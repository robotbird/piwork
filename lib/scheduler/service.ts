import { LocalizedError } from "@/lib/i18n/messages";
import "server-only";
import { createHash } from "node:crypto";
import { createScheduledTaskTool } from "@/lib/ai/scheduled-task-tools";
import { createScheduledTask } from "@/lib/db/scheduled-task-queries";
import type { TaskInput } from "@/lib/scheduler/validation";

/**
 * Message-level idempotency: the task id is derived from
 * (userId, salt, validated input). `salt` is the creating user message id, so
 * re-running the same message with the same parameters returns the original
 * task (the insert conflicts and the existing row is read back); changed
 * parameters may create another task. Shared by the in-process closure tool
 * and the sandbox host-tools bridge.
 */
export async function createTaskForUser(
  userId: string,
  salt: string,
  input: TaskInput
) {
  const hash = createHash("sha256")
    .update(JSON.stringify([userId, salt, input]))
    .digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const task = await createScheduledTask(userId, input, id);
  if (!task) {
    throw new LocalizedError("runtimeMessages.taskCreateFailed");
  }
  return {
    id: task.id,
    nextRunAt: task.nextRunAt,
    schedule: task.schedule,
    title: task.taskType,
    url: "/scheduled-tasks",
  };
}

export function scheduledTaskTools(userId: string, messageId: string) {
  return [
    createScheduledTaskTool((input) =>
      createTaskForUser(userId, messageId, input)
    ),
  ];
}
