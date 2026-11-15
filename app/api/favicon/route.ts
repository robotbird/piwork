import { auth } from "@/app/(auth)/auth";
import { fetchFavicon } from "@/lib/search/favicon";

/**
 * Source card favicon proxy: GET /api/favicon?host=example.com.
 * Requires a signed-in session (same-origin <img> requests carry cookies).
 * The host is validated by publicFaviconHost and the upstream fetch is capped
 * by timeout/size/magic bytes (see lib/search/favicon.ts). Misses return 404;
 * the client falls back to a letter avatar.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return new Response(null, { status: 401 });
  }
  const host = new URL(request.url).searchParams.get("host");
  if (!host) {
    return new Response(null, { status: 400 });
  }
  const favicon = await fetchFavicon(host);
  if (!favicon) {
    return new Response(null, {
      headers: { "Cache-Control": "public, max-age=300" },
      status: 404,
    });
  }
  return new Response(favicon.bytes, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": favicon.contentType,
    },
  });
}
