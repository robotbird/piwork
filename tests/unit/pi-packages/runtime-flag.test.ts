import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WEB_SEARCH_PACKAGES,
  isWebSearchPackage,
} from "../../../lib/pi-packages/runtime-flag.ts";

test("web-search package matching covers npm name and pinned sources", () => {
  const match = (name: string, source: string) =>
    isWebSearchPackage({ name, source }, {});
  assert.equal(match("pi-web-access", "npm:pi-web-access"), true);
  assert.equal(match("pi-web-access", "npm:pi-web-access@0.47.0"), true);
  assert.equal(match("pi-web-access", "/repo/tests/fixtures/pkg"), true);
  assert.equal(match("other-package", "npm:other-package@1.0.0"), false);
  // 前缀相似但不同的包名不得命中
  assert.equal(match("pi-web-access-plus", "npm:pi-web-access-plus"), false);
});

test("web-search package list is overridable via env", () => {
  const env = { PIWORK_WEB_SEARCH_PACKAGES: "custom-search,another" };
  assert.equal(
    isWebSearchPackage(
      { name: "custom-search", source: "npm:custom-search@1.0.0" },
      env
    ),
    true
  );
  // 覆盖后默认名单不再命中
  assert.equal(
    isWebSearchPackage(
      { name: "pi-web-access", source: "npm:pi-web-access" },
      env
    ),
    false
  );
});

test("default web-search package list contains pi-web-access", () => {
  assert.deepEqual(DEFAULT_WEB_SEARCH_PACKAGES, ["pi-web-access"]);
});
