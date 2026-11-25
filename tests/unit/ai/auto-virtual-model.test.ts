import "../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { AUTO_VIRTUAL_MODEL_ID } from "../../../lib/ai/models.ts";
import {
  autoVirtualCatalogModel,
  autoVirtualModelDefinition,
  buildVirtualCatalogModel,
  classifyAutoTier,
} from "../../../lib/ai/virtual-models.ts";

const FAST: Model<Api> = {
  api: "openai-completions",
  baseUrl: "https://example",
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "flash",
  input: ["text"],
  maxTokens: 8192,
  name: "Flash",
  provider: "installation:test",
  reasoning: false,
};

const QUALITY: Model<Api> = { ...FAST, id: "pro", name: "Pro" };

function routeRequest(
  overrides: Partial<ModelRouteRequest> = {}
): ModelRouteRequest<{ tier: "fast" | "quality" }> {
  return {
    messages: [
      {
        content: "你好",
        role: "user",
        timestamp: Date.now(),
      } as never,
    ],
    model: autoVirtualCatalogModel(),
    reason: "user",
    thinkingLevel: "medium",
    ...overrides,
  } as ModelRouteRequest<{ tier: "fast" | "quality" }>;
}

test("classifyAutoTier: simple prompts stay fast", () => {
  assert.equal(classifyAutoTier("你好"), "fast");
  assert.equal(classifyAutoTier("帮我写一句问候语"), "fast");
});

test("classifyAutoTier: complexity signals go quality", () => {
  assert.equal(classifyAutoTier("帮我重构这段代码并分析根因"), "quality");
  assert.equal(classifyAutoTier("review this architecture design"), "quality");
  assert.equal(classifyAutoTier("简".repeat(120)), "quality");
});

test("auto route: direct requests go to the fast model", async () => {
  const definition = autoVirtualModelDefinition({
    fast: FAST,
    quality: QUALITY,
  });
  const route = await definition.route(routeRequest({ reason: "direct" }));
  assert.equal(route.model.id, "flash");
});

test("auto route: user turn classifies and stores tier state", async () => {
  const definition = autoVirtualModelDefinition({
    fast: FAST,
    quality: QUALITY,
  });
  const route = await definition.route(
    routeRequest({
      messages: [
        {
          content: "请深入分析这个架构的权衡与风险",
          role: "user",
          timestamp: Date.now(),
        } as never,
      ],
    })
  );
  assert.equal(route.model.id, "pro");
  assert.deepEqual(route.state, { tier: "quality" });
});

test("auto route: same tier keeps the sticky model (cache friendly)", async () => {
  const definition = autoVirtualModelDefinition({
    fast: FAST,
    quality: QUALITY,
  });
  const route = await definition.route(
    routeRequest({
      previous: { model: FAST, thinkingLevel: "medium" },
      state: { tier: "fast" },
    })
  );
  assert.equal(route.model.id, "flash");
  assert.deepEqual(route.state, { tier: "fast" });
});

test("auto route: tier change switches models", async () => {
  const definition = autoVirtualModelDefinition({
    fast: FAST,
    quality: QUALITY,
  });
  const route = await definition.route(
    routeRequest({
      messages: [
        {
          content: "深入分析这个方案的架构风险",
          role: "user",
          timestamp: Date.now(),
        } as never,
      ],
      previous: { model: FAST, thinkingLevel: "medium" },
      state: { tier: "fast" },
    })
  );
  assert.equal(route.model.id, "pro");
  assert.deepEqual(route.state, { tier: "quality" });
});

test("auto route: continuation sticks to the previous physical model", async () => {
  const definition = autoVirtualModelDefinition({
    fast: FAST,
    quality: QUALITY,
  });
  const route = await definition.route(
    routeRequest({
      previous: { model: QUALITY, thinkingLevel: "high" },
      reason: "continuation",
      state: { tier: "quality" },
    })
  );
  assert.equal(route.model.id, "pro");
});

test("auto route: passes thinking level through instead of forcing off", async () => {
  const definition = autoVirtualModelDefinition({ fast: FAST });
  const route = await definition.route(routeRequest({ thinkingLevel: "high" }));
  assert.equal(route.thinkingLevel, "high");
});

test("auto route: without a quality candidate everything stays fast", async () => {
  const definition = autoVirtualModelDefinition({ fast: FAST });
  const route = await definition.route(
    routeRequest({
      messages: [
        {
          content: "复杂架构设计与重构方案分析",
          role: "user",
          timestamp: Date.now(),
        } as never,
      ],
    })
  );
  assert.equal(route.model.id, "flash");
});

test("auto catalog entry: first in dropdown, reasoning levels exposed", () => {
  const entry = autoVirtualCatalogModel();
  assert.equal(entry.id, "auto");
  assert.equal(entry.provider, "piwork");
  assert.equal(entry.api, "pi-virtual");
  assert.equal(`${entry.provider}/${entry.id}`, AUTO_VIRTUAL_MODEL_ID);
  assert.equal(entry.reasoning, true);
  assert.equal(entry.thinkingLevelMap?.medium, "medium");
  assert.equal(entry.thinkingLevelMap?.off, null);
});

test("buildVirtualCatalogModel matches official createVirtualModel semantics", () => {
  const entry = buildVirtualCatalogModel({
    id: "x",
    name: "X",
    provider: "piwork",
    thinkingLevels: ["off"],
  });
  assert.equal(entry.reasoning, false);
  assert.equal(entry.thinkingLevelMap?.off, "off");
  assert.equal(entry.thinkingLevelMap?.medium, null);
});
