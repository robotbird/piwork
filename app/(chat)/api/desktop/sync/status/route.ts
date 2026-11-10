import { auth } from "@/app/(auth)/auth";
import { getUserRolePolicies } from "@/lib/db/role-policy-queries";
export async function GET(request: Request) {
  if (process.env.PIWORK_DESKTOP_SYNC_ENABLED !== "1") {
    return new Response(null, { status: 503 });
  }
  const session = await auth();
  if (
    request.headers.get("x-piwork-desktop") !== "1" ||
    session?.user?.type !== "regular"
  ) {
    return new Response(null, { status: 401 });
  }
  try {
    await getUserRolePolicies(session.user.id);
  } catch {
    return new Response(null, { status: 401 });
  }
  return Response.json(
    { enabled: true },
    { headers: { "cache-control": "no-store" } }
  );
}
