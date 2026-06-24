import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
} from "../packages/research-agent/dist/index.js";

const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("memory CLI shows subcommand help", () => {
  const result = spawnSync(process.execPath, [cliPath, "memory", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: honeycrisp memory <command>/);
});

test("memory CLI prints event timelines and records as JSON", async () => {
  const { workspaceRoot, eventId, eventLog, recordStore } = await createCliFixture();

  const timeline = runMemoryCliJson("timeline", "--workspace-root", workspaceRoot);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[1]?.id, eventId);

  const records = runMemoryCliJson(
    "records-for-event",
    eventId,
    "--workspace-root",
    workspaceRoot,
  );
  assert.ok(records.some((record) => record.kind === "semantic_claim"));

  eventLog.close();
  recordStore.close();
});

test("memory CLI prints recall, context, decision, and debug capture data", async () => {
  const { workspaceRoot, eventLog, recordStore } = await createCliFixture();
  const goal = "Goal: Inspect parser memory\nScope constraints: local only";

  const preconscious = runMemoryCliJson(
    "preconscious",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
    "--question",
    "Which parser memory is available?",
  );
  assert.ok(preconscious.candidateCount > 0);

  const context = runMemoryCliJson(
    "context",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.ok(context.sections.some((section) => section.itemCount > 0));

  const decision = runMemoryCliJson(
    "decision",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.equal(typeof decision.actionClass, "string");

  const debugCapture = runMemoryCliJson(
    "debug-capture",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.ok(debugCapture.acceptedEvents.length > 0);
  assert.ok(debugCapture.committedWrites.length > 0);
  assert.ok(debugCapture.retrievalResults?.candidateCount);
  assert.ok(debugCapture.contextSelections?.sections.length);
  assert.equal(debugCapture.controllerDecision?.actionClass, decision.actionClass);

  eventLog.close();
  recordStore.close();
});

async function createCliFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-cli-"));
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const recordStore = createSqliteMemoryRecordStore({ workspaceRoot });
  const events = [
    createEvent("tool.observed", {
      summary: "Parser source was inspected.",
      confidence: 0.95,
    }),
    createEvent("model.claim", {
      claim: "Parser normalization happens before expansion.",
      evidenceRefIds: ["parser_source"],
    }),
    createEvent("user.commitment", {
      commitment: "Keep parser inspection local.",
      trigger: "Before any search action.",
    }),
  ];
  const acceptedEvents = eventLog.appendMany(events);
  const records = createDeterministicMemoryWritePipeline().deriveMany(acceptedEvents);
  recordStore.writeMany(records);

  return {
    workspaceRoot,
    eventId: acceptedEvents[1].id,
    eventLog,
    recordStore,
  };
}

function runMemoryCliJson(...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "memory", ...args, "--json"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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
