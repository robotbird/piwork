CREATE TABLE "DesktopSyncState" (
	"chatId" uuid PRIMARY KEY NOT NULL,
	"activeBy" varchar,
	"leaseToken" uuid,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "DesktopSyncState" ADD CONSTRAINT "DesktopSyncState_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE cascade ON UPDATE no action;