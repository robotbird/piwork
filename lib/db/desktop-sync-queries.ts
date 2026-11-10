import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { agentRun, chat, desktopSyncState, message } from "./schema";

export type SyncMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
export class DesktopSyncConflict extends Error {}
export class DesktopSyncForbidden extends Error {}

function textOnly(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("");
}
function projectMessage(item: typeof message.$inferSelect): SyncMessage | null {
  if (item.role !== "user" && item.role !== "assistant") {
    return null;
  }
  return { id: item.id, role: item.role, text: textOnly(item.parts) };
}
export async function readDesktopSyncChat(userId: string, chatId: string) {
  const db = getDb();
  const [owner] = await db
    .select()
    .from(chat)
    .where(and(eq(chat.id, chatId), eq(chat.userId, userId)));
  if (!owner) {
    return null;
  }
  const rows = await db
    .select()
    .from(message)
    .where(eq(message.chatId, chatId))
    .orderBy(asc(message.createdAt), asc(message.id));
  const [state] = await db
    .select({ activeBy: desktopSyncState.activeBy })
    .from(desktopSyncState)
    .where(eq(desktopSyncState.chatId, chatId));
  if (!state) {
    return null;
  }
  return {
    activeBy: state.activeBy,
    createdAt: owner.createdAt.toISOString(),
    id: owner.id,
    messages: rows
      .map(projectMessage)
      .filter((item): item is SyncMessage => item !== null),
    title: owner.title,
    updatedAt: owner.updatedAt.toISOString(),
  };
}

/** Append-only compare-and-swap: never overwrite Web messages or an existing ID. */
export function appendDesktopSyncChat(input: {
  userId: string;
  chatId: string;
  title: string;
  expected: SyncMessage[];
  messages: SyncMessage[];
  leaseToken?: string;
}) {
  return getDb().transaction(async (tx) => {
    const created = await tx
      .insert(chat)
      .values({
        createdAt: new Date(),
        id: input.chatId,
        title: input.title,
        userId: input.userId,
        visibility: "private",
      })
      .onConflictDoNothing({ target: chat.id })
      .returning({ id: chat.id });
    const [owner] = await tx
      .select({ id: chat.id, userId: chat.userId })
      .from(chat)
      .where(eq(chat.id, input.chatId))
      .for("update");
    if (!owner || owner.userId !== input.userId) {
      throw new DesktopSyncForbidden();
    }
    if (created.length) {
      await tx.insert(desktopSyncState).values({ chatId: input.chatId });
    }
    const [sync] = await tx
      .select()
      .from(desktopSyncState)
      .where(eq(desktopSyncState.chatId, input.chatId))
      .for("update");
    if (
      !sync ||
      (sync.activeBy !== null &&
        (sync.activeBy !== "desktop" ||
          !input.leaseToken ||
          input.leaseToken !== sync.leaseToken))
    ) {
      throw new DesktopSyncConflict();
    }
    if ((sync.activeBy === null) !== (sync.leaseToken === null)) {
      throw new DesktopSyncConflict();
    }
    const rows = await tx
      .select()
      .from(message)
      .where(eq(message.chatId, input.chatId))
      .orderBy(asc(message.createdAt), asc(message.id))
      .for("update");
    const current = rows
      .map(projectMessage)
      .filter((item): item is SyncMessage => item !== null);
    const { expected } = input;
    if (
      expected.length > current.length ||
      expected.some(
        (item, index) =>
          current[index]?.id !== item.id ||
          current[index]?.role !== item.role ||
          current[index]?.text !== item.text
      )
    ) {
      throw new DesktopSyncConflict();
    }
    const existing = current.slice(expected.length);
    if (
      existing.length > input.messages.length ||
      existing.some(
        (item, index) =>
          item.id !== input.messages[index]?.id ||
          item.role !== input.messages[index]?.role ||
          item.text !== input.messages[index]?.text
      )
    ) {
      throw new DesktopSyncConflict();
    }
    const pending = input.messages.slice(existing.length);
    if (
      new Set([
        ...expected.map((item) => item.id),
        ...input.messages.map((item) => item.id),
      ]).size !==
      expected.length + input.messages.length
    ) {
      throw new DesktopSyncConflict();
    }
    let stamp = Math.max(
      Date.now(),
      (rows.at(-1)?.createdAt.getTime() ?? 0) + 1
    );
    for (const item of pending) {
      const createdAt = new Date(stamp);
      stamp += 1;
      // biome-ignore lint/performance/noAwaitInLoops: preserve ordering and fail on ID collision.
      const inserted = await tx
        .insert(message)
        .values({
          attachments: [],
          chatId: input.chatId,
          createdAt,
          id: item.id,
          parts: [{ text: item.text, type: "text" }],
          role: item.role,
          userId: item.role === "user" ? input.userId : null,
        })
        .onConflictDoNothing({ target: message.id })
        .returning({ id: message.id });
      if (!inserted.length) {
        throw new DesktopSyncConflict();
      }
    }
    if (pending.length) {
      await tx
        .update(chat)
        .set({ updatedAt: sql`now()` })
        .where(eq(chat.id, input.chatId));
    }
    if (sync.activeBy === "desktop" && input.leaseToken === sync.leaseToken) {
      await tx
        .update(desktopSyncState)
        .set({ activeBy: null, leaseToken: null, updatedAt: sql`now()` })
        .where(eq(desktopSyncState.chatId, input.chatId));
    }
    return {
      ids: [
        ...expected.map((item) => item.id),
        ...input.messages.map((item) => item.id),
      ],
    };
  });
}

/** No expiry or automatic takeover: a lost connection leaves the run state unknown. */
export function acquireDesktopSyncLease(input: {
  userId: string;
  chatId: string;
  side: "desktop" | "web";
  expected?: SyncMessage[];
}) {
  return getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ userId: chat.userId })
      .from(chat)
      .where(eq(chat.id, input.chatId))
      .for("update");
    if (!owner || owner.userId !== input.userId) {
      throw new DesktopSyncForbidden();
    }
    const [sync] = await tx
      .select()
      .from(desktopSyncState)
      .where(eq(desktopSyncState.chatId, input.chatId))
      .for("update");
    if (!sync || sync.activeBy || sync.leaseToken) {
      throw new DesktopSyncConflict();
    }
    if (input.side === "desktop") {
      const active = await tx
        .select({ id: agentRun.id })
        .from(agentRun)
        .where(
          and(
            eq(agentRun.chatId, input.chatId),
            inArray(agentRun.status, [
              "queued",
              "starting",
              "running",
              "waiting_user",
            ])
          )
        )
        .limit(1);
      if (active.length) {
        throw new DesktopSyncConflict();
      }
      if (!input.expected) {
        throw new DesktopSyncConflict();
      }
      const rows = await tx
        .select()
        .from(message)
        .where(eq(message.chatId, input.chatId))
        .orderBy(asc(message.createdAt), asc(message.id))
        .for("update");
      const current = rows
        .map(projectMessage)
        .filter((item): item is SyncMessage => item !== null);
      if (
        current.length !== input.expected.length ||
        current.some(
          (item, index) =>
            item.id !== input.expected?.[index]?.id ||
            item.role !== input.expected?.[index]?.role ||
            item.text !== input.expected?.[index]?.text
        )
      ) {
        throw new DesktopSyncConflict();
      }
    }
    const token = randomUUID();
    await tx
      .update(desktopSyncState)
      .set({ activeBy: input.side, leaseToken: token, updatedAt: sql`now()` })
      .where(eq(desktopSyncState.chatId, input.chatId));
    return token;
  });
}
export function releaseDesktopSyncLease(input: {
  userId: string;
  chatId: string;
  token: string;
  side: "desktop" | "web";
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ userId: chat.userId })
      .from(chat)
      .where(eq(chat.id, input.chatId))
      .for("update");
    if (!owner || owner.userId !== input.userId) {
      throw new DesktopSyncForbidden();
    }
    const rows = await tx
      .update(desktopSyncState)
      .set({ activeBy: null, leaseToken: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(desktopSyncState.chatId, input.chatId),
          eq(desktopSyncState.leaseToken, input.token),
          eq(desktopSyncState.activeBy, input.side)
        )
      )
      .returning({ id: desktopSyncState.chatId });
    if (!rows.length) {
      throw new DesktopSyncConflict();
    }
  });
}

/** Called only after the Web route has verified owner/collaborator access. */
export async function acquireWebLeaseIfSynced(
  chatId: string,
  ownerUserId: string
): Promise<string | null> {
  const [state] = await getDb()
    .select({ chatId: desktopSyncState.chatId })
    .from(desktopSyncState)
    .where(eq(desktopSyncState.chatId, chatId));
  if (!state) {
    return null;
  }
  return acquireDesktopSyncLease({ chatId, side: "web", userId: ownerUserId });
}
