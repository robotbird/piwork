import { LocalizedError, translateMessage } from "@/lib/i18n/messages";
import type { RunHandle } from "@/lib/runtime/run/run-manager";

/**
 * Scheduled tasks run multi-turn agent work (model calls + sandbox tools),
 * which routinely takes longer than interactive chat. Default budget is
 * 15 minutes; override with PIWORK_SCHEDULED_TASK_TIMEOUT_MS (milliseconds).
 */
const DEFAULT_TASK_TIMEOUT_MS = 900_000;

export function scheduledTaskTimeoutMs(): number {
  const raw = Number.parseInt(
    process.env.PIWORK_SCHEDULED_TASK_TIMEOUT_MS ?? "",
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASK_TIMEOUT_MS;
}

export async function waitForTaskCompletion(
  handle: RunHandle,
  timeoutMs = scheduledTaskTimeoutMs()
) {
  const subscription = handle.attach();
  if (!subscription) {
    throw new LocalizedError("runtimeMessages.subscriptionFailed");
  }
  // The scheduler only needs the completion promise, not an unbounded event queue.
  subscription.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      subscription.settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LocalizedError("runtimeMessages.taskTimeout")),
          timeoutMs
        );
      }),
    ]);
    if (outcome !== "settled") {
      throw new Error(
        outcome === "aborted"
          ? translateMessage("runtimeMessages.taskStopped")
          : translateMessage("runtimeMessages.taskFailed")
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
