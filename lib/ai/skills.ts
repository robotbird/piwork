import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { unzipSync } from "fflate";
import { LocalizedError } from "@/lib/i18n/messages";
import { getInstallableCatalogSkill } from "./skill-catalog";
import {
  formatSkillDisplayName,
  parseSkillDisplayName,
  parseSkillVersion,
  validateSkillDisplayName,
} from "./skill-display";
import { forEachSkillFile } from "./skill-file-operations";
import type { SkillInstallLink } from "./skill-install-link";
import { SKILL_LIMIT_MB, SKILL_LIMITS } from "./skill-limits";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_INSTRUCTIONS_LENGTH = 50_000;
export const MAX_SKILL_UPLOAD_FILE_COUNT = SKILL_LIMITS.files;
export const MAX_SKILL_UPLOAD_FILE_SIZE = SKILL_LIMITS.fileBytes;
export const MAX_SKILL_UPLOAD_TOTAL_SIZE = SKILL_LIMITS.totalBytes;
export const MAX_SKILL_FILE_ENTRY_COUNT = SKILL_LIMITS.files;
export const MAX_SKILL_PREVIEW_FILE_SIZE = 1024 * 1024;
const MAX_SKILL_PREVIEW_TEXT_LENGTH = 200_000;
const RESERVED_SKILL_NAMES = new Set([
  "clear",
  "delete",
  "model",
  "new",
  "purge",
  "rename",
  "theme",
]);

function getSkillsDirectory(cwd: string) {
  return `${cwd}/.pi/skills`;
}

function getSkillStatePath(cwd: string) {
  return `${cwd}/.pi/skill-state.json`;
}

function createExecutionEnv(cwd: string) {
  return new NodeExecutionEnv({ cwd });
}

export type ProjectSkillUploadFile = {
  content: Uint8Array;
  path: string;
};

function normalizeUploadPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    throw new Error(`Invalid upload path: ${path}`);
  }

  return segments.join("/");
}

function isIgnoredZipEntry(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.endsWith("/") ||
    normalized.startsWith("__MACOSX/") ||
    normalized.split("/").at(-1) === ".DS_Store"
  );
}

function unzipSkillEntries(
  content: Uint8Array,
  { maxEntries = MAX_SKILL_UPLOAD_FILE_COUNT }: { maxEntries?: number } = {}
): ProjectSkillUploadFile[] {
  let fileCount = 0;
  let declaredTotalSize = 0;
  const archive = unzipSync(content, {
    filter(entry) {
      if (isIgnoredZipEntry(entry.name)) {
        return false;
      }

      normalizeUploadPath(entry.name);
      fileCount += 1;
      declaredTotalSize += entry.originalSize;

      if (fileCount > maxEntries) {
        throw new LocalizedError("api.skillFileCount", { count: maxEntries });
      }
      if (entry.originalSize > MAX_SKILL_UPLOAD_FILE_SIZE) {
        throw new LocalizedError("api.skillFileLimit", {
          maxMB: SKILL_LIMIT_MB.file,
          name: entry.name,
        });
      }
      if (declaredTotalSize > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
        throw new LocalizedError("api.skillFolderLimit", {
          maxMB: SKILL_LIMIT_MB.total,
        });
      }

      return true;
    },
  });

  let actualTotalSize = 0;
  const files = Object.entries(archive).map(([path, fileContent]) => {
    actualTotalSize += fileContent.byteLength;
    return { content: fileContent, path: normalizeUploadPath(path) };
  });
  if (files.length === 0) {
    throw new Error("The ZIP archive does not contain any skill files.");
  }
  if (actualTotalSize > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
    throw new LocalizedError("api.skillFolderLimit", {
      maxMB: SKILL_LIMIT_MB.total,
    });
  }

  return files;
}

export function extractProjectSkillArchive({
  content,
  filename,
}: {
  content: Uint8Array;
  filename: string;
}): ProjectSkillUploadFile[] {
  if (!filename.toLocaleLowerCase().endsWith(".zip")) {
    throw new Error("Skill archive must be a .zip file.");
  }
  if (content.byteLength > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
    throw new LocalizedError("api.skillZipLimit", {
      maxMB: SKILL_LIMIT_MB.total,
    });
  }

  // Same folder-name rules as link installs: prefer the SKILL.md frontmatter
  // name, else sanitize the archive filename/wrapper folder (e.g.
  // ai-ppt-skill-1.0.0) instead of rejecting the upload outright.
  return normalizeSkillInstallArchive(
    unzipSkillEntries(content),
    filename.slice(0, -4)
  );
}

const VCS_METADATA_ROOT_ENTRIES = new Set([
  ".circleci",
  ".git",
  ".github",
  ".gitignore",
  ".gitattributes",
  ".gitlab-ci.yml",
  ".gitmodules",
  ".idea",
  ".vscode",
]);

function isVcsMetadataPath(path: string) {
  const firstSegment = path.split("/")[0] ?? "";
  return VCS_METADATA_ROOT_ENTRIES.has(firstSegment);
}

const FRONTMATTER_NAME_PATTERN =
  /^name:[ \t]*(?:"([^"]*)"|'([^']*)'|([^#"'\n]*?))[ \t]*$/;

/** 从 SKILL.md frontmatter 提取 name（尽力而为；权威校验仍由官方 Pi loader 负责）。 */
function parseSkillManifestName(content: Uint8Array): string | null {
  const text = new TextDecoder()
    .decode(content.slice(0, 64 * 1024))
    .replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return null;
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return null;
  }
  const frontmatter = text.slice(4, end);
  for (const line of frontmatter.split("\n")) {
    if (!/^\S/.test(line)) {
      continue;
    }
    const match = line.match(FRONTMATTER_NAME_PATTERN);
    if (!match) {
      continue;
    }
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    return value || null;
  }
  return null;
}

function isUsableSkillFolderName(
  name: string | null | undefined
): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    SKILL_NAME_PATTERN.test(name) &&
    !RESERVED_SKILL_NAMES.has(name)
  );
}

function sanitizeSkillFolderName(raw: string): string | null {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return isUsableSkillFolderName(sanitized) ? sanitized : null;
}

function pickInstallFolderName(
  manifestContent: Uint8Array,
  rootDirectoryName: string | undefined,
  fallbackName: string
) {
  const frontmatterName = parseSkillManifestName(manifestContent);
  if (isUsableSkillFolderName(frontmatterName)) {
    return frontmatterName;
  }
  if (rootDirectoryName) {
    const fromRoot = sanitizeSkillFolderName(rootDirectoryName);
    if (fromRoot) {
      return fromRoot;
    }
  }
  return sanitizeSkillFolderName(fallbackName) ?? "installed-skill";
}

const SINGLE_SKILL_MANIFEST_ERROR =
  "The archive must contain exactly one SKILL.md file (single-skill archives only).";

/**
 * 将下载的 zip 条目归一化为 installProjectSkill 可接受的文件集：
 * 丢弃 VCS 元数据，定位唯一 SKILL.md，剥离技能目录前缀并重新挂到合法的安装目录名下。
 * 根目录之外的仓库杂项（如 README）会被丢弃，不参与安装。
 */
export function normalizeSkillInstallArchive(
  files: ProjectSkillUploadFile[],
  fallbackName: string
): ProjectSkillUploadFile[] {
  const skillFiles = files.filter((file) => !isVcsMetadataPath(file.path));
  const manifests = skillFiles.filter(
    (file) => file.path.split("/").at(-1) === "SKILL.md"
  );
  if (manifests.length !== 1) {
    throw new Error(SINGLE_SKILL_MANIFEST_ERROR);
  }

  const rootSegments = manifests[0].path.split("/").slice(0, -1);
  const rootPrefix =
    rootSegments.length > 0 ? `${rootSegments.join("/")}/` : "";
  const stripped = skillFiles
    .filter((file) => rootPrefix === "" || file.path.startsWith(rootPrefix))
    .map((file) => ({
      content: file.content,
      path: rootPrefix ? file.path.slice(rootPrefix.length) : file.path,
    }));
  if (stripped.length === 0 || stripped.some((file) => !file.path)) {
    throw new Error("The archive contains invalid skill file paths.");
  }

  const folder = pickInstallFolderName(
    manifests[0].content,
    rootSegments.at(-1),
    fallbackName
  );
  return stripped.map((file) => ({
    content: file.content,
    path: `${folder}/${file.path}`,
  }));
}

/** 归一化下载条目前置的 zip 条目过滤器：返回规范化路径，被忽略/丢弃的条目返回 null。 */
function normalizeRetainedZipEntryPath(entryName: string): string | null {
  if (isIgnoredZipEntry(entryName)) {
    return null;
  }
  const normalized = normalizeUploadPath(entryName);
  return isVcsMetadataPath(normalized) ? null : normalized;
}

/**
 * 链接安装专用两段式提取：仓库归档可能远大于 Skill 本身（如 docs/ 截图资源），
 * 先只解压定位唯一 SKILL.md，再仅提取其所在子树并对保留文件执行 Skill 限额。
 * 根级 SKILL.md 时保留全部条目（整个归档视为 Skill，同样受限额约束）。
 */
function extractSkillInstallFiles(
  content: Uint8Array
): ProjectSkillUploadFile[] {
  const manifestPaths: string[] = [];
  unzipSync(content, {
    filter(entry) {
      const normalized = normalizeRetainedZipEntryPath(entry.name);
      if (normalized?.split("/").at(-1) !== "SKILL.md") {
        return false;
      }
      if (entry.originalSize > MAX_SKILL_UPLOAD_FILE_SIZE) {
        throw new LocalizedError("api.skillFileLimit", {
          maxMB: SKILL_LIMIT_MB.file,
          name: entry.name,
        });
      }
      manifestPaths.push(normalized);
      return true;
    },
  });
  if (manifestPaths.length !== 1) {
    throw new Error(SINGLE_SKILL_MANIFEST_ERROR);
  }

  const rootPrefix = manifestPaths[0].includes("/")
    ? `${manifestPaths[0].slice(0, manifestPaths[0].lastIndexOf("/"))}/`
    : "";
  let fileCount = 0;
  let declaredTotalSize = 0;
  const archive = unzipSync(content, {
    filter(entry) {
      const normalized = normalizeRetainedZipEntryPath(entry.name);
      if (!normalized) {
        return false;
      }
      if (rootPrefix && !normalized.startsWith(rootPrefix)) {
        return false;
      }

      fileCount += 1;
      declaredTotalSize += entry.originalSize;
      if (fileCount > MAX_SKILL_FILE_ENTRY_COUNT) {
        throw new LocalizedError("api.skillFileCount", {
          count: MAX_SKILL_FILE_ENTRY_COUNT,
        });
      }
      if (entry.originalSize > MAX_SKILL_UPLOAD_FILE_SIZE) {
        throw new LocalizedError("api.skillFileLimit", {
          maxMB: SKILL_LIMIT_MB.file,
          name: entry.name,
        });
      }
      if (declaredTotalSize > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
        throw new LocalizedError("api.skillFolderLimit", {
          maxMB: SKILL_LIMIT_MB.total,
        });
      }
      return true;
    },
  });

  let actualTotalSize = 0;
  const files = Object.entries(archive).map(([path, fileContent]) => {
    actualTotalSize += fileContent.byteLength;
    return { content: fileContent, path: normalizeUploadPath(path) };
  });
  if (files.length === 0) {
    throw new Error(SINGLE_SKILL_MANIFEST_ERROR);
  }
  if (actualTotalSize > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
    throw new LocalizedError("api.skillFolderLimit", {
      maxMB: SKILL_LIMIT_MB.total,
    });
  }
  return files;
}

const SKILL_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const SKILL_ARCHIVE_MAX_REDIRECTS = 4;
const SKILL_ARCHIVE_FETCHER_USER_AGENT = "piwork-skill-installer";
/** Download and extracted-skill limits are independently enforced. */
export const MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE = SKILL_LIMITS.archiveBytes;

/** 下载阶段（网络/重定向/主机校验/大小上限）失败；区别于后续 Skill 内容校验错误。 */
export class SkillArchiveDownloadError extends Error {}

type SkillArchiveFetcher = (
  url: string,
  init: RequestInit
) => Promise<Response>;

type SkillArchiveHostResolver = (hostname: string) => Promise<string[]>;

const defaultResolveSkillArchiveHost: SkillArchiveHostResolver = async (
  hostname
) => {
  if (isIP(hostname)) {
    return [hostname];
  }
  return (await lookup(hostname, { all: true })).map(
    (record) => record.address
  );
};

function isPrivateIpv4Address(address: string) {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6Address(address: string) {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") {
    return true;
  }
  const mappedIpv4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    return isPrivateIpv4Address(mappedIpv4[1]);
  }
  if (lower.startsWith("::")) {
    // 其余以 :: 开头的形式（保留段）直接拒绝，fail-closed
    return true;
  }
  const firstGroup = Number.parseInt(lower.split(":")[0] ?? "", 16);
  if (Number.isNaN(firstGroup)) {
    return true;
  }
  return (
    firstGroup === 0 || // 0000::/8（含兼容/映射段）
    (firstGroup & 0xfe_00) === 0xfc_00 || // fc00::/7 ULA
    (firstGroup & 0xff_c0) === 0xfe_80 // fe80::/10 链路本地
  );
}

function isPrivateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIpv4Address(address);
  }
  if (version === 6) {
    return isPrivateIpv6Address(address);
  }
  return true;
}

async function assertPublicHttpUrl(
  rawUrl: string,
  resolveHost: SkillArchiveHostResolver = defaultResolveSkillArchiveHost
) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http(s) URLs are supported for skill installation.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error(`Refusing to fetch non-public skill host "${hostname}".`);
  }

  let addresses: string[];
  if (isIP(hostname)) {
    // IP 直连地址不经注入的解析器，始终直接校验
    addresses = [hostname];
  } else {
    try {
      addresses = await resolveHost(hostname);
    } catch (error) {
      throw new Error(`Failed to resolve skill host "${hostname}".`, {
        cause: error,
      });
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch non-public skill host "${hostname}".`);
  }
  return url;
}

async function readCappedResponseBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(
      `The archive download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`
    );
  }
  if (!response.body) {
    const content = new Uint8Array(await response.arrayBuffer());
    if (content.byteLength > maxBytes) {
      throw new Error(
        `The archive download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`
      );
    }
    return content;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: 流式逐块读取以在上限时提前中止
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    totalSize += value.byteLength;
    if (totalSize > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(
        `The archive download exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`
      );
    }
    chunks.push(value);
  }

  const content = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

async function downloadSkillArchive(
  requestUrl: string,
  fetchImpl: SkillArchiveFetcher,
  headers: Record<string, string>,
  resolveHost: SkillArchiveHostResolver,
  maxBytes: number
) {
  let currentUrl = requestUrl;
  try {
    for (
      let redirects = 0;
      redirects <= SKILL_ARCHIVE_MAX_REDIRECTS;
      redirects += 1
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: 重定向链必须逐跳串行校验后才能继续
      const url = await assertPublicHttpUrl(currentUrl, resolveHost);
      const response = await fetchImpl(url.href, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(SKILL_ARCHIVE_DOWNLOAD_TIMEOUT_MS),
      });
      if (
        response.status === 301 ||
        response.status === 302 ||
        response.status === 303 ||
        response.status === 307 ||
        response.status === 308
      ) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(
            "The archive download redirected without a location."
          );
        }
        currentUrl = new URL(location, url.href).href;
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `The archive download failed with HTTP ${response.status}.`
        );
      }
      return await readCappedResponseBody(response, maxBytes);
    }
    throw new Error("The archive download exceeded the redirect limit.");
  } catch (error) {
    if (error instanceof SkillArchiveDownloadError) {
      throw error;
    }
    throw new SkillArchiveDownloadError(
      error instanceof Error
        ? error.message
        : "The skill archive download failed.",
      { cause: error }
    );
  }
}

/**
 * 从公网安装链接有界下载原始 zip（100MiB/逐跳120s）。
 * 多 Skill 检查/所选子树限额由 skill-install-archive.ts 承接；旧单项 wrapper 保留。
 */
export async function downloadSkillInstallArchive(
  link: SkillInstallLink,
  {
    fetch: fetchImpl = fetch,
    resolveHost = defaultResolveSkillArchiveHost,
  }: {
    fetch?: SkillArchiveFetcher;
    resolveHost?: SkillArchiveHostResolver;
  } = {}
): Promise<{ content: Uint8Array; fallbackName: string }> {
  const headers: Record<string, string> = {
    "User-Agent": SKILL_ARCHIVE_FETCHER_USER_AGENT,
  };
  let requestUrl: string;
  let fallbackName: string;
  if (link.kind === "github-repo") {
    headers.Accept = "application/vnd.github+json";
    requestUrl = `https://api.github.com/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.repo)}/zipball${
      link.ref
        ? `/${link.ref.split("/").map(encodeURIComponent).join("/")}`
        : ""
    }`;
    fallbackName = link.repo;
  } else {
    requestUrl = link.url;
    fallbackName = link.filename;
  }

  const content = await downloadSkillArchive(
    requestUrl,
    fetchImpl,
    headers,
    resolveHost,
    MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE
  );
  return { content, fallbackName };
}

/** Compatibility for the existing single-skill install endpoint. */
export async function fetchSkillInstallArchive(
  link: SkillInstallLink,
  options: Parameters<typeof downloadSkillInstallArchive>[1] = {}
): Promise<ProjectSkillUploadFile[]> {
  const { content, fallbackName } = await downloadSkillInstallArchive(
    link,
    options
  );
  return normalizeSkillInstallArchive(
    extractSkillInstallFiles(content),
    fallbackName
  );
}

export function validateSkillName(name: string) {
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      "Skill name must be 1-64 characters using lowercase letters, numbers, and single hyphens only."
    );
  }
  if (RESERVED_SKILL_NAMES.has(name)) {
    throw new Error(`Skill name "${name}" conflicts with a built-in command.`);
  }
}

export type ProjectSkillSource = "catalog" | "pi-package" | "upload";

export type ProjectSkillSummary = {
  description: string;
  displayName: string;
  enabled: boolean;
  name: string;
  source: ProjectSkillSource;
  version: string;
};

async function readDisabledSkillNames(env: NodeExecutionEnv, cwd: string) {
  const stateFile = await env.readTextFile(
    getSkillStatePath(cwd),
    BACKGROUND_CONTEXT
  );
  if (!stateFile.ok) {
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(stateFile.value) as { disabled?: unknown };
    return new Set(
      Array.isArray(parsed.disabled)
        ? parsed.disabled.filter(
            (name): name is string => typeof name === "string"
          )
        : []
    );
  } catch {
    return new Set<string>();
  }
}

async function writeDisabledSkillNames(
  env: NodeExecutionEnv,
  cwd: string,
  disabled: Set<string>
) {
  await env.createDir(`${cwd}/.pi`, { recursive: true }, BACKGROUND_CONTEXT);
  const written = await env.writeFile(
    getSkillStatePath(cwd),
    `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`,
    BACKGROUND_CONTEXT
  );
  if (!written.ok) {
    throw written.error;
  }
}

export async function loadProjectSkills(cwd = process.cwd()) {
  const env = createExecutionEnv(cwd);

  try {
    const loaded = loadSkillsFromDir({
      dir: getSkillsDirectory(cwd),
      source: "piwork",
    });
    const disabled = await readDisabledSkillNames(env, cwd);
    return {
      diagnostics: loaded.diagnostics,
      skills: loaded.skills.filter((skill) => !disabled.has(skill.name)),
    };
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function loadAllProjectSkills(cwd = process.cwd()) {
  const env = createExecutionEnv(cwd);

  try {
    return loadSkillsFromDir({
      dir: getSkillsDirectory(cwd),
      source: "piwork",
    });
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function loadProjectSkillSummaries(cwd = process.cwd()) {
  const env = createExecutionEnv(cwd);

  try {
    const loaded = loadSkillsFromDir({
      dir: getSkillsDirectory(cwd),
      source: "piwork",
    });
    const disabled = await readDisabledSkillNames(env, cwd);
    const skills = await Promise.all(
      loaded.skills.map(async (skill) => {
        const metadataPath = skill.filePath.replace(
          /SKILL\.md$/,
          "agents/openai.yaml"
        );
        const [metadata, skillFile] = await Promise.all([
          env.readTextFile(metadataPath, BACKGROUND_CONTEXT),
          env.readTextFile(skill.filePath, BACKGROUND_CONTEXT),
        ]);
        const configuredName = metadata.ok
          ? parseSkillDisplayName(metadata.value)
          : null;

        return {
          description: skill.description,
          displayName: configuredName?.trim()
            ? configuredName.trim()
            : formatSkillDisplayName(skill.name),
          enabled: !disabled.has(skill.name),
          name: skill.name,
          source: getInstallableCatalogSkill(skill.name)
            ? ("catalog" as const)
            : ("upload" as const),
          version: skillFile.ok
            ? (parseSkillVersion(skillFile.value) ?? "")
            : "",
        };
      })
    );

    return { diagnostics: loaded.diagnostics, skills };
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function setProjectSkillEnabled(
  name: string,
  enabled: boolean,
  cwd = process.cwd()
) {
  validateSkillName(name);
  const env = createExecutionEnv(cwd);

  try {
    const loaded = loadSkillsFromDir({
      dir: getSkillsDirectory(cwd),
      source: "piwork",
    });
    const skill = loaded.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      throw new Error(`Skill "${name}" was not found.`);
    }

    const disabled = await readDisabledSkillNames(env, cwd);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    await writeDisabledSkillNames(env, cwd, disabled);
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function createProjectSkill({
  name,
  displayName,
  description,
  instructions,
  cwd = process.cwd(),
}: {
  name: string;
  displayName?: string;
  description: string;
  instructions: string;
  cwd?: string;
}) {
  validateSkillName(name);

  const cleanDescription = description.trim();
  const cleanInstructions = instructions.trim();
  const cleanDisplayName = validateSkillDisplayName(
    displayName ?? formatSkillDisplayName(name)
  );

  if (!cleanDescription || cleanDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `Skill description must be 1-${MAX_DESCRIPTION_LENGTH} characters.`
    );
  }
  if (
    !cleanInstructions ||
    cleanInstructions.length > MAX_INSTRUCTIONS_LENGTH
  ) {
    throw new Error(
      `Skill instructions must be 1-${MAX_INSTRUCTIONS_LENGTH} characters.`
    );
  }

  const env = createExecutionEnv(cwd);
  const skillDirectory = `${getSkillsDirectory(cwd)}/${name}`;
  const skillPath = `${skillDirectory}/SKILL.md`;

  try {
    const existing = await env.exists(skillPath, BACKGROUND_CONTEXT);
    if (!existing.ok) {
      throw existing.error;
    }
    if (existing.value) {
      throw new Error(`Skill "${name}" already exists.`);
    }

    const created = await env.createDir(
      skillDirectory,
      { recursive: true },
      BACKGROUND_CONTEXT
    );
    if (!created.ok) {
      throw created.error;
    }

    const agentsDirectory = `${skillDirectory}/agents`;
    const agentsCreated = await env.createDir(
      agentsDirectory,
      { recursive: true },
      BACKGROUND_CONTEXT
    );
    if (!agentsCreated.ok) {
      throw agentsCreated.error;
    }

    const metadata = [
      "interface:",
      `  display_name: ${JSON.stringify(cleanDisplayName)}`,
      "",
    ].join("\n");
    const metadataWritten = await env.writeFile(
      `${agentsDirectory}/openai.yaml`,
      metadata,
      BACKGROUND_CONTEXT
    );
    if (!metadataWritten.ok) {
      throw metadataWritten.error;
    }

    const content = [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(cleanDescription)}`,
      "---",
      "",
      cleanInstructions,
      "",
    ].join("\n");
    const written = await env.writeFile(skillPath, content, BACKGROUND_CONTEXT);
    if (!written.ok) {
      throw written.error;
    }

    const loaded = loadSkillsFromDir({ dir: skillDirectory, source: "piwork" });
    const skill = loaded.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      const detail = loaded.diagnostics.map((item) => item.message).join("; ");
      throw new Error(detail || `Skill "${name}" failed validation.`);
    }

    return skill;
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function installProjectSkill({
  files,
  cwd = process.cwd(),
}: {
  files: ProjectSkillUploadFile[];
  cwd?: string;
}) {
  if (files.length === 0) {
    throw new Error("Choose a skill folder to upload.");
  }
  if (files.length > MAX_SKILL_UPLOAD_FILE_COUNT) {
    throw new LocalizedError("api.skillFileCount", {
      count: MAX_SKILL_UPLOAD_FILE_COUNT,
    });
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.content.byteLength > MAX_SKILL_UPLOAD_FILE_SIZE) {
      throw new LocalizedError("api.skillFileLimit", {
        maxMB: SKILL_LIMIT_MB.file,
        name: file.path,
      });
    }
    totalBytes += file.content.byteLength;
  }
  if (totalBytes > MAX_SKILL_UPLOAD_TOTAL_SIZE) {
    throw new LocalizedError("api.skillFolderLimit", {
      maxMB: SKILL_LIMIT_MB.total,
    });
  }

  const normalizedFiles = files.map((file) => ({
    ...file,
    path: normalizeUploadPath(file.path),
  }));
  const skillManifests = normalizedFiles.filter(
    (file) => file.path.split("/").at(-1) === "SKILL.md"
  );

  if (skillManifests.length !== 1) {
    throw new Error("An upload must contain exactly one SKILL.md file.");
  }

  const manifestSegments = skillManifests[0].path.split("/");
  if (manifestSegments.length !== 2) {
    throw new Error(
      "SKILL.md must be at the root of the selected skill folder."
    );
  }
  const requestedRoot = manifestSegments.slice(0, -1).join("/");
  const relativeFiles = normalizedFiles.map((file) => {
    if (requestedRoot && !file.path.startsWith(`${requestedRoot}/`)) {
      throw new Error(
        "All uploaded files must belong to the same skill folder."
      );
    }

    return {
      content: file.content,
      path: requestedRoot
        ? file.path.slice(requestedRoot.length + 1)
        : file.path,
    };
  });
  // The uploaded folder name is just packaging; when it is not a usable skill
  // name (e.g. ai-ppt-skill-1.0.0) derive the install folder from the
  // frontmatter name, else a sanitized folder name. The Pi loader and
  // validateSkillName below remain the authority on the final skill name.
  const uploadedRoot = isUsableSkillFolderName(requestedRoot)
    ? requestedRoot
    : pickInstallFolderName(
        skillManifests[0].content,
        requestedRoot,
        requestedRoot
      );
  const uniquePaths = new Set(relativeFiles.map((file) => file.path));
  if (uniquePaths.size !== relativeFiles.length) {
    throw new Error("The upload contains duplicate file paths.");
  }

  const env = createExecutionEnv(cwd);
  const tempResult = await env.createTempDir(
    "piwork-skill-upload-",
    BACKGROUND_CONTEXT
  );
  if (!tempResult.ok) {
    await env.cleanup(BACKGROUND_CONTEXT);
    throw tempResult.error;
  }
  const stagingDirectory = tempResult.value;
  const stagedSkillDirectory = `${stagingDirectory}/${uploadedRoot}`;
  let installedDirectory: string | null = null;

  try {
    await forEachSkillFile(
      relativeFiles,
      SKILL_LIMITS.hostWriteConcurrency,
      async (file) => {
        const written = await env.writeFile(
          `${stagedSkillDirectory}/${file.path}`,
          file.content,
          BACKGROUND_CONTEXT
        );
        if (!written.ok) {
          throw written.error;
        }
      }
    );

    const staged = loadSkillsFromDir({
      dir: stagedSkillDirectory,
      source: "piwork",
    });
    if (
      staged.skills.length !== 1 ||
      staged.diagnostics.length > 0 ||
      resolve(staged.skills[0].filePath) !==
        resolve(stagedSkillDirectory, "SKILL.md")
    ) {
      const detail = staged.diagnostics.map((item) => item.message).join("; ");
      throw new Error(
        detail || "The uploaded skill could not be validated by Pi."
      );
    }

    const [skill] = staged.skills;
    validateSkillName(skill.name);
    const destinationDirectory = `${getSkillsDirectory(cwd)}/${skill.name}`;

    const existing = await env.exists(destinationDirectory, BACKGROUND_CONTEXT);
    if (!existing.ok) {
      throw existing.error;
    }
    if (existing.value) {
      throw new Error(`Skill "${skill.name}" already exists.`);
    }

    const parentCreated = await env.createDir(
      getSkillsDirectory(cwd),
      { recursive: true },
      BACKGROUND_CONTEXT
    );
    if (!parentCreated.ok) {
      throw parentCreated.error;
    }
    // Exclusive directory creation: never adopt or remove an existing install.
    const created = await env.createDir(
      destinationDirectory,
      { recursive: false },
      BACKGROUND_CONTEXT
    );
    if (!created.ok) {
      throw created.error;
    }

    installedDirectory = destinationDirectory;
    await forEachSkillFile(
      relativeFiles,
      SKILL_LIMITS.hostWriteConcurrency,
      async (file) => {
        const written = await env.writeFile(
          `${destinationDirectory}/${file.path}`,
          file.content,
          BACKGROUND_CONTEXT
        );
        if (!written.ok) {
          throw written.error;
        }
      }
    );

    const installed = loadSkillsFromDir({
      dir: installedDirectory,
      source: "piwork",
    });
    const installedSkill = installed.skills.find(
      (candidate) => candidate.name === skill.name
    );
    if (
      !installedSkill ||
      installed.diagnostics.length > 0 ||
      resolve(installedSkill.filePath) !==
        resolve(installedDirectory, "SKILL.md")
    ) {
      const detail = installed.diagnostics
        .map((item) => item.message)
        .join("; ");
      throw new Error(detail || `Skill "${skill.name}" failed validation.`);
    }

    return installedSkill;
  } catch (error) {
    if (installedDirectory) {
      await env.remove(
        installedDirectory,
        { force: true, recursive: true },
        BACKGROUND_CONTEXT
      );
    }
    throw error;
  } finally {
    await env.remove(
      stagingDirectory,
      { force: true, recursive: true },
      BACKGROUND_CONTEXT
    );
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

function resolveProjectSkill(cwd: string, name: string) {
  validateSkillName(name);
  const loaded = loadSkillsFromDir({
    dir: getSkillsDirectory(cwd),
    source: "piwork",
  });
  const skill = loaded.skills.find((candidate) => candidate.name === name);
  if (!skill) {
    throw new Error(`Skill "${name}" was not found.`);
  }

  const skillsDirectory = resolve(getSkillsDirectory(cwd));
  const skillDirectory = resolve(dirname(skill.filePath));
  const relativeDirectory = relative(skillsDirectory, skillDirectory);
  if (
    isAbsolute(relativeDirectory) ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith("../")
  ) {
    throw new Error("The skill is outside the managed project directory.");
  }

  return { relativeDirectory, skill, skillDirectory };
}

export async function deleteProjectSkill(name: string, cwd = process.cwd()) {
  const env = createExecutionEnv(cwd);

  try {
    const { relativeDirectory, skill, skillDirectory } = resolveProjectSkill(
      cwd,
      name
    );
    const target = relativeDirectory ? skillDirectory : skill.filePath;
    const removed = await env.remove(
      target,
      { force: false, recursive: true },
      BACKGROUND_CONTEXT
    );
    if (!removed.ok) {
      throw removed.error;
    }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export type ProjectSkillFileEntry = {
  kind: "file" | "directory";
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};

export type ProjectSkillFileContent = {
  content: string;
  encoding: "base64" | "text";
  mimeType: string;
  path: string;
  size: number;
  truncated: boolean;
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function resolveSkillFilePath(skillDirectory: string, requestedPath: string) {
  const normalized = requestedPath.replaceAll("\\", "/");
  const segments = normalized.split("/");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    throw new Error(`Invalid skill file path: ${requestedPath}`);
  }

  const target = resolve(skillDirectory, normalized);
  const relativePath = relative(skillDirectory, target);
  if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error(`Invalid skill file path: ${requestedPath}`);
  }

  return { relativePath: relativePath.split("\\").join("/"), target };
}

function looksLikeBinary(content: Uint8Array) {
  const limit = Math.min(content.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) {
      return true;
    }
  }
  return false;
}

export async function listProjectSkillFiles(
  name: string,
  cwd = process.cwd()
): Promise<{ entries: ProjectSkillFileEntry[]; truncated: boolean }> {
  const env = createExecutionEnv(cwd);

  try {
    const { relativeDirectory, skillDirectory } = resolveProjectSkill(
      cwd,
      name
    );
    if (!relativeDirectory) {
      throw new Error(`Skill "${name}" has no skill folder to browse.`);
    }

    const entries: ProjectSkillFileEntry[] = [];
    let truncated = false;
    const walk = async (directoryPath: string): Promise<void> => {
      if (entries.length >= SKILL_LIMITS.browseEntries) {
        truncated = true;
        return;
      }
      const listed = await env.listDir(
        directoryPath ? `${skillDirectory}/${directoryPath}` : skillDirectory,
        BACKGROUND_CONTEXT
      );
      if (!listed.ok) {
        throw listed.error;
      }

      const children = [...listed.value].sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const info of children) {
        if (info.kind === "symlink") {
          continue;
        }
        if (entries.length >= SKILL_LIMITS.browseEntries) {
          truncated = true;
          return;
        }
        const relativeInfoPath = directoryPath
          ? `${directoryPath}/${info.name}`
          : info.name;
        entries.push({
          kind: info.kind === "directory" ? "directory" : "file",
          mtimeMs: info.mtimeMs,
          name: info.name,
          path: relativeInfoPath,
          size: info.size,
        });
        if (info.kind === "directory") {
          // biome-ignore lint/performance/noAwaitInLoops: 顺序遍历保证条目上限与稳定排序
          await walk(relativeInfoPath);
        }
      }
    };
    await walk("");

    return {
      entries: entries.sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
      truncated,
    };
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export async function readProjectSkillFile(
  name: string,
  requestedPath: string,
  cwd = process.cwd()
): Promise<ProjectSkillFileContent> {
  const env = createExecutionEnv(cwd);

  try {
    const { relativeDirectory, skillDirectory } = resolveProjectSkill(
      cwd,
      name
    );
    if (!relativeDirectory) {
      throw new Error(`Skill "${name}" has no skill folder to browse.`);
    }

    const { relativePath, target } = resolveSkillFilePath(
      skillDirectory,
      requestedPath
    );
    const info = await env.fileInfo(target, BACKGROUND_CONTEXT);
    if (!info.ok) {
      throw info.error;
    }
    if (info.value.kind !== "file") {
      throw new Error(`"${relativePath}" is not a file.`);
    }
    if (info.value.size > MAX_SKILL_PREVIEW_FILE_SIZE) {
      throw new Error(
        `"${relativePath}" exceeds the ${MAX_SKILL_PREVIEW_FILE_SIZE / 1024} KB preview limit.`
      );
    }

    const content = await env.readBinaryFile(target, BACKGROUND_CONTEXT);
    if (!content.ok) {
      throw content.error;
    }

    const imageMimeType =
      IMAGE_MIME_TYPES[extname(relativePath).toLocaleLowerCase()];
    if (imageMimeType) {
      return {
        content: Buffer.from(content.value).toString("base64"),
        encoding: "base64",
        mimeType: imageMimeType,
        path: relativePath,
        size: info.value.size,
        truncated: false,
      };
    }

    if (looksLikeBinary(content.value)) {
      return {
        content: Buffer.from(content.value).toString("base64"),
        encoding: "base64",
        mimeType: "application/octet-stream",
        path: relativePath,
        size: info.value.size,
        truncated: false,
      };
    }

    const text = new TextDecoder("utf-8").decode(content.value);
    return {
      content: text.slice(0, MAX_SKILL_PREVIEW_TEXT_LENGTH),
      encoding: "text",
      mimeType: "text/plain; charset=utf-8",
      path: relativePath,
      size: info.value.size,
      truncated: text.length > MAX_SKILL_PREVIEW_TEXT_LENGTH,
    };
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
  }
}

export function buildSkillsSystemPrompt(skills: Skill[]) {
  const availableSkills = formatSkillsForPrompt(skills);

  return [
    "Skills are reusable, on-demand instruction packages.",
    "When a request matches an available skill, call load_skill before answering and follow the returned instructions.",
    "When the user asks to create a reusable skill, call create_skill with complete, actionable Markdown instructions.",
    availableSkills,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseSkillCommand(input: string) {
  const match = input.trim().match(/^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    return null;
  }

  return { instructions: match[2]?.trim(), name: match[1] };
}

export function invokeSkill(
  skills: Skill[],
  name: string,
  additionalInstructions?: string
) {
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) {
    return Promise.reject(new Error(`Unknown skill "${name}".`));
  }

  return formatSkillInvocation(skill, additionalInstructions);
}

/**
 * 与 pi-coding-agent 1.0.0 的 _expandSkillCommand 同构
 * （dist/core/agent-session.js：读 SKILL.md → stripFrontmatter → <skill> 块）；
 * 1.0.0 起 formatSkillInvocation 不再从官方包导出。
 */
async function formatSkillInvocation(
  skill: Skill,
  additionalInstructions?: string
) {
  const env = new NodeExecutionEnv({ cwd: process.cwd() });
  const read = await env.readTextFile(skill.filePath, BACKGROUND_CONTEXT);
  if (!read.ok) {
    throw read.error;
  }
  const body = stripFrontmatter(read.value).trim();
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return additionalInstructions
    ? `${skillBlock}\n\n${additionalInstructions}`
    : skillBlock;
}

export function createSkillTools(
  initialSkills: Skill[],
  cwd = process.cwd()
): AgentTool[] {
  const skills = new Map(initialSkills.map((skill) => [skill.name, skill]));

  const loadSkill: AgentTool = {
    description:
      "Load the complete instructions for an available skill before carrying out a matching task.",
    execute: async (_toolCallId, params) => {
      const { name, task } = params as { name: string; task?: string };
      const skill = skills.get(name);
      if (!skill) {
        throw new Error(`Unknown skill "${name}".`);
      }

      return {
        content: [
          {
            text: await formatSkillInvocation(skill, task),
            type: "text",
          },
        ],
        details: { name: skill.name, path: skill.filePath },
      };
    },
    label: "Load skill",
    name: "load_skill",
    parameters: Type.Object({
      name: Type.String({ description: "Exact name of the skill to load" }),
      task: Type.Optional(
        Type.String({
          description: "The user's task or arguments to execute with the skill",
        })
      ),
    }),
  };

  const createSkill: AgentTool = {
    description:
      "Create a reusable project skill in the standard .pi/skills/<name>/SKILL.md format. Use only when the user asks to create or save a skill.",
    execute: async (_toolCallId, params) => {
      const skill = await createProjectSkill({
        ...(params as {
          name: string;
          displayName?: string;
          description: string;
          instructions: string;
        }),
        cwd,
      });
      skills.set(skill.name, skill);

      return {
        content: [
          {
            text: `Created skill "${skill.name}" at ${skill.filePath}. It is ready to use with /${skill.name}.`,
            type: "text",
          },
        ],
        details: { name: skill.name, path: skill.filePath },
      };
    },
    executionMode: "sequential",
    label: "Create skill",
    name: "create_skill",
    parameters: Type.Object({
      description: Type.String({
        description:
          "Specific description of what the skill does and when it should be used",
      }),
      displayName: Type.Optional(
        Type.String({
          description:
            "Human-friendly title shown in the chat UI, such as Weekly Report. Defaults to a title-cased skill name.",
        })
      ),
      instructions: Type.String({
        description:
          "Complete Markdown workflow, including constraints, steps, expected outputs, and relative references when needed",
      }),
      name: Type.String({
        description:
          "Skill name: lowercase letters, numbers and single hyphens, maximum 64 characters",
      }),
    }),
  };

  return [loadSkill, createSkill];
}
