import { z } from "zod";

// Platform-owned names deliberately do not collide with pi-web-access/web_search.
export const WEB_SEARCH_TOOL = "platform_web_search";
/** pi-web-access plugin tool whose text output carries search result regions. */
export const PI_WEB_ACCESS_SEARCH_TOOL = "web_search";
export const searchInputSchema = z
  .object({
    limit: z.number().int().min(1).max(8).default(5),
    query: z.string().trim().min(1).max(500),
    recency: z.enum(["day", "week", "month", "year"]).optional(),
  })
  .strict();
export type SearchInput = z.input<typeof searchInputSchema>;
export type SearchSource = {
  title: string;
  url: string;
  publishedAt: string | null;
  /** Bounded display snippet projected to the UI; never fed back to the model. */
  snippet: string;
};
export type SearchResult = SearchSource & { snippet: string };
export type SearchResponse = {
  provider: "tavily" | "deepseek";
  results: SearchResult[];
};

/** Rich source metadata carried by the `data-web-source` UI message part. */
export type WebSourceData = {
  publishedAt?: string;
  snippet?: string;
  sourceId: string;
  title: string;
  url: string;
};

/** Favicon fetch bound for a display-only public host, served by /api/favicon. */
export function publicFaviconHost(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  // Reuse the conservative display URL rules by wrapping the bare host.
  const href = publicSourceUrl(`https://${value.replace(/^\/+/, "")}`);
  if (!href) {
    return;
  }
  return new URL(href).hostname.toLowerCase();
}

/** Display-only URL validation. We never fetch these URLs on the host.
 * Conservative: IP literals, custom ports and local/special-use names are omitted.
 * This is NOT an SSRF-safe fetch implementation or DNS validation.
 */
export function publicSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      !host.includes(".") ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(
        host
      ) ||
      host === "metadata.google.internal"
    ) {
      return;
    }
    return url.href;
  } catch {
    // Invalid URLs are omitted rather than surfaced as source links.
  }
}

/** Project only bounded source metadata from successful platform tool results.
 *
 * Two producers are recognized:
 * - `platform_web_search` (piwork): the bounded `details.sources` projection.
 * - pi-web-access `web_search`: the plugin's `structuredContent` results
 *   (title/url/snippet) first, with the result-text regions parsed by
 *   extractSearchSources as fallback; anything else is dropped.
 */
export function searchSources(
  toolName: string,
  result: unknown
): SearchSource[] {
  if (toolName === PI_WEB_ACCESS_SEARCH_TOOL) {
    return pluginSearchSources(result);
  }
  if (toolName !== WEB_SEARCH_TOOL || !result || typeof result !== "object") {
    return [];
  }
  const { details } = result as { details?: { sources?: unknown } };
  if (!Array.isArray(details?.sources)) {
    return [];
  }
  const seen = new Set<string>();
  return details.sources.slice(0, 8).flatMap((source: unknown) => {
    if (!source || typeof source !== "object") {
      return [];
    }
    const record = source as Record<string, unknown>;
    const url = publicSourceUrl(record.url);
    if (!url || seen.has(url) || typeof record.title !== "string") {
      return [];
    }
    seen.add(url);
    return [
      {
        publishedAt:
          typeof record.publishedAt === "string"
            ? record.publishedAt.slice(0, 80)
            : null,
        // Display-only excerpt for the sources panel; bounded like every field.
        snippet:
          typeof record.snippet === "string"
            ? record.snippet.slice(0, 300)
            : "",
        title: record.title.slice(0, 250),
        url,
      },
    ];
  });
}

/** Join the text blocks of a Pi tool result (or pass through a plain string). */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const { content } = result as { content?: unknown };
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block: unknown) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return [(block as { text: string }).text];
      }
      return [];
    })
    .join("\n");
}

/** Bounded extraction from pi-web-access result text regions.
 * Supports both textual presentations the plugin emits:
 * - inline search summary: `N. title\n   <url>` numbered list
 * - stored full results: `### title\n<url>` heading regions
 */
export function extractSearchSources(text: string): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  const push = (titleRaw: string | undefined, urlRaw: string | undefined) => {
    const title = titleRaw?.trim().slice(0, 250);
    const url = publicSourceUrl(urlRaw ?? "");
    if (!title || !url || seen.has(url)) {
      return;
    }
    seen.add(url);
    sources.push({ publishedAt: null, snippet: "", title, url });
  };
  for (const match of text.matchAll(
    /^\d+\. (.+)$\n^[ \t]+(https?:\/\/\S+)$/gm
  )) {
    push(match[1], match[2]);
    if (sources.length >= 8) {
      return sources;
    }
  }
  for (const match of text.matchAll(/^### (.+)$\n^(https?:\/\/\S+)$/gm)) {
    push(match[1], match[2]);
    if (sources.length >= 8) {
      break;
    }
  }
  return sources;
}

type PluginStructuredContent = {
  structuredContent?: {
    queries?: Array<{
      results?: Array<{
        title?: unknown;
        url?: unknown;
        snippet?: unknown;
      }>;
    }>;
  };
};

/** pi-web-access web_search: structured results first, text regions as fallback. */
function pluginSearchSources(result: unknown): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  if (result && typeof result === "object") {
    const queries = (result as PluginStructuredContent).structuredContent
      ?.queries;
    if (Array.isArray(queries)) {
      for (const query of queries) {
        for (const item of Array.isArray(query?.results)
          ? (query.results as Array<Record<string, unknown>>)
          : []) {
          const url = publicSourceUrl(item.url);
          const title =
            typeof item.title === "string"
              ? item.title.trim().slice(0, 250)
              : "";
          if (!url || !title || seen.has(url)) {
            continue;
          }
          seen.add(url);
          sources.push({
            publishedAt: null,
            snippet:
              typeof item.snippet === "string"
                ? item.snippet.slice(0, 300)
                : "",
            title,
            url,
          });
          if (sources.length >= 8) {
            return sources;
          }
        }
      }
    }
  }
  if (sources.length === 0) {
    return extractSearchSources(toolResultText(result));
  }
  return sources;
}
