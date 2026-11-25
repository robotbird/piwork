import type { Api, Model } from "@earendil-works/pi-ai";
import { geolocation } from "@vercel/functions";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { checkBotId } from "botid/server";
import { getTranslations } from "next-intl/server";
import { auth, type UserType } from "@/app/(auth)/auth";
import { getPreferredModelId } from "@/lib/ai/active-models";
import {
  buildExecutionSystemPrompt,
  ensureChatWorkspace,
  executionToolsEnabled,
  removeChatWorkspace,
  writeAttachmentsToWorkspace,
} from "@/lib/ai/agent-tools";
import { isChatFileUrl } from "@/lib/ai/attachment-types";
import {
  type PreparedChatAttachments,
  prepareChatAttachments,
} from "@/lib/ai/attachments";
import { DocumentInputError } from "@/lib/ai/document-errors";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { classifyExecution } from "@/lib/ai/execution-classifier";
import { getImageGenerationSetup } from "@/lib/ai/image-generation";
import { loadEnabledManagedProjectSkills } from "@/lib/ai/managed-skills";
import {
  AUTO_VIRTUAL_MODEL_ID,
  getModelAvailability,
  IMAGE_VIRTUAL_MODEL_ID,
} from "@/lib/ai/models";
import { getPiModel, toPiHistoryMessages } from "@/lib/ai/pi";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { checkUserTokenQuota, getUserModelCatalog } from "@/lib/ai/role-access";
import { schedulingPrompt } from "@/lib/ai/scheduled-task-tools";
import {
  buildSkillsSystemPrompt,
  createSkillTools,
  invokeSkill,
  parseSkillCommand,
} from "@/lib/ai/skills";
import { webSearchPrompt } from "@/lib/ai/web-tools";
import {
  publishChatMessage,
  publishChatRun,
} from "@/lib/collab/chat-event-hub";
import { getActiveRunByChatId } from "@/lib/db/agent-run-queries";
import { getChatAccess } from "@/lib/db/chat-share-queries";
import {
  acquireWebLeaseIfSynced,
  DesktopSyncConflict,
  releaseDesktopSyncLease,
} from "@/lib/db/desktop-sync-queries";
import { canReadStoredFile } from "@/lib/db/library-queries";
import { getProject } from "@/lib/db/project-queries";
import {
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { LocalizedError } from "@/lib/i18n/messages";
import { syncManagedAgentMcpConfig } from "@/lib/mcp/agent-config";
import { pluginSearchAvailable } from "@/lib/pi-packages/runtime-flag";
import { buildProjectSourcesContext } from "@/lib/projects/context";
import { projectDocumentInputsEnabled } from "@/lib/projects/document-inputs";
import { willRunSandbox } from "@/lib/runtime/backends/routing/backend";
import { projectChatExecution } from "@/lib/runtime/backends/routing/chat-routing";
import type {
  ProjectSourcesGrant,
  RuntimeCommand,
} from "@/lib/runtime/protocol";
import { getRunManager } from "@/lib/runtime/run";
import type { RunSubscription } from "@/lib/runtime/run/run-manager";
import { scheduledTaskTools } from "@/lib/scheduler/service";
import { chatWebSearchTools } from "@/lib/search/chat";
import { webSearchEnabled } from "@/lib/search/service";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import {
  convertToUIMessages,
  generateUUID,
  getTextFromMessage,
} from "@/lib/utils";
import {
  createWebSearchBridgeTool,
  webAccessPrompt,
} from "@/lib/web-access/host-tool";
import { getWebAccessService } from "@/lib/web-access/mcp-host";
import { generateTitleFromUserMessage } from "../../actions";
import {
  isMessageTextTooLongError,
  type PostRequestBody,
  postRequestBodySchema,
} from "./schema";
import { pumpRunSubscription } from "./stream-mapping";

export const maxDuration = 60;

const HEALTH_CHECK_DELAY_MS = 9000;

export async function POST(request: Request) {
  const t = await getTranslations("api");
  const tRuntime = await getTranslations();
  let requestBody: PostRequestBody;
  let syncLease: { chatId: string; userId: string; token: string } | null =
    null;
  let streamOwnsLease = false;
  const releaseSyncLease = async () => {
    if (!syncLease) {
      return;
    }
    const lease = syncLease;
    syncLease = null;
    try {
      await releaseDesktopSyncLease({ ...lease, side: "web" });
    } catch {
      console.error("[desktop-sync] Unable to release Web run lease");
    }
  };

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    // 超长消息返回专属提示（含上限），其余仍用通用 bad_request 文案
    if (isMessageTextTooLongError(error)) {
      return new ChatbotError("bad_request:chat").toResponse();
    }
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const [botIdResult, session] = await Promise.all([
      // BotID 仅在显式开启（部署于 Vercel）时检测；自托管默认关闭：
      // 服务端无 Vercel 平台注入时本就无法完成真实检测（每次请求都会
      // 打 "Possible misconfiguration" 警告），客户端挑战在非安全上下文
      // （http://IP:port）也无法运行，见 instrumentation-client.ts。
      process.env.NEXT_PUBLIC_BOTID_ENABLED === "1"
        ? checkBotId({ developmentOptions: { bypass: "HUMAN" } }).catch(
            () => null
          )
        : Promise.resolve(null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // 模型管理平台未配置任何模型时直接拒绝，不再回退静态模型
    const modelCatalog = await getUserModelCatalog(session.user.id);
    await checkUserTokenQuota(session.user.id);
    if (modelCatalog.models.length === 0) {
      if (modelCatalog.platformModelCount > 0) {
        return new ChatbotError(
          "forbidden:model",
          t("noAuthorizedModel")
        ).toResponse();
      }
      return Response.json({ error: t("noModelConfigured") }, { status: 503 });
    }
    const requestedModelId =
      selectedChatModel === IMAGE_VIRTUAL_MODEL_ID
        ? modelCatalog.defaultImageModelId
        : selectedChatModel;
    const modelConfig = modelCatalog.models.find(
      (model) => model.id === requestedModelId
    );
    if (!modelConfig) {
      return new ChatbotError(
        "forbidden:model",
        "Model not authorized"
      ).toResponse();
    }
    const { id: chatModel, imageModelId } = modelConfig;

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      differenceInHours: 1,
      id: session.user.id,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      const access = await getChatAccess(id, session.user.id);
      if (!access || !(access.isOwner || access.isCollaborator)) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      if (
        chat.projectId &&
        !(await getProject(session.user.id, chat.projectId))
      ) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      if (process.env.PIWORK_DESKTOP_SYNC_ENABLED === "1") {
        try {
          const token = await acquireWebLeaseIfSynced(id, chat.userId);
          if (token) {
            syncLease = { chatId: id, token, userId: chat.userId };
          }
        } catch (error) {
          if (error instanceof DesktopSyncConflict) {
            return new ChatbotError("conflict:chat").toResponse();
          }
          throw error;
        }
      }
      messagesFromDb = await getMessagesByChatId({ id });
      // 项目聊天在发起页已预建（标题为占位）：首条用户消息发出后生成标题
      if (
        chat.projectId &&
        messagesFromDb.length === 0 &&
        message?.role === "user" &&
        message.parts.some((part) => part.type === "text" && part.text.trim())
      ) {
        titlePromise = generateTitleFromUserMessage({ message });
      }
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "New chat",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      const hasText = message.parts.some(
        (part) => part.type === "text" && part.text.trim()
      );
      titlePromise = hasText
        ? generateTitleFromUserMessage({ message })
        : Promise.resolve(
            message.parts[0]?.type === "file"
              ? (message.parts[0].filename ?? t("attachmentProcessing"))
              : t("attachmentProcessing")
          );
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    // 审批续跑（v2.0 §2.1-8）：既有 assistant 消息的 parts（含审批状态
    // 覆盖）与 id 作为 run 的 base——RunManager 终态 upsert 前置合并，
    // 只落 run 事件 parts 会丢前轮内容/审批态。
    let baseAssistantMessageId: string | undefined;
    let baseParts: readonly unknown[] | undefined;
    if (isToolApprovalFlow) {
      const lastAssistant = uiMessages.findLast(
        (currentMessage) => currentMessage.role === "assistant"
      );
      if (lastAssistant) {
        baseAssistantMessageId = lastAssistant.id;
        baseParts = lastAssistant.parts;
      }
    }

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      city,
      country,
      latitude,
      longitude,
    };

    const currentUserMessageIndex = uiMessages.findLastIndex(
      (currentMessage) => currentMessage.role === "user"
    );
    const currentUserMessage = uiMessages[currentUserMessageIndex];
    const currentUserText = currentUserMessage
      ? getTextFromMessage(currentUserMessage).trim()
      : "";
    const currentUserFileCount =
      currentUserMessage?.parts.filter((part) => part.type === "file").length ??
      0;
    if (!(currentUserText || currentUserFileCount > 0)) {
      return new ChatbotError("bad_request:api").toResponse();
    }
    let projectClassification: ReturnType<typeof projectChatExecution>;
    try {
      projectClassification = projectChatExecution({
        executionEnabled: executionToolsEnabled(),
        projectChat: Boolean(chat?.projectId),
        sandboxProvider: process.env.PIWORK_SANDBOX_PROVIDER,
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof LocalizedError
              ? tRuntime(error.messageKey, error.params)
              : error instanceof Error
                ? error.message
                : t("projectSandboxUnavailable"),
        },
        { status: 503 }
      );
    }
    const skillCommand = parseSkillCommand(currentUserText);
    const history = uiMessages.slice(0, currentUserMessageIndex);
    const { skills, diagnostics: skillDiagnostics } =
      await loadEnabledManagedProjectSkills();
    const platformWebSearch = webSearchEnabled();
    // 分类器的能力信号 = Tavily 平台工具或插件路线(pi-web-access 等),
    // 任一可用即纯搜索问题可留在轻量通道;平台工具装配仍只看 Tavily 开关
    const webSearchCapable =
      platformWebSearch || (await pluginSearchAvailable());
    const classification =
      projectClassification ??
      (executionToolsEnabled()
        ? skillCommand
          ? { reason: "skill-command", requiresExecution: true }
          : await classifyExecution({
              attachmentCount: currentUserFileCount,
              history: history.map((item) => ({
                role: item.role,
                text: getTextFromMessage(item),
              })),
              message: currentUserText,
              platformWebSearch: webSearchCapable,
              signal: request.signal,
            })
        : { reason: "disabled", requiresExecution: false });
    console.info("[chat] execution routing", {
      chatId: id,
      ...classification,
    });

    if (message?.role === "user") {
      const fileAccess = await Promise.all(
        message.parts
          .filter((part) => part.type === "file" && isChatFileUrl(part.url))
          .map((part) =>
            part.type === "file"
              ? canReadStoredFile(session.user.id, part.url)
              : true
          )
      );
      if (fileAccess.some((allowed) => !allowed)) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
            // 消息归属由服务端会话决定，不信任客户端 metadata；
            // 用于协作对话的用户消息头像/名字展示。
            userId: session.user.id,
          },
        ],
      });
      // 协作实时：用户消息落库后通知房间其他成员（本人跳过；
      // 事件不携带正文，watcher 重拉 /api/messages）。
      publishChatMessage({
        actorId: session.user.id,
        chatId: id,
        role: "user",
      });
    }

    let preparedAttachments: PreparedChatAttachments;
    try {
      preparedAttachments = currentUserMessage
        ? await prepareChatAttachments(currentUserMessage, request.signal)
        : { images: [], text: "" };
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to process attachments.",
        },
        { status: 400 }
      );
    }
    const piModel = await getPiModel(chatModel);
    // 虚拟模型（Auto / 图像生成）选中时解析物理派发目标。候选一律取自
    // modelCatalog（当前用户经角色策略授权的目录），不取全局目录——
    // 受限角色不得被路由到未授权模型。
    const imageGeneration = await getImageGenerationSetup();
    const virtualSelected = piModel.provider === "piwork";
    const autoVirtualSelected = chatModel === AUTO_VIRTUAL_MODEL_ID;
    if (
      imageModelId &&
      !imageGeneration?.models.some((model) => model.modelId === imageModelId)
    ) {
      return Response.json({ error: t("modelUnavailable") }, { status: 400 });
    }
    const physicalCatalogModels = modelCatalog.models.filter(
      (model) => model.provider !== "piwork"
    );
    let virtualOrchestrator: Model<Api> | undefined;
    let autoVirtualRouting:
      | { fast: Model<Api>; quality?: Model<Api> }
      | undefined;
    if (virtualSelected) {
      const fastId =
        physicalCatalogModels.find((model) => model.capabilities.tools)?.id ??
        (autoVirtualSelected ? getPreferredModelId(modelCatalog) : null);
      virtualOrchestrator = fastId
        ? await getPiModel(fastId).catch(() => undefined)
        : undefined;
      if (!virtualOrchestrator) {
        return Response.json(
          {
            error: t(
              autoVirtualSelected
                ? "autoModelNeedsChatModel"
                : "imageModelNeedsChatModel"
            ),
          },
          { status: 400 }
        );
      }
      if (autoVirtualSelected) {
        // 高质量档：用户授权目录里按名称/id 特征挑选（目录顺序优先），
        // 找不到就退化为 fast 单档
        const qualityId = physicalCatalogModels.find((model) =>
          /-pro\b|-plus\b|max\b|premium|opus|sonnet|thinking|reasoner|\br1\b/i.test(
            `${model.id} ${model.name}`
          )
        )?.id;
        const quality = qualityId
          ? await getPiModel(qualityId).catch(() => undefined)
          : undefined;
        autoVirtualRouting = quality
          ? { fast: virtualOrchestrator, quality }
          : { fast: virtualOrchestrator };
      }
    }
    // 虚拟选中时辅助直调（联网搜索工具的模型身份等）一律用物理模型，
    // 避免宿主侧直调拿到未注册路由的虚拟 id
    const auxiliaryModel = virtualOrchestrator ?? piModel;
    if (
      preparedAttachments.images.length > 0 &&
      !piModel.input.includes("image")
    ) {
      return Response.json({ error: t("modelNoImages") }, { status: 400 });
    }

    if (skillDiagnostics.length > 0) {
      console.warn("Skill discovery warnings:", skillDiagnostics);
    }

    // 执行类工具（bash/read/write/edit + deliver_file）以每聊天独立工作区
    // 运行；用户上传的附件原始字节先落盘到工作区供 skill 脚本直接读取。
    const workspaceDir = classification.requiresExecution
      ? await ensureChatWorkspace(id)
      : null;
    // Workspace runs sync the managed mcp.json before the Pi session opens.
    // A sync failure is logged and the run can still start.
    if (workspaceDir) {
      await syncManagedAgentMcpConfig().catch((error) => {
        console.warn("Failed to sync managed agent mcp.json:", error);
      });
    }
    let workspaceAttachmentFiles: string[] = [];
    if (workspaceDir && currentUserMessage) {
      try {
        workspaceAttachmentFiles = await writeAttachmentsToWorkspace(
          currentUserMessage,
          workspaceDir,
          request.signal
        );
      } catch (error) {
        // 输入准备失败传播（A2）：执行类任务的必要附件水合失败不得静默
        // 降级——缺输入的执行会产出错误结果；fail-closed 直接拒绝本次请求。
        console.error("Failed to materialize attachments into workspace:", {
          chatId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        // biome-ignore lint/style/useErrorCause: 原始错误已在上行日志保留；用户可见文案走 i18n
        throw new ChatbotError(
          "bad_request:chat",
          t("attachmentWorkspaceFailed")
        );
      }
    }

    const baseSystemPrompt = systemPrompt({
      requestHints,
      supportsTools: false,
    });
    const executionPrompt = workspaceDir
      ? buildExecutionSystemPrompt(workspaceDir, workspaceAttachmentFiles)
      : "";
    // 沙箱宿主工具桥（二期）：实际会进沙箱的 run 且插件可用时，装配
    // platform_web_search 桥接工具与提示词（轻量通道的 Tavily 闭包已含
    // 同名工具时跳过，避免重名）。
    const webAccessBridge =
      willRunSandbox({ workspaceDir }) &&
      !(platformWebSearch && !workspaceDir) &&
      (await getWebAccessService().available());
    const historyMessages = toPiHistoryMessages(history, chatModel);

    const sandboxSkillCommand = Boolean(
      process.env.PIWORK_SANDBOX_PROVIDER && workspaceDir && skillCommand
    );
    let agentPrompt = currentUserText || t("attachmentPrompt");
    if (skillCommand) {
      try {
        if (!skills.some((skill) => skill.name === skillCommand.name)) {
          throw new Error(`Unknown skill "${skillCommand.name}".`);
        }
        agentPrompt = sandboxSkillCommand
          ? (skillCommand.instructions ?? "")
          : await invokeSkill(
              skills,
              skillCommand.name,
              skillCommand.instructions
            );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : t("unknownSkill") },
          { status: 404 }
        );
      }
    }
    if (preparedAttachments.text) {
      agentPrompt = `${agentPrompt}\n\n${preparedAttachments.text}`;
    }

    let projectSources: ProjectSourcesGrant | undefined;
    // Preview in prompt; complete stored text is hydrated inside SandboxRpc.
    if (chat?.projectId) {
      try {
        const projectRecord = await getProject(session.user.id, chat.projectId);
        if (!projectRecord) {
          return new ChatbotError("forbidden:chat").toResponse();
        }
        if (projectRecord) {
          const context = await buildProjectSourcesContext({
            projectId: projectRecord.id,
            projectName: projectRecord.name,
            sandboxDocuments: projectDocumentInputsEnabled(),
            userId: session.user.id,
          });
          if (context) {
            if (context.images.length && !piModel.input.includes("image")) {
              return Response.json(
                { error: t("modelNoImages") },
                { status: 400 }
              );
            }
            preparedAttachments.images.push(...context.images);
            if (projectDocumentInputsEnabled()) {
              projectSources = {
                projectId: projectRecord.id,
                sources: context.references,
                userId: session.user.id,
              };
            }
            agentPrompt = `${context.block}${t("questionPrompt", { text: agentPrompt })}`;
          }
        }
      } catch (error) {
        console.warn("Project sources context failed:", error);
        return Response.json(
          {
            error:
              error instanceof DocumentInputError
                ? tRuntime(error.messageKey, error.params)
                : t("sourceExtractFailed"),
          },
          { status: 400 }
        );
      }
    }

    const runtimePrompt: Extract<RuntimeCommand, { type: "prompt" }> = {
      expandPromptTemplates: false,
      images: preparedAttachments.images,
      // Official remote Pi expands the command after project/attachment context
      // is assembled, using its actual sandbox-local SKILL.md/baseDir.
      text:
        sandboxSkillCommand && skillCommand
          ? `/skill:${skillCommand.name} ${agentPrompt}`
          : agentPrompt,
      type: "prompt",
    };
    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        let leaseTransferred = false;
        try {
          const modelName = modelConfig.name;
          let hasModelActivity = false;
          let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;

          const clearHealthCheckTimer = () => {
            if (healthCheckTimer) {
              clearTimeout(healthCheckTimer);
            }
          };

          const writeWaitingStatus = (
            phase: WaitingStatusData["phase"],
            messageText: string
          ) => {
            if (hasModelActivity && phase !== "thinking") {
              return;
            }
            dataStream.write({
              data: {
                message: messageText,
                modelId: chatModel,
                modelName,
                phase,
              },
              transient: true,
              type: "data-waiting-status",
            });
          };

          writeWaitingStatus("waiting", "Waiting...");

          healthCheckTimer = setTimeout(() => {
            Promise.resolve(getModelAvailability(chatModel))
              .then((availability) => {
                if (availability === "impacted") {
                  writeWaitingStatus(
                    "health",
                    `${modelName} may be slow or unavailable right now...`
                  );
                } else {
                  writeWaitingStatus("still-waiting", "Still waiting...");
                }
              })
              .catch(() => {
                writeWaitingStatus("still-waiting", "Still waiting...");
              });
          }, HEALTH_CHECK_DELAY_MS);

          const markModelActive = () => {
            if (hasModelActivity) {
              return;
            }
            hasModelActivity = true;
            clearHealthCheckTimer();
            writeWaitingStatus("thinking", "Thinking...");
          };

          const stopWaitingStatus = () => {
            hasModelActivity = true;
            clearHealthCheckTimer();
          };

          // RunManager（v2.0 Step 2）：run 生命周期独立于本请求——start 落
          // AgentRun/lease 并启动唯一消费循环，route 只 attach 订阅；断线仅
          // detach（run 进程内继续），消息在终态由 RunManager 幂等 upsert。
          let subscription: RunSubscription | undefined;
          try {
            const run = await getRunManager().start({
              baseAssistantMessageId,
              baseParts,
              prompt: runtimePrompt,
              spec: {
                ...(projectSources ? { projectSources } : {}),
                appendSystemPrompt: [
                  buildSkillsSystemPrompt(skills),
                  schedulingPrompt + new Date().toISOString(),
                  ...(platformWebSearch && !workspaceDir
                    ? [webSearchPrompt + new Date().toISOString()]
                    : []),
                  ...(webAccessBridge
                    ? [webAccessPrompt + new Date().toISOString()]
                    : []),
                  ...(executionPrompt ? [executionPrompt] : []),
                ],
                autoVirtualRouting,
                chatId: id,
                historyMessages,
                // RunManager binds the authenticated actor to this message-level key.
                hostTools: { idempotencyKey: currentUserMessage.id },
                // image_gen 由 backend 注入（artifact 卡片闭包），此处只声明可用性
                imageGeneration: Boolean(imageGeneration),
                imageModelId,
                // 沙箱路由矩阵下虚拟模型 pin 成物理编排模型：沙箱内 Pi 无
                // 会话侧路由注册（fail-closed，不降级），此处显式固定
                model:
                  virtualSelected &&
                  willRunSandbox({ workspaceDir }) &&
                  virtualOrchestrator
                    ? virtualOrchestrator
                    : piModel,
                skills,
                systemPrompt: baseSystemPrompt,
                tools: [
                  ...createSkillTools(skills),
                  ...(platformWebSearch && !workspaceDir
                    ? chatWebSearchTools({
                        chatId: id,
                        model: auxiliaryModel,
                        userId: session.user.id,
                      })
                    : []),
                  ...(webAccessBridge
                    ? [
                        createWebSearchBridgeTool({
                          chatId: id,
                          model: {
                            id: auxiliaryModel.id,
                            provider: auxiliaryModel.provider,
                          },
                          userId: session.user.id,
                        }),
                      ]
                    : []),
                  ...scheduledTaskTools(session.user.id, currentUserMessage.id),
                ],
                virtualOrchestrator,
                workspaceDir,
              },
              userId: session.user.id,
            });

            const attached = run.attach();
            if (!attached) {
              // start 返回后 LiveRun 必在，仅防御性兜底
              throw new Error("run detached before attach");
            }
            subscription = attached;
            if (syncLease) {
              leaseTransferred = true;
              attached.settled
                .then(async () => {
                  if (!(await getActiveRunByChatId(id))) {
                    await releaseSyncLease();
                  }
                })
                .catch(() =>
                  console.error(
                    "[desktop-sync] Unable to verify Web run completion"
                  )
                );
            }
            // 协作实时：run 已启动且本请求成功 attach，通知房间其他成员
            // resumeStream attach 活跃 run（与断线重连同一重放/活流 tail）。
            publishChatRun({
              actorId: session.user.id,
              chatId: id,
              phase: "started",
            });
            // 显式 start：客户端/DB/重放共用同一确定性消息 id（§2.5）
            dataStream.write({ messageId: attached.messageId, type: "start" });

            const detach = () => subscription?.close();
            request.signal.addEventListener("abort", detach, { once: true });
            try {
              await pumpRunSubscription(dataStream, subscription, {
                // 任意内容块事件即视为模型活跃(含 tool 通道,与原事件桥一致)
                onEvent: (event) => {
                  if (event.type === "message.delta") {
                    markModelActive();
                  }
                },
              });
            } finally {
              request.signal.removeEventListener("abort", detach);
            }
          } finally {
            stopWaitingStatus();
            subscription?.close();
          }

          if (titlePromise) {
            try {
              const title = await titlePromise;
              await updateChatTitleById({ chatId: id, title });
              dataStream.write({ data: title, type: "data-chat-title" });
            } catch {
              /* non-fatal */
            }
          }
        } finally {
          if (!leaseTransferred) {
            await releaseSyncLease();
          }
        }
      },
      generateId: generateUUID,
      onError: (error) => {
        console.error("[chat] stream execution failed", { chatId: id }, error);
        return t("modelUnavailable");
      },
    });

    // Lease ownership transfer: from here the POST-level finally must not
    // release — the stream's execute finally owns pre-attach failures, and the
    // run's settled hook owns the release once the run outlives the request.
    streamOwnsLease = true;
    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  } finally {
    if (!streamOwnsLease) {
      await releaseSyncLease();
    }
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  // 先停活跃 run 再删（best-effort）：避免删除后 run 继续向已删 chat 落消息
  await getRunManager()
    .abortByChat(id)
    .catch(() => undefined);

  const deletedChat = await deleteChatById({ id });

  // 聊天删除后同步清理其执行工作区（best-effort）。
  await removeChatWorkspace(id).catch(() => undefined);

  return Response.json(deletedChat, { status: 200 });
}
