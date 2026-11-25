// biome-ignore-all lint/performance/noAwaitInLoops: provider activation is intentionally sequential and bounded

import "server-only";

import type { Provider } from "@earendil-works/pi-ai";
import type {
  LocalizedText,
  ProviderDefinition,
  ProviderModelDefinition,
} from "@piwork/model-provider-sdk";

import { CUSTOM_MODEL_PACKAGE } from "@/lib/admin/custom-models";
import {
  applyModelContextWindows,
  asProviderDefinition,
} from "@/lib/admin/model-plugins";
import { listPluginInstallations } from "@/lib/db/model-plugin-queries";
import { getBuiltinPluginPackage } from "./builtin-catalog";
import { decryptPluginCredentials } from "./credentials";
import { createCustomProvider } from "./custom-provider";
import { ProviderPluginManager } from "./manager";

export type PluginInstallationRuntime = {
  defaultModelId: string | null;
  definition: ProviderDefinition;
  displayName: string;
  installationId: string;
  models: ProviderModelDefinition[];
  provider: Provider;
  providerKey: string;
  runtimeProviderId: string;
};

export function pickLocalizedText(text: LocalizedText): string {
  return text["zh-CN"] ?? text.en ?? Object.values(text)[0] ?? "";
}

type RegistrySnapshot = {
  manager: ProviderPluginManager;
  promise: Promise<PluginInstallationRuntime[]>;
};

// Route bundles and the long-lived RunManager must see the same provider snapshot.
const shared = globalThis as typeof globalThis & {
  piworkPluginRegistry?: { snapshot?: RegistrySnapshot };
};
shared.piworkPluginRegistry ??= {};
const registry = shared.piworkPluginRegistry;

export function resetPluginRegistry(): void {
  const { snapshot } = registry;
  registry.snapshot = undefined;
  if (snapshot) {
    // Activation may still be in progress. Dispose after all hosts are registered.
    snapshot.promise
      .catch(() => undefined)
      .then(() => snapshot.manager.disposeAll())
      .catch((error) => {
        console.warn("[piwork-plugin] failed to dispose plugin hosts", error);
      });
  }
}

export async function loadPluginInstallations(): Promise<
  PluginInstallationRuntime[]
> {
  if (!registry.snapshot) {
    const manager = new ProviderPluginManager();
    const promise = buildRegistry(manager);
    registry.snapshot = { manager, promise };
  }
  const { snapshot } = registry;
  try {
    const installations = await snapshot.promise;
    if (registry.snapshot === snapshot) {
      return installations;
    }
    return loadPluginInstallations();
  } catch (error) {
    if (registry.snapshot === snapshot) {
      resetPluginRegistry();
    }
    throw error;
  }
}

async function buildRegistry(
  manager: ProviderPluginManager
): Promise<PluginInstallationRuntime[]> {
  const records = (await listPluginInstallations()).filter(
    (record) => record.enabled && record.credentialsConfigured
  );
  const output: PluginInstallationRuntime[] = [];

  for (const record of records) {
    if (record.packageId === CUSTOM_MODEL_PACKAGE) {
      try {
        const definition = applyModelContextWindows(
          asProviderDefinition(record.definition)
        );
        const runtimeProviderId = `installation:${record.id}`;
        const provider = createCustomProvider(
          definition,
          decryptPluginCredentials(record.encryptedCredentials),
          runtimeProviderId
        );
        output.push({
          defaultModelId: record.defaultModelId,
          definition,
          displayName: record.displayName,
          installationId: record.id,
          models: definition.models.filter((model) =>
            record.enabledModels.includes(model.modelId)
          ),
          provider,
          providerKey: record.providerKey,
          runtimeProviderId,
        });
      } catch {
        console.warn(
          `[piwork-plugin] failed to activate custom model ${record.id}`
        );
      }
      continue;
    }
    const pluginPackage = await getBuiltinPluginPackage(record.packageId);
    if (!pluginPackage || pluginPackage.version !== record.version) {
      console.warn(
        `[piwork-plugin] package unavailable: ${record.packageId}@${record.version}`
      );
      continue;
    }
    try {
      const installation = await manager.install(
        pluginPackage.fileName,
        pluginPackage.zipBytes
      );
      installation.installationId = record.id;
      installation.runtimeProviderId = `installation:${record.id}`;
      const activated = await manager.activate(
        installation,
        decryptPluginCredentials(record.encryptedCredentials)
      );
      const definition = applyModelContextWindows({
        ...activated.definition,
        contextWindowOverrides: asProviderDefinition(record.definition)
          .contextWindowOverrides,
      });
      const originalGetModels = activated.provider.getModels.bind(
        activated.provider
      );
      activated.provider.getModels = () =>
        originalGetModels().map((model) => {
          const contextWindow = definition.contextWindowOverrides?.[model.id];
          return contextWindow === undefined
            ? model
            : {
                ...model,
                contextWindow,
                maxTokens: Math.min(model.maxTokens, contextWindow),
              };
        });
      const enabled = new Set(record.enabledModels);
      output.push({
        defaultModelId: record.defaultModelId,
        definition,
        displayName: record.displayName,
        installationId: record.id,
        models: definition.models.filter((model) => enabled.has(model.modelId)),
        provider: activated.provider,
        providerKey: record.providerKey,
        runtimeProviderId: installation.runtimeProviderId,
      });
    } catch (error) {
      console.warn(
        `[piwork-plugin] failed to activate ${record.packageId}:`,
        error
      );
    }
  }
  return output;
}
