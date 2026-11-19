// Scheduled runs have historically stored this prefix in Chat.title.
export const SCHEDULED_CHAT_TITLE_PREFIX = "[任务] ";

export function formatChatTitle(
  title: string,
  translate: (
    key: "chat.scheduledTaskTitle",
    values: { name: string }
  ) => string
): string {
  if (!title.startsWith(SCHEDULED_CHAT_TITLE_PREFIX)) {
    return title;
  }

  return translate("chat.scheduledTaskTitle", {
    name: title.slice(SCHEDULED_CHAT_TITLE_PREFIX.length),
  });
}
