import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createPiworkAgentSession } from "../../../lib/ai/agent-session";
import { getPiModel } from "../../../lib/ai/pi";
import { MANAGED_AGENT_DIR } from "../../../lib/pi-packages/agent-dir";

function echoTool(): AgentTool {
  return {
    description: "Echo tool for tests",
    execute: async () => ({
      content: [{ text: "ok", type: "text" }],
      details: undefined,
    }),
    label: "Echo",
    name: "echo_tool",
    parameters: { type: "object" },
  };
}

// 扩展运行时默认开启:轻量会话不带工具白名单——平台自定义工具仍活跃、
// 内建工具仍被 noTools:"builtin" 挡住;受管 agentDir 已安装的包(如本机
// 的 pi-web-access)其扩展工具一并出现,故用包含式断言不依赖机器状态
test("lightweight session keeps platform tools active and builtin tools off", async () => {
  const agent = await createPiworkAgentSession({
    appendSystemPrompt: [],
    cwd: MANAGED_AGENT_DIR,
    disableBuiltinTools: true,
    historyMessages: [],
    model: await getPiModel("deepseek/deepseek-flash"),
    systemPrompt: "package extensions test",
    tools: [echoTool()],
  });
  try {
    const names = agent.session.getActiveToolNames();
    assert.ok(names.includes("echo_tool"));
    assert.equal(names.includes("bash"), false);
    assert.equal(names.includes("read"), false);
    assert.deepEqual(agent.extensionsResult.errors, []);
  } finally {
    agent.dispose();
  }
});
