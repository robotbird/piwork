ALTER TABLE "AgentRun" ADD COLUMN "stopRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "AgentRun" ADD COLUMN "cleanupError" text;