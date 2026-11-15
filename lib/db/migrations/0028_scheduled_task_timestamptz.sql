-- Scheduled-task time columns: timestamp (no tz) -> timestamptz.
-- Existing literals were written by the app in UTC semantics
-- (postgres.js serializes Date as UTC), so convert with AT TIME ZONE 'UTC'.
-- After this migration, SQL-side writes (now(), manual ops) and app-side
-- Date writes agree on absolute instants (production incident 2026-11-15:
-- a manual `nextRunAt = now() - interval` landed 8h off in CST and the
-- scheduler silently ignored the task).
ALTER TABLE "ScheduledTask" ALTER COLUMN "createdAt" TYPE timestamptz USING "createdAt" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTask" ALTER COLUMN "updatedAt" TYPE timestamptz USING "updatedAt" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTask" ALTER COLUMN "lastRunAt" TYPE timestamptz USING "lastRunAt" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTask" ALTER COLUMN "lockedUntil" TYPE timestamptz USING "lockedUntil" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTask" ALTER COLUMN "nextRunAt" TYPE timestamptz USING "nextRunAt" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTaskRun" ALTER COLUMN "startedAt" TYPE timestamptz USING "startedAt" AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE "ScheduledTaskRun" ALTER COLUMN "finishedAt" TYPE timestamptz USING "finishedAt" AT TIME ZONE 'UTC';
