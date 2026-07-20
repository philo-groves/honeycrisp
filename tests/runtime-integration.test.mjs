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
  createResearchEventId,
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

test("durable bootstrap sends compacted memory context to loop model input", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-runtime-compact-model-input-"));
  const noisyPriorEvents = Array.from({ length: 140 }, (_, index) => ({
    id: createResearchEventId(),
    kind: "model.visible_note",
    timestamp: "2026-06-24T00:00:00.000Z",
    payload: {
      summary: [
        `Prior-goal scan ${index}: selected Src/noisy-${index}.c and exhausted the candidate without confirmed proof.`,
        "This intentionally verbose episode should not all be replayed into the next model input.",
        "repeat-context-detail ".repeat(20),
      ].join(" "),
    },
  }));
  let capturedModelInput = null;
  const captureExecutor = {
    name: "capture-model-input",
    async execute(input) {
      capturedModelInput = input.modelInput;
      return {
        text: "Captured compact context.",
        artifacts: [],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [],
      };
    },
  };

  const result = await bootstrapResearchRun({
    prompt: [
      "Goal: Inspect fresh parser evidence without repeating prior exhausted files",
      "Success gates: choose a fresh target",
      "Scope constraints: local fixture only",
    ].join("\n"),
    workspaceRoot,
    durableMemory: true,
    events: noisyPriorEvents,
    loopExecutor: captureExecutor,
    goalRun: {
      maxLoops: 1,
    },
  });

  assert.equal(result.durableMemory?.usedMemoryDrivenController, true);
  assert.ok(capturedModelInput);
  const priorSection = capturedModelInput.contextSections.find(
    (section) => section.label === "prior_observations",
  );
  assert.ok(priorSection);
  assert.ok(Array.isArray(priorSection.content));
  assert.ok(
    priorSection.content.length < noisyPriorEvents.length,
    "prior observations should be bounded by contextV2 selection",
  );
  assert.equal(
    priorSection.content.length,
    result.durableMemory?.latestContextPacketV2?.sections.find(
      (section) => section.label === "prior_episodes",
    )?.items.length,
  );
  assert.ok(
    JSON.stringify(capturedModelInput.contextSections).length < 50_000,
    "model input context sections should stay below the conservative context guard",
  );
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
    authorization: {
      recorded: true,
      source: "beale",
      scopeId: "scope_zsh_fixture",
      scopeName: "ZSH fixture",
      networkProfile: "offline",
    },
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
  assert.equal(result.workspaceContext.authorization?.scopeId, "scope_zsh_fixture");
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
