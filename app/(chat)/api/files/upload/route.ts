import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { getSupportedAttachmentType } from "@/lib/ai/attachment-types";
import { createPrivateFileStore } from "@/lib/ai/private-file-store";
import {
  assertLibraryFolder,
  registerLibraryFile,
} from "@/lib/db/library-queries";
import { getUploadSettings } from "@/lib/db/upload-settings-queries";
import { type UploadSettings, uploadLimitBytes } from "@/lib/uploads/settings";

/** 上传文件名归一：去控制字符、限长（符合私有存储入参约束；展示名保留） */
function normalizeUploadFilename(filename: string): string {
  const cleaned = Array.from(filename)
    .filter(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127
    )
    .join("");
  return cleaned.slice(0, 180) || "file";
}

export async function POST(request: Request) {
  const t = await getTranslations("api");
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: t("unauthorized") }, { status: 401 });
  }

  let settings: UploadSettings;
  try {
    settings = await getUploadSettings();
  } catch {
    return NextResponse.json(
      { error: t("uploadSettingsUnavailable") },
      { status: 503 }
    );
  }
  const fileSchema = z.object({
    file: z
      .instanceof(Blob)
      .refine((file) => file.size <= uploadLimitBytes(settings), {
        message: t("fileTooLarge", { maxMB: settings.maxFileSizeMB }),
      }),
  });

  if (request.body === null) {
    return new Response(t("requestBodyEmpty"), { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: t("fileRequired") }, { status: 400 });
    }

    const validatedFile = fileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.issues
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const parentId = formData.get("parentId");
    if (
      parentId &&
      (typeof parentId !== "string" || !z.uuid().safeParse(parentId).success)
    ) {
      return NextResponse.json({ error: t("folderInvalid") }, { status: 400 });
    }
    try {
      await assertLibraryFolder(session.user.id, parentId as string | null);
    } catch {
      return NextResponse.json({ error: t("folderMissing") }, { status: 400 });
    }
    const isLibraryUpload = formData.get("library") === "true";
    const filename = (formData.get("file") as File).name;
    const attachmentType = getSupportedAttachmentType(filename);
    if (!attachmentType && !isLibraryUpload) {
      return NextResponse.json(
        { error: t("unsupportedFile") },
        { status: 400 }
      );
    }

    try {
      // 新写入私有化（A5/S5）：platform 绑定 key + 鉴权下载路由，不再向
      // public Blob 写入新对象；旧 Blob 保持可读（兼容读），不迁移历史。
      // 文件名归一（控制字符/长度）以符合私有存储入参约束，展示名保留。
      const data = await createPrivateFileStore(undefined, {
        maxBytes: uploadLimitBytes(settings),
      })({
        content: new Uint8Array(await file.arrayBuffer()),
        contentType: attachmentType?.mediaType ?? "application/octet-stream",
        filename: normalizeUploadFilename(filename),
        operationKey: `upload:${session.user.id}:${crypto.randomUUID()}`,
      });

      await registerLibraryFile({
        file: data,
        parentId: parentId as string | null,
        size: file.size,
        source: "upload",
        userId: session.user.id,
      });
      return NextResponse.json(data);
    } catch (error) {
      console.error("[files/upload] failed to store file", error);
      return NextResponse.json({ error: t("uploadFailed") }, { status: 500 });
    }
  } catch (error) {
    console.error("[files/upload] failed to process request", error);
    return NextResponse.json({ error: t("requestFailed") }, { status: 500 });
  }
}
