import assert from "node:assert/strict";
import test from "node:test";
import { formatThinkingDuration } from "@/lib/chat/reasoning-duration";

test("formatThinkingDuration：分档展示且负值钳为 0", () => {
  assert.equal(formatThinkingDuration(0), "0.0s");
  assert.equal(formatThinkingDuration(320), "0.3s");
  assert.equal(formatThinkingDuration(3240), "3.2s");
  assert.equal(formatThinkingDuration(9940), "9.9s");
  assert.equal(formatThinkingDuration(13_000), "13s");
  assert.equal(formatThinkingDuration(59_400), "59s");
  assert.equal(formatThinkingDuration(60_000), "1m 0s");
  assert.equal(formatThinkingDuration(83_000), "1m 23s");
  assert.equal(formatThinkingDuration(150_000), "2m 30s");
  assert.equal(formatThinkingDuration(-500), "0.0s");
});
