"use client";

import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatThinkingDuration } from "@/lib/chat/reasoning-duration";
import { cn } from "@/lib/utils";
import { Shimmer } from "../ai-elements/shimmer";
import { useDataStream } from "./data-stream-provider";

/** DB 落库的 reasoning part（durationMs 为服务端按事件时刻推导的每步耗时） */
export type ReasoningPartWithTiming = {
  type: "reasoning";
  text: string;
  state: "streaming" | "done";
  durationMs?: number;
};

type ReasoningStep = {
  text: string;
  isStreaming: boolean;
  /** 起止时刻（优先服务端 at，缺席时回退本地首见/完成时刻）；未知为 undefined */
  startedAt: number | undefined;
  endedAt: number | undefined;
  /** 展示用每步耗时：落库 durationMs ?? (end - start) */
  durationMs: number | undefined;
  /** 流式中的步骤已流出时长 */
  elapsedMs: number | undefined;
};

/** 流式计时的刷新间隔 */
const LIVE_TICK_MS = 200;

/**
 * 思考过程面板（Codex 风格）：默认折叠，头部展示总用时（思考中实时跳动），
 * 展开后按步骤列出思考内容与每步耗时。耗时来源优先级：落库 durationMs →
 * wire 下发的服务端起止时刻（data-reasoning-timing，重放不失真）→ 本地
 * 首见/完成时刻兜底。
 */
export function MessageReasoning({
  parts,
}: {
  parts: ReasoningPartWithTiming[];
}) {
  const t = useTranslations("reasoning");
  const [open, setOpen] = useState(false);
  const { reasoningTimings } = useDataStream();

  const isThinking = parts.some((part) => part.state === "streaming");

  const [now, setNow] = useState(() => Date.now());
  const toggleOpen = useCallback(() => {
    setOpen((value) => !value);
  }, []);
  useEffect(() => {
    if (!isThinking) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [isThinking]);

  // 本地兜底时刻：服务端 timing 缺席时按渲染观察时刻估算（正常流仅作最后
  // 回退）。完成时刻只在亲历"streaming → done"转换时记录——历史消息挂载时
  // 已是 done，凭空记录会把耗时算成 0
  const firstSeenAtRef = useRef<number[]>([]);
  const doneAtRef = useRef<number[]>([]);
  const observedStreamingRef = useRef<boolean[]>([]);

  const steps = useMemo<ReasoningStep[]>(() => {
    // 本 run 的 reasoning start 时刻按到达顺序与 parts 一一对应（同一时刻
    // 只有一条流在写这条消息），取最近的 N 个；end 按 id 配对
    const starts = reasoningTimings
      .filter((timing) => timing.phase === "start")
      .slice(-parts.length);
    const endedAtById = new Map(
      reasoningTimings
        .filter((timing) => timing.phase === "end")
        .map((timing) => [timing.id, timing.at] as const)
    );

    return parts.map((part, index) => {
      if (firstSeenAtRef.current[index] === undefined) {
        firstSeenAtRef.current[index] = Date.now();
      }
      if (part.state === "streaming") {
        observedStreamingRef.current[index] = true;
      } else if (
        observedStreamingRef.current[index] === true &&
        doneAtRef.current[index] === undefined
      ) {
        doneAtRef.current[index] = Date.now();
      }
      const serverStart = starts[index]?.at;
      const serverEnd =
        serverStart === undefined
          ? undefined
          : endedAtById.get(starts[index].id);
      // 本地首见时刻只在亲历过流式时才可信；历史消息（挂载即 done）无据可依
      const startedAt =
        serverStart ??
        (observedStreamingRef.current[index] === true
          ? firstSeenAtRef.current[index]
          : undefined);
      const endedAt =
        serverEnd ??
        (part.state === "done" ? doneAtRef.current[index] : undefined);
      return {
        durationMs:
          part.durationMs ??
          (startedAt !== undefined && endedAt !== undefined
            ? Math.max(0, endedAt - startedAt)
            : undefined),
        elapsedMs:
          part.state === "streaming" && startedAt !== undefined
            ? Math.max(0, now - startedAt)
            : undefined,
        endedAt,
        isStreaming: part.state === "streaming",
        startedAt,
        text: part.text,
      };
    });
  }, [parts, reasoningTimings, now]);

  const timestamped = steps.filter((step) => step.startedAt !== undefined);
  const firstStart = timestamped[0]?.startedAt;
  // 结束时刻取最后一个已知活动（末步未结束时用其 start），保证 total ≥ 0
  const lastActivity =
    timestamped.length > 0
      ? (timestamped.at(-1)?.endedAt ?? timestamped.at(-1)?.startedAt)
      : undefined;
  const sumDurations = steps.reduce(
    (sum, step) => sum + (step.durationMs ?? 0),
    0
  );
  const anyDuration = steps.some((step) => step.durationMs !== undefined);

  // 有起止时刻时总用时按墙钟（首步 start → 末步 end，思考中实时跳动）；
  // 否则（纯 DB 回放）退化为各步耗时之和
  const totalMs =
    firstStart === undefined
      ? anyDuration
        ? sumDurations
        : undefined
      : Math.max(0, (isThinking ? now : (lastActivity ?? now)) - firstStart);

  return (
    <div className="not-prose flex flex-col" data-testid="message-reasoning">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        data-state={open ? "open" : "closed"}
        onClick={toggleOpen}
        type="button"
      >
        {isThinking ? (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/50" />
        ) : null}
        <span className="leading-[1.65]">
          {isThinking
            ? totalMs === undefined
              ? t("thinking")
              : t("thinkingWithDuration", {
                  duration: formatThinkingDuration(totalMs),
                })
            : totalMs === undefined
              ? t("thoughtBriefly")
              : t("thoughtForDuration", {
                  duration: formatThinkingDuration(totalMs),
                })}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform",
            open ? "rotate-180" : "rotate-0"
          )}
        />
      </button>
      {open ? (
        <div className="mt-1.5 max-h-72 overflow-y-auto border-t border-border/60 pt-2 [scrollbar-width:none]">
          <ol aria-label={t("stepsLabel")} className="flex flex-col">
            {steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 步骤只追加不重排，part 无稳定 id，顺序即标识
              <li className="flex gap-2.5 py-1" key={index}>
                <span
                  className={cn(
                    "mt-[7px] size-1.5 shrink-0 rounded-full",
                    step.isStreaming
                      ? "animate-pulse bg-muted-foreground/70"
                      : "bg-muted-foreground/30"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] tabular-nums text-muted-foreground/60">
                    {step.isStreaming
                      ? step.elapsedMs === undefined
                        ? "…"
                        : formatThinkingDuration(step.elapsedMs)
                      : step.durationMs === undefined
                        ? ""
                        : formatThinkingDuration(step.durationMs)}
                  </span>
                  {step.text ? (
                    <p className="mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap text-muted-foreground/80">
                      {step.text}
                    </p>
                  ) : step.isStreaming ? (
                    <Shimmer
                      as="span"
                      className="text-[13px] font-medium"
                      duration={1}
                    >
                      {t("thinking")}
                    </Shimmer>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
