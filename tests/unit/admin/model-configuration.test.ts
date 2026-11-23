import assert from "node:assert/strict";
import test from "node:test";
import {
  initialCredentialValues,
  mergeCredentialUpdate,
} from "../../../lib/admin/model-plugins";
import {
  definition as deepseek,
  DEFAULT_BASE_URL as deepseekUrl,
} from "../../../plugins/piwork-llm-deepseek/src/provider";
import {
  imageModelCatalog,
  modelCatalog as tongyiChatCatalog,
} from "../../../plugins/piwork-llm-tongyi/src/models";
import {
  definition as tongyi,
  DEFAULT_BASE_URL as tongyiUrl,
} from "../../../plugins/piwork-llm-tongyi/src/provider";
import {
  definition as zhipu,
  DEFAULT_BASE_URL as zhipuUrl,
} from "../../../plugins/piwork-llm-zhipuai/src/provider";

test("plugin public endpoint metadata matches the endpoint used with default credentials", () => {
  assert.equal(deepseek.defaultBaseUrl, deepseekUrl);
  assert.equal(tongyi.defaultBaseUrl, tongyiUrl);
  assert.equal(zhipu.defaultBaseUrl, zhipuUrl);
});

test("tongyi definition combines the chat and image catalogs unchanged", () => {
  assert.equal(
    tongyi.models.length,
    tongyiChatCatalog.length + imageModelCatalog.length
  );
  assert.ok(tongyiChatCatalog.length > 0);
  for (const model of tongyiChatCatalog) {
    assert.equal(model.modelType, "llm");
  }
});

test("tongyi image catalog entries are well-formed image models", () => {
  const ids = new Set<string>();
  for (const model of imageModelCatalog) {
    assert.equal(model.modelType, "image");
    assert.ok(model.modelId.length > 0);
    assert.ok(
      !ids.has(model.modelId),
      `duplicate image model ${model.modelId}`
    );
    ids.add(model.modelId);
    assert.ok(model.label.en || model.label["zh-CN"]);
    assert.equal(typeof model.features.vision, "boolean");
    if (model.pricing) {
      assert.equal(model.pricing.currency, "CNY");
      assert.ok(model.pricing.output > 0);
    }
    // 图像模型不得混入对话模型字段（判别联合收窄后不可访问）
    assert.ok(!("contextSize" in model));
    assert.ok(!("properties" in model));
  }
  // 目录不与对话模型重叠
  for (const id of ids) {
    assert.ok(
      !tongyiChatCatalog.some((model) => model.modelId === id),
      `image model ${id} collides with the chat catalog`
    );
  }
  // 代表性条目：官方价格页 2026-11 北京区核对
  const qwenImage3Pro = imageModelCatalog.find(
    (model) => model.modelId === "qwen-image-3.0-pro"
  );
  assert.deepEqual(qwenImage3Pro?.pricing, {
    currency: "CNY",
    input: 0.02,
    output: 0.25,
  });
  assert.equal(
    imageModelCatalog.find((model) => model.modelId === "wan2.6-image")
      ?.features.textOutput,
    true
  );
  assert.equal(
    imageModelCatalog.find((model) => model.modelId === "z-image-turbo")
      ?.features.vision,
    false
  );
});

test("new forms receive public field defaults without any secret or guessed endpoint", () => {
  const values = initialCredentialValues({
    credentialFields: [
      ...zhipu.credentialFields,
      {
        default: zhipuUrl,
        label: { en: "Base URL" },
        required: false,
        type: "text-input",
        variable: "base_url",
      },
      {
        default: "glm-5-turbo",
        label: { en: "Validation model" },
        required: false,
        type: "text-input",
        variable: "validate_model",
      },
      {
        default: "never-copy",
        label: { en: "Secret" },
        required: true,
        type: "secret-input",
        variable: "secret",
      },
    ],
    credentialsConfigured: false,
  });
  assert.equal(values.base_url, zhipu.defaultBaseUrl);
  assert.equal(values.validate_model, "glm-5-turbo");
  assert.equal(values.api_key, undefined);
  assert.equal(values.secret, undefined);
  assert.deepEqual(initialCredentialValues(null), {});
});

test("configured forms leave credentials empty so rotating keys cannot reset custom endpoints", () => {
  assert.deepEqual(
    initialCredentialValues({
      credentialFields: zhipu.credentialFields,
      credentialsConfigured: true,
    }),
    {}
  );
});

test("credential recovery requires all fields when the old ciphertext is unreadable", () => {
  assert.deepEqual(
    mergeCredentialUpdate(null, { api_key: "new" }, [{ variable: "api_key" }]),
    { api_key: "new" }
  );
  assert.equal(
    mergeCredentialUpdate(null, { api_key: "new" }, [
      { variable: "api_key" },
      { variable: "api_host" },
    ]),
    null
  );
  assert.deepEqual(
    mergeCredentialUpdate(
      { api_host: "custom", api_key: "old" },
      { api_host: "", api_key: "new" },
      [{ variable: "api_key" }, { variable: "api_host" }]
    ),
    { api_host: "custom", api_key: "new" }
  );
});
