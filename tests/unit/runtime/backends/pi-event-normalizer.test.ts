import "../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiEventNormalizer } from "../../../../lib/runtime/backends/pi-event-normalizer";
import type { RuntimeEvent } from "../../../../lib/runtime/protocol";

function piEvent(event: unknown): AgentSessionEvent {
  return event as AgentSessionEvent;
}

/** assistant message_update 事件的简写 */
function assistantUpdate(update: Record<string, unknown>): AgentSessionEvent {
  return piEvent({
    assistantMessageEvent: update,
    type: "message_update",
  });
}

test("message.delta 事件携带归一化时刻 at（epoch ms）", () => {
  const normalizer = new PiEventNormalizer();
  normalizer.feed(
    piEvent({ message: { role: "assistant" }, type: "message_start" })
  );
  const events = [
    ...normalizer.feed(
      assistantUpdate({ contentIndex: 0, type: "thinking_start" })
    ),
    ...normalizer.feed(
      assistantUpdate({
        contentIndex: 0,
        delta: "思考",
        type: "thinking_delta",
      })
    ),
    ...normalizer.feed(
      assistantUpdate({ contentIndex: 0, type: "thinking_end" })
    ),
  ];
  assert.equal(events.length, 3);
  for (const event of events) {
    const delta = event as Extract<RuntimeEvent, { type: "message.delta" }>;
    assert.equal(delta.type, "message.delta");
    assert.equal(delta.channel, "reasoning");
    assert.equal(typeof delta.at, "number");
    assert.ok(delta.at !== undefined && delta.at > 0);
  }
  // 非.delta 事件不携带 at 字段
  const started = normalizer.feed(
    piEvent({ message: { role: "assistant" }, type: "message_start" })
  );
  assert.deepEqual(started, [{ sequence: 2, type: "message.started" }]);
});
