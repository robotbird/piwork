CREATE TABLE "DesktopLoginGrant" (
	"codeHash" varchar(43) PRIMARY KEY NOT NULL,
	"challenge" varchar(43) NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"userId" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "DesktopLoginGrant" ADD CONSTRAINT "DesktopLoginGrant_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;