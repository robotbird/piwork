import assert from "node:assert/strict";
import { encode } from "next-auth/jwt";
import postgres from "postgres";

const { AUTH_SECRET, POSTGRES_URL } = process.env;
assert.ok(
  AUTH_SECRET && POSTGRES_URL,
  "Set AUTH_SECRET and POSTGRES_URL for the test server"
);
const db = postgres(POSTGRES_URL, { max: 1 });
const base = process.env.DESKTOP_TEST_URL ?? "http://127.0.0.1:43876";
const user = crypto.randomUUID(),
  member = crypto.randomUUID(),
  role = crypto.randomUUID(),
  runId = crypto.randomUUID();
const token = await encode({
  salt: "authjs.session-token",
  secret: AUTH_SECRET,
  token: { email: "desktop@test.local", id: user, sub: user, type: "regular" },
});
const cookie = `authjs.session-token=${token}`;
const payload = {
  context: {
    messages: [
      { content: "Reply with Hello.", role: "user", timestamp: Date.now() },
    ],
  },
  model: "",
  options: {},
  runId,
};
const send = (body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/desktop/inference/messages`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie,
      "x-piwork-desktop": "1",
      ...extra,
    },
    method: "POST",
  });
try {
  await db`insert into "User" (id,email) values (${user},'desktop@test.local')`;
  await db`insert into "Member" (id,"userId",role) values (${member},${user},'member')`;
  await db`insert into "Role" (id,name) values (${role},${`desktop-${role}`})`;
  await db`insert into "MemberRole" ("memberId","roleId") values (${member},${role})`;
  const sync = await fetch(`${base}/api/desktop/sync/status`, {
    headers: { cookie, "x-piwork-desktop": "1" },
  });
  assert.equal(
    sync.status,
    503,
    "Run this test with PIWORK_DESKTOP_SYNC_ENABLED unset or disabled"
  );
  const catalog = await fetch(`${base}/api/models`, { headers: { cookie } });
  assert.equal(catalog.status, 200);
  const { models, defaultModelId } = await catalog.json();
  payload.model = process.env.DESKTOP_TEST_MODEL ?? defaultModelId;
  assert.ok(
    models.some((model: { id: string }) => model.id === payload.model),
    "Test model is not available in the account catalog"
  );
  assert.equal(
    (await fetch(`${base}/api/desktop/inference/messages`, { method: "POST" }))
      .status,
    401
  );
  assert.equal((await send(payload, { "x-piwork-desktop": "0" })).status, 401);
  assert.equal(
    (await send({ ...payload, model: "unknown/unknown" })).status,
    403
  );
  const response = await send(payload);
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /"type":"done"/);
  assert.match(events, /Hello/);
  const records =
    await db`select "totalTokens" from "DesktopInferenceUsage" where "userId"=${user}`;
  assert.equal(records.length, 1);
  assert.notEqual(records[0].totalTokens, null);
  await db`update "Role" set "tokenPolicy"=${db.json({ action: "block", daily: 1, monthly: null, perRun: null })} where id=${role}`;
  await db`update "DesktopInferenceUsage" set "totalTokens"=10 where "userId"=${user}`;
  assert.equal((await send(payload)).status, 429);
  console.log(
    "Desktop inference with history sync disabled: authorization, streaming, persisted usage and quota enforcement passed"
  );
} finally {
  await db`delete from "User" where id=${user}`;
  await db`delete from "Role" where id=${role}`;
  await db.end();
}
