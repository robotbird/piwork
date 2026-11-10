import type {
  CredentialFieldSchema,
  ProviderDefinition,
  ProviderModelDefinition,
} from "@piwork/model-provider-sdk";

export type ModelPluginCatalogItem = {
  defaultBaseUrl?: string;
  credentialFields: CredentialFieldSchema[];
  description: string;
  installed: boolean;
  models: ProviderModelDefinition[];
  name: string;
  networkHosts: string[];
  packageId: string;
  providerKey: string;
  version: string;
};

export type ModelPluginInstallationView = {
  defaultBaseUrl?: string;
  credentialFields: CredentialFieldSchema[];
  credentialSummary: Record<string, string>;
  credentialsConfigured: boolean;
  credentialReadable?: boolean;
  defaultModelId: string | null;
  description: string;
  enabled: boolean;
  enabledModels: string[];
  healthStatus: "unknown" | "healthy" | "degraded" | "failed";
  id: string;
  models: ProviderModelDefinition[];
  name: string;
  packageId: string;
  providerKey: string;
  updatedAt: string;
  version: string;
};

export type ModelPluginsView = {
  available: ModelPluginCatalogItem[];
  installed: ModelPluginInstallationView[];
};

/** Only new configurations receive public non-secret defaults. Rotation must preserve saved custom endpoints. */
export function initialCredentialValues(
  installation: Pick<
    ModelPluginInstallationView,
    "credentialsConfigured" | "credentialFields"
  > | null
): Record<string, string> {
  if (!installation || installation.credentialsConfigured) {
    return {};
  }
  return Object.fromEntries(
    installation.credentialFields
      .filter(
        (field) => field.type !== "secret-input" && field.default !== undefined
      )
      .map((field) => [field.variable, field.default as string])
  );
}

export function asProviderDefinition(value: unknown): ProviderDefinition {
  return value as ProviderDefinition;
}

/** Recover only when the submitted values replace every field that might have been stored. */
export function mergeCredentialUpdate(
  current: Record<string, unknown> | null,
  submitted: Record<string, unknown>,
  fields: readonly { variable: string }[]
): Record<string, unknown> | null {
  const values = Object.fromEntries(
    Object.entries(submitted).filter(
      ([, value]) => typeof value !== "string" || value.trim().length > 0
    )
  );
  if (!current && fields.some((field) => !(field.variable in values))) {
    return null;
  }
  return { ...(current ?? {}), ...values };
}
