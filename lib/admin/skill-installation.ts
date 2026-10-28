import { randomUUID } from "node:crypto";
import {
  extractSkillInstallCandidate,
  inspectSkillInstallArchive,
  MAX_SKILL_INSTALL_CANDIDATES,
} from "@/lib/ai/skill-install-archive";
import { parseSkillInstallLink } from "@/lib/ai/skill-install-link";
import type {
  SkillInstallCandidate,
  SkillInstallPreview,
  SkillInstallResult,
} from "@/lib/ai/skill-install-types";
import {
  MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE,
  type ProjectSkillUploadFile,
} from "@/lib/ai/skills";
import { LocalizedError } from "@/lib/i18n/messages";

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

type PreviewEntry = {
  actor: string;
  content: Uint8Array;
  candidates: SkillInstallCandidate[];
  expiresAt: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type Dependencies = {
  download: (
    link: NonNullable<ReturnType<typeof parseSkillInstallLink>>
  ) => Promise<{ content: Uint8Array; fallbackName: string }>;
  existingNames: () => Promise<Set<string>>;
  install: (files: ProjectSkillUploadFile[]) => Promise<{ name: string }>;
  register: (name: string, actor: string) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  now?: () => number;
};

/** Single-process, bounded, short-lived previews; not durable jobs or worker state. */
export class SkillInstallationService {
  private readonly entries = new Map<string, PreviewEntry>();
  private reserved = 0;
  private readonly now: () => number;
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
  }

  private sweep() {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= this.now() && !entry.busy) {
        clearTimeout(entry.timer);
        this.entries.delete(token);
      }
    }
  }

  discard(actor: string, token: string) {
    const entry = this.entries.get(token);
    if (entry?.actor === actor && !entry.busy) {
      clearTimeout(entry.timer);
      this.entries.delete(token);
    }
  }

  async preview(actor: string, input: string): Promise<SkillInstallPreview> {
    const link = input.length <= 2048 ? parseSkillInstallLink(input) : null;
    if (!link) {
      throw new LocalizedError("api.skillInstallUrlInvalid");
    }
    this.sweep();
    const bytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.content.byteLength,
      0
    );
    // Reserve before awaiting so concurrent downloads cannot exceed the cap.
    if (
      bytes + (this.reserved + 1) * MAX_SKILL_ARCHIVE_DOWNLOAD_SIZE >
        MAX_CACHE_BYTES ||
      this.entries.size + this.reserved >= MAX_CACHE_ENTRIES
    ) {
      throw new LocalizedError("api.skillPreviewBusy");
    }
    this.reserved += 1;
    try {
      const { content, fallbackName } = await this.dependencies.download(link);
      const candidates = await inspectSkillInstallArchive(
        content,
        fallbackName
      );
      const installed = await this.dependencies.existingNames();
      for (const candidate of candidates) {
        if (installed.has(candidate.name)) {
          candidate.issue = "installed";
        }
      }
      const token = randomUUID();
      const expiresAt = this.now() + PREVIEW_TTL_MS;
      const timer = setTimeout(
        () => this.discard(actor, token),
        PREVIEW_TTL_MS
      );
      timer.unref();
      this.entries.set(token, {
        actor,
        busy: false,
        candidates,
        content,
        expiresAt,
        timer,
      });
      return {
        candidates: candidates.map((candidate) => ({ ...candidate })),
        expiresAt,
        token,
      };
    } finally {
      this.reserved -= 1;
    }
  }

  async install(
    actor: string,
    token: string,
    ids: string[]
  ): Promise<SkillInstallResult[]> {
    this.sweep();
    const entry = this.entries.get(token);
    // Ownership failure deliberately indistinguishable from expiry/not found.
    if (!entry || entry.actor !== actor || entry.expiresAt <= this.now()) {
      throw new LocalizedError("api.skillPreviewExpired");
    }
    if (entry.busy) {
      throw new LocalizedError("api.skillPreviewBusy");
    }
    const selected = ids.map((id) =>
      entry.candidates.find((candidate) => candidate.id === id)
    );
    if (
      !ids.length ||
      ids.length > MAX_SKILL_INSTALL_CANDIDATES ||
      new Set(ids).size !== ids.length ||
      selected.some((candidate) => !candidate || candidate.issue)
    ) {
      throw new LocalizedError("api.skillSelectionInvalid");
    }
    entry.busy = true;
    try {
      const installedNames = await this.dependencies.existingNames();
      const results: SkillInstallResult[] = [];
      for (const candidate of selected) {
        if (!candidate) {
          continue;
        }
        if (installedNames.has(candidate.name)) {
          candidate.issue = "installed";
          results.push({
            id: candidate.id,
            issue: "installed",
            name: candidate.name,
            status: "failed",
          });
          continue;
        }
        let created: string | null = null;
        try {
          const files = extractSkillInstallCandidate(entry.content, candidate);
          // biome-ignore lint/performance/noAwaitInLoops: sequential installs bound extraction memory and report per-item outcomes
          const installed = await this.dependencies.install(files);
          created = installed.name;
          if (installed.name !== candidate.name) {
            throw new LocalizedError("api.skillSelectionInvalid");
          }
          await this.dependencies.register(installed.name, actor);
          installedNames.add(installed.name);
          candidate.issue = "installed";
          results.push({
            id: candidate.id,
            name: installed.name,
            status: "installed",
          });
        } catch (error) {
          // Roll back only this attempt's newly created directory, never existing skills.
          if (created) {
            try {
              await this.dependencies.remove(created);
            } catch (cleanupError) {
              // Preserve the directory for inspection; never hide successful siblings.
              console.error("Skill install rollback requires review", {
                cleanupError,
                name: created,
              });
            }
          }
          console.error("Skill selection installation failed", {
            error,
            id: candidate.id,
          });
          results.push({
            id: candidate.id,
            issue: "failed",
            name: candidate.name,
            status: "failed",
          });
        }
      }
      return results;
    } finally {
      entry.busy = false;
      if (
        entry.expiresAt <= this.now() ||
        entry.candidates.every((candidate) => candidate.issue)
      ) {
        this.discard(actor, token);
      }
    }
  }
}
