import "server-only";

import type {
  Api,
  AssistantImages,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  ImagesOutputContent,
  Model,
  Provider,
  ProviderImages,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import type { VirtualModelDefinition } from "@earendil-works/pi-coding-agent";
import type { ProviderImageModelDefinition } from "@piwork/model-provider-sdk";
import { isTestEnvironment } from "@/lib/constants";
import { listPluginInstallations } from "@/lib/db/model-plugin-queries";
import { decryptPluginCredentials } from "@/lib/model-plugins/credentials";
import {
  loadPluginInstallations,
  type PluginInstallationRuntime,
  pickLocalizedText,
} from "@/lib/model-plugins/registry";
import {
  buildVirtualCatalogModel,
  VIRTUAL_MODEL_PROVIDER,
} from "./virtual-models";

/**
 * piwork 图像生成通道（v1：通义 DashScope OpenAI 兼容模式 images 端点）。
 *
 * 链路：插件目录中的 image 模型 → 宿主侧 images Provider（pi-ai
 * `createProvider({ images })` 官方契约）→ 会话内 `image_gen` 平台工具调用
 * `Models.generateImages`。凭据始终留在服务进程（复用插件安装的加密凭据），
 * 不进入聊天工作区。
 *
 * 同时定义「图像生成」虚拟模型（Pi virtual model）：选中它时每次请求经
 * `route()` 派给一个物理编排 LLM，编排模型通过 image_gen 工具完成出图；
 * 用户无需切回普通模型即可继续对话。
 */

/** 自定义 ImageApi id（pi-ai 允许字符串扩展名；KnownImageApi 只有 openrouter） */
export const DASHSCOPE_IMAGES_API = "dashscope-images";

/** 宿主侧图像生成 Provider 在 Models registry 中的 id */
export const IMAGE_GENERATION_PROVIDER_ID = "piwork-images";

/** 虚拟模型（图像生成模式）完整 id：聊天目录 / getPiModel 均用该值 */
export const IMAGE_VIRTUAL_MODEL_ID = "piwork/image-gen";

const IMAGE_VIRTUAL_PROVIDER = VIRTUAL_MODEL_PROVIDER;
const IMAGE_VIRTUAL_MODEL_NAME = "image-gen";

/** 默认出图模型：千问图像 3.0（同步端点、0.18 元/张） */
export const DEFAULT_IMAGE_MODEL_ID = "qwen-image-3.0";

const MAX_IMAGES_PER_CALL = 4;

export { MAX_IMAGES_PER_CALL };

export type ImageGenerationModelInfo = {
  modelId: string;
  name: string;
  /** 每张输出价格（plugin 目录定价，货币见 currency） */
  pricePerImage?: number;
  currency?: string;
};

export type ImageGenerationInfo = {
  defaultModelId: string;
  models: ImageGenerationModelInfo[];
  providerName: string;
};

/** 装配一个可用图像生成通道所需的全部输入（含解密后的凭据） */
export type ImageGenerationSetup = ImageGenerationInfo & {
  apiKey: string;
  baseUrl: string;
  imageModels: ImageModel<typeof DASHSCOPE_IMAGES_API>[];
};

function toModelInfo(
  definition: ProviderImageModelDefinition
): ImageGenerationModelInfo {
  return {
    currency: definition.pricing?.currency,
    modelId: definition.modelId,
    name: pickLocalizedText(definition.label) || definition.modelId,
    pricePerImage: definition.pricing?.output,
  };
}

async function readTongyiApiKey(): Promise<string | null> {
  const records = await listPluginInstallations();
  const record = records.find(
    (item) =>
      item.providerKey === "tongyi" &&
      item.enabled &&
      item.credentialsConfigured
  );
  if (!record) {
    return null;
  }
  try {
    const credentials = decryptPluginCredentials(record.encryptedCredentials);
    const apiKey =
      typeof credentials.api_key === "string" ? credentials.api_key.trim() : "";
    return apiKey || null;
  } catch {
    return null;
  }
}

/**
 * 当前可用的图像生成通道；测试环境恒为 null（与模型目录的 faux 策略一致）。
 * v1 只支持通义（DashScope compatible-mode images 端点）；其他插件的 image
 * 目录待插件契约扩展 images 调用后再接入。
 */
export async function getImageGenerationSetup(): Promise<ImageGenerationSetup | null> {
  if (isTestEnvironment) {
    return null;
  }
  const plugins = await loadPluginInstallations();
  const tongyi = plugins.find((plugin) => plugin.providerKey === "tongyi");
  if (!tongyi) {
    return null;
  }
  const definitions = tongyi.models.filter(
    (model): model is ProviderImageModelDefinition =>
      model.modelType === "image"
  );
  if (definitions.length === 0) {
    return null;
  }
  const apiKey = await readTongyiApiKey();
  if (!apiKey) {
    return null;
  }
  const baseUrl =
    tongyi.definition.defaultBaseUrl ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const providerName =
    pickLocalizedText(tongyi.definition.name) || tongyi.displayName;
  return {
    apiKey,
    baseUrl,
    defaultModelId: definitions.some(
      (d) => d.modelId === DEFAULT_IMAGE_MODEL_ID
    )
      ? DEFAULT_IMAGE_MODEL_ID
      : definitions[0].modelId,
    imageModels: definitions.map((definition) =>
      toImageModel(IMAGE_GENERATION_PROVIDER_ID, definition, baseUrl)
    ),
    models: definitions.map(toModelInfo),
    providerName,
  };
}

/** 展示层信息（不含凭据）：聊天目录 / 工具描述使用 */
export async function getImageGenerationInfo(): Promise<ImageGenerationInfo | null> {
  const setup = await getImageGenerationSetup();
  if (!setup) {
    return null;
  }
  return {
    defaultModelId: setup.defaultModelId,
    models: setup.models,
    providerName: setup.providerName,
  };
}

/** 插件 image 目录 → pi-ai ImageModel（cost 为 token 语义，与按张计价不符，置零；真实价格走 ImageGenerationInfo） */
export function toImageModel(
  provider: string,
  definition: ProviderImageModelDefinition,
  baseUrl: string
): ImageModel<typeof DASHSCOPE_IMAGES_API> {
  return {
    api: DASHSCOPE_IMAGES_API,
    baseUrl,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: definition.modelId,
    input: ["text"],
    name: pickLocalizedText(definition.label) || definition.modelId,
    output: ["image"],
    provider,
    type: "image",
  };
}

function imagesError(
  model: ImageModel<typeof DASHSCOPE_IMAGES_API>,
  message: string
): AssistantImages {
  return {
    api: model.api,
    errorMessage: message,
    model: model.id,
    output: [],
    provider: model.provider,
    stopReason: "error",
    timestamp: Date.now(),
  };
}

/** DashScope 原生 multimodal-generation 同步响应（qwen-image / z-image / wan2.5+ 实测形状） */
type DashScopeNativeContent = { image?: string; text?: string; type?: string };
type DashScopeNativeResponse = {
  output?: {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: DashScopeNativeContent[] };
    }>;
    task_id?: string;
    task_status?: string;
    message?: string;
  };
  message?: string;
  code?: string;
};

async function fetchAsBase64(
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new Error(`failed to download generated image (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

/** compatible-mode baseUrl → 原生 API 根（同源） */
function nativeOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/**
 * DashScope 原生图像生成客户端，实现 pi-ai `ProviderImages` 契约。
 * 端点：`POST {origin}/api/v1/services/aigc/multimodal-generation/generation`
 * （同步模式，无 X-DashScope-Async；compatible-mode 无 /images/generations
 * 路由，实测 404）。请求形状为对话式 `input.messages`（qwen-image、
 * z-image、wan2.5+ 统一）；旧 wanx2.0/v1 与可灵/Vidu 走各自异步端点，
 * 本通道未接——错误原样透传。v1 只接受文本 prompt（图生图待接入）。
 */
export function createDashScopeImagesFunction({
  apiKey,
  baseUrl,
  fetchImpl = fetch,
}: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): ProviderImages {
  return {
    async generateImages(
      model: ImageModel<typeof DASHSCOPE_IMAGES_API>,
      context: ImagesContext,
      options?: ImagesOptions & Record<string, unknown>
    ): Promise<AssistantImages> {
      const extra = (options ?? {}) as { n?: number; size?: string };
      const signal = options?.signal;
      const prompt = context.input
        .filter(
          (part): part is Extract<typeof part, { type: "text" }> =>
            part.type === "text"
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!prompt) {
        return imagesError(model, "image_gen: prompt is required");
      }
      if (context.input.some((part) => part.type === "image")) {
        return imagesError(
          model,
          "image_gen: image input (图生图/局部重绘) 尚未接入，当前仅支持文生图；编辑类需求请先用图像处理 skill 的本地能力"
        );
      }
      const count =
        typeof extra.n === "number" && extra.n >= 1
          ? Math.min(Math.floor(extra.n), MAX_IMAGES_PER_CALL)
          : 1;
      // wan 系尺寸下限约 768×768；缺省 1024×1024 对全部已接模型安全
      const size =
        typeof extra.size === "string" && extra.size ? extra.size : "1024*1024";
      const body = {
        input: {
          messages: [{ content: [{ text: prompt }], role: "user" }],
        },
        model: model.id,
        parameters: { n: count, size },
      };

      let response: Response;
      try {
        response = await fetchImpl(
          `${nativeOrigin(baseUrl)}/api/v1/services/aigc/multimodal-generation/generation`,
          {
            body: JSON.stringify(body),
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            method: "POST",
            signal,
          }
        );
      } catch (error) {
        return imagesError(
          model,
          `image_gen: request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 400);
        return imagesError(
          model,
          `image_gen: DashScope ${response.status}: ${text}`
        );
      }
      let payload: DashScopeNativeResponse;
      try {
        payload = (await response.json()) as DashScopeNativeResponse;
      } catch {
        return imagesError(model, "image_gen: invalid JSON from DashScope");
      }
      const choices = payload.output?.choices ?? [];
      const imageUrls = choices.flatMap((choice) =>
        (choice.message?.content ?? [])
          .map((part) => part.image)
          .filter((url): url is string => typeof url === "string" && !!url)
      );
      if (imageUrls.length === 0) {
        const taskHint = payload.output?.task_id
          ? `模型 ${model.id} 走异步任务接口，暂不支持；请改用同步模型（如 ${DEFAULT_IMAGE_MODEL_ID}、wan2.6-t2i）`
          : payload.message ||
            payload.output?.message ||
            "empty image response";
        return imagesError(model, `image_gen: ${taskHint}`);
      }
      try {
        const images = await Promise.all(
          imageUrls.map(
            async (url): Promise<ImagesOutputContent> => ({
              data: await fetchAsBase64(url, signal, fetchImpl),
              mimeType: "image/png",
              type: "image",
            })
          )
        );
        return {
          api: model.api,
          model: model.id,
          output: images,
          provider: model.provider,
          stopReason: "stop",
          timestamp: Date.now(),
        };
      } catch (error) {
        return imagesError(
          model,
          `image_gen: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  };
}

/** 宿主侧 images-only Provider（pi-ai 官方 `createProvider({ images })` 形态） */
export function buildImageGenerationProvider(setup: {
  apiKey: string;
  baseUrl: string;
  imageModels: ImageModel<typeof DASHSCOPE_IMAGES_API>[];
}): Provider {
  return createProvider({
    auth: {
      apiKey: {
        // 凭据来自插件安装记录，已在此闭包内解析；Pi auth 层拿到的恒为已配置状态
        name: "Piwork 图像生成（通义 API Key）",
        resolve: async () => ({ auth: { apiKey: setup.apiKey } }),
      },
    },
    baseUrl: setup.baseUrl,
    id: IMAGE_GENERATION_PROVIDER_ID,
    images: {
      [DASHSCOPE_IMAGES_API]: createDashScopeImagesFunction({
        apiKey: setup.apiKey,
        baseUrl: setup.baseUrl,
      }),
    },
    models: setup.imageModels,
    name: "Piwork 图像生成",
  });
}

/**
 * 「图像生成」虚拟模型目录条目。等价于 Pi 的 `createVirtualModel`——该函数
 * 未从 pi-coding-agent 包根导出，按官方 `VIRTUAL_MODEL_API` 语义手工构造。
 */
export function imageGenVirtualCatalogModel(): Model<Api> {
  return buildVirtualCatalogModel({
    id: IMAGE_VIRTUAL_MODEL_NAME,
    name: "图像生成",
    provider: IMAGE_VIRTUAL_PROVIDER,
    thinkingLevels: ["low", "medium", "high"],
  });
}

/**
 * 注册进 ModelRuntime 的虚拟模型定义（Pi virtual model）。
 * 路由策略：用户消息 → 编排 LLM（默认物理模型）；工具循环/重试/续写 →
 * 粘住最近成功（或失败待重试）的物理模型，保住 prompt cache。
 */
export function imageGenVirtualModelDefinition(
  resolveOrchestrator: () => Model<Api> | undefined
): VirtualModelDefinition {
  return {
    id: IMAGE_VIRTUAL_MODEL_NAME,
    name: "图像生成",
    provider: IMAGE_VIRTUAL_PROVIDER,
    route(request) {
      // thinkingLevel 透传（官方示例模式）：由运行时按物理模型 clamp，
      // 不在此悄悄关掉编排模型的思考
      const passThrough =
        request.previous?.thinkingLevel ??
        request.failed?.thinkingLevel ??
        request.thinkingLevel;
      const sticky = request.failed?.model ?? request.previous?.model;
      if (request.reason !== "user" && sticky) {
        return { model: sticky, thinkingLevel: passThrough };
      }
      const orchestrator = resolveOrchestrator();
      if (!orchestrator) {
        throw new Error(
          "image_gen virtual model: no orchestrator model available"
        );
      }
      return { model: orchestrator, thinkingLevel: passThrough };
    },
  };
}

/** 供 pi.ts ensurePiProviders 使用的装配结果 */
export type ImageGenerationProviderSetup = {
  available: boolean;
  /** 注册进 Models registry 的 image 模型（供 generateChatImage 直查） */
  imageModels?: ImageModel<typeof DASHSCOPE_IMAGES_API>[];
  provider?: Provider;
};

export async function resolveImageGenerationProviderSetup(): Promise<ImageGenerationProviderSetup> {
  const setup = await getImageGenerationSetup();
  if (!setup) {
    return { available: false };
  }
  return {
    available: true,
    imageModels: setup.imageModels,
    provider: buildImageGenerationProvider({
      apiKey: setup.apiKey,
      baseUrl: setup.baseUrl,
      imageModels: setup.imageModels,
    }),
  };
}

/** pluginCatalogModels 同款守卫：供目录/工具复用的 image 过滤 */
export function isImageRuntimePlugin(
  plugin: PluginInstallationRuntime
): boolean {
  return plugin.models.some((model) => model.modelType === "image");
}
