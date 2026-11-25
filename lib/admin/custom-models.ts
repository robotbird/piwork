import { z } from "zod";

// Preserve the package identity of existing custom model installations.
export const CUSTOM_MODEL_PACKAGE = "piwork-custom-openai";

export const customModelApiSchema = z.enum([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);
export type CustomModelApi = z.infer<typeof customModelApiSchema>;

export const customModelSchema = z
  .object({
    api: customModelApiSchema.default("openai-completions"),
    apiKey: z.string().trim().min(1).max(8192),
    contextWindow: z.number().int().min(1).max(10_000_000).default(128_000),
    endpoint: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    maxTokens: z.number().int().min(1).max(10_000_000).default(8192),
    modelId: z.string().trim().min(1).max(256),
    reasoning: z.boolean().default(false),
    toolCall: z.boolean().default(true),
    vision: z.boolean().default(false),
  })
  .refine((value) => value.maxTokens <= value.contextWindow);

export function normalizeCustomEndpoint(
  endpoint: string,
  api: CustomModelApi = "openai-completions"
): string {
  const baseUrl = endpoint.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    // The Anthropic SDK appends /v1/messages itself, including for gateway prefixes.
    return baseUrl.replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
  }
  return api === "openai-responses"
    ? baseUrl.replace(/\/responses$/, "")
    : baseUrl.replace(/\/chat\/completions$/, "");
}

const bigModelEndpoints: Record<CustomModelApi, string> = {
  "anthropic-messages": "https://open.bigmodel.cn/api/anthropic",
  "openai-completions": "https://open.bigmodel.cn/api/paas/v4",
  "openai-responses": "https://open.bigmodel.cn/api/v1",
};

export function effectiveCustomModelMaxTokens(
  api: CustomModelApi,
  baseUrl: string,
  modelId: string,
  configuredMaxTokens: number
): number {
  // GLM-5.3 supports a 1M context window but only 128K output on BigModel.
  if (modelId === "glm-5.3" && baseUrl === bigModelEndpoints[api]) {
    return Math.min(configuredMaxTokens, 131_072);
  }
  return configuredMaxTokens;
}
