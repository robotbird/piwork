// biome-ignore-all lint/suspicious/useAwait: Async test doubles implement RuntimeBackend.open.
import "../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { getPiModel } from "../../../../lib/ai/pi";
import { createWebSearchTool } from "../../../../lib/ai/web-tools";
import { LocalRpcBackend } from "../../../../lib/runtime/backends/local-rpc/backend";
import {
  RoutingRuntimeBackend,
  requiresSandbox,
  willRunSandbox,
} from "../../../../lib/runtime/backends/routing/backend";
import { HOST_TOOLS_BRIDGEABLE } from "../../../../lib/runtime/backends/sandbox-rpc/host-tools-extension";
import type { RuntimeSpec } from "../../../../lib/runtime/protocol";

test("matrix routes platform search without workspace to lightweight; LocalRpc still rejects; SandboxRpc bridges", async () => {
  const spec: RuntimeSpec = {
    appendSystemPrompt: [],
    chatId: crypto.randomUUID(),
    historyMessages: [],
    model: await getPiModel("deepseek/deepseek-flash"),
    systemPrompt: "test",
    tools: [
      createWebSearchTool(async () => ({ provider: "tavily", results: [] })),
    ],
    workspaceDir: null,
  };
  assert.equal(requiresSandbox(spec), false);
  let selected = "";
  const router = new RoutingRuntimeBackend({
    inProcess: {
      open: async () => {
        selected = "lightweight";
        throw new Error("marker");
      },
    },
    sandbox: {
      open: async () => {
        selected = "sandbox";
        throw new Error("marker");
      },
    },
  });
  await assert.rejects(router.open(spec), /marker/);
  assert.equal(selected, "lightweight");
  await assert.rejects(
    router.open({ ...spec, workspaceDir: "/workspace" }),
    /marker/
  );
  assert.equal(selected, "sandbox");
  await assert.rejects(new LocalRpcBackend().open(spec), /尚未接入 LocalRpc/);
  // 二期起 SandboxRpc 不再启动前拒绝 platform_web_search：按名桥接
  // （scope 铸发与全栈行为见 sandbox-rpc/host-tools-bridge.test.ts）。
  assert.equal(HOST_TOOLS_BRIDGEABLE.has("platform_web_search"), true);
});

test("willRunSandbox matches sandbox selection in matrix and all modes", () => {
  const matrix = {
    PIWORK_SANDBOX_PROVIDER: "docker",
    PIWORK_SANDBOX_ROUTING: undefined,
  };
  assert.equal(
    willRunSandbox({ workspaceDir: null }, matrix),
    false,
    "matrix + 纯对话 → in-process"
  );
  assert.equal(
    willRunSandbox({ workspaceDir: "/ws" }, matrix),
    true,
    "matrix + 执行类 → 沙箱"
  );
  const all = { ...matrix, PIWORK_SANDBOX_ROUTING: "all" };
  assert.equal(
    willRunSandbox({ workspaceDir: null }, all),
    true,
    "all 路由 → 全量沙箱"
  );
  assert.equal(
    willRunSandbox(
      { workspaceDir: "/ws" },
      { PIWORK_SANDBOX_PROVIDER: undefined, PIWORK_SANDBOX_ROUTING: undefined }
    ),
    false,
    "未装配沙箱 → in-process"
  );
});
