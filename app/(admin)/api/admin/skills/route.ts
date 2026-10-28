import { getTranslations } from "next-intl/server";
import { requireAdminRole } from "@/lib/admin/access";
import {
  deleteManagedProjectSkill,
  loadManagedProjectSkillSummaries,
  registerManagedProjectSkill,
  setManagedProjectSkillEnabled,
} from "@/lib/ai/managed-skills";
import { getInstallableCatalogSkill } from "@/lib/ai/skill-catalog";
import { parseSkillInstallLink } from "@/lib/ai/skill-install-link";
import { SKILL_LIMIT_MB } from "@/lib/ai/skill-limits";
import {
  createProjectSkill,
  deleteProjectSkill,
  extractProjectSkillArchive,
  fetchSkillInstallArchive,
  installProjectSkill,
  MAX_SKILL_UPLOAD_FILE_COUNT,
  MAX_SKILL_UPLOAD_FILE_SIZE,
  MAX_SKILL_UPLOAD_TOTAL_SIZE,
  type ProjectSkillUploadFile,
  SkillArchiveDownloadError,
} from "@/lib/ai/skills";
import { getUserById } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { LocalizedError } from "@/lib/i18n/messages";

async function apiError(error: unknown, status = 400) {
  const t = await getTranslations("api");
  return Response.json(
    {
      error:
        error instanceof LocalizedError
          ? t(error.messageKey.slice(4), error.params)
          : error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : t("unknownError"),
    },
    { status }
  );
}

export async function GET() {
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const { skills, diagnostics } = await loadManagedProjectSkillSummaries();
  return Response.json(
    {
      diagnostics: diagnostics.map(({ type, message, path }) => ({
        // 1.0.0 的 ResourceDiagnostic 以 type 取代 code；wire 格式保持不变
        code: type,
        message,
        path,
      })),
      skills,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  const t = await getTranslations("api");
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  let installedName: string | null = null;
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as {
        catalogSkillName?: unknown;
        installUrl?: unknown;
      };
      if (typeof body.installUrl === "string" && body.installUrl.trim()) {
        const link = parseSkillInstallLink(body.installUrl);
        if (!link) {
          return apiError(t("skillInstallUrlInvalid"));
        }
        let downloadedFiles: ProjectSkillUploadFile[];
        try {
          downloadedFiles = await fetchSkillInstallArchive(link);
        } catch (error) {
          // 下载类失败给统一提示；Skill 内容校验错误继续抛出，由外层 400 透出具体原因
          if (!(error instanceof SkillArchiveDownloadError)) {
            throw error;
          }
          console.error("Failed to download skill install link:", error);
          return apiError(t("skillInstallDownloadFailed"), 502);
        }
        const installed = await installProjectSkill({ files: downloadedFiles });
        installedName = installed.name;
      } else if (typeof body.catalogSkillName === "string") {
        const catalogSkill = getInstallableCatalogSkill(body.catalogSkillName);
        if (!catalogSkill) {
          return apiError(t("catalogSkillNotFound"), 404);
        }
        const created = await createProjectSkill({
          description: catalogSkill.description,
          displayName: catalogSkill.displayName,
          instructions: catalogSkill.instructions,
          name: catalogSkill.name,
        });
        installedName = created.name;
      } else {
        return apiError(t("catalogSkillNameRequired"));
      }
    } else {
      const formData = await request.formData();
      const files = formData
        .getAll("files")
        .filter((item) => item instanceof File);
      const paths = formData.getAll("paths").map(String);
      if (files.length === 0) {
        return apiError(t("skillUploadRequired"));
      }
      if (files.length > MAX_SKILL_UPLOAD_FILE_COUNT) {
        return apiError(
          t("skillFileCount", { count: MAX_SKILL_UPLOAD_FILE_COUNT })
        );
      }

      const isZipUpload =
        files.length === 1 &&
        files[0].name.toLocaleLowerCase().endsWith(".zip");
      if (
        !isZipUpload &&
        files.some((file) => file.name.toLocaleLowerCase().endsWith(".zip"))
      ) {
        return apiError(t("skillSingleZip"));
      }
      if (!isZipUpload && files.length !== paths.length) {
        return apiError(t("skillPathsInvalid"));
      }

      let totalSize = 0;
      for (const file of files) {
        if (!isZipUpload && file.size > MAX_SKILL_UPLOAD_FILE_SIZE) {
          return apiError(
            t("skillFileLimit", { maxMB: SKILL_LIMIT_MB.file, name: file.name })
          );
        }
        totalSize += file.size;
      }
      if (totalSize > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
        return apiError(
          isZipUpload
            ? t("skillZipLimit", { maxMB: SKILL_LIMIT_MB.total })
            : t("skillFolderLimit", { maxMB: SKILL_LIMIT_MB.total })
        );
      }

      const uploadedFiles = isZipUpload
        ? extractProjectSkillArchive({
            content: new Uint8Array(await files[0].arrayBuffer()),
            filename: files[0].name,
          })
        : await Promise.all(
            files.map(async (file, index) => ({
              content: new Uint8Array(await file.arrayBuffer()),
              path: paths[index],
            }))
          );
      const installed = await installProjectSkill({ files: uploadedFiles });
      installedName = installed.name;
    }

    const uploader = await getUserById(session.userId);
    await registerManagedProjectSkill({
      name: installedName,
      uploadedBy: uploader?.id ?? null,
    });
    return Response.json({ name: installedName }, { status: 201 });
  } catch (error) {
    if (installedName) {
      await deleteProjectSkill(installedName).catch(() => undefined);
    }
    console.error("Failed to upload managed skill:", error);
    const message = error instanceof Error ? error.message : "Upload failed";
    return apiError(error, message.includes("already exists") ? 409 : 400);
  }
}

export async function PATCH(request: Request) {
  const t = await getTranslations("api");
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  try {
    const body = (await request.json()) as {
      enabled?: unknown;
      name?: unknown;
    };
    if (typeof body.name !== "string" || typeof body.enabled !== "boolean") {
      return apiError(t("skillEnableRequired"));
    }
    await setManagedProjectSkillEnabled(body.name, body.enabled);
    return Response.json({ updated: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update the skill";
    return apiError(error, message.includes("was not found") ? 404 : 400);
  }
}

export async function DELETE(request: Request) {
  const t = await getTranslations("api");
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  try {
    const body = (await request.json()) as { name?: unknown };
    if (typeof body.name !== "string") {
      return apiError(t("skillNameRequired"));
    }
    await deleteManagedProjectSkill(body.name);
    return Response.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    return apiError(error, message.includes("was not found") ? 404 : 400);
  }
}
