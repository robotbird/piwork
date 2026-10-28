/** Shared platform limits, not Pi specification limits. Safe for client imports. */
export const SKILL_LIMITS = {
  archiveBytes: 100 * 1024 * 1024,
  browseEntries: 50_000,
  bundleBytes: 256 * 1024 * 1024,
  bundleFiles: 50_000,
  collectorMemoryMB: 1536,
  collectorTimeoutMs: 120_000,
  fileBytes: 20 * 1024 * 1024,
  files: 20_000,
  hostWriteConcurrency: 16,
  manifestBytes: 16 * 1024 * 1024,
  sandboxWriteConcurrency: 4,
  totalBytes: 100 * 1024 * 1024,
} as const;

/** Inert documentation only. Never permit actual dotenv assignments. */
export const SKILL_ENV_EXAMPLE_MAX_BYTES = 64 * 1024;
export function isCommentOnlySkillEnvExample(content: Uint8Array): boolean {
  return (
    content.byteLength <= SKILL_ENV_EXAMPLE_MAX_BYTES &&
    new TextDecoder()
      .decode(content)
      .split(/[\r\n\u2028\u2029]/)
      .every((line) => !line.trim() || line.trimStart().startsWith("#"))
  );
}

export const SKILL_LIMIT_MB = {
  file: SKILL_LIMITS.fileBytes / 1024 / 1024,
  total: SKILL_LIMITS.totalBytes / 1024 / 1024,
} as const;
