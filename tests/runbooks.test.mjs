import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createResearchStorageLayout,
  createResearchToolRegistry,
  createRunbookExecutor,
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
    }, { provider: "openai", model: "gpt-5.6" });
    assert.equal(created.runbook.revision, 1);
    assert.equal(created.runbook.contentRevision, 1);
    assert.deepEqual(created.runbook.execution, {
      runCount: 0,
      completedRunCount: 0,
      executedCellCount: 0,
      latest: null,
    });
    assert.equal(created.runbook.status, "active");
    assert.equal(created.runbook.cellCount, 2);
    assert.equal(created.artifactRef.kind, "runbook");

    const appended = store.append({
      id: created.runbook.id,
      expectedRevision: 1,
      status: "completed",
      cells: [{ kind: "code", language: "text", source: "Observed SIGTRAP", stdout: "status=133\n", exitCode: 0 }],
    }, { provider: "anthropic", model: "claude-opus-4-6" });
    assert.equal(appended.runbook.revision, 2);
    assert.equal(appended.runbook.contentRevision, 2);
    assert.equal(appended.runbook.status, "completed");
    assert.equal(appended.runbook.cellCount, 3);
    assert.deepEqual(appended.runbook.authors, [
      { provider: "openai", model: "gpt-5.6" },
      { provider: "anthropic", model: "claude-opus-4-6" },
    ]);
    assert.throws(
      () => store.append({ id: created.runbook.id, expectedRevision: 1, cells: [{ kind: "markdown", source: "stale write" }] }),
      /revision conflict/,
    );

    const page = store.get(created.runbook.id);
    assert.equal(page.totalCells, 3);
    assert.match(page.cells[1].id, /^cell-/);
    assert.equal(page.cells[1].index, 1);
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
    assert.equal(notebook.metadata.honeycrisp.contentRevision, 2);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        database.prepare(`SELECT artifact_kind, artifact_id, session_id, revision
          FROM honeycrisp_artifact_revisions
          WHERE artifact_id = ? ORDER BY revision`).all(created.runbook.id).map((row) => ({ ...row })),
        [
          { artifact_kind: "runbook", artifact_id: created.runbook.id, session_id: "run_one", revision: 1 },
          { artifact_kind: "runbook", artifact_id: created.runbook.id, session_id: "run_one", revision: 2 },
        ],
      );
    } finally {
      database.close();
    }

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

test("migration 13 separates historical authored content from execution revisions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runbook-migration-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const context = { sessionId: "session_migration", workspaceId: "workspace_migration", workspaceName: "Migration" };
  let store = new RunbookStore(databasePath, layout, context);
  try {
    const created = store.create({ title: "Historical runbook", purpose: "Classify old execution churn." }, { provider: "openai", model: "gpt-5.6" });
    const appended = store.append({
      id: created.runbook.id,
      expectedRevision: 1,
      cells: [{ kind: "markdown", source: "Content update" }],
    }, { provider: "openai", model: "gpt-5.6" });
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE honeycrisp_runbooks SET revision = 3, content_revision = 1 WHERE id = ?").run(appended.runbook.id);
      database.prepare(`INSERT INTO honeycrisp_artifact_revisions (
        artifact_kind, artifact_id, workspace_id, session_id, revision, created_at, revision_kind
      ) VALUES ('runbook', ?, ?, ?, 3, ?, 'content')`).run(
        appended.runbook.id,
        context.workspaceId,
        context.sessionId,
        "2026-08-20T00:00:00.000Z",
      );
      database.prepare("DELETE FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 13").run();
    } finally {
      database.close();
    }

    store = new RunbookStore(databasePath, layout, context);
    const migrated = store.get(appended.runbook.id);
    assert.equal(migrated.contentRevision, 2);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        migratedDatabase.prepare(`SELECT revision, revision_kind FROM honeycrisp_artifact_revisions
          WHERE artifact_kind = 'runbook' AND artifact_id = ? ORDER BY revision`).all(appended.runbook.id).map((row) => ({ ...row })),
        [
          { revision: 1, revision_kind: "content" },
          { revision: 2, revision_kind: "content" },
          { revision: 3, revision_kind: "execution" },
        ],
      );
    } finally {
      migratedDatabase.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed before migration replay */ }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runbook execution records cell status, output, and duration through the shell boundary", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runbook-execution-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const store = new RunbookStore(
    getDefaultMemoryDatabasePath(workspaceRoot),
    layout,
    { sessionId: "session_exec", workspaceId: "workspace_exec", workspaceName: "Execution" },
  );
  const contexts = [];
  const updates = [];
  const shellTool = {
    descriptor: {
      name: "shell.run",
      description: "fixture",
      actionClasses: ["experiment"],
      sideEffects: "process",
      requiredPermissions: ["process:spawn"],
    },
    async execute(action, context) {
      contexts.push(context.runbookContext);
      return {
        action,
        status: "complete",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        summary: "complete",
        output: { stdout: "proof passed\n", stderr: "", exitCode: 0 },
        followUpActions: [],
      };
    },
  };
  try {
    const created = store.create({
      title: "Proof sequence",
      purpose: "Run one bounded and repeatable proof command.",
      cells: [{ kind: "code", language: "sh", source: "printf 'proof passed\\n'" }],
    });
    const execute = createRunbookExecutor({
      store,
      shellTool,
      onUpdate: (update) => updates.push(update),
    });
    await assert.rejects(
      execute({ runbookId: created.runbook.id, proofTarget: "device" }),
      /deviceOs/,
    );
    await execute({ runbookId: created.runbook.id, proofTarget: "device", deviceOs: "iOS 27.0" });

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].runbookId, created.runbook.id);
    assert.match(contexts[0].runId, /^runbook_run_/);
    assert.match(contexts[0].cellId, /^cell-/);
    assert.equal(updates.at(-1).status, "succeeded");

    const artifact = listResearchStorageArtifacts(layout, { kind: "runbook" })[0];
    const notebook = JSON.parse(await readFile(artifact.path, "utf8"));
    const codeCell = notebook.cells[1];
    assert.equal(codeCell.execution_count, 1);
    assert.equal(codeCell.outputs[0].text.join(""), "proof passed\n");
    assert.equal(codeCell.metadata.honeycrisp.latestRun.status, "succeeded");
    assert.equal(codeCell.metadata.honeycrisp.latestRun.proofTarget, "device");
    assert.equal(codeCell.metadata.honeycrisp.latestRun.deviceOs, "iOS 27.0");
    assert.equal(typeof codeCell.metadata.honeycrisp.latestRun.durationMs, "number");
    assert.equal(notebook.metadata.honeycrisp.latestRun.status, "succeeded");
    assert.equal(notebook.metadata.honeycrisp.latestRun.proofTarget, "device");
    assert.equal(notebook.metadata.honeycrisp.latestRun.deviceOs, "iOS 27.0");
    assert.equal(typeof notebook.metadata.honeycrisp.latestRun.durationMs, "number");
    const executed = store.get(created.runbook.id);
    assert.equal(executed.contentRevision, 1);
    assert.ok(executed.revision > executed.contentRevision);
    assert.equal(executed.execution.runCount, 1);
    assert.equal(executed.execution.completedRunCount, 1);
    assert.equal(executed.execution.executedCellCount, 1);
    assert.equal(executed.execution.latest.status, "succeeded");

    const database = new DatabaseSync(getDefaultMemoryDatabasePath(workspaceRoot), { readOnly: true });
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM honeycrisp_artifact_revisions
        WHERE artifact_kind = 'runbook' AND artifact_id = ?`).get(created.runbook.id).count, 1);
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runbook execution plans support inclusive cell ranges and resume-from-here selection", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runbook-range-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const store = new RunbookStore(
    getDefaultMemoryDatabasePath(workspaceRoot),
    layout,
    { sessionId: "session_range", workspaceId: "workspace_range", workspaceName: "Range" },
  );
  try {
    const created = store.create({
      title: "Resume sequence",
      purpose: "Prove that a repaired late step can resume without repeating the prefix.",
      cells: [
        { kind: "code", language: "sh", source: "printf 'one\\n'" },
        { kind: "markdown", source: "Inspect the first result." },
        { kind: "code", language: "sh", source: "printf 'two\\n'" },
        { kind: "code", language: "sh", source: "printf 'three\\n'" },
      ],
    });
    const codeCells = store.get(created.runbook.id).cells.filter((cell) => cell.kind === "code");
    assert.equal(codeCells.length, 3);
    assert.deepEqual(
      store.executionPlan(created.runbook.id, { startCellId: codeCells[1].id }).map((cell) => cell.id),
      [codeCells[1].id, codeCells[2].id],
    );
    assert.deepEqual(
      store.executionPlan(created.runbook.id, { endCellId: codeCells[1].id }).map((cell) => cell.id),
      [codeCells[0].id, codeCells[1].id],
    );
    assert.deepEqual(
      store.executionPlan(created.runbook.id, { startCellId: codeCells[1].id, endCellId: codeCells[2].id }).map((cell) => cell.id),
      [codeCells[1].id, codeCells[2].id],
    );
    assert.throws(
      () => store.executionPlan(created.runbook.id, { startCellId: codeCells[2].id, endCellId: codeCells[0].id }),
      /must precede/,
    );
    assert.throws(
      () => store.executionPlan(created.runbook.id, { cellId: codeCells[0].id, startCellId: codeCells[1].id }),
      /cannot be combined/,
    );
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
