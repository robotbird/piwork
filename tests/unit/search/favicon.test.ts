// biome-ignore-all lint/suspicious/useAwait: Async test doubles implement the fetch contract.
// biome-ignore-all lint/performance/noAwaitInLoops: Sequential lookups deliberately verify fetch/cache behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { clearFaviconCache, fetchFavicon } from "../../../lib/search/favicon";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a,
]);
const ICO_BYTES = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

function countingFetcher(response: () => Response): {
  calls: () => number;
  fetch: typeof fetch;
} {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      return response();
    },
  };
}

test("non-public hosts are rejected before any upstream fetch", async () => {
  clearFaviconCache();
  const fetcher = countingFetcher(() => new Response(PNG_BYTES));
  for (const host of [
    "",
    "localhost",
    "10.0.0.1",
    "2130706433",
    "service.internal",
    "news.example.org:8080",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      await fetchFavicon(host, { fetch: fetcher.fetch }),
      null,
      host
    );
  }
  assert.equal(fetcher.calls(), 0);
});

test("content type comes from magic bytes, not upstream headers; hits are cached", async () => {
  clearFaviconCache();
  const fetcher = countingFetcher(
    () => new Response(PNG_BYTES, { headers: { "Content-Type": "text/html" } })
  );
  const first = await fetchFavicon("news.example.org", {
    fetch: fetcher.fetch,
  });
  assert.ok(first);
  assert.equal(first.contentType, "image/png");
  // deepStrictEqual is prototype-strict; compare through a plain Uint8Array view
  assert.deepEqual(new Uint8Array(first.bytes), PNG_BYTES);
  const second = await fetchFavicon("news.example.org", {
    fetch: fetcher.fetch,
  });
  assert.equal(second, first);
  assert.equal(fetcher.calls(), 1);
});

test("ico magic bytes are recognized", async () => {
  clearFaviconCache();
  const fetcher = countingFetcher(() => new Response(ICO_BYTES));
  const result = await fetchFavicon("ico.example.org", {
    fetch: fetcher.fetch,
  });
  assert.equal(result?.contentType, "image/x-icon");
});

test("non-icon payloads count as misses even with an image content type", async () => {
  clearFaviconCache();
  const fetcher = countingFetcher(
    () =>
      new Response("<html>not an icon</html>", {
        headers: { "Content-Type": "image/png" },
      })
  );
  assert.equal(
    await fetchFavicon("spoof.example.org", { fetch: fetcher.fetch }),
    null
  );
  assert.equal(fetcher.calls(), 1);
});

test("oversized and failed responses resolve as cached misses", async () => {
  clearFaviconCache();
  const oversized = new Uint8Array(300 * 1024);
  oversized.set(PNG_BYTES);
  const big = countingFetcher(() => new Response(oversized));
  assert.equal(
    await fetchFavicon("big.example.org", { fetch: big.fetch }),
    null
  );
  const failed = countingFetcher(() => new Response(null, { status: 500 }));
  assert.equal(
    await fetchFavicon("down.example.org", { fetch: failed.fetch }),
    null
  );
  // Misses are cached too: repeat lookups do not hit the upstream again
  assert.equal(
    await fetchFavicon("down.example.org", { fetch: failed.fetch }),
    null
  );
  assert.equal(failed.calls(), 1);
});

test("upstream timeout resolves as a miss", async () => {
  clearFaviconCache();
  const fetcher: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted"))
      );
    });
  // AbortSignal.timeout timers are unref'ed; keep the test process alive while waiting.
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    assert.equal(
      await fetchFavicon("slow.example.org", {
        fetch: fetcher,
        timeoutMs: 20,
      }),
      null
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
