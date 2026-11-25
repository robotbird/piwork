import assert from "node:assert/strict";
import test from "node:test";
import {
  createSearchGateway,
  resolveSearchProvider,
} from "../../../lib/search/service.ts";

const TAVILY_BODY = {
  results: [
    {
      content: "tavily content body",
      published_date: "2026-01-02",
      title: "Tavily result",
      url: "https://example.com/a",
    },
  ],
};

const DEEPSEEK_BODY = {
  results: [
    {
      date: "2026-02-03T00:00:00Z",
      snippet: "short snippet",
      summary: "long summary body",
      title: "DeepSeek result",
      url: "https://example.com/b",
    },
    {
      date: null,
      snippet: "x",
      title: "Filtered local",
      url: "http://localhost/secret",
    },
  ],
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

function gatewayWith(fetchImpl: typeof fetch, env: Record<string, string>) {
  return createSearchGateway({
    authorize: async () => {},
    env: () => ({ PIWORK_WEB_SEARCH_ENABLED: "1", ...env }),
    fetch: fetchImpl,
    userId: "test",
  });
}

test("provider resolution: explicit override wins, then keys, else null", () => {
  assert.equal(
    resolveSearchProvider({ PIWORK_SEARCH_PROVIDER: "deepseek" }),
    "deepseek"
  );
  assert.equal(
    resolveSearchProvider({ PIWORK_SEARCH_PROVIDER: "TAVILY" }),
    "tavily"
  );
  assert.equal(resolveSearchProvider({ TAVILY_API_KEY: "k" }), "tavily");
  assert.equal(resolveSearchProvider({ DEEPSEEK_API_KEY: "k" }), "deepseek");
  assert.equal(resolveSearchProvider({}), null);
});

test("deepseek provider sends the native request shape and normalizes", async () => {
  let captured: { url: string; body: string; auth: string } | undefined;
  const gateway = gatewayWith(
    async (input, init) => {
      captured = {
        auth: String(new Headers(init?.headers).get("Authorization")),
        body: String(init?.body),
        url: String(input),
      };
      return ok(DEEPSEEK_BODY);
    },
    { DEEPSEEK_API_KEY: "sk-test" }
  );

  const result = await gateway({ limit: 3, query: "比亚迪 三季报" });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.results.length, 1, "non-public hosts filtered");
  assert.equal(result.results[0]?.title, "DeepSeek result");
  assert.equal(result.results[0]?.snippet, "long summary body");
  assert.equal(result.results[0]?.publishedAt, "2026-02-03T00:00:00Z");
  assert.match(captured?.url ?? "", /\/v1\/tools\/search$/);
  const body = JSON.parse(captured?.body ?? "{}");
  assert.equal(body.query, "比亚迪 三季报");
  assert.equal(body.count, 3);
  assert.match(captured?.auth ?? "", /^Bearer sk-test$/);
});

test("tavily provider stays the default when only its key is present", async () => {
  const gateway = gatewayWith(async () => ok(TAVILY_BODY), {
    TAVILY_API_KEY: "tvly-test",
  });
  const result = await gateway({ limit: 2, query: "q" });
  assert.equal(result.provider, "tavily");
  assert.equal(result.results[0]?.snippet, "tavily content body");
});

test("no keys configured surfaces the unconfigured error", async () => {
  const gateway = gatewayWith(async () => ok(TAVILY_BODY), {});
  await assert.rejects(gateway({ limit: 1, query: "q" }), (error: Error) =>
    /searchUnconfigured|联网搜索/.test(error.message)
  );
});

test("provider failures map to the generic unavailable error", async () => {
  const gateway = gatewayWith(
    async () => new Response("denied", { status: 403 }),
    { DEEPSEEK_API_KEY: "sk-test" }
  );
  await assert.rejects(
    gateway({ limit: 1, query: "q" }),
    (error: Error) => error.message.length > 0
  );
});
