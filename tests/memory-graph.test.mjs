import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  MemoryGraphStore,
  createMemoryGraphTools,
  createResearchToolRegistry,
  getDefaultMemoryDatabasePath,
  memoryCatalogHash,
  normalizeResearchProfile,
  researchProfileHash,
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
    const expectedLegacyId = `hypothesis_${createHash("sha256")
      .update(`${store.getContext().subjectId}:hypothesis:parser state crosses requests`)
      .digest("hex")
      .slice(0, 20)}`;
    assert.equal(first.id, expectedLegacyId);
    assert.equal(first.provenance.state, "active_validated");
    assert.equal(
      first.provenance.validation.researchProfile.hash,
      researchProfileHash(normalizeResearchProfile(DEFAULT_SECURITY_RESEARCH_PROFILE)),
    );
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
      /retired/,
    );
    assert.throws(
      () => store.save({ type: "flow-endpoint", title: "Template renderer", status: "confirmed" }),
      /requires non-empty attributes: role/,
    );
    assert.throws(
      () => store.save({ type: "hypothesis", title: "Proven parser flaw", status: "confirmed" }),
      /must be reclassified as a primitive or chain/,
    );
    assert.throws(
      () => store.save({ type: "primitive", title: "Unsubstantiated primitive", status: "confirmed" }),
      /requires evidence/,
    );
    assert.throws(
      () => store.save({
        type: "chain",
        title: "Unsubstantiated chain",
        status: "confirmed",
        attributes: { impact: "Code execution", reachability: "Authenticated request path" },
      }),
      /requires evidence/,
    );

    const candidate = store.save({
      type: "primitive",
      title: "Parser flow boundary",
      status: "confirmed",
      assetIds: ["asset_parser"],
      evidence: [{ kind: "url", pathBase: "external", path: "https://example.test/advisory", locator: {}, summary: "Fixed advisory" }],
    });
    store.link(candidate.id, first.id, "precedes");
    const flowEndpoint = store.correct(candidate.id, 1, {
      type: "flow-endpoint",
      attributes: { role: "sink" },
    });
    assert.match(flowEndpoint.id, /^flow-endpoint_/);
    assert.equal(flowEndpoint.type, "flow-endpoint");
    assert.equal(store.get(candidate.id), null);
    assert.ok(store.listEdges().some((edge) => edge.fromId === flowEndpoint.id && edge.toId === first.id));
    assert.equal(flowEndpoint.evidence.length, 1);

    const rediscoveredPrimitive = store.correct(flowEndpoint.id, 2, { type: "primitive", attributes: {} });
    assert.match(rediscoveredPrimitive.id, /^primitive_/);
    assert.equal(rediscoveredPrimitive.type, "primitive");
    assert.equal(store.get(flowEndpoint.id), null);
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
    assert.deepEqual(saveSchema.properties.type.enum, ["asset", "invariant", "mitigation", "flow-endpoint", "hypothesis", "primitive", "chain", "trajectory"]);
    assert.deepEqual(searchDescriptor.inputSchema.properties.types.items.enum, saveSchema.properties.type.enum);
    assert.equal(searchDescriptor.inputSchema.properties.types.items.enum.includes("source"), false);
    assert.equal(searchDescriptor.inputSchema.properties.types.items.enum.includes("sink"), false);
    assert.equal(saveSchema.properties.type.enum.includes("evidence"), false);
    assert.equal(saveSchema.properties.type.enum.includes("finding"), false);
    assert.deepEqual(saveSchema.properties.status.enum, ["draft", "suspected", "confirmed", "rejected", "stale"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.kind.enum, ["code", "artifact", "command", "url", "human_note"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.pathBase.enum, ["workspace", "repository", "asset_root", "external"]);
    const chainRequirement = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("chain")
      && condition.then?.properties?.attributes?.required?.includes("impact"));
    const primitiveEvidenceRequirement = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("primitive")
      && condition.if?.properties?.status?.enum?.includes("confirmed")
      && condition.then?.required?.includes("evidence"));
    const chainEvidenceRequirement = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("chain")
      && condition.if?.properties?.status?.enum?.includes("confirmed")
      && condition.then?.required?.includes("evidence"));
    const flowEndpointRequirement = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("flow-endpoint")
      && condition.then?.properties?.attributes?.required?.includes("role"));
    const hypothesisType = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("hypothesis")
      && condition.then?.properties?.status);
    assert.deepEqual(chainRequirement.then.properties.attributes.required, ["impact", "reachability"]);
    assert.deepEqual(primitiveEvidenceRequirement.then.required, ["evidence"]);
    assert.deepEqual(chainEvidenceRequirement.then.required, ["evidence"]);
    assert.deepEqual(flowEndpointRequirement.then.required, ["attributes"]);
    assert.deepEqual(flowEndpointRequirement.then.properties.attributes.required, ["role"]);
    assert.deepEqual(hypothesisType.then.properties.status.enum, ["draft", "suspected", "rejected", "stale"]);
    const correctSchema = descriptors.find((tool) => tool.name === "memory.correct").inputSchema;
    assert.deepEqual(correctSchema.properties.type.enum, saveSchema.properties.type.enum);
    const source = await registry.execute({ id: "save_source", actionClass: "synthesize", toolName: "memory.save", input: { type: "flow-endpoint", title: "Request body", attributes: { role: "source" } } });
    const sink = await registry.execute({ id: "save_sink", actionClass: "synthesize", toolName: "memory.save", input: { type: "flow-endpoint", title: "Template renderer", attributes: { role: "sink" } } });
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

  const migrated = new MemoryGraphStore({
    workspaceRoot,
    context: {
      workspaceId: "workspace_default",
      workspaceName: "Default Workspace",
      subjectId: "subject_workspace:workspace_default",
      subjectName: "Default Workspace",
    },
  });
  try {
    const grandfathered = migrated.search({ scope: "subject" }).find((node) => node.title === "Preserved finding");
    assert.equal(grandfathered.provenance.state, "legacy_unrecorded");
    const activeSameIdentity = migrated.save({ type: "trajectory", title: "Preserved finding" });
    assert.notEqual(activeSameIdentity.id, grandfathered.id);
    assert.equal(activeSameIdentity.provenance.state, "active_validated");
    assert.equal(migrated.get(grandfathered.id).provenance.state, "legacy_unrecorded");

    const database = new DatabaseSync(databasePath);
    try {
      const migratedNode = database
        .prepare("SELECT id, title, type FROM memory_nodes WHERE title = 'Preserved finding' AND catalog_hash IS NULL")
        .get();
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
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE component = 'honeycrisp_core' AND version = 7").get().name, "memory_catalog_provenance");
      assert.equal(database.prepare("SELECT session_id FROM memory_node_sessions WHERE node_id = ?").get(migratedNode.id), undefined);
      assert.deepEqual({ ...database.prepare("SELECT workspace_id, workspace_name FROM memory_node_workspaces WHERE node_id = ?").get(migratedNode.id) }, {
        workspace_id: "workspace_default",
        workspace_name: "Default Workspace",
      });
      assert.deepEqual({ ...database.prepare("SELECT subject_id, subject_name FROM memory_nodes WHERE id = ?").get(migratedNode.id) }, {
        subject_id: "subject_workspace:workspace_default",
        subject_name: "Default Workspace",
      });
      assert.equal(database.prepare("SELECT catalog_hash FROM memory_nodes WHERE id = ?").get(migratedNode.id).catalog_hash, null);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_node_catalog_validations WHERE node_id = ?").get(migratedNode.id).count, 0);
      assert.deepEqual(migrated.get(migratedNode.id).provenance, {
        state: "legacy_unrecorded",
        catalogHash: null,
        activeCatalog: false,
        validation: null,
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
      type: "trajectory",
      body: "Compare the bounded-message convention across components.",
      tags: ["ipc", "cross_workspace"],
    });
    assert.notEqual(corrected.id, node.id);
    assert.equal(corrected.type, "trajectory");
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

test("memory graph uses a runtime profile for aliases, validation, and tool schemas", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-dynamic-memory-"));
  const profileMemory = customMemoryProfile();
  const store = new MemoryGraphStore({ workspaceRoot, profileMemory });
  try {
    const aliasNode = store.save({ type: "finding", title: "Protocol claim", attributes: { extensionMetadata: "kept" } });
    assert.equal(aliasNode.type, "claim");
    assert.equal(aliasNode.status, "draft");
    assert.equal(aliasNode.attributes.extensionMetadata, "kept");
    assert.equal(aliasNode.provenance.state, "active_validated");
    assert.equal(aliasNode.provenance.catalogHash, memoryCatalogHash(profileMemory));
    assert.equal(aliasNode.provenance.validation.researchProfile, undefined);
    assert.throws(() => store.save({ type: "unknown", title: "Unknown" }), /Unsupported memory node type/);
    assert.throws(() => store.save({ type: "legacy_note", title: "Retired" }), /retired/);
    assert.throws(() => store.save({ type: "imported", title: "Imported" }), /not creatable/);
    assert.throws(() => store.save({ type: "claim", title: "Unknown status", status: "missing" }), /does not allow status/);
    assert.throws(
      () => store.save({ type: "claim", title: "Unproved", status: "verified" }),
      /requires non-empty attributes: citationKey/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "Bad key", attributes: { citationKey: "Not Valid" } }),
      /required pattern/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "Unknown evidence", evidence: [{ kind: "other", locator: {}, summary: "No catalog entry" }] }),
      /Unsupported memory evidence kind/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "Unknown path base", evidence: [{ kind: "citation", pathBase: "missing", path: "citation.txt", locator: {}, summary: "No catalog entry" }] }),
      /Unsupported memory evidence path base/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "Pathless note", evidence: [{ kind: "note", path: "note.txt", locator: {}, summary: "No path allowed" }] }),
      /does not allow a path/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "URL under relative base", evidence: [{ kind: "citation", pathBase: "workspace", path: "https://example.test/paper", locator: {}, summary: "Wrong format" }] }),
      /requires a relative path/,
    );
    assert.throws(
      () => store.save({ type: "claim", title: "Relative URL base", evidence: [{ kind: "citation", pathBase: "external", path: "paper.txt", locator: {}, summary: "Wrong format" }] }),
      /requires a URL/,
    );

    const verified = store.save({
      type: "claim",
      title: "Verified protocol claim",
      status: "verified",
      attributes: { citationKey: "rfc-9000" },
      evidence: [{ kind: "citation", pathBase: "external", path: "https://example.test/paper", locator: { page: 2 }, summary: "Primary source" }],
    });
    assert.equal(verified.status, "verified");
    assert.deepEqual(store.search({ types: ["finding"] }).map((node) => node.id), [verified.id, aliasNode.id]);
    assert.equal(store.link(aliasNode.id, verified.id, "qualifies-evidence").relation, "qualifies-evidence");

    const descriptors = createResearchToolRegistry(createMemoryGraphTools(store)).listDescriptors();
    const searchSchema = descriptors.find((tool) => tool.name === "memory.search").inputSchema;
    const saveDescriptor = descriptors.find((tool) => tool.name === "memory.save");
    const saveSchema = saveDescriptor.inputSchema;
    assert.deepEqual(saveSchema.properties.type.enum, ["claim", "finding"]);
    assert.deepEqual(searchSchema.properties.types.items.enum, ["claim", "finding", "imported"]);
    assert.deepEqual(saveSchema.properties.status.enum, ["draft", "verified", "obsolete"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.kind.enum, ["citation", "note"]);
    assert.deepEqual(saveSchema.properties.evidence.items.properties.pathBase.enum, ["workspace", "external"]);
    assert.match(saveSchema.properties.evidence.items.properties.pathBase.description, /external \(External, url\)/);
    assert.match(saveDescriptor.description, /claim \(Claim\)/);
    assert.match(saveDescriptor.description, /Aliases: finding/);
    assert.equal(saveSchema.properties.type.enum.includes("legacy_note"), false);
    assert.equal(saveSchema.properties.type.enum.includes("imported"), false);
    const verifiedRequirement = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("claim")
      && condition.if?.properties?.status?.enum?.includes("verified"));
    assert.deepEqual(verifiedRequirement.then.required.sort(), ["attributes", "evidence"].sort());
    assert.deepEqual(verifiedRequirement.then.properties.attributes.required, ["citationKey"]);
    const linkSchema = descriptors.find((tool) => tool.name === "memory.link").inputSchema;
    assert.equal("enum" in linkSchema.properties.relation, false);
    assert.match(linkSchema.properties.relation.description, /supports \(Supports\)/);
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory save exposes and creates required neighbor links atomically", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-atomic-links-"));
  const memory = customMemoryProfile();
  memory.types[0].requirements[0].requiredNeighborTypes = ["claim"];
  const store = new MemoryGraphStore({ workspaceRoot, profileMemory: memory });
  try {
    const anchor = store.save({ type: "claim", title: "Existing supporting claim" });
    const verifiedInput = {
      type: "claim",
      title: "Verified linked claim",
      status: "verified",
      attributes: { citationKey: "source-1" },
      evidence: [{
        kind: "citation",
        pathBase: "external",
        path: "https://example.test/source",
        locator: {},
        summary: "Primary source",
      }],
    };
    assert.throws(() => store.save(verifiedInput), /requires linked neighbor types: claim/);
    assert.equal(
      store.search({ scope: "subject" }).some((node) => node.title === "Verified linked claim"),
      false,
    );

    const saved = store.save({
      ...verifiedInput,
      links: [{ nodeId: anchor.id, relation: "supports", note: "Atomic dependency" }],
    });
    assert.equal(saved.status, "verified");
    assert.deepEqual(store.listEdges(saved.id).map((edge) => ({
      fromId: edge.fromId,
      toId: edge.toId,
      relation: edge.relation,
    })), [{ fromId: saved.id, toId: anchor.id, relation: "supports" }]);

    const saveSchema = createResearchToolRegistry(createMemoryGraphTools(store))
      .listDescriptors()
      .find((tool) => tool.name === "memory.save").inputSchema;
    assert.equal(saveSchema.properties.links.items.properties.nodeId.type, "string");
    const neighborRequirement = saveSchema.allOf.find((condition) =>
      condition.then?.properties?.links?.description?.includes("claim"));
    assert.deepEqual(neighborRequirement.then.required.includes("links"), true);
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory tool attributes remain wholly type-conditional", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-conditional-attributes-"));
  const memory = customMemoryProfile({ legacyLifecycle: "active", legacyCreatable: true });
  memory.types[1].attributes = {
    citationKey: {
      type: "number",
      description: "A numeric citation identifier for this type only.",
    },
  };
  const store = new MemoryGraphStore({ workspaceRoot, profileMemory: memory });
  try {
    const saveSchema = createResearchToolRegistry(createMemoryGraphTools(store))
      .listDescriptors()
      .find((tool) => tool.name === "memory.save").inputSchema;
    assert.equal(saveSchema.properties.attributes.properties, undefined);
    const claimCondition = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("claim")
      && condition.then?.properties?.attributes?.properties?.citationKey);
    const legacyCondition = saveSchema.allOf.find((condition) =>
      condition.if?.properties?.type?.enum?.includes("legacy_note")
      && condition.then?.properties?.attributes?.properties?.citationKey);
    assert.equal(claimCondition.then.properties.attributes.properties.citationKey.type, "string");
    assert.equal(legacyCondition.then.properties.attributes.properties.citationKey.type, "number");
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory-disabled empty catalogs initialize without inheriting security requirements", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-disabled-catalog-"));
  const store = new MemoryGraphStore({
    workspaceRoot,
    profileMemory: {
      types: [],
      statuses: [],
      evidenceKinds: [],
      evidencePathBases: [],
    },
  });
  try {
    assert.deepEqual(store.getProfileMemory().types, []);
    assert.throws(
      () => store.save({ type: "primitive", title: "Must stay disabled" }),
      /Unsupported memory node type/,
    );
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph isolates catalog identities while workflow-only profile changes share memory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-catalog-isolation-"));
  const memoryA = customMemoryProfile();
  const memoryB = structuredClone(memoryA);
  memoryB.statuses[0].polarity = "negative";
  memoryB.types[0].attributes.citationKey.pattern = "^source:[a-z0-9-]+$";
  const profileA = resolvedProfileForMemory(memoryA, "1", "Use the first workflow wording.");
  const profileAWorkflowUpdate = resolvedProfileForMemory(memoryA, "2", "Use revised workflow wording.");
  const profileB = resolvedProfileForMemory(memoryB, "1-b", "Use the first workflow wording.");
  assert.equal(memoryCatalogHash(profileA.profile.memory), memoryCatalogHash(profileAWorkflowUpdate.profile.memory));
  assert.notEqual(memoryCatalogHash(profileA.profile.memory), memoryCatalogHash(profileB.profile.memory));

  const firstStore = new MemoryGraphStore({ workspaceRoot, resolvedProfile: profileA });
  let first;
  try {
    first = firstStore.save({
      type: "claim",
      title: "Shared catalog identity",
      attributes: { citationKey: "stable-key" },
    });
    assert.equal(first.provenance.state, "active_validated");
    assert.equal(first.provenance.validation.researchProfile.hash, profileA.hash);
  } finally {
    firstStore.close();
  }

  const secondStore = new MemoryGraphStore({ workspaceRoot, resolvedProfile: profileB });
  let second;
  let foreignOnly;
  try {
    second = secondStore.save({
      type: "claim",
      title: "Shared catalog identity",
      attributes: { citationKey: "source:stable-key" },
    });
    foreignOnly = secondStore.save({ type: "claim", title: "Catalog B only" });
    assert.notEqual(second.id, first.id);
    assert.deepEqual(secondStore.search().map((node) => node.id).sort(), [foreignOnly.id, second.id].sort());
    assert.equal(secondStore.get(first.id).provenance.state, "foreign_validated");
    assert.throws(
      () => secondStore.link(first.id, second.id, "supports"),
      /another catalog must be explicitly reclassified/,
    );
  } finally {
    secondStore.close();
  }

  const workflowStore = new MemoryGraphStore({ workspaceRoot, resolvedProfile: profileAWorkflowUpdate });
  try {
    const refined = workflowStore.save({ type: "claim", title: "Shared catalog identity", summary: "Workflow-only refinement." });
    assert.equal(refined.id, first.id);
    assert.equal(refined.revision, 2);
    assert.equal(refined.provenance.state, "active_validated");
    assert.equal(refined.provenance.validation.kind, "inherited");
    assert.equal(refined.provenance.validation.researchProfile.hash, profileAWorkflowUpdate.hash);
    assert.equal(workflowStore.get(second.id).provenance.state, "foreign_validated");

    const adopted = workflowStore.correct(foreignOnly.id, 1, { type: "claim" });
    assert.notEqual(adopted.id, foreignOnly.id);
    assert.equal(adopted.provenance.state, "active_validated");
    assert.equal(adopted.provenance.validation.kind, "full");
    assert.equal(workflowStore.get(foreignOnly.id), null);
    assert.deepEqual(
      workflowStore.search().map((node) => node.id).sort(),
      [adopted.id, refined.id].sort(),
    );
  } finally {
    workflowStore.close();
  }

  const database = new DatabaseSync(getDefaultMemoryDatabasePath(workspaceRoot));
  try {
    const profileHashes = database
      .prepare("SELECT research_profile_hash FROM memory_node_catalog_validations WHERE node_id = ? ORDER BY node_revision")
      .all(first.id)
      .map((row) => row.research_profile_hash);
    assert.deepEqual(profileHashes, [profileA.hash, profileAWorkflowUpdate.hash]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_catalog_snapshots").get().count, 2);
  } finally {
    database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory graph preserves compatible nodes across presentation and additive catalog changes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-compatible-catalog-"));
  const originalMemory = customMemoryProfile();
  const originalProfile = resolvedProfileForMemory(originalMemory, "compatible-1", "Original workflow.");
  const originalStore = new MemoryGraphStore({ workspaceRoot, resolvedProfile: originalProfile });
  let original;
  try {
    original = originalStore.save({ type: "claim", title: "Durable claim identity" });
  } finally {
    originalStore.close();
  }

  const evolvedMemory = structuredClone(originalMemory);
  evolvedMemory.types[0].name = "Research Assertion";
  evolvedMemory.types[0].pluralName = "Research Assertions";
  evolvedMemory.types[0].description = "Renamed presentation for the same durable claim type.";
  evolvedMemory.types[0].order = 900;
  evolvedMemory.types[0].aliases = ["finding", "assertion"];
  evolvedMemory.statuses[0].name = "Working Draft";
  evolvedMemory.statuses[0].description = "Presentation-only status wording.";
  evolvedMemory.statuses[0].order = 900;
  evolvedMemory.evidenceKinds[0].name = "Published Source";
  evolvedMemory.evidenceKinds[0].description = "Presentation-only evidence wording.";
  evolvedMemory.evidencePathBases[0].name = "Project Files";
  evolvedMemory.relations[0].name = "Corroborates";
  evolvedMemory.defaultNodeLimit = 25;
  evolvedMemory.defaultCharacterBudget = 50_000;
  evolvedMemory.statuses.push({
    id: "reviewed",
    name: "Reviewed",
    description: "An additive status unused by the stored claim.",
    order: 30,
    polarity: "positive",
  });
  evolvedMemory.types[0].allowedStatuses.push("reviewed");
  evolvedMemory.types[0].attributes.optionalScore = {
    type: "number",
    description: "An additive optional field unused by the stored claim.",
  };
  evolvedMemory.types[0].requirements.push({
    statuses: ["reviewed"],
    requireEvidence: true,
  });
  evolvedMemory.types.push({
    id: "observation",
    name: "Observation",
    pluralName: "Observations",
    description: "An additive memory type unrelated to existing claims.",
    lifecycle: "active",
    creatable: true,
    order: 40,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "obsolete"],
  });
  evolvedMemory.evidenceKinds.push({
    id: "dataset",
    name: "Dataset",
    description: "An additive evidence kind.",
    allowsPath: true,
  });
  evolvedMemory.evidencePathBases.push({
    id: "archive",
    name: "Archive",
    description: "An additive evidence path base.",
  });
  const evolvedProfile = resolvedProfileForMemory(evolvedMemory, "compatible-2", "Evolved workflow.");
  assert.notEqual(memoryCatalogHash(originalProfile.profile.memory), memoryCatalogHash(evolvedProfile.profile.memory));

  const evolvedStore = new MemoryGraphStore({ workspaceRoot, resolvedProfile: evolvedProfile });
  try {
    const recalled = evolvedStore.search({ scope: "subject" });
    assert.deepEqual(recalled.map((node) => node.id), [original.id]);
    assert.equal(recalled[0].provenance.state, "active_validated");
    assert.equal(recalled[0].provenance.activeCatalog, true);
    assert.equal(recalled[0].provenance.catalogHash, originalProfile.profile
      ? memoryCatalogHash(originalProfile.profile.memory)
      : undefined);

    const refined = evolvedStore.save({
      type: "assertion",
      title: "Durable claim identity",
      summary: "Refined after a compatible catalog evolution.",
    });
    assert.equal(refined.id, original.id);
    assert.equal(refined.revision, 2);
    assert.equal(refined.provenance.catalogHash, memoryCatalogHash(evolvedProfile.profile.memory));
    assert.equal(refined.provenance.validation.researchProfile.hash, evolvedProfile.hash);
  } finally {
    evolvedStore.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("general catalogs do not implicitly recall unprofiled security memory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-legacy-boundary-"));
  const securityStore = new MemoryGraphStore({ workspaceRoot });
  let legacy;
  try {
    legacy = securityStore.save({ type: "primitive", title: "Legacy security primitive" });
  } finally {
    securityStore.close();
  }
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("DELETE FROM memory_node_catalog_validations WHERE node_id = ?").run(legacy.id);
    database.prepare("UPDATE memory_nodes SET catalog_hash = NULL WHERE id = ?").run(legacy.id);
  } finally {
    database.close();
  }

  const generalStore = new MemoryGraphStore({ workspaceRoot, profileMemory: customMemoryProfile() });
  try {
    assert.deepEqual(generalStore.search({ scope: "subject" }), []);
    assert.equal(generalStore.get(legacy.id).provenance.state, "legacy_unrecorded");
  } finally {
    generalStore.close();
  }

  const securityAgain = new MemoryGraphStore({ workspaceRoot });
  try {
    assert.deepEqual(securityAgain.search({ scope: "subject" }).map((node) => node.id), [legacy.id]);
  } finally {
    securityAgain.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("memory catalog snapshots are canonical, hash-bound, and immutable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-catalog-snapshot-"));
  const memory = customMemoryProfile();
  const reorderedMemory = {
    defaultCharacterBudget: memory.defaultCharacterBudget,
    relations: memory.relations,
    evidencePathBases: memory.evidencePathBases,
    evidenceKinds: memory.evidenceKinds,
    statuses: memory.statuses,
    types: memory.types,
    defaultNodeLimit: memory.defaultNodeLimit,
  };
  const hash = memoryCatalogHash(memory);
  assert.equal(memoryCatalogHash(reorderedMemory), hash);
  assert.equal(
    memoryCatalogHash(resolvedProfileForMemory(memory, "normalized", "Normalized catalog.").profile.memory),
    hash,
  );
  const store = new MemoryGraphStore({ workspaceRoot, profileMemory: memory });
  assert.equal(store.getMemoryCatalogHash(), hash);
  assert.equal(Object.isFrozen(store.getProfileMemory()), true);
  store.close();

  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const database = new DatabaseSync(databasePath);
  const otherMemory = structuredClone(memory);
  otherMemory.types[0].description = "A mismatched snapshot body.";
  const otherHash = memoryCatalogHash(otherMemory);
  try {
    const snapshot = database
      .prepare("SELECT schema_version, catalog_json FROM memory_catalog_snapshots WHERE catalog_hash = ?")
      .get(hash);
    assert.equal(snapshot.schema_version, 1);
    assert.deepEqual(
      JSON.parse(snapshot.catalog_json),
      resolvedProfileForMemory(memory, "snapshot", "Snapshot normalization.").profile.memory,
    );
    assert.notEqual(createHash("sha256").update(snapshot.catalog_json).digest("hex"), hash);
    assert.throws(
      () => database.prepare("UPDATE memory_catalog_snapshots SET catalog_json = catalog_json WHERE catalog_hash = ?").run(hash),
      /immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM memory_catalog_snapshots WHERE catalog_hash = ?").run(hash),
      /immutable/,
    );
    database
      .prepare("INSERT INTO memory_catalog_snapshots(catalog_hash, schema_version, catalog_json, created_at) VALUES (?, 1, '{}', ?)")
      .run(otherHash, "2026-08-10T00:00:00.000Z");
  } finally {
    database.close();
  }
  assert.throws(
    () => new MemoryGraphStore({ workspaceRoot, profileMemory: otherMemory }),
    /snapshot does not match catalog hash/,
  );
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("memory graph reads retired and unknown legacy rows and permits unrelated corrections", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-grandfathered-memory-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const initialMemory = customMemoryProfile({ legacyLifecycle: "active", legacyCreatable: true, requireVerifiedClaimEvidence: false });
  const initial = new MemoryGraphStore({ workspaceRoot, profileMemory: initialMemory });
  let legacy;
  let grandfathered;
  let unknown;
  try {
    legacy = initial.save({ type: "legacy_note", title: "Old note" });
    grandfathered = initial.save({ type: "claim", title: "Old verified claim", status: "verified" });
    unknown = initial.save({
      type: "claim",
      title: "Removed type",
      evidence: [{ kind: "note", locator: {}, summary: "Old evidence" }],
    });
  } finally {
    initial.close();
  }

  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE memory_nodes SET attributes_json = ? WHERE id = ?").run('{"citationKey":"INVALID VALUE"}', grandfathered.id);
    database.prepare("UPDATE memory_nodes SET type = 'removed_type', status = 'legacy_status' WHERE id = ?").run(unknown.id);
    database.prepare("UPDATE memory_evidence_refs SET kind = 'legacy_evidence', path_base = 'legacy_root' WHERE node_id = ?").run(unknown.id);
  } finally {
    database.close();
  }

  const current = new MemoryGraphStore({ workspaceRoot, profileMemory: customMemoryProfile() });
  try {
    assert.equal(current.get(legacy.id).type, "legacy_note");
    assert.equal(current.get(legacy.id).provenance.state, "active_validated");
    const correctedLegacy = current.correct(legacy.id, 1, { summary: "Retained retired knowledge." });
    assert.equal(correctedLegacy.summary, "Retained retired knowledge.");
    assert.equal(correctedLegacy.provenance.state, "active_validated");
    assert.throws(() => current.save({ type: "legacy_note", title: "New retired note" }), /retired/);

    assert.equal(current.get(grandfathered.id).status, "verified");
    assert.equal(current.get(grandfathered.id).provenance.state, "catalog_unvalidated");
    const correctedGrandfathered = current.correct(grandfathered.id, 1, { body: "An unrelated correction." });
    assert.equal(correctedGrandfathered.body, "An unrelated correction.");
    assert.equal(correctedGrandfathered.provenance.state, "catalog_unvalidated");
    const repairedEvidence = current.correct(grandfathered.id, 2, {
      evidence: [{ kind: "citation", pathBase: "external", path: "https://example.test/new-source", locator: {}, summary: "New source" }],
    });
    assert.equal(repairedEvidence.evidence.length, 1);
    assert.equal(repairedEvidence.provenance.state, "catalog_unvalidated");
    assert.throws(
      () => current.correct(grandfathered.id, 3, { status: "verified" }),
      /required pattern/,
    );

    const unknownNode = current.get(unknown.id);
    assert.equal(unknownNode.type, "removed_type");
    assert.equal(unknownNode.status, "legacy_status");
    assert.equal(unknownNode.evidence[0].kind, "legacy_evidence");
    assert.equal(unknownNode.evidence[0].pathBase, "legacy_root");
    assert.equal(unknownNode.provenance.state, "catalog_unvalidated");
    const correctedUnknown = current.correct(unknown.id, 1, { summary: "Unknown rows remain repairable." });
    assert.equal(correctedUnknown.summary, "Unknown rows remain repairable.");
    assert.equal(correctedUnknown.provenance.state, "catalog_unvalidated");
    assert.throws(
      () => current.correct(unknown.id, 2, { status: "draft" }),
      /unknown stored memory node type/,
    );
  } finally {
    current.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("searching a replacement type includes compatible retired memory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-replaced-memory-"));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const initialMemory = customMemoryProfile({ legacyLifecycle: "active", legacyCreatable: true });
  const initial = new MemoryGraphStore({ workspaceRoot, databasePath, profileMemory: initialMemory });
  let legacy;
  try {
    legacy = initial.save({ type: "legacy_note", title: "Old claim representation" });
  } finally {
    initial.close();
  }

  const currentMemory = customMemoryProfile();
  currentMemory.types.find((type) => type.id === "legacy_note").replacedBy = "claim";
  const current = new MemoryGraphStore({ workspaceRoot, databasePath, profileMemory: currentMemory });
  try {
    assert.deepEqual(current.search({ types: ["claim"] }).map((node) => node.id), [legacy.id]);
    assert.deepEqual(current.search({ types: ["finding"] }).map((node) => node.id), [legacy.id]);
  } finally {
    current.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function resolvedProfileForMemory(memory, version, workflowInstruction) {
  const profile = normalizeResearchProfile({
    ...DEFAULT_SECURITY_RESEARCH_PROFILE,
    id: "test_research_profile",
    version,
    memory,
    workflows: DEFAULT_SECURITY_RESEARCH_PROFILE.workflows.map((workflow, index) =>
      index === 0
        ? {
            ...workflow,
            promptInstructions: [...workflow.promptInstructions, workflowInstruction],
          }
        : workflow),
  });
  return {
    profile,
    hash: researchProfileHash(profile),
    source: "explicit",
  };
}

function customMemoryProfile(options = {}) {
  const legacyLifecycle = options.legacyLifecycle ?? "retired";
  const legacyCreatable = options.legacyCreatable ?? false;
  const requirements = options.requireVerifiedClaimEvidence === false
    ? []
    : [{ statuses: ["verified"], requiredAttributes: ["citationKey"], requireEvidence: true }];
  return {
    types: [
      {
        id: "claim",
        name: "Claim",
        pluralName: "Claims",
        description: "A testable research claim.",
        lifecycle: "active",
        creatable: true,
        aliases: ["finding"],
        order: 10,
        defaultStatus: "draft",
        allowedStatuses: ["draft", "verified", "obsolete"],
        contextWeight: 25,
        attributes: {
          citationKey: { type: "string", description: "Stable citation key.", pattern: "^[a-z0-9-]+$" },
        },
        requirements,
      },
      {
        id: "legacy_note",
        name: "Legacy Note",
        pluralName: "Legacy Notes",
        description: "A retired historical type.",
        lifecycle: legacyLifecycle,
        creatable: legacyCreatable,
        order: 20,
        defaultStatus: "draft",
        allowedStatuses: ["draft", "obsolete"],
      },
      {
        id: "imported",
        name: "Imported Record",
        pluralName: "Imported Records",
        description: "A read-only imported record.",
        lifecycle: "active",
        creatable: false,
        order: 30,
        defaultStatus: "draft",
        allowedStatuses: ["draft", "obsolete"],
      },
    ],
    statuses: [
      { id: "draft", name: "Draft", description: "Unverified.", order: 10 },
      { id: "verified", name: "Verified", description: "Verified.", order: 20 },
      { id: "obsolete", name: "Obsolete", description: "No longer current.", order: 30, terminal: true },
    ],
    evidenceKinds: [
      { id: "citation", name: "Citation", description: "An external citation.", allowsPath: true },
      { id: "note", name: "Note", description: "A pathless note.", allowsPath: false },
    ],
    evidencePathBases: [
      { id: "workspace", name: "Workspace", description: "Workspace relative." },
      { id: "external", name: "External", description: "External reference.", pathFormat: "url" },
    ],
    relations: [
      { id: "supports", name: "Supports", description: "Supports another memory." },
      { id: "qualifies-evidence", name: "Qualifies Evidence", description: "Qualifies another memory's evidence." },
    ],
    defaultNodeLimit: 2,
    defaultCharacterBudget: 4_000,
  };
}
