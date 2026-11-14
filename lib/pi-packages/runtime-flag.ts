import "server-only";

import { listPiPackages } from "@/lib/db/pi-package-queries";
import type { PiPackageRecord } from "@/lib/db/schema";

/**
 * "平台具备联网搜索能力"信号（插件路线）。
 *
 * Pi 包扩展运行时默认开启：管理端安装的 pi 包，其 extensions 由聊天会话的
 * DefaultResourceLoader 解析并在服务器进程内加载（jiti，与 AgentSession
 * 同进程）。安装即管理员对扩展代码的信任决策，无额外环境开关。
 */

/** env 形状（process.env 与测试字面量均可赋值,对齐 lib/search/service.ts） */
type SearchEnv = Record<string, string | undefined>;

/** 默认按 web 搜索插件识别的包名（npm name，不含 npm: 前缀与版本）。 */
export const DEFAULT_WEB_SEARCH_PACKAGES = ["pi-web-access"];

export const WEB_SEARCH_PACKAGES_ENV = "PIWORK_WEB_SEARCH_PACKAGES";

function webSearchPackageNames(env: SearchEnv = process.env): string[] {
  const raw = env.PIWORK_WEB_SEARCH_PACKAGES ?? "";
  const names = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return names.length > 0 ? names : [...DEFAULT_WEB_SEARCH_PACKAGES];
}

/** 包记录（name 或 npm source）是否命中 web 搜索插件名单。 */
export function isWebSearchPackage(
  record: Pick<PiPackageRecord, "name" | "source">,
  env: SearchEnv = process.env
): boolean {
  return webSearchPackageNames(env).some(
    (entry) =>
      record.name === entry ||
      record.source === `npm:${entry}` ||
      record.source.startsWith(`npm:${entry}@`)
  );
}

/**
 * 平台当前是否具备"可用的联网搜索"（插件路线）：已安装带扩展的 web 搜索
 * 插件即具备。只作路由/分类的能力信号，不是授权。DB 不可达按无能力处理
 * （fail-closed，不虚报能力）。
 */
export async function pluginSearchAvailable(
  env: SearchEnv = process.env
): Promise<boolean> {
  try {
    const records = await listPiPackages();
    return records.some(
      (record) =>
        record.resourceSummary.extensions > 0 && isWebSearchPackage(record, env)
    );
  } catch {
    return false;
  }
}
