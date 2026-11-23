import "server-only";
import { resolveRoleModelAccess } from "../admin/role-model-policy";
import { tokenLimitExceeded } from "../admin/role-token-policy";
import {
  getRoleTokenUsage,
  getUserRolePolicies,
} from "../db/role-policy-queries";
import { ChatbotError } from "../errors";
import { getActiveModelCatalog } from "./active-models";

export async function getUserModelCatalog(userId: string) {
  const [catalog, roles] = await Promise.all([
    getActiveModelCatalog(),
    getUserRolePolicies(userId),
  ]);
  const access = resolveRoleModelAccess(
    roles.flatMap((role) => (role.modelPolicy ? [role.modelPolicy] : [])),
    catalog.models.map((model) => model.id),
    catalog.defaultModelId
  );
  return {
    ...catalog,
    allowSwitch: access.allowSwitch,
    defaultModelId: access.defaultModelId,
    // 虚拟条目（provider "piwork"）不参与策略过滤：策略是静态 ID 快照，
    // 新增虚拟入口永远不在旧快照里；真实消费是其路由目标（物理模型，
    // authorizeRoleRun 对虚拟 run 改验路由候选，照常受策略约束）
    models: catalog.models.filter(
      (model) =>
        model.provider === "piwork" || access.modelIds.includes(model.id)
    ),
    platformModelCount: catalog.models.length,
  };
}
export async function checkUserTokenQuota(userId: string, runId?: string) {
  const roles = await getUserRolePolicies(userId);
  for (const role of roles) {
    if (!role.tokenPolicy) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Bound DB work sequentially and stop at the first blocking policy.
    const usage = await getRoleTokenUsage(role.id, runId);
    if (tokenLimitExceeded(role.tokenPolicy, usage)) {
      if (role.tokenPolicy.action === "block") {
        throw new ChatbotError("rate_limit:chat", "Role Token quota exceeded");
      }
      console.warn("[role-quota] recorded Token limit exceeded", {
        roleId: role.id,
        runId,
      });
    }
  }
}
export async function authorizeRoleRun(
  userId: string,
  model: { provider: string; id: string },
  /**
   * 虚拟模型的实际路由目标（物理模型）。提供时改验这些候选的授权——
   * 虚拟入口本身不是消费单位，fast/quality 候选才是。
   */
  routes?: ReadonlyArray<{ provider: string; id: string }>
) {
  const catalog = await getUserModelCatalog(userId);
  if (routes) {
    for (const route of routes) {
      if (
        !catalog.models.some(
          (item) => item.id === `${route.provider}/${route.id}`
        )
      ) {
        throw new ChatbotError("forbidden:model", "Model not authorized");
      }
    }
  } else if (
    !catalog.models.some((item) => item.id === `${model.provider}/${model.id}`)
  ) {
    throw new ChatbotError("forbidden:model", "Model not authorized");
  }
  await checkUserTokenQuota(userId);
}
