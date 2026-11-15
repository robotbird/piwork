import type {
  ProviderDefinition,
  ValidateCredentialsContext,
} from "@piwork/model-provider-sdk";

import { modelCatalog } from "./models";

/** 官方开放平台端点（Dify provider/zhipuai.yaml 的 base_url 默认值） */
export const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

/** Dify zhipuai.py 的连通性探测模型，仅插件内部使用 */
const VALIDATION_MODEL = "glm-5-turbo";

/**
 * Backoff delays before retrying a throttled (HTTP 429) probe.
 * Total worst case must stay below the host's 20s validation timeout.
 */
const THROTTLE_RETRY_DELAYS_MS = [1000, 2000];

/** Abort-aware sleep used between throttled probe retries. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Credential validation aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Credential validation aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const definition: ProviderDefinition = {
  credentialFields: [
    {
      label: { en: "API Key", "zh-CN": "API Key" },
      placeholder: {
        en: "Enter your API Key",
        "zh-CN": "在此输入您的 API Key",
      },
      required: true,
      type: "secret-input",
      variable: "api_key",
    },
  ],
  defaultBaseUrl: DEFAULT_BASE_URL,
  description: {
    en: "Official ZHIPU AI models: the GLM chat family with thinking mode, tool calling, and vision.",
    "zh-CN":
      "智谱 AI 官方模型：GLM 全系对话模型，支持思考模式、工具调用与视觉理解。",
  },
  help: {
    title: {
      en: "Get your API key from ZHIPU AI",
      "zh-CN": "从智谱 AI 获取 API Key",
    },
    url: {
      en: "https://open.bigmodel.cn/usercenter/apikeys",
      "zh-CN": "https://open.bigmodel.cn/usercenter/apikeys",
    },
  },
  models: modelCatalog,
  name: { en: "ZHIPU AI", "zh-CN": "智谱 AI" },
  networkHosts: ["open.bigmodel.cn"],
  provider: "zhipuai",
};

/**
 * 凭据验证：发送一次 max_tokens=1 的最小补全请求。
 * 等价于 Dify ZhipuAILargeLanguageModel.validate_credentials 的探测行为；
 * Base URL 与探测模型由插件固定提供，管理员只需填写 API Key。
 */
export async function validateCredentials(
  ctx: ValidateCredentialsContext
): Promise<void> {
  const apiKey =
    typeof ctx.credentials.api_key === "string"
      ? ctx.credentials.api_key.trim()
      : "";
  if (!apiKey) {
    throw new Error("api_key is required");
  }

  const probe = () =>
    ctx.fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: "ping", role: "user" }],
        model: VALIDATION_MODEL,
        stream: false,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: ctx.signal,
    });

  let response = await probe();

  // Retry throttled probes briefly: 429 happens after auth on these providers
  // (invalid keys get 401/403), so it is transient and not a key problem.
  for (const delayMs of THROTTLE_RETRY_DELAYS_MS) {
    if (response.status !== 429) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential backoff before retrying the throttled probe
    await sleep(delayMs, ctx.signal);
    response = await probe();
  }

  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Invalid API key (HTTP ${response.status})`);
  }
  if (response.status === 429) {
    // Still throttled after retries: the key was authenticated, so accept it
    // and let the admin save the configuration despite the current rate limit.
    ctx.logger.warn(
      "Credential accepted, but the provider throttled the validation probe (HTTP 429)"
    );
    return;
  }
  throw new Error(
    `Credential validation failed: HTTP ${response.status} ${response.statusText}`
  );
}
