import { LocalizedError } from "@/lib/i18n/messages";

/** Chats attached to a persisted project always require sandbox execution. */
export function projectChatExecution(input: {
  projectChat: boolean;
  executionEnabled: boolean;
  sandboxProvider?: string;
}): { requiresExecution: true; reason: "project-sandbox" } | null {
  if (!input.projectChat) {
    return null;
  }
  if (!input.executionEnabled) {
    throw new LocalizedError("runtimeMessages.projectExecutionDisabled");
  }
  if (!["docker", "opensandbox"].includes(input.sandboxProvider ?? "")) {
    throw new LocalizedError("runtimeMessages.projectSandboxRequired");
  }
  return { reason: "project-sandbox", requiresExecution: true };
}
