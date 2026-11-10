CREATE TABLE "DesktopInferenceUsage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"runId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"totalTokens" integer,
	"inputTokens" integer,
	"outputTokens" integer
);
--> statement-breakpoint
ALTER TABLE "DesktopInferenceUsage" ADD CONSTRAINT "DesktopInferenceUsage_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "DesktopInferenceUsage_user_created_idx" ON "DesktopInferenceUsage" USING btree ("userId","createdAt");