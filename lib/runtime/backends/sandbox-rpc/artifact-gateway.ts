import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { MAX_DELIVER_FILE_SIZE } from "@/lib/ai/agent-tools";
import { getSupportedAttachmentType } from "@/lib/ai/attachment-types";
import type { StoredFile } from "@/lib/ai/file-store";
import { createPrivateFileStore } from "@/lib/ai/private-file-store";
import type { RuntimeEvent } from "../../protocol";
import type { AsyncEventQueue } from "../event-queue";
import { DELIVER_FILE_TOOL_NAME } from "./deliver-file-extension";

/**
 * Artifact Gateway 宿主侧（spec §6 Phase 2 / §8「出站走显式网关」）：收割
 * 沙箱 outbox manifest，经私有存储出站、归档回调入文档库，并把
 * artifact.created 推进会话事件流（与 InProcessBackend 的 deliver_file 闭包
 * 同一终效：前端附件卡 + message-builder 持久化）。
 *
 * 触发点：官方 RpcClient.onEvent 的 tool_execution_end（result.details.manifest
 * 由沙箱内 deliver-file extension 填写）。收割串行（保序）。
 *
 * 终态屏障（A1/S1）：交付失败不再 best-effort 吞错——收割链本身仍不 reject
 * （后续收割不受前次失败影响），但每次失败都被计数；SandboxRpc 会话在官方
 * agent_settled 之后、平台终态之前调用 drain()，排空在途收割并取回自上次
 * drain 以来的失败。存在失败时平台终态落 run.failed（fail-closed），最终
 * 消息/事件不再静默丢失交付文件。flush() 仅作 close 兜底（诊断用途），
 * 不承担正常交付语义。
 *
 * 出站存储默认为平台私有存储（A5/S5）：platform 绑定 key、本地原子发布、
 * URL 经既有鉴权下载路由；不向 Vercel Blob public 写入新对象。
 */

export type ArtifactStore = (input: {
  buffer: Uint8Array;
  contentType: string;
  filename: string;
  /** 平台绑定操作键（默认私有存储的幂等 key：chat + manifest 绑定） */
  key: string;
}) => Promise<StoredFile>;

export type ArtifactArchive = (
  chatId: string,
  file: StoredFile,
  size: number
) => Promise<void>;

export type ArtifactGatewayOptions = {
  chatId: string;
  queue: AsyncEventQueue<RuntimeEvent>;
  /** workspace 相对路径读取（通常绑定 SandboxHandle.readFile，遏制由其保证） */
  readFile: (file: string) => Promise<Uint8Array>;
  /** 出站存储（默认平台私有存储；测试注入替身） */
  store?: ArtifactStore;
  /** 归档回调（生产为 registerGeneratedFile；缺省跳过） */
  archiveFile?: ArtifactArchive;
};

/** drain() 结果：自上次 drain 以来收割失败的描述（空数组 = 全部成功） */
export type ArtifactDrainResult = {
  failures: string[];
};

type OutboxManifest = {
  id: string;
  path: string;
  filename: string;
  size: number;
};

const privateStore = createPrivateFileStore();

const privateArtifactStore: ArtifactStore = async ({
  buffer,
  contentType,
  filename,
  key,
}) =>
  privateStore({ content: buffer, contentType, filename, operationKey: key });

/** 官方事件的最小结构判别（JsonAgentSessionEvent 是大联合，按需收窄） */
function deliverFileManifestOf(
  event: JsonAgentSessionEvent
): string | undefined {
  if (event.type !== "tool_execution_end") {
    return;
  }
  if (event.toolName !== DELIVER_FILE_TOOL_NAME || event.isError) {
    return;
  }
  const details = (event.result as { details?: unknown } | undefined | null)
    ?.details;
  const manifest = (details as { manifest?: unknown } | undefined | null)
    ?.manifest;
  return typeof manifest === "string" ? manifest : undefined;
}

function parseManifest(bytes: Uint8Array): OutboxManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.filename !== "string" ||
    typeof candidate.size !== "number"
  ) {
    return null;
  }
  return {
    filename: candidate.filename,
    id: candidate.id,
    path: candidate.path,
    size: candidate.size,
  };
}

export function createArtifactGateway(options: ArtifactGatewayOptions): {
  /** 挂到 client.onEvent；返回值即 unsubscribe */
  handleEvent: (event: JsonAgentSessionEvent) => void;
  /**
   * 终态屏障：等待在途收割完成，回报自上次 drain 以来的失败（含归档）。
   * 链本身永不 reject；失败经结果数组上报。
   */
  drain: () => Promise<ArtifactDrainResult>;
  /** close 兜底：等待在途收割完成（吞错，仅诊断用途） */
  flush: () => Promise<void>;
} {
  const store = options.store ?? privateArtifactStore;
  const processed = new Set<string>();
  const failures: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const recordFailure = (reason: string, manifestPath: string): void => {
    const message = `${reason} (${manifestPath})`;
    failures.push(message);
    console.error("[artifact-gateway] harvest failed", {
      manifestPath,
      reason,
    });
  };

  const harvest = async (manifestPath: string): Promise<void> => {
    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await options.readFile(manifestPath);
    } catch (error) {
      recordFailure(
        `manifest read failed: ${error instanceof Error ? error.message : String(error)}`,
        manifestPath
      );
      return;
    }
    const manifest = parseManifest(manifestBytes);
    if (!manifest) {
      recordFailure("invalid manifest", manifestPath);
      return;
    }
    if (processed.has(manifest.id)) {
      return;
    }
    processed.add(manifest.id);
    if (manifest.size > MAX_DELIVER_FILE_SIZE) {
      recordFailure(
        `manifest exceeds size limit (${manifest.size})`,
        manifestPath
      );
      return;
    }
    // 载荷路径由沙箱内扩展写入（workspace 相对）；readFile 的路径遏制由
    // 绑定的 SandboxHandle 保证
    const bytes = await options.readFile(manifest.path);
    if (bytes.byteLength > MAX_DELIVER_FILE_SIZE) {
      recordFailure(
        `file exceeds size limit (${bytes.byteLength})`,
        manifestPath
      );
      return;
    }
    const contentType =
      getSupportedAttachmentType(manifest.filename)?.mediaType ??
      "application/octet-stream";
    // 平台绑定 key（chat + manifest）：同 manifest 重放幂等，跨 manifest 唯一
    const stored = await store({
      buffer: bytes,
      contentType,
      filename: manifest.filename,
      key: `artifact:${options.chatId}:${manifest.id}`,
    });
    await options.archiveFile?.(options.chatId, stored, bytes.byteLength);
    options.queue.push({
      file: {
        contentType,
        downloadUrl: stored.downloadUrl,
        filename: manifest.filename,
        url: stored.url,
      },
      type: "artifact.created",
    });
  };

  return {
    drain: async () => {
      await chain;
      const pending = [...failures];
      failures.length = 0;
      return { failures: pending };
    },
    flush: () =>
      chain.then(
        () => undefined,
        () => undefined
      ),
    handleEvent: (event) => {
      const manifestPath = deliverFileManifestOf(event);
      if (manifestPath === undefined) {
        return;
      }
      // 串行收割保序；失败计数上报 drain（终态屏障），链尾恒 catch——chain
      // 永不 reject，后续收割不受前次失败影响
      chain = chain
        .then(() => harvest(manifestPath))
        .catch((error: unknown) => {
          recordFailure(
            error instanceof Error ? error.message : String(error),
            manifestPath
          );
        });
    },
  };
}
