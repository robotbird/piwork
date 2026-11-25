import "../support/db-env";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { encode } from "next-auth/jwt";
import { createProjectDocumentDatabase } from "../support/project-documents/database";

const sourceUrl = process.env.POSTGRES_URL;
assert.ok(sourceUrl);
const database = await createProjectDocumentDatabase(sourceUrl);
const secret = crypto.randomUUID();
const userId = crypto.randomUUID();
const email = `${userId}@test.local`;
const port = process.env.PIWORK_MODEL_ACTIVATION_HTTP_PORT ?? "3026";
const base = `http://localhost:${port}`;
const root = path.join(".next", `model-activation-${userId}`);
const originalNextDeclaration = await readFile("next-env.d.ts", "utf8");
await mkdir(root, { recursive: true });
await writeFile(
  path.join(root, "tsconfig.json"),
  JSON.stringify({ extends: "../../tsconfig.json" })
);
const log = await open(path.join(root, "server.log"), "wx");
const outputLimits: { model: string; maxTokens: number }[] = [];
const upstream = createServer(async (incoming, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(chunk);
  }
  const { model, max_tokens: maxTokens } = JSON.parse(
    Buffer.concat(chunks).toString()
  );
  outputLimits.push({ maxTokens, model });
  const events = [
    {
      message: {
        id: "msg_test",
        model,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      type: "message_start",
    },
    {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { text: `Reply from ${model}`, type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    },
    { index: 0, type: "content_block_stop" },
    {
      delta: { stop_reason: "end_turn" },
      type: "message_delta",
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  response
    .writeHead(200, { "Content-Type": "text/event-stream" })
    .end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join("")
    );
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}/api/anthropic`;
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--port", port],
  {
    detached: true,
    env: {
      ...process.env,
      AUTH_SECRET: secret,
      AUTH_TRUST_HOST: "true",
      AUTH_URL: base,
      NEXT_DIST_DIR: path.join(root, "build"),
      NEXT_TSCONFIG_PATH: path.join(root, "tsconfig.json"),
      NEXTAUTH_URL: base,
      NODE_ENV: "development",
      PIWORK_SANDBOX_PROVIDER: "",
      PLAYWRIGHT: "",
      POSTGRES_URL: database.url,
      SCHEDULED_TASKS_ENABLED: "false",
    },
    stdio: ["ignore", log.fd, log.fd],
  }
);
const exited = once(server, "exit");
const token = await encode({
  salt: "authjs.session-token",
  secret,
  token: { email, id: userId, sub: userId, type: "regular" },
});
const request = (url: string, body?: unknown) =>
  fetch(`${base}${url}`, {
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), method: "POST" }),
    headers: {
      "Content-Type": "application/json",
      Cookie: `authjs.session-token=${token}`,
    },
    signal: AbortSignal.timeout(45_000),
  });
const addModel = async (modelId: string) => {
  const response = await request("/api/admin/model-plugins/custom", {
    api: "anthropic-messages",
    apiKey: "test-key",
    endpoint,
    modelId,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { id } = await response.json();
  return `installation:${id}/${modelId}`;
};
const chat = async (modelId: string, selectedChatModel: string) => {
  const response = await request("/api/chat", {
    id: crypto.randomUUID(),
    message: {
      id: crypto.randomUUID(),
      parts: [{ text: "你好", type: "text" }],
      role: "user",
    },
    selectedChatModel,
    selectedVisibilityType: "private",
  });
  const stream = await response.text();
  assert.equal(response.status, 200, stream);
  assert.match(stream, new RegExp(`"delta":"Reply from ${modelId}"`));
  assert.doesNotMatch(stream, /"type":"error"/);
};
try {
  await database.sql`insert into "User" (id, email) values (${userId}, ${email})`;
  await database.sql`insert into "Member" ("userId", role, status) values (${userId}, 'admin', 'enabled')`;
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (!ready && Date.now() < deadline && server.exitCode === null) {
    // biome-ignore lint/performance/noAwaitInLoops: Poll the dedicated dev server until ready.
    ready = await request("/api/models")
      .then((response) => response.ok)
      .catch(() => false);
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.ok(ready, "isolated server did not start");
  await chat("warm-model", await addModel("warm-model"));
  const model = await addModel("new-model");
  const catalog = await (await request("/api/models")).json();
  assert.ok(catalog.models.some((entry: { id: string }) => entry.id === model));
  await chat("new-model", model);
  const installationId = model.split("/")[0].slice("installation:".length);
  const patch = async (contextWindows: unknown) =>
    fetch(`${base}/api/admin/model-plugins/${installationId}`, {
      body: JSON.stringify({ contextWindows }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `authjs.session-token=${token}`,
      },
      method: "PATCH",
    });
  assert.equal((await patch({ "new-model": 6000 })).status, 200);
  const view = await (await request("/api/admin/model-plugins")).json();
  const saved = view.installed.find(
    (entry: { id: string }) => entry.id === installationId
  );
  assert.equal(saved.models[0].properties.contextSize, 6000);
  assert.equal(saved.defaultBaseUrl, endpoint);
  assert.equal((await patch({ "new-model": -1 })).status, 400);
  assert.equal((await patch({ "unknown-model": 6000 })).status, 400);
  await chat("new-model", model);

  const lastOutputLimit = outputLimits.findLast(
    (entry) => entry.model === "new-model" && entry.maxTokens <= 6000
  )?.maxTokens;
  assert.ok(
    lastOutputLimit !== undefined &&
      lastOutputLimit > 0 &&
      lastOutputLimit <= 6000
  );
  console.log(
    "PASS: a custom Anthropic model added after the RunManager warmed up can immediately stream a chat reply"
  );
} catch (error) {
  console.error(
    (await readFile(path.join(root, "server.log"), "utf8")).slice(-6000)
  );
  throw error;
} finally {
  if (server.pid && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM");
    await exited;
  }
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await log.close();
  await database.close();
  if ((await readFile("next-env.d.ts", "utf8")).includes(root)) {
    await writeFile("next-env.d.ts", originalNextDeclaration);
  }
  await rm(root, { force: true, recursive: true });
}
