import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import {
  DESKTOP_CODE_TTL_MS,
  hashDesktopSecret,
} from "@/lib/auth/desktop-login";
import { getDb } from "./client";
import { desktopLoginGrant } from "./schema";

export async function createDesktopLoginGrant(
  userId: string,
  challenge: string
) {
  const db = getDb();
  const code = randomBytes(32).toString("base64url");
  await db
    .delete(desktopLoginGrant)
    .where(lte(desktopLoginGrant.expiresAt, new Date()));
  await db.insert(desktopLoginGrant).values({
    challenge,
    codeHash: hashDesktopSecret(code),
    expiresAt: new Date(Date.now() + DESKTOP_CODE_TTL_MS),
    userId,
  });
  return code;
}

/** DELETE RETURNING makes concurrent exchanges and replays fail atomically. */
export async function consumeDesktopLoginGrant(code: string, verifier: string) {
  const [grant] = await getDb()
    .delete(desktopLoginGrant)
    .where(
      and(
        eq(desktopLoginGrant.codeHash, hashDesktopSecret(code)),
        eq(desktopLoginGrant.challenge, hashDesktopSecret(verifier)),
        gt(desktopLoginGrant.expiresAt, new Date())
      )
    )
    .returning({ userId: desktopLoginGrant.userId });
  return grant?.userId ?? null;
}
