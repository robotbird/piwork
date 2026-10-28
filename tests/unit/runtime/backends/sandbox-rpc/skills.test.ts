import "../../../../support/runtime-env";
import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { SKILL_LIMITS } from "@/lib/ai/skill-limits";
import {
  buildSkillsSystemPrompt,
  installProjectSkill,
  listProjectSkillFiles,
} from "@/lib/ai/skills";
import {
  installSandboxSkills,
  sandboxSkillsPrompt,
  snapshotSandboxSkills,
} from "@/lib/runtime/backends/sandbox-rpc/skills";
import type { RuntimeSpec } from "@/lib/runtime/protocol";
import { MAX_SKILL_FILE_BYTES } from "@/lib/runtime/protocol/skill-bundle";
import { TestSandboxProvider } from "../../../../support/sandbox/test-sandbox-provider";

Object.assign(process.env, { NODE_ENV: "test" });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "piwork-skills-unit-"));
  await cp(
    path.resolve("tests/fixtures/skills/sandbox-script"),
    path.join(root, "sandbox-script"),
    { recursive: true }
  );
  const { skills } = loadSkillsFromDir({ dir: root, source: "project" });
  assert.equal(skills.length, 1);
  return { options: { allowNonLinuxForTests: true, root }, root, skills };
}

test("snapshots complete enabled directory, not other sibling skills or later edits", async () => {
  const f = await fixture();
  try {
    await cp(
      path.join(f.root, "sandbox-script"),
      path.join(f.root, "disabled"),
      { recursive: true }
    );
    const snapshots = await snapshotSandboxSkills(f.skills, f.options);
    assert.deepEqual(snapshots[0].files.map((file) => file.path).sort(), [
      "SKILL.md",
      "assets/value.txt",
      "references/usage.txt",
      "scripts/report.mjs",
    ]);
    await writeFile(
      path.join(f.root, "sandbox-script/assets/value.txt"),
      "changed"
    );
    const asset = snapshots[0].files.find(
      (file) => file.path === "assets/value.txt"
    );
    assert(asset);
    assert.equal(Buffer.from(asset.bytes).toString(), "沙箱资源\n");
    assert.deepEqual(await snapshotSandboxSkills([], f.options), []);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});

test("rejects host references outside the platform-managed root and duplicate names", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      snapshotSandboxSkills([{ ...f.skills[0], baseDir: "/etc" }], f.options),
      /unmanaged-source/
    );
    await assert.rejects(
      snapshotSandboxSkills([f.skills[0], f.skills[0]], f.options),
      /invalid-name/
    );
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});

test("rejects symlink and hardlink payloads before transfer", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, "sandbox-script/assets/value.txt");
    const entry = path.join(f.root, "sandbox-script/assets/link.txt");
    await symlink(target, entry);
    await assert.rejects(snapshotSandboxSkills(f.skills, f.options));
    await rm(entry);
    await link(target, entry);
    await assert.rejects(
      snapshotSandboxSkills(f.skills, f.options),
      /unsupported-file/
    );
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});

test("rejects oversized files, credential files and changed root instructions", async () => {
  const f = await fixture();
  try {
    const extra = path.join(f.root, "sandbox-script/assets/large.bin");
    await writeFile(extra, "");
    await truncate(extra, MAX_SKILL_FILE_BYTES + 1);
    await assert.rejects(
      snapshotSandboxSkills(f.skills, f.options),
      /byte-or-file-limit/
    );
    await rm(extra);
    const secret = path.join(f.root, "sandbox-script/.env");
    await writeFile(secret, "not-a-real-key");
    await assert.rejects(
      snapshotSandboxSkills(f.skills, f.options),
      /unsafe-path/
    );
    await rm(secret);
    const template = path.join(f.root, "sandbox-script/.env.example");
    await writeFile(template, "API_KEY=must-not-transfer\n");
    await assert.rejects(
      snapshotSandboxSkills(f.skills, f.options),
      /unsafe-config-template/
    );
    await writeFile(template, "# API_KEY=example-only\n\n");
    assert(
      (await snapshotSandboxSkills(f.skills, f.options))[0].files.some(
        (file) => file.path === ".env.example"
      )
    );
    await rm(template);
    await writeFile(
      f.skills[0].filePath,
      "---\nname: another-skill\ndescription: Changed\n---\nBody"
    );
    await assert.rejects(
      snapshotSandboxSkills(f.skills, f.options),
      /instructions-mismatch/
    );
    await writeFile(
      f.skills[0].filePath,
      "---\ndescription: Name falls back to directory\n---\nBody"
    );
    const fallback = await snapshotSandboxSkills(f.skills, f.options);
    assert.equal(fallback[0].skill.name, "sandbox-script");
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});

test("atomic copies are sandbox-relative, distinct each install, and fail closed", async () => {
  const f = await fixture();
  const provider = new TestSandboxProvider();
  const handle = await provider.acquire({
    chatId: crypto.randomUUID(),
    egress: { mode: "deny-all" },
    image: "test",
    resource: { cpuCores: 1, memoryMB: 768 },
    runId: crypto.randomUUID(),
    ttlSeconds: 60,
    workspaceVolume: { source: "ephemeral" },
  });
  try {
    const snapshots = await snapshotSandboxSkills(f.skills, f.options);
    const first = await installSandboxSkills(handle, snapshots);
    const second = await installSandboxSkills(handle, snapshots);
    assert.notEqual(first[0], second[0]);
    assert(first[0].startsWith(handle.workspaceRoot));
    assert.equal(
      Buffer.from(
        await handle.readFile(
          path.join(path.dirname(first[0]), "assets/value.txt")
        )
      ).toString(),
      "沙箱资源\n"
    );
    const { filesystem } = handle;
    assert(filesystem);
    const saved = filesystem.writeAtomic;
    filesystem.writeAtomic = () => Promise.reject(new Error("transfer failed"));
    await assert.rejects(
      installSandboxSkills(handle, snapshots),
      /transfer failed/
    );
    filesystem.writeAtomic = saved;
  } finally {
    await provider.release(handle, "kill");
    await rm(f.root, { force: true, recursive: true });
  }
});

test("PPT-style resources cross former 500/512 file limits without truncation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "piwork-ppt-skill-"));
  try {
    const files = Array.from({ length: 600 }, (_, index) => ({
      content: new TextEncoder().encode(`asset-${index}`),
      path: `ppt-fixture/assets/template-${index}.txt`,
    }));
    files.push({
      content: new TextEncoder().encode(
        "---\nname: ppt-fixture\ndescription: PPT resource fixture.\n---\nUse bundled assets."
      ),
      path: "ppt-fixture/SKILL.md",
    });
    files.push({
      content: new Uint8Array(6 * 1024 * 1024),
      path: "ppt-fixture/assets/large.bin",
    });
    const installed = await installProjectSkill({ cwd, files });
    const listed = await listProjectSkillFiles(installed.name, cwd);
    assert.equal(listed.truncated, false);
    assert.equal(
      listed.entries.filter((entry) => entry.kind === "file").length,
      files.length
    );
    const snapshots = await snapshotSandboxSkills([installed], {
      allowNonLinuxForTests: true,
      root: path.join(cwd, ".pi/skills"),
    });
    assert.equal(snapshots[0].files.length, files.length);
    let active = 0;
    let peak = 0;
    const copied = new Set<string>();
    const provider = new TestSandboxProvider();
    const handle = await provider.acquire({
      chatId: crypto.randomUUID(),
      egress: { mode: "deny-all" },
      image: "test",
      resource: { cpuCores: 1, memoryMB: 768 },
      runId: crypto.randomUUID(),
      ttlSeconds: 60,
      workspaceVolume: { source: "ephemeral" },
    });
    try {
      assert(handle.filesystem);
      handle.filesystem.writeAtomic = async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        assert.equal(input.expectedSha256, null);
        await Promise.resolve();
        copied.add(input.path);
        active -= 1;
        assert(input.content.byteLength <= input.maxBytes);
      };
      const paths = await installSandboxSkills(handle, snapshots);
      assert.equal(paths.length, 1);
      assert.equal(copied.size, files.length);
      assert(peak <= SKILL_LIMITS.sandboxWriteConcurrency);
    } finally {
      await provider.release(handle, "kill");
    }
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("remote prompt removes host catalog and rebases only generated workspace instructions", async () => {
  const f = await fixture();
  try {
    const spec = {
      appendSystemPrompt: [
        buildSkillsSystemPrompt(f.skills),
        "unchanged custom text",
        "## Workspace and execution tools\n- Your working directory (workspace) is: /host/workspace.",
      ],
      skills: f.skills,
      workspaceDir: "/host/workspace",
    } as RuntimeSpec;
    const prompt = sandboxSkillsPrompt(spec, "/workspace").join("\n");
    assert(!prompt.includes(f.root));
    assert(!prompt.includes("/host/workspace"));
    assert(prompt.includes("unchanged custom text"));
    assert(prompt.includes("read to load"));
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});
