import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  MemoryGraphStore,
  createMemoryGraphTools,
  createResearchToolRegistry,
  getDefaultMemoryDatabasePath,
} from "../packages/research-agent/dist/index.js";

test("memory graph saves concise knowledge additively and corrects it by revision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-graph-"));
  const store = new MemoryGraphStore({ workspaceRoot });
  try {
    const first = store.save({
      type: "hypothesis",
      title: "Parser state crosses requests",
      summary: "A shared parser object may retain request state.",
      status: "suspected",
      confidence: 0.6,
      assetIds: ["asset_api"],
      tags: ["Parser State"],
      evidence: [{ kind: "code", pathBase: "repository", path: "src/parser.ts", locator: { line: 42 }, summary: "Shared state write" }],
    });
    const refined = store.save({
      type: "hypothesis",
      title: "  Parser state crosses requests  ",
      body: "Check whether cleanup runs on all error paths.",
      tags: ["cleanup"],
    });

    assert.equal(first.id, refined.id);
    assert.equal(refined.revision, 2);
    assert.deepEqual(refined.tags, ["cleanup", "parser_state"]);
    assert.equal(refined.evidence.length, 1);
    assert.equal(store.search({ query: "cleanup", assetIds: ["asset_api"] })[0]?.id, first.id);
    assert.equal(store.search({ query: "asset_api" })[0]?.id, first.id);
    assert.equal(store.search({ query: "src/parser.ts" })[0]?.id, first.id);
    assert.equal(store.search({ query: "42" })[0]?.id, first.id);
    assert.equal(store.search({ query: `${first.id} unrelated FTP sink terms` })[0]?.id, first.id);
    assert.equal(store.search({ query: "shared cleanup unrelated" })[0]?.id, first.id);

    assert.throws(() => store.correct(first.id, 1, { status: "confirmed" }), /revision conflict/);
    const corrected = store.correct(first.id, 2, { status: "rejected", summary: "Cleanup prevents state reuse." });
    assert.equal(corrected.status, "rejected");
    assert.equal(corrected.revision, 3);
    assert.throws(
      () => store.save({ type: "primitive", title: "Absolute evidence", evidence: [{ kind: "code", pathBase: "repository", path: "/tmp/parser.ts", locator: {}, summary: "bad path" }] }),
      /must be relative/,
    );
    assert.equal(store.databasePath, getDefaultMemoryDatabasePath(workspaceRoot));
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph tools expose search, save, get, correct, and link", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-tools-"));
  const store = new MemoryGraphStore({ workspaceRoot });
  const registry = createResearchToolRegistry(createMemoryGraphTools(store));
  try {
    const descriptors = registry.listDescriptors();
    assert.deepEqual(descriptors.map((tool) => tool.name), ["memory.search", "memory.get", "memory.save", "memory.correct", "memory.link"]);
    const saveSchema = descriptors.find((tool) => tool.name === "memory.save").inputSchema;
    assert.deepEqual(saveSchema.properties.type.enum, ["asset", "bug", "invariant", "mitigation", "source", "sink", "hypothesis", "primitive", "chain", "procedure", "trajectory"]);
    assert.deepEqual(saveSchema.properties.status.enum, ["draft", "suspected", "confirmed", "rejected", "stale"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.kind.enum, ["code", "artifact", "command", "url", "human_note"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.pathBase.enum, ["workspace", "repository", "asset_root", "external"]);
    assert.deepEqual(saveSchema.allOf[0].then.properties.attributes.required, ["impact", "reachability"]);
    const source = await registry.execute({ id: "save_source", actionClass: "synthesize", toolName: "memory.save", input: { type: "source", title: "Request body" } });
    const sink = await registry.execute({ id: "save_sink", actionClass: "synthesize", toolName: "memory.save", input: { type: "sink", title: "Template renderer" } });
    assert.equal(source.result.status, "complete");
    assert.equal(sink.result.status, "complete");

    const linked = await registry.execute({
      id: "link_flow",
      actionClass: "synthesize",
      toolName: "memory.link",
      input: { fromId: source.result.output.id, toId: sink.result.output.id, relation: "flows_to", note: "Unescaped path" },
    });
    assert.equal(linked.result.status, "complete");
    assert.deepEqual(linked.result.output, {
      fromId: source.result.output.id,
      toId: sink.result.output.id,
      relation: "flows_to",
      note: "Unescaped path",
      createdAt: linked.result.output.createdAt,
      updatedAt: linked.result.output.updatedAt,
    });
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph shares a database without disturbing host operational tables", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-shared-database-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".honeycrisp", "memory"), { recursive: true });
  const host = new DatabaseSync(databasePath);
  host.exec(`
    CREATE TABLE host_runs (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO host_runs VALUES ('run_one', 'Host run');
    CREATE TABLE schema_migrations (
      component TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(component, version)
    );
    INSERT INTO schema_migrations VALUES ('beale_workbench', 1, 'workspace_schema_baseline', '2026-07-20T00:00:00.000Z');
  `);
  host.close();

  const store = new MemoryGraphStore({ workspaceRoot });
  store.save({ type: "asset", title: "Shared workspace" });
  store.close();

  const reopened = new DatabaseSync(databasePath);
  try {
    const hostRun = reopened.prepare("SELECT * FROM host_runs").get();
    assert.equal(hostRun.id, "run_one");
    assert.equal(hostRun.title, "Host run");
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, 1);
    assert.deepEqual(
      { ...reopened.prepare("SELECT component, version, name FROM schema_migrations WHERE component = 'honeycrisp_core'").get() },
      { component: "honeycrisp_core", version: 1, name: "tiered_memory_graph_baseline" },
    );
    assert.equal(reopened.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 2").get().name, "replace_finding_memory_with_trajectory");
    assert.equal(reopened.prepare("SELECT name FROM schema_migrations WHERE component = 'beale_workbench'").get().name, "workspace_schema_baseline");
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_meta'").get(), undefined);
  } finally {
    reopened.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph migrates legacy finding knowledge to a trajectory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-migration-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const initial = new MemoryGraphStore({ workspaceRoot });
  initial.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.prepare("DELETE FROM schema_migrations WHERE component = 'honeycrisp_core' AND version >= 2").run();
  legacy.prepare(`INSERT INTO memory_nodes (
    id, tier, scope_key, session_id, workspace_id, workspace_name, subject_id, subject_name,
    type, title, title_norm, summary, body, status, confidence, attributes_json, created_at, updated_at, revision
  ) VALUES (?, 'workspace', 'workspace_default', NULL, 'workspace_default', 'Default Workspace', NULL, NULL,
    'finding', 'Preserved finding', 'preserved finding', 'Durable research result.', '', 'confirmed', 0.9, '{}', ?, ?, 1)`)
    .run('finding_legacy', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
  legacy.prepare("INSERT INTO memory_node_tags (node_id, tag) VALUES ('finding_legacy', 'parser')").run();
  legacy.prepare("INSERT INTO memory_evidence_refs (id, node_id, kind, path_base, path, locator_json, summary, created_at) VALUES ('evidence_legacy', 'finding_legacy', 'code', 'repository', 'src/parser.c', '{}', 'Legacy reference', '2026-07-20T00:00:00.000Z')").run();
  legacy.close();

  const migrated = new MemoryGraphStore({ workspaceRoot });
  try {
    const database = new DatabaseSync(databasePath);
    try {
      const migratedNode = database.prepare("SELECT id, title, type FROM memory_nodes WHERE title = 'Preserved finding'").get();
      assert.equal(migratedNode.id.startsWith('trajectory_'), true);
      assert.equal(migratedNode.title, "Preserved finding");
      assert.equal(migratedNode.type, "trajectory");
      assert.equal(database.prepare("SELECT id FROM memory_nodes WHERE id = 'finding_legacy'").get(), undefined);
      assert.equal(database.prepare("SELECT node_id FROM memory_node_tags WHERE tag = 'parser'").get().node_id, migratedNode.id);
      assert.equal(database.prepare("SELECT node_id FROM memory_evidence_refs WHERE id = 'evidence_legacy'").get().node_id, migratedNode.id);
      assert.deepEqual(
        { ...database.prepare("SELECT version, name FROM schema_migrations WHERE component = 'honeycrisp_core'").get() },
        { version: 1, name: "tiered_memory_graph_baseline" },
      );
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 2").get().name, "replace_finding_memory_with_trajectory");
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 3").get().name, "rename_legacy_finding_memory_ids");
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_meta'").get(), undefined);
    } finally {
      database.close();
    }
  } finally {
    migrated.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph tiers session, workspace, and subject knowledge across peer workspaces", async () => {
  const zshRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tier-zsh-"));
  const mdnsRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tier-mdns-"));
  const apple = { subjectId: "subject_apple", subjectName: "Apple" };
  const zshContext = { sessionId: "run_zsh", workspaceId: "workspace_zsh", workspaceName: "Zsh", ...apple };
  const zsh = new MemoryGraphStore({ workspaceRoot: zshRoot, context: zshContext });
  let subjectNode;
  let workspaceNode;
  let sessionNode;
  try {
    subjectNode = zsh.save({ tier: "subject", type: "invariant", title: "Shared IPC boundary", summary: "Apple components exchange bounded messages." });
    workspaceNode = zsh.save({ tier: "workspace", type: "invariant", title: "Shared IPC boundary", summary: "Zsh-specific boundary." });
    sessionNode = zsh.save({ tier: "session", type: "invariant", title: "Shared IPC boundary", summary: "Current run lead." });
    zsh.link(subjectNode.id, workspaceNode.id, "observed_in", "Origin workspace relationship");
    assert.equal(zsh.search({ query: "boundary" }).length, 3);
    assert.deepEqual(zsh.search({ tiers: ["session"] }).map((node) => node.id), [sessionNode.id]);
  } finally {
    zsh.close();
  }

  const mdns = new MemoryGraphStore({
    workspaceRoot: mdnsRoot,
    context: { sessionId: "run_mdns", workspaceId: "workspace_mdns", workspaceName: "mDNSResponder", ...apple },
    peers: [{ databasePath: getDefaultMemoryDatabasePath(zshRoot), workspaceId: "workspace_zsh", workspaceName: "Zsh", ...apple }],
  });
  try {
    assert.deepEqual(mdns.search({ query: "boundary" }).map((node) => node.id), [subjectNode.id]);
    assert.equal(mdns.get(workspaceNode.id), null);
    assert.equal(mdns.get(sessionNode.id), null);
    assert.equal(mdns.get(subjectNode.id)?.subjectName, "Apple");
    assert.deepEqual(mdns.listEdges(subjectNode.id), []);

    const refined = mdns.save({ tier: "subject", type: "invariant", title: "Shared IPC boundary", body: "Check interactions between separately scoped components." });
    assert.equal(refined.id, subjectNode.id);
    assert.equal(refined.revision, 2);
    const localSameTitle = mdns.save({ tier: "workspace", type: "invariant", title: "Shared IPC boundary", summary: "mDNSResponder-specific boundary." });
    assert.notEqual(localSameTitle.id, subjectNode.id);
    assert.deepEqual(mdns.search({ query: "boundary", tiers: ["workspace"] }).map((node) => node.id), [localSameTitle.id]);
    const crossTierEdge = mdns.link(subjectNode.id, localSameTitle.id, "applies_to", "Shared owner invariant applies at this boundary");
    assert.deepEqual(mdns.listEdges(subjectNode.id), [crossTierEdge]);
  } finally {
    mdns.close();
    await rm(zshRoot, { recursive: true, force: true });
    await rm(mdnsRoot, { recursive: true, force: true });
  }
});

test("memory graph derives shared Beale workspace identity for headless access", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-headless-identity-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const host = new DatabaseSync(databasePath);
  host.exec(`
    CREATE TABLE workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO workspace_meta VALUES ('workspace_id', 'workspace_shared', '2026-01-01T00:00:00Z');
    CREATE TABLE scope_versions (id TEXT PRIMARY KEY, status TEXT NOT NULL, workspace_name TEXT NOT NULL, scope_owner TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO scope_versions VALUES ('scope_one', 'active', 'Zsh', 'Apple', '2026-01-01T00:00:00Z');
  `);
  host.close();

  const store = new MemoryGraphStore({ workspaceRoot });
  try {
    const workspaceNode = store.save({ type: "asset", title: "Zsh parser" });
    const subjectNode = store.save({ tier: "subject", type: "invariant", title: "Apple parser boundary" });
    assert.equal(workspaceNode.workspaceId, "workspace_shared");
    assert.equal(workspaceNode.workspaceName, "Zsh");
    assert.equal(subjectNode.subjectName, "Apple");
  } finally {
    store.close();
  }

  const reopened = new MemoryGraphStore({ workspaceRoot });
  try {
    assert.equal(reopened.search({ tiers: ["workspace"] })[0]?.title, "Zsh parser");
    assert.equal(reopened.search({ tiers: ["subject"] })[0]?.title, "Apple parser boundary");
  } finally {
    reopened.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
