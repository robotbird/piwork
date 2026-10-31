import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { parseSkillInstallLink } from "../../../lib/ai/skill-install-link.ts";
import { SKILL_LIMITS } from "../../../lib/ai/skill-limits";
import {
  createProjectSkill,
  deleteProjectSkill,
  extractProjectSkillArchive,
  fetchSkillInstallArchive,
  installProjectSkill,
  invokeSkill,
  loadProjectSkillSummaries,
  loadProjectSkills,
  normalizeSkillInstallArchive,
  parseSkillCommand,
  validateSkillName,
} from "../../../lib/ai/skills.ts";
import { withDeclaredSkillZipSizes } from "../../support/skill-zip";

test("creates and discovers a standard Pi skill", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skills-"));

  try {
    const created = await createProjectSkill({
      cwd,
      description: "Summarizes weekly reports when a user requests a recap.",
      displayName: "Weekly Recap",
      instructions: "# Weekly recap\n\nReturn three concise bullets.",
      name: "weekly-recap",
    });
    const skillFile = await readFile(created.filePath, "utf8");
    const metadataFile = await readFile(
      join(cwd, ".pi/skills/weekly-recap/agents/openai.yaml"),
      "utf8"
    );

    assert.match(skillFile, /^---\nname: "weekly-recap"/);
    assert.match(skillFile, /# Weekly recap/);
    assert.match(metadataFile, /display_name: "Weekly Recap"/);

    const loaded = await loadProjectSkills(cwd);
    assert.equal(loaded.diagnostics.length, 0);
    assert.equal(loaded.skills.length, 1);
    assert.equal(loaded.skills[0]?.name, "weekly-recap");

    const summaries = await loadProjectSkillSummaries(cwd);
    assert.equal(summaries.skills[0]?.displayName, "Weekly Recap");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("parses and formats explicit skill commands", async () => {
  const command = parseSkillCommand("/weekly-recap focus on risks");
  assert.deepEqual(command, {
    instructions: "focus on risks",
    name: "weekly-recap",
  });

  // 1.0.0 起 Skill 不含 content，invokeSkill 读 SKILL.md 并 stripFrontmatter
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skill-invoke-"));
  try {
    const skillDir = join(cwd, "weekly-recap");
    await mkdir(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    await writeFile(
      skillFile,
      '---\nname: "weekly-recap"\ndescription: "Summarizes weekly reports."\n---\n\n# Weekly recap\n\nReturn three concise bullets.\n'
    );

    const prompt = await invokeSkill(
      [
        {
          baseDir: skillDir,
          description: "Summarizes weekly reports.",
          disableModelInvocation: false,
          filePath: skillFile,
          name: "weekly-recap",
          sourceInfo: {
            origin: "top-level",
            path: skillFile,
            scope: "temporary",
            source: "test",
          },
        },
      ],
      "weekly-recap",
      command?.instructions
    );

    assert.match(prompt, /<skill name="weekly-recap"/);
    assert.match(prompt, /# Weekly recap/);
    assert.ok(!prompt.includes("description:"));
    assert.match(prompt, /focus on risks/);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rejects unsafe skill names", () => {
  assert.throws(() => validateSkillName("../unsafe"));
  assert.throws(() => validateSkillName("Uppercase"));
  assert.throws(() => validateSkillName("clear"));
  assert.doesNotThrow(() => validateSkillName("safe-skill-2"));
});

test("installs and deletes an uploaded skill folder", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skills-upload-"));

  try {
    const installed = await installProjectSkill({
      cwd,
      files: [
        {
          content: new TextEncoder().encode(
            [
              "---",
              "name: uploaded-skill",
              "description: Handles uploaded skill test requests.",
              "---",
              "",
              "# Uploaded skill",
            ].join("\n")
          ),
          path: "uploaded-skill/SKILL.md",
        },
        {
          content: new TextEncoder().encode("Supporting material"),
          path: "uploaded-skill/references/guide.md",
        },
      ],
    });

    assert.equal(installed.name, "uploaded-skill");
    assert.equal(
      await readFile(
        join(cwd, ".pi/skills/uploaded-skill/references/guide.md"),
        "utf8"
      ),
      "Supporting material"
    );

    await deleteProjectSkill("uploaded-skill", cwd);
    const loaded = await loadProjectSkills(cwd);
    assert.equal(loaded.skills.length, 0);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rejects uploads with unsafe paths", async () => {
  await assert.rejects(() =>
    installProjectSkill({
      files: [
        {
          content: new TextEncoder().encode("invalid"),
          path: "../SKILL.md",
        },
      ],
    })
  );
});

test("extracts a skill ZIP with a top-level directory", () => {
  const archive = zipSync({
    "zip-skill/references/guide.md": new TextEncoder().encode("Guide"),
    "zip-skill/SKILL.md": new TextEncoder().encode(
      [
        "---",
        "name: zip-skill",
        "description: Handles ZIP upload test requests.",
        "---",
        "",
        "# ZIP skill",
      ].join("\n")
    ),
  });

  const files = extractProjectSkillArchive({
    content: archive,
    filename: "zip-skill.zip",
  });

  assert.deepEqual(
    new Set(files.map((file) => file.path)),
    new Set(["zip-skill/SKILL.md", "zip-skill/references/guide.md"])
  );
});

test("wraps a root-level SKILL.md using the ZIP filename", () => {
  const archive = zipSync({
    "SKILL.md": new TextEncoder().encode(
      [
        "---",
        "name: root-zip-skill",
        "description: Handles root ZIP upload test requests.",
        "---",
      ].join("\n")
    ),
  });

  const files = extractProjectSkillArchive({
    content: archive,
    filename: "root-zip-skill.zip",
  });

  assert.equal(files[0]?.path, "root-zip-skill/SKILL.md");
});

test("installs a versioned ZIP filename using the frontmatter name", () => {
  const archive = zipSync({
    "SKILL.md": new TextEncoder().encode(
      [
        "---",
        "name: ai-ppt-skill",
        "description: Builds presentations from documents.",
        "---",
      ].join("\n")
    ),
  });

  const files = extractProjectSkillArchive({
    content: archive,
    filename: "ai-ppt-skill-1.0.0.zip",
  });

  assert.deepEqual(
    files.map((file) => file.path),
    ["ai-ppt-skill/SKILL.md"]
  );
});

test("installs a versioned top-level directory from a ZIP", () => {
  const archive = zipSync({
    "ai-ppt-skill-1.0.0/SKILL.md": new TextEncoder().encode(
      [
        "---",
        "name: ai-ppt-skill",
        "description: Builds presentations from documents.",
        "---",
      ].join("\n")
    ),
    "ai-ppt-skill-1.0.0/scripts/build.py": new TextEncoder().encode("print()"),
    "README.md": new TextEncoder().encode("Repository readme"),
  });

  const files = extractProjectSkillArchive({
    content: archive,
    filename: "ai-ppt-skill-1.0.0.zip",
  });

  assert.deepEqual(
    new Set(files.map((file) => file.path)),
    new Set(["ai-ppt-skill/SKILL.md", "ai-ppt-skill/scripts/build.py"])
  );
});

test("sanitizes a versioned folder name when frontmatter name is missing", () => {
  const archive = zipSync({
    "SKILL.md": new TextEncoder().encode(
      ["---", "description: Falls back to a sanitized name.", "---"].join("\n")
    ),
  });

  const files = extractProjectSkillArchive({
    content: archive,
    filename: "ai-ppt-skill-1.0.0.zip",
  });

  assert.deepEqual(
    files.map((file) => file.path),
    ["ai-ppt-skill-1-0-0/SKILL.md"]
  );
});

test("installs a versioned skill ZIP end to end", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skills-zip-"));

  try {
    const archive = zipSync({
      "ai-ppt-skill-1.0.0/SKILL.md": new TextEncoder().encode(
        [
          "---",
          "name: ai-ppt-skill",
          "description: Builds presentations from documents.",
          "---",
        ].join("\n")
      ),
    });
    const files = extractProjectSkillArchive({
      content: archive,
      filename: "ai-ppt-skill-1.0.0.zip",
    });

    const installed = await installProjectSkill({ cwd, files });

    assert.equal(installed.name, "ai-ppt-skill");
    assert.equal(
      await readFile(join(cwd, ".pi/skills/ai-ppt-skill/SKILL.md"), "utf8"),
      [
        "---",
        "name: ai-ppt-skill",
        "description: Builds presentations from documents.",
        "---",
      ].join("\n")
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("installs a folder upload with a versioned folder name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piwork-skills-folder-"));

  try {
    const installed = await installProjectSkill({
      cwd,
      files: [
        {
          content: new TextEncoder().encode(
            [
              "---",
              "name: ai-ppt-skill",
              "description: Builds presentations from documents.",
              "---",
            ].join("\n")
          ),
          path: "ai-ppt-skill-1.0.0/SKILL.md",
        },
        {
          content: new TextEncoder().encode("Guide"),
          path: "ai-ppt-skill-1.0.0/references/guide.md",
        },
      ],
    });

    assert.equal(installed.name, "ai-ppt-skill");
    assert.equal(
      await readFile(
        join(cwd, ".pi/skills/ai-ppt-skill/references/guide.md"),
        "utf8"
      ),
      "Guide"
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rejects path traversal in a skill ZIP", () => {
  const archive = zipSync({
    "../SKILL.md": new TextEncoder().encode("unsafe"),
  });

  assert.throws(() =>
    extractProjectSkillArchive({ content: archive, filename: "unsafe.zip" })
  );
});

const manifest = (name = "link-skill", description = "Installs from a link.") =>
  new TextEncoder().encode(
    [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      "# Instructions",
      "",
    ].join("\n")
  );

test("recognizes supported install links", () => {
  assert.deepEqual(parseSkillInstallLink("https://github.com/owner/repo"), {
    kind: "github-repo",
    owner: "owner",
    repo: "repo",
    url: "https://github.com/owner/repo",
  });
  assert.deepEqual(
    parseSkillInstallLink("https://github.com/owner/repo/tree/v2?tab=readme"),
    {
      kind: "github-repo",
      owner: "owner",
      ref: "v2",
      repo: "repo",
      url: "https://github.com/owner/repo",
    }
  );
  assert.deepEqual(parseSkillInstallLink("git@github.com:owner/my.repo.git"), {
    kind: "github-repo",
    owner: "owner",
    repo: "my.repo",
    url: "https://github.com/owner/my.repo",
  });

  const githubArchive = parseSkillInstallLink(
    "https://github.com/owner/repo/archive/refs/heads/main.zip"
  );
  assert.equal(githubArchive?.kind, "zip-url");

  const codeload = parseSkillInstallLink(
    "https://codeload.github.com/owner/repo/zip/refs/heads/main"
  );
  assert.equal(codeload?.kind, "zip-url");
  assert.equal(codeload?.filename, "repo");

  const direct = parseSkillInstallLink(
    "https://cdn.example.com/files/team skill.zip?token=abc"
  );
  assert.deepEqual(direct, {
    filename: "team skill",
    kind: "zip-url",
    url: "https://cdn.example.com/files/team%20skill.zip?token=abc",
  });

  assert.equal(parseSkillInstallLink(""), null);
  assert.equal(parseSkillInstallLink("not a url"), null);
  assert.equal(parseSkillInstallLink("ftp://example.com/skill.zip"), null);
  assert.equal(parseSkillInstallLink("https://gitlab.com/owner/repo"), null);
  assert.equal(
    parseSkillInstallLink("https://github.com/owner/repo/blob/main/SKILL.md"),
    null
  );
  assert.equal(parseSkillInstallLink("https://github.com/owner"), null);
});

test("normalizes a downloaded archive into installable skill files", () => {
  const files = normalizeSkillInstallArchive(
    [
      { content: manifest(), path: "repo-main/SKILL.md" },
      {
        content: new TextEncoder().encode("helper"),
        path: "repo-main/scripts/helper.txt",
      },
      {
        content: new TextEncoder().encode("meta"),
        path: ".github/workflows/ci.yml",
      },
      {
        content: new TextEncoder().encode("readme"),
        path: "README.md",
      },
    ],
    "repo"
  );

  assert.deepEqual(
    files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    ["link-skill/scripts/helper.txt", "link-skill/SKILL.md"]
  );
});

test("sanitizes the install folder name when frontmatter name is missing", () => {
  const noName = new TextEncoder().encode(
    ["---", 'description: "Falls back to the directory name."', "---"].join(
      "\n"
    )
  );
  const files = normalizeSkillInstallArchive(
    [
      { content: noName, path: "My.Awesome-Skill_v2/SKILL.md" },
      {
        content: new TextEncoder().encode("asset"),
        path: "My.Awesome-Skill_v2/assets/logo.png",
      },
    ],
    "fallback"
  );

  assert.deepEqual(
    files.map((file) => file.path),
    ["my-awesome-skill-v2/SKILL.md", "my-awesome-skill-v2/assets/logo.png"]
  );
});

test("rejects archives with multiple or zero skill manifests", () => {
  assert.throws(
    () =>
      normalizeSkillInstallArchive(
        [
          { content: manifest("one"), path: "one/SKILL.md" },
          { content: manifest("two"), path: "two/SKILL.md" },
        ],
        "repo"
      ),
    /exactly one SKILL\.md/
  );

  assert.throws(
    () =>
      normalizeSkillInstallArchive(
        [{ content: new TextEncoder().encode("x"), path: "README.md" }],
        "repo"
      ),
    /exactly one SKILL\.md/
  );
});

const publicResolver = (_hostname: string) =>
  Promise.resolve(["93.184.216.34"]);

test("downloads and installs a skill from a zip link", async () => {
  const archive = zipSync({
    "repo-main/assets/note.txt": new TextEncoder().encode("hi"),
    "repo-main/SKILL.md": manifest("zip-link-skill"),
  });
  const requested: string[] = [];
  const fetchImpl = (url: string) => {
    requested.push(url);
    return new Response(archive, {
      headers: { "content-type": "application/zip" },
    });
  };

  const link = parseSkillInstallLink("https://93.184.216.34/repo.zip");
  assert.ok(link);
  const files = await fetchSkillInstallArchive(link, {
    fetch: fetchImpl as unknown as typeof fetch,
    resolveHost: publicResolver,
  });

  assert.deepEqual(requested, ["https://93.184.216.34/repo.zip"]);
  assert.deepEqual(
    files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    ["zip-link-skill/assets/note.txt", "zip-link-skill/SKILL.md"]
  );

  const cwd = await mkdtemp(join(tmpdir(), "piwork-skill-link-"));
  try {
    const installed = await installProjectSkill({ cwd, files });
    assert.equal(installed.name, "zip-link-skill");
    const loaded = await loadProjectSkills(cwd);
    assert.equal(loaded.skills[0]?.name, "zip-link-skill");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("downloads a GitHub repository through the zipball endpoint", async () => {
  const archive = zipSync({ "demo-main/SKILL.md": manifest("gh-skill") });
  const requests: Array<{ headers: Headers; url: string }> = [];
  const fetchImpl = (url: string, init: RequestInit) => {
    requests.push({ headers: new Headers(init.headers), url });
    return new Response(archive, { status: 200 });
  };

  const link = parseSkillInstallLink("https://github.com/owner/demo/tree/v3");
  assert.ok(link);
  const files = await fetchSkillInstallArchive(link, {
    fetch: fetchImpl as unknown as typeof fetch,
    resolveHost: publicResolver,
  });

  assert.equal(files[0]?.path, "gh-skill/SKILL.md");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/repos/owner/demo/zipball/v3"
  );
  assert.match(requests[0]?.headers.get("user-agent") ?? "", /piwork/);
});

test("installs a nested skill from a repository whose archive exceeds the skill limit", async () => {
  // 仓库 docs/ 下有 16MB 资源，但 Skill 子树很小：两段式提取只保留 Skill 子树
  const archive = zipSync({
    "repo-main/docs/assets/hero.gif": new Uint8Array(16 * 1024 * 1024),
    "repo-main/README.md": new TextEncoder().encode("readme"),
    "repo-main/skills/inner/assets/note.txt": new TextEncoder().encode("hi"),
    "repo-main/skills/inner/SKILL.md": manifest("inner-skill"),
  });
  const fetchImpl = () =>
    new Response(archive, { headers: { "content-type": "application/zip" } });

  const link = parseSkillInstallLink("https://93.184.216.34/repo.zip");
  assert.ok(link);
  const files = await fetchSkillInstallArchive(link, {
    fetch: fetchImpl as unknown as typeof fetch,
    resolveHost: publicResolver,
  });
  assert.deepEqual(
    files.map((file) => file.path).sort((a, b) => a.localeCompare(b)),
    ["inner-skill/assets/note.txt", "inner-skill/SKILL.md"]
  );

  const cwd = await mkdtemp(join(tmpdir(), "piwork-skill-link-"));
  try {
    const installed = await installProjectSkill({ cwd, files });
    assert.equal(installed.name, "inner-skill");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rejects skill subtrees that exceed the install limits", async () => {
  const archive = withDeclaredSkillZipSizes(
    zipSync({
      "repo-main/skill/one.bin": new TextEncoder().encode("tiny fixture"),
      "repo-main/skill/SKILL.md": manifest("big-skill"),
    }),
    { "repo-main/skill/one.bin": SKILL_LIMITS.fileBytes + 1 }
  );
  const fetchImpl = () =>
    new Response(archive, { headers: { "content-type": "application/zip" } });
  const link = parseSkillInstallLink("https://93.184.216.34/repo.zip");
  assert.ok(link);

  await assert.rejects(
    fetchSkillInstallArchive(link, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveHost: publicResolver,
    }),
    { messageKey: "api.skillFileLimit" }
  );
});

test("rejects non-public and oversized archive downloads", async () => {
  const redirectResponse = () =>
    Response.redirect("http://127.0.0.1:8080/evil.zip", 302);
  const link = parseSkillInstallLink("https://93.184.216.34/repo.zip");
  assert.ok(link);

  await assert.rejects(
    fetchSkillInstallArchive(link, {
      fetch: redirectResponse as unknown as typeof fetch,
      resolveHost: publicResolver,
    }),
    /non-public skill host/
  );

  const privateResolver = async () => ["10.0.0.8"];
  const hostnameLink = parseSkillInstallLink(
    "https://files.example.com/skill.zip"
  );
  assert.ok(hostnameLink);
  await assert.rejects(
    fetchSkillInstallArchive(hostnameLink, {
      fetch: redirectResponse as unknown as typeof fetch,
      resolveHost: privateResolver,
    }),
    /non-public skill host/
  );

  const tooBig = new Response(null, {
    headers: { "content-length": String(101 * 1024 * 1024) },
    status: 200,
  });
  await assert.rejects(
    fetchSkillInstallArchive(link, {
      fetch: (async () => tooBig) as unknown as typeof fetch,
      resolveHost: publicResolver,
    }),
    /100 MB/
  );

  const notFound = new Response(null, { status: 404 });
  await assert.rejects(
    fetchSkillInstallArchive(link, {
      fetch: (async () => notFound) as unknown as typeof fetch,
      resolveHost: publicResolver,
    }),
    /HTTP 404/
  );
});
