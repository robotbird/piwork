import {
  createModels,
  createProvider,
  type Model,
  type ProviderStreams,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ProviderDefinition } from "@piwork/model-provider-sdk";
import {
  type CustomModelApi,
  customModelApiSchema,
  effectiveCustomModelMaxTokens,
  normalizeCustomEndpoint,
} from "@/lib/admin/custom-models";

export function createCustomProvider(
  definition: ProviderDefinition,
  credentials: Record<string, unknown>,
  id: string
) {
  const protocol = customModelApiSchema.parse(
    definition.api ?? "openai-completions"
  );
  const baseUrl = normalizeCustomEndpoint(
    String(credentials.endpoint_url ?? definition.defaultBaseUrl),
    protocol
  );
  const apiKey = String(credentials.api_key ?? "");
  const models: Model<CustomModelApi>[] = definition.models
    .filter((entry) => entry.modelType === "llm")
    .map((entry) => ({
      api: protocol,
      baseUrl,
      contextWindow: entry.properties.contextSize,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: entry.modelId,
      input: entry.features.vision ? ["text", "image"] : ["text"],
      maxTokens: effectiveCustomModelMaxTokens(
        protocol,
        baseUrl,
        entry.modelId,
        entry.properties.defaultMaxTokens
      ),
      name: entry.label.en ?? entry.modelId,
      provider: id,
      reasoning: entry.features.reasoning,
    }));
  const implementations: Record<CustomModelApi, () => ProviderStreams> = {
    "anthropic-messages": anthropicMessagesApi,
    "openai-completions": openAICompletionsApi,
    "openai-responses": openAIResponsesApi,
  };
  const api = implementations[protocol]();
  const toolCall = definition.models.some(
    (entry) => entry.modelType === "llm" && entry.features.toolCall
  );
  const prepare = (context: TranscriptContext): TranscriptContext =>
    toolCall
      ? context
      : {
          ...context,
          messages: context.messages.map((message) =>
            message.role === "system"
              ? { ...message, toolsAdded: undefined, toolsRemoved: undefined }
              : message
          ),
        };
  return createProvider({
    api: {
      stream: (model, context, options) =>
        api.stream(model, prepare(context), options),
      streamSimple: (model, context, options) =>
        api.streamSimple(model, prepare(context), options),
    },
    auth: {
      apiKey: {
        name: "API Key",
        resolve: async () => ({ auth: { apiKey }, source: "piwork-custom" }),
      },
    },
    baseUrl,
    id,
    models,
    name: definition.name.en,
  });
}

export async function validateCustomCredentials(
  definition: ProviderDefinition,
  credentials: Record<string, unknown>
) {
  const provider = createCustomProvider(
    definition,
    credentials,
    "custom-connection-test"
  );
  const models = createModels();
  models.setProvider(provider);
  const result = await models.completeSimple(
    provider.getModels()[0],
    {
      messages: [
        { content: "Reply with OK.", role: "user", timestamp: Date.now() },
      ],
    },
    { signal: AbortSignal.timeout(20_000) }
  );
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error("modelPlugins.customConnectionFailed");
  }
}
