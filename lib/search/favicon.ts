import "server-only";

import { publicFaviconHost } from "./protocol";

/**
 * Server-side favicon proxy for source cards: only fetches
 * `https://<host>/favicon.ico` for hosts accepted by publicFaviconHost, with
 * timeout and size caps. Magic-byte sniffing admits raster icon formats only
 * (SVG can embed scripts and is always rejected), and upstream responses are
 * never surfaced as text — only as image/* bytes. Hits and misses (null) are
 * both cached in-process to avoid repeated probing.
 */

const MAX_FAVICON_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;
const CACHE_MAX = 200;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type FaviconResult = {
  bytes: Uint8Array;
  contentType: string;
} | null;

type CacheEntry = FaviconResult;

const shared = globalThis as typeof globalThis & {
  piworkFaviconCache?: Map<string, CacheEntry>;
};
const cache = shared.piworkFaviconCache ?? new Map<string, CacheEntry>();
shared.piworkFaviconCache = cache;

/** Magic-byte sniffing: ico/png/gif/jpeg/webp only; returns the content type. */
function sniffImage(bytes: Uint8Array): string | null {
  const has = (offset: number, ...pattern: number[]) =>
    pattern.every((byte, index) => bytes[offset + index] === byte);
  if (has(0, 0x00, 0x00, 0x01, 0x00)) {
    return "image/x-icon";
  }
  if (has(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (has(0, 0x47, 0x49, 0x46, 0x38)) {
    return "image/gif";
  }
  if (has(0, 0xff, 0xd8, 0xff)) {
    return "image/jpeg";
  }
  if (has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x45, 0x42, 0x50)) {
    return "image/webp";
  }
  return null;
}

async function boundedBytes(
  response: Response,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (!response.body) {
    throw new Error("empty body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      // biome-ignore lint/performance/noAwaitInLoops: Stream reads must be sequential and bounded.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_FAVICON_BYTES) {
        throw new Error("oversized response");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function loadFavicon(
  host: string,
  options: { fetch?: typeof fetch; timeoutMs?: number }
): Promise<FaviconResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(
      `https://${host}/favicon.ico`,
      {
        cache: "no-store",
        headers: { Accept: "image/*", "User-Agent": BROWSER_UA },
        redirect: "follow",
        signal: deadline,
      }
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await boundedBytes(response, deadline);
    const contentType = sniffImage(bytes);
    // Non-icon payloads (HTML/JSON/text) count as a miss; never proxy the raw upstream response.
    return contentType ? { bytes, contentType } : null;
  } catch {
    return null;
  }
}

/** The host must pass publicFaviconHost; results (including misses) are cached in-process. */
export async function fetchFavicon(
  hostInput: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<FaviconResult> {
  const host = publicFaviconHost(hostInput);
  if (!host) {
    return null;
  }
  const cached = cache.get(host);
  if (cached !== undefined) {
    return cached;
  }
  const result = await loadFavicon(host, options);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(host, result);
  return result;
}

/** Test helper: clears the in-process cache. */
export function clearFaviconCache(): void {
  cache.clear();
}
