import { encode } from "next-auth/jwt";
import { desktopSecretPattern } from "@/lib/auth/desktop-login";
import { consumeDesktopLoginGrant } from "@/lib/db/desktop-login-queries";
import { getMemberByUserId } from "@/lib/db/organization-queries";
import { getUserById } from "@/lib/db/queries";

export async function POST(request: Request) {
  const headers = { "cache-control": "no-store" };
  if (Number(request.headers.get("content-length")) > 2048) {
    return new Response(null, { headers, status: 413 });
  }
  const body = await request.json().catch(() => null);
  if (
    !body ||
    typeof body.code !== "string" ||
    typeof body.verifier !== "string" ||
    !desktopSecretPattern.test(body.code) ||
    !desktopSecretPattern.test(body.verifier)
  ) {
    return new Response(null, { headers, status: 400 });
  }
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return new Response(null, { headers, status: 503 });
  }
  const userId = await consumeDesktopLoginGrant(body.code, body.verifier);
  if (!userId) {
    return new Response(null, { headers, status: 401 });
  }
  const user = await getUserById(userId);
  const member = await getMemberByUserId(userId);
  if (!user || user.isAnonymous || member?.status === "disabled") {
    return new Response(null, { headers, status: 403 });
  }
  const secure = new URL(request.url).protocol === "https:";
  const name = `${secure ? "__Secure-" : ""}authjs.session-token`;
  const maxAge = 30 * 24 * 60 * 60;
  const value = await encode({
    maxAge,
    salt: name,
    secret,
    token: {
      email: user.email,
      id: user.id,
      name: user.name,
      sub: user.id,
      type: "regular",
    },
  });
  return Response.json(
    { expires: Math.floor(Date.now() / 1000) + maxAge, name, value },
    { headers }
  );
}
