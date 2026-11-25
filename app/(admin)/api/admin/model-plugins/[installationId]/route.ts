import { getLocale, getTranslations } from "next-intl/server";
import { requireAdminRole } from "@/lib/admin/access";
import {
  CUSTOM_MODEL_PACKAGE,
  customModelApiSchema,
} from "@/lib/admin/custom-models";
import {
  applyModelContextWindows,
  asProviderDefinition,
  mergeCredentialUpdate,
  modelContextWindowsSchema,
} from "@/lib/admin/model-plugins";
import {
  deletePluginInstallation,
  getPluginInstallation,
  updatePluginInstallation,
} from "@/lib/db/model-plugin-queries";
import { ChatbotError } from "@/lib/errors";
import { getBuiltinPluginPackage } from "@/lib/model-plugins/builtin-catalog";
import {
  decryptPluginCredentials,
  encryptPluginCredentials,
  summarizeCredentials,
} from "@/lib/model-plugins/credentials";
import { validateCustomCredentials } from "@/lib/model-plugins/custom-provider";
import { ProviderPluginManager } from "@/lib/model-plugins/manager";
import {
  pickLocalizedText,
  resetPluginRegistry,
} from "@/lib/model-plugins/registry";

function unauthorized() {
  return new ChatbotError("unauthorized:chat").toResponse();
}

async function errorResponse(error: unknown, status = 400) {
  const t = await getTranslations("adminApi");
  return Response.json(
    { error: error instanceof Error ? error.message : t("operationFailed") },
    { status }
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ installationId: string }> }
) {
  const t = await getTranslations("adminApi");
  const locale = await getLocale();
  const session = await requireAdminRole();
  if (!session) {
    return unauthorized();
  }
  try {
    const { installationId } = await params;
    const record = await getPluginInstallation(installationId);
    if (!record) {
      return errorResponse(new Error(t("pluginInstallationNotFound")), 404);
    }
    const body = (await request.json()) as {
      contextWindows?: unknown;
      api?: unknown;
      credentials?: Record<string, unknown>;
      defaultModelId?: string | null;
      enabled?: boolean;
      enabledModels?: string[];
    };
    const update: Parameters<typeof updatePluginInstallation>[1] = {};
    if (typeof body.enabled === "boolean") {
      update.enabled = body.enabled;
      if (!body.enabled) {
        update.defaultModelId = null;
      }
    }
    // The matching packaged definition is the fresh catalog source (model entries
    // can ship under the same version); fall back to the saved snapshot only for
    // installations whose package is gone. Refresh the stored snapshot when the
    // catalog changed so every consumer sees the same model list.
    const packagedPlugin = await getBuiltinPluginPackage(record.packageId);
    const packagedDefinition =
      packagedPlugin && packagedPlugin.version === record.version
        ? packagedPlugin.definition
        : null;
    let definition: ReturnType<typeof asProviderDefinition> = {
      ...(packagedDefinition ?? asProviderDefinition(record.definition)),
      contextWindowOverrides: asProviderDefinition(record.definition)
        .contextWindowOverrides,
    };
    if (
      packagedDefinition &&
      JSON.stringify(packagedDefinition.models) !==
        JSON.stringify(record.definition.models)
    ) {
      update.definition = packagedDefinition as Record<string, unknown>;
    }
    if (body.api !== undefined) {
      const parsedApi = customModelApiSchema.safeParse(body.api);
      if (record.packageId !== CUSTOM_MODEL_PACKAGE || !parsedApi.success) {
        return errorResponse(new Error("modelPlugins.customInvalid"));
      }
      definition.api = parsedApi.data;
      update.definition = definition as Record<string, unknown>;
    }
    if (body.contextWindows !== undefined) {
      const parsed = modelContextWindowsSchema.safeParse(body.contextWindows);
      if (
        !parsed.success ||
        Object.keys(parsed.data).some(
          (id) =>
            !definition.models.some(
              (model) => model.modelId === id && model.modelType === "llm"
            )
        )
      ) {
        return errorResponse(new Error("modelPlugins.invalidContextWindow"));
      }
      definition.contextWindowOverrides = {
        ...definition.contextWindowOverrides,
        ...parsed.data,
      };
    }
    definition = applyModelContextWindows(definition);
    if (
      packagedDefinition ||
      body.api !== undefined ||
      body.contextWindows !== undefined
    ) {
      update.definition = definition as Record<string, unknown>;
    }
    const knownIds = new Set(definition.models.map((model) => model.modelId));
    if (body.enabledModels) {
      if (
        body.enabledModels.length > 0 &&
        !record.credentialsConfigured &&
        !body.credentials
      ) {
        return errorResponse(new Error(t("configureApiKeyFirst")));
      }
      if (body.enabledModels.some((id) => !knownIds.has(id))) {
        return errorResponse(new Error(t("unknownModelInCatalog")));
      }
      update.enabledModels = body.enabledModels;
      if (
        record.defaultModelId &&
        !body.enabledModels.includes(record.defaultModelId) &&
        body.defaultModelId === undefined
      ) {
        update.defaultModelId = null;
      }
    }
    if (body.defaultModelId !== undefined) {
      if (body.defaultModelId && !knownIds.has(body.defaultModelId)) {
        return errorResponse(new Error(t("defaultModelNotFound")));
      }
      const enabledModels = update.enabledModels ?? record.enabledModels;
      if (body.defaultModelId && !enabledModels.includes(body.defaultModelId)) {
        return errorResponse(new Error(t("defaultModelMustBeEnabled")));
      }
      update.defaultModelId = body.defaultModelId;
    }
    if (body.credentials || body.api !== undefined) {
      const pluginPackage = packagedPlugin;
      if (!pluginPackage && record.packageId !== CUSTOM_MODEL_PACKAGE) {
        return errorResponse(new Error(t("pluginPackageNotFound")), 404);
      }
      let currentCredentials: Record<string, unknown> | null;
      try {
        currentCredentials = decryptPluginCredentials(
          record.encryptedCredentials
        );
      } catch {
        currentCredentials = null;
      }
      const nextCredentials = mergeCredentialUpdate(
        currentCredentials,
        body.credentials ?? {},
        definition.credentialFields
      );
      if (!nextCredentials) {
        return errorResponse(new Error(t("credentialRecoveryRequired")));
      }
      for (const field of definition.credentialFields) {
        if (
          field.required &&
          (typeof nextCredentials[field.variable] !== "string" ||
            !String(nextCredentials[field.variable]).trim())
        ) {
          return errorResponse(
            new Error(
              t("credentialFieldRequired", {
                field:
                  field.label[locale === "zh" ? "zh-CN" : "en"] ??
                  pickLocalizedText(field.label),
              })
            )
          );
        }
      }
      if (record.packageId === CUSTOM_MODEL_PACKAGE) {
        const endpoint = String(nextCredentials.endpoint_url ?? "");
        const url = new URL(endpoint);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          return errorResponse(new Error("modelPlugins.customInvalid"));
        }
        await validateCustomCredentials(definition, nextCredentials);
      } else if (pluginPackage) {
        const manager = new ProviderPluginManager();
        const installation = await manager.install(
          pluginPackage.fileName,
          pluginPackage.zipBytes
        );
        await manager.validateCredentials(installation, nextCredentials);
      }
      update.encryptedCredentials = encryptPluginCredentials(nextCredentials);
      update.credentialSummary = summarizeCredentials(nextCredentials);
      update.credentialsConfigured = true;
      update.healthStatus = "healthy";
    }
    await updatePluginInstallation(installationId, update);
    resetPluginRegistry();
    return Response.json({ updated: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ installationId: string }> }
) {
  const t = await getTranslations("adminApi");
  const session = await requireAdminRole();
  if (!session) {
    return unauthorized();
  }
  try {
    const { installationId } = await params;
    if (!(await getPluginInstallation(installationId))) {
      return errorResponse(new Error(t("pluginInstallationNotFound")), 404);
    }
    await deletePluginInstallation(installationId);
    resetPluginRegistry();
    return Response.json({ deleted: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
