import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  MemoryGraphStore,
  createCuratedMemoryTools,
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
    assert.throws(
      () => store.save({ type: "bug", title: "Current parser flaw", status: "confirmed" }),
      /historicalPrecedent/,
    );
    assert.throws(
      () => store.save({ type: "hypothesis", title: "Proven parser flaw", status: "confirmed" }),
      /must be reclassified as a primitive or chain/,
    );

    const candidate = store.save({
      type: "primitive",
      title: "Historical parser overflow",
      status: "confirmed",
      assetIds: ["asset_parser"],
      attributes: { historicalPrecedent: true },
      evidence: [{ kind: "url", pathBase: "external", path: "https://example.test/advisory", locator: {}, summary: "Fixed advisory" }],
    });
    store.link(candidate.id, first.id, "precedes");
    const historicalBug = store.correct(candidate.id, 1, { type: "bug" });
    assert.match(historicalBug.id, /^bug_/);
    assert.equal(historicalBug.type, "bug");
    assert.equal(store.get(candidate.id), null);
    assert.ok(store.listEdges().some((edge) => edge.fromId === historicalBug.id && edge.toId === first.id));
    assert.equal(historicalBug.evidence.length, 1);

    const rediscoveredPrimitive = store.correct(historicalBug.id, 2, { type: "primitive", attributes: {} });
    assert.match(rediscoveredPrimitive.id, /^primitive_/);
    assert.equal(rediscoveredPrimitive.type, "primitive");
    assert.equal(store.get(historicalBug.id), null);
    assert.ok(store.listEdges().some((edge) => edge.fromId === rediscoveredPrimitive.id && edge.toId === first.id));
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
    const searchDescriptor = descriptors.find((tool) => tool.name === "memory.search");
    const saveDescriptor = descriptors.find((tool) => tool.name === "memory.save");
    assert.match(searchDescriptor.description, /current workspace by default/);
    assert.match(searchDescriptor.inputSchema.properties.scope.description, /Defaults to workspace/);
    assert.match(saveDescriptor.description, /refined in place/);
    assert.equal("tier" in saveDescriptor.inputSchema.properties, false);
    const saveSchema = saveDescriptor.inputSchema;
    assert.deepEqual(saveSchema.properties.type.enum, ["asset", "bug", "invariant", "mitigation", "source", "sink", "hypothesis", "primitive", "chain", "procedure", "trajectory"]);
    assert.equal(saveSchema.properties.type.enum.includes("evidence"), false);
    assert.equal(saveSchema.properties.type.enum.includes("finding"), false);
    assert.deepEqual(saveSchema.properties.status.enum, ["draft", "suspected", "confirmed", "rejected", "stale"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.kind.enum, ["code", "artifact", "command", "url", "human_note"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.pathBase.enum, ["workspace", "repository", "asset_root", "external"]);
    assert.deepEqual(saveSchema.allOf[0].then.properties.attributes.required, ["impact", "reachability"]);
    assert.deepEqual(saveSchema.allOf[1].then.required, ["status", "assetIds", "attributes", "evidence"]);
    assert.deepEqual(saveSchema.allOf[1].then.properties.attributes.required, ["historicalPrecedent"]);
    assert.deepEqual(saveSchema.allOf[2].then.properties.status.enum, ["draft", "suspected", "rejected", "stale"]);
    const correctSchema = descriptors.find((tool) => tool.name === "memory.correct").inputSchema;
    assert.deepEqual(correctSchema.properties.type.enum, saveSchema.properties.type.enum);
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

test("curated memory tools keep the graph read-only and queue constrained requests", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-curated-memory-tools-"));
  const store = new MemoryGraphStore({ workspaceRoot });
  const existing = store.save({
    type: "primitive",
    title: "Bounded parser read",
    summary: "The parser reads within the mapped input.",
    status: "confirmed",
  });
  const registry = createResearchToolRegistry(createCuratedMemoryTools(store));
  try {
    const descriptors = registry.listDescriptors();
    assert.deepEqual(descriptors.map((tool) => tool.name), ["memory.search", "memory.get", "memory.request"]);
    assert.deepEqual(descriptors.map((tool) => tool.transportName), ["memory_search", "memory_get", "memory_request"]);
    assert.equal(descriptors.some((tool) => ["memory.save", "memory.correct", "memory.link"].includes(tool.name)), false);

    const requestDescriptor = descriptors.find((tool) => tool.name === "memory.request");
    assert.equal(requestDescriptor.sideEffects, "none");
    assert.deepEqual(requestDescriptor.requiredPermissions, []);
    assert.deepEqual(requestDescriptor.inputSchema.properties.intent.enum, ["create", "revise", "relate", "reconsider"]);
    assert.equal(requestDescriptor.inputSchema.additionalProperties, false);
    assert.equal(
      requestDescriptor.inputSchema.properties.candidate.properties.attributes.properties.rootCauseKey.pattern,
      "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    );
    assert.match(requestDescriptor.description, /never mutates the memory graph directly/);

    const searched = await registry.execute({
      id: "search_curated_memory",
      actionClass: "recall",
      toolName: "memory.search",
      input: { query: "bounded parser" },
    });
    assert.equal(searched.result.output[0].id, existing.id);
    const read = await registry.execute({
      id: "get_curated_memory",
      actionClass: "recall",
      toolName: "memory.get",
      input: { id: existing.id },
    });
    assert.equal(read.result.output.id, existing.id);

    const requested = await registry.execute({
      id: "request_curated_memory",
      actionClass: "synthesize",
      toolName: "memory.request",
      input: {
        intent: "create",
        reason: "A distinct attacker-controlled length was established by the parser experiment.",
        candidate: {
          type: "source",
          title: "Attacker-controlled parser length",
          claim: "The parser accepts a length from the untrusted input header.",
        },
        evidenceRefs: [{ toolCallId: "parser_probe_1", artifactId: "artifact_parser_probe" }],
      },
    });
    assert.equal(requested.result.status, "complete");
    assert.equal(requested.result.summary, "Memory request queued for curator review.");
    assert.equal(requested.result.output.status, "queued");
    assert.equal(requested.result.output.intent, "create");
    assert.match(requested.result.output.requestId, /^memory_request_/);
    assert.deepEqual(store.search({ scope: "workspace" }).map((node) => [node.id, node.revision]), [[existing.id, 1]]);

    const structuredRequest = await registry.execute({
      id: "request_structured_primitive",
      actionClass: "synthesize",
      toolName: "memory.request",
      input: {
        intent: "create",
        reason: "The proof establishes one durable root-cause flaw.",
        candidate: {
          type: "primitive",
          title: "Parser length wraps before allocation",
          claim: "An attacker-controlled length wraps before the allocation bound is checked.",
          attributes: {
            rootCause: "Allocation uses a wrapped attacker-controlled length before validation.",
            rootCauseKey: "parser-length-wrap-before-validation",
            impact: "Out-of-bounds memory access.",
            reachability: "A crafted parser input reaches the unchecked allocation.",
          },
        },
      },
    });
    assert.equal(structuredRequest.result.status, "complete");

    const malformedKey = await registry.execute({
      id: "request_malformed_root_cause_key",
      actionClass: "synthesize",
      toolName: "memory.request",
      input: {
        intent: "create",
        reason: "The proposed identity uses the wrong separator.",
        candidate: {
          type: "primitive",
          title: "Malformed primitive request",
          claim: "A proven flaw with an invalid structured identity.",
          attributes: {
            rootCause: "A proven parser flaw.",
            rootCauseKey: "parser_length_wrap",
          },
        },
      },
    });
    assert.equal(malformedKey.result.status, "error");
    assert.match(malformedKey.result.error.message, /rootCauseKey/);

    const invalid = await registry.execute({
      id: "invalid_curated_memory_request",
      actionClass: "synthesize",
      toolName: "memory.request",
      input: {
        intent: "create",
        reason: "Missing candidate details must not be accepted.",
      },
    });
    assert.equal(invalid.result.status, "error");
    assert.match(invalid.result.error.message, /candidate is required/);
    assert.equal(store.get(existing.id).revision, 1);
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
    assert.equal(reopened.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 6").get().name, "memory_context_memberships");
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
  legacy.exec(`
    DROP TABLE memory_node_sessions;
    DROP TABLE memory_node_workspaces;
    DROP INDEX memory_nodes_subject_identity_idx;
    ALTER TABLE memory_nodes ADD COLUMN tier TEXT NOT NULL DEFAULT 'workspace';
    ALTER TABLE memory_nodes ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'workspace_default';
    ALTER TABLE memory_nodes ADD COLUMN session_id TEXT;
    ALTER TABLE memory_nodes ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_default';
    ALTER TABLE memory_nodes ADD COLUMN workspace_name TEXT NOT NULL DEFAULT 'Default Workspace';
  `);
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
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 4").get().name, "remove_peer_database_federation");
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 5").get().name, "workspace_runbook_artifacts");
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 6").get().name, "memory_context_memberships");
      assert.equal(database.prepare("SELECT session_id FROM memory_node_sessions WHERE node_id = ?").get(migratedNode.id), undefined);
      assert.deepEqual({ ...database.prepare("SELECT workspace_id, workspace_name FROM memory_node_workspaces WHERE node_id = ?").get(migratedNode.id) }, {
        workspace_id: "workspace_default",
        workspace_name: "Default Workspace",
      });
      assert.deepEqual({ ...database.prepare("SELECT subject_id, subject_name FROM memory_nodes WHERE id = ?").get(migratedNode.id) }, {
        subject_id: "subject_workspace:workspace_default",
        subject_name: "Default Workspace",
      });
      assert.equal(database.prepare("SELECT name FROM pragma_table_info('memory_nodes') WHERE name = 'tier'").get(), undefined);
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_runbooks'").get().name, "honeycrisp_runbooks");
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_federated_edges'").get(), undefined);
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_meta'").get(), undefined);
    } finally {
      database.close();
    }
  } finally {
    migrated.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph accumulates session and workspace memberships under one subject", async () => {
  const zshRoot = await mkdtemp(join(tmpdir(), "honeycrisp-context-zsh-"));
  const mdnsRoot = await mkdtemp(join(tmpdir(), "honeycrisp-context-mdns-"));
  const apple = { subjectId: "subject_apple", subjectName: "Apple" };
  const zshContext = { sessionId: "run_zsh", workspaceId: "workspace_zsh", workspaceName: "Zsh", ...apple };
  const zsh = new MemoryGraphStore({ workspaceRoot: zshRoot, context: zshContext });
  let sharedNode;
  let zshNode;
  try {
    sharedNode = zsh.save({ type: "invariant", title: "Apple IPC convention", summary: "Apple components exchange bounded messages." });
    zshNode = zsh.save({ type: "invariant", title: "Zsh IPC boundary", summary: "Zsh-specific boundary." });
    zsh.link(sharedNode.id, zshNode.id, "observed_in", "Origin workspace relationship");
    assert.deepEqual(sharedNode.sessionIds, ["run_zsh"]);
    assert.deepEqual(sharedNode.workspaces, [{ id: "workspace_zsh", name: "Zsh" }]);
    assert.deepEqual(zsh.search({ scope: "session" }).map((node) => node.id).sort(), [sharedNode.id, zshNode.id].sort());
    assert.deepEqual(zsh.search({ scope: "workspace" }).map((node) => node.id).sort(), [sharedNode.id, zshNode.id].sort());
    assert.deepEqual(zsh.search({ scope: "subject" }).map((node) => node.id).sort(), [sharedNode.id, zshNode.id].sort());
  } finally {
    zsh.close();
  }

  const mdns = new MemoryGraphStore({
    workspaceRoot: mdnsRoot,
    databasePath: getDefaultMemoryDatabasePath(zshRoot),
    context: { sessionId: "run_mdns", workspaceId: "workspace_mdns", workspaceName: "mDNSResponder", ...apple },
  });
  try {
    assert.deepEqual(mdns.search(), []);
    assert.deepEqual(mdns.search({ scope: "subject" }).map((node) => node.id).sort(), [sharedNode.id, zshNode.id].sort());
    assert.equal(mdns.get(sharedNode.id)?.subjectName, "Apple");
    assert.ok(mdns.listEdges(sharedNode.id).some((edge) => edge.relation === "observed_in"));

    const refined = mdns.save({ type: "invariant", title: "Apple IPC convention", body: "Check interactions between separately scoped components." });
    assert.equal(refined.id, sharedNode.id);
    assert.equal(refined.revision, 2);
    assert.deepEqual(refined.sessionIds, ["run_mdns", "run_zsh"]);
    assert.deepEqual(refined.workspaces, [
      { id: "workspace_zsh", name: "Zsh" },
      { id: "workspace_mdns", name: "mDNSResponder" },
    ]);
    assert.deepEqual(mdns.search({ scope: "session" }).map((node) => node.id), [sharedNode.id]);
    assert.deepEqual(mdns.search({ scope: "workspace" }).map((node) => node.id), [sharedNode.id]);
    const localNode = mdns.save({ type: "invariant", title: "mDNSResponder IPC boundary", summary: "mDNSResponder-specific boundary." });
    assert.deepEqual(mdns.search({ query: "boundary" }).map((node) => node.id), [localNode.id]);
    const crossWorkspaceEdge = mdns.link(sharedNode.id, localNode.id, "applies_to", "Shared owner invariant applies at this boundary");
    assert.ok(mdns.listEdges(sharedNode.id).some((edge) => edge.relation === crossWorkspaceEdge.relation));
  } finally {
    mdns.close();
    await rm(zshRoot, { recursive: true, force: true });
    await rm(mdnsRoot, { recursive: true, force: true });
  }
});

test("memory correction appends context memberships when reclassifying a node", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-context-correction-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const subject = { subjectId: "subject_apple", subjectName: "Apple" };
  const first = new MemoryGraphStore({
    workspaceRoot,
    databasePath,
    context: { sessionId: "run_zsh", workspaceId: "workspace_zsh", workspaceName: "Zsh", ...subject },
  });
  let node;
  try {
    node = first.save({
      type: "invariant",
      title: "Apple IPC convention",
      summary: "Apple components exchange bounded messages.",
      tags: ["ipc"],
    });
  } finally {
    first.close();
  }

  const followup = new MemoryGraphStore({
    workspaceRoot,
    databasePath,
    context: { sessionId: "run_mdns", workspaceId: "workspace_mdns", workspaceName: "mDNSResponder", ...subject },
  });
  try {
    const corrected = followup.correct(node.id, 1, {
      type: "procedure",
      body: "Compare the bounded-message convention across components.",
      tags: ["ipc", "cross_workspace"],
    });
    assert.notEqual(corrected.id, node.id);
    assert.equal(corrected.type, "procedure");
    assert.deepEqual(corrected.sessionIds, ["run_mdns", "run_zsh"]);
    assert.deepEqual(corrected.workspaces, [
      { id: "workspace_zsh", name: "Zsh" },
      { id: "workspace_mdns", name: "mDNSResponder" },
    ]);
    assert.deepEqual(corrected.tags, ["cross_workspace", "ipc"]);
    assert.equal(followup.get(node.id), null);
  } finally {
    followup.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph derives shared Beale workspace identity for headless access", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-headless-identity-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  await mkdir(dirname(databasePath), { recursive: true });
  const host = new DatabaseSync(databasePath);
  host.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('workspace_shared', '${workspaceRoot.replaceAll("'", "''")}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    CREATE TABLE scope_versions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL, workspace_name TEXT NOT NULL, scope_owner TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO scope_versions VALUES ('scope_one', 'workspace_shared', 'active', 'Zsh', 'Apple', '2026-01-01T00:00:00Z');
  `);
  host.close();

  const store = new MemoryGraphStore({ workspaceRoot });
  try {
    const workspaceNode = store.save({ type: "asset", title: "Zsh parser" });
    const subjectNode = store.save({ type: "invariant", title: "Apple parser boundary" });
    assert.deepEqual(workspaceNode.workspaces, [{ id: "workspace_shared", name: "Zsh" }]);
    assert.equal(subjectNode.subjectName, "Apple");
  } finally {
    store.close();
  }

  const reopened = new MemoryGraphStore({ workspaceRoot });
  try {
    assert.equal(reopened.search({ scope: "workspace" }).some((node) => node.title === "Zsh parser"), true);
    assert.equal(reopened.search({ scope: "subject" }).some((node) => node.title === "Apple parser boundary"), true);
  } finally {
    reopened.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
