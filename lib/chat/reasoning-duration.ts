/**
 * 思考耗时展示格式（Codex 风格紧凑单位，中英文通用）：
 * <10s 一位小数（"3.2s"），<60s 取整（"13s"），更久走分秒（"2m 5s"）。
 * 流式计时与落库 durationMs 共用，保证同一轮展示口径一致。
 */
export function formatThinkingDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 10_000) {
    return `${(clamped / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(clamped / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}
