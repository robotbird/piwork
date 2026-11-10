import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  appendDesktopSyncChat,
  DesktopSyncConflict,
  DesktopSyncForbidden,
  readDesktopSyncChat,
} from "@/lib/db/desktop-sync-queries";
import { getUserRolePolicies } from "@/lib/db/role-policy-queries";

const idSchema = z.uuid();
const syncMessage = z
  .object({
    id: idSchema,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(100_000),
  })
  .strict();
const payload = z
  .object({
    expected: z.array(syncMessage).max(10_000),
    leaseToken: idSchema.optional(),
    messages: z.array(syncMessage).max(1000),
    title: z.string().trim().min(1).max(100),
  })
  .strict();
async function identity(request: Request, id: string) {
  if (
    request.headers.get("x-piwork-desktop") !== "1" ||
    !idSchema.safeParse(id).success
  ) {
    return null;
  }
  const session = await auth();
  if (session?.user?.type !== "regular") {
    return null;
  }
  try {
    await getUserRolePolicies(session.user.id);
    return session.user.id;
  } catch {
    return null;
  }
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.PIWORK_DESKTOP_SYNC_ENABLED !== "1") {
    return new Response(null, { status: 503 });
  }
  const { id } = await params;
  const userId = await identity(request, id);
  if (!userId) {
    return new Response(null, { status: 401 });
  }
  const result = await readDesktopSyncChat(userId, id);
  return result
    ? Response.json(result, { headers: { "cache-control": "no-store" } })
    : new Response(null, { status: 404 });
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.PIWORK_DESKTOP_SYNC_ENABLED !== "1") {
    return new Response(null, { status: 503 });
  }
  const { id } = await params;
  const userId = await identity(request, id);
  if (!userId) {
    return new Response(null, { status: 401 });
  }
  if (Number(request.headers.get("content-length")) > 2_000_000) {
    return new Response(null, { status: 413 });
  }
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      return new Response(null, { status: 400 });
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: enforce the request size while streaming.
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(part.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = payload.safeParse(body);
  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }
  try {
    return Response.json(
      await appendDesktopSyncChat({ chatId: id, userId, ...parsed.data }),
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof DesktopSyncConflict) {
      return new Response(null, { status: 409 });
    }
    if (error instanceof DesktopSyncForbidden) {
      return new Response(null, { status: 403 });
    }
    throw error;
  }
}
