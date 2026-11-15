"use client";

import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { publicSourceUrl } from "@/lib/search/protocol";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Display cap mirroring the desktop sources panel. */
const SOURCES_MAX = 50;

export type DisplaySource = {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
};

/**
 * Aggregate source parts for one assistant message: current `data-web-source`
 * rich cards plus legacy `source-url` parts (rendered without a snippet), both
 * validated through publicSourceUrl and deduped by URL.
 */
export function collectSources(parts: ChatMessage["parts"]): DisplaySource[] {
  const byUrl = new Map<string, DisplaySource>();
  for (const part of parts) {
    if (part.type === "data-web-source") {
      const url = publicSourceUrl(part.data.url);
      if (url && !byUrl.has(url)) {
        byUrl.set(url, {
          publishedAt: part.data.publishedAt,
          snippet: part.data.snippet,
          title: part.data.title || url,
          url,
        });
      }
    } else if (part.type === "source-url") {
      const url = publicSourceUrl(part.url);
      if (url && !byUrl.has(url)) {
        byUrl.set(url, { title: part.title || url, url });
      }
    }
  }
  return [...byUrl.values()].slice(0, SOURCES_MAX);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Deterministic UTC date so server/client rendering never disagree. */
function displayDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toISOString().slice(0, 10)
    : null;
}

function hueOf(host: string): number {
  let hash = 0;
  for (let index = 0; index < host.length; index += 1) {
    hash = (hash * 31 + host.charCodeAt(index)) % 360;
  }
  return hash;
}

function SourceFavicon({
  className,
  host,
}: {
  className?: string;
  host: string;
}) {
  const [failed, setFailed] = useState(false);
  const handleLoadError = useCallback(() => setFailed(true), []);
  if (failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold text-white",
          className
        )}
        style={{ backgroundColor: `hsl(${hueOf(host)} 45% 42%)` }}
      >
        {host.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // Plain <img> on purpose: favicons come from the local /api/favicon
    // proxy, not a configured next/image remote pattern.
    /* biome-ignore lint/performance/noImgElement lint/a11y/noNoninteractiveElementInteractions: authenticated local proxy with a letter-avatar fallback */
    <img
      alt=""
      className={cn(
        "size-4 shrink-0 rounded-[4px] object-cover",
        "ring-1 ring-background",
        className
      )}
      loading="lazy"
      onError={handleLoadError}
      src={`/api/favicon?host=${encodeURIComponent(host)}`}
    />
  );
}

/**
 * Web search sources (inline collapsible, mirroring the desktop app): a chip
 * with stacked favicons + "{count}个来源" under the answer, expanding to a list
 * of favicon + domain + title + snippet entries. Defaults to collapsed, same
 * interaction as the reasoning panel.
 */
export function MessageSources({ parts }: { parts: ChatMessage["parts"] }) {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const toggleOpen = useCallback(() => {
    setOpen((value) => !value);
  }, []);
  const sources = collectSources(parts);
  if (sources.length === 0) {
    return null;
  }

  return (
    <div className="not-prose flex flex-col" data-testid="web-search-sources">
      <button
        aria-expanded={open}
        className="flex w-fit items-center gap-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        data-state={open ? "open" : "closed"}
        onClick={toggleOpen}
        type="button"
      >
        <span className="flex -space-x-1.5">
          {sources.slice(0, 3).map((source) => (
            <SourceFavicon host={hostnameOf(source.url)} key={source.url} />
          ))}
        </span>
        <span className="leading-[1.65]">
          {t("sourceCount", { count: sources.length })}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform",
            open ? "rotate-180" : "rotate-0"
          )}
        />
      </button>
      {open ? (
        <section
          aria-label={t("webSources")}
          className="mt-1.5 rounded-lg border p-2 text-sm"
        >
          <ul className="space-y-0.5">
            {sources.map((source) => {
              const host = hostnameOf(source.url);
              const date = displayDate(source.publishedAt);
              return (
                <li className="min-w-0" key={source.url}>
                  <a
                    className="flex gap-2.5 rounded-md p-2 transition-colors hover:bg-muted/50"
                    href={source.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <SourceFavicon className="mt-0.5" host={host} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                        <span className="truncate">{host}</span>
                        {date ? (
                          <span className="shrink-0 tabular-nums">{date}</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 line-clamp-1 font-medium text-[13px] leading-5 break-words">
                        {source.title}
                      </p>
                      {source.snippet ? (
                        <p className="mt-0.5 line-clamp-2 text-[12px] leading-[18px] break-words text-muted-foreground/80">
                          {source.snippet}
                        </p>
                      ) : null}
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
