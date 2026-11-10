import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { RoleModelPolicy } from "../admin/role-model-policy";
import type { RoleTokenPolicy } from "../admin/role-token-policy";
import { getDb } from "./client";
import { member, memberRole, role } from "./schema";

export async function updateRolePolicy(
  id: string,
  input: {
    modelPolicy?: RoleModelPolicy | null;
    tokenPolicy?: RoleTokenPolicy | null;
  }
) {
  const [updated] = await getDb()
    .update(role)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(role.id, id))
    .returning({ id: role.id });
  return updated ?? null;
}
export async function getUserRolePolicies(userId: string) {
  const db = getDb();
  const [account] = await db
    .select({ status: member.status })
    .from(member)
    .where(eq(member.userId, userId));
  if (account?.status !== "enabled") {
    throw new Error("Account is not enabled");
  }
  return db
    .select({
      id: role.id,
      modelPolicy: role.modelPolicy,
      tokenPolicy: role.tokenPolicy,
    })
    .from(member)
    .innerJoin(memberRole, eq(memberRole.memberId, member.id))
    .innerJoin(role, eq(role.id, memberRole.roleId))
    .where(and(eq(member.userId, userId), eq(member.status, "enabled")))
    .orderBy(asc(role.createdAt), asc(role.id));
}
// The additive desktop migration may lag behind this code during a rolling
// deploy, so probe lazily. Only positive results are cached: once installed the
// table never disappears, while a not-yet-installed result keeps re-probing so
// a migration applied at runtime is picked up without a process restart.
let desktopUsageTableInstalled = false;

async function isDesktopUsageTableInstalled(): Promise<boolean> {
  if (!desktopUsageTableInstalled) {
    const available = await getDb().execute<{ installed: boolean }>(
      sql`select to_regclass('"DesktopInferenceUsage"') is not null as installed`
    );
    desktopUsageTableInstalled = available[0]?.installed === true;
  }
  return desktopUsageTableInstalled;
}

/** Each completed message counted once per role; organization membership is current, not historical. */
export async function getRoleTokenUsage(roleId: string, runId?: string) {
  const rows = await getDb().execute<{
    daily: number;
    monthly: number;
    perRun: number;
    missing: number;
  }>(sql`
    select coalesce(sum((e.data->'usage'->>'totalTokens')::numeric) filter (where e."createdAt" >= current_date and e."createdAt" < current_date + interval '1 day'), 0)::float as daily,
      coalesce(sum((e.data->'usage'->>'totalTokens')::numeric) filter (where e."createdAt" >= date_trunc('month', current_date) and e."createdAt" < date_trunc('month', current_date) + interval '1 month'), 0)::float as monthly,
      coalesce(sum((e.data->'usage'->>'totalTokens')::numeric) filter (where r.id = ${runId ?? null}::uuid), 0)::float as "perRun",
      count(*) filter (where e.data->'usage'->>'totalTokens' is null and e."createdAt" >= date_trunc('month', current_date) and e."createdAt" < date_trunc('month', current_date) + interval '1 month')::int as missing
    from "RuntimeEvent" e join "AgentRun" r on r.id = e."runId"
    where e.type = 'message.completed' and ((e."createdAt" >= date_trunc('month', current_date) and e."createdAt" < date_trunc('month', current_date) + interval '1 month') or r.id = ${runId ?? null}::uuid)
      and exists (select 1 from "Member" m join "MemberRole" mr on mr."memberId" = m.id where m."userId" = r."userId" and mr."roleId" = ${roleId}::uuid)
  `);
  const result = rows[0] ?? { daily: 0, missing: 0, monthly: 0, perRun: 0 };
  // Existing Web traffic remains available until the additive desktop migration is installed.
  // The desktop inference endpoint itself fails closed if its usage table is absent.
  if (!(await isDesktopUsageTableInstalled())) {
    return result;
  }
  const desktop = await getDb().execute<{
    daily: number;
    monthly: number;
    perRun: number;
    missing: number;
  }>(sql`
    select coalesce(sum(d."totalTokens") filter (where d."createdAt" >= current_date and d."createdAt" < current_date + interval '1 day'),0)::float as daily,
      coalesce(sum(d."totalTokens") filter (where d."createdAt" >= date_trunc('month',current_date) and d."createdAt" < date_trunc('month',current_date) + interval '1 month'),0)::float as monthly,
      coalesce(sum(d."totalTokens") filter (where d."runId" = ${runId ?? null}::uuid),0)::float as "perRun",
      count(*) filter (where d."totalTokens" is null and d."createdAt" >= date_trunc('month',current_date) and d."createdAt" < date_trunc('month',current_date) + interval '1 month')::int as missing
    from "DesktopInferenceUsage" d
    where ((d."createdAt" >= date_trunc('month',current_date) and d."createdAt" < date_trunc('month',current_date) + interval '1 month') or d."runId" = ${runId ?? null}::uuid)
      and exists (select 1 from "Member" m join "MemberRole" mr on mr."memberId"=m.id where m."userId"=d."userId" and mr."roleId"=${roleId}::uuid)
  `);
  const extra = desktop[0] ?? { daily: 0, missing: 0, monthly: 0, perRun: 0 };
  return {
    daily: result.daily + extra.daily,
    missing: result.missing + extra.missing,
    monthly: result.monthly + extra.monthly,
    perRun: result.perRun + extra.perRun,
  };
}
