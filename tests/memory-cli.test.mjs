import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
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

test("main CLI defaults to real mode and preflights auth", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(["-p", "Goal: Check real-mode preflight"], {
    HONEYCRISP_AUTH_FILE: authFile,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /real mode requires configured credentials/);
  assert.match(result.stderr, /pass --mock for deterministic mode/);
});

test("main CLI supports deterministic mock mode without auth", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(
    [
      "--mock",
      "-p",
      "Goal: Exercise deterministic mock mode\nScope constraints: test only",
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Loop result: complete via deterministic-first-run/);
  assert.match(result.stdout, /Execution mode: deterministic/);
});

test("main CLI persists top-level runtime tool events to sqlite", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-top-cli-memory-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-top-cli-tool-"));
  const fixtureFile = join(fixtureRoot, "parse.c");
  await writeFile(fixtureFile, "cli parser evidence\n", "utf8");
  const result = runTopCli(
    [
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--inspect-root",
      fixtureRoot,
      "-p",
      [
        `Goal: Inspect local parser evidence in ${fixtureFile}`,
        "Scope constraints: local fixture only",
      ].join("\n"),
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const toolEvents = eventLog
    .listAll()
    .filter((event) => event.kind === "tool.requested" || event.kind === "tool.observed");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(toolEvents.map((event) => event.kind), [
    "tool.requested",
    "tool.observed",
  ]);
  assert.match(toolEvents[1]?.payload.summary, /cli parser evidence/);

  eventLog.close();
});

test("main CLI rejects retired run-mode flags with migration hints", () => {
  const realResult = runTopCli(["--real", "-p", "Goal: old flag"]);

  assert.equal(realResult.status, 1);
  assert.match(realResult.stderr, /--real was removed/);
  assert.match(realResult.stderr, /Pass --mock/);
});

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

function runTopCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function createEmptyAuthFilePath() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-auth-empty-"));
  return join(root, "auth.json");
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
