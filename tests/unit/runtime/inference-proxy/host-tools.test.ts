import "../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostToolsHandler,
  type HostToolsAuditEntry,
  HostToolsError,
  InferenceProxyServer,
  RunTokenRegistry,
} from "@/lib/runtime/inference-proxy";

/**
 * Sandbox Host Tools Bridge 专测：真 HTTP + 临时端口上验证 /host-tools/<name>
 * 委派——run token 鉴权、hostTools scope 校验（身份只在 grant）、传输层与
 * 工具层错误分离（传输层 HTTP 状态码、工具层 200 {ok:false,error}）、审计
 * 脱敏（不含参数正文）、断连取消只作用于本次调用。
 */

const CHAT_ID = "00000000-0000-0000-0000-0000000000bb";
const USER_ID = "00000000-0000-4000-8000-0000000000ff";
const GRANTS = [{ model: "deepseek-flash", provider: "deepseek" }];
const SCOPE = {
  idempotencyKey: "message-1",
  tools: ["stub_tool"],
  userId: USER_ID,
};

type Booted = {
  audit: HostToolsAuditEntry[];
  close: () => Promise<void>;
  mint: (options?: {
    hostTools?: typeof SCOPE | null;
    runId?: string;
  }) => string;
  url: string;
};

async function boot(): Promise<Booted> {
  const audit: HostToolsAuditEntry[] = [];
  const tokens = new RunTokenRegistry();
  const server = new InferenceProxyServer({
    hostTools: createHostToolsHandler({
      audit: {
        record: (entry) => {
          audit.push(entry);
        },
      },
      tokens,
      tools: {
        stub_tool: async ({ hostTools, input, signal }) => {
          if (input === null || typeof input !== "object") {
            throw new HostToolsError(
              "invalid_input",
              "input must be an object"
            );
          }
          const params = input as { behavior?: string };
          if (params.behavior === "boom") {
            throw new Error("secret internal detail");
          }
          if (params.behavior === "invalid") {
            throw new HostToolsError("invalid_input", "任务参数不合法");
          }
          if (params.behavior === "wait-abort") {
            await new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () =>
                reject(new HostToolsError("aborted", "cancelled"))
              );
            });
            throw new Error("unreachable");
          }
          return {
            content: [
              {
                text: JSON.stringify({
                  echo: params.behavior ?? "ok",
                  userId: hostTools.userId,
                }),
                type: "text",
              },
            ],
          };
        },
      },
    }),
    resolver: () => null,
    tokens,
  });
  const { url } = await server.listen();
  return {
    audit,
    close: () => server.close(),
    mint: (options) =>
      tokens.mint({
        chatId: CHAT_ID,
        grants: GRANTS,
        // 默认带完整 scope；显式传 null = 签发无 hostTools 的 token
        ...(options?.hostTools === null
          ? {}
          : { hostTools: options?.hostTools ?? SCOPE }),
        runId: options?.runId ?? "run-ht-1",
      }).token,
    url,
  };
}

function post(
  url: string,
  token: string,
  body: unknown,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${url}/host-tools/stub_tool`, {
    ...init,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    method: "POST",
  });
}

test("host-tools: 成功分发结果与 grant 身份；审计 allowed 不含参数", async () => {
  const booted = await boot();
  try {
    const token = booted.mint();
    const response = await post(booted.url, token, { behavior: "hi" });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      result: { content: { text: string }[] };
    };
    assert.equal(payload.ok, true);
    const { content } = payload.result;
    assert.ok(content[0]);
    assert.deepEqual(JSON.parse(content[0].text), {
      echo: "hi",
      userId: USER_ID,
    });
    const allowedEntry = booted.audit.at(-1);
    assert.equal(allowedEntry?.status, "allowed");
    assert.equal(allowedEntry?.tool, "stub_tool");
    assert.equal(allowedEntry?.runId, "run-ht-1");
    assert.equal(allowedEntry?.chatId, CHAT_ID);
    assert.equal(typeof allowedEntry?.durationMs, "number");
  } finally {
    await booted.close();
  }
});

test("host-tools: 无/伪 token → 401；有效 token 但 scope 不含该工具 → 403", async () => {
  const booted = await boot();
  try {
    const unauthorized = await post(booted.url, "f".repeat(64), {});
    assert.equal(unauthorized.status, 401);
    assert.equal(booted.audit.at(-1)?.errorCode, "unauthorized");

    const noScope = await post(
      booted.url,
      booted.mint({ hostTools: null }),
      {}
    );
    assert.equal(noScope.status, 403);
    assert.equal(booted.audit.at(-1)?.errorCode, "tool_not_allowed");

    const otherScope = await post(
      booted.url,
      booted.mint({
        hostTools: { ...SCOPE, tools: ["create_scheduled_task"] },
      }),
      {}
    );
    assert.equal(otherScope.status, 403);
  } finally {
    await booted.close();
  }
});

test("host-tools: 未知工具与非 POST → 404；畸形 JSON 与超限 → 400/413", async () => {
  const booted = await boot();
  try {
    const unknown = await fetch(`${booted.url}/host-tools/nope`, {
      headers: { authorization: `Bearer ${booted.mint()}` },
      method: "POST",
    });
    assert.equal(unknown.status, 404);

    const get = await fetch(`${booted.url}/host-tools/stub_tool`, {
      headers: { authorization: `Bearer ${booted.mint()}` },
    });
    assert.equal(get.status, 404);

    const malformed = await post(booted.url, booted.mint(), "{not-json");
    assert.equal(malformed.status, 400);

    const oversized = await post(
      booted.url,
      booted.mint(),
      `${"x".repeat(256 * 1024 + 1)}`
    );
    assert.equal(oversized.status, 413);
  } finally {
    await booted.close();
  }
});

test("host-tools: 工具层失败走 200 {ok:false}——invalid_input 原文返回、内部错误脱敏", async () => {
  const booted = await boot();
  try {
    const invalid = await post(booted.url, booted.mint(), {
      behavior: "invalid",
    });
    assert.equal(invalid.status, 200);
    assert.deepEqual(await invalid.json(), {
      error: { code: "invalid_input", message: "任务参数不合法" },
      ok: false,
    });

    const boom = await post(booted.url, booted.mint(), { behavior: "boom" });
    assert.equal(boom.status, 200);
    const payload = (await boom.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(payload.error.code, "internal_error");
    assert.doesNotMatch(payload.error.message, /secret internal detail/);
    assert.equal(booted.audit.at(-1)?.errorCode, "internal_error");
  } finally {
    await booted.close();
  }
});

test("host-tools: 客户端断开只取消本次调用（impl 收到 abort）", async () => {
  const booted = await boot();
  try {
    const controller = new AbortController();
    const responsePromise = post(
      booted.url,
      booted.mint(),
      { behavior: "wait-abort" },
      { signal: controller.signal }
    );
    // 等服务端进入工具执行后断开
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await responsePromise.then(
      () => undefined,
      () => undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(booted.audit.at(-1)?.errorCode, "aborted");
  } finally {
    await booted.close();
  }
});

test("host-tools: 未注入 handler 时 /host-tools/* 维持 404（既有行为）", async () => {
  const server = new InferenceProxyServer({
    resolver: () => null,
    tokens: new RunTokenRegistry(),
  });
  const { url } = await server.listen();
  try {
    const response = await fetch(`${url}/host-tools/stub_tool`, {
      method: "POST",
    });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
