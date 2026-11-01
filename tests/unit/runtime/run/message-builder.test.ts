import "../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../../../lib/runtime/protocol";
import {
  buildAssistantMessageParts,
  deriveMessageId,
} from "../../../../lib/runtime/run/message-builder";

/** 构造 message.delta 事件的简写 */
function delta(
  channel: "text" | "reasoning" | "tool",
  sequence: number,
  contentIndex: number,
  phase: "start" | "delta" | "end",
  text?: string,
  at?: number
): RuntimeEvent {
  return {
    channel,
    contentIndex,
    ...(phase === "delta" && text !== undefined ? { delta: text } : {}),
    ...(at === undefined ? {} : { at }),
    phase,
    sequence,
    type: "message.delta",
  };
}

test("deriveMessageId：确定性 + 8-4-4-4-12 形状", () => {
  const runId = "0199aabb-ccdd-eeff-0011-223344556677";
  const id = deriveMessageId(runId);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  assert.equal(deriveMessageId(runId), id);
  assert.notEqual(deriveMessageId("0199aabb-ccdd-eeff-0011-223344556678"), id);
});

test("多 sequence/contentIndex：按 (channel,sequence,contentIndex) 分组累积", () => {
  const parts = buildAssistantMessageParts([
    { sequence: 1, type: "message.started" },
    delta("reasoning", 1, 0, "start"),
    delta("reasoning", 1, 0, "delta", "思考"),
    delta("reasoning", 1, 0, "delta", "内容"),
    delta("reasoning", 1, 0, "end"),
    delta("text", 1, 1, "start"),
    delta("text", 1, 1, "delta", "第一轮"),
    delta("text", 1, 1, "end"),
    { sequence: 1, type: "message.completed" },
    { sequence: 2, type: "message.started" },
    delta("text", 2, 0, "start"),
    delta("text", 2, 0, "delta", "第二轮"),
    delta("text", 2, 0, "end"),
    { sequence: 2, type: "message.completed" },
  ]);
  assert.deepEqual(parts, [
    { state: "done", text: "思考内容", type: "reasoning" },
    { state: "done", text: "第一轮", type: "text" },
    { state: "done", text: "第二轮", type: "text" },
  ]);
});

test("流式中（未收到 end）：state 保持 streaming", () => {
  const parts = buildAssistantMessageParts([
    delta("text", 1, 0, "start"),
    delta("text", 1, 0, "delta", "部分"),
  ]);
  assert.deepEqual(parts, [{ state: "streaming", text: "部分", type: "text" }]);
});

test("tool 通道 delta 不产生 part；artifact 事件追加 delivered-file", () => {
  const file = {
    contentType: "text/plain",
    filename: "report.txt",
    url: "/api/files/report",
  };
  const parts = buildAssistantMessageParts([
    delta("tool", 1, 0, "start"),
    delta("tool", 1, 0, "delta", "{}"),
    delta("tool", 1, 0, "end"),
    {
      args: { path: "report.txt" },
      toolCallId: "tc1",
      toolName: "deliver_file",
      type: "tool.started",
    },
    { file, type: "artifact.created" },
    {
      isError: false,
      toolCallId: "tc1",
      toolName: "deliver_file",
      type: "tool.completed",
    },
    delta("text", 2, 0, "start"),
    delta("text", 2, 0, "delta", "已交付"),
    delta("text", 2, 0, "end"),
  ]);
  assert.deepEqual(parts, [
    { data: file, type: "data-delivered-file" },
    { state: "done", text: "已交付", type: "text" },
  ]);
});

test("容错：缺 start 的 delta/end 被跳过，不抛错", () => {
  const parts = buildAssistantMessageParts([
    delta("text", 1, 0, "delta", "孤儿增量"),
    delta("text", 1, 0, "end"),
  ]);
  assert.deepEqual(parts, []);
});

test("空事件序列与终态事件：产出空 parts", () => {
  assert.deepEqual(
    buildAssistantMessageParts([
      { runId: "r1", type: "run.started" },
      { reason: "completed", runId: "r1", type: "run.settled" },
    ]),
    []
  );
  assert.deepEqual(buildAssistantMessageParts([]), []);
});

test("reasoning 块带 at 的 start/end 对：落库 durationMs；缺 at 不写字段", () => {
  const parts = buildAssistantMessageParts([
    delta("reasoning", 1, 0, "start", undefined, 1000),
    delta("reasoning", 1, 0, "delta", "第一步", 1500),
    delta("reasoning", 1, 0, "end", undefined, 4200),
    delta("text", 1, 1, "start", undefined, 4300),
    delta("text", 1, 1, "end", undefined, 5000),
    delta("reasoning", 1, 2, "start", undefined, 6000),
    delta("reasoning", 1, 2, "delta", "第二步", 6100),
    delta("reasoning", 1, 2, "end", undefined, 7000),
    delta("reasoning", 1, 3, "start"),
    delta("reasoning", 1, 3, "delta", "无时刻"),
    delta("reasoning", 1, 3, "end"),
  ]);
  assert.deepEqual(parts, [
    { durationMs: 3200, state: "done", text: "第一步", type: "reasoning" },
    { state: "done", text: "", type: "text" },
    { durationMs: 1000, state: "done", text: "第二步", type: "reasoning" },
    // 无 at 的块保持原形状，不携带 durationMs
    { state: "done", text: "无时刻", type: "reasoning" },
  ]);
});

test("流式中（只有 start/delta）：不产出 durationMs", () => {
  const parts = buildAssistantMessageParts([
    delta("reasoning", 1, 0, "start", undefined, 1000),
    delta("reasoning", 1, 0, "delta", "思考中", 1200),
  ]);
  assert.deepEqual(parts, [
    { state: "streaming", text: "思考中", type: "reasoning" },
  ]);
});
