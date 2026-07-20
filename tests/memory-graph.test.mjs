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

    assert.throws(() => store.correct(first.id, 1, { status: "confirmed" }), /revision conflict/);
    const corrected = store.correct(first.id, 2, { status: "rejected", summary: "Cleanup prevents state reuse." });
    assert.equal(corrected.status, "rejected");
    assert.equal(corrected.revision, 3);
    assert.throws(
      () => store.save({ type: "finding", title: "Absolute evidence", evidence: [{ kind: "code", pathBase: "repository", path: "/tmp/parser.ts", locator: {}, summary: "bad path" }] }),
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
    assert.deepEqual(registry.listDescriptors().map((tool) => tool.name), ["memory.search", "memory.get", "memory.save", "memory.correct", "memory.link"]);
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
  host.exec("CREATE TABLE host_runs (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO host_runs VALUES ('run_one', 'Host run');");
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
  } finally {
    reopened.close();
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

test("memory graph upgrades existing nodes into the workspace tier", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-tier-upgrade-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE memory_nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, title_norm TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      confidence REAL NOT NULL DEFAULT 0.5, attributes_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(type, title_norm)
    );
    CREATE TABLE memory_node_assets (node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, asset_id TEXT NOT NULL, PRIMARY KEY(node_id, asset_id));
    CREATE TABLE memory_node_tags (node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(node_id, tag));
    CREATE TABLE memory_edges (from_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, relation TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(from_id, to_id, relation));
    CREATE TABLE memory_evidence_refs (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, kind TEXT NOT NULL, path_base TEXT, path TEXT, locator_json TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    INSERT INTO memory_nodes VALUES ('legacy_node', 'asset', 'Legacy target', 'legacy target', 'Existing memory.', '', 'confirmed', 0.9, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
    INSERT INTO memory_node_tags VALUES ('legacy_node', 'legacy');
  `);
  legacy.close();

  const store = new MemoryGraphStore({
    workspaceRoot,
    context: { workspaceId: "workspace_upgrade", workspaceName: "Upgrade Fixture", subjectId: "subject_apple", subjectName: "Apple" },
  });
  try {
    const node = store.get("legacy_node");
    assert.equal(node.tier, "workspace");
    assert.equal(node.workspaceId, "workspace_upgrade");
    assert.deepEqual(node.tags, ["legacy"]);
    const subjectNode = store.save({ tier: "subject", type: "asset", title: "Legacy target" });
    assert.notEqual(subjectNode.id, node.id);
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
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
