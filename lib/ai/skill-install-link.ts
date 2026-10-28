/**
 * Skill 安装链接解析（纯函数，客户端/服务端共用）。
 *
 * 支持两类链接：
 * - GitHub 仓库（github.com/owner/repo，可带 /tree/<ref>，或 git@github.com: SSH 形式），
 *   服务端经 api.github.com zipball 下载默认分支/指定 ref 的 zip；
 * - zip 直链（任意 http(s) 地址，路径以 .zip 结尾；含 github.com/.../archive/... 与
 *   codeload.github.com/.../zip/... 两种 GitHub 归档形式）。
 *
 * 仅做语法识别，不做网络安全校验（公网地址校验在服务端下载时执行）。
 */

export type SkillInstallLink =
  | {
      kind: "github-repo";
      owner: string;
      ref?: string;
      repo: string;
      url: string;
    }
  | {
      kind: "zip-url";
      filename: string;
      url: string;
    };

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SSH_GITHUB_PATTERN =
  /^git@github\.com:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/;

function stripGitSuffix(segment: string) {
  return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function githubRepoLink(
  owner: string,
  rawRepo: string,
  ref?: string
): SkillInstallLink | null {
  const repo = stripGitSuffix(rawRepo);
  if (!REPO_SEGMENT_PATTERN.test(owner) || !REPO_SEGMENT_PATTERN.test(repo)) {
    return null;
  }
  return {
    kind: "github-repo",
    owner,
    ...(ref ? { ref } : {}),
    repo,
    url: `https://github.com/${owner}/${repo}`,
  };
}

function archiveNameFromPath(pathname: string) {
  const rawName = pathname.split("/").filter(Boolean).at(-1) ?? "";
  const decoded = decodeSegment(rawName) ?? rawName;
  const withoutZip = decoded.replace(/\.zip$/i, "");
  return withoutZip || "skill-archive";
}

/**
 * 识别 Skill 安装链接。无法识别时返回 null；识别结果中的 url 为规范化后的下载地址。
 */
export function parseSkillInstallLink(input: string): SkillInstallLink | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(SSH_GITHUB_PATTERN);
  if (sshMatch) {
    return githubRepoLink(sshMatch[1], sshMatch[2]);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const isZipPath = url.pathname.toLowerCase().endsWith(".zip");

  if (host === "github.com" && segments.length >= 2) {
    const [owner, repo, third, fourth, ...rest] = segments;
    if (!third) {
      return githubRepoLink(owner, repo);
    }
    if (third === "tree" && fourth && rest.length === 0) {
      const ref = decodeSegment(fourth);
      if (!ref || ref.includes("/") || ref.includes("\0")) {
        return null;
      }
      return githubRepoLink(owner, repo, ref);
    }
    if (third === "archive" && isZipPath) {
      return {
        filename: archiveNameFromPath(url.pathname),
        kind: "zip-url",
        url: url.href,
      };
    }
    return null;
  }

  if (host === "codeload.github.com" && segments[2] === "zip") {
    const [, repo] = segments;
    return {
      filename: decodeSegment(repo ?? "") || "skill-archive",
      kind: "zip-url",
      url: url.href,
    };
  }

  if (isZipPath) {
    return {
      filename: archiveNameFromPath(url.pathname),
      kind: "zip-url",
      url: url.href,
    };
  }

  return null;
}
