// Isolated skill-install UI contract. No real identity/DB/model; /api/admin/skills is route-mocked.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import tailwindcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { zipSync } from "fflate";
import postcss from "postcss";
import { SKILL_LIMITS } from "../../lib/ai/skill-limits";

const dir = await mkdtemp(join(tmpdir(), "piwork-skill-install-ui-"));
const server = createServer(async (request, response) => {
  const file = ["/preview.js", "/preview.css"].includes(request.url ?? "")
    ? (request.url ?? "").slice(1)
    : "index.html";
  response.setHeader(
    "content-type",
    file.endsWith("js")
      ? "text/javascript"
      : file.endsWith("css")
        ? "text/css"
        : "text/html"
  );
  response.end(await readFile(join(dir, file)));
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const linkInstalls: Array<{ token: string; selectedIds: string[] }> = [];
const previewRequests: string[] = [];
let expireNextInstall = false;
const previewCandidates = [
  {
    description: "First skill",
    fileCount: 13_018,
    id: "a".repeat(64),
    issue: null,
    name: "alpha",
    path: "repo/skills/alpha",
    totalBytes: 1024,
  },
  {
    description: "Second skill",
    fileCount: 3,
    id: "b".repeat(64),
    issue: null,
    name: "beta",
    path: "repo/skills/beta",
    totalBytes: 2048,
  },
  {
    description: "Third skill",
    fileCount: 1,
    id: "c".repeat(64),
    issue: null,
    name: "gamma",
    path: "repo/skills/gamma",
    totalBytes: 512,
  },
  {
    description: "Too many files",
    fileCount: SKILL_LIMITS.files + 1,
    id: "d".repeat(64),
    issue: "fileCount",
    name: "oversized",
    path: "repo/skills/oversized",
    totalBytes: 37 * 1024 * 1024,
  },
  {
    description: "Already installed",
    fileCount: 1,
    id: "e".repeat(64),
    issue: "installed",
    name: "existing",
    path: "repo/skills/existing",
    totalBytes: 512,
  },
];
const archiveInstalls: (string | undefined)[] = [];
try {
  await build({
    alias: {
      "next/navigation": resolve("tests/support/i18n/navigation.ts"),
    },
    bundle: true,
    define: {
      "process.env": "{}",
      "process.env.NEXT_PUBLIC_BASE_PATH": '""',
      "process.env.NODE_ENV": '"development"',
    },
    entryPoints: ["tests/support/skill-install-preview.tsx"],
    jsx: "automatic",
    outfile: join(dir, "preview.js"),
    platform: "browser",
  });
  const css = await postcss([tailwindcss()]).process(
    await readFile("app/globals.css", "utf8"),
    { from: "app/globals.css" }
  );
  await writeFile(join(dir, "preview.css"), css.css);
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script src="/preview.js"></script></body></html>'
  );
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { height: 880, width: 1180 },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/admin/skills/install", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      await route.fulfill({ status: 204 });
      return;
    }
    const body = request.postDataJSON();
    if (body.action === "preview") {
      previewRequests.push(body.installUrl);
      if (body.installUrl.includes("no-skill")) {
        await route.fulfill({
          json: { error: "No SKILL.md found" },
          status: 400,
        });
        return;
      }
      await route.fulfill({
        json: {
          candidates: previewCandidates,
          expiresAt: Date.now() + 300_000,
          token: "11111111-1111-4111-8111-111111111111",
        },
      });
      return;
    }
    linkInstalls.push({ selectedIds: body.selectedIds, token: body.token });
    if (expireNextInstall) {
      expireNextInstall = false;
      await route.fulfill({ json: { error: "Preview expired" }, status: 409 });
      return;
    }
    const results = body.selectedIds.map((id: string) => ({
      id,
      issue:
        linkInstalls.length === 1 && id === "b".repeat(64)
          ? "failed"
          : undefined,
      name: previewCandidates.find((item) => item.id === id)?.name,
      status:
        linkInstalls.length === 1 && id === "b".repeat(64)
          ? "failed"
          : "installed",
    }));
    await route.fulfill({ json: { results } });
  });
  await page.route("**/api/admin/skills", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      archiveInstalls.push(request.postData());
      await route.fulfill({ json: { name: "fixture-zip-skill" }, status: 201 });
      return;
    }
    await route.fulfill({
      json: {
        skills: [
          {
            description: "整理零散会议记录并产出可分发纪要。",
            displayName: "会议纪要",
            enabled: true,
            name: "meeting-notes",
            source: "upload",
            version: "1.0.0",
          },
        ],
      },
    });
  });
  await page.route("**/api/admin/skills/meeting-notes**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path) {
      await route.fulfill({
        json: {
          file: {
            content: "Fixture skill file",
            encoding: "text",
            mimeType: "text/plain",
            path,
            size: 18,
            truncated: false,
          },
        },
      });
    } else {
      await route.fulfill({
        json: {
          entries: [
            { kind: "file", name: "SKILL.md", path: "SKILL.md", size: 18 },
            { kind: "directory", name: "assets", path: "assets", size: 0 },
            ...Array.from({ length: 600 }, (_, index) => ({
              kind: "file",
              name: `template-${index}.txt`,
              path: `assets/template-${index}.txt`,
              size: 10,
            })),
          ],
          truncated: true,
        },
      });
    }
  });
  await page.goto(`http://127.0.0.1:${address.port}`);

  // 入口按钮文案为「安装 Skill」
  const openInstall = page.getByRole("button", {
    exact: true,
    name: "安装 Skill",
  });
  await expect(openInstall).toBeVisible();
  await openInstall.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const linkTab = dialog.getByRole("tab", { name: "链接" });
  const archiveTab = dialog.getByRole("tab", { name: "压缩包" });
  const marketplaceTab = dialog.getByRole("tab", { name: "第三方市场" });
  await expect(linkTab).toBeVisible();
  await expect(archiveTab).toBeVisible();
  await expect(marketplaceTab).toBeVisible();
  await expect(linkTab).toHaveAttribute("aria-selected", "true");

  // 链接识别状态
  const urlInput = dialog.getByRole("textbox");
  await urlInput.fill("https://gitlab.com/team/repo");
  await expect(dialog.getByText("无法识别的链接类型")).toBeVisible();
  await urlInput.fill("https://github.com/e2e-works/demo-skill");
  await expect(dialog.getByText("已识别：GitHub 仓库")).toBeVisible();
  await expect(dialog.locator('[role="tab"][aria-selected="true"]')).toHaveText(
    "链接"
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/skill-install-link.png",
  });

  // Parse first, show all roots, and install only the explicitly selected subset.
  await urlInput.fill("https://github.com/e2e-works/demo-skill/tree/v2");
  await dialog.getByRole("button", { exact: true, name: "解析链接" }).click();
  await expect(dialog.getByText("发现 5 个 Skill")).toBeVisible();
  assert.equal(
    previewRequests[0],
    "https://github.com/e2e-works/demo-skill/tree/v2"
  );
  await expect(
    dialog.getByRole("checkbox", { exact: true, name: "选择 alpha" })
  ).toBeEnabled();
  await expect(
    dialog.getByRole("checkbox", { exact: true, name: "选择 oversized" })
  ).toBeDisabled();
  await expect(
    dialog.getByRole("checkbox", { exact: true, name: "选择 existing" })
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "安装所选（0）" })
  ).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "全选可安装项" }).check();
  await dialog
    .getByRole("checkbox", { exact: true, name: "选择 gamma" })
    .uncheck();
  await expect(
    dialog.getByRole("button", { name: "安装所选（2）" })
  ).toBeEnabled();
  await page.screenshot({ path: "test-results/skill-install-multiple.png" });
  await dialog.getByRole("button", { name: "安装所选（2）" }).click();
  await expect(
    dialog.getByRole("checkbox", { exact: true, name: "选择 alpha" })
  ).toBeDisabled();
  await expect(
    dialog.getByText("安装失败，请重试；不会回滚其他已成功的 Skill。")
  ).toBeVisible();
  assert.deepEqual(linkInstalls[0].selectedIds, [
    "a".repeat(64),
    "b".repeat(64),
  ]);
  await dialog
    .getByRole("checkbox", { exact: true, name: "选择 beta" })
    .check();
  await dialog.getByRole("button", { name: "安装所选（1）" }).click();
  await expect(
    dialog.getByRole("checkbox", { exact: true, name: "选择 beta" })
  ).toBeDisabled();

  // Editing a URL invalidates the prior preview; failure can be retried, expiry requires reparsing.
  await urlInput.fill("https://github.com/e2e-works/no-skill");
  await expect(dialog.getByText("发现 5 个 Skill")).toBeHidden();
  await dialog.getByRole("button", { exact: true, name: "解析链接" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("No SKILL.md found");
  await urlInput.fill("https://github.com/e2e-works/new-repo");
  await dialog.getByRole("button", { exact: true, name: "解析链接" }).click();
  await dialog
    .getByRole("checkbox", { exact: true, name: "选择 alpha" })
    .check();
  expireNextInstall = true;
  await dialog.getByRole("button", { name: "安装所选（1）" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Preview expired");
  await expect(dialog.getByText("发现 5 个 Skill")).toBeHidden();
  await dialog.getByRole("button", { exact: true, name: "解析链接" }).click();
  await page.setViewportSize({ height: 844, width: 390 });
  await page.screenshot({
    path: "test-results/skill-install-multiple-mobile.png",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  );
  await page.setViewportSize({ height: 880, width: 1180 });

  // 压缩包 Tab：选择 + 拖拽区 + 安装提交 multipart
  await archiveTab.click();
  await expect(archiveTab).toHaveAttribute("aria-selected", "true");
  await expect(linkTab).toHaveAttribute("aria-selected", "false");
  await expect(archiveTab).toHaveClass(/bg-foreground/);
  await expect(
    dialog.getByText("拖拽 .zip 压缩包到这里，或点击选择")
  ).toBeVisible();
  const archive = zipSync({
    "demo/SKILL.md": new TextEncoder().encode(
      ["---", 'name: "demo"', 'description: "Fixture."', "---"].join("\n")
    ),
  });
  await page.setInputFiles('input[type="file"]', {
    buffer: Buffer.from(archive),
    mimeType: "application/zip",
    name: "demo.zip",
  });
  await expect(dialog.getByText("已选择：demo.zip")).toBeVisible();
  await page.screenshot({
    path: "test-results/skill-install-archive.png",
  });
  await dialog.getByRole("button", { exact: true, name: "安装" }).click();
  await expect(dialog).toBeHidden();
  assert.equal(archiveInstalls.length, 1);

  // 第三方市场占位
  await openInstall.click();
  await marketplaceTab.click();
  await expect(marketplaceTab).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByText("第三方市场安装即将上线，敬请期待。")
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/skill-install-marketplace.png",
  });

  await page.keyboard.press("Escape");
  await page.getByRole("button", { exact: true, name: "会议纪要" }).click();
  await expect(
    dialog.getByText("目录过大，仅显示部分条目；安装的资源文件未被删减。")
  ).toBeVisible();
  const assets = dialog.getByRole("button", { exact: true, name: "assets" });
  await expect(assets).toHaveAttribute("aria-expanded", "false");
  await expect(
    dialog.getByRole("button", { exact: true, name: "template-599.txt" })
  ).toBeHidden();
  await assets.click();
  await expect(
    dialog.getByRole("button", { exact: true, name: "template-599.txt" })
  ).toBeAttached();
  assert.deepEqual(pageErrors, []);
  console.log(
    "Skill install UI: discovery, subset/multi-select, partial retry, expired preview, mobile layout, archive and marketplace passed."
  );
} finally {
  await browser?.close();
  await new Promise<void>((ready) => server.close(() => ready()));
  await rm(dir, { force: true, recursive: true });
}
