import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  JsonAgentSessionEvent,
  RpcClient,
} from "@earendil-works/pi-coding-agent";
import type { StoredFile } from "@/lib/ai/file-store";
import { AsyncEventQueue } from "@/lib/runtime/backends/event-queue";
import { createArtifactGateway } from "@/lib/runtime/backends/sandbox-rpc/artifact-gateway";
import { SandboxRpcRuntimeSession } from "@/lib/runtime/backends/sandbox-rpc/backend";
import type {
  RuntimeBackend,
  RuntimeEvent,
  RuntimeSpec,
} from "@/lib/runtime/protocol";
import { InMemoryEventStore } from "@/lib/runtime/run/in-memory-event-store";
import type {
  AgentRunStatus,
  AgentRunStore,
  AssistantMessageStore,
} from "@/lib/runtime/run/run-manager";
import { RunManager } from "@/lib/runtime/run/run-manager";

/**
 * RPC 终态屏障回归（A1/S1）：官方 agent_settled → 排空 Artifact Gateway
 * 收割并确认归档 → artifact.created 全部入队 → 才发布平台终态。
 * 归档/存储失败 → 平台终态落 run.failed（fail-closed），最终消息不再
 * 静默丢失交付文件。最后一条用例为二审 §3.1 探针场景的真实 RunManager
 * 组合回归（替身只提供 RpcClient 事件源与延迟归档）。
 */

const CHAT = "00000000-0000-4000-8000-0000000000b1";
const USER = "00000000-0000-4000-8000-0000000000b2";

/** 最小 RpcClient 替身：事件由测试手动 emit，其余命令 no-op */
class FakeRpcClient {
  private readonly listeners = new Set<
    (event: JsonAgentSessionEvent) => void
  >();
  stopped = false;

  onEvent(handler: (event: JsonAgentSessionEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  emit(event: JsonAgentSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  // biome-ignore lint/suspicious/useAwait: 替身无进程语义，接口要求 Promise
  async prompt(): Promise<unknown> {
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身无进程语义，接口要求 Promise
  async abort(): Promise<unknown> {
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身无进程语义，接口要求 Promise
  async clearQueue(): Promise<unknown> {
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身无进程语义，接口要求 Promise
  async steer(): Promise<unknown> {
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身无进程语义，接口要求 Promise
  async followUp(): Promise<unknown> {
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身同步置位，接口要求 Promise
  async stop(): Promise<unknown> {
    this.stopped = true;
    return { success: true };
  }

  // biome-ignore lint/suspicious/useAwait: 替身同步派生，接口要求 Promise
  async getState(): Promise<unknown> {
    if (this.stopped) {
      throw new Error("rpc process exited: stopped");
    }
    return { status: "idle" };
  }

  // biome-ignore lint/suspicious/useAwait: 诊断通道恒空
  getStderr(): string {
    return "";
  }
}

function manifestFile(manifestId: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      filename: "report.txt",
      id: manifestId,
      path: "out/report.txt",
      size: 4,
    })
  );
}

function deliverFileEnd(manifestPath: string): JsonAgentSessionEvent {
  return {
    isError: false,
    result: {
      content: [],
      details: { id: manifestPath, manifest: manifestPath },
    },
    toolCallId: "call-deliver",
    toolName: "deliver_file",
    type: "tool_execution_end",
  } as unknown as JsonAgentSessionEvent;
}

const SETTLED_EVENT = {
  type: "agent_settled",
} as unknown as JsonAgentSessionEvent;

type BarrierFixture = {
  client: FakeRpcClient;
  collect: () => Promise<RuntimeEvent[]>;
  /** 会话事件流的活动视图（仅 consume 模式；RunManager 探针由管理器消费） */
  events: RuntimeEvent[];
  session: SandboxRpcRuntimeSession;
};

function makeBarrierFixture(options: {
  archive: () => Promise<void>;
  /** 会话级测试自行消费事件流；RunManager 组合探针传 false */
  consume?: boolean;
}): BarrierFixture {
  const client = new FakeRpcClient();
  const queue = new AsyncEventQueue<RuntimeEvent>();
  const files = new Map<string, Uint8Array>([
    ["piwork/outbox/m1.json", manifestFile("m1")],
    ["out/report.txt", new TextEncoder().encode("data")],
  ]);
  const gateway = createArtifactGateway({
    archiveFile: () => options.archive(),
    chatId: CHAT,
    queue,
    readFile: (file) => {
      const bytes = files.get(file);
      if (!bytes) {
        return Promise.reject(new Error(`read failed: ${file}`));
      }
      return Promise.resolve(bytes);
    },
    store: (input) =>
      Promise.resolve({
        contentType: input.contentType,
        name: input.filename,
        pathname: `blob/${input.filename}`,
        url: `https://blob.test/${input.filename}`,
      } satisfies StoredFile),
  });
  client.onEvent(gateway.handleEvent);
  const session = new SandboxRpcRuntimeSession(
    client as unknown as RpcClient,
    queue,
    // biome-ignore lint/suspicious/useAwait: preClose 替身同步置位
    async () => {
      client.stopped = true;
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: postClose 替身无清理动作
    async () => {},
    async () => {
      const { failures } = await gateway.drain();
      return failures.length > 0
        ? `artifact delivery failed (${failures.length}): ${failures.join("; ")}`
        : undefined;
    }
  );
  const events: RuntimeEvent[] = [];
  const done = options.consume
    ? (async () => {
        for await (const event of session.events()) {
          events.push(event);
        }
      })().catch(() => undefined)
    : undefined;
  return {
    client,
    collect: async () => {
      await session.close("test-end");
      await done;
      return events;
    },
    events,
    session,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: 轮询等待条件，等待点即目的
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout: ${what}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: 轮询等待条件，等待点即目的
    await delay(10);
  }
}

test("慢归档：agent_settled 后终态等待归档，artifact.created 先于终态", async () => {
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const fixture = makeBarrierFixture({
    archive: () => archiveGate,
    consume: true,
  });
  assert.ok(
    (await fixture.session.send({ text: "生成报告", type: "prompt" })).ok
  );
  fixture.client.emit(deliverFileEnd("piwork/outbox/m1.json"));
  fixture.client.emit(SETTLED_EVENT);
  // 归档未放行：不得出现任何终态（二审探针核心断言）
  await delay(150);
  assert.equal(
    fixture.events.filter(
      (event) => event.type === "run.settled" || event.type === "run.failed"
    ).length,
    0,
    "归档未完成时不得发布平台终态"
  );
  releaseArchive();
  await waitFor(
    () =>
      fixture.events.some(
        (event) => event.type === "run.settled" || event.type === "run.failed"
      ),
    2000,
    "屏障放行后的平台终态"
  );
  const events = await fixture.collect();
  const artifactIndex = events.findIndex((e) => e.type === "artifact.created");
  const terminalIndex = events.findIndex(
    (e) => e.type === "run.settled" || e.type === "run.failed"
  );
  assert.ok(artifactIndex >= 0, "应发出 artifact.created");
  assert.ok(terminalIndex >= 0, "应发出平台终态");
  assert.ok(
    artifactIndex < terminalIndex,
    "artifact.created 必须先于平台终态（S1）"
  );
  assert.equal(events[terminalIndex]?.type, "run.settled");
});

test("归档失败：终态落 run.failed 并携带交付失败信息（fail-closed）", async () => {
  const fixture = makeBarrierFixture({
    archive: () => Promise.reject(new Error("archive backend down")),
    consume: true,
  });
  assert.ok(
    (await fixture.session.send({ text: "生成报告", type: "prompt" })).ok
  );
  fixture.client.emit(deliverFileEnd("piwork/outbox/m1.json"));
  fixture.client.emit(SETTLED_EVENT);
  await waitFor(
    () =>
      fixture.events.some(
        (event) => event.type === "run.settled" || event.type === "run.failed"
      ),
    2000,
    "归档失败的终态"
  );
  const snapshot = await fixture.session.snapshot();
  assert.match(
    (snapshot as { errorMessage?: string }).errorMessage ?? "",
    /artifact delivery failed.*archive backend down/
  );
  const events = await fixture.collect();
  const terminal = events.find(
    (e) => e.type === "run.failed" || e.type === "run.settled"
  );
  assert.equal(terminal?.type, "run.failed", "交付失败不得 settled");
  assert.equal(
    events.filter((e) => e.type === "artifact.created").length,
    0,
    "归档失败的制品不发事件"
  );
});

test("close 竞态：屏障在途时 close 不崩溃，队列正常收尾", async () => {
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const fixture = makeBarrierFixture({
    archive: () => archiveGate,
    consume: true,
  });
  assert.ok(
    (await fixture.session.send({ text: "生成报告", type: "prompt" })).ok
  );
  fixture.client.emit(deliverFileEnd("piwork/outbox/m1.json"));
  fixture.client.emit(SETTLED_EVENT);
  const closing = fixture.collect();
  releaseArchive();
  const events = await closing;
  // close 排空后收尾：无论终态是否在 close 前发出，队列都完整结束不悬挂
  assert.ok(Array.isArray(events));
});

// ------------------------------------------------- 真实 RunManager 组合探针

class ProbeRunStore implements AgentRunStore {
  readonly runs = new Map<string, { chatId: string; status: AgentRunStatus }>();
  readonly leases = new Set<string>();
  stopRequested = new Set<string>();
  cleanupErrors: Array<{ error: string; runId: string }> = [];

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async createAgentRun(input: {
    backend: string;
    chatId: string;
    userId: string;
  }): Promise<string> {
    const id = globalThis.crypto.randomUUID();
    this.runs.set(id, { chatId: input.chatId, status: "queued" });
    return id;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async markRunStatus(runId: string, status: AgentRunStatus): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    run.status = status;
    return true;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async getActiveRunByChatId(
    chatId: string
  ): Promise<{ runId: string } | null> {
    for (const [id, run] of this.runs) {
      if (
        run.chatId === chatId &&
        run.status !== "settled" &&
        run.status !== "failed" &&
        run.status !== "aborted"
      ) {
        return { runId: id };
      }
    }
    return null;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async acquireLease(): Promise<boolean> {
    return true;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  // biome-ignore lint/suspicious/noEmptyBlockStatements: 无心跳概念，stale 路径由 PG 集成测试覆盖
  async renewLeases(): Promise<void> {}

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async releaseLease(runId: string): Promise<void> {
    this.leases.delete(runId);
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async failStaleRuns(): Promise<number> {
    return 0;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async failOrphanedRuns(): Promise<number> {
    return 0;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身（A3/S3 端口）
  async requestStop(runId: string): Promise<boolean> {
    this.stopRequested.add(runId);
    return true;
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async getStopRequested(runId: string): Promise<boolean> {
    return this.stopRequested.has(runId);
  }

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async recordCleanupError(runId: string, error: string): Promise<void> {
    this.cleanupErrors.push({ error, runId });
  }
}

class ProbeMessageStore implements AssistantMessageStore {
  readonly upserts: Array<{ id: string; parts: unknown[] }> = [];

  // biome-ignore lint/suspicious/useAwait: 同步替身
  async upsertAssistantMessage(input: {
    chatId: string;
    id: string;
    parts: unknown[];
  }): Promise<void> {
    this.upserts.push({ id: input.id, parts: [...input.parts] });
  }
}

test("RunManager 组合探针（二审 §3.1 场景）：归档放行前不得 settled，最终消息含交付文件", async () => {
  let releaseArchive!: () => void;
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const fixture = makeBarrierFixture({ archive: () => archiveGate });
  const runStore = new ProbeRunStore();
  const messageStore = new ProbeMessageStore();
  const eventStore = new InMemoryEventStore();
  const backend: RuntimeBackend = {
    // biome-ignore lint/suspicious/useAwait: 直接返回已构建会话（同步派生）
    async open(_spec: RuntimeSpec) {
      return fixture.session;
    },
  };
  const manager = new RunManager({
    backend,
    eventStore,
    messageStore,
    runStore,
    workerId: "probe-worker",
  });

  const run = await manager.start({
    prompt: { text: "生成报告", type: "prompt" },
    spec: {
      appendSystemPrompt: [],
      chatId: CHAT,
      historyMessages: [],
      model: {
        id: "test-model",
        name: "Test model",
        provider: "test-provider",
      } as RuntimeSpec["model"],
      systemPrompt: "",
      tools: [],
      workspaceDir: null,
    },
    userId: USER,
  });
  const subscription = run.attach();
  assert.ok(subscription, "start 后应可 attach");

  // 模型完成交付并 settled（官方语义），归档仍在途
  fixture.client.emit(deliverFileEnd("piwork/outbox/m1.json"));
  fixture.client.emit(SETTLED_EVENT);

  // 归档放行前：settled promise 不得 resolve（二审探针核心断言）
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 150);
  });
  assert.equal(
    await Promise.race([subscription.settled.then(() => "settled"), timeout]),
    "timeout",
    "归档未放行时 settled 不得 resolve"
  );

  releaseArchive();
  assert.equal(await subscription.settled, "settled");
  const finalStatus = [...runStore.runs.values()][0]?.status;
  assert.equal(finalStatus, "settled");

  // 最终消息含交付文件（修复前为空 parts）
  const upsert = messageStore.upserts.at(-1);
  assert.ok(upsert, "终态应 upsert assistant 消息");
  const fileParts = JSON.stringify(upsert.parts);
  assert.match(fileParts, /blob\.test\/report\.txt/, "最终消息应含交付文件");

  // 持久事件顺序：artifact.created 先于 run.settled（经 replay 读回）
  const persisted = await eventStore.replay(run.runId, 0);
  const persistedArtifact = persisted.findIndex(
    (e) => e.type === "artifact.created"
  );
  const persistedTerminal = persisted.findIndex(
    (e) => e.type === "run.settled"
  );
  assert.ok(persistedArtifact >= 0, "artifact.created 应持久化");
  assert.ok(persistedTerminal >= 0, "run.settled 应持久化");
  assert.ok(persistedArtifact < persistedTerminal, "持久序同样先交付后终态");
  subscription.close();
});
