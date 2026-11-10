import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decode, encode } from "next-auth/jwt";
import postgres from "postgres";
import { hashDesktopSecret } from "../../lib/auth/desktop-login";

const { AUTH_SECRET, POSTGRES_URL } = process.env;
assert.ok(
  AUTH_SECRET && POSTGRES_URL,
  "Set AUTH_SECRET and POSTGRES_URL for the local test server"
);
const base = process.env.DESKTOP_TEST_URL ?? "http://localhost:3000";
const db = postgres(POSTGRES_URL, { max: 1 });
const userId = crypto.randomUUID(),
  memberId = crypto.randomUUID();
const state = randomBytes(32).toString("base64url"),
  verifier = randomBytes(32).toString("base64url");
const challenge = hashDesktopSecret(verifier);
const cookieName = `${base.startsWith("https:") ? "__Secure-" : ""}authjs.session-token`;
const browserToken = await encode({
  salt: cookieName,
  secret: AUTH_SECRET,
  token: {
    email: "desktop-login@test.local",
    id: userId,
    sub: userId,
    type: "regular",
  },
});
const headers = {
  "content-type": "application/json",
  cookie: `${cookieName}=${browserToken}`,
  origin: base,
};
const authorize = (extra = {}) =>
  fetch(`${base}/api/auth/desktop/authorize`, {
    body: JSON.stringify({ challenge, state }),
    headers: { ...headers, ...extra },
    method: "POST",
  });
const exchange = (code: string, proof = verifier) =>
  fetch(`${base}/api/auth/desktop/exchange`, {
    body: JSON.stringify({ code, verifier: proof }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
const grant = async () => {
  const response = await authorize();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { callback } = await response.json();
  const url = new URL(callback);
  assert.equal(url.origin, "null");
  assert.equal(url.protocol, "piwork:");
  assert.equal(url.host, "auth");
  assert.equal(url.pathname, "/callback");
  assert.equal(url.searchParams.get("state"), state);
  assert.ok(!callback.includes(browserToken));
  const code = url.searchParams.get("code");
  assert.ok(code);
  return code;
};
try {
  await db`insert into "User" (id,email) values (${userId},${`${userId}@test.local`})`;
  await db`insert into "Member" (id,"userId",role) values (${memberId},${userId},'member')`;
  assert.equal((await authorize({ cookie: "" })).status, 401);
  assert.equal((await authorize({ origin: "https://evil.test" })).status, 403);
  const target = `/desktop-login?challenge=${challenge}&state=${state}`;
  const loginRedirect = await fetch(base + target, { redirect: "manual" });
  assert.equal(loginRedirect.status, 307);
  const location = new URL(loginRedirect.headers.get("location") ?? "", base);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("callbackUrl"), target);
  const resume = await fetch(
    `${base}/login?callbackUrl=${encodeURIComponent(target)}`,
    { headers, redirect: "manual" }
  );
  assert.equal(
    new URL(resume.headers.get("location") ?? "", base).pathname,
    "/desktop-login"
  );
  const code = await grant();
  assert.equal(
    (await exchange(code, randomBytes(32).toString("base64url"))).status,
    401
  );
  const results = await Promise.all([exchange(code), exchange(code)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const response = results.find((r) => r.status === 200);
  assert.ok(response);
  const session = await response.json();
  assert.equal(session.name, cookieName);
  assert.notEqual(session.value, browserToken);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const decoded = await decode({
    salt: session.name,
    secret: AUTH_SECRET,
    token: session.value,
  });
  assert.equal(decoded?.id, userId);
  assert.equal(decoded?.type, "regular");
  const identity = await fetch(`${base}/api/auth/session`, {
    headers: { cookie: `${session.name}=${session.value}` },
  });
  assert.equal((await identity.json()).user.id, userId);
  const expired = await grant();
  await db`update "DesktopLoginGrant" set "expiresAt"=${new Date(Date.now() - 120_000).toISOString()}::timestamp where "codeHash"=${hashDesktopSecret(expired)}`;
  assert.equal((await exchange(expired)).status, 401);
  const disabled = await grant();
  await db`update "Member" set status='disabled' where id=${memberId}`;
  assert.equal((await exchange(disabled)).status, 403);
  assert.equal((await authorize()).status, 403);
  console.log(
    "Desktop login HTTP passed: redirect continuity, CSRF, PKCE, atomic replay rejection, expiry, session and disabled accounts"
  );
} finally {
  await db`delete from "DesktopLoginGrant" where "userId"=${userId}`;
  await db`delete from "Member" where id=${memberId}`;
  await db`delete from "User" where id=${userId}`;
  await db.end();
}
