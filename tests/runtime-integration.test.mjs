import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapResearchRun,
  createDeterministicLoopExecutor,
  createLocalInspectionTool,
  createResearchFlowCapture,
  createResearchToolRegistry,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
} from "../packages/research-agent/dist/index.js";

test("durable bootstrap writes records and retrieves them between loops", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runtime-memory-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runtime-fixture-"));
  const fixtureFile = join(fixtureRoot, "parser.txt");
  await writeFile(
    fixtureFile,
    "parse_context_save is the parser context handoff evidence.\n",
    "utf8",
  );
  const inspection = createLocalInspectionTool({
    allowedRoots: [fixtureRoot],
    maxBytes: 1000,
  });
  const toolRegistry = createResearchToolRegistry([inspection.executable]);

  const result = await bootstrapResearchRun({
    prompt: [
      `Goal: Inspect local parser evidence in ${fixtureFile}`,
      "Success gates: direct parser evidence captured",
      "Scope constraints: local fixture only",
    ].join("\n"),
    workspaceRoot,
    durableMemory: true,
    tools: [inspection.descriptor],
    governance: {
      allowedSideEffects: ["read"],
      maxToolCalls: 1,
    },
    loopExecutor: createDeterministicLoopExecutor({ toolRegistry }),
    goalRun: {
      maxLoops: 2,
    },
  });
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const recordStore = createSqliteMemoryRecordStore({ workspaceRoot });
  const capture = createResearchFlowCapture(result);

  try {
    const records = recordStore.list();
    const toolEvents = eventLog
      .listAll()
      .filter((event) => event.kind === "tool.requested" || event.kind === "tool.observed");

    assert.equal(result.goalRun.iterations.length, 2);
    assert.equal(result.durableMemory?.enabled, true);
    assert.ok(result.durableMemory.eventsAppended > 0);
    assert.ok(result.durableMemory.recordsWritten > 0);
    assert.ok(result.durableMemory.latestRetrievalCandidateCount > 0);
    assert.equal(result.durableMemory.usedMemoryDrivenController, true);
    assert.equal(capture.memoryIntegration?.enabled, true);
    assert.ok(capture.contextV2?.sections.length > 0);
    assert.ok(
      capture.context.toolPermissions.some(
        (permission) => permission.toolName === "local.inspection",
      ),
    );
    assert.ok(
      capture.storage.directories.some(
        (directory) => directory.name === "scratch",
      ),
    );
    assert.equal(
      capture.storageManifest.path.endsWith(".honeycrisp/memory/artifacts/manifest.json"),
      true,
    );
    assert.ok(records.some((record) => record.kind === "evidence"));
    assert.deepEqual(toolEvents.map((event) => event.kind), [
      "tool.requested",
      "tool.observed",
    ]);
  } finally {
    eventLog.close();
    recordStore.close();
  }
});
