import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  acquireDesktopSyncLease,
  DesktopSyncConflict,
  DesktopSyncForbidden,
  releaseDesktopSyncLease,
} from "@/lib/db/desktop-sync-queries";
import { getUserRolePolicies } from "@/lib/db/role-policy-queries";

const id = z.uuid();
const msg = z
  .object({
    id,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(100_000),
  })
  .strict();
const input = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("acquire"),
      expected: z.array(msg).max(10_000),
    })
    .strict(),
  z.object({ action: z.literal("release"), token: id }).strict(),
]);
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.PIWORK_DESKTOP_SYNC_ENABLED !== "1") {
    return new Response(null, { status: 503 });
  }
  const { id: chatId } = await params;
  const session = await auth();
  if (
    request.headers.get("x-piwork-desktop") !== "1" ||
    !id.safeParse(chatId).success ||
    session?.user?.type !== "regular"
  ) {
    return new Response(null, { status: 401 });
  }
  try {
    await getUserRolePolicies(session.user.id);
  } catch {
    return new Response(null, { status: 401 });
  }
  const length = Number(request.headers.get("content-length"));
  if (length > 2_000_000) {
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
  const parsed = input.safeParse(body);
  if (!parsed.success) {
    return new Response(null, { status: 400 });
  }
  try {
    if (parsed.data.action === "acquire") {
      const token = await acquireDesktopSyncLease({
        chatId,
        expected: parsed.data.expected,
        side: "desktop",
        userId: session.user.id,
      });
      return Response.json(
        { token },
        { headers: { "cache-control": "no-store" } }
      );
    }
    await releaseDesktopSyncLease({
      chatId,
      side: "desktop",
      token: parsed.data.token,
      userId: session.user.id,
    });
    return Response.json(
      { released: true },
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
