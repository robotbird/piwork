import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("preview/install/discard HTTP requires admin, rejects forged DTOs and binds actor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "piwork-skill-install-route-"));
  const state = { admin: false, calls: [] as unknown[], fail: "" };
  const scope = globalThis as typeof globalThis & {
    skillInstallRouteFixture?: typeof state;
  };
  scope.skillInstallRouteFixture = state;
  try {
    const outfile = join(dir, "route.mjs");
    await build({
      bundle: true,
      entryPoints: ["app/(admin)/api/admin/skills/install/route.ts"],
      format: "esm",
      outfile,
      platform: "node",
      plugins: [
        {
          name: "skill-install-trusted-fixture",
          setup(builder) {
            builder.onResolve(
              {
                filter:
                  /^(@\/lib\/(admin\/(access|skill-installation-runtime)|ai\/skills|errors|i18n\/messages)|next-intl\/server)$/,
              },
              (args) => ({ namespace: "fixture", path: args.path })
            );
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
              const preamble =
                "const state = globalThis.skillInstallRouteFixture;";
              const contents =
                args.path === "next-intl/server"
                  ? "export async function getTranslations(){return (key)=>key;}"
                  : args.path.endsWith("/access")
                    ? "export async function requireAdminRole(){return state.admin ? {userId:'trusted-admin'} : null;}"
                    : args.path.endsWith("/errors")
                      ? "export class ChatbotError {toResponse(){return Response.json({error:'unauthorized'},{status:401});}}"
                      : args.path.endsWith("/skills")
                        ? "export class SkillArchiveDownloadError extends Error {}"
                        : args.path.endsWith("/messages")
                          ? "export class LocalizedError extends Error {}"
                          : `export function getSkillInstallationService(){return {
                  async preview(actor,url){state.calls.push({actor,url,action:'preview'}); if(state.fail) throw Error('secret-fixture'); return {token:'fixture-token', candidates:[]};},
                  async install(actor,token,selectedIds){state.calls.push({actor,token,selectedIds,action:'install'});return [{id:selectedIds[0],name:'alpha',status:'installed'}];},
                  discard(actor,token){state.calls.push({actor,token,action:'discard'});}
                };}`;
              return { contents: preamble + contents, loader: "js" };
            });
          },
        },
      ],
    });
    const { POST, DELETE } = await import(outfile);
    const token = "11111111-1111-4111-8111-111111111111";
    const id = "a".repeat(64);
    const request = (body: unknown) =>
      new Request("http://localhost/api/admin/skills/install", {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    assert.equal(
      (
        await POST(
          request({
            action: "preview",
            installUrl: "https://example.com/a.zip",
          })
        )
      ).status,
      401
    );
    assert.equal((await DELETE(request({ token }))).status, 401);
    assert.deepEqual(state.calls, []);
    state.admin = true;
    for (const body of [
      { action: "preview", installUrl: "x", userId: "forged" },
      { action: "install", paths: ["../../escape"], selectedIds: [id], token },
      { action: "install", selectedIds: [], token },
      { action: "install", selectedIds: [id], token: "bad" },
      { action: "install", selectedIds: ["../../escape"], token },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered HTTP boundary cases
      assert.equal((await POST(request(body))).status, 400);
    }
    assert.deepEqual(state.calls, []);
    const preview = await POST(
      request({ action: "preview", installUrl: "https://example.com/a.zip" })
    );
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(state.calls[0], {
      action: "preview",
      actor: "trusted-admin",
      url: "https://example.com/a.zip",
    });
    const installed = await POST(
      request({ action: "install", selectedIds: [id], token })
    );
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).results[0].status, "installed");
    assert.deepEqual(state.calls[1], {
      action: "install",
      actor: "trusted-admin",
      selectedIds: [id],
      token,
    });
    assert.equal((await DELETE(request({ token }))).status, 204);
    assert.equal(
      (await DELETE(request({ token, userId: "forged" }))).status,
      400
    );
    state.fail = "yes";
    const failure = await POST(
      request({ action: "preview", installUrl: "https://example.com/a.zip" })
    );
    assert.equal(failure.status, 500);
    assert.doesNotMatch(await failure.text(), /secret-fixture/);
    assert.equal(
      (
        await POST(
          new Request("http://localhost", { body: "{", method: "POST" })
        )
      ).status,
      400
    );
  } finally {
    scope.skillInstallRouteFixture = undefined;
    await rm(dir, { force: true, recursive: true });
  }
});
