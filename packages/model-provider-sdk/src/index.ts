/**
 * @piwork/model-provider-sdk
 *
 * piwork 模型供应商插件（`piwork-llm-*`）的 package contract。
 * 插件入口 `src/index.ts` 默认导出 activate factory，通过受限的
 * `PiworkLlmExtensionAPI.registerProvider()` 注册完整 Pi `Provider`。
 *
 * 详见 docs/research/model-provider-plugin-architecture.md §5.4。
 */

import type { Provider } from "@earendil-works/pi-ai";

/** 插件 contract 版本，与 manifest 的 schemaVersion 对应 */
export const SDK_SCHEMA_VERSION = 1;

/** 本地化文案：键为 BCP-47 风格 locale（zh-CN / en），至少提供 en */
export type LocalizedText = Record<string, string>;

/** 凭据表单字段类型（迁移自 Dify credential_form_schemas） */
export type CredentialFieldType = "secret-input" | "text-input" | "select";

export type CredentialFieldSchema = {
  /** 凭据变量名，例如 api_key / endpoint_url */
  variable: string;
  type: CredentialFieldType;
  label: LocalizedText;
  required: boolean;
  placeholder?: LocalizedText;
  help?: { title: LocalizedText; text: LocalizedText };
  default?: string;
  options?: { label: LocalizedText; value: string }[];
};

export type ProviderModelPricing = {
  /** 每百万 token 单价 */
  input: number;
  output: number;
  inputCached?: number;
  currency?: "CNY" | "USD";
};

/** 模型调用参数规则（迁移自 Dify parameter_rules） */
export type ProviderModelParameterRule = {
  name: string;
  type: "float" | "int" | "string" | "boolean";
  label?: LocalizedText;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  options?: string[];
  help?: LocalizedText;
};

/** 图像生成模型的按张计价（区别于对话模型的每百万 token 计价） */
export type ProviderImageModelPricing = {
  currency?: "CNY" | "USD";
  /** 每张输入参考图片单价；按输出计费的模型可省略 */
  input?: number;
  /** 每张输出图片单价（取基准分辨率档） */
  output: number;
};

/** 对话模型（迁移自 Dify features / model_properties） */
export type ProviderChatModelDefinition = {
  /** 上游模型 id，例如 deepseek-v4-flash */
  modelId: string;
  modelType: "llm";
  label: LocalizedText;
  features: {
    vision: boolean;
    reasoning: boolean;
    toolCall: boolean;
    streamToolCall: boolean;
  };
  properties: {
    mode: "chat";
    /** 上下文窗口（token） */
    contextSize: number;
    /** 默认输出 token 上限 */
    defaultMaxTokens: number;
  };
  parameterRules: ProviderModelParameterRule[];
  pricing?: ProviderModelPricing;
  deprecated?: boolean;
};

/**
 * 图像生成模型（文生图 / 图生图编辑）。管理端仅做目录登记与启用开关，
 * 生成链路由宿主的图像生成消费方按 modelId 调用 DashScope 接口。
 */
export type ProviderImageModelDefinition = {
  /** 上游模型 id，例如 qwen-image-3.0-pro */
  modelId: string;
  modelType: "image";
  label: LocalizedText;
  features: {
    /** 支持图像输入（图生图 / 参考图编辑 / 图片翻译） */
    vision: boolean;
    /** 可同时输出文本（图文混排） */
    textOutput?: boolean;
  };
  parameterRules?: ProviderModelParameterRule[];
  pricing?: ProviderImageModelPricing;
  deprecated?: boolean;
};

/** 模型目录条目：llm 与 image 两类，按 modelType 判别 */
export type ProviderModelDefinition =
  | ProviderChatModelDefinition
  | ProviderImageModelDefinition;

/** 供应商静态定义：名称、凭据 schema、模型目录与网络权限声明 */
export type ProviderDefinition = {
  /** Administrator context limits, preserved independently of packaged catalogs. */
  contextWindowOverrides?: Record<string, number>;
  /** Wire protocol for declarative custom providers; executable plugins own their dispatch. */
  api?: "openai-completions" | "anthropic-messages" | "openai-responses";
  /** provider key，等于 manifest 的 provider 字段（小写 kebab-case） */
  provider: string;
  name: LocalizedText;
  description: LocalizedText;
  help: { title: LocalizedText; url: LocalizedText };
  credentialFields: CredentialFieldSchema[];
  /** Public default endpoint for configuration UI; never derived from secret credentials. */
  defaultBaseUrl?: string;
  models: ProviderModelDefinition[];
  /** 声明需要访问的网络 host；宿主据此放行 */
  networkHosts: string[];
};

/** 宿主注入的脱敏 logger：secret 值在跨宿主边界前已被替换 */
export interface PluginLogger {
  error: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
}

export interface ProviderFactoryContext {
  config: Readonly<Record<string, unknown>>;
  /** 已按 definition schema 校验的凭据（secret 仅在激活时注入，不得持久化） */
  credentials: Readonly<Record<string, unknown>>;
  fetch: typeof globalThis.fetch;
  installationId: string;
  logger: PluginLogger;
  /** provider key（例如 deepseek），来自 manifest */
  providerId: string;
  /** 本安装实例在 Pi registry 中的运行时 provider id */
  runtimeProviderId: string;
}

/** 受限扩展 API：与 Pi 官方 extension 的 registerProvider 语义一致 */
export interface PiworkLlmExtensionAPI {
  readonly context: ProviderFactoryContext;
  onDispose: (handler: () => void | Promise<void>) => void;
  /** 必须且只能调用一次；注册的 Provider.id 必须等于 context.runtimeProviderId */
  registerProvider: (provider: Provider) => void;
}

/** validateCredentials 的注入上下文（不触碰进程环境与文件系统） */
export type ValidateCredentialsContext = {
  credentials: Readonly<Record<string, unknown>>;
  config: Readonly<Record<string, unknown>>;
  fetch: typeof globalThis.fetch;
  logger: PluginLogger;
  signal?: AbortSignal;
};

/** piwork-llm-* 插件入口模块 contract */
export type PiworkLlmPluginModule = {
  definition: ProviderDefinition;
  /** 凭据验证：失败抛错，错误消息会展示给管理员 */
  validateCredentials: (ctx: ValidateCredentialsContext) => Promise<void>;
  /** 默认导出的 activate factory */
  activate: (pi: PiworkLlmExtensionAPI) => void | Promise<void>;
};

/** 插件作者用它获得模块类型检查；运行时为恒等函数 */
export function definePlugin(
  module: PiworkLlmPluginModule
): PiworkLlmPluginModule {
  return module;
}
