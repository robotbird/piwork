import "server-only";

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  RunHostToolsGrant,
  RunTokenGrant,
  RunTokenRegistry,
} from "./tokens";

/**
 * Sandbox Host Tools Bridge (sync counterpart of the async deliver_file
 * outbox): sandbox-side extension tools call `POST /host-tools/<name>` on the
 * inference proxy with the run token; the host executes and returns the real
 * result in the same request. Identity lives only in the token grant — the
 * request body carries tool input and nothing else.
 *
 * Transport-level failures (auth, scope, malformed body) use HTTP status
 * codes; tool-level failures answer 200 with {ok:false,error} so the sandbox
 * extension can relay the allowlisted message to the model verbatim.
 */

export const HOST_TOOLS_PATH_PREFIX = "/host-tools/";
export const HOST_TOOLS_MAX_BODY_BYTES = 256 * 1024;

/** Tool-level error with a code + message that may be returned to the model. */
export class HostToolsError extends Error {
  readonly code: "invalid_input" | "task_failed" | "aborted";

  constructor(
    code: HostToolsError["code"],
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.code = code;
  }
}

export type HostToolsAuditEntry = {
  tool: string;
  runId: string | null;
  chatId: string | null;
  status: "allowed" | "denied" | "error";
  errorCode?: string;
  durationMs?: number;
};

export type HostToolsAuditSink = {
  record: (entry: HostToolsAuditEntry) => void | Promise<void>;
};

/** Context handed to a host tool implementation. The hostTools grant is
 * narrowed by the transport: presence of userId/idempotencyKey is guaranteed
 * before dispatch. */
export type HostToolCallContext = {
  grant: RunTokenGrant;
  hostTools: RunHostToolsGrant;
  input: unknown;
  signal: AbortSignal;
};

export type HostToolResult = {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
};

export type HostTool = (
  context: HostToolCallContext
) => Promise<HostToolResult>;

export type HostToolsRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void>;

export function createHostToolsHandler(options: {
  tools: Record<string, HostTool>;
  tokens: RunTokenRegistry;
  audit?: HostToolsAuditSink;
  now?: () => number;
}): HostToolsRequestHandler {
  const { audit } = options;
  const now = options.now ?? Date.now;
  return async (req, res) => {
    res.on("error", () => undefined);
    const url = new URL(req.url ?? "/", "http://host-tools.local");
    const tool = url.pathname.slice(HOST_TOOLS_PATH_PREFIX.length);
    const deny = async (
      status: number,
      code: string,
      message: string,
      runId: string | null,
      chatId: string | null
    ) => {
      await recordAudit(audit, {
        chatId,
        errorCode: code,
        runId,
        status: "denied",
        tool: tool || "<unknown>",
      });
      sendJson(res, status, { error: { code, message }, ok: false });
    };
    if (req.method !== "POST" || !tool || tool.includes("/")) {
      await deny(
        404,
        "not_found",
        "host tools bridge only serves POST /host-tools/<name>",
        null,
        null
      );
      return;
    }
    const impl = options.tools[tool];
    if (!impl) {
      await deny(404, "not_found", `unknown host tool: ${tool}`, null, null);
      return;
    }
    const tokenMatch = /^Bearer\s+(\S+)$/iu.exec(
      req.headers.authorization ?? ""
    );
    const grant = tokenMatch ? options.tokens.validate(tokenMatch[1]) : null;
    if (!grant) {
      await deny(
        401,
        "unauthorized",
        "invalid or expired run token",
        null,
        null
      );
      return;
    }
    const { hostTools } = grant;
    if (!hostTools?.tools.includes(tool)) {
      await deny(
        403,
        "tool_not_allowed",
        `host tool "${tool}" is not granted to this run`,
        grant.runId,
        grant.chatId
      );
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      await deny(
        413,
        "payload_too_large",
        "request body exceeds limit",
        grant.runId,
        grant.chatId
      );
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(body) as unknown;
    } catch {
      await deny(
        400,
        "bad_request",
        "request body is not valid JSON",
        grant.runId,
        grant.chatId
      );
      return;
    }

    // Disconnect awareness (same contract as the /messages route): an HTTP
    // disconnect aborts this call only; the browser chat stream detaching a
    // subscription never reaches here.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });

    const startedAt = now();
    try {
      const result = await impl({
        grant,
        hostTools,
        input,
        signal: abort.signal,
      });
      sendJson(res, 200, { ok: true, result });
      await recordAudit(audit, {
        chatId: grant.chatId,
        durationMs: now() - startedAt,
        runId: grant.runId,
        status: "allowed",
        tool,
      });
    } catch (error) {
      if (error instanceof HostToolsError) {
        sendJson(res, 200, {
          error: { code: error.code, message: error.message },
          ok: false,
        });
        await recordAudit(audit, {
          chatId: grant.chatId,
          durationMs: now() - startedAt,
          errorCode: abort.signal.aborted ? "aborted" : error.code,
          runId: grant.runId,
          status: "error",
          tool,
        });
        return;
      }
      // Unexpected failures never leak internals; details stay in host logs.
      console.error("[host-tools] unexpected tool failure", {
        chatId: grant.chatId,
        error: error instanceof Error ? error.message : String(error),
        runId: grant.runId,
        tool,
      });
      sendJson(res, 200, {
        error: {
          code: "internal_error",
          message: `host tool "${tool}" failed`,
        },
        ok: false,
      });
      await recordAudit(audit, {
        chatId: grant.chatId,
        durationMs: now() - startedAt,
        errorCode: "internal_error",
        runId: grant.runId,
        status: "error",
        tool,
      });
    }
  };
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowing = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowing) {
        // Keep draining so the 413 response stays deliverable.
        return;
      }
      total += chunk.length;
      if (total > HOST_TOOLS_MAX_BODY_BYTES) {
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify(payload));
}

async function recordAudit(
  sink: HostToolsAuditSink | undefined,
  entry: HostToolsAuditEntry
): Promise<void> {
  try {
    await sink?.record(entry);
  } catch {
    // Audit failures never block request handling.
  }
}
