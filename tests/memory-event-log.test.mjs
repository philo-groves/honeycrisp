import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  computeMemoryEventPayloadHash,
  createMemorySnapshotFromEventLog,
  createResearchEventId,
  createSqliteMemoryEventLog,
  getDefaultMemoryArtifactDirectoryPath,
  getDefaultMemoryDatabasePath,
} from "../packages/research-agent/dist/index.js";

test("sqlite memory event log appends accepted events in deterministic sequence order", async () => {
  const workspaceRoot = await createTempWorkspace();
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const artifactDirectoryPath =
    getDefaultMemoryArtifactDirectoryPath(workspaceRoot);
  const log = createSqliteMemoryEventLog({ workspaceRoot });

  const goalEvent = createEvent("goal.created", {
    objective: "Persist events",
    status: "active",
  }, {
    goalId: "goal_phase2",
  });
  const observationEvent = createEvent("tool.observed", {
    summary: "Read the memory plan.",
    path: "/tmp/MEMORY_PLAN.md",
  }, {
    goalId: "goal_phase2",
    loopId: "loop_phase2",
    subGoalId: "subgoal_phase2",
    artifactRefs: [
      {
        id: "artifact_memory_plan",
        kind: "file",
        uri: "file:///tmp/MEMORY_PLAN.md",
        summary: "Memory plan fixture",
        contentHash: "sha256:fixture",
      },
    ],
  });

  const appended = log.appendMany([goalEvent, observationEvent]);

  assert.equal(existsSync(databasePath), true);
  assert.equal(existsSync(artifactDirectoryPath), true);
  assert.deepEqual(appended.map((event) => event.sequence), [1, 2]);
  assert.equal(
    appended[0]?.payloadHash,
    computeMemoryEventPayloadHash(goalEvent.payload),
  );
  assert.equal(log.getById(observationEvent.id)?.sequence, 2);
  assert.deepEqual(
    log.listBySequenceRange({ fromSequence: 2, toSequence: 2 }).map(
      (event) => event.id,
    ),
    [observationEvent.id],
  );
  assert.deepEqual(
    log.listByGoalId("goal_phase2").map((event) => event.id),
    [goalEvent.id, observationEvent.id],
  );
  assert.deepEqual(
    log.listByLoopId("loop_phase2").map((event) => event.id),
    [observationEvent.id],
  );
  assert.deepEqual(
    log.listBySubGoalId("subgoal_phase2").map((event) => event.id),
    [observationEvent.id],
  );
  assert.deepEqual(
    log.listByKind("tool.observed").map((event) => event.id),
    [observationEvent.id],
  );
  assert.deepEqual(log.getById(observationEvent.id)?.artifactRefs, [
    {
      id: "artifact_memory_plan",
      kind: "file",
      uri: "file:///tmp/MEMORY_PLAN.md",
      summary: "Memory plan fixture",
      contentHash: "sha256:fixture",
    },
  ]);

  log.close();
});

test("sqlite memory event log reloads from disk and rejects duplicate event ids without mutation", async () => {
  const workspaceRoot = await createTempWorkspace();
  const firstLog = createSqliteMemoryEventLog({ workspaceRoot });
  const firstEvent = createEvent("goal.created", {
    objective: "Reload event log",
    status: "active",
  }, {
    goalId: "goal_reload",
  });
  const appendedFirst = firstLog.append(firstEvent);
  firstLog.close();

  const reloadedLog = createSqliteMemoryEventLog({ workspaceRoot });
  const secondEvent = createEvent("model.visible_note", {
    summary: "Reload preserved the first row.",
  }, {
    goalId: "goal_reload",
  });
  const beforeDuplicate = reloadedLog.getById(firstEvent.id);

  reloadedLog.append(secondEvent);

  assert.deepEqual(
    reloadedLog.listAll().map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(
    reloadedLog.listAll().map((event) => event.id),
    [firstEvent.id, secondEvent.id],
  );
  assert.deepEqual(beforeDuplicate, appendedFirst);
  assert.throws(
    () => reloadedLog.append(firstEvent),
    /Memory event already exists/,
  );
  assert.deepEqual(reloadedLog.getById(firstEvent.id), beforeDuplicate);
  assert.equal(reloadedLog.listAll().length, 2);

  reloadedLog.close();
});

test("sqlite memory event log rejects invalid payloads, private thoughts, and hook failures", async () => {
  const workspaceRoot = await createTempWorkspace();
  const log = createSqliteMemoryEventLog({
    workspaceRoot,
    rejectionHooks: [
      (event) =>
        event.kind === "error.observed" ? "error events disabled in test" : undefined,
    ],
  });

  assert.throws(
    () =>
      log.append({
        ...createEvent("model.visible_note", {
          summary: "Invalid kind fixture",
        }),
        kind: "model.private_thought",
      }),
    /Unsupported memory event kind/,
  );
  assert.throws(
    () =>
      log.append(
        createEvent("model.visible_note", {
          summary: "Invalid payload fixture",
          missing: undefined,
        }),
      ),
    /cannot be undefined/,
  );
  assert.throws(
    () =>
      log.append(
        createEvent("model.visible_note", {
          summary: "Should be rejected.",
          chainOfThought: "private scratch reasoning",
        }),
      ),
    /private thought-like data/,
  );
  assert.throws(
    () =>
      log.append(
        createEvent("error.observed", {
          summary: "Hook should reject this event.",
        }),
      ),
    /rejected by hook/,
  );
  assert.equal(log.listAll().length, 0);

  log.close();
});

test("sqlite memory event log remains compatible with existing memory snapshot routing", async () => {
  const workspaceRoot = await createTempWorkspace();
  const log = createSqliteMemoryEventLog({ workspaceRoot });
  const observationEvent = createEvent("tool.observed", {
    summary: "SQLite event rows can still feed the context snapshot.",
  }, {
    goalId: "goal_snapshot",
  });

  log.append(observationEvent);

  const memory = createMemorySnapshotFromEventLog(log);

  assert.equal(memory.eventLog.length, 1);
  assert.equal(memory.eventLog[0]?.sequence, 1);
  assert.equal(memory.directEvidence.length, 1);
  assert.equal(memory.directEvidence[0]?.recordKind, "evidence");
  assert.match(
    memory.directEvidence[0]?.summary ?? "",
    /SQLite event rows can still feed/,
  );

  log.close();
});

test("sqlite memory event log spills large tool results to artifact storage across restart", async () => {
  const workspaceRoot = await createTempWorkspace();
  const firstLog = createSqliteMemoryEventLog({
    workspaceRoot,
    largePayloadThresholdBytes: 256,
  });
  const largeText = "parser evidence ".repeat(200);
  const observationEvent = createEvent("tool.observed", {
    toolName: "local.inspection",
    actionClass: "inspect",
    status: "complete",
    summary: "Large parser output was read.",
    evidenceExtracted: ["Large parser output was read."],
    result: {
      text: largeText,
      bytesRead: largeText.length,
    },
  }, {
    goalId: "goal_spill",
  });

  const appended = firstLog.append(observationEvent);
  const artifactRef = appended.artifactRefs?.[0];
  assert.ok(artifactRef);
  assert.equal(artifactRef.kind, "tool_raw_output");
  assert.equal(appended.payload.result, undefined);
  assert.equal(appended.payload.rawOutputRef, artifactRef.id);
  assert.match(appended.payload.rawOutputHash, /^sha256:/);
  assert.equal(appended.payload.summary, "Large parser output was read.");
  const artifactPath = fileURLToPath(artifactRef.uri);
  assert.equal(existsSync(artifactPath), true);
  assert.match(readFileSync(artifactPath, "utf8"), /parser evidence/);
  firstLog.close();

  const reloadedLog = createSqliteMemoryEventLog({ workspaceRoot });
  const reloaded = reloadedLog.getById(observationEvent.id);
  assert.deepEqual(reloaded?.artifactRefs, appended.artifactRefs);
  assert.equal(reloaded?.payload.rawOutputRef, artifactRef.id);
  assert.equal(existsSync(artifactPath), true);

  reloadedLog.close();
});

async function createTempWorkspace() {
  return mkdtemp(join(tmpdir(), "honeycrisp-memory-log-"));
}

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: "2026-06-24T00:00:00.000Z",
    payload,
    ...options,
  };
}
