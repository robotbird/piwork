import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  LiveState,
  TaskId,
} from "@earendil-works/pi-durable";
import { DurableEventNormalizer } from "../../../../../lib/runtime/backends/durable/event-normalizer";
import type { RuntimeEvent } from "../../../../../lib/runtime/protocol";

function view(
  live: LiveState = {},
  entries: EntryRecord[] = []
): ConversationView {
  return {
    conversation: { id: 1 as ConversationId },
    docs: { "pi.live": live },
    entries,
  } as ConversationView;
}

function entry(id: number, message: Message): EntryRecord {
  return {
    conversationId: 1 as ConversationId,
    id: id as EntryId,
    kind: message.role,
    model: [message],
  } as EntryRecord;
}

function outline(events: RuntimeEvent[]): string[] {
  return events.map((event) =>
    event.type === "message.delta"
      ? `${event.channel}:${event.phase}${event.delta === undefined ? "" : `(${event.delta})`}`
      : event.type
  );
}

function partial(text: string): LiveState {
  return {
    generation: {
      attempt: 1,
      message: JSON.parse(JSON.stringify(fauxAssistantMessage(text))),
    },
  };
}

test("committed partials and final entries emit each character once", () => {
  const normalizer = new DurableEventNormalizer();
  assert.deepEqual(outline(normalizer.feed(view(partial("ab")))), [
    "message.started",
    "text:start",
    "text:delta(ab)",
  ]);
  assert.deepEqual(outline(normalizer.feed(view(partial("abcdef")))), [
    "text:delta(cdef)",
  ]);
  const final = view({}, [entry(1, fauxAssistantMessage("abcdefg"))]);
  const events = normalizer.feed(final);
  assert.deepEqual(outline(events), [
    "text:delta(g)",
    "text:end",
    "message.completed",
  ]);
  assert.deepEqual(normalizer.feed(final), []);
  for (const event of events) {
    if (event.type === "message.delta") {
      assert.ok((event.at ?? 0) > 0);
    }
  }
});

test("whole answers survive coalesced watches and existing history is skipped", () => {
  const normalizer = new DurableEventNormalizer();
  const history = entry(1, fauxAssistantMessage("old"));
  normalizer.initialize(view({}, [history]));
  assert.deepEqual(
    outline(
      normalizer.feed(
        view({}, [history, entry(2, fauxAssistantMessage("new"))])
      )
    ),
    [
      "message.started",
      "text:start",
      "text:delta(new)",
      "text:end",
      "message.completed",
    ]
  );
  assert.equal(normalizer.runEnded, true);
});

test("reasoning closes before text and closed blocks are not repeated", () => {
  const normalizer = new DurableEventNormalizer();
  const message = {
    ...fauxAssistantMessage(""),
    content: [
      { thinking: "think", type: "thinking" as const },
      { text: "answer", type: "text" as const },
    ],
  };
  assert.deepEqual(
    outline(
      normalizer.feed(
        view({
          generation: {
            attempt: 1,
            message: JSON.parse(JSON.stringify(message)),
          },
        })
      )
    ),
    [
      "message.started",
      "reasoning:start",
      "reasoning:delta(think)",
      "reasoning:end",
      "text:start",
      "text:delta(answer)",
    ]
  );
  assert.deepEqual(
    normalizer.feed(
      view({
        generation: {
          attempt: 1,
          message: JSON.parse(JSON.stringify(message)),
        },
      })
    ),
    []
  );
  assert.deepEqual(outline(normalizer.feed(view({}, [entry(1, message)]))), [
    "text:end",
    "message.completed",
  ]);
});

test("tool entries retain start arguments and error status after coalescing", () => {
  const normalizer = new DurableEventNormalizer();
  const message = {
    ...fauxAssistantMessage(""),
    content: [
      {
        arguments: { path: "file" },
        id: "call",
        name: "read",
        type: "toolCall" as const,
      },
    ],
  };
  const result: Message = {
    content: [],
    isError: true,
    role: "toolResult",
    timestamp: 0,
    toolCallId: "call",
    toolName: "read",
  };
  const events = normalizer.feed(
    view({}, [entry(1, message), entry(2, result)])
  );
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")),
    [
      {
        args: { path: "file" },
        toolCallId: "call",
        toolName: "read",
        type: "tool.started",
      },
      {
        isError: true,
        toolCallId: "call",
        toolName: "read",
        type: "tool.completed",
      },
    ]
  );
});

test("nested tool completion uses the official summary error flag", () => {
  for (const isError of [false, true]) {
    const normalizer = new DurableEventNormalizer();
    const live = {
      nestedTools: [
        {
          arguments: {},
          callId: "parent/child",
          name: "read",
          parentCallId: "parent",
          parentTaskId: 2,
          status: "done",
          summary: { isError },
          taskId: 1,
        },
      ],
    } as LiveState;
    const events = normalizer.feed(view(live));
    assert.deepEqual(events.at(-1), {
      isError,
      toolCallId: "parent/child",
      toolName: "read",
      type: "tool.completed",
    });
    assert.deepEqual(normalizer.feed(view(live)), []);
  }
});

test("run disappearance signals settlement even without an answer", () => {
  const normalizer = new DurableEventNormalizer();
  normalizer.feed(
    view({ run: { inputs: [], taskId: 1 as TaskId, turns: 0 } } as LiveState)
  );
  assert.equal(normalizer.runEnded, false);
  normalizer.feed(
    view({
      runFailure: {
        detail: "unavailable",
        inputs: [],
        reason: "model_error",
        taskId: 1 as TaskId,
      },
    } as LiveState)
  );
  assert.equal(normalizer.runEnded, true);
  assert.equal(normalizer.failure, "unavailable");
});
