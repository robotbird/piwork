import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { getPiModel } from "@/lib/ai/pi";
import { resolveDefaultCliPath } from "@/lib/runtime/backends/local-rpc/spawn";
import { SandboxRpcBackend } from "@/lib/runtime/backends/sandbox-rpc/backend";
import {
  createHostToolsHandler,
  InferenceProxyServer,
  RunTokenRegistry,
} from "@/lib/runtime/inference-proxy";
import type {
  RuntimeEvent,
  RuntimeSession,
  RuntimeSpec,
} from "@/lib/runtime/protocol";
import { TestSandboxProvider } from "../../../../support/sandbox/test-sandbox-provider";

/**
 * 沙箱宿主工具桥全栈专测（第一期 create_scheduled_task）：真实沙箱进程 +
 * UDS 桥 + 官方 pi --mode rpc 内加载生成扩展，经 run-token HTTP 调宿主真实
 * 路由器。验证：mint 请求携带 hostTools scope（发起人来自 spec 绑定）、
 * 工具结果同步回流模型、事件流 tool.completed/run.settled、缺配置时
 * unavailable 模式如实报错且 run 正常收尾。
 */

const FAUX_EXTENSION_PATH = fileURLToPath(
  new URL("../../../../support/faux-provider-extension.ts", import.meta.url)
);

const TEST_TIMEOUT_MS = 60_000;
const TEST_MODEL_ID = "deepseek/deepseek-flash";
const CHAT_ID = "00000000-0000-0000-0000-0000000000e1";
const USER_ID = "00000000-0000-4000-8000-0000000000e2";

const TOOL_INPUT = {
  prompt: "每天抓取 AI 资讯生成报告",
  schedule: { cron: "20 13 * * *", timezone: "Asia/Shanghai" },
  taskType: "每日 AI 资讯",
};

let cachedModel: RuntimeSpec["model"] | undefined;

async function makeSpec(overrides: {
  tools: RuntimeSpec["tools"];
  hostTools?: RuntimeSpec["hostTools"];
}): Promise<RuntimeSpec> {
  cachedModel ??= await getPiModel(TEST_MODEL_ID);
  return {
    appendSystemPrompt: [],
    chatId: CHAT_ID,
    historyMessages: [],
    hostTools: overrides.hostTools,
    model: cachedModel,
    systemPrompt: "piwork host-tools bridge test",
    tools: overrides.tools,
    workspaceDir: null,
  };
}

/** spec.tools 只按名映射，形状仅用于类型 */
function closureToolStub(name: string): RuntimeSpec["tools"][number] {
  return {
    description: `closure stub ${name}`,
    execute: async () => ({ content: [], details: {} }),
    label: name,
    name,
    parameters: { type: "object" },
  } as RuntimeSpec["tools"][number];
}

async function fauxScriptEnv(
  steps: FauxResponseStep[]
): Promise<{ env: Record<string, string> }> {
  const scriptDir = await mkdtemp(path.join(tmpdir(), "piwork-htb-script-"));
  const scriptPath = path.join(scriptDir, "faux-script.json");
  await writeFile(scriptPath, JSON.stringify(steps));
  return { env: { PIWORK_FAUX_SCRIPT: scriptPath } };
}

async function drainUntilSettled(
  session: RuntimeSession
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of session.events()) {
      events.push(event);
    }
  })();
  const waitForTerminal = () =>
    new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (
          events.at(-1)?.type === "run.settled" ||
          events.at(-1)?.type === "run.failed"
        ) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(
      () => reject(new Error("timeout waiting for terminal event")),
      45_000
    )
  );
  await Promise.race([waitForTerminal(), timeout]);
  await session.close("test-done").catch(() => undefined);
  await drained;
  return events;
}

test("全栈：沙箱内 create_scheduled_task 经桥真实落库语义（stub）并回流结果", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const provider = new TestSandboxProvider();
  const tokens = new RunTokenRegistry();
  // 模型上游：官方 fauxProvider 在宿主侧回放（沙箱 pi 经代理调用）
  const faux = fauxProvider({
    models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
    provider: "deepseek",
    tokensPerSecond: 0,
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("create_scheduled_task", TOOL_INPUT)]),
    fauxAssistantMessage([fauxText("任务已创建")]),
  ]);
  const received: Array<{ input: unknown; userId: string; salt: string }> = [];
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      tokens,
      tools: {
        // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
        create_scheduled_task: async ({ hostTools, input }) => {
          received.push({
            input,
            salt: hostTools.idempotencyKey,
            userId: hostTools.userId,
          });
          return {
            content: [
              {
                text: JSON.stringify({
                  id: "task-full-1",
                  schedule: (input as { schedule: unknown }).schedule,
                  title: (input as { taskType: string }).taskType,
                  url: "/scheduled-tasks",
                }),
                type: "text",
              },
            ],
          };
        },
      },
    }),
    resolver: () => ({
      model: faux.getModel("deepseek-flash") as RuntimeSpec["model"],
      provider: faux.provider,
    }),
    tokens,
  });
  const { url } = await server.listen();
  const minted: Array<{ hostTools?: unknown }> = [];
  try {
    const backend = new SandboxRpcBackend({
      inference: {
        // biome-ignore lint/suspicious/useAwait: mint 为同步替身，契约要求 Promise
        mintRunToken: async (request) => {
          minted.push(request);
          return tokens.mint(request).token;
        },
        proxyUrl: url,
        revokeRunTokens: (runId) => tokens.revokeRun(runId),
      },
      provider,
      remoteCliPath: resolveDefaultCliPath(),
    });
    const session = await backend.open(
      await makeSpec({
        hostTools: { idempotencyKey: "message-full-1", userId: USER_ID },
        tools: [closureToolStub("create_scheduled_task")],
      })
    );
    const settling = drainUntilSettled(session);
    await session.send({ text: "创建定时任务", type: "prompt" });
    const events = await settling;

    // scope 以 RunManager 绑定的发起人签发（此处模拟绑定后的 spec）
    assert.deepEqual(minted[0]?.hostTools, {
      idempotencyKey: "message-full-1",
      tools: ["create_scheduled_task"],
      userId: USER_ID,
    });
    // 宿主按 grant 身份收到工具输入
    assert.equal(received.length, 1);
    assert.equal(received[0].userId, USER_ID);
    assert.equal(received[0].salt, "message-full-1");
    assert.deepEqual(received[0].input, TOOL_INPUT);
    // 模型侧：工具成功完成 + run 正常收尾
    const completed = events.find(
      (event): event is Extract<RuntimeEvent, { type: "tool.completed" }> =>
        event.type === "tool.completed" &&
        event.toolName === "create_scheduled_task"
    );
    assert.ok(completed, "应有 create_scheduled_task 工具完成事件");
    assert.equal(completed.isError, false);
    assert.equal(events.at(-1)?.type, "run.settled");
  } finally {
    await server.close();
  }
});

test("全栈：无 inference 配置 → unavailable 模式如实报错，run 仍正常收尾", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const provider = new TestSandboxProvider();
  const { env } = await fauxScriptEnv([
    fauxAssistantMessage([fauxToolCall("create_scheduled_task", TOOL_INPUT)]),
    fauxAssistantMessage([fauxText("能力不可用，已如实转告")]),
  ]);
  const backend = new SandboxRpcBackend({
    env,
    extensions: [FAUX_EXTENSION_PATH],
    provider,
    remoteCliPath: resolveDefaultCliPath(),
  });
  const session = await backend.open(
    await makeSpec({
      hostTools: { idempotencyKey: "message-full-2", userId: USER_ID },
      tools: [closureToolStub("create_scheduled_task")],
    })
  );
  const settling = drainUntilSettled(session);
  await session.send({ text: "创建定时任务", type: "prompt" });
  const events = await settling;
  const completed = events.find(
    (event): event is Extract<RuntimeEvent, { type: "tool.completed" }> =>
      event.type === "tool.completed" &&
      event.toolName === "create_scheduled_task"
  );
  assert.ok(completed, "unavailable 模式工具仍被调用并完成（错误结果）");
  assert.equal(completed.isError, true);
  assert.equal(events.at(-1)?.type, "run.settled", "聊天不整聊失败");
});

test("全栈：hostTools 半绑定（key 无 userId）为装配错误，fail-closed", async () => {
  const backend = new SandboxRpcBackend({
    provider: new TestSandboxProvider(),
    remoteCliPath: resolveDefaultCliPath(),
  });
  await assert.rejects(
    backend.open(
      await makeSpec({
        hostTools: { idempotencyKey: "message-full-3" },
        tools: [closureToolStub("create_scheduled_task")],
      })
    ),
    /runtime:sandbox:host-tools:unbound-user/
  );
});

test("二期回归：platform_web_search 不再硬报错，按名桥接并进 scope", async () => {
  const tokens = new RunTokenRegistry();
  const minted: Array<{ hostTools?: unknown }> = [];
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      tokens,
      tools: { platform_web_search: async () => ({ content: [] }) },
    }),
    resolver: () => null,
    tokens,
  });
  const { url } = await server.listen();
  try {
    const backend = new SandboxRpcBackend({
      inference: {
        // biome-ignore lint/suspicious/useAwait: mint 为同步替身，契约要求 Promise
        mintRunToken: async (request) => {
          minted.push(request);
          return tokens.mint(request).token;
        },
        proxyUrl: url,
        revokeRunTokens: (runId) => tokens.revokeRun(runId),
      },
      provider: new TestSandboxProvider(),
      remoteCliPath: resolveDefaultCliPath(),
    });
    const session = await backend.open(
      await makeSpec({
        hostTools: { idempotencyKey: "message-ws-1", userId: USER_ID },
        tools: [closureToolStub("platform_web_search")],
      })
    );
    await session.close("done");
    assert.deepEqual(minted[0]?.hostTools, {
      idempotencyKey: "message-ws-1",
      tools: ["platform_web_search"],
      userId: USER_ID,
    });
  } finally {
    await server.close();
  }
});

test("全栈：沙箱内 platform_web_search 经桥返回结果并产出 source 卡片", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const provider = new TestSandboxProvider();
  const tokens = new RunTokenRegistry();
  const faux = fauxProvider({
    models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
    provider: "deepseek",
    tokensPerSecond: 0,
  });
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("platform_web_search", { limit: 3, query: "AI 资讯" }),
    ]),
    fauxAssistantMessage([fauxText("已整理资讯")]),
  ]);
  const SEARCH_TEXT = `## Results for: "AI 资讯"\n\n**Providers:** test\n\n### OpenAI 发布 GPT-5\nhttps://openai.com/blog/gpt5\n\n### Anthropic 更新\nhttps://www.anthropic.com/news/claude\n`;
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      tokens,
      tools: {
        platform_web_search: async () => ({
          content: [{ text: SEARCH_TEXT, type: "text" }],
          details: {
            sources: [
              {
                publishedAt: null,
                snippet: "",
                title: "OpenAI 发布 GPT-5",
                url: "https://openai.com/blog/gpt5",
              },
              {
                publishedAt: null,
                snippet: "",
                title: "Anthropic 更新",
                url: "https://www.anthropic.com/news/claude",
              },
            ],
          },
        }),
      },
    }),
    resolver: () => ({
      model: faux.getModel("deepseek-flash") as RuntimeSpec["model"],
      provider: faux.provider,
    }),
    tokens,
  });
  const { url } = await server.listen();
  try {
    const backend = new SandboxRpcBackend({
      inference: {
        mintRunToken: async (request) => tokens.mint(request).token,
        proxyUrl: url,
        revokeRunTokens: (runId) => tokens.revokeRun(runId),
      },
      provider,
      remoteCliPath: resolveDefaultCliPath(),
    });
    const session = await backend.open(
      await makeSpec({
        hostTools: { idempotencyKey: "message-ws-2", userId: USER_ID },
        tools: [closureToolStub("platform_web_search")],
      })
    );
    const settling = drainUntilSettled(session);
    await session.send({ text: "搜索 AI 资讯", type: "prompt" });
    const events = await settling;
    const completed = events.find(
      (event): event is Extract<RuntimeEvent, { type: "tool.completed" }> =>
        event.type === "tool.completed" &&
        event.toolName === "platform_web_search"
    );
    assert.ok(completed, "应有 platform_web_search 工具完成事件");
    assert.equal(completed.isError, false);
    // 来源卡片链路：normalizer 按 details.sources 出 source.created
    const sources = events.filter(
      (event): event is Extract<RuntimeEvent, { type: "source.created" }> =>
        event.type === "source.created"
    );
    assert.equal(sources.length, 2, "应产出两张来源卡片");
    assert.match(sources[0]?.url ?? "", /^https:\/\//);
    assert.equal(events.at(-1)?.type, "run.settled");
  } finally {
    await server.close();
  }
});
