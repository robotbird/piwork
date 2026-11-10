import type { Context, Provider } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { auth } from "@/app/(auth)/auth";
import { getActivePiProviders, getPiModel } from "@/lib/ai/pi";
import { authorizeRoleRun, checkUserTokenQuota } from "@/lib/ai/role-access";
import {
  createDesktopInferenceUsage,
  finishDesktopInferenceUsage,
} from "@/lib/db/desktop-inference-queries";
import { ChatbotError } from "@/lib/errors";
import { toPiMessagesEvent } from "@/lib/runtime/inference-proxy/events";

const maxBytes = 32 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // Account inference also serves local chats with history sync disabled.
  const current = await auth();
  if (
    request.headers.get("x-piwork-desktop") !== "1" ||
    current?.user?.type !== "regular"
  ) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    return new Response(null, { status: 413 });
  }
  let body: {
    model?: unknown;
    context?: unknown;
    options?: Record<string, unknown>;
    runId?: unknown;
  };
  try {
    const reader = request.body?.getReader();
    if (!reader) {
      throw new Error("Missing body");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: request chunks must be read sequentially and bounded.
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(part.value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof body.model !== "string" ||
      typeof body.runId !== "string" ||
      !uuid.test(body.runId) ||
      !body.context ||
      typeof body.context !== "object" ||
      !Array.isArray((body.context as Context).messages)
    ) {
      throw new Error("Invalid request");
    }
  } catch {
    return new Response(null, { status: 400 });
  }
  const separator = (body.model as string).indexOf("/");
  if (separator < 1 || separator === (body.model as string).length - 1) {
    return new Response(null, { status: 400 });
  }
  const providerId = (body.model as string).slice(0, separator);
  const modelId = (body.model as string).slice(separator + 1);
  try {
    await authorizeRoleRun(current.user.id, {
      id: modelId,
      provider: providerId,
    });
    await checkUserTokenQuota(current.user.id, body.runId as string);
    const model = await getPiModel(body.model as string);
    const provider = (await getActivePiProviders()).find(
      (item) => item.id === providerId
    ) as Provider | undefined;
    if (!provider) {
      return new Response(null, { status: 503 });
    }
    const context = normalizeContext(body.context as Context);
    const recordId = await createDesktopInferenceUsage(
      current.user.id,
      body.runId as string
    );
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), {
      once: true,
    });
    const options: Record<string, unknown> = { signal: abort.signal };
    for (const key of [
      "temperature",
      "maxTokens",
      "reasoning",
      "cacheRetention",
      "sessionId",
      "toolChoice",
    ]) {
      if (body.options?.[key] !== undefined) {
        options[key] = body.options[key];
      }
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        abort.abort();
      },
      async start(controller) {
        let terminal = false;
        try {
          for await (const event of provider.stream(model, context, options)) {
            if (event.type === "done" || event.type === "error") {
              terminal = true;
              const usage =
                event.type === "done" ? event.message.usage : event.error.usage;
              if (
                usage &&
                Number.isSafeInteger(usage.totalTokens) &&
                usage.totalTokens >= 0 &&
                Number.isSafeInteger(usage.input) &&
                usage.input >= 0 &&
                Number.isSafeInteger(usage.output) &&
                usage.output >= 0
              ) {
                await finishDesktopInferenceUsage(recordId, usage);
              }
            }
            const wire = toPiMessagesEvent(event);
            if (wire) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(wire)}\n\n`)
              );
            }
            if (terminal) {
              break;
            }
          }
          if (terminal) {
            controller.close();
          } else {
            controller.error(
              new Error("Inference ended without a terminal event")
            );
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    return new Response(null, { status: 503 });
  }
}
