import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
  extractSkillInstallCandidate,
  inspectSkillInstallArchive,
} from "../../../lib/ai/skill-install-archive";
import { SKILL_LIMITS } from "../../../lib/ai/skill-limits";
import { installProjectSkill } from "../../../lib/ai/skills";
import { withDeclaredSkillZipSizes } from "../../support/skill-zip";

const encode = (text: string) => new TextEncoder().encode(text);
const manifest = (name: string, description = "A standard skill.") =>
  encode(
    `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`
  );

test("discovers multiple nested sibling skills with official Pi multiline frontmatter", async () => {
  const content = zipSync({
    "repo-main/.github/actions/not-a-skill/SKILL.md": manifest("ignored"),
    "repo-main/docs/large.bin": new Uint8Array(6 * 1024 * 1024),
    "repo-main/skills/one/SKILL.md": manifest(
      "one",
      "|\n  First line.\n  Second line."
    ),
    "repo-main/skills/one/scripts/helper.py": encode("print(1)"),
    "repo-main/skills/two/assets/hello.txt": encode("hello"),
    "repo-main/skills/two/SKILL.md": manifest("two"),
  });
  const candidates = await inspectSkillInstallArchive(content, "repo");
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((item) => item.name),
    ["one", "two"]
  );
  assert.match(candidates[0].description, /First line.\nSecond line./);
  assert.equal(candidates[0].fileCount, 2);
  assert.equal(candidates[0].issue, null);
  const [, two] = candidates;
  const files = extractSkillInstallCandidate(content, two);
  assert.deepEqual(
    new Set(files.map((file) => file.path)),
    new Set(["two/SKILL.md", "two/assets/hello.txt"])
  );
  const cwd = await mkdtemp(join(tmpdir(), "piwork-multi-skills-"));
  try {
    await installProjectSkill({ cwd, files });
    assert.equal(
      await readFile(join(cwd, ".pi/skills/two/assets/hello.txt"), "utf8"),
      "hello"
    );
    // Duplicate installs must not delete an already-installed directory.
    await assert.rejects(installProjectSkill({ cwd, files }), /already exists/);
    assert.equal(
      await readFile(join(cwd, ".pi/skills/two/assets/hello.txt"), "utf8"),
      "hello"
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("reports oversized/invalid/duplicate items without hiding healthy siblings", async () => {
  const entries: Record<string, Uint8Array> = {
    "repo/big-file/asset.bin": encode("asset"),
    "repo/big-file/SKILL.md": manifest("big-file"),
    "repo/dup1/SKILL.md": manifest("duplicate"),
    "repo/dup2/SKILL.md": manifest("duplicate"),
    "repo/invalid/SKILL.md": encode(
      "---\nname: invalid\n---\nMissing description."
    ),
    "repo/large/SKILL.md": manifest("large"),
    "repo/ok/SKILL.md": manifest("ok"),
  };
  for (let i = 0; i < SKILL_LIMITS.files; i += 1) {
    entries[`repo/large/assets/${i}.txt`] = encode("asset");
  }
  const content = withDeclaredSkillZipSizes(zipSync(entries), {
    "repo/big-file/asset.bin": SKILL_LIMITS.fileBytes + 1,
  });
  const candidates = await inspectSkillInstallArchive(content, "repo");
  const byPath = new Map(candidates.map((item) => [item.path, item]));
  assert.equal(byPath.get("repo/large")?.issue, "fileCount");
  assert.equal(byPath.get("repo/large")?.fileCount, SKILL_LIMITS.files + 1);
  assert.equal(byPath.get("repo/invalid")?.issue, "invalid");
  assert.equal(byPath.get("repo/ok")?.issue, null);
  assert.equal(byPath.get("repo/dup1")?.issue, "duplicateName");
  assert.equal(byPath.get("repo/dup2")?.issue, "duplicateName");
  assert.equal(byPath.get("repo/big-file")?.issue, "fileSize");
  const large = byPath.get("repo/large");
  assert.ok(large);
  assert.throws(() => extractSkillInstallCandidate(content, large));
});

test("shows exact total bytes, blocks total-size limits, and never trims nested resources", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [
      `repo/big/${i}.bin`,
      encode("tiny fixture"),
    ])
  );
  const content = withDeclaredSkillZipSizes(
    zipSync({
      ...files,
      "repo/big/SKILL.md": manifest("big"),
      "repo/parent/child/asset.txt": encode("child asset"),
      "repo/parent/child/SKILL.md": manifest("child"),
      "repo/parent/SKILL.md": manifest("parent"),
    }),
    Object.fromEntries(
      Object.keys(files).map((name) => [name, SKILL_LIMITS.fileBytes])
    )
  );
  const candidates = await inspectSkillInstallArchive(content, "repo");
  assert.equal(
    candidates.find((item) => item.name === "parent")?.issue,
    "nested"
  );
  assert.equal(
    candidates.find((item) => item.name === "big")?.issue,
    "totalSize"
  );
  const child = candidates.find((item) => item.name === "child");
  assert.ok(child);
  assert.equal(child.issue, null);
  assert.equal(extractSkillInstallCandidate(content, child).length, 2);
});

test("supports root manifests and rejects unsafe, empty, excessive or malformed archives", async () => {
  const root = zipSync({
    "asset.txt": encode("x"),
    "SKILL.md": manifest("root-skill"),
  });
  const [candidate] = await inspectSkillInstallArchive(root, "fallback");
  assert.equal(candidate.path, ".");
  assert.equal(candidate.name, "root-skill");
  assert.equal(extractSkillInstallCandidate(root, candidate).length, 2);
  for (const path of [
    "../outside/SKILL.md",
    "/absolute/SKILL.md",
    "C:/windows/SKILL.md",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: independent unsafe path cases are exercised in order
    await assert.rejects(
      inspectSkillInstallArchive(zipSync({ [path]: manifest("bad") }), "repo")
    );
  }
  await assert.rejects(
    inspectSkillInstallArchive(zipSync({ "README.md": encode("x") }), "repo")
  );
  await assert.rejects(inspectSkillInstallArchive(encode("not a zip"), "repo"));
  const many = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [
      `repo/skill-${i}/SKILL.md`,
      manifest(`skill-${i}`),
    ])
  );
  await assert.rejects(inspectSkillInstallArchive(zipSync(many), "repo"));
});

test("ignored root manifest cannot substitute an unrelated Markdown skill at install time", async () => {
  const content = zipSync({
    "repo/skill/.gitignore": encode("SKILL.md\n"),
    "repo/skill/README.md": manifest("unexpected"),
    "repo/skill/SKILL.md": manifest("previewed"),
  });
  const [candidate] = await inspectSkillInstallArchive(content, "repo");
  assert.equal(candidate.name, "previewed");
  const files = extractSkillInstallCandidate(content, candidate);
  const cwd = await mkdtemp(join(tmpdir(), "piwork-root-skill-"));
  try {
    await assert.rejects(installProjectSkill({ cwd, files }));
    await assert.rejects(readFile(join(cwd, ".pi/skills/unexpected/SKILL.md")));
    await assert.rejects(readFile(join(cwd, ".pi/skills/previewed/SKILL.md")));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("exclusive publish permits only one concurrent install of the same name", async () => {
  const content = zipSync({
    "repo/test/SKILL.md": manifest("concurrent-skill"),
  });
  const [candidate] = await inspectSkillInstallArchive(content, "repo");
  const files = extractSkillInstallCandidate(content, candidate);
  const cwd = await mkdtemp(join(tmpdir(), "piwork-concurrent-skills-"));
  try {
    const results = await Promise.allSettled([
      installProjectSkill({ cwd, files }),
      installProjectSkill({ cwd, files }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.match(
      await readFile(join(cwd, ".pi/skills/concurrent-skill/SKILL.md"), "utf8"),
      /concurrent-skill/
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
