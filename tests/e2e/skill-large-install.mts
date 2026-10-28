// Opt-in single real Skill fixture. No platform DB, identity, model or capacity test.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  extractSkillInstallCandidate,
  inspectSkillInstallArchive,
} from "../../lib/ai/skill-install-archive";
import { parseSkillInstallLink } from "../../lib/ai/skill-install-link";
import {
  downloadSkillInstallArchive,
  installProjectSkill,
  listProjectSkillFiles,
} from "../../lib/ai/skills";
import { snapshotSandboxSkills } from "../../lib/runtime/backends/sandbox-rpc/skills";

if (process.env.PIWORK_LARGE_SKILL_TEST === "1") {
  const base = path.join(process.cwd(), ".pi/test-sandboxes");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "large-skill-"));
  const previous = process.env.NODE_ENV;
  const docker =
    process.platform === "darwin" &&
    process.env.PIWORK_LARGE_SKILL_DOCKER === "1";
  Object.assign(process.env, { NODE_ENV: docker ? "development" : "test" });
  try {
    const link = parseSkillInstallLink(
      process.env.PIWORK_LARGE_SKILL_URL ??
        "https://github.com/hugohe3/ppt-master"
    );
    assert(link);
    const { content, fallbackName } = await downloadSkillInstallArchive(link);
    const candidates = await inspectSkillInstallArchive(content, fallbackName);
    const candidate = candidates.find((item) => !item.issue);
    assert(
      candidate,
      JSON.stringify(candidates.map(({ name, issue }) => ({ issue, name })))
    );
    const files = extractSkillInstallCandidate(content, candidate);
    const installed = await installProjectSkill({ cwd, files });
    const listing = await listProjectSkillFiles(installed.name, cwd);
    assert.equal(listing.truncated, false);
    assert.equal(
      listing.entries.filter((item) => item.kind === "file").length,
      candidate.fileCount
    );
    const snapshots = await snapshotSandboxSkills([installed], {
      allowNonLinuxForTests: !docker,
      root: path.join(cwd, ".pi/skills"),
    });
    const expected = new Map(
      files.map((file) => [
        file.path.slice(installed.name.length + 1),
        file.content,
      ])
    );
    assert.equal(snapshots[0].files.length, expected.size);
    for (const file of snapshots[0].files) {
      const original = expected.get(file.path);
      assert(original);
      assert(Buffer.from(file.bytes).equals(Buffer.from(original)), file.path);
    }
    console.log(
      JSON.stringify({
        collector: docker
          ? "docker-linux-pinned-fd"
          : process.platform === "linux"
            ? "linux-pinned-fd"
            : "explicit-test-fallback",
        files: candidate.fileCount,
        name: installed.name,
        runtimeExecutionTested: false,
        totalBytes: candidate.totalBytes,
        verified:
          "all installed files + browse + complete snapshot match archive",
      })
    );
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.assign(process.env, { NODE_ENV: previous });
    }
    await rm(cwd, { force: true, recursive: true });
  }
} else {
  console.log(
    "Skipped: PIWORK_LARGE_SKILL_TEST=1 enables a real archive install fixture."
  );
}
