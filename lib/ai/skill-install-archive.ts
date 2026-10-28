import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { unzipSync } from "fflate";
import { LocalizedError } from "@/lib/i18n/messages";
import type {
  SkillInstallCandidate,
  SkillInstallIssue,
} from "./skill-install-types";
import {
  MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE,
  MAX_SKILL_FILE_ENTRY_COUNT,
  MAX_SKILL_UPLOAD_FILE_SIZE,
  MAX_SKILL_UPLOAD_TOTAL_SIZE,
  type ProjectSkillUploadFile,
  validateSkillName,
} from "./skills";

export const MAX_SKILL_INSTALL_CANDIDATES = 100;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 1024 * 1024;
const METADATA_SEGMENTS = new Set([
  ".git",
  ".github",
  ".gitlab",
  ".idea",
  ".vscode",
  "node_modules",
  "__MACOSX",
]);

function entryPath(raw: string) {
  const path = raw.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) {
    throw new LocalizedError("api.skillArchiveInvalid");
  }
  const segments = path.replace(/\/$/, "").split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new LocalizedError("api.skillArchiveInvalid");
  }
  return path;
}

function ignored(path: string) {
  return (
    path.endsWith("/") ||
    path.split("/").some((segment) => METADATA_SEGMENTS.has(segment)) ||
    path.split("/").at(-1) === ".DS_Store"
  );
}

/** Scan ZIP central-directory metadata without inflating unrelated files. */
function scan(content: Uint8Array) {
  if (content.byteLength > MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE) {
    throw new LocalizedError("api.skillArchiveInvalid");
  }
  const entries: { path: string; size: number }[] = [];
  const seen = new Set<string>();
  let count = 0;
  try {
    unzipSync(content, {
      filter(entry) {
        count += 1;
        if (count > MAX_ARCHIVE_ENTRIES) {
          throw new LocalizedError("api.skillArchiveInvalid");
        }
        const path = entryPath(entry.name);
        if (seen.has(path)) {
          throw new LocalizedError("api.skillArchiveInvalid");
        }
        seen.add(path);
        if (!ignored(path)) {
          entries.push({ path, size: entry.originalSize });
        }
        return false;
      },
    });
  } catch (cause) {
    const error = new LocalizedError("api.skillArchiveInvalid");
    error.cause = cause;
    throw error;
  }
  return entries;
}

function prefixOf(manifestPath: string) {
  return manifestPath.slice(0, -"SKILL.md".length);
}

function candidateIssue(files: { size: number }[]): SkillInstallIssue | null {
  if (files.length > MAX_SKILL_FILE_ENTRY_COUNT) {
    return "fileCount";
  }
  if (files.some((file) => file.size > MAX_SKILL_UPLOAD_FILE_SIZE)) {
    return "fileSize";
  }
  if (
    files.reduce((sum, file) => sum + file.size, 0) >
    MAX_SKILL_UPLOAD_TOTAL_SIZE
  ) {
    return "totalSize";
  }
  return null;
}

/**
 * Each SKILL.md is an explicit selectable root. Names/descriptions and diagnostics
 * come from the installed Pi loader, not a home-grown YAML parser. Only bounded
 * manifests are staged; no scripts, package hooks or third-party code execute.
 */
export async function inspectSkillInstallArchive(
  content: Uint8Array,
  fallbackName: string
) {
  const entries = scan(content);
  const manifests = entries.filter(
    (entry) => entry.path.split("/").at(-1) === "SKILL.md"
  );
  if (!manifests.length) {
    throw new LocalizedError("api.skillArchiveNoSkills");
  }
  if (manifests.length > MAX_SKILL_INSTALL_CANDIDATES) {
    throw new LocalizedError("api.skillArchiveTooManySkills");
  }
  let manifestBytes = 0;
  const readable = new Set(
    manifests
      .filter((manifest) => {
        if (manifest.size > MAX_MANIFEST_BYTES) {
          return false;
        }
        manifestBytes += manifest.size;
        return true;
      })
      .map((manifest) => manifest.path)
  );
  if (manifestBytes > MAX_MANIFEST_TOTAL_BYTES) {
    throw new LocalizedError("api.skillArchiveInvalid");
  }
  const manifestContents = unzipSync(content, {
    filter: (entry) => readable.has(entryPath(entry.name)),
  });
  const temp = await mkdtemp(join(tmpdir(), "piwork-skill-inspect-"));
  try {
    const candidates: SkillInstallCandidate[] = [];
    for (const manifest of manifests) {
      const prefix = prefixOf(manifest.path);
      const files = entries.filter((entry) => entry.path.startsWith(prefix));
      let issue = candidateIssue(files);
      // Do not silently omit nested skill resources from a parent skill.
      if (
        manifests.some(
          (other) =>
            other.path !== manifest.path && other.path.startsWith(prefix)
        )
      ) {
        issue = "nested";
      }
      const folder = prefix.split("/").filter(Boolean).at(-1) ?? fallbackName;
      const safeFolder =
        folder
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64) || "skill";
      const id = createHash("sha256").update(manifest.path).digest("hex");
      let name = safeFolder;
      let description = "";
      const bytes = manifestContents[manifest.path];
      if (!bytes || bytes.byteLength > MAX_MANIFEST_BYTES) {
        issue = "invalid";
      } else {
        const dir = join(temp, id, safeFolder);
        // biome-ignore lint/performance/noAwaitInLoops: sequential bounded manifest staging
        await mkdir(dir, { mode: 0o700, recursive: true });
        await writeFile(join(dir, "SKILL.md"), bytes, { mode: 0o600 });
        const loaded = loadSkillsFromDir({
          dir,
          source: "piwork-install-preview",
        });
        const [skill] = loaded.skills;
        if (skill) {
          ({ name } = skill);
          description = skill.description.slice(0, 1024);
        }
        try {
          validateSkillName(name);
          if (!skill || loaded.diagnostics.length) {
            issue = "invalid";
          }
        } catch {
          issue = "invalid";
        }
      }
      candidates.push({
        description,
        fileCount: files.length,
        id,
        issue,
        name,
        path: prefix.replace(/\/$/, "") || ".",
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      });
    }
    const names = new Map<string, number>();
    for (const candidate of candidates) {
      names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      if ((names.get(candidate.name) ?? 0) > 1) {
        candidate.issue = "duplicateName";
      }
    }
    return candidates.sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}

/** Extract a server-inspected root only. Client paths never reach this function. */
export function extractSkillInstallCandidate(
  content: Uint8Array,
  candidate: SkillInstallCandidate
): ProjectSkillUploadFile[] {
  if (candidate.issue) {
    throw new LocalizedError("api.skillSelectionInvalid");
  }
  validateSkillName(candidate.name);
  const prefix = candidate.path === "." ? "" : `${candidate.path}/`;
  let count = 0;
  let total = 0;
  const archive = unzipSync(content, {
    filter(entry) {
      const path = entryPath(entry.name);
      if (ignored(path) || !path.startsWith(prefix)) {
        return false;
      }
      count += 1;
      total += entry.originalSize;
      if (
        count > MAX_SKILL_FILE_ENTRY_COUNT ||
        total > MAX_SKILL_UPLOAD_TOTAL_SIZE ||
        entry.originalSize > MAX_SKILL_UPLOAD_FILE_SIZE
      ) {
        throw new LocalizedError("api.skillSelectionInvalid");
      }
      return true;
    },
  });
  const files = Object.entries(archive).map(([path, bytes]) => ({
    content: bytes,
    path: `${candidate.name}/${entryPath(path).slice(prefix.length)}`,
  }));
  if (
    files.length !== candidate.fileCount ||
    files.reduce((sum, file) => sum + file.content.byteLength, 0) !==
      candidate.totalBytes
  ) {
    throw new LocalizedError("api.skillSelectionInvalid");
  }
  return files;
}
