import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchStorageLayout,
  ensureResearchStorageLayout,
  getResearchStorageManifestPath,
  listResearchStorageArtifacts,
  loadResearchStorageManifest,
  registerResearchStorageArtifact,
  resolveResearchStorageArtifact,
} from "../packages/research-agent/dist/index.js";

test("storage manifest registers, lists, resolves, and reloads artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-storage-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "honeycrisp-storage-outside-"));
  const layout = ensureResearchStorageLayout(
    createResearchStorageLayout({ workspaceRoot }),
  );
  assert.deepEqual(layout.directories.map((directory) => directory.name), ["artifacts"]);
  const artifactPath = join(layout.artifactDirectoryPath, "reports", "summary.txt");
  const outsidePath = join(outsideRoot, "outside.txt");
  await mkdir(join(layout.artifactDirectoryPath, "reports"), { recursive: true });
  await writeFile(artifactPath, "stored report\n", "utf8");
  await writeFile(outsidePath, "outside\n", "utf8");

  try {
    const entry = registerResearchStorageArtifact(layout, {
      path: artifactPath,
      kind: "report",
      purpose: "Phase 2 manifest test report.",
      sourceEventIds: ["evt_alpha"],
    });
    const manifest = loadResearchStorageManifest(layout);
    const listed = listResearchStorageArtifacts(layout, {
      kind: "report",
      sourceEventId: "evt_alpha",
    });
    const resolved = resolveResearchStorageArtifact(layout, entry.id);

    assert.equal(manifest.manifestPath, getResearchStorageManifestPath(layout));
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(listed.length, 1);
    assert.equal(resolved?.id, entry.id);
    assert.equal(entry.relativePath, "artifacts/reports/summary.txt");
    assert.match(entry.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.throws(
      () =>
        registerResearchStorageArtifact(layout, {
          path: outsidePath,
          kind: "outside",
        }),
      /under storage root/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
