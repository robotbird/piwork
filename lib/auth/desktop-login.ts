import { createHash } from "node:crypto";

export const DESKTOP_CALLBACK = "piwork://auth/callback";
export const DESKTOP_CODE_TTL_MS = 60_000;

export function hashDesktopSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export {
  desktopLoginReturn,
  desktopSecretPattern,
} from "./desktop-login-return";
