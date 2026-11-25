import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { createImageGenTool } from "@/lib/ai/image-tools";
import {
  HOST_TOOLS_BRIDGEABLE,
  hostToolsExtensionSource,
} from "@/lib/runtime/backends/sandbox-rpc/host-tools-extension";
import {
  createHostToolsHandler,
  type HostTool,
  HostToolsError,
  InferenceProxyServer,
  RunTokenRegistry,
} from "@/lib/runtime/inference-proxy";

/**
 * Host Tools Bridge 沙箱侧扩展专测：生成源码零依赖可加载、按需注册工具、
 * unavailable 模式如实报错、loopback 全链路（真 InferenceProxyServer +
 * handler → 结果/错误映射回模型）。
 */

const USER_ID = "00000000-0000-4000-8000-0000000000ee";

type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ) => Promise<{ content: unknown[]; details: Record<string, unknown> }>;
  name: string;
  parameters: Record<string, unknown>;
};

async function loadExtension(
  source: string
): Promise<{ registered: RegisteredTool[] }> {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = await import(moduleUrl);
  const registered: RegisteredTool[] = [];
  module.default({
    registerTool: (tool: RegisteredTool) => {
      registered.push(tool);
    },
  });
  return { registered };
}

test("生成器：源码可加载、仅注册请求的工具、参数为 plain JSON Schema", async () => {
  const { registered } = await loadExtension(
    hostToolsExtensionSource({
      tools: ["create_scheduled_task", "platform_web_search"],
    })
  );
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, "create_scheduled_task");
  assert.equal(registered[1].name, "platform_web_search");
  const schema = registered[0].parameters as {
    properties: Record<string, unknown>;
    required: string[];
    type: string;
  };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["prompt", "schedule", "taskType"]);
  assert.ok(schema.properties.schedule, "schedule 参数存在");
  const searchSchema = registered[1].parameters as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(searchSchema.required, ["query"]);
  assert.ok(searchSchema.properties.recency, "recency 参数存在");
  // 桥接面 = 第一/二期清单
  assert.deepEqual(
    [...HOST_TOOLS_BRIDGEABLE],
    ["create_scheduled_task", "platform_web_search"]
  );
});

test("生成器：按工具注入外层超时（search 60s > 宿主内层 30s）", () => {
  const source = hostToolsExtensionSource({
    tools: ["platform_web_search"],
  });
  assert.ok(source.includes('"platform_web_search":60000'));
  assert.ok(source.includes('"create_scheduled_task":30000'));
});

test("生成器：unavailable 模式不做任何 HTTP，如实抛出原因", async () => {
  const reason =
    "当前部署未启用推理代理（PIWORK_INFERENCE_URL），无法创建定时任务";
  const { registered } = await loadExtension(
    hostToolsExtensionSource({
      tools: ["create_scheduled_task"],
      unavailableReason: reason,
    })
  );
  await assert.rejects(
    registered[0].execute("call-1", { taskType: "t" }, undefined),
    (error: unknown) => error instanceof Error && error.message === reason
  );
});

test("生成器：缺 env（未配置桥）时报未配置错误", async () => {
  const previousUrl = process.env.PIWORK_HOST_TOOLS_URL;
  const previousToken = process.env.PIWORK_RUN_TOKEN;
  delete process.env.PIWORK_HOST_TOOLS_URL;
  delete process.env.PIWORK_RUN_TOKEN;
  try {
    const { registered } = await loadExtension(
      hostToolsExtensionSource({ tools: ["create_scheduled_task"] })
    );
    await assert.rejects(
      registered[0].execute("call-1", { taskType: "t" }, undefined),
      /not configured/
    );
  } finally {
    if (previousUrl !== undefined) {
      process.env.PIWORK_HOST_TOOLS_URL = previousUrl;
    }
    if (previousToken !== undefined) {
      process.env.PIWORK_RUN_TOKEN = previousToken;
    }
  }
});

type Bridge = {
  close: () => Promise<void>;
  token: string;
  url: string;
};

async function bootBridge(
  impl: HostTool,
  name = "create_scheduled_task"
): Promise<Bridge> {
  const tokens = new RunTokenRegistry();
  const { token } = tokens.mint({
    chatId: "00000000-0000-0000-0000-0000000000cc",
    grants: [{ model: "m", provider: "p" }],
    hostTools: {
      idempotencyKey: "message-1",
      tools: [name],
      userId: USER_ID,
    },
    runId: "run-ext-1",
  });
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      tokens,
      tools: { [name]: impl },
    }),
    resolver: () => null,
    tokens,
  });
  const { url } = await server.listen();
  return { close: () => server.close(), token, url };
}

async function withBridgeEnv<T>(
  bridge: Bridge,
  run: () => Promise<T>
): Promise<T> {
  const previousUrl = process.env.PIWORK_HOST_TOOLS_URL;
  const previousToken = process.env.PIWORK_RUN_TOKEN;
  process.env.PIWORK_HOST_TOOLS_URL = bridge.url;
  process.env.PIWORK_RUN_TOKEN = bridge.token;
  try {
    return await run();
  } finally {
    if (previousUrl === undefined) {
      delete process.env.PIWORK_HOST_TOOLS_URL;
    } else {
      process.env.PIWORK_HOST_TOOLS_URL = previousUrl;
    }
    if (previousToken === undefined) {
      delete process.env.PIWORK_RUN_TOKEN;
    } else {
      process.env.PIWORK_RUN_TOKEN = previousToken;
    }
  }
}

test("loopback：宿主结果同步回流为工具内容", async () => {
  const bridge = await bootBridge(async () => ({
    content: [
      { text: JSON.stringify({ id: "task-9", title: "报告" }), type: "text" },
    ],
  }));
  try {
    const { registered } = await loadExtension(
      hostToolsExtensionSource({ tools: ["create_scheduled_task"] })
    );
    await withBridgeEnv(bridge, async () => {
      const result = await registered[0].execute(
        "call-1",
        {
          prompt: "p",
          schedule: { cron: "0 9 * * *" },
          taskType: "t",
        },
        undefined
      );
      assert.deepEqual(
        JSON.parse((result.content[0] as { text: string }).text),
        { id: "task-9", title: "报告" }
      );
    });
  } finally {
    await bridge.close();
  }
});

test("the selected image tool crosses the bridge with its pinned schema", async () => {
  const { description, label, name, parameters } = createImageGenTool({
    allowReferences: false,
    imageModelId: "wan2.7-image",
  });
  const { registered } = await loadExtension(
    hostToolsExtensionSource({
      imageTool: { description, label, name, parameters },
      tools: [],
    })
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "image_gen");
  const properties = registered[0].parameters.properties as object;
  assert.equal("model" in properties, false);
  assert.equal("references" in properties, false);
  const bridge = await bootBridge(
    ({ input }) =>
      Promise.resolve({
        content: [{ text: JSON.stringify(input), type: "text" }],
      }),
    name
  );
  try {
    const input = { prompt: "A mountain lake" };
    const result = await withBridgeEnv(bridge, () =>
      registered[0].execute("image-call", input)
    );
    assert.deepEqual(result.content, [
      { text: JSON.stringify(input), type: "text" },
    ]);
  } finally {
    await bridge.close();
  }
});

test("loopback：工具层失败（ok:false）文案原文转交模型", async () => {
  // biome-ignore lint/suspicious/useAwait: 接口契约要求 Promise，同步测试替身无异步工作
  const bridge = await bootBridge(async () => {
    throw new HostToolsError("task_failed", "任务创建失败，请稍后重试");
  });
  try {
    const { registered } = await loadExtension(
      hostToolsExtensionSource({ tools: ["create_scheduled_task"] })
    );
    await withBridgeEnv(bridge, async () => {
      await assert.rejects(
        registered[0].execute(
          "call-1",
          { prompt: "p", schedule: { cron: "0 9 * * *" }, taskType: "t" },
          undefined
        ),
        (error: unknown) =>
          error instanceof Error && error.message === "任务创建失败，请稍后重试"
      );
    });
  } finally {
    await bridge.close();
  }
});

test("loopback：传输层 403 → 服务端 allowlist 文案转交模型", async () => {
  // token 无 hostTools scope
  const tokens = new RunTokenRegistry();
  const { token } = tokens.mint({
    chatId: "00000000-0000-0000-0000-0000000000cc",
    grants: [{ model: "m", provider: "p" }],
    runId: "run-ext-2",
  });
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      tokens,
      tools: { create_scheduled_task: async () => ({ content: [] }) },
    }),
    resolver: () => null,
    tokens,
  });
  const { url } = await server.listen();
  try {
    const { registered } = await loadExtension(
      hostToolsExtensionSource({ tools: ["create_scheduled_task"] })
    );
    process.env.PIWORK_HOST_TOOLS_URL = url;
    process.env.PIWORK_RUN_TOKEN = token;
    await assert.rejects(
      registered[0].execute("call-1", {}, undefined),
      (error: unknown) =>
        error instanceof Error && /not granted to this run/.test(error.message)
    );
  } finally {
    delete process.env.PIWORK_HOST_TOOLS_URL;
    delete process.env.PIWORK_RUN_TOKEN;
    await server.close();
  }
});
