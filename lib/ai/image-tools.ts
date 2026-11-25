import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantImages } from "@earendil-works/pi-ai";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import type { DeliveredFileData } from "@/lib/types";
import { isInsideWorkspace } from "./agent-tools";
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

/** 参考图数量上限（qwen-image 编辑系实测 1–3 张为稳） */
const MAX_REFERENCE_IMAGES = 3;

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
  /** 参考图 base64（图生图/锚点派生；data/mimeType 进入生成请求） */
  references?: { data: string; mimeType: string }[];
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
  defaultModelId: string,
  hasReferences = false
): { modelId: string; reason: string } {
  // 带参考图（图生图/锚点派生）时优先支持编辑的模型：保主体换风格靠
  // 参考图硬约束，纯文生图模型会退化成"像但不是同一个"
  if (hasReferences) {
    for (const candidate of ["qwen-image-3.0", "qwen-image-3.0-pro"]) {
      const hit = models.find((item) => item.modelId === candidate);
      if (hit) {
        return {
          modelId: hit.modelId,
          reason: "按参考图自动选择：千问图像支持图生图编辑与风格派生",
        };
      }
    }
  }
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
  imageModelId,
  allowReferences = true,
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
  imageModelId?: string;
  allowReferences?: boolean;
  /** backend 注入：每张图作为附件卡片推送（artifact.created） */
  onDelivered?: (file: DeliveredFileData) => void;
  /** backend 注入：产物归档（与 deliver_file 同款库归档钩子） */
  onStored?: (file: StoredFile, size: number) => Promise<void>;
} = {}): AgentTool {
  return {
    description: imageModelId
      ? `Generate an image with the selected model ${imageModelId}. Treat visual descriptions as image requests and pass a complete visual prompt. Generated images are delivered automatically as attachment cards.`
      : "Generate or edit images with piwork's image generation models (Tongyi: Qwen-Image, Wan, Z-Image). Call it when the user asks to generate/create/paint an image (画一张/生成图片/文生图/帮我画) or to derive/edit from an existing image (换风格/以这张为参考/保持主体改成…). Pass a complete visual prompt (subject, style, composition, lighting); for anchor/style derivation pass workspace image paths via `references` and describe what to change rather than re-describing the scene. Leave `model` empty for auto-routing; do not call it for local pixel operations like watermark removal or background cutout (use the image-processing skill instead). Generated images are delivered to the user automatically as attachment cards.",
    execute: async (toolCallId, params, signal) => {
      const { model, n, prompt, references, size } = params as {
        model?: string;
        n?: number;
        prompt: string;
        references?: string[];
        size?: string;
      };
      const setup = await getSetup();
      if (!setup) {
        throw new Error(
          "image_gen: 图像生成未配置——需要在管理端安装通义插件、填写凭据并启用图像模型"
        );
      }
      const requestedModel = imageModelId ?? model;
      const choice = requestedModel
        ? { modelId: requestedModel, reason: "" }
        : resolveAutoModel(
            prompt,
            setup.models,
            setup.defaultModelId,
            Boolean(references?.length)
          );
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
      // 参考图：仅接受工作区内的文件（与 deliver_file 同款边界），读成
      // base64 带进生成请求——锚点链/保真派生的硬约束
      const workspace = workspaceDir ? path.resolve(cwd, workspaceDir) : null;
      const referenceInputs: { data: string; mimeType: string }[] = [];
      if (references?.length) {
        if (!workspace) {
          throw new Error(
            "image_gen: 参考图仅在执行类会话（聊天工作区）中可用；请让用户把参考图上传到对话"
          );
        }
        if (references.length > MAX_REFERENCE_IMAGES) {
          throw new Error(
            `image_gen: 参考图最多 ${MAX_REFERENCE_IMAGES} 张（收到 ${references.length} 张）`
          );
        }
        for (const reference of references) {
          if (!isInsideWorkspace(workspace, reference)) {
            throw new Error(
              `image_gen: reference path must be inside the chat workspace: ${reference}`
            );
          }
          // biome-ignore lint/performance/noAwaitInLoops: Bound concurrent reads of reference files.
          const bytes = await readFile(path.resolve(workspace, reference));
          referenceInputs.push({
            data: bytes.toString("base64"),
            mimeType: "image/png",
          });
        }
      }
      const result = await generate({
        modelId: choice.modelId,
        n: count,
        prompt,
        references: referenceInputs,
        signal,
        size,
      });
      if (result.stopReason !== "stop" || result.output.length === 0) {
        throw new Error(result.errorMessage || "image_gen: generation failed");
      }

      const stamp = Date.now().toString(36);
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
        // biome-ignore lint/performance/noAwaitInLoops: Archive each file before publishing its card in output order.
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
      const reasonNote = choice.reason ? `；${choice.reason}` : "";
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
      ...(imageModelId
        ? {}
        : {
            model: opt(
              str({
                description:
                  "Optional image model id from the platform catalog. Omit for auto-routing by prompt and references.",
              })
            ),
          }),
      ...(allowReferences
        ? {
            references: opt(
              arr(str(), {
                description:
                  "Workspace-relative reference image paths (max 3) for image-to-image: anchor derivation, style transfer, product fidelity. Describe what to change in the prompt, not the whole scene.",
              })
            ),
          }
        : {}),
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
