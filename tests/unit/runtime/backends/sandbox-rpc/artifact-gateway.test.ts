import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { StoredFile } from "@/lib/ai/file-store";
import { AsyncEventQueue } from "@/lib/runtime/backends/event-queue";
import { createArtifactGateway } from "@/lib/runtime/backends/sandbox-rpc/artifact-gateway";
import type { RuntimeEvent } from "@/lib/runtime/protocol";

/**
 * Artifact Gateway 宿主侧单测（spec §6 Phase 2 出站基线）：manifest 收割、
 * 幂等、坏输入失败计数（经 drain 上报终态屏障，不再 best-effort 吞错）。
 * 全链路（沙箱内 extension → outbox → 收割 → 终态顺序）见
 * terminal-barrier.test.ts 与 sandbox-rpc.test.ts 的 deliver_file 集成用例。
 */

type Harness = {
  archived: Array<{ chatId: string; file: StoredFile; size: number }>;
  files: Map<string, Uint8Array>;
  queue: AsyncEventQueue<RuntimeEvent>;
  stored: Array<{ buffer: Uint8Array; contentType: string; filename: string }>;
};

function makeGateway(
  files: Record<string, string | Uint8Array>,
  options: { failRead?: (file: string) => boolean } = {}
) {
  const harness: Harness = {
    archived: [],
    files: new Map(
      Object.entries(files).map(([key, value]) => [
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ])
    ),
    queue: new AsyncEventQueue<RuntimeEvent>(),
    stored: [],
  };
  const gateway = createArtifactGateway({
    archiveFile: (chatId, file, size) => {
      harness.archived.push({ chatId, file, size });
      return Promise.resolve();
    },
    chatId: "00000000-0000-0000-0000-0000000000c1",
    queue: harness.queue,
    readFile: (file) => {
      const bytes = harness.files.get(file);
      if (options.failRead?.(file) || !bytes) {
        return Promise.reject(new Error(`read failed: ${file}`));
      }
      return Promise.resolve(bytes);
    },
    store: (input) => {
      harness.stored.push(input);
      const stored: StoredFile = {
        contentType: input.contentType,
        name: input.filename,
        pathname: `blob/${input.filename}`,
        url: `https://blob.test/${input.filename}`,
      };
      return Promise.resolve(stored);
    },
  });
  return { gateway, harness };
}

function deliverFileEnd(manifest: string): JsonAgentSessionEvent {
  return {
    isError: false,
    result: { content: [], details: { id: manifest, manifest } },
    toolCallId: "call-1",
    toolName: "deliver_file",
    type: "tool_execution_end",
  } as unknown as JsonAgentSessionEvent;
}

/** 全量排空队列（调用方负责 queue.end()） */
function drain(harness: Harness): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of harness.queue.iterate()) {
      events.push(event);
    }
  })();
  return done.then(() => events);
}

test("manifest 收割：store + archive + artifact.created", async () => {
  const manifestId = "11111111-1111-4111-8111-111111111111";
  const { gateway, harness } = makeGateway({
    [`piwork/outbox/${manifestId}.json`]: JSON.stringify({
      filename: "report.pdf",
      id: manifestId,
      path: "out/report.pdf",
      size: 9,
    }),
    "out/report.pdf": new TextEncoder().encode("PDF-bytes"),
  });
  const collected = drain(harness);
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${manifestId}.json`));
  await gateway.flush();
  harness.queue.end();
  const events = await collected;

  assert.deepEqual(
    harness.stored.map((stored) => stored.filename),
    ["report.pdf"]
  );
  assert.deepEqual(
    harness.stored[0]?.buffer,
    new TextEncoder().encode("PDF-bytes")
  );
  assert.equal(harness.stored[0]?.contentType, "application/pdf");
  assert.deepEqual(
    harness.archived.map((entry) => entry.chatId),
    ["00000000-0000-0000-0000-0000000000c1"]
  );
  assert.equal(harness.archived[0]?.size, 9);
  const artifact = events.find(
    (event): event is Extract<RuntimeEvent, { type: "artifact.created" }> =>
      event.type === "artifact.created"
  );
  assert.ok(artifact, "应发出 artifact.created");
  assert.equal(artifact.file.filename, "report.pdf");
  assert.equal(artifact.file.url, "https://blob.test/report.pdf");
  assert.equal(artifact.file.contentType, "application/pdf");
});

test("幂等：同 id manifest 重复事件只出站一次", async () => {
  const manifestId = "22222222-2222-4222-8222-222222222222";
  const { gateway, harness } = makeGateway({
    [`piwork/outbox/${manifestId}.json`]: JSON.stringify({
      filename: "a.txt",
      id: manifestId,
      path: "a.txt",
      size: 2,
    }),
    "a.txt": new TextEncoder().encode("hi"),
  });
  const collected = drain(harness);
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${manifestId}.json`));
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${manifestId}.json`));
  await gateway.flush();
  harness.queue.end();
  const events = await collected;
  assert.equal(harness.stored.length, 1);
  assert.equal(
    events.filter((event) => event.type === "artifact.created").length,
    1
  );
});

test("坏 manifest / 读失败 / 超限：无出站、链不 reject，drain 上报失败", async () => {
  const bad = "33333333-3333-4333-8333-333333333333";
  const oversize = "44444444-4444-4444-8444-444444444444";
  const { gateway, harness } = makeGateway(
    { [`piwork/outbox/${bad}.json`]: "not-json{" },
    { failRead: (file) => file.endsWith("missing.json") }
  );
  harness.files.set(
    `piwork/outbox/${oversize}.json`,
    new TextEncoder().encode(
      JSON.stringify({
        filename: "big.bin",
        id: oversize,
        path: "big.bin",
        size: 50 * 1024 * 1024 + 1,
      })
    )
  );
  const collected = drain(harness);
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${bad}.json`));
  gateway.handleEvent(deliverFileEnd("piwork/outbox/missing.json"));
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${oversize}.json`));
  await gateway.flush();
  const drained = await gateway.drain();
  // 三类失败全部计数：invalid manifest / manifest read failed / exceeds size limit
  assert.equal(drained.failures.length, 3);
  assert.match(drained.failures.join(";"), /invalid manifest/);
  assert.match(drained.failures.join(";"), /manifest read failed/);
  assert.match(drained.failures.join(";"), /exceeds size limit/);
  // drain 取走后重置：再次 drain 无遗留
  assert.deepEqual((await gateway.drain()).failures, []);
  harness.queue.end();
  const events = await collected;
  assert.equal(
    events.filter((event) => event.type === "artifact.created").length,
    0
  );
  assert.equal(harness.stored.length, 0);
  assert.equal(harness.archived.length, 0);
});

test("归档失败：链不 reject，drain 上报；后续收割不受影响", async () => {
  const manifestId = "55555555-5555-4555-8555-555555555555";
  const files = new Map<string, Uint8Array>([
    [
      `piwork/outbox/${manifestId}.json`,
      new TextEncoder().encode(
        JSON.stringify({
          filename: "a.txt",
          id: manifestId,
          path: "a.txt",
          size: 2,
        })
      ),
    ],
    ["a.txt", new TextEncoder().encode("hi")],
  ]);
  const queue = new AsyncEventQueue<RuntimeEvent>();
  let archiveShouldFail = true;
  const gateway = createArtifactGateway({
    archiveFile: () =>
      archiveShouldFail
        ? Promise.reject(new Error("archive backend down"))
        : Promise.resolve(),
    chatId: "00000000-0000-0000-0000-0000000000c2",
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
      }),
  });
  const collected = drain({ queue } as Harness);
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${manifestId}.json`));
  let drained = await gateway.drain();
  assert.equal(drained.failures.length, 1);
  assert.match(drained.failures[0] ?? "", /archive backend down/);
  // 修复归档后同 manifest 重就（同 id 幂等跳过）不再失败；新 manifest 正常
  archiveShouldFail = false;
  const secondId = "66666666-6666-4666-8666-666666666666";
  files.set(
    `piwork/outbox/${secondId}.json`,
    new TextEncoder().encode(
      JSON.stringify({ filename: "b.txt", id: secondId, path: "b.txt", size: 2 })
    )
  );
  files.set("b.txt", new TextEncoder().encode("ok"));
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${secondId}.json`));
  drained = await gateway.drain();
  assert.deepEqual(drained.failures, []);
  queue.end();
  const events = await collected;
  assert.equal(
    events.filter((event) => event.type === "artifact.created").length,
    1
  );
});

test("默认出站为平台私有存储：platform key、鉴权 URL、不落 public Blob", async (t) => {
  const manifestId = "77777777-7777-4777-8777-777777777777";
  const directory = await mkdtemp(path.join(tmpdir(), "piwork-gw-private-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  // 注入目录的方式：临时改 UPLOAD_DIR（createPrivateFileStore 读 env）
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = directory;
  t.after(() => {
    if (previous === undefined) {
      process.env.UPLOAD_DIR = undefined;
    } else {
      process.env.UPLOAD_DIR = previous;
    }
  });
  const queue = new AsyncEventQueue<RuntimeEvent>();
  const gateway = createArtifactGateway({
    chatId: "00000000-0000-0000-0000-0000000000c3",
    queue,
    readFile: (file) => {
      if (file === `piwork/outbox/${manifestId}.json`) {
        return Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify({
              filename: "r.txt",
              id: manifestId,
              path: "r.txt",
              size: 4,
            })
          )
        );
      }
      if (file === "r.txt") {
        return Promise.resolve(new TextEncoder().encode("data"));
      }
      return Promise.reject(new Error(`unexpected read: ${file}`));
    },
  });
  const collected = drain({ queue } as Harness);
  gateway.handleEvent(deliverFileEnd(`piwork/outbox/${manifestId}.json`));
  const drained = await gateway.drain();
  assert.deepEqual(drained.failures, []);
  queue.end();
  const events = await collected;
  const artifact = events.find(
    (event): event is Extract<RuntimeEvent, { type: "artifact.created" }> =>
      event.type === "artifact.created"
  );
  assert.ok(artifact, "应发出 artifact.created");
  // 鉴权路由 URL + 私有 key 派生的稳定 id；字节落私有目录
  assert.match(artifact.file.url, /^\/api\/files\/private-[a-f0-9]{64}$/);
  const written = await readdir(directory);
  assert.equal(written.filter((name) => name.startsWith("private-")).length, 2);
});

test("非 deliver_file / isError 事件被忽略", async () => {
  const { gateway, harness } = makeGateway({});
  const ignored: JsonAgentSessionEvent[] = [
    { type: "message_end" } as unknown as JsonAgentSessionEvent,
    {
      isError: true,
      result: { content: [], details: {} },
      toolCallId: "c1",
      toolName: "deliver_file",
      type: "tool_execution_end",
    } as unknown as JsonAgentSessionEvent,
    {
      isError: false,
      result: { content: [], details: {} },
      toolCallId: "c2",
      toolName: "bash",
      type: "tool_execution_end",
    } as unknown as JsonAgentSessionEvent,
  ];
  for (const event of ignored) {
    gateway.handleEvent(event);
  }
  await gateway.flush();
  harness.queue.end();
  await drain(harness);
  assert.equal(harness.stored.length, 0);
});
