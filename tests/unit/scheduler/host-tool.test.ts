import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { LocalizedError } from "@/lib/i18n/messages";
import {
  type HostToolCallContext,
  HostToolsError,
} from "@/lib/runtime/inference-proxy/host-tools";
import { createScheduledTaskHostTool } from "@/lib/scheduler/host-tool";

/**
 * create_scheduled_task 桥接域适配器专测：身份只取 grant（请求体多余
 * 字段被 strict schema 拒绝）、宿主侧全量校验、取消检查点先于持久写、
 * LocalizedError 映射为可外发文案。
 */

const USER_A = "00000000-0000-4000-8000-0000000000aa";
const USER_B = "00000000-0000-4000-8000-0000000000bb";

const VALID_INPUT = {
  prompt: "抓取 AI 资讯生成报告",
  schedule: { cron: "20 13 * * *", timezone: "Asia/Shanghai" },
  taskType: "每日 AI 资讯",
};

type RecordedCall = { input: unknown; salt: string; userId: string };

function contextFor(
  hostTools: { idempotencyKey: string; userId: string },
  input: unknown,
  signal?: AbortSignal
): HostToolCallContext {
  return {
    grant: {
      chatId: "00000000-0000-0000-0000-0000000000cc",
      grants: [{ model: "m", provider: "p" }],
      hostTools: { tools: ["create_scheduled_task"], ...hostTools },
      runId: "run-1",
    },
    hostTools: { tools: ["create_scheduled_task"], ...hostTools },
    input,
    signal: signal ?? new AbortController().signal,
  };
}

test("适配器：以 grant 身份与幂等盐调用服务，结果为 JSON 文本", async () => {
  const calls: RecordedCall[] = [];
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const tool = createScheduledTaskHostTool(async (userId, salt, input) => {
    calls.push({ input, salt, userId });
    return {
      id: "task-1",
      nextRunAt: new Date("2026-11-16T05:20:00.000Z"),
      schedule: input.schedule,
      title: input.taskType,
      url: "/scheduled-tasks",
    };
  });
  const result = await tool(
    contextFor({ idempotencyKey: "message-9", userId: USER_A }, VALID_INPUT)
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, USER_A, "归属=token grant 的发起人");
  assert.equal(calls[0].salt, "message-9", "幂等盐=消息 id");
  const { content } = result;
  assert.ok(content[0]);
  assert.deepEqual(JSON.parse(content[0].text), {
    id: "task-1",
    nextRunAt: "2026-11-16T05:20:00.000Z",
    schedule: VALID_INPUT.schedule,
    title: "每日 AI 资讯",
    url: "/scheduled-tasks",
  });
});

test("适配器：身份不可从请求体注入——多余字段 strict 拒绝为 invalid_input", async () => {
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const tool = createScheduledTaskHostTool(async () => {
    throw new Error("should not be called");
  });
  await assert.rejects(
    tool(
      contextFor(
        { idempotencyKey: "m1", userId: USER_A },
        { ...VALID_INPUT, userId: USER_B }
      )
    ),
    (error: unknown) =>
      error instanceof HostToolsError &&
      error.code === "invalid_input" &&
      /输入无效/.test(error.message)
  );
});

test("适配器：schema 校验宿主权威——坏 cron/超长 taskType 拒绝", async () => {
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const tool = createScheduledTaskHostTool(async () => {
    throw new Error("should not be called");
  });
  await assert.rejects(
    tool(
      contextFor(
        { idempotencyKey: "m1", userId: USER_A },
        {
          ...VALID_INPUT,
          schedule: { cron: "bad cron", timezone: "Asia/Shanghai" },
        }
      )
    ),
    (error: unknown) => error instanceof HostToolsError
  );
  await assert.rejects(
    tool(
      contextFor(
        { idempotencyKey: "m1", userId: USER_A },
        { ...VALID_INPUT, taskType: "x".repeat(65) }
      )
    ),
    (error: unknown) => error instanceof HostToolsError
  );
});

test("适配器：取消检查点先于持久写（aborted 不触达服务）", async () => {
  const calls: RecordedCall[] = [];
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const tool = createScheduledTaskHostTool(async (userId, salt, input) => {
    calls.push({ input, salt, userId });
    throw new Error("unreachable");
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    tool(
      contextFor(
        { idempotencyKey: "m1", userId: USER_A },
        VALID_INPUT,
        aborted.signal
      )
    ),
    (error: unknown) =>
      error instanceof HostToolsError && error.code === "aborted"
  );
  assert.equal(calls.length, 0);
});

test("适配器：LocalizedError 映射为可外发文案，未知错误原样上抛（传输层脱敏）", async () => {
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const failing = createScheduledTaskHostTool(async () => {
    throw new LocalizedError("runtimeMessages.taskCreateFailed");
  });
  await assert.rejects(
    failing(contextFor({ idempotencyKey: "m1", userId: USER_A }, VALID_INPUT)),
    (error: unknown) =>
      error instanceof HostToolsError && error.code === "task_failed"
  );

  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const unexpected = createScheduledTaskHostTool(async () => {
    throw new Error("db exploded");
  });
  await assert.rejects(
    unexpected(
      contextFor({ idempotencyKey: "m1", userId: USER_A }, VALID_INPUT)
    ),
    (error: unknown) =>
      error instanceof Error && error.message === "db exploded"
  );
});

test("适配器：timezone 缺省由宿主 schema 补默认值后落库", async () => {
  const seen: RecordedCall[] = [];
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const tool = createScheduledTaskHostTool(async (userId, salt, input) => {
    seen.push({ input, salt, userId });
    return {
      id: "t",
      nextRunAt: new Date(0),
      schedule: input.schedule,
      title: input.taskType,
      url: "/scheduled-tasks",
    };
  });
  await tool(
    contextFor(
      { idempotencyKey: "m1", userId: USER_A },
      {
        prompt: VALID_INPUT.prompt,
        schedule: { cron: "0 9 * * 1-5" },
        taskType: VALID_INPUT.taskType,
      }
    )
  );
  assert.deepEqual(seen[0]?.input, {
    prompt: VALID_INPUT.prompt,
    schedule: { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    taskType: VALID_INPUT.taskType,
  });
});
