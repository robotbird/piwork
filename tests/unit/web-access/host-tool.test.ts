import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { HostToolsError } from "@/lib/runtime/inference-proxy/host-tools";
import { extractSearchSources } from "@/lib/search/protocol";
import {
  createWebSearchExecutor,
  createWebSearchHostTool,
} from "@/lib/web-access/host-tool";
import type { ClientBundle } from "@/lib/web-access/mcp-host";
import { WebAccessService } from "@/lib/web-access/mcp-host";

/**
 * platform_web_search 桥接域测试（二期）：参数严格校验、授权（身份仅取
 * grant/调用方注入，聊天归属+角色检查语义）、共享准入与每 run 预算、
 * 取消检查点、失败映射为可外发文案；来源卡片仅从可识别结果区域提取，
 * 解析失败省略。
 */

const CHAT = "00000000-0000-0000-0000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000aa";
const MODEL = { id: "deepseek-flash", provider: "deepseek" };

const RESULT_TEXT = `## Results for: "ai news"

**Providers:** test

### OpenAI releases GPT-5
https://openai.com/blog/gpt5

OpenAI announced...

### Anthropic Claude update
https://www.anthropic.com/news/claude

Anthropic announced...
`;

function serviceReturning(text: string, calls?: unknown[][]): WebAccessService {
  return new WebAccessService({
    // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
    connect: async () => {
      const bundle = {
        client: {
          // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
          callTool: async (_name: string, args: unknown) => {
            calls?.push([args]);
            return { content: [{ text, type: "text" }], isError: false };
          },
          close: async () => undefined,
          listTools: async () => [{ name: "web_search" }],
        },
        transport: {},
      } as unknown as ClientBundle;
      return bundle;
    },
    resolveCliPath: async () => "/fake/cli.js",
  });
}

test("extractSearchSources：仅从 '### 标题\\nURL' 区域提取，去重、上限 8、非法 URL 剔除", () => {
  const many = Array.from(
    { length: 12 },
    (_, i) => `### 标题${i}\nhttps://example.com/page-${i}\n`
  ).join("\n");
  assert.equal(extractSearchSources(many).length, 8);
  assert.deepEqual(extractSearchSources("no regions here").length, 0);
  assert.deepEqual(
    extractSearchSources("### 标题\nhttp://localhost/x\n").length,
    0,
    "内网/localhost URL 剔除"
  );
  const sources = extractSearchSources(RESULT_TEXT);
  assert.deepEqual(
    sources.map((item) => item.title),
    ["OpenAI releases GPT-5", "Anthropic Claude update"]
  );
  assert.ok(sources[0]?.url.startsWith("https://"));
});

function makeExecutor(options: {
  authorize?: (input: { userId: string }) => Promise<void>;
  service?: WebAccessService;
}) {
  return createWebSearchExecutor(
    options.service ?? serviceReturning(RESULT_TEXT),
    {
      authorize:
        options.authorize ??
        // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
        (async () => {
          throw new HostToolsError("task_failed", "unauthorized");
        }),
    }
  );
}

test("执行核心：授权通过后返回内容与来源；查询参数映射到 MCP", async () => {
  const calls: unknown[][] = [];
  const execute = makeExecutor({
    authorize: async () => undefined,
    service: serviceReturning(RESULT_TEXT, calls),
  });
  const result = await execute({
    chatId: CHAT,
    input: { limit: 3, query: "ai news", recency: "week" },
    model: MODEL,
    runId: "run-1",
    signal: new AbortController().signal,
    userId: USER,
  });
  assert.match(result.content[0]?.text ?? "", /Untrusted public web search/);
  assert.equal(result.sources.length, 2);
  assert.deepEqual(calls[0]?.[0], {
    numResults: 3,
    query: "ai news",
    recencyFilter: "week",
  });
});

test("执行核心：strict schema 拒绝多余字段（身份不可从请求体注入）", async () => {
  const execute = makeExecutor({
    authorize: async () => undefined,
  });
  await assert.rejects(
    execute({
      chatId: CHAT,
      input: { query: "x", userId: "evil" },
      model: MODEL,
      runId: "run-1",
      signal: new AbortController().signal,
      userId: USER,
    }),
    (error: unknown) =>
      error instanceof HostToolsError && error.code === "invalid_input"
  );
});

test("执行核心：授权失败与取消检查点", async () => {
  const execute = makeExecutor({
    // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
    authorize: async () => {
      throw new HostToolsError("task_failed", "授权失败");
    },
  });
  await assert.rejects(
    execute({
      chatId: CHAT,
      input: { query: "x" },
      model: MODEL,
      runId: "run-1",
      signal: new AbortController().signal,
      userId: "someone-else",
    }),
    /授权失败/
  );
  const aborted = new AbortController();
  aborted.abort();
  const ok = makeExecutor({ authorize: async () => undefined });
  await assert.rejects(
    ok({
      chatId: CHAT,
      input: { query: "x" },
      model: MODEL,
      runId: "run-abort",
      signal: aborted.signal,
      userId: USER,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
});

test("执行核心：每 run 预算（同 runId 超过 20 次拒绝）", async () => {
  const execute = makeExecutor({ authorize: async () => undefined });
  for (let i = 0; i < 20; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: 顺序执行即语义本身（串行消耗预算）
    await execute({
      chatId: CHAT,
      input: { query: `q${i}` },
      model: MODEL,
      runId: "run-budget",
      signal: new AbortController().signal,
      userId: `budget-user-${i % 2}`,
    });
  }
  await assert.rejects(
    execute({
      chatId: CHAT,
      input: { query: "over" },
      model: MODEL,
      runId: "run-budget",
      signal: new AbortController().signal,
      userId: "budget-user-0",
    }),
    (error: unknown) => error instanceof HostToolsError
  );
});

test("执行核心：MCP 不可用/超时映射为可外发的 searchUnavailable 文案", async () => {
  const unavailable = new WebAccessService({
    resolveCliPath: async () => null,
  });
  const execute = createWebSearchExecutor(unavailable, {
    authorize: async () => undefined,
  });
  await assert.rejects(
    execute({
      chatId: CHAT,
      input: { query: "x" },
      model: MODEL,
      runId: "run-1",
      signal: new AbortController().signal,
      userId: USER,
    }),
    (error: unknown) =>
      error instanceof HostToolsError && error.code === "task_failed"
  );
});

test("HostTool 适配器：身份取 grant（hostTools.userId），模型取 grants[0]；来源进 details.sources", async () => {
  const calls: { userId: string; model: unknown }[] = [];
  const execute = createWebSearchExecutor(serviceReturning(RESULT_TEXT), {
    // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
    authorize: async (input) => {
      calls.push({ model: input.model, userId: input.userId });
    },
  });
  const tool = createWebSearchHostTool(execute);
  const result = await tool({
    grant: {
      chatId: CHAT,
      grants: [{ model: MODEL.id, provider: MODEL.provider }],
      hostTools: {
        idempotencyKey: "message-1",
        tools: ["platform_web_search"],
        userId: USER,
      },
      runId: "run-bridge-1",
    },
    hostTools: {
      idempotencyKey: "message-1",
      tools: ["platform_web_search"],
      userId: USER,
    },
    input: { query: "ai news" },
    signal: new AbortController().signal,
  });
  assert.deepEqual(calls[0], { model: MODEL, userId: USER });
  assert.equal(result.details?.sources !== undefined, true);
  assert.equal(
    (result.details?.sources as unknown[]).length,
    2,
    "来源卡片经 details.sources 供 normalizer 出卡"
  );
});
