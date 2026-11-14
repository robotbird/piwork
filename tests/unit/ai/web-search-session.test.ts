// biome-ignore-all lint/suspicious/useAwait: Async test doubles implement the tool callback contract.
import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createPiworkAgentSession } from "../../../lib/ai/agent-session";
import { getPiModel, getTestFauxHandle } from "../../../lib/ai/pi";
import { createWebSearchTool } from "../../../lib/ai/web-tools";
import { MANAGED_AGENT_DIR } from "../../../lib/pi-packages/agent-dir";
import { PiEventNormalizer } from "../../../lib/runtime/backends/pi-event-normalizer";
import { WEB_SEARCH_TOOL } from "../../../lib/search/protocol";

test("official AgentSession calls search in lightweight session, with no builtin tools", async (t) => {
  let calls = 0;
  const handle = getTestFauxHandle();
  assert.ok(handle);
  handle.setResponses([
    fauxAssistantMessage(
      [fauxToolCall(WEB_SEARCH_TOOL, { query: "AI news", recency: "week" })],
      { stopReason: "toolUse" }
    ),
    (context) => {
      assert.ok(
        context.messages.some((message) => message.role === "toolResult")
      );
      return fauxAssistantMessage("新闻来源：https://news.example.org/a");
    },
  ]);
  const agent = await createPiworkAgentSession({
    appendSystemPrompt: [],
    cwd: MANAGED_AGENT_DIR,
    disableBuiltinTools: true,
    historyMessages: [],
    model: await getPiModel("deepseek/deepseek-flash"),
    systemPrompt: "Use the search tool for news and cite sources.",
    tools: [
      createWebSearchTool(async () => {
        calls += 1;
        return {
          provider: "tavily",
          results: [
            {
              publishedAt: null,
              snippet: "new release",
              title: "AI news",
              url: "https://news.example.org/a",
            },
          ],
        };
      }),
    ],
  });
  t.after(() => agent.dispose());
  // 扩展运行时默认开启,受管 agentDir 已装包(如 pi-web-access)的扩展工具
  // 会一并出现;本测试只关心平台工具在内建工具关闭时仍可用
  const activeTools = agent.session.getActiveToolNames();
  assert.ok(activeTools.includes(WEB_SEARCH_TOOL));
  assert.equal(activeTools.includes("bash"), false);
  assert.deepEqual(agent.extensionsResult.errors, []);
  const normalizer = new PiEventNormalizer();
  const events: ReturnType<PiEventNormalizer["feed"]> = [];
  const unsubscribe = agent.session.subscribe((event) => {
    events.push(...normalizer.feed(event));
  });
  t.after(unsubscribe);
  await agent.session.prompt("Search AI news");
  assert.equal(calls, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "tool.started" && event.toolName === WEB_SEARCH_TOOL
    )
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "source.created" &&
        event.url === "https://news.example.org/a"
    )
  );
});
