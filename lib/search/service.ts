import { LocalizedError, translateMessage } from "@/lib/i18n/messages";
import "server-only";
import {
  publicSourceUrl,
  type SearchInput,
  type SearchResponse,
  searchInputSchema,
} from "./protocol";

type SearchEnv = Record<string, string | undefined>;

export type SearchProvider = "tavily" | "deepseek";

export function webSearchEnabled(env: SearchEnv = process.env): boolean {
  return env.PIWORK_WEB_SEARCH_ENABLED === "1";
}

/**
 * 检索 provider 选择（固定单通道，无请求内回退/级联）：
 * 1. `PIWORK_SEARCH_PROVIDER` 显式指定（tavily|deepseek）；
 * 2. 否则按已配置的 key 自动选择：TAVILY_API_KEY → tavily，
 *    DEEPSEEK_API_KEY → deepseek（可经 lib/search/keys.ts 注入插件凭据）。
 * 返回 null = 没有任何可用通道，调用方报 searchUnconfigured。
 */
export function resolveSearchProvider(
  env: SearchEnv = process.env
): SearchProvider | null {
  const explicit = env.PIWORK_SEARCH_PROVIDER?.trim().toLowerCase();
  if (explicit === "tavily" || explicit === "deepseek") {
    return explicit;
  }
  if (env.TAVILY_API_KEY?.trim()) {
    return "tavily";
  }
  if (env.DEEPSEEK_API_KEY?.trim()) {
    return "deepseek";
  }
  return null;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 12_000;
const WINDOW_MS = 60_000;
const shared = globalThis as typeof globalThis & {
  piworkSearchLimits?: {
    active: number;
    users: Map<string, { since: number; calls: number; active: number }>;
  };
};
const limits = shared.piworkSearchLimits ?? { active: 0, users: new Map() };
shared.piworkSearchLimits = limits;

/** Process-local admission only, not a distributed quota/billing ledger.
 * Shared by the Tavily gateway and the sandbox host-tools web search bridge
 * (phase 2) so both paths draw from the same per-user budget. */
export function reserveSearchAdmission(userId: string): () => void {
  const now = Date.now();
  for (const [id, entry] of limits.users) {
    if (!entry.active && now - entry.since >= WINDOW_MS) {
      limits.users.delete(id);
    }
  }
  let entry = limits.users.get(userId);
  if (!entry) {
    if (limits.users.size >= 1000) {
      throw new LocalizedError("runtimeMessages.searchBusy");
    }
    entry = { active: 0, calls: 0, since: now };
    limits.users.set(userId, entry);
  }
  if (now - entry.since >= WINDOW_MS) {
    entry.since = now;
    entry.calls = 0;
  }
  if (entry.calls >= 20 || entry.active >= 2 || limits.active >= 8) {
    throw new LocalizedError("runtimeMessages.searchRateLimit");
  }
  entry.calls += 1;
  entry.active += 1;
  limits.active += 1;
  return () => {
    entry.active -= 1;
    limits.active -= 1;
  };
}

async function boundedJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  if (
    !response.headers.get("content-type")?.includes("application/json") ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("invalid response");
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
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error("oversized response");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function normalize(data: unknown, limit: number): SearchResponse {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { results?: unknown }).results)
  ) {
    throw new Error("invalid results");
  }
  const seen = new Set<string>();
  const results = (data as { results: unknown[] }).results
    .slice(0, 32)
    .flatMap((value) => {
      if (!value || typeof value !== "object") {
        return [];
      }
      const item = value as Record<string, unknown>;
      const url = publicSourceUrl(item.url);
      if (
        !url ||
        seen.has(url) ||
        typeof item.title !== "string" ||
        typeof item.content !== "string"
      ) {
        return [];
      }
      seen.add(url);
      // Preserve only an explicit parseable provider date; never infer it from retrieval time.
      const publishedAt =
        typeof item.published_date === "string" &&
        Number.isFinite(Date.parse(item.published_date))
          ? item.published_date.slice(0, 80)
          : null;
      return [
        {
          publishedAt,
          snippet: item.content.slice(0, 1200),
          title: item.title.slice(0, 250),
          url,
        },
      ];
    })
    .slice(0, limit);
  return { provider: "tavily", results };
}

/** DeepSeek Search API（POST /v1/tools/search）结果 → 平台检索结果。 */
function normalizeDeepseek(data: unknown, limit: number): SearchResponse {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { results?: unknown }).results)
  ) {
    throw new Error("invalid results");
  }
  const seen = new Set<string>();
  const results = (data as { results: unknown[] }).results
    .slice(0, 32)
    .flatMap((value) => {
      if (!value || typeof value !== "object") {
        return [];
      }
      const item = value as Record<string, unknown>;
      const url = publicSourceUrl(item.url);
      if (!url || seen.has(url) || typeof item.title !== "string") {
        return [];
      }
      seen.add(url);
      // summary（600-800 字长摘要）优先于 snippet（100-200 字短摘要）：
      // 该字段是喂给模型的主体内容，对齐 Tavily normalize 的 content 语义。
      const body =
        typeof item.summary === "string" && item.summary.trim()
          ? item.summary
          : typeof item.snippet === "string"
            ? item.snippet
            : "";
      // Preserve only an explicit parseable provider date; never infer it from retrieval time.
      const publishedAt =
        typeof item.date === "string" && Number.isFinite(Date.parse(item.date))
          ? item.date.slice(0, 80)
          : null;
      return [
        {
          publishedAt,
          snippet: body.slice(0, 1200),
          title: item.title.slice(0, 250),
          url,
        },
      ];
    })
    .slice(0, limit);
  return { provider: "deepseek", results };
}

/** Per-turn gateway. Identity is bound by the host, never supplied by the model.
 * Exactly one fixed search provider/endpoint, no retries/fallback or arbitrary fetch.
 */
export function createSearchGateway(options: {
  userId: string;
  authorize: () => Promise<void>;
  fetch?: typeof fetch;
  env?: () => SearchEnv | Promise<SearchEnv>;
  timeoutMs?: number;
}) {
  let calls = 0;
  return async (
    input: SearchInput,
    signal?: AbortSignal
  ): Promise<SearchResponse> => {
    signal?.throwIfAborted();
    const args = searchInputSchema.parse(input);
    const env = (await options.env?.()) ?? process.env;
    if (!webSearchEnabled(env)) {
      throw new LocalizedError("runtimeMessages.searchDisabled");
    }
    const provider = resolveSearchProvider(env);
    if (!provider) {
      throw new LocalizedError("runtimeMessages.searchUnconfigured");
    }
    // Authorization exceptions must block outbound work; do not substitute identities.
    await options.authorize();
    signal?.throwIfAborted();
    if (calls >= 6) {
      throw new LocalizedError("runtimeMessages.searchRoundLimit");
    }
    const release = reserveSearchAdmission(options.userId);
    calls += 1;
    const deadline = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    try {
      const response = await (options.fetch ?? fetch)(
        provider === "deepseek"
          ? "https://api.deepseek.com/v1/tools/search"
          : "https://api.tavily.com/search",
        {
          body: JSON.stringify(
            provider === "deepseek"
              ? {
                  count: args.limit,
                  // 有助于 DeepSeek 侧理解意图；不携带用户身份。
                  ori_question: args.query,
                  query: args.query,
                }
              : {
                  max_results: args.limit,
                  query: args.query,
                  search_depth: "basic",
                  ...(args.recency ? { time_range: args.recency } : {}),
                  include_answer: false,
                  include_images: false,
                  include_published_date: true,
                  include_raw_content: false,
                }
          ),
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${provider === "deepseek" ? env.DEEPSEEK_API_KEY?.trim() : env.TAVILY_API_KEY?.trim()}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: deadline,
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        // Never expose provider bodies, request headers, tokens, or transport URLs.
        throw new Error("provider rejected request");
      }
      const data = await boundedJson(response, deadline);
      return provider === "deepseek"
        ? normalizeDeepseek(data, args.limit)
        : normalize(data, args.limit);
    } catch {
      signal?.throwIfAborted();
      // biome-ignore lint/style/useErrorCause: Transport causes can contain credentials; never retain them in logs or tool results.
      throw new Error(
        deadline.aborted
          ? translateMessage("runtimeMessages.searchTimeout")
          : translateMessage("runtimeMessages.searchUnavailable")
      );
    } finally {
      release();
    }
  };
}
