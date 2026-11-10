import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build as esbuildBuild } from "esbuild";
import { unzipSync } from "fflate";

import {
  isForbiddenEntryPath,
  isUnsafeEntryPath,
  type PackageInspection,
  PluginPackageError,
  packageError,
} from "./contract";
import { staticScanSources } from "./static-scan";

/** 平台管理的插件工作区根目录（staging 与不可变 artifact） */
export function pluginWorkspaceRoot(): string {
  return resolve(process.cwd(), ".piwork");
}

/** 外部依赖解析位置：构建产物通过 node_modules 符号链接复用宿主侧审核过的包 */
function dependencyLinkTarget(specifier: string): string {
  if (specifier === "@piwork/model-provider-sdk") {
    return resolve(process.cwd(), "packages", "model-provider-sdk");
  }
  return resolve(process.cwd(), "node_modules", specifier);
}

export type PluginArtifact = {
  /** 构建产物入口（ESM bundle）绝对路径 */
  entryPath: string;
  /** artifact 目录（含 dist 与 node_modules 链接） */
  dir: string;
  /** bundle 内容 hash */
  buildHash: string;
};

/**
 * 从源码重新构建插件（§6.1）：解压 staging → 静态扫描 → esbuild 单文件
 * ESM bundle → 链接 allowlist 依赖。上传包内的 dist/ 不被信任、不执行。
 */
export async function buildPluginArtifact(
  zipBytes: Uint8Array,
  inspection: PackageInspection
): Promise<PluginArtifact> {
  const root = pluginWorkspaceRoot();
  const stagingRoot = join(root, "staging");
  const artifactRoot = join(
    root,
    "artifacts",
    `${inspection.packageId}@${inspection.version}`,
    inspection.sha256.slice(0, 16)
  );
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const stagingDir = await mkdtemp(
    join(stagingRoot, `${inspection.sha256.slice(0, 16)}-`)
  );
  const artifactDir = await mkdtemp(join(artifactRoot, ".building-"));
  try {
    const entries = unzipSync(zipBytes);
    const sourceFiles: [string, string][] = [];

    for (const [entryPath, bytes] of Object.entries(entries)) {
      if (isUnsafeEntryPath(entryPath) || isForbiddenEntryPath(entryPath)) {
        // inspect 已拦截；构建期双检防止绕过
        throw new PluginPackageError(
          "unsafe_path",
          `Rejected entry during build: ${entryPath}`
        );
      }
      if (entryPath === "dist" || entryPath.startsWith("dist/")) {
        // 上传产物仅作者自检用，平台丢弃后自行构建
        continue;
      }
      const target = join(stagingDir, entryPath);
      // biome-ignore lint/performance/noAwaitInLoops: 按包内条目顺序落盘 staging
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      if (/\.(ts|tsx|js|mjs)$/.test(entryPath)) {
        sourceFiles.push([entryPath, new TextDecoder().decode(bytes)]);
      }
    }

    staticScanSources(sourceFiles);

    const outEntry = join(artifactDir, "dist", "index.js");
    try {
      await esbuildBuild({
        absWorkingDir: stagingDir,
        bundle: true,
        entryPoints: [inspection.manifest.runtime.source],
        external: [
          "@earendil-works/pi-ai",
          "@earendil-works/pi-ai/*",
          "@piwork/model-provider-sdk",
          "^node:",
        ],
        format: "esm",
        outfile: outEntry,
        platform: "node",
        sourcemap: "linked",
        target: "node22",
      });
    } catch (error) {
      throw packageError(
        "build_failed",
        `TypeScript build failed: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }

    // allowlist 依赖在 artifact 内以符号链接提供，bundle 与宿主共享同一 pi-ai 实例
    for (const dependency of Object.keys(inspection.dependencies)) {
      const linkDir = join(artifactDir, "node_modules", dependency);
      // biome-ignore lint/performance/noAwaitInLoops: 依赖链接需逐个串行创建
      await mkdir(dirname(linkDir), { recursive: true });
      await symlink(dependencyLinkTarget(dependency), linkDir, "dir");
    }

    const buildHash = createHash("sha256")
      .update(readFileSync(outEntry))
      .digest("hex");
    const publishedDir = join(artifactRoot, buildHash);
    try {
      await rename(artifactDir, publishedDir);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        throw error;
      }
      const existingHash = createHash("sha256")
        .update(readFileSync(join(publishedDir, "dist", "index.js")))
        .digest("hex");
      if (existingHash !== buildHash) {
        throw error;
      }
    }
    return {
      buildHash,
      dir: publishedDir,
      entryPath: join(publishedDir, "dist", "index.js"),
    };
  } finally {
    await rm(stagingDir, { force: true, recursive: true });
    await rm(artifactDir, { force: true, recursive: true });
  }
}
