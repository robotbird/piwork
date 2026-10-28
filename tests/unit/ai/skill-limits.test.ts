import assert from "node:assert/strict";
import test from "node:test";
import { forEachSkillFile } from "../../../lib/ai/skill-file-operations";
import {
  isCommentOnlySkillEnvExample,
  SKILL_LIMITS,
} from "../../../lib/ai/skill-limits";

test("shared PPT quotas remain bounded and fit inside runtime transfer quotas", () => {
  assert.equal(SKILL_LIMITS.files, 20_000);
  assert.equal(SKILL_LIMITS.totalBytes, 100 * 1024 * 1024);
  assert(SKILL_LIMITS.bundleFiles >= SKILL_LIMITS.files);
  assert(SKILL_LIMITS.bundleBytes >= SKILL_LIMITS.totalBytes);
  assert(
    SKILL_LIMITS.fileBytes <= 50 * 1024 * 1024,
    "filesystem transfer ceiling"
  );
});

test("only comment-only config templates are admitted, including CR-only line boundaries", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(
    isCommentOnlySkillEnvExample(
      bytes("# Example only\n\n# KEY=placeholder\n")
    ),
    true
  );
  for (const separator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    assert.equal(
      isCommentOnlySkillEnvExample(
        bytes(`# Example${separator}KEY=not-allowed`)
      ),
      false
    );
  }
  assert.equal(
    isCommentOnlySkillEnvExample(new Uint8Array(64 * 1024 + 1)),
    false
  );
});

test("bounded writes stop scheduling on failure and drain before rollback", async () => {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const run = forEachSkillFile([0, 1, 2, 3, 4], 2, async (file) => {
    started.push(file);
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (file === 0) {
        await Promise.resolve();
        throw new Error("fixture write failed");
      }
      await barrier;
    } finally {
      active -= 1;
    }
  });
  let settled = false;
  const observed = assert.rejects(run, /fixture write failed/).then(() => {
    settled = true;
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(
    settled,
    false,
    "must not race rollback against in-flight writes"
  );
  assert.deepEqual(started, [0, 1]);
  release?.();
  await observed;
  assert.equal(active, 0);
  assert.equal(peak, 2);
  await assert.rejects(forEachSkillFile([1], 0, () => Promise.resolve()));
});
