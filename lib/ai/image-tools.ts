import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantImages } from "@earendil-works/pi-ai";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import type { DeliveredFileData } from "@/lib/types";
import type { StoredFile } from "./file-store";
import {
  getImageGenerationSetup,
  type ImageGenerationModelInfo,
  type ImageGenerationSetup,
  MAX_IMAGES_PER_CALL,
} from "./image-generation";
import { generateChatImage } from "./pi";
import { createPrivateFileStore } from "./private-file-store";

/**
 * image_gen 平台工具：调用 piwork 图像生成通道（Pi `Models.generateImages`
 * → 宿主侧 DashScope images Provider），产物落到聊天工作区（执行类会话）
 * 与平台私有存储（下载链接），凭据不离开服务进程。
 * 由 backend 注入（与 deliver_file 同款模式）：onDelivered 把每张图作为
 * artifact.created 附件卡片推入事件流——聊天 UI 的 markdown 渲染器不放行
 * 相对路径图片 URL，卡片是图像的正确交付形态。
 */

// 与 deliver_file 同款出站存储（A5/S5：URL 经鉴权下载路由）
const imagePrivateStore = createPrivateFileStore();

export type ImageGenResult = {
  images: { path?: string; url: string }[];
  model: string;
};

type ImageGenerateInput = {
  modelId: string;
  prompt: string;
  n?: number;
  signal?: AbortSignal;
  size?: string;
};

function defaultGenerate(input: ImageGenerateInput): Promise<AssistantImages> {
  return generateChatImage(input);
}

/**
 * auto 路由：model 参数省略时按 prompt 关键词选模型（先匹配场景，命中且
 * 在目录内才用；否则回退平台默认）。纯启发式，选择依据回显给模型与用户。
 */
function autoModelSuits(prompt: string, modelId: string): boolean {
  if (modelId === "wan2.7-image-pro") {
    return /图文|排版|文字|标题|封面文案|海报文案|infographic/i.test(prompt);
  }
  if (modelId === "qwen-image-3.0-pro") {
    return /海报|艺术|高质量|精细|商业|插画|国风|水彩|油画|大片|写实/i.test(
      prompt
    );
  }
  if (modelId === "z-image-turbo") {
    return /快速|草图|草稿|示意|简单|试一下|多张|备选|头像|表情/i.test(prompt);
  }
  return false;
}

function autoReasonFor(modelId: string): string {
  if (modelId === "wan2.7-image-pro") {
    return "按 prompt 自动选择：图文混排/文字排版";
  }
  if (modelId === "qwen-image-3.0-pro") {
    return "按 prompt 自动选择：高质量/艺术创作";
  }
  return "按 prompt 自动选择：快速草稿/多方案";
}

function resolveAutoModel(
  prompt: string,
  models: ImageGenerationModelInfo[],
  defaultModelId: string
): { modelId: string; reason: string } {
  for (const candidate of [
    "wan2.7-image-pro",
    "qwen-image-3.0-pro",
    "z-image-turbo",
  ]) {
    if (autoModelSuits(prompt, candidate)) {
      const hit = models.find((item) => item.modelId === candidate);
      if (hit) {
        return { modelId: hit.modelId, reason: autoReasonFor(candidate) };
      }
    }
  }
  const fallback =
    models.find((item) => item.modelId === defaultModelId) ?? models[0];
  return fallback
    ? { modelId: fallback.modelId, reason: "按 prompt 自动选择（默认档）" }
    : { modelId: defaultModelId, reason: "平台默认模型" };
}

export function createImageGenTool({
  cwd = process.cwd(),
  workspaceDir,
  generate = defaultGenerate,
  getSetup = getImageGenerationSetup,
  onDelivered,
  onStored,
}: {
  cwd?: string;
  /** 执行类会话的工作区；提供时产物额外落盘，便于后续处理与 deliver_file */
  workspaceDir?: string | null;
  /** 测试注入：替换真实生成调用 */
  generate?: (input: ImageGenerateInput) => Promise<AssistantImages>;
  /** 测试注入：替换可用性探测 */
  getSetup?: () => Promise<ImageGenerationSetup | null>;
  /** backend 注入：每张图作为附件卡片推送（artifact.created） */
  onDelivered?: (file: DeliveredFileData) => void;
  /** backend 注入：产物归档（与 deliver_file 同款库归档钩子） */
  onStored?: (file: StoredFile, size: number) => Promise<void>;
} = {}): AgentTool {
  return {
    description:
      "Generate images from a text prompt with piwork's image generation models (Tongyi: Qwen-Image, Wan, Z-Image). Call it only when the user explicitly asks to generate/create/paint an image (画一张/生成图片/文生图/帮我画). Pass a complete visual prompt (subject, style, composition, lighting); leave `model` empty for auto-routing by prompt (quality/art → qwen-image-3.0, fast drafts/alternatives → z-image-turbo, text-in-image layouts → wan2.7); do not call it for image processing tasks (use the image-processing skill's local operations instead). Generated images are delivered to the user automatically as attachment cards.",
    execute: async (toolCallId, params) => {
      const { model, n, prompt, size } = params as {
        model?: string;
        n?: number;
        prompt: string;
        size?: string;
      };
      const setup = await getSetup();
      if (!setup) {
        throw new Error(
          "image_gen: 图像生成未配置——需要在管理端安装通义插件、填写凭据并启用图像模型"
        );
      }
      const auto = !model;
      const choice = auto
        ? resolveAutoModel(prompt, setup.models, setup.defaultModelId)
        : { modelId: model, reason: "" };
      const info = setup.models.find((item) => item.modelId === choice.modelId);
      if (!info) {
        throw new Error(
          `image_gen: unknown image model "${choice.modelId}"; available: ${setup.models
            .map((item) => item.modelId)
            .join(", ")}`
        );
      }
      const count =
        typeof n === "number" && n >= 1
          ? Math.min(Math.floor(n), MAX_IMAGES_PER_CALL)
          : 1;
      const result = await generate({
        modelId: choice.modelId,
        n: count,
        prompt,
        size,
      });
      if (result.stopReason !== "stop" || result.output.length === 0) {
        throw new Error(result.errorMessage || "image_gen: generation failed");
      }

      const stamp = Date.now().toString(36);
      const workspace = workspaceDir ? path.resolve(cwd, workspaceDir) : null;
      if (workspace) {
        await mkdir(path.join(workspace, "generated"), { recursive: true });
      }
      const imageParts = result.output.filter((part) => part.type === "image");
      const outputs = await Promise.all(
        imageParts.map(
          async (
            part,
            index
          ): Promise<{
            bytes: Buffer;
            filename: string;
            path?: string;
            stored: StoredFile;
          }> => {
            if (part.type !== "image") {
              throw new Error("unreachable");
            }
            const number = index + 1;
            const filename = `image-${stamp}-${number}.png`;
            const bytes = Buffer.from(part.data, "base64");
            const stored = await imagePrivateStore({
              content: bytes,
              contentType: "image/png",
              filename,
              operationKey: `imagegen:${toolCallId}:${number}`,
            });
            const relative = workspace ? `generated/${filename}` : undefined;
            if (workspace && relative) {
              await writeFile(path.join(workspace, relative), bytes);
            }
            return { bytes, filename, path: relative, stored };
          }
        )
      );
      if (outputs.length === 0) {
        throw new Error("image_gen: generation returned no images");
      }

      // 附件卡片交付（backend 注入的 artifact.created 通道）：
      // markdown 渲染器不放行相对路径图片 URL，卡片才是图像的展示形态
      for (const item of outputs) {
        await onStored?.(item.stored, item.bytes.byteLength);
        onDelivered?.({
          contentType: "image/png",
          filename: item.filename,
          url: item.stored.url,
          ...(item.stored.downloadUrl
            ? { downloadUrl: item.stored.downloadUrl }
            : {}),
        });
      }

      const priceNote = info.pricePerImage
        ? `（${info.pricePerImage} ${info.currency === "CNY" ? "元" : (info.currency ?? "")}/张，共 ${outputs.length} 张）`
        : "";
      const reasonNote = auto ? `；${choice.reason}` : "";
      const lines = [
        `已用 ${info.name}（${choice.modelId}）生成 ${outputs.length} 张图片${priceNote}${reasonNote}。`,
        "图片已作为附件卡片直接展示给用户，不要再用 Markdown 图片语法重复贴图。",
        ...(workspace
          ? [
              "后续去水印/抠图等处理可用 image-processing skill 直接读这些文件：",
              ...outputs.map((item) => `- ${item.path}`),
            ]
          : []),
      ];
      return {
        content: [{ text: lines.join("\n"), type: "text" }],
        details: {
          images: outputs.map((item) => ({
            path: item.path,
            url: item.stored.url,
          })),
          model: choice.modelId,
        },
      };
    },
    executionMode: "sequential",
    label: "Generate image",
    name: "image_gen",
    parameters: obj({
      model: opt(
        str({
          description:
            "Optional image model id from the platform catalog. Omit for auto-routing by prompt (quality/art → qwen-image-3.0, fast drafts → z-image-turbo, text-in-image layout → wan2.7). Examples: qwen-image-3.0, wan2.6-t2i, z-image-turbo.",
        })
      ),
      n: opt(
        int({
          description: `Number of images to generate (1-${MAX_IMAGES_PER_CALL}, default 1)`,
          maximum: MAX_IMAGES_PER_CALL,
          minimum: 1,
        })
      ),
      prompt: str({
        description:
          "Complete text-to-image prompt: subject, style, composition, lighting, quality cues",
      }),
      size: opt(
        str({
          description:
            "Optional image size like 1024*1024, 1664*928, 1472*1140 (DashScope format)",
        })
      ),
    }),
  };
}
