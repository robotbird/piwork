import "server-only";

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { VirtualModelDefinition } from "@earendil-works/pi-coding-agent";

/**
 * piwork 虚拟模型公共件（Pi virtual model，见 Pi 官方 virtual-models 文档
 * 与 examples/extensions/jev-router.ts）。
 *
 * 目录条目按官方 `createVirtualModel` 的输出语义手工构造（该函数未从
 * pi-coding-agent 包根导出）：thinkingLevels → thinkingLevelMap 映射，
 * reasoning = 含任一非 off 档位。会话默认思考等级 medium 落在
 * ["low","medium","high"] 内，route() 透传 request.thinkingLevel，
 * 运行时再按物理模型 clamp——编排模型不会被悄悄关掉思考。
 */

/** Pi 虚拟目录条目的 api id（pi-coding-agent VIRTUAL_MODEL_API，未从包根导出） */
const VIRTUAL_MODEL_API_ID = "pi-virtual";

const ALL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type VirtualCatalogModelInput = {
  id: string;
  name: string;
  provider: string;
  thinkingLevels?: readonly ModelThinkingLevel[];
};

/** 官方 createVirtualModel 语义的目录条目（contextWindow/maxTokens 0 = 未知） */
export function buildVirtualCatalogModel({
  id,
  name,
  provider,
  thinkingLevels = ["off"],
}: VirtualCatalogModelInput): Model<Api> {
  const levels = new Set(thinkingLevels);
  const thinkingLevelMap = Object.fromEntries(
    ALL_THINKING_LEVELS.map((level) => [
      level,
      levels.has(level) ? level : null,
    ])
  ) as Record<ModelThinkingLevel, ModelThinkingLevel | null>;
  return {
    api: VIRTUAL_MODEL_API_ID,
    baseUrl: "",
    // 0 = unknown（官方约定：首个物理响应前的展示上限）
    contextWindow: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text", "image"],
    maxTokens: 0,
    name,
    provider,
    reasoning: [...levels].some((level) => level !== "off"),
    thinkingLevelMap,
  };
}

/** 「Auto 智能路由」虚拟模型完整 id：聊天目录 / getPiModel 均用该值 */
export const AUTO_VIRTUAL_MODEL_ID = "piwork/auto";

/** 虚拟模型统一挂载的 provider id（目录/UI 据此识别虚拟条目） */
export const VIRTUAL_MODEL_PROVIDER = "piwork";

export type AutoVirtualRouting = {
  /** 快速档：简单问题与 direct 请求（压缩摘要等）的默认目标 */
  fast: Model<Api>;
  /** 高质量档：复杂提示词的目标；缺省时一律走 fast */
  quality?: Model<Api>;
};

type AutoRouteState = {
  tier: "fast" | "quality";
};

/**
 * Auto 分层启发式：纯关键词 + 篇幅判断（无分类模型依赖，确定性可测）。
 * 命中复杂信号 → quality 档；否则 fast 档。
 */
export function classifyAutoTier(prompt: string): "fast" | "quality" {
  const text = prompt.trim();
  if (text.length >= 120) {
    return "quality";
  }
  return QUALITY_SIGNAL.test(text) ? "quality" : "fast";
}

const QUALITY_SIGNAL =
  /复杂|深入|详细|仔细|架构|设计|评审|审查|重构|优化|排查|调试|根因|分析|论证|推导|数学|推理|论文|报告|方案|规划|策略|对比|权衡| trade-?off|architect|refactor|debug|root cause|analyz|review|design|in depth|step by step/i;

function lastUserText(
  messages: ReadonlyArray<{ role: string; content: unknown }>
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return (message.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
    }
    return "";
  }
  return "";
}

/**
 * 「Auto 智能路由」虚拟模型定义。
 *
 * 路由策略（对齐官方 jev-router 的单次切换/cache 友好原则）：
 * - direct（压缩摘要等会话外请求）→ fast 档；
 * - 工具循环/重试 → 粘住最近物理模型（运行时保证 previous/failed 为物理模型）；
 * - 用户消息 → 按提示词分层；与当前 state 同档则保持原模型（零 cache 失配），
 *   跨档才切换（接受一次 cache 失配）。
 * - thinkingLevel 一律透传 request.thinkingLevel，由运行时按物理模型 clamp。
 */
export function autoVirtualModelDefinition(
  routing: AutoVirtualRouting
): VirtualModelDefinition<AutoRouteState> {
  return {
    id: "auto",
    name: "Auto 智能路由",
    provider: VIRTUAL_MODEL_PROVIDER,
    route(request) {
      const passThrough =
        request.previous?.thinkingLevel ??
        request.failed?.thinkingLevel ??
        request.thinkingLevel;
      if (request.reason === "direct") {
        return {
          model: routing.fast,
          thinkingLevel: request.thinkingLevel,
        };
      }
      const sticky = request.failed?.model ?? request.previous?.model;
      if (request.reason !== "user" && sticky) {
        return { model: sticky, thinkingLevel: passThrough };
      }
      const target =
        routing.quality &&
        classifyAutoTier(lastUserText(request.messages)) === "quality"
          ? routing.quality
          : routing.fast;
      const tier = target === routing.fast ? "fast" : "quality";
      const state = request.state as AutoRouteState | undefined;
      // 同档保持原模型：会话内不重复切换，prompt cache 稳定
      if (sticky && state && state.tier === tier) {
        return { model: sticky, state, thinkingLevel: passThrough };
      }
      return {
        model: target,
        state: { tier },
        thinkingLevel: passThrough,
      };
    },
  };
}

/** Auto 的目录条目（下拉首位展示） */
export function autoVirtualCatalogModel(): Model<Api> {
  return buildVirtualCatalogModel({
    id: "auto",
    name: "Auto 智能路由",
    provider: VIRTUAL_MODEL_PROVIDER,
    thinkingLevels: ["low", "medium", "high"],
  });
}
