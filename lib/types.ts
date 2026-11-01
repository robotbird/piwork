import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { createDocument } from "./ai/tools/create-document";
import type { getWeather } from "./ai/tools/get-weather";
import type { requestSuggestions } from "./ai/tools/request-suggestions";
import type { updateDocument } from "./ai/tools/update-document";
import type { Suggestion } from "./db/schema";

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
  /** 用户消息的发送者；assistant/旧消息为 undefined。仅用于展示归属头像 */
  userId: z.string().optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type weatherTool = InferUITool<typeof getWeather>;
type createDocumentTool = InferUITool<ReturnType<typeof createDocument>>;
type updateDocumentTool = InferUITool<ReturnType<typeof updateDocument>>;
type requestSuggestionsTool = InferUITool<
  ReturnType<typeof requestSuggestions>
>;

export type ChatTools = {
  getWeather: weatherTool;
  createDocument: createDocumentTool;
  updateDocument: updateDocumentTool;
  requestSuggestions: requestSuggestionsTool;
};

export type WaitingStatusData = {
  phase: "waiting" | "still-waiting" | "health" | "thinking";
  message: string;
  modelId: string;
  modelName: string;
};

export type ToolStatusData = {
  detail?: string;
  phase: "start" | "end";
  toolName: string;
  message: string;
  isError?: boolean;
};

export type DeliveredFileData = {
  filename: string;
  contentType: string;
  url: string;
  downloadUrl?: string;
};

export type CustomUIDataTypes = {
  textDelta: string;
  imageDelta: string;
  sheetDelta: string;
  codeDelta: string;
  suggestion: Suggestion;
  appendMessage: string;
  id: string;
  title: string;
  kind: ArtifactKind;
  clear: null;
  finish: null;
  "chat-title": string;
  "waiting-status": WaitingStatusData;
  "tool-status": ToolStatusData;
  "delivered-file": DeliveredFileData;
  /** (runId, seq) 游标：transient 直传，客户端存内存 ref 供断线重连 */
  "runtime-cursor": RuntimeCursorData;
  "reasoning-timing": ReasoningTimingData;
};

export type RuntimeCursorData = {
  runId: string;
  seq: number;
};

/**
 * reasoning 块的服务端起止时刻（epoch ms，取自 message.delta 的 at）：
 * transient 直传，客户端据此展示思考总耗时与每步耗时——断线重连/重放时
 * 到达时刻失真，服务端时刻仍准确。
 */
export type ReasoningTimingData = {
  id: string;
  phase: "start" | "end";
  at: number;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

/** 分享协作的参与者投影（不含 email 等联系方式），用于头像/名字展示 */
export type ChatParticipantInfo = {
  image: string | null;
  joinedAt: string;
  name: string | null;
  role: "owner" | "collaborator";
  title: string | null;
  userId: string;
};

export type ChatMyRole = "owner" | "collaborator" | null;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
