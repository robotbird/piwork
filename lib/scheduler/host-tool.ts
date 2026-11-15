import "server-only";

import { ZodError } from "zod";
import { LocalizedError, translateMessage } from "@/lib/i18n/messages";
import {
  type HostTool,
  HostToolsError,
} from "@/lib/runtime/inference-proxy/host-tools";
import { createTaskForUser } from "@/lib/scheduler/service";
import { taskInputSchema } from "@/lib/scheduler/validation";

export const CREATE_SCHEDULED_TASK_TOOL_NAME = "create_scheduled_task";

/**
 * Host-side implementation of the sandbox-host-tools bridge for
 * create_scheduled_task. Identity comes exclusively from the token grant
 * (initiator bound by RunManager); the request body carries tool input only.
 * Validation (cron/timezone/lengths) stays on the host via taskInputSchema —
 * the sandbox-side JSON Schema is a UX hint, not the security boundary.
 */
export function createScheduledTaskHostTool(
  createTask: typeof createTaskForUser = createTaskForUser
): HostTool {
  return async ({ hostTools, input, signal }) => {
    let parsed: ReturnType<typeof taskInputSchema.parse>;
    try {
      parsed = taskInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        // biome-ignore lint/style/useErrorCause: HostToolsError forwards {cause} to super
        throw new HostToolsError(
          "invalid_input",
          translateMessage("api.taskInputInvalid"),
          { cause: error }
        );
      }
      throw error;
    }
    // Cancellation checkpoint before the durable write: after the insert
    // commits, a dropped connection is recovered by the same-parameters retry
    // reading the original task back (message-level idempotency).
    if (signal.aborted) {
      throw new HostToolsError("aborted", "request cancelled before execution");
    }
    try {
      const task = await createTask(
        hostTools.userId,
        hostTools.idempotencyKey,
        parsed
      );
      return { content: [{ text: JSON.stringify(task), type: "text" }] };
    } catch (error) {
      if (error instanceof LocalizedError) {
        // biome-ignore lint/style/useErrorCause: HostToolsError forwards {cause} to super
        throw new HostToolsError(
          "task_failed",
          translateMessage(error.messageKey, error.params),
          { cause: error }
        );
      }
      throw error;
    }
  };
}
