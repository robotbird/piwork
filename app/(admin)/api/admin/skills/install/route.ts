import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { requireAdminRole } from "@/lib/admin/access";
import { getSkillInstallationService } from "@/lib/admin/skill-installation-runtime";
import { SkillArchiveDownloadError } from "@/lib/ai/skills";
import { ChatbotError } from "@/lib/errors";
import { LocalizedError } from "@/lib/i18n/messages";

const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("preview"),
      installUrl: z.string().trim().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      action: z.literal("install"),
      selectedIds: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .min(1)
        .max(100),
      token: z.string().uuid(),
    })
    .strict(),
]);
const discardSchema = z.object({ token: z.string().uuid() }).strict();
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }
  const t = await getTranslations("api");
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: t("skillSelectionInvalid") },
        { headers, status: 400 }
      );
    }
    const body = parsed.data;
    const service = getSkillInstallationService();
    if (body.action === "preview") {
      return Response.json(
        await service.preview(session.userId, body.installUrl),
        { headers }
      );
    }
    const results = await service.install(
      session.userId,
      body.token,
      body.selectedIds
    );
    // Each selected item has an explicit outcome; successful siblings are not rolled back.
    return Response.json({ results }, { headers });
  } catch (error) {
    if (error instanceof LocalizedError) {
      const status =
        error.messageKey === "api.skillPreviewExpired"
          ? 409
          : error.messageKey === "api.skillPreviewBusy"
            ? 429
            : 400;
      return Response.json(
        { error: t(error.messageKey.slice(4), error.params) },
        { headers, status }
      );
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: t("skillSelectionInvalid") },
        { headers, status: 400 }
      );
    }
    console.error("Skill install preview/batch failed", error);
    const download = error instanceof SkillArchiveDownloadError;
    return Response.json(
      {
        error: t(
          download ? "skillInstallDownloadFailed" : "skillInstallBatchFailed"
        ),
      },
      { headers, status: download ? 502 : 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }
  const t = await getTranslations("api");
  const body = discardSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json(
      { error: t("skillSelectionInvalid") },
      { headers, status: 400 }
    );
  }
  getSkillInstallationService().discard(session.userId, body.data.token);
  return new Response(null, { headers, status: 204 });
}
