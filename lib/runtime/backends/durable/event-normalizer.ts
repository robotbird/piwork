import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  EntryId,
  LiveState,
} from "@earendil-works/pi-durable";
import type { RuntimeEvent } from "../../protocol";
import { completedModel } from "../model-identity";
import { normalizeUsage } from "../usage";

type Channel = "text" | "reasoning" | "tool";

/** Project Pi's committed conversation views into the platform event stream. */
export class DurableEventNormalizer {
  private sequence = 0;
  private lastEntry: EntryId | undefined;
  private active = false;
  private readonly blocks = new Map<
    number,
    { channel: Channel; text: string; open: boolean }
  >();
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private busy = false;
  failure: string | undefined;
  runEnded = false;

  /** Existing history is already owned by the caller and must not be replayed. */
  initialize(view: ConversationView): void {
    this.lastEntry = view.entries.at(-1)?.id ?? view.before;
  }

  feed(view: ConversationView): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    const live = (view.docs["pi.live"] ?? {}) as LiveState;
    this.runEnded = false;
    let answered = false;
    for (const entry of view.entries) {
      if (this.lastEntry !== undefined && entry.id <= this.lastEntry) {
        continue;
      }
      this.lastEntry = entry.id;
      for (const message of entry.model ?? []) {
        if (message.role === "assistant") {
          this.render(message, true, events);
          answered = true;
          for (const block of message.content) {
            if (block.type === "toolCall") {
              this.startTool(block.id, block.name, block.arguments, events);
            }
          }
        } else if (message.role === "toolResult") {
          this.startTool(message.toolCallId, message.toolName, {}, events);
          this.endTool(
            message.toolCallId,
            message.toolName,
            message.isError,
            events
          );
        }
      }
    }
    const partial = live.generation?.message;
    if (partial) {
      this.render(partial, false, events);
    } else if (this.active) {
      this.closeBlocks(events);
      this.active = false;
    }
    for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
      if (slot.status === "pending") {
        continue;
      }
      this.startTool(
        slot.callId,
        slot.name,
        "arguments" in slot ? slot.arguments : {},
        events
      );
      if (slot.status === "done") {
        const result =
          "entry" in slot
            ? view.entries.find((entry) => entry.id === slot.entry)?.model?.[0]
            : undefined;
        const isError =
          "summary" in slot
            ? (slot.summary?.isError ?? true)
            : result?.role === "toolResult"
              ? result.isError
              : true;
        this.endTool(slot.callId, slot.name, isError, events);
      }
    }
    this.failure = live.runFailure?.detail;
    this.runEnded =
      (this.busy || answered || live.runFailure !== undefined) &&
      live.run === undefined;
    this.busy = live.run !== undefined;
    return events;
  }

  private startTool(
    id: string,
    name: string,
    args: unknown,
    events: RuntimeEvent[]
  ): void {
    if (!this.startedTools.has(id)) {
      this.startedTools.add(id);
      events.push({
        args,
        toolCallId: id,
        toolName: name,
        type: "tool.started",
      });
    }
  }

  private endTool(
    id: string,
    name: string,
    isError: boolean,
    events: RuntimeEvent[]
  ): void {
    if (!this.completedTools.has(id)) {
      this.completedTools.add(id);
      events.push({
        isError,
        toolCallId: id,
        toolName: name,
        type: "tool.completed",
      });
    }
  }

  private render(
    message: AssistantMessage,
    complete: boolean,
    events: RuntimeEvent[]
  ): void {
    if (!this.active) {
      this.active = true;
      this.blocks.clear();
      this.sequence += 1;
      events.push({ sequence: this.sequence, type: "message.started" });
    }
    for (const [index, block] of message.content.entries()) {
      const channel =
        block.type === "text"
          ? "text"
          : block.type === "thinking"
            ? "reasoning"
            : "tool";
      const text =
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : JSON.stringify(block.arguments);
      const previous = this.blocks.get(index);
      if (!previous) {
        // Close the preceding block before opening the next one.
        this.closeBlocks(events);
        this.blocks.set(index, { channel, open: true, text: "" });
        this.delta(index, channel, "start", events);
      }
      if (previous && !previous.open) {
        continue;
      }
      const emitted = previous?.text ?? "";
      if (text.length > emitted.length && text.startsWith(emitted)) {
        this.delta(index, channel, "delta", events, text.slice(emitted.length));
      }
      this.blocks.set(index, { channel, open: true, text });
    }
    if (complete) {
      this.closeBlocks(events);
      this.active = false;
      const usage = normalizeUsage(message.usage);
      const model = completedModel(message);
      events.push({
        sequence: this.sequence,
        type: "message.completed",
        ...(usage ? { usage } : {}),
        ...(model ? { model } : {}),
      });
    }
  }

  private closeBlocks(events: RuntimeEvent[]): void {
    for (const [index, block] of this.blocks) {
      if (block.open) {
        this.delta(index, block.channel, "end", events);
        block.open = false;
      }
    }
  }

  private delta(
    index: number,
    channel: Channel,
    phase: "start" | "delta" | "end",
    events: RuntimeEvent[],
    delta?: string
  ): void {
    events.push({
      at: Date.now(),
      channel,
      contentIndex: index,
      phase,
      sequence: this.sequence,
      type: "message.delta",
      ...(delta === undefined ? {} : { delta }),
    });
  }
}
