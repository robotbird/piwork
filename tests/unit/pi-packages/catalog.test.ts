import assert from "node:assert/strict";
import test from "node:test";

import { searchPiPackageCatalog } from "../../../lib/pi-packages/catalog.ts";

/** Stub global fetch to capture the request URL and return a canned payload. */
function stubNpmSearch(objects: unknown[], total: number) {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ objects, total }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      })
    );
  }) as typeof globalThis.fetch;
  return {
    requestedUrls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("searchPiPackageCatalog 翻页使用 npm 的 from 参数而非 offset", async () => {
  const objects = [
    {
      package: {
        date: "2026-01-01T00:00:00.000Z",
        description: "demo package",
        keywords: ["pi-package"],
        links: { npm: "https://www.npmjs.com/package/demo-pkg" },
        name: "demo-pkg",
        publisher: { username: "alice" },
        version: "1.0.0",
      },
    },
  ];
  const stub = stubNpmSearch(objects, 42);
  try {
    const result = await searchPiPackageCatalog("", 20);

    assert.equal(stub.requestedUrls.length, 1);
    const url = new URL(stub.requestedUrls[0]);
    // npm search 仅识别 from;offset 会被忽略并导致翻页重复返回首页
    assert.equal(url.searchParams.get("from"), "20");
    assert.equal(url.searchParams.get("offset"), null);
    assert.equal(url.searchParams.get("size"), "20");
    assert.equal(url.searchParams.get("text"), "keywords:pi-package");

    assert.equal(result.total, 42);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, "demo-pkg");
    assert.equal(result.items[0].publisher, "alice");
    assert.equal(result.items[0].version, "1.0.0");
  } finally {
    stub.restore();
  }
});

test("searchPiPackageCatalog 非空查询拼接 keyword 基线", async () => {
  const stub = stubNpmSearch([], 0);
  try {
    await searchPiPackageCatalog("weather", 0);
    const url = new URL(stub.requestedUrls[0]);
    assert.equal(url.searchParams.get("text"), "keywords:pi-package weather");
    assert.equal(url.searchParams.get("from"), "0");
  } finally {
    stub.restore();
  }
});

test("searchPiPackageCatalog 非 2xx 响应抛出错误", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("boom", { status: 500 })) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => searchPiPackageCatalog("", 0),
      /npm registry search failed: 500/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
