import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron, chromium, expect } from "@playwright/test";
import { hash } from "bcrypt-ts";
import postgres from "postgres";

const base = process.env.DESKTOP_TEST_URL ?? "http://localhost:3000";
const desktop = process.env.DESKTOP_REPO ?? path.resolve("../piwork-desktop");
const profile = await mkdtemp(path.join(os.tmpdir(), "piwork-browser-login-"));
assert.ok(process.env.POSTGRES_URL);
const db = postgres(process.env.POSTGRES_URL, { max: 1 });
const userId = crypto.randomUUID(),
  memberId = crypto.randomUUID();
const email = `${userId}@test.local`,
  password = crypto.randomUUID();
const launch = (callback?: string) =>
  _electron.launch({
    args: [
      path.join(desktop, "apps/desktop"),
      `--user-data-dir=${profile}`,
      ...(callback ? [callback] : []),
    ],
    env: { ...process.env, VITE_DEV_SERVER_URL: "" },
    executablePath: path.join(
      desktop,
      "apps/desktop/node_modules/.bin/electron"
    ),
  });
let app: Awaited<ReturnType<typeof launch>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await db`insert into "User" (id,email,password,name) values (${userId},${email},${await hash(password, 10)},'Browser login tester')`;
  await db`insert into "Member" (id,"userId",role) values (${memberId},${userId},'member')`;
  app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.evaluate(() =>
    (window as any).desktop.setPreferences({
      appearance: "light",
      language: "en",
    })
  );
  await page.reload();
  await page.getByRole("button", { exact: false, name: "Settings" }).click();
  await page.getByRole("menuitem", { exact: true, name: "Settings" }).click();
  await page.getByRole("button", { name: "Account & sync" }).click();
  const settings = page.getByRole("main", { name: "Settings" });
  await settings.getByLabel("PiWork server URL").fill(base);
  // Capture the external launch while exercising the production IPC and URL handler.
  await app.evaluate(({ shell }) => {
    shell.openExternal = (externalUrl) => {
      (globalThis as any).__browserLoginUrl = externalUrl;
      return Promise.resolve();
    };
  });
  await settings.getByRole("button", { name: "Sign in with browser" }).click();
  await settings
    .getByRole("status")
    .filter({ hasText: "Waiting for browser" })
    .waitFor();
  assert.equal(
    (await app.windows()).length,
    1,
    "Login must not open an embedded browser window"
  );
  const url = await app.evaluate(
    () => (globalThis as any).__browserLoginUrl as string
  );
  assert.equal(new URL(url).origin, base);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  let web = await context.newPage();
  web.on("pageerror", (error) =>
    console.log("Browser page error:", error.message)
  );
  await web.goto(url);
  await expect(web).toHaveURL(/\/login\?callbackUrl=/);
  await web.locator("#email").fill(email);
  await web.locator("#password").fill(password);
  await web.locator('form button[type="submit"]').click();
  await expect(web).toHaveURL(/\/desktop-login\?/);
  await expect(web.getByText(email, { exact: true })).toBeVisible();
  await web.waitForLoadState("networkidle");
  const authorized = web.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/desktop/authorize") &&
      r.request().method() === "POST"
  );
  await web
    .getByRole("button", { name: /登录并打开|Sign in and open/ })
    .click();
  const { callback } = await (await authorized).json();
  assert.ok(callback.startsWith("piwork://auth/callback?"));
  await expect(
    web.getByRole("link", { name: /打开 PiWork 客户端|Open PiWork desktop/ })
  ).toBeVisible();
  const invalid = new URL(callback);
  invalid.searchParams.set("state", "a".repeat(43));
  await app.evaluate(
    ({ app: electronApp }, link) =>
      electronApp.emit(
        "open-url",
        {
          preventDefault() {
            /* Simulate the OS event. */
          },
        },
        link
      ),
    invalid.href
  );
  assert.equal(
    (await page.evaluate(() => (window as any).desktop.accountStatus())).user,
    null
  );
  await app.evaluate(
    ({ app: electronApp }, link) =>
      electronApp.emit(
        "open-url",
        {
          preventDefault() {
            /* Simulate the OS event. */
          },
        },
        link
      ),
    callback
  );
  await settings.getByText("Browser login tester", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => (window as any).desktop.accountStatus())).user
      ?.id,
    userId
  );
  const cookies = await app.evaluate(async ({ session }) =>
    session.fromPartition("persist:piwork-account").cookies.get({})
  );
  assert.ok(
    cookies.some((c) => c.httpOnly && c.name === "authjs.session-token")
  );
  await settings.getByRole("button", { exact: true, name: "Sign out" }).click();
  await expect(settings.getByText("Signed out", { exact: true })).toBeVisible();
  assert.equal(
    (await (await context.request.get(`${base}/api/auth/session`)).json()).user
      .id,
    userId,
    "Desktop logout must preserve the website session"
  );
  // Existing website sessions skip password entry; pending PKCE survives a client restart.
  await settings.getByRole("button", { name: "Sign in with browser" }).click();
  await expect
    .poll(() =>
      app?.evaluate(() => (globalThis as any).__browserLoginUrl as string)
    )
    .not.toBe(url);
  const secondUrl = await app.evaluate(
    () => (globalThis as any).__browserLoginUrl as string
  );
  await web.close();
  web = await context.newPage();
  await web.goto(secondUrl);
  await expect(web).toHaveURL(/\/desktop-login\?/);
  await web.waitForLoadState("networkidle");
  await expect(
    web.getByRole("button", { name: /登录并打开|Sign in and open/ })
  ).toBeVisible();
  console.log("Testing website session reuse and cold callback");
  const [secondAuth] = await Promise.all([
    web.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/desktop/authorize") &&
        r.request().method() === "POST"
    ),
    web
      .getByRole("button", { name: /登录并打开|Sign in and open/ })
      .click({ timeout: 10_000 }),
  ]);
  const secondCallback = (await secondAuth.json()).callback;
  await app.close();
  app = await launch(secondCallback);
  const restarted = await app.firstWindow();
  await expect
    .poll(
      async () =>
        (
          await restarted.evaluate(() =>
            (window as any).desktop.accountStatus()
          )
        ).user?.id
    )
    .toBe(userId);
  assert.equal(
    (await restarted.evaluate(() => (window as any).desktop.accountStatus()))
      .loginPending,
    false
  );
  await app.evaluate(
    ({ app: electronApp }, link) =>
      electronApp.emit(
        "open-url",
        {
          preventDefault() {
            /* Simulate the OS event. */
          },
        },
        link
      ),
    secondCallback
  );
  assert.equal(
    (await restarted.evaluate(() => (window as any).desktop.accountStatus()))
      .user?.id,
    userId
  );
  console.log(
    "Browser + Electron passed: password login, website-session reuse, automatic account update, invalid callback, HttpOnly storage, independent logout, cold callback and replay"
  );
} finally {
  await app?.close().catch(() => undefined);
  await browser?.close();
  await rm(profile, { force: true, recursive: true });
  await db`delete from "DesktopLoginGrant" where "userId"=${userId}`;
  await db`delete from "Member" where id=${memberId}`;
  await db`delete from "User" where id=${userId}`;
  await db.end();
}
