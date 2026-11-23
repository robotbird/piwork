import "../../support/runtime-env";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Api,
  AssistantImages,
  ImageModel,
  Model,
} from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
  createDashScopeImagesFunction,
  DASHSCOPE_IMAGES_API,
  IMAGE_GENERATION_PROVIDER_ID,
  imageGenVirtualCatalogModel,
  imageGenVirtualModelDefinition,
  toImageModel,
} from "../../../lib/ai/image-generation.ts";
import { createImageGenTool } from "../../../lib/ai/image-tools.ts";

const MODEL: ImageModel<typeof DASHSCOPE_IMAGES_API> = {
  api: DASHSCOPE_IMAGES_API,
  baseUrl: "https://dashscope.example/v1",
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "qwen-image-test",
  input: ["text"],
  name: "Qwen Image Test",
  output: ["image"],
  provider: IMAGE_GENERATION_PROVIDER_ID,
  type: "image",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function routeRequest(
  overrides: Partial<ModelRouteRequest> = {}
): ModelRouteRequest {
  return {
    messages: [],
    model: imageGenVirtualCatalogModel(),
    reason: "user",
    thinkingLevel: "off",
    ...overrides,
  } as ModelRouteRequest;
}

const ORCHESTRATOR: Model<Api> = {
  api: "openai-completions",
  baseUrl: "https://example",
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "orchestrator",
  input: ["text"],
  maxTokens: 8192,
  name: "Orchestrator",
  provider: "installation:test",
  reasoning: false,
};

test("dashscope images function maps a native synchronous response", async () => {
  const generateImages = createDashScopeImagesFunction({
    apiKey: "key",
    baseUrl: "https://dashscope.example/compatible-mode/v1",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("multimodal-generation")) {
        const body = JSON.parse(String(init?.body)) as {
          input: { messages: unknown[] };
        };
        assert.ok(body.input.messages.length > 0, "native messages shape");
        return jsonResponse({
          output: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: [
                    { image: "https://img.example/a.png", type: "image" },
                  ],
                  role: "assistant",
                },
              },
            ],
          },
        });
      }
      return new Response(Buffer.from("hello"), { status: 200 });
    },
  });
  const result = await generateImages.generateImages(MODEL, {
    input: [{ text: "a cat", type: "text" }],
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.output.length, 1);
  assert.equal(result.output[0]?.type, "image");
  if (result.output[0]?.type === "image") {
    assert.equal(
      result.output[0].data,
      Buffer.from("hello").toString("base64")
    );
  }
});

test("dashscope images function surfaces http errors verbatim", async () => {
  const generateImages = createDashScopeImagesFunction({
    apiKey: "key",
    baseUrl: "https://dashscope.example/compatible-mode/v1",
    fetchImpl: async () =>
      jsonResponse({ code: "InvalidApiKey", message: "InvalidApiKey" }, 401),
  });
  const result = await generateImages.generateImages(MODEL, {
    input: [{ text: "a cat", type: "text" }],
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /401/);
  assert.match(result.errorMessage ?? "", /InvalidApiKey/);
});

test("dashscope images function rejects async task models with a sync hint", async () => {
  const generateImages = createDashScopeImagesFunction({
    apiKey: "key",
    baseUrl: "https://dashscope.example/compatible-mode/v1",
    fetchImpl: async () =>
      jsonResponse({ output: { task_id: "t-1", task_status: "PENDING" } }),
  });
  const result = await generateImages.generateImages(MODEL, {
    input: [{ text: "a cat", type: "text" }],
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /qwen-image-3\.0/);
});

test("dashscope images function rejects image input for now", async () => {
  const generateImages = createDashScopeImagesFunction({
    apiKey: "key",
    baseUrl: "https://dashscope.example/v1",
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: "eA==" }] }),
  });
  const result = await generateImages.generateImages(MODEL, {
    input: [
      { data: "eA==", mimeType: "image/png", type: "image" },
      { text: "edit this", type: "text" },
    ],
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /图生图/);
});

test("virtual model route: user message goes to the orchestrator", async () => {
  const definition = imageGenVirtualModelDefinition(() => ORCHESTRATOR);
  const route = await definition.route(routeRequest({ reason: "user" }));
  assert.equal(route.model.id, "orchestrator");
});

test("virtual model route: continuation sticks to the previous physical model", async () => {
  const previous = { ...ORCHESTRATOR, id: "first-physical" };
  const definition = imageGenVirtualModelDefinition(() => ORCHESTRATOR);
  const route = await definition.route(
    routeRequest({
      previous: { model: previous, thinkingLevel: "off" },
      reason: "continuation",
    })
  );
  assert.equal(route.model.id, "first-physical");
});

test("virtual model route: retry prefers the failed model to preserve caches", async () => {
  const failed = { ...ORCHESTRATOR, id: "failed-physical" };
  const definition = imageGenVirtualModelDefinition(() => ORCHESTRATOR);
  const route = await definition.route(
    routeRequest({
      failed: {
        message: { role: "assistant" } as never,
        model: failed,
      },
      reason: "retry",
    })
  );
  assert.equal(route.model.id, "failed-physical");
});

test("virtual model route: throws without an orchestrator on user requests", async () => {
  const definition = imageGenVirtualModelDefinition(() => undefined);
  await assert.rejects(async () => {
    await definition.route(routeRequest({ reason: "user" }));
  });
});

test("virtual catalog entry uses the pi-virtual api id", () => {
  const entry = imageGenVirtualCatalogModel();
  assert.equal(entry.api, "pi-virtual");
  assert.equal(entry.provider, "piwork");
  assert.equal(entry.id, "image-gen");
});

test("toImageModel keeps catalog ids and zeroes token cost", () => {
  const model = toImageModel(
    "piwork-images",
    {
      features: { vision: false },
      label: { en: "Wan", "zh-CN": "万相" },
      modelId: "wan2.6-t2i",
      modelType: "image",
      pricing: { currency: "CNY", output: 0.2 },
    },
    "https://dashscope.example/v1"
  );
  assert.equal(model.id, "wan2.6-t2i");
  assert.equal(model.type, "image");
  assert.deepEqual(model.cost, {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
  });
});

test("image_gen tool writes workspace files, delivers cards, returns urls", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-imagegen-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const generated: AssistantImages = {
    api: DASHSCOPE_IMAGES_API,
    model: "qwen-image-3.0",
    output: [
      { data: png.toString("base64"), mimeType: "image/png", type: "image" },
    ],
    provider: IMAGE_GENERATION_PROVIDER_ID,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const delivered: { filename: string; url: string }[] = [];
  const tool = createImageGenTool({
    cwd,
    generate: async () => generated,
    getSetup: async () => ({
      apiKey: "key",
      baseUrl: "https://dashscope.example/v1",
      defaultModelId: "qwen-image-3.0",
      imageModels: [],
      models: [
        {
          currency: "CNY",
          modelId: "qwen-image-3.0",
          name: "千问图像 3.0",
          pricePerImage: 0.18,
        },
      ],
      providerName: "通义",
    }),
    onDelivered: (file) => delivered.push(file),
    workspaceDir: cwd,
  });

  const result = await tool.execute("call-1", {
    prompt: "a red circle",
  });
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
  assert.match(text, /千问图像 3\.0/);
  assert.match(text, /0\.18 元\/张/);
  assert.match(text, /generated\/image-/);
  assert.match(text, /不要再用 Markdown 图片语法/);

  assert.equal(delivered.length, 1, "artifact card delivered");
  assert.equal(delivered[0]?.filename.endsWith(".png"), true);
  assert.ok(delivered[0]?.url, "card carries url");

  const files = (result.details as { images: { path?: string }[] }).images;
  assert.equal(files.length, 1);
  const [first] = files;
  assert.ok(first?.path, "workspace path recorded");
  const written = await readFile(join(cwd, first.path), null);
  assert.equal(written.byteLength, png.byteLength);
});

test("image_gen tool auto-routes quality prompts to the pro model", async () => {
  const calls: string[] = [];
  const tool = createImageGenTool({
    generate: async (input) => {
      calls.push(input.modelId);
      return {
        api: DASHSCOPE_IMAGES_API,
        model: input.modelId,
        output: [
          {
            data: Buffer.from("x").toString("base64"),
            mimeType: "image/png",
            type: "image",
          },
        ],
        provider: IMAGE_GENERATION_PROVIDER_ID,
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
    getSetup: async () => ({
      apiKey: "key",
      baseUrl: "https://dashscope.example/v1",
      defaultModelId: "qwen-image-3.0",
      imageModels: [],
      models: [
        { modelId: "qwen-image-3.0", name: "千问图像 3.0" },
        { modelId: "qwen-image-3.0-pro", name: "千问图像 3.0 Pro" },
        { modelId: "z-image-turbo", name: "Z-Image Turbo" },
      ],
      providerName: "通义",
    }),
  });
  await tool.execute("call-a", { prompt: "国风水彩海报，高质量商业插画" });
  await tool.execute("call-b", { prompt: "快速画个头像草稿" });
  await tool.execute("call-c", { prompt: "就随便画个东西" });
  assert.deepEqual(calls, [
    "qwen-image-3.0-pro",
    "z-image-turbo",
    "qwen-image-3.0",
  ]);
});

test("image_gen tool rejects unknown models and missing setup", async () => {
  const tool = createImageGenTool({
    generate: () => Promise.reject(new Error("should not be called")),
    getSetup: async () => null,
  });
  await assert.rejects(
    tool.execute("call-2", { prompt: "x" }),
    /图像生成未配置/
  );
});
