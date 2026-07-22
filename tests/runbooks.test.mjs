import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchStorageLayout,
  createResearchToolRegistry,
  createRunbookTools,
  ensureResearchStorageLayout,
  getDefaultMemoryDatabasePath,
  listResearchStorageArtifacts,
  RunbookStore,
} from "../packages/research-agent/dist/index.js";

test("runbooks persist revisioned nbformat artifacts within one workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runbook-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const context = {
    sessionId: "run_one",
    workspaceId: "workspace_zsh",
    workspaceName: "Zsh",
    subjectId: "subject_apple",
    subjectName: "Apple",
  };
  const store = new RunbookStore(databasePath, layout, context);
  try {
    const created = store.create({
      title: "Reproduce hashed-command overflow",
      purpose: "Preserve the exact source build and runtime proof sequence.",
      cells: [{ kind: "code", language: "sh", source: "zsh -f ./proof.zsh", summary: "Run the bounded proof" }],
    });
    assert.equal(created.runbook.revision, 1);
    assert.equal(created.runbook.status, "active");
    assert.equal(created.runbook.cellCount, 2);
    assert.equal(created.artifactRef.kind, "runbook");

    const appended = store.append({
      id: created.runbook.id,
      expectedRevision: 1,
      status: "completed",
      cells: [{ kind: "code", language: "text", source: "Observed SIGTRAP", stdout: "status=133\n", exitCode: 0 }],
    });
    assert.equal(appended.runbook.revision, 2);
    assert.equal(appended.runbook.status, "completed");
    assert.equal(appended.runbook.cellCount, 3);
    assert.throws(
      () => store.append({ id: created.runbook.id, expectedRevision: 1, cells: [{ kind: "markdown", source: "stale write" }] }),
      /revision conflict/,
    );

    const page = store.get(created.runbook.id);
    assert.equal(page.totalCells, 3);
    assert.equal(page.cells[1].language, "sh");
    assert.equal(page.cells[2].stdout, "status=133\n");
    assert.equal(store.list({ query: "hashed-command", statuses: ["completed"] })[0].id, created.runbook.id);

    const artifacts = listResearchStorageArtifacts(layout, { kind: "runbook" });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, created.runbook.id);
    const notebook = JSON.parse(await readFile(artifacts[0].path, "utf8"));
    assert.equal(notebook.nbformat, 4);
    assert.equal(notebook.nbformat_minor, 5);
    assert.equal(notebook.metadata.honeycrisp.artifactFamily, "runbook");
    assert.equal(notebook.metadata.honeycrisp.revision, 2);

    const otherWorkspace = new RunbookStore(databasePath, layout, { workspaceId: "workspace_mdns", workspaceName: "mDNSResponder" });
    try {
      assert.equal(otherWorkspace.get(created.runbook.id), null);
      assert.deepEqual(otherWorkspace.list(), []);
    } finally {
      otherWorkspace.close();
    }
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runbook tools expose bounded artifact operations", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runbook-tools-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const store = new RunbookStore(
    getDefaultMemoryDatabasePath(workspaceRoot),
    layout,
    { sessionId: "run_tools", workspaceId: "workspace_tools", workspaceName: "Tools" },
  );
  const registry = createResearchToolRegistry(createRunbookTools(store));
  try {
    assert.deepEqual(registry.listDescriptors().map((tool) => tool.name), ["runbook.list", "runbook.get", "runbook.create", "runbook.append"]);
    const created = await registry.execute({
      id: "create_runbook",
      actionClass: "synthesize",
      toolName: "runbook.create",
      input: { title: "Crash triage", purpose: "Repeatable crash collection and classification." },
    });
    assert.equal(created.result.status, "complete");
    assert.equal(created.result.artifactRefs[0].kind, "runbook");

    const listed = await registry.execute({ id: "list_runbooks", actionClass: "recall", toolName: "runbook.list", input: {} });
    assert.equal(listed.result.output.length, 1);
    assert.equal(listed.result.output[0].id, created.result.output.id);
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
