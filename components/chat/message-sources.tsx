"use client";

import { ChevronRightIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  createContext,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { publicSourceUrl } from "@/lib/search/protocol";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Display cap mirroring the desktop sources panel. */
const SOURCES_MAX = 50;
const PANEL_ID = "chat-sources-panel";
const PANEL_TITLE_ID = "chat-sources-title";

export const MessageSourcesContext = createContext<{
  activeMessageId: string | undefined;
  toggleSources: (messageId: string, trigger: HTMLButtonElement) => void;
} | null>(null);

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
          "flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-1 ring-background",
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
        "size-4 shrink-0 rounded-full object-cover",
        "ring-1 ring-background",
        className
      )}
      loading="lazy"
      onError={handleLoadError}
      src={`/api/favicon?host=${encodeURIComponent(host)}`}
    />
  );
}

export function MessageSources({ message }: { message: ChatMessage }) {
  const t = useTranslations("chat");
  const context = useContext(MessageSourcesContext);
  const toggleSources = context?.toggleSources;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      toggleSources?.(message.id, event.currentTarget);
    },
    [message.id, toggleSources]
  );
  const sources = collectSources(message.parts);
  if (!context || sources.length === 0) {
    return null;
  }
  const open = context.activeMessageId === message.id;

  return (
    <div className="not-prose" data-testid="web-search-sources">
      <Button
        aria-controls={open ? PANEL_ID : undefined}
        aria-expanded={open}
        className="rounded-full focus-visible:ring-2 focus-visible:ring-ring"
        onClick={handleClick}
        size="sm"
        type="button"
        variant={open ? "secondary" : "outline"}
      >
        <span aria-hidden="true" className="flex">
          {sources.slice(0, 3).map((source) => (
            <SourceFavicon
              className="not-first:-ml-1"
              host={hostnameOf(source.url)}
              key={source.url}
            />
          ))}
        </span>
        {t("sourceCount", { count: sources.length })}
        <ChevronRightIcon aria-hidden="true" data-icon="inline-end" />
      </Button>
    </div>
  );
}

function SourceList({ sources }: { sources: DisplaySource[] }) {
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-3 py-2">
      {sources.map((source) => {
        const host = hostnameOf(source.url);
        const date = displayDate(source.publishedAt);
        return (
          <li className="min-w-0 shrink-0" key={source.url}>
            <a
              className="flex flex-col gap-1 rounded-lg px-3 py-3 transition-colors hover:bg-muted focus-visible:bg-muted"
              href={source.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <SourceFavicon host={host} />
                <span className="truncate">{host}</span>
                {date ? (
                  <time className="shrink-0 tabular-nums" dateTime={date}>
                    {date}
                  </time>
                ) : null}
              </div>
              <p
                className="truncate font-semibold text-sm"
                title={source.title}
              >
                {source.title}
              </p>
              {source.snippet ? (
                <p className="line-clamp-2 wrap-break-word text-muted-foreground text-sm">
                  {source.snippet}
                </p>
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function MessageSourcesPanel({
  messageId,
  onClose,
  overlay,
  sources,
  trigger,
}: {
  messageId: string;
  onClose: () => void;
  overlay: boolean;
  sources: DisplaySource[];
  trigger: HTMLButtonElement;
}) {
  const t = useTranslations("chat");
  const common = useTranslations("common");
  const closeButton = useRef<HTMLButtonElement>(null);
  const dockedPanel = useRef<HTMLElement>(null);
  const title = t("webSourcesTitle", { count: sources.length });

  const closePanel = useCallback(() => {
    onClose();
    trigger.focus({ preventScroll: true });
  }, [onClose, trigger]);

  useEffect(() => {
    const panel = dockedPanel.current;
    if (overlay || !panel) {
      return;
    }
    closeButton.current?.focus({ preventScroll: true });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    panel.addEventListener("keydown", handleEscape);
    return () => panel.removeEventListener("keydown", handleEscape);
  }, [closePanel, overlay]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );
  const restoreSheetFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (
        trigger.isConnected &&
        trigger.getAttribute("aria-expanded") === "false"
      ) {
        trigger.focus({ preventScroll: true });
      }
    },
    [trigger]
  );

  if (overlay) {
    return (
      <Sheet onOpenChange={handleOpenChange} open>
        <SheetContent
          aria-describedby={undefined}
          data-testid="web-search-sources-panel"
          id={PANEL_ID}
          onCloseAutoFocus={restoreSheetFocus}
          showCloseButton={false}
          side="right"
        >
          <SheetHeader className="h-14 flex-row items-center justify-between gap-2 border-b px-5 py-0">
            <SheetTitle>{title}</SheetTitle>
            <SheetClose asChild>
              <Button
                aria-label={common("close")}
                className="focus-visible:ring-2 focus-visible:ring-ring"
                size="icon"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetHeader>
          <SourceList key={messageId} sources={sources} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-labelledby={PANEL_TITLE_ID}
      className="flex min-h-0 w-[clamp(300px,30vw,420px)] shrink-0 flex-col border-l bg-background motion-safe:slide-in-from-right-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      data-testid="web-search-sources-panel"
      id={PANEL_ID}
      ref={dockedPanel}
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-5">
        <h2 className="font-semibold text-base" id={PANEL_TITLE_ID}>
          {title}
        </h2>
        <Button
          aria-label={common("close")}
          className="focus-visible:ring-2 focus-visible:ring-ring"
          onClick={closePanel}
          ref={closeButton}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      <SourceList key={messageId} sources={sources} />
    </aside>
  );
}
