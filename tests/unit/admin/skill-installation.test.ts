import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { SkillInstallationService } from "../../../lib/admin/skill-installation";
import {
  deleteProjectSkill,
  installProjectSkill,
} from "../../../lib/ai/skills";

const encode = (text: string) => new TextEncoder().encode(text);
const archive = () =>
  zipSync(
    Object.fromEntries(
      ["alpha", "beta", "gamma"].flatMap((name) => [
        [
          `repo/skills/${name}/SKILL.md`,
          encode(
            `---\nname: ${name}\ndescription: ${name} instructions.\n---\nBody`
          ),
        ],
        [`repo/skills/${name}/assets/note.txt`, encode(`${name} asset`)],
      ])
    )
  );

test("owner-bound snapshot installs only selected roots and registers trusted identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skill-batch-"));
  const writes: Array<{ actor: string; name: string }> = [];
  let downloads = 0;
  const service = new SkillInstallationService({
    download: (link) => {
      downloads += 1;
      assert.equal(link.kind, "github-repo");
      assert.equal(link.kind === "github-repo" && link.ref, "v2");
      return Promise.resolve({ content: archive(), fallbackName: "repo" });
    },
    existingNames: () => Promise.resolve(new Set<string>()),
    install: (files) => installProjectSkill({ cwd, files }),
    register: (name, actor) => {
      writes.push({ actor, name });
      return Promise.resolve();
    },
    remove: (name) => deleteProjectSkill(name, cwd),
  });
  try {
    const preview = await service.preview(
      "admin-one",
      "https://github.com/example/repo/tree/v2"
    );
    const ids = preview.candidates.slice(0, 2).map((candidate) => candidate.id);
    await assert.rejects(service.install("admin-two", preview.token, ids));
    service.discard("admin-two", preview.token);
    await assert.rejects(service.install("admin-one", preview.token, []));
    await assert.rejects(
      service.install("admin-one", preview.token, [ids[0], ids[0]])
    );
    await assert.rejects(
      service.install("admin-one", preview.token, ["f".repeat(64)])
    );
    const results = await service.install("admin-one", preview.token, ids);
    assert.deepEqual(
      results.map((result) => result.status),
      ["installed", "installed"]
    );
    assert.equal(
      downloads,
      1,
      "installation must not refetch a moving repository ref"
    );
    assert.deepEqual(writes, [
      { actor: "admin-one", name: "alpha" },
      { actor: "admin-one", name: "beta" },
    ]);
    assert.equal(
      await readFile(join(cwd, ".pi/skills/alpha/assets/note.txt"), "utf8"),
      "alpha asset"
    );
    await assert.rejects(readFile(join(cwd, ".pi/skills/gamma/SKILL.md")));
    await assert.rejects(
      service.install("admin-one", preview.token, ids),
      "cannot repeat already-installed items"
    );
    service.discard("admin-one", preview.token);
    await assert.rejects(
      service.install("admin-one", preview.token, [preview.candidates[2].id])
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("per-item failures rollback only that item, preserve successful siblings and allow retry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skill-partial-"));
  let failBeta = true;
  const registered = new Set<string>();
  const removed: string[] = [];
  const service = new SkillInstallationService({
    download: () =>
      Promise.resolve({ content: archive(), fallbackName: "repo" }),
    existingNames: () => Promise.resolve(new Set(registered)),
    install: (files) => installProjectSkill({ cwd, files }),
    register: (name) => {
      if (name === "beta" && failBeta) {
        return Promise.reject(new Error("fixture-registration-failure"));
      }
      registered.add(name);
      return Promise.resolve();
    },
    remove: (name) => {
      removed.push(name);
      return deleteProjectSkill(name, cwd);
    },
  });
  try {
    const preview = await service.preview(
      "admin",
      "https://example.com/skills.zip"
    );
    const results = await service.install(
      "admin",
      preview.token,
      preview.candidates.map((candidate) => candidate.id)
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["installed", "failed", "installed"]
    );
    assert.deepEqual(removed, ["beta"]);
    assert.match(
      await readFile(join(cwd, ".pi/skills/alpha/SKILL.md"), "utf8"),
      /alpha/
    );
    await assert.rejects(readFile(join(cwd, ".pi/skills/beta/SKILL.md")));
    failBeta = false;
    const retried = await service.install("admin", preview.token, [
      preview.candidates[1].id,
    ]);
    assert.equal(retried[0].status, "installed");
    await assert.rejects(
      service.install("admin", preview.token, [preview.candidates[1].id])
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("conflicts are shown at preview and rechecked at install; expiry/discard refuse work", async () => {
  let now = 1000;
  let names = new Set(["alpha"]);
  let installCalls = 0;
  const service = new SkillInstallationService({
    download: () =>
      Promise.resolve({ content: archive(), fallbackName: "repo" }),
    existingNames: () => Promise.resolve(new Set(names)),
    install: () => {
      installCalls += 1;
      return Promise.resolve({ name: "beta" });
    },
    now: () => now,
    register: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  });
  const preview = await service.preview(
    "admin",
    "https://example.com/skills.zip"
  );
  assert.equal(preview.candidates[0].issue, "installed");
  await assert.rejects(
    service.install("admin", preview.token, [preview.candidates[0].id])
  );
  names = new Set(["alpha", "beta"]);
  const results = await service.install("admin", preview.token, [
    preview.candidates[1].id,
  ]);
  assert.equal(results[0].issue, "installed");
  assert.equal(installCalls, 0);
  now = preview.expiresAt + 1;
  await assert.rejects(
    service.install("admin", preview.token, [preview.candidates[2].id])
  );
});

test("in-flight download admission and same-token install locking are enforced", async () => {
  let releaseDownloads: (() => void) | undefined;
  const blocked = new Promise<void>((done) => {
    releaseDownloads = done;
  });
  const service = new SkillInstallationService({
    download: async () => {
      await blocked;
      return { content: archive(), fallbackName: "repo" };
    },
    existingNames: () => Promise.resolve(new Set()),
    install: () => Promise.resolve({ name: "alpha" }),
    register: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  });
  const first = service.preview("admin", "https://example.com/a.zip");
  const second = service.preview("admin", "https://example.com/b.zip");
  await assert.rejects(service.preview("admin", "https://example.com/c.zip"));
  releaseDownloads?.();
  const previews = await Promise.all([first, second]);
  for (const preview of previews) {
    service.discard("admin", preview.token);
  }

  let releaseInstall: (() => void) | undefined;
  const installBlocked = new Promise<void>((done) => {
    releaseInstall = done;
  });
  const locking = new SkillInstallationService({
    download: () =>
      Promise.resolve({ content: archive(), fallbackName: "repo" }),
    existingNames: () => Promise.resolve(new Set()),
    install: async () => {
      await installBlocked;
      return { name: "alpha" };
    },
    register: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  });
  const preview = await locking.preview("admin", "https://example.com/a.zip");
  const ids = [preview.candidates[0].id];
  const firstInstall = locking.install("admin", preview.token, ids);
  await assert.rejects(locking.install("admin", preview.token, ids));
  releaseInstall?.();
  assert.equal((await firstInstall)[0].status, "installed");
  locking.discard("admin", preview.token);
});
