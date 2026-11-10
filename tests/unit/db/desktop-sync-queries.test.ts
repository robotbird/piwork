import "../../support/db-env";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { getDb } from "../../../lib/db/client";
import {
  acquireDesktopSyncLease,
  appendDesktopSyncChat,
  DesktopSyncConflict,
  DesktopSyncForbidden,
  readDesktopSyncChat,
  releaseDesktopSyncLease,
} from "../../../lib/db/desktop-sync-queries";

test("desktop sync is private, idempotent and rejects divergent text histories", {
  skip: !process.env.POSTGRES_URL,
}, async () => {
  const db = getDb();
  const user = crypto.randomUUID(),
    other = crypto.randomUUID(),
    chatId = crypto.randomUUID();
  const first = {
      id: crypto.randomUUID(),
      role: "user" as const,
      text: "整理会议",
    },
    answer = {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      text: "已完成",
    };
  try {
    await db.execute(
      sql`insert into "User" (id,email) values (${user},${`${user}@test.local`}),(${other},${`${other}@test.local`})`
    );
    const request = {
      chatId,
      expected: [],
      messages: [first, answer],
      title: "会议",
      userId: user,
    };
    await appendDesktopSyncChat(request);
    await appendDesktopSyncChat(request);
    const stored = await readDesktopSyncChat(user, chatId);
    assert.deepEqual(stored?.messages, [first, answer]);
    assert.equal(await readDesktopSyncChat(other, chatId), null);
    await assert.rejects(
      appendDesktopSyncChat({ ...request, userId: other }),
      DesktopSyncForbidden
    );
    await assert.rejects(
      appendDesktopSyncChat({
        ...request,
        expected: [{ ...first, text: "changed" }],
        messages: [],
      }),
      DesktopSyncConflict
    );
    await assert.rejects(
      appendDesktopSyncChat({
        ...request,
        messages: [first, { ...answer, text: "changed" }],
      }),
      DesktopSyncConflict
    );
    const remote = {
      id: crypto.randomUUID(),
      role: "user" as const,
      text: "Web 续写",
    };
    await db.execute(
      sql`insert into "Message_v2" (id,"chatId",role,parts,attachments,"createdAt") values (${remote.id},${chatId},'user',${JSON.stringify([{ text: remote.text, type: "text" }])}::json,'[]'::json,now()+interval '2 seconds')`
    );
    await assert.rejects(
      appendDesktopSyncChat({
        ...request,
        expected: [first, answer],
        messages: [{ id: crypto.randomUUID(), role: "user", text: "桌面续写" }],
      }),
      DesktopSyncConflict
    );
    assert.deepEqual((await readDesktopSyncChat(user, chatId))?.messages, [
      first,
      answer,
      remote,
    ]);
  } finally {
    await db.execute(sql`delete from "Message_v2" where "chatId"=${chatId}`);
    await db.execute(sql`delete from "Chat" where id=${chatId}`);
    await db.execute(sql`delete from "User" where id in (${user},${other})`);
  }
});

test("simultaneous divergent appends cannot both commit", {
  skip: !process.env.POSTGRES_URL,
}, async () => {
  const db = getDb();
  const user = crypto.randomUUID(),
    chatId = crypto.randomUUID();
  try {
    await db.execute(
      sql`insert into "User" (id,email) values (${user},${`${user}@test.local`})`
    );
    const base = { chatId, expected: [], title: "race", userId: user };
    const attempts = await Promise.allSettled(
      ["A", "B"].map((text) =>
        appendDesktopSyncChat({
          ...base,
          messages: [{ id: crypto.randomUUID(), role: "user", text }],
        })
      )
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1
    );
    const rejected = attempts.find((result) => result.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof DesktopSyncConflict
    );
    assert.equal((await readDesktopSyncChat(user, chatId))?.messages.length, 1);
  } finally {
    await db.execute(sql`delete from "Message_v2" where "chatId"=${chatId}`);
    await db.execute(sql`delete from "Chat" where id=${chatId}`);
    await db.execute(sql`delete from "User" where id=${user}`);
  }
});

test("run leases prevent concurrent execution and release atomically with final messages", {
  skip: !process.env.POSTGRES_URL,
}, async () => {
  const db = getDb(),
    user = crypto.randomUUID(),
    other = crypto.randomUUID(),
    chatId = crypto.randomUUID();
  try {
    await db.execute(
      sql`insert into "User" (id,email) values (${user},${`${user}@test.local`}),(${other},${`${other}@test.local`})`
    );
    await appendDesktopSyncChat({
      chatId,
      expected: [],
      messages: [],
      title: "lock",
      userId: user,
    });
    const attempts = await Promise.allSettled([
      acquireDesktopSyncLease({
        chatId,
        expected: [],
        side: "desktop",
        userId: user,
      }),
      acquireDesktopSyncLease({ chatId, side: "web", userId: user }),
    ]);
    assert.equal(
      attempts.filter((item) => item.status === "fulfilled").length,
      1
    );
    const winning = attempts.findIndex((item) => item.status === "fulfilled");
    const selected = attempts[winning];
    assert.ok(selected && selected.status === "fulfilled");
    const side = winning === 0 ? "desktop" : "web";
    await assert.rejects(
      releaseDesktopSyncLease({
        chatId,
        side,
        token: selected.value,
        userId: other,
      }),
      DesktopSyncForbidden
    );
    await releaseDesktopSyncLease({
      chatId,
      side,
      token: selected.value,
      userId: user,
    });
    const lease = await acquireDesktopSyncLease({
      chatId,
      expected: [],
      side: "desktop",
      userId: user,
    });
    await assert.rejects(
      acquireDesktopSyncLease({ chatId, side: "web", userId: user }),
      DesktopSyncConflict
    );
    const final = {
      id: crypto.randomUUID(),
      role: "user" as const,
      text: "完成",
    };
    await assert.rejects(
      appendDesktopSyncChat({
        chatId,
        expected: [],
        messages: [final],
        title: "lock",
        userId: user,
      }),
      DesktopSyncConflict
    );
    await appendDesktopSyncChat({
      chatId,
      expected: [],
      leaseToken: lease,
      messages: [final],
      title: "lock",
      userId: user,
    });
    await appendDesktopSyncChat({
      chatId,
      expected: [],
      leaseToken: lease,
      messages: [final],
      title: "lock",
      userId: user,
    });
    assert.equal((await readDesktopSyncChat(user, chatId))?.activeBy, null);
    await assert.rejects(
      acquireDesktopSyncLease({
        chatId,
        expected: [],
        side: "desktop",
        userId: user,
      }),
      DesktopSyncConflict
    );
  } finally {
    await db.execute(sql`delete from "Message_v2" where "chatId"=${chatId}`);
    await db.execute(sql`delete from "Chat" where id=${chatId}`);
    await db.execute(sql`delete from "User" where id in (${user},${other})`);
  }
});
