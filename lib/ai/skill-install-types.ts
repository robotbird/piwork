/** Public preview DTOs. No archive bytes or trusted filesystem paths. */
export type SkillInstallIssue =
  | "invalid"
  | "fileCount"
  | "fileSize"
  | "totalSize"
  | "nested"
  | "duplicateName"
  | "installed";

export type SkillInstallCandidate = {
  id: string;
  path: string;
  name: string;
  description: string;
  fileCount: number;
  totalBytes: number;
  issue: SkillInstallIssue | null;
};

export type SkillInstallPreview = {
  token: string;
  expiresAt: number;
  candidates: SkillInstallCandidate[];
};

export type SkillInstallResult = {
  id: string;
  name: string;
  status: "installed" | "failed";
  issue?: SkillInstallIssue | "failed";
};
