import { LocalizedError, translateMessage } from "@/lib/i18n/messages";
import "server-only";
import { getPreferredModelId } from "@/lib/ai/active-models";
import {
  buildExecutionSystemPrompt,
  ensureChatWorkspace,
  executionToolsEnabled,
} from "@/lib/ai/agent-tools";
import { loadEnabledManagedProjectSkills } from "@/lib/ai/managed-skills";
import { getPiModel } from "@/lib/ai/pi";
import { regularPrompt } from "@/lib/ai/prompts";
import { getUserModelCatalog } from "@/lib/ai/role-access";
import { buildSkillsSystemPrompt, createSkillTools } from "@/lib/ai/skills";
import { SCHEDULED_CHAT_TITLE_PREFIX } from "@/lib/chat/title";
import {
  publishChatMessage,
  publishChatRun,
} from "@/lib/collab/chat-event-hub";
import { saveChat, saveMessages } from "@/lib/db/queries";
import {
  finishScheduledTask,
  linkTaskChat,
} from "@/lib/db/scheduled-task-queries";
import type { ScheduledTaskRecord } from "@/lib/db/schema";
import { syncManagedAgentMcpConfig } from "@/lib/mcp/agent-config";
import { willRunSandbox } from "@/lib/runtime/backends/routing/backend";
import { getRunManager } from "@/lib/runtime/run";
import {
  createWebSearchBridgeTool,
  webAccessPrompt,
} from "@/lib/web-access/host-tool";
import { getWebAccessService } from "@/lib/web-access/mcp-host";
import { waitForTaskCompletion } from "./completion";

/** Accept only atomically claimed tasks. The scheduler never implements an agent loop. */
export async function executeScheduledTask(task: ScheduledTaskRecord) {
  if (!task.leaseToken) {
    throw new Error("Task must be claimed before execution");
  }
  const chatId = crypto.randomUUID();
  let errorMessage: string | null = null;
  const manager = getRunManager();
  try {
    const modelId = getPreferredModelId(await getUserModelCatalog(task.userId));
    if (!modelId) {
      throw new LocalizedError("runtimeMessages.modelRequired");
    }
    const model = await getPiModel(modelId);
    const workspaceDir = executionToolsEnabled()
      ? await ensureChatWorkspace(chatId)
      : null;
    // MCP 服务配置同步不依赖工作区；失败仅记日志，不阻断任务执行
    await syncManagedAgentMcpConfig().catch((error) => {
      console.warn("Failed to sync managed agent mcp.json:", error);
    });
    const { skills } = await loadEnabledManagedProjectSkills();
    await saveChat({
      id: chatId,
      title: `${SCHEDULED_CHAT_TITLE_PREFIX}${task.taskType}`,
      userId: task.userId,
      visibility: "private",
    });
    await linkTaskChat(task, chatId);
    await saveMessages({
      messages: [
        {
          attachments: [],
          chatId,
          createdAt: new Date(),
          id: crypto.randomUUID(),
          parts: [{ text: task.prompt, type: "text" }],
          role: "user",
          userId: task.userId,
        },
      ],
    });
    // 协作实时：定时任务新对话首条用户消息落库后通知（房间通常为空，
    // 无 watcher 时广播为 no-op；与聊天路由同一语义）
    publishChatMessage({ actorId: task.userId, chatId, role: "user" });
    // 沙箱宿主工具桥（二期）：任务 run 实际进沙箱且插件可用时，仅追加
    // 联网能力（platform_web_search），不追加 create_scheduled_task——
    // 执行器无创建权限；hostTools 幂等盐用任务 id（userId 由 RunManager
    // 以 RunStartInput.userId=task.userId 绑定）。
    const webAccess =
      workspaceDir !== null &&
      willRunSandbox({ workspaceDir }) &&
      (await getWebAccessService().available());
    const handle = await manager.start({
      prompt: { text: task.prompt, type: "prompt" },
      spec: {
        appendSystemPrompt: [
          buildSkillsSystemPrompt(skills),
          ...(workspaceDir
            ? [buildExecutionSystemPrompt(workspaceDir, [])]
            : []),
          ...(webAccess ? [webAccessPrompt + new Date().toISOString()] : []),
          `这是定时执行的任务。当前时间 ${new Date().toISOString()}。直接完成工作，不要创建新的定时任务。无法获取所需信息时如实说明，不编造实时信息或声称已发送通知。`,
        ],
        chatId,
        historyMessages: [],
        ...(webAccess ? { hostTools: { idempotencyKey: task.id } } : {}),
        model,
        skills,
        systemPrompt: regularPrompt,
        tools: [
          ...createSkillTools(skills),
          ...(webAccess
            ? [
                createWebSearchBridgeTool({
                  chatId,
                  model: { id: model.id, provider: model.provider },
                  userId: task.userId,
                }),
              ]
            : []),
        ],
        workspaceDir,
      },
      userId: task.userId,
    });
    publishChatRun({ actorId: task.userId, chatId, phase: "started" });
    await waitForTaskCompletion(handle);
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : translateMessage("runtimeMessages.executionFailed");
    await manager.abortByChat(chatId).catch(() => undefined);
  } finally {
    await finishScheduledTask(task, errorMessage);
  }
  return { error: errorMessage, success: !errorMessage, taskId: task.id };
}
