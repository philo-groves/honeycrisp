import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapResearchRun,
  createDeterministicLoopExecutor,
  createLocalInspectionTool,
  createRepositorySearchTool,
  createResearchFlowCapture,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createResearchWorkspaceContext,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
  createStructuredFileReadTool,
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

test("bootstrap run exposes workspace context with repository and source hints", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runtime-workspace-context-"));
  const sourceRoot = join(workspaceRoot, "sources", "zsh");
  await mkdir(join(sourceRoot, "Src"), { recursive: true });
  await writeFile(
    join(sourceRoot, "Src", "placeholder.txt"),
    "placeholder\n",
  );
  const storageLayout = createResearchStorageLayout({ workspaceRoot });
  const workspaceContext = createResearchWorkspaceContext({
    workspaceRoot,
    storageLayout,
    knownRepositories: [
      {
        rootPath: sourceRoot,
        role: "known_repository",
        source: "cli",
        label: "ZSH fixture",
      },
    ],
    materializedSourcePaths: [sourceRoot],
    projectNotes: ["Apple Security Bounty test project"],
  });
  const repositorySearch = createRepositorySearchTool({ roots: [sourceRoot] });
  const fileRead = createStructuredFileReadTool({ contextRoots: [sourceRoot] });

  const result = await bootstrapResearchRun({
    prompt: "Goal: Inspect nested ZSH source context",
    workspaceRoot,
    storageLayout,
    workspaceContext,
    durableMemory: true,
    tools: [repositorySearch.descriptor, fileRead.descriptor],
    goalRun: {
      maxLoops: 1,
    },
  });
  const capture = createResearchFlowCapture(result);
  const compiledContextEvent = result.events.find(
    (event) => event.kind === "context.compiled",
  );

  assert.equal(result.workspaceContext.workspaceRoot, workspaceRoot);
  assert.equal(capture.workspaceContext.knownRepositories[0]?.rootPath, sourceRoot);
  assert.equal(capture.context.workspaceContext?.materializedSourcePaths[0], sourceRoot);
  assert.ok(
    capture.contextV2?.sections.some(
      (section) =>
        section.label === "workspace_context" && section.itemCount === 1,
    ),
  );
  assert.equal(
    compiledContextEvent?.payload.workspaceContext.knownRepositories[0].rootPath,
    sourceRoot,
  );
});

test("durable bootstrap omits absent optional loop trace payload fields", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runtime-no-trace-"));
  const executor = {
    name: "no-trace-fixture",
    async execute() {
      return {
        text: "Completed without visible trace JSON.",
        artifacts: [],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [],
      };
    },
  };

  const result = await bootstrapResearchRun({
    prompt: "Goal: Complete without model-visible trace",
    workspaceRoot,
    durableMemory: true,
    loopExecutor: executor,
    goalRun: {
      maxLoops: 1,
    },
  });
  const loopProcessed = result.events.find(
    (event) => event.kind === "loop.processed",
  );

  assert.equal(loopProcessed?.payload.summary, "Completed without visible trace JSON.");
  assert.equal(Object.hasOwn(loopProcessed?.payload ?? {}, "researchTrace"), false);
});
