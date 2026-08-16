import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HoneycrispSessionStore,
} from "../packages/research-agent/dist/index.js";
import { decodeHoneycrispProtocolEnvelope } from "../packages/cli/dist/protocol.js";

const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("session store owns creation, lifecycle, capture import, and queries as one revisioned aggregate", () => {
  const store = new HoneycrispSessionStore({ databasePath: ":memory:" });
  try {
    const created = store.create({
      id: "session_one",
      workspaceId: "workspace_one",
      attemptId: "attempt_one",
      title: "Session one",
      prompt: "Inspect the parser.",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    assert.equal(created.revision, 1);

    const withLiveEvent = store.appendEvent(created.id, {
      id: "event_one",
      kind: "agent.event",
      timestamp: "2026-08-15T12:00:00.000Z",
      summary: "Inspected parser",
      payload: { eventType: "tool.completed" },
    });
    assert.equal(withLiveEvent.revision, 2);

    const imported = store.importCapture(created.id, {
      attemptId: "attempt_one",
      expectedRevision: 2,
      capture: captureFixture(),
    });
    assert.equal(imported.status, "completed");
    assert.equal(imported.finalResponse, "The parser is safe.");
    assert.equal(imported.events.length, 2);
    assert.equal(imported.attempts[0].capture.schemaVersion, 5);
    assert.equal(store.list("workspace_one")[0].revision, 3);
    assert.throws(
      () => store.transition(created.id, { status: "stopped", summary: "Stale writer", expectedRevision: 2 }),
      /revision conflict/,
    );
  } finally {
    store.close();
  }
});

test("versioned session CLI imports captures and serves the canonical query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-protocol-"));
  const databasePath = join(directory, "memory.sqlite");
  const createPath = join(directory, "create.json");
  const capturePath = join(directory, "capture.json");
  await writeFile(createPath, JSON.stringify({
    id: "session_cli",
    workspaceId: "workspace_cli",
    attemptId: "attempt_cli",
    title: "CLI session",
    prompt: "Inspect the CLI.",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }));
  await writeFile(capturePath, JSON.stringify(captureFixture()));
  const env = { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath };

  const created = runCli(["session", "create", "--input", createPath, "--json"], env);
  assert.equal(created.operation, "session.create");
  assert.equal(created.ok, true);
  const imported = runCli([
    "session", "import-capture",
    "--session-id", "session_cli",
    "--attempt-id", "attempt_cli",
    "--capture", capturePath,
    "--json",
  ], env);
  assert.equal(imported.operation, "session.import_capture");
  const queried = runCli(["session", "get", "--session-id", "session_cli", "--json"], env);
  assert.equal(queried.result.status, "completed");
  assert.equal(queried.result.finalResponse, "The parser is safe.");
});

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return decodeHoneycrispProtocolEnvelope(JSON.parse(result.stdout));
}

function captureFixture() {
  return {
    schemaVersion: 5,
    capturedAt: "2026-08-15T12:01:00.000Z",
    request: { prompt: "Inspect the parser." },
    agent: {
      id: "agent_one",
      status: "complete",
      executorName: "fixture",
      startedAt: "2026-08-15T12:00:00.000Z",
      completedAt: "2026-08-15T12:01:00.000Z",
      outputText: "The parser is safe.",
      finalDisposition: {
        outcome: "objective_achieved",
        summary: "Inspection complete.",
        externalStateRequired: false,
        blockerDependencies: [],
      },
    },
    eventTimeline: [{
      id: "event_two",
      kind: "agent.event",
      timestamp: "2026-08-15T12:00:30.000Z",
      summary: "Reviewed result",
      payload: { eventType: "assistant.message" },
    }],
  };
}
