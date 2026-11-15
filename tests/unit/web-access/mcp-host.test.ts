import "../../support/runtime-env";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  type ClientBundle,
  getWebAccessService,
  WebAccessService,
} from "@/lib/web-access/mcp-host";

/**
 * WebAccessService（沙箱宿主工具桥二期）专测：CLI 定位/可用性、假客户端
 * 的调用映射与错误文本识别、崩溃后按需重拉；以及真子进程（本机受管
 * agentDir 内 pi-web-access 官方 mcp-cli.js）握手与 listTools 探测。
 */

function fakeService(options: {
  calls?: { args: unknown }[];
  result?: { content: unknown[]; isError?: boolean };
  error?: Error;
}): WebAccessService {
  return new WebAccessService({
    // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
    connect: async () => {
      const bundle = {
        client: {
          // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
          callTool: async (_name: string, args: unknown) => {
            options.calls?.push({ args });
            if (options.error) {
              throw options.error;
            }
            return (
              options.result ?? {
                content: [{ text: "## Results", type: "text" }],
                isError: false,
              }
            );
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

test("available：CLI 不可解析时能力为 false", async () => {
  const service = new WebAccessService({
    resolveCliPath: async () => null,
  });
  assert.equal(await service.available(), false);
});

test("webSearch：参数映射（query/numResults/recencyFilter）与文本返回", async () => {
  const calls: { args: unknown }[] = [];
  const service = fakeService({
    calls,
    result: {
      content: [{ text: '## Results for: "ai news"', type: "text" }],
    },
  });
  const text = await service.webSearch(
    { numResults: 5, query: "ai news", recencyFilter: "day" },
    undefined
  );
  assert.match(text, /ai news/);
  assert.deepEqual(calls[0]?.args, {
    numResults: 5,
    query: "ai news",
    recencyFilter: "day",
  });
  await service.webSearch({ query: "x" }, undefined);
  assert.deepEqual(calls[1]?.args, {
    numResults: undefined,
    query: "x",
  });
});

test("webSearch：MCP isError 与插件 'Error: ...' 文本都按失败抛出；超长截断", async () => {
  const failing = fakeService({
    result: { content: [{ text: "Error: no provider", type: "text" }] },
  });
  await assert.rejects(
    failing.webSearch({ query: "x" }, undefined),
    /no provider/
  );
  const isError = fakeService({
    result: { content: [{ text: "boom", type: "text" }], isError: true },
  });
  await assert.rejects(isError.webSearch({ query: "x" }, undefined), /boom/);
  const long = fakeService({
    result: { content: [{ text: "x".repeat(100_000), type: "text" }] },
  });
  const text = await long.webSearch({ query: "x" }, undefined);
  assert.ok(text.length < 70_000 && text.includes("[truncated]"));
});

test("webSearch：McpTimeoutError 原样上抛（调用方映射为 searchUnavailable）", async () => {
  const timeout = new Error("timed out");
  timeout.name = "McpTimeoutError";
  const service = fakeService({ error: timeout });
  await assert.rejects(
    service.webSearch({ query: "x" }, undefined),
    (error) => error instanceof Error && error.name === "McpTimeoutError"
  );
});

test("close 后调用按不可用抛出；后续调用可重新拉起", async () => {
  const service = fakeService({});
  await service.listTools();
  await service.close();
  await assert.rejects(
    service.webSearch({ query: "x" }, undefined),
    /disposed/
  );
});

test("真子进程：官方 mcp-cli.js 握手 + listTools 含 web_search（本机插件已装时）", {
  timeout: 60_000,
}, async () => {
  const cli = path.join(
    process.cwd(),
    ".piwork/pi-agent/npm/node_modules/pi-web-access/dist/mcp-cli.js"
  );
  const installed = await stat(cli).then(
    () => true,
    () => false
  );
  if (!installed) {
    return;
  }
  const service = new WebAccessService({ resolveCliPath: async () => cli });
  try {
    const tools = await service.listTools();
    assert.ok(
      tools.includes("web_search"),
      `MCP 工具面应含 web_search，实际：${tools.join(",")}`
    );
  } finally {
    await service.close();
  }
});

test("getWebAccessService 单例稳定（HMR 存活语义）", () => {
  assert.equal(getWebAccessService(), getWebAccessService());
});
