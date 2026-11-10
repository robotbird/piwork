import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  desktopLoginReturn,
  hashDesktopSecret,
} from "../../../lib/auth/desktop-login";

test("desktop login return URLs cannot redirect to other pages or origins", () => {
  const state = randomBytes(32).toString("base64url");
  const challenge = hashDesktopSecret(randomBytes(32).toString("base64url"));
  const target = `/desktop-login?challenge=${challenge}&state=${state}`;
  assert.equal(desktopLoginReturn(target), target);
  for (const value of [
    null,
    "https://evil.test",
    "//evil.test/desktop-login",
    "/desktop-login",
    `${target}#fragment`,
    target.replace(challenge, "bad"),
    "/desktop-login?state=x&challenge=y",
  ]) {
    assert.equal(desktopLoginReturn(value), null);
  }
  assert.equal(
    desktopLoginReturn(`${target}&callbackUrl=https://evil.test`),
    target
  );
});
