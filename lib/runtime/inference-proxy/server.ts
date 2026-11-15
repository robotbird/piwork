import "server-only";

import { createServer, type Server } from "node:http";
import type {
  Api,
  Context,
  Model,
  Provider,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiMessagesEvent } from "@earendil-works/pi-ai/api/pi-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { toPiMessagesEvent } from "./events";
import type { HostToolsRequestHandler } from "./host-tools";
import type { RunTokenRegistry } from "./tokens";

/**
 * Inference Proxy（spec §6 Phase 4，v2.0 §7.2 MVP）。
 *
 * 控制面旁路的 HTTP 反向代理：实现官方 `pi-messages` wire 协议的服务端
 * （pi-ai `api/pi-messages.js` 的对端）——`POST {baseUrl}/messages`，
 * Bearer run token 鉴权，body `{model, context, options}`，响应为 SSE
 * 序列化 assistant-message 事件 + 终态 done/error。上游是控制面的 Pi
 * Provider（生产 = 模型插件 WorkerThread host，即 HostedPiProviderAdapter；
 * 真实凭据只在 proxy 侧进程内，沙箱永远拿不到）。
 *
 * MVP 边界（v2.0 §7.2：首版不做多租户路由以外的功能）：
 * - 单控制面实例、内存 token 表（进程重启全失效 = fail-closed）；
 * - token 只授权签发 run 的模型集合（默认单模型）；
 * - 审计脱敏：只记 runId/chatId/provider/model/状态/用量/时长/错误码，
 *   永不落 token、context、消息内容。
 */

export type UpstreamModel = {
  provider: Provider;
  model: Model<Api>;
};

/** 控制面上游解析：(provider, modelId) → 可调用 Provider/Model */
export type UpstreamResolver = (grant: {
  provider: string;
  model: string;
}) => UpstreamModel | null | Promise<UpstreamModel | null>;

export type InferenceAuditEntry = {
  runId: string | null;
  chatId: string | null;
  action: "stream";
  status: "allowed" | "denied" | "error";
  provider: string | null;
  model: string | null;
  errorCode?:
    | "unauthorized"
    | "bad_request"
    | "payload_too_large"
    | "model_not_allowed"
    | "model_ambiguous"
    | "upstream_unavailable"
    | "upstream_error"
    | "upstream_stalled"
    | "client_aborted";
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
};

export type InferenceAuditSink = {
  record: (entry: InferenceAuditEntry) => void | Promise<void>;
};

/** wire 请求体（官方客户端序列化形状，见 pi-messages.js stream()） */
type PiMessagesRequestBody = {
  model?: unknown;
  context?: unknown;
  options?: Record<string, unknown>;
};

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Upstream stall guard: abort the provider stream when no event (not even a
 * delta) arrives for this long, so a hung upstream call fails fast instead of
 * pinning the run until an outer timeout. 0 disables the guard. Long thinking
 * pauses only risk tripping it when they exceed the whole window.
 */
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

export class InferenceProxyServer {
  private readonly server: Server;
  private readonly resolver: UpstreamResolver;
  private readonly tokens: RunTokenRegistry;
  private readonly audit: InferenceAuditSink | undefined;
  private readonly now: () => number;
  private readonly maxBodyBytes: number;
  private readonly hostTools: HostToolsRequestHandler | undefined;
  private readonly upstreamIdleTimeoutMs: number;

  constructor(options: {
    resolver: UpstreamResolver;
    tokens: RunTokenRegistry;
    audit?: InferenceAuditSink;
    now?: () => number;
    maxBodyBytes?: number;
    /** Sandbox Host Tools Bridge: POST /host-tools/<name> delegation.
     * Absent = the route 404s exactly as before. */
    hostTools?: HostToolsRequestHandler;
    /** Abort upstream streams idle for this long (0 = disabled). */
    upstreamIdleTimeoutMs?: number;
  }) {
    this.resolver = options.resolver;
    this.tokens = options.tokens;
    this.audit = options.audit;
    this.now = options.now ?? Date.now;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.hostTools = options.hostTools;
    this.upstreamIdleTimeoutMs =
      options.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        // 兜底：handler 内部已尽量自洽，这里防未知异常悬挂连接（审计与
        // 排障只用错误类别，不落请求体）
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "inference proxy internal error",
            },
          })
        );
      });
    });
    // 长流式响应：禁掉 node 默认 2 分钟空闲超时（模型生成可超过）
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
  }

  async listen(options?: {
    host?: string;
    port?: number;
  }): Promise<{ host: string; port: number; url: string }> {
    const host = options?.host ?? "127.0.0.1";
    const port = options?.port ?? 0;
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        resolvePromise();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("inference-proxy:listen:unexpected-address");
    }
    return {
      host: address.address,
      port: address.port,
      url: `http://${address.address === "::" ? "[::1]" : address.address}:${address.port}`,
    };
  }

  close(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      // 强制断开存量 keep-alive 连接（HTTP 客户端普遍长连接，不主动断则
      // close 等待空闲连接永不返回；Node ≥18.2）
      this.server.closeAllConnections?.();
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://inference-proxy.local");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (this.hostTools && url.pathname.startsWith("/host-tools/")) {
      await this.hostTools(req, res);
      return;
    }
    if (
      req.method !== "POST" ||
      url.pathname.replace(/\/+$/u, "") !== "/messages"
    ) {
      this.sendError(
        res,
        404,
        "not_found",
        "inference proxy only serves POST /messages"
      );
      return;
    }

    // 鉴权：官方客户端发 `authorization: Bearer <run token>`
    const authorization = req.headers.authorization ?? "";
    const tokenMatch = /^Bearer\s+(\S+)$/iu.exec(authorization);
    const grant = tokenMatch ? this.tokens.validate(tokenMatch[1]) : null;
    if (!grant) {
      await this.recordAudit({
        action: "stream",
        chatId: null,
        errorCode: "unauthorized",
        model: null,
        provider: null,
        runId: null,
        status: "denied",
      });
      this.sendError(res, 401, "unauthorized", "invalid or expired run token");
      return;
    }

    const body = await this.readBody(req);
    if (body === null) {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "payload_too_large",
        model: null,
        provider: null,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(
        res,
        413,
        "payload_too_large",
        "request body exceeds limit"
      );
      return;
    }
    let payload: PiMessagesRequestBody;
    try {
      payload = JSON.parse(body) as PiMessagesRequestBody;
    } catch {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "bad_request",
        model: null,
        provider: null,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(res, 400, "bad_request", "request body is not valid JSON");
      return;
    }
    const modelId = typeof payload.model === "string" ? payload.model : "";
    const context = payload.context as Context | undefined;
    if (!modelId || !context || !Array.isArray(context.messages)) {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "bad_request",
        model: modelId || null,
        provider: null,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(
        res,
        400,
        "bad_request",
        "expected {model, context{messages[]}, options?}"
      );
      return;
    }

    // 窄权限：wire 只携带裸 model id（pi-messages.js payload），按 token
    // 绑定的授权集匹配；同 id 多 provider 视为歧义（拒绝，fail-closed）
    const matches = grant.grants.filter((entry) => entry.model === modelId);
    if (matches.length === 0) {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "model_not_allowed",
        model: modelId,
        provider: null,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(
        res,
        403,
        "model_not_allowed",
        `model "${modelId}" is not granted to this run`
      );
      return;
    }
    if (matches.length > 1) {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "model_ambiguous",
        model: modelId,
        provider: null,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(
        res,
        403,
        "model_ambiguous",
        `model "${modelId}" matches multiple granted providers`
      );
      return;
    }
    const [grantModel] = matches;

    let upstream: UpstreamModel | null;
    try {
      upstream = await this.resolver(grantModel);
    } catch {
      upstream = null;
    }
    if (!upstream) {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "upstream_unavailable",
        model: modelId,
        provider: grantModel.provider,
        runId: grant.runId,
        status: "error",
      });
      this.sendError(
        res,
        503,
        "upstream_unavailable",
        "upstream provider is not available"
      );
      return;
    }

    let transcript: TranscriptContext;
    try {
      // 官方归一化：systemPrompt/tools 折叠进 leading system message
      transcript = normalizeContext(context);
    } catch {
      await this.recordAudit({
        action: "stream",
        chatId: grant.chatId,
        errorCode: "bad_request",
        model: modelId,
        provider: grantModel.provider,
        runId: grant.runId,
        status: "denied",
      });
      this.sendError(res, 400, "bad_request", "context failed to normalize");
      return;
    }

    // wire options 透传（HostedPiProviderAdapter.relay 对可结构化克隆的
    // options 原样转发进 worker，插件 Provider 按自身 api 消费）
    const upstreamOptions: Record<string, unknown> = {};
    const payloadOptions = payload.options ?? {};
    for (const key of [
      "temperature",
      "maxTokens",
      "reasoning",
      "cacheRetention",
      "sessionId",
      "toolChoice",
    ]) {
      if (payloadOptions[key] !== undefined) {
        upstreamOptions[key] = payloadOptions[key];
      }
    }
    const abort = new AbortController();
    // 断连感知：Node ≥16 的 req 'close' 在请求体读毕即触发（实测，非断连），
    // 必须挂 res 'close' 并以 writableEnded 区分「正常收尾后关闭」与中途断开
    res.on("close", () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    // 停滞保护：上游 N ms 无任何事件即中止（与断连共用同一 signal 语义）
    const stallAbort = new AbortController();
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = this.upstreamIdleTimeoutMs;
    const armStall = () => {
      clearTimeout(stallTimer);
      if (!idleMs) {
        return;
      }
      stallTimer = setTimeout(() => {
        stalled = true;
        stallAbort.abort();
      }, idleMs);
    };
    upstreamOptions.signal = AbortSignal.any([abort.signal, stallAbort.signal]);

    const startedAt = this.now();
    // 客户端断开后的残余写入不得抛（流已销毁；错误吞掉，断开只经 abort 感知）
    res.on("error", () => undefined);
    // 头部先发：上游失败以 wire error 事件到达（客户端按官方协议消费）
    res.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    const syntheticError = (errorMessage: string): PiMessagesEvent => ({
      errorMessage,
      reason: "error",
      type: "error",
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    });
    let terminal: "done" | "error" | null = null;
    let usage: { input: number; output: number } | undefined;
    try {
      const stream = upstream.provider.stream(
        upstream.model,
        transcript,
        upstreamOptions as Parameters<Provider["stream"]>[2]
      );
      armStall();
      for await (const event of stream) {
        armStall();
        const wireEvent = toPiMessagesEvent(event);
        if (wireEvent && !res.destroyed) {
          res.write(`data: ${JSON.stringify(wireEvent)}\n\n`);
        }
        if (event.type === "done" || event.type === "error") {
          terminal = event.type;
          const message = event.type === "done" ? event.message : event.error;
          usage = { input: message.usage.input, output: message.usage.output };
          break;
        }
      }
    } catch {
      terminal ??= "error";
      // 官方客户端把「流无终态结束」当硬错误；异常路径同样补发 error 事件
      if (!res.destroyed) {
        res.write(
          `data: ${JSON.stringify(
            syntheticError(
              stalled
                ? `upstream stalled: no events for ${idleMs}ms`
                : "upstream stream failed"
            )
          )}\n\n`
        );
      }
    } finally {
      clearTimeout(stallTimer);
    }
    if (terminal === null) {
      // 客户端契约：流必须以终态事件结束（"stream ended without a
      // terminal event" 是官方客户端的硬错误），上游违约时补发 error
      terminal = "error";
      if (!res.destroyed) {
        res.write(
          `data: ${JSON.stringify(
            syntheticError("upstream stream ended without a terminal event")
          )}\n\n`
        );
      }
    }
    res.end();
    await this.recordAudit({
      action: "stream",
      chatId: grant.chatId,
      durationMs: this.now() - startedAt,
      errorCode:
        terminal === "error"
          ? stalled
            ? "upstream_stalled"
            : abort.signal.aborted
              ? "client_aborted"
              : "upstream_error"
          : undefined,
      inputTokens: usage?.input,
      model: modelId,
      outputTokens: usage?.output,
      provider: grantModel.provider,
      runId: grant.runId,
      status: terminal === "done" ? "allowed" : "error",
    });
  }

  private readBody(
    req: import("node:http").IncomingMessage
  ): Promise<string | null> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let overflowing = false;
      req.on("data", (chunk: Buffer) => {
        if (overflowing) {
          // 已超限：继续读弃剩余字节（不 destroy——提前掐断会让 413 响应
          // 无法送达客户端），end 后连接由 keep-alive 语义自然回收
          return;
        }
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          overflowing = true;
          resolvePromise(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!overflowing) {
          resolvePromise(Buffer.concat(chunks).toString("utf8"));
        }
      });
      req.on("error", reject);
    });
  }

  private sendError(
    res: import("node:http").ServerResponse,
    status: number,
    code: string,
    message: string
  ): void {
    // 错误体格式对齐官方客户端 parsePiMessagesErrorBody 的 {error:{message,code}}
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { code, message } }));
  }

  private async recordAudit(entry: InferenceAuditEntry): Promise<void> {
    try {
      await this.audit?.record(entry);
    } catch {
      // 审计失败不阻断请求处理（best-effort），错误在装配层观察
    }
  }
}
