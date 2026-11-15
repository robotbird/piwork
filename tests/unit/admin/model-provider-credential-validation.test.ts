import assert from "node:assert/strict";
import test from "node:test";
import { validateCredentials as deepseekValidate } from "../../../plugins/piwork-llm-deepseek/src/provider";
import { validateCredentials as tongyiValidate } from "../../../plugins/piwork-llm-tongyi/src/provider";
import { validateCredentials as zhipuValidate } from "../../../plugins/piwork-llm-zhipuai/src/provider";

type ValidateFn = typeof tongyiValidate;

const PROVIDERS: Array<{ name: string; validate: ValidateFn }> = [
  { name: "tongyi", validate: tongyiValidate },
  { name: "deepseek", validate: deepseekValidate },
  { name: "zhipu", validate: zhipuValidate },
];

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  401: "Unauthorized",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/**
 * Yield one real macrotask so microtasks pending in the validator (fake fetch
 * resolution, await chains) settle between virtual-time ticks. setImmediate
 * is not covered by the setTimeout mock.
 */
const flushMicrotasks = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Returns a fetch stub replaying the queued statuses (last one repeats) and
 * counting the probe requests, plus a ctx object collecting warn logs.
 */
function makeCtx(statuses: number[]) {
  let calls = 0;
  const warnings: string[] = [];
  return {
    calls: () => calls,
    ctx: {
      config: {},
      credentials: { api_key: "sk-test-key" },
      fetch: (() => {
        const status = statuses[Math.min(calls, statuses.length - 1)];
        calls += 1;
        return Promise.resolve(
          new Response(null, {
            status,
            statusText: STATUS_TEXT[status] ?? "",
          })
        );
      }) as typeof globalThis.fetch,
      logger: {
        error: () => undefined,
        info: () => undefined,
        warn: (message: string) => warnings.push(message),
      },
    },
    warnings,
  };
}

for (const { name, validate } of PROVIDERS) {
  test(`${name}: accepts credentials when the probe succeeds`, async () => {
    const stub = makeCtx([200]);
    await validate(stub.ctx);
    assert.equal(stub.calls(), 1);
    assert.deepEqual(stub.warnings, []);
  });

  test(`${name}: rejects a missing api key without probing`, async () => {
    const stub = makeCtx([200]);
    await assert.rejects(
      validate({ ...stub.ctx, credentials: {} }),
      /api_key is required/
    );
    assert.equal(stub.calls(), 0);
  });

  test(`${name}: rejects an invalid api key (HTTP 401)`, async () => {
    const stub = makeCtx([401]);
    await assert.rejects(validate(stub.ctx), /Invalid API key \(HTTP 401\)/);
    assert.equal(stub.calls(), 1);
  });

  test(`${name}: fails on unexpected server errors`, async () => {
    const stub = makeCtx([500]);
    await assert.rejects(
      validate(stub.ctx),
      /Credential validation failed: HTTP 500/
    );
    assert.equal(stub.calls(), 1);
  });

  test(`${name}: retries a throttled probe and succeeds`, async (t) => {
    const stub = makeCtx([429, 200]);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = validate(stub.ctx);
    // Let the first probe resolve and the 1s backoff timer get scheduled.
    await flushMicrotasks();
    t.mock.timers.tick(1000);
    await pending;
    assert.equal(stub.calls(), 2);
    assert.deepEqual(stub.warnings, []);
  });

  test(`${name}: accepts credentials when still throttled after retries`, async (t) => {
    const stub = makeCtx([429]);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = validate(stub.ctx);
    await flushMicrotasks();
    t.mock.timers.tick(1000);
    // Let the first retry probe resolve and the 2s backoff get scheduled.
    await flushMicrotasks();
    t.mock.timers.tick(2000);
    await pending;
    // 1 initial probe + 2 retries, then the throttled key is accepted.
    assert.equal(stub.calls(), 3);
    assert.equal(stub.warnings.length, 1);
    assert.match(stub.warnings[0], /throttled the validation probe/);
  });
}
