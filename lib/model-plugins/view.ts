import "server-only";

import {
  asProviderDefinition,
  type ModelPluginsView,
} from "@/lib/admin/model-plugins";
import { listPluginInstallations } from "@/lib/db/model-plugin-queries";
import { loadBuiltinPluginCatalog } from "./builtin-catalog";
import { decryptPluginCredentials } from "./credentials";
import { pickLocalizedText } from "./registry";

export async function loadModelPluginsView(): Promise<ModelPluginsView> {
  const [catalog, records] = await Promise.all([
    loadBuiltinPluginCatalog(),
    listPluginInstallations(),
  ]);
  const installedKeys = new Set(records.map((item) => item.providerKey));
  return {
    available: catalog.map((item) => ({
      credentialFields: item.definition.credentialFields,
      defaultBaseUrl: item.definition.defaultBaseUrl,
      description: pickLocalizedText(item.definition.description),
      installed: installedKeys.has(item.providerKey),
      models: item.definition.models,
      name: pickLocalizedText(item.definition.name),
      networkHosts: item.definition.networkHosts,
      packageId: item.packageId,
      providerKey: item.providerKey,
      version: item.version,
    })),
    installed: records.map((record) => {
      const definition = asProviderDefinition(record.definition);
      let credentialReadable = true;
      if (record.credentialsConfigured) {
        try {
          decryptPluginCredentials(record.encryptedCredentials);
        } catch {
          credentialReadable = false;
        }
      }
      // Legacy installations keep their saved schema/models only when the matching
      // package is gone; a matching packaged definition is the fresh catalog source
      // (e.g. new model entries shipped under the same version), so it wins for the
      // model list while credential fields stay with the saved schema.
      const packaged = catalog.find(
        (item) =>
          item.packageId === record.packageId && item.version === record.version
      )?.definition;
      return {
        credentialFields: definition.credentialFields,
        credentialReadable,
        credentialSummary: record.credentialSummary,
        credentialsConfigured: record.credentialsConfigured,
        defaultBaseUrl: definition.defaultBaseUrl ?? packaged?.defaultBaseUrl,
        defaultModelId: record.defaultModelId,
        description: record.description ?? "",
        enabled: record.enabled,
        enabledModels: record.enabledModels,
        healthStatus: record.healthStatus,
        id: record.id,
        models: packaged?.models ?? definition.models,
        name: record.displayName,
        packageId: record.packageId,
        providerKey: record.providerKey,
        updatedAt: record.updatedAt.toISOString(),
        version: record.version,
      };
    }),
  };
}
