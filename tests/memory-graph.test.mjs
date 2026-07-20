import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
