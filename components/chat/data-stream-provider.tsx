"use client";

import type { DataUIPart } from "ai";
import type React from "react";
import { createContext, useContext, useMemo, useState } from "react";
import type {
  CustomUIDataTypes,
  ReasoningTimingData,
  ToolStatusData,
  WaitingStatusData,
} from "@/lib/types";

type DataStreamContextValue = {
  dataStream: DataUIPart<CustomUIDataTypes>[];
  setDataStream: React.Dispatch<
    React.SetStateAction<DataUIPart<CustomUIDataTypes>[]>
  >;
  waitingStatus: WaitingStatusData | undefined;
  setWaitingStatus: React.Dispatch<
    React.SetStateAction<WaitingStatusData | undefined>
  >;
  toolStatus: ToolStatusData | undefined;
  setToolStatus: React.Dispatch<
    React.SetStateAction<ToolStatusData | undefined>
  >;
  /**
   * 本次 run 的 reasoning 块服务端起止时刻（按 wire 到达顺序）。
   * 只留最近一批（截断防无限增长）；新一轮 submitted 时清空。
   */
  reasoningTimings: ReasoningTimingData[];
  setReasoningTimings: React.Dispatch<
    React.SetStateAction<ReasoningTimingData[]>
  >;
};

const DataStreamContext = createContext<DataStreamContextValue | null>(null);

/** 单个 run 的 reasoning 块数上界（超界截断旧值即可，展示只取最近 N 个） */
const MAX_REASONING_TIMINGS = 200;

export function DataStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [dataStream, setDataStream] = useState<DataUIPart<CustomUIDataTypes>[]>(
    []
  );
  const [waitingStatus, setWaitingStatus] = useState<WaitingStatusData>();
  const [toolStatus, setToolStatus] = useState<ToolStatusData>();
  const [reasoningTimings, setReasoningTimings] = useState<
    ReasoningTimingData[]
  >([]);

  const value = useMemo(
    () => ({
      dataStream,
      reasoningTimings,
      setDataStream,
      setReasoningTimings,
      setToolStatus,
      setWaitingStatus,
      toolStatus,
      waitingStatus,
    }),
    [dataStream, toolStatus, waitingStatus, reasoningTimings]
  );

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function useDataStream() {
  const context = useContext(DataStreamContext);
  if (!context) {
    throw new Error("useDataStream must be used within a DataStreamProvider");
  }
  return context;
}

/** 追加一条 reasoning 起止时刻，按上界截断（供 onData 消费 transient chunk） */
export function appendReasoningTiming(
  timings: ReasoningTimingData[],
  timing: ReasoningTimingData
): ReasoningTimingData[] {
  return [...timings.slice(-(MAX_REASONING_TIMINGS - 1)), timing];
}
