import "server-only";

import { listPluginInstallations } from "@/lib/db/model-plugin-queries";
import { decryptPluginCredentials } from "@/lib/model-plugins/credentials";

/**
 * 平台检索通道的凭据解析。
 *
 * 优先级：DeepSeek 模型插件的安装凭据（DB 加密存储）> 环境变量。
 * 插件凭据与对话模型同 key、随凭据轮换自动同步——"已配置 DeepSeek 对话
 * 模型 = 搜索可直接用同一把 key"。环境变量兜底给未装插件的部署，且显式
 * 忽略形如 "your-deepseek-api-key" 的占位符样例值。
 *
 * 结果进程内缓存 5 分钟：插件凭据轮换最迟 5 分钟生效，热路径不反复解密。
 */

const CACHE_TTL_MS = 5 * 60_000;

type KeyCache = { at: number; key: string | null };
const shared = globalThis as typeof globalThis & {
  piworkSearchKeyCache?: { deepseek?: KeyCache };
};
shared.piworkSearchKeyCache ??= {};
const keyCache = shared.piworkSearchKeyCache;

/** 样例占位符（.env.example 风格）不能当作已配置。 */
function looksLikePlaceholder(value: string): boolean {
  return /^your-|placeholder|xxx+|change[-_]?me/i.test(value.trim());
}

async function deepseekPluginApiKey(): Promise<string | null> {
  const cached = keyCache.deepseek;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.key;
  }
  let key: string | null = null;
  try {
    const records = await listPluginInstallations();
    const record = records.find(
      (item) =>
        item.providerKey === "deepseek" &&
        item.enabled &&
        item.credentialsConfigured
    );
    if (record) {
      const credentials = decryptPluginCredentials(record.encryptedCredentials);
      const value =
        typeof credentials.api_key === "string"
          ? credentials.api_key.trim()
          : "";
      key = value || null;
    }
  } catch {
    // 凭据解密失败（key 轮换等）按未配置处理；搜索走不可用文案。
    key = null;
  }
  keyCache.deepseek = { at: Date.now(), key };
  return key;
}

/**
 * 合并环境变量与插件凭据，产出检索 provider 的 key 视图。
 * 永不返回日志/工具结果——只进 provider 请求头。
 */
export async function resolveSearchEnv(): Promise<
  Record<string, string | undefined>
> {
  const env: Record<string, string | undefined> = { ...process.env };
  const fromEnv = env.DEEPSEEK_API_KEY?.trim();
  const envUsable = Boolean(fromEnv) && !looksLikePlaceholder(fromEnv ?? "");
  if (!envUsable) {
    const pluginKey = await deepseekPluginApiKey();
    if (pluginKey) {
      env.DEEPSEEK_API_KEY = pluginKey;
    } else if (fromEnv) {
      // 无插件凭据且 env 是占位符：保留原值让 provider 判定给出
      // unconfigured 语义之外的稳定错误路径（401 透传为服务不可用）。
      env.DEEPSEEK_API_KEY = fromEnv;
    } else {
      delete env.DEEPSEEK_API_KEY;
    }
  }
  return env;
}
