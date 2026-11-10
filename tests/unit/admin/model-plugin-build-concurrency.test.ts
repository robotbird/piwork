import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPluginArtifact } from "../../../lib/model-plugins/build";
import { loadBuiltinPluginCatalog } from "../../../lib/model-plugins/builtin-catalog";
import { inspectPluginZip } from "../../../lib/model-plugins/inspect";

test("parallel builds of the same plugin publish one stable artifact", async () => {
  const original = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "piwork-plugin-concurrency-"));
  try {
    await Promise.all(
      ["plugins", "packages", "node_modules", "lib"].map((entry) =>
        symlink(path.join(original, entry), path.join(root, entry), "dir")
      )
    );
    process.chdir(root);
    const plugin = (await loadBuiltinPluginCatalog()).find(
      (item) => item.providerKey === "deepseek"
    );
    assert.ok(plugin);
    const inspection = inspectPluginZip(plugin.fileName, plugin.zipBytes);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        buildPluginArtifact(plugin.zipBytes, inspection)
      )
    );
    assert.equal(new Set(results.map((result) => result.buildHash)).size, 1);
    assert.equal(new Set(results.map((result) => result.entryPath)).size, 1);
  } finally {
    process.chdir(original);
    await rm(root, { force: true, recursive: true });
  }
});
