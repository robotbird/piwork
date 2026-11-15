import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEventToUIMessageChunks } from "../../../app/(chat)/api/chat/stream-mapping";
import { heuristicExecution } from "../../../lib/ai/execution-heuristic";
import { PiEventNormalizer } from "../../../lib/runtime/backends/pi-event-normalizer";
import { selectChatRuntime } from "../../../lib/runtime/backends/routing/chat-routing";
import { isPersistedRuntimeEvent } from "../../../lib/runtime/run/event-store";
import { buildAssistantMessageParts } from "../../../lib/runtime/run/message-builder";
import { WEB_SEARCH_TOOL } from "../../../lib/search/protocol";

test("opted-in pure public search is lightweight; disabled and mixed execution stay unchanged", () => {
  for (const message of [
    "请使用网页搜索工具，查找最近一周的人工智能新闻，附来源链接",
    "请联网查询 AI 新闻",
    "Search the web for AI news",
    "查询最新天气",
    "请调用 platform_web_search 查找资料",
  ]) {
    const input = { attachmentCount: 0, history: [], message };
    const decision = heuristicExecution({ ...input, platformWebSearch: true });
    assert.equal(decision.requiresExecution, false, message);
    assert.equal(
      selectChatRuntime({
        approvalContinuation: false,
        classificationReason: decision.reason,
        durableEnabled: true,
        needsCompatibility: true,
        requiresExecution: decision.requiresExecution,
        skillCommand: false,
      }).lane,
      "default"
    );
  }
  for (const message of [
    "联网搜索后执行 Python 脚本",
    "用浏览器搜索新闻",
    "搜索资料并生成 PDF 文件",
    "调用 pi-web-access 插件搜索",
    "调用 MCP 搜索",
    "下载网页到工作区",
    "每周搜索新闻",
    "查询当前服务器时间并写入time.txt",
    "联网搜索资料并保存到notes.md",
    "Search the web and write the result to news.txt",
  ]) {
    assert.equal(
      heuristicExecution({
        attachmentCount: 0,
        history: [],
        message,
        platformWebSearch: true,
      }).requiresExecution,
      true,
      message
    );
  }
  assert.equal(
    heuristicExecution({
      attachmentCount: 0,
      history: [],
      message: "联网搜索新闻",
    }).requiresExecution,
    true
  );
  assert.equal(
    heuristicExecution({
      attachmentCount: 1,
      history: [],
      message: "联网搜索新闻",
      platformWebSearch: true,
    }).requiresExecution,
    true
  );
  assert.equal(
    heuristicExecution({
      attachmentCount: 0,
      history: [{ role: "user", text: "运行 Python 分析数据" }],
      message: "联网搜索新闻",
      platformWebSearch: true,
    }).requiresExecution,
    true
  );
});

test("successful search metadata becomes replayable RuntimeEvent and identical wire/DB sources", () => {
  const normalizer = new PiEventNormalizer();
  const events = normalizer.feed({
    isError: false,
    result: {
      content: [{ text: "not persisted", type: "text" }],
      details: {
        sources: [
          {
            publishedAt: "2026-11-01",
            snippet: "bounded snippet",
            title: "News",
            url: "https://news.example.org/a",
          },
          { title: "Bad", url: "javascript:alert(1)" },
        ],
      },
    },
    toolCallId: "search1",
    toolName: WEB_SEARCH_TOOL,
    type: "tool_execution_end",
  });
  assert.equal(events.length, 2);
  const [, source] = events;
  assert.equal(source.type, "source.created");
  assert.equal(isPersistedRuntimeEvent(source), true);
  // Rich source card fields survive the event → wire chunk → DB part pipeline
  const expected = {
    data: {
      publishedAt: "2026-11-01",
      snippet: "bounded snippet",
      sourceId: "search1-source-0",
      title: "News",
      url: "https://news.example.org/a",
    },
    type: "data-web-source",
  };
  assert.deepEqual(runtimeEventToUIMessageChunks(source), [expected]);
  assert.deepEqual(buildAssistantMessageParts([source, source]), [expected]);
  assert.ok(!JSON.stringify(source).includes("not persisted"));
});

test("empty snippet fields are omitted from the source card, not stored as blanks", () => {
  const normalizer = new PiEventNormalizer();
  const events = normalizer.feed({
    isError: false,
    result: {
      content: [],
      details: {
        sources: [{ title: "News", url: "https://news.example.org/a" }],
      },
    },
    toolCallId: "search1",
    toolName: WEB_SEARCH_TOOL,
    type: "tool_execution_end",
  });
  const source = events.at(-1);
  assert.ok(source && source.type === "source.created");
  const [chunk] = runtimeEventToUIMessageChunks(source);
  if (chunk.type !== "data-web-source") {
    assert.fail(`expected data-web-source chunk, got ${chunk.type}`);
  }
  assert.ok(!("snippet" in chunk.data));
  assert.ok(!("publishedAt" in chunk.data));
  assert.deepEqual(buildAssistantMessageParts([source]), [
    {
      data: {
        sourceId: "search1-source-0",
        title: "News",
        url: "https://news.example.org/a",
      },
      type: "data-web-source",
    },
  ]);
});

test("failed or third-party tool results cannot emit search source events", () => {
  for (const [toolName, isError] of [
    [WEB_SEARCH_TOOL, true],
    ["webfetch", false],
  ] as const) {
    const events = new PiEventNormalizer().feed({
      isError,
      result: {
        content: [],
        details: {
          sources: [{ title: "News", url: "https://news.example.org/a" }],
        },
      },
      toolCallId: "tc",
      toolName,
      type: "tool_execution_end",
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["tool.completed"]
    );
  }
});

test("pi-web-access web_search structuredContent projects into replayable source cards", () => {
  const events = new PiEventNormalizer().feed({
    isError: false,
    result: {
      content: [{ text: "presentation text", type: "text" }],
      structuredContent: {
        queries: [
          {
            results: [
              { snippet: "terminal coding agent", title: "Pi Coding Agent", url: "https://pi.dev/" },
              { snippet: "release notes", title: "Release v1.5.0", url: "https://github.com/earendil-works/pi/releases/tag/v1.5.0" },
            ],
          },
        ],
      },
    },
    toolCallId: "ws1",
    toolName: "web_search",
    type: "tool_execution_end",
  });
  assert.deepEqual(
    events.map((event) =>
      event.type === "source.created" ? event.url : event.type
    ),
    ["tool.completed", "https://pi.dev/", "https://github.com/earendil-works/pi/releases/tag/v1.5.0"]
  );
  // Snippet rides along into the wire chunk (and the persisted part)
  assert.deepEqual(runtimeEventToUIMessageChunks(events[1]), [
    {
      data: {
        snippet: "terminal coding agent",
        sourceId: "ws1-source-0",
        title: "Pi Coding Agent",
        url: "https://pi.dev/",
      },
      type: "data-web-source",
    },
  ]);
});

test("pi-web-access web_search numbered text fallback still yields source cards", () => {
  const events = new PiEventNormalizer().feed({
    isError: false,
    result: {
      content: [
        {
          text: 'Answer paragraph.\n\n---\n\n**Sources:**\n1. Pi Coding Agent\n   https://pi.dev/\n\n2. Release v1.5.0\n   https://github.com/earendil-works/pi/releases/tag/v1.5.0\n',
          type: "text",
        },
      ],
    },
    toolCallId: "ws2",
    toolName: "web_search",
    type: "tool_execution_end",
  });
  assert.deepEqual(
    events.map((event) =>
      event.type === "source.created" ? event.url : event.type
    ),
    ["tool.completed", "https://pi.dev/", "https://github.com/earendil-works/pi/releases/tag/v1.5.0"]
  );
});
