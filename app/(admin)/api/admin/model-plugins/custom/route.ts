import { randomUUID } from "node:crypto";
import type { ProviderDefinition } from "@piwork/model-provider-sdk";
import { getTranslations } from "next-intl/server";
import { requireAdminRole } from "@/lib/admin/access";
import {
  CUSTOM_MODEL_PACKAGE,
  customModelSchema,
  effectiveCustomModelMaxTokens,
  normalizeCustomEndpoint,
} from "@/lib/admin/custom-models";
import { createPluginInstallation } from "@/lib/db/model-plugin-queries";
import { ChatbotError } from "@/lib/errors";
import {
  encryptPluginCredentials,
  summarizeCredentials,
} from "@/lib/model-plugins/credentials";
import { validateCustomCredentials } from "@/lib/model-plugins/custom-provider";
import { resetPluginRegistry } from "@/lib/model-plugins/registry";

export async function POST(request: Request) {
  const session = await requireAdminRole();
  if (!session) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }
  try {
    const body = await request.json();
    const parsed = customModelSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "modelPlugins.customInvalid" },
        { status: 400 }
      );
    }
    const input = parsed.data;
    const endpoint = normalizeCustomEndpoint(input.endpoint, input.api);
    const providerKey = `custom-${randomUUID()}`;
    const zh = await getTranslations({
      locale: "zh",
      namespace: "modelPlugins",
    });
    const en = await getTranslations({
      locale: "en",
      namespace: "modelPlugins",
    });
    const apiLabelKey = {
      "anthropic-messages": "customApiAnthropic",
      "openai-completions": "customApiChat",
      "openai-responses": "customApiResponses",
    } as const;
    const description = {
      en: en(apiLabelKey[input.api]),
      "zh-CN": zh(apiLabelKey[input.api]),
    };
    const definition: ProviderDefinition = {
      api: input.api,
      credentialFields: [
        {
          label: { en: "API Key" },
          required: true,
          type: "secret-input",
          variable: "api_key",
        },
        {
          default: endpoint,
          label: { en: en("customEndpoint"), "zh-CN": zh("customEndpoint") },
          required: true,
          type: "text-input",
          variable: "endpoint_url",
        },
      ],
      defaultBaseUrl: endpoint,
      description,
      help: { title: { en: "API" }, url: { en: endpoint } },
      models: [
        {
          features: {
            reasoning: input.reasoning,
            streamToolCall: input.toolCall,
            toolCall: input.toolCall,
            vision: input.vision,
          },
          label: { en: input.modelId },
          modelId: input.modelId,
          modelType: "llm",
          parameterRules: [],
          properties: {
            contextSize: input.contextWindow,
            defaultMaxTokens: effectiveCustomModelMaxTokens(
              input.api,
              endpoint,
              input.modelId,
              input.maxTokens
            ),
            mode: "chat",
          },
        },
      ],
      name: { en: input.modelId },
      networkHosts: [new URL(endpoint).hostname],
      provider: providerKey,
    };
    const credentials = { api_key: input.apiKey, endpoint_url: endpoint };
    await validateCustomCredentials(definition, credentials);
    if (body.testOnly === true) {
      return Response.json({ tested: true });
    }
    const record = await createPluginInstallation({
      buildHash: "custom",
      createdBy: session.userId,
      credentialSummary: summarizeCredentials(credentials),
      credentialsConfigured: true,
      defaultModelId: null,
      definition,
      description: description.en,
      displayName: input.modelId,
      enabledModels: [input.modelId],
      encryptedCredentials: encryptPluginCredentials(credentials),
      packageId: CUSTOM_MODEL_PACKAGE,
      providerKey,
      sha256: "custom",
      version: "1.0.0",
    });
    resetPluginRegistry();
    return Response.json({ id: record.id }, { status: 201 });
  } catch {
    return Response.json(
      { error: "modelPlugins.customConnectionFailed" },
      { status: 400 }
    );
  }
}
