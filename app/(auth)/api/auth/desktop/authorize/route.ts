import { auth } from "@/app/(auth)/auth";
import {
  DESKTOP_CALLBACK,
  desktopSecretPattern,
} from "@/lib/auth/desktop-login";
import { createDesktopLoginGrant } from "@/lib/db/desktop-login-queries";
import { getMemberByUserId } from "@/lib/db/organization-queries";

export async function POST(request: Request) {
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return new Response(null, { headers, status: 403 });
  }
  const session = await auth();
  if (session?.user?.type !== "regular") {
    return new Response(null, { headers, status: 401 });
  }
  const member = await getMemberByUserId(session.user.id);
  if (member?.status === "disabled") {
    return new Response(null, { headers, status: 403 });
  }
  if (Number(request.headers.get("content-length")) > 2048) {
    return new Response(null, { headers, status: 413 });
  }
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.state !== "string" ||
    typeof body.challenge !== "string" ||
    !desktopSecretPattern.test(body.state) ||
    !desktopSecretPattern.test(body.challenge)
  ) {
    return new Response(null, { headers, status: 400 });
  }
  const code = await createDesktopLoginGrant(session.user.id, body.challenge);
  const callback = new URL(DESKTOP_CALLBACK);
  callback.search = new URLSearchParams({ code, state: body.state }).toString();
  return Response.json({ callback: callback.href }, { headers });
}
