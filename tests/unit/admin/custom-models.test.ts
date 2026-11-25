import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import type { ProviderDefinition } from "@piwork/model-provider-sdk";
import {
  customModelSchema,
  effectiveCustomModelMaxTokens,
  normalizeCustomEndpoint,
} from "../../../lib/admin/custom-models";
import {
  createCustomProvider,
  validateCustomCredentials,
} from "../../../lib/model-plugins/custom-provider";

test("custom model validates endpoint and token limits", () => {
  const input = {
    apiKey: "secret",
    endpoint: "https://example.com/v1/chat/completions",
    modelId: "test",
  };
  assert.equal(customModelSchema.parse(input).contextWindow, 128_000);
  for (const endpoint of [
    "file:///tmp/test",
    "https://user:pass@example.com",
    "https://example.com?key=secret",
  ]) {
    assert.equal(
      customModelSchema.safeParse({ ...input, endpoint }).success,
      false
    );
  }
  assert.equal(
    customModelSchema.safeParse({ ...input, maxTokens: 200_000 }).success,
    false
  );
  assert.equal(
    normalizeCustomEndpoint(`${input.endpoint}/`),
    "https://example.com/v1"
  );
});

test("BigModel GLM-5.3 caps output separately from its context window", () => {
  const api = "anthropic-messages";
  const endpoint = "https://open.bigmodel.cn/api/anthropic";
  assert.equal(
    effectiveCustomModelMaxTokens(api, endpoint, "glm-5.3", 1_000_000),
    131_072
  );
  assert.equal(
    effectiveCustomModelMaxTokens(api, endpoint, "glm-5.3", 8192),
    8192
  );
  assert.equal(
    effectiveCustomModelMaxTokens(
      api,
      "https://example.com/api/anthropic",
      "glm-5.3",
      1_000_000
    ),
    1_000_000
  );
});

test("connection test uses Pi streaming, model ID, endpoint and saved credentials", async () => {
  const requests: {
    auth: string | undefined;
    url: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      auth: req.headers.authorization,
      body: JSON.parse(body),
      url: req.url,
    });
    if (req.headers.authorization === "Bearer invalid") {
      res.writeHead(401).end('{"error":{"message":"unauthorized"}}');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"id":"test","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const definition: ProviderDefinition = {
    credentialFields: [],
    description: { en: "test" },
    help: { title: { en: "test" }, url: { en: endpoint } },
    models: [
      {
        features: {
          reasoning: false,
          streamToolCall: false,
          toolCall: false,
          vision: true,
        },
        label: { en: "My model" },
        modelId: "my-model",
        modelType: "llm",
        parameterRules: [],
        properties: {
          contextSize: 64_000,
          defaultMaxTokens: 4096,
          mode: "chat",
        },
      },
    ],
    name: { en: "test" },
    networkHosts: ["127.0.0.1"],
    provider: "custom-test",
  };
  try {
    const credentials = { api_key: "test-secret", endpoint_url: endpoint };
    const provider = createCustomProvider(
      definition,
      credentials,
      "installation:test"
    );
    assert.deepEqual(provider.getModels()[0].input, ["text", "image"]);
    assert.equal(provider.getModels()[0].provider, "installation:test");
    await validateCustomCredentials(definition, credentials);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].auth, "Bearer test-secret");
    assert.equal(requests[0].body.model, "my-model");
    assert.equal(requests[0].body.max_completion_tokens, 4096);
    await assert.rejects(
      validateCustomCredentials(definition, {
        ...credentials,
        api_key: "invalid",
      }),
      /customConnectionFailed/
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("protocol validation defaults legacy entries and rejects unknown formats", () => {
  const input = {
    apiKey: "secret",
    endpoint: "https://example.com",
    modelId: "test",
  };
  assert.equal(customModelSchema.parse(input).api, "openai-completions");
  assert.equal(
    customModelSchema.safeParse({ ...input, api: "unknown" }).success,
    false
  );
  for (const api of ["anthropic-messages", "openai-responses"] as const) {
    assert.equal(customModelSchema.parse({ ...input, api }).api, api);
  }
});

test("endpoint normalization respects the chosen protocol and gateway prefix", () => {
  for (const endpoint of [
    "https://example.com/gateway",
    "https://example.com/gateway/v1/",
    "https://example.com/gateway/v1/messages/",
  ]) {
    assert.equal(
      normalizeCustomEndpoint(endpoint, "anthropic-messages"),
      "https://example.com/gateway"
    );
  }
  assert.equal(
    normalizeCustomEndpoint(
      "https://example.com/gateway/v1/responses/",
      "openai-responses"
    ),
    "https://example.com/gateway/v1"
  );
  assert.equal(
    normalizeCustomEndpoint(
      "https://example.com/gateway/v1",
      "openai-responses"
    ),
    "https://example.com/gateway/v1"
  );
});

function eventStream(events: { type: string; [key: string]: unknown }[]) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const protocolFixtures = [
  {
    api: "anthropic-messages" as const,
    authHeader: "x-api-key",
    authorization: "test-secret",
    endpoints: ["/gateway", "/gateway/v1", "/gateway/v1/messages"],
    path: "/gateway/v1/messages?beta=true",
    stream: eventStream([
      {
        message: {
          content: [],
          id: "msg_test",
          model: "my-model",
          role: "assistant",
          type: "message",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        type: "message_start",
      },
      {
        content_block: { text: "", type: "text" },
        index: 0,
        type: "content_block_start",
      },
      {
        delta: { text: "Hello", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      { index: 0, type: "content_block_stop" },
      {
        delta: { stop_reason: "end_turn" },
        type: "message_delta",
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]),
  },
  {
    api: "openai-responses" as const,
    authHeader: "authorization",
    authorization: "Bearer test-secret",
    endpoints: ["/gateway/v1", "/gateway/v1/responses"],
    path: "/gateway/v1/responses",
    stream: eventStream([
      {
        response: { id: "resp_test", status: "in_progress" },
        type: "response.created",
      },
      {
        item: {
          content: [],
          id: "msg_test",
          role: "assistant",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.added",
      },
      {
        content_index: 0,
        output_index: 0,
        part: { annotations: [], text: "", type: "output_text" },
        type: "response.content_part.added",
      },
      {
        content_index: 0,
        delta: "Hello",
        output_index: 0,
        type: "response.output_text.delta",
      },
      {
        item: {
          content: [{ annotations: [], text: "Hello", type: "output_text" }],
          id: "msg_test",
          role: "assistant",
          type: "message",
        },
        output_index: 0,
        type: "response.output_item.done",
      },
      {
        response: {
          id: "resp_test",
          output: [],
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
        type: "response.completed",
      },
    ]),
  },
];

for (const fixture of protocolFixtures) {
  test(`${fixture.api} uses official streaming, auth and normalized gateway URLs`, async () => {
    const requests: {
      url: string | undefined;
      auth: string | string[] | undefined;
      body: Record<string, unknown>;
    }[] = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
      }
      requests.push({
        auth: req.headers[fixture.authHeader],
        body: JSON.parse(text),
        url: req.url,
      });
      if (req.headers[fixture.authHeader]?.includes("invalid")) {
        res
          .writeHead(401)
          .end(
            '{"error":{"type":"authentication_error","message":"unauthorized"}}'
          );
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/event-stream" })
        .end(fixture.stream);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const definition: ProviderDefinition = {
      api: fixture.api,
      credentialFields: [],
      description: { en: "test" },
      help: { title: { en: "test" }, url: { en: origin } },
      models: [
        {
          features: {
            reasoning: false,
            streamToolCall: false,
            toolCall: false,
            vision: true,
          },
          label: { en: "test" },
          modelId: "my-model",
          modelType: "llm",
          parameterRules: [],
          properties: {
            contextSize: 64_000,
            defaultMaxTokens: 4096,
            mode: "chat",
          },
        },
      ],
      name: { en: "test" },
      networkHosts: ["127.0.0.1"],
      provider: "custom-test",
    };
    try {
      await Promise.all(
        fixture.endpoints.map(async (endpoint) => {
          const credentials = {
            api_key: "test-secret",
            endpoint_url: `${origin}${endpoint}`,
          };
          const provider = createCustomProvider(
            JSON.parse(JSON.stringify(definition)),
            credentials,
            "installation:test"
          );
          assert.equal(provider.getModels()[0].api, fixture.api);
          const models = createModels();
          models.setProvider(provider);
          const result = await models.completeSimple(provider.getModels()[0], {
            messages: [{ content: "Hi", role: "user", timestamp: Date.now() }],
            tools: [
              {
                description: "Test tool",
                name: "test_tool",
                parameters: { properties: {}, type: "object" },
              },
            ],
          });
          assert.equal(result.stopReason, "stop");
          assert.ok(
            result.content.some(
              (block) => block.type === "text" && block.text === "Hello"
            )
          );
          await validateCustomCredentials(definition, credentials);
        })
      );
      for (const request of requests) {
        assert.equal(request.url, fixture.path);
        assert.equal(request.auth, fixture.authorization);
        assert.equal(request.body.model, "my-model");
        assert.equal(request.body.stream, true);
        assert.equal(request.body.tools, undefined);
      }
      await assert.rejects(
        validateCustomCredentials(definition, {
          api_key: "invalid",
          endpoint_url: `${origin}${fixture.endpoints[0]}`,
        }),
        /customConnectionFailed/
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
