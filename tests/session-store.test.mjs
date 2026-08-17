import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
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
    assert.equal(store.get(created.id).attempts[0].capture.schemaVersion, 5);
    assert.equal(store.list("workspace_one")[0].revision, 3);
    assert.throws(
      () => store.transition(created.id, { status: "stopped", summary: "Stale writer", expectedRevision: 2 }),
      /revision conflict/,
    );
  } finally {
    store.close();
  }
});

test("session transitions update editable configuration with the lifecycle aggregate", () => {
  const store = new HoneycrispSessionStore({ databasePath: ":memory:" });
  try {
    const created = store.create({
      id: "session_configuration",
      workspaceId: "workspace_one",
      attemptId: "attempt_configuration",
      title: "Editable session",
      prompt: "Inspect the parser.",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      workflowId: "discovery",
    });
    const updated = store.transition(created.id, {
      status: created.status,
      summary: created.summary,
      configuration: {
        prompt: "Review the parser and its callers.",
        provider: "anthropic",
        model: "claude-opus-4-1",
        reasoningEffort: "medium",
        workflowId: "chaining",
      },
    });

    assert.equal(updated.prompt, "Review the parser and its callers.");
    assert.equal(updated.provider, "anthropic");
    assert.equal(updated.model, "claude-opus-4-1");
    assert.equal(updated.reasoningEffort, "medium");
    assert.equal(updated.workflowId, "chaining");
  } finally {
    store.close();
  }
});

test("session recovery atomically pauses interrupted workspace sessions and their active attempts", () => {
  const store = new HoneycrispSessionStore({ databasePath: ":memory:" });
  try {
    store.create({
      id: "session_interrupted",
      workspaceId: "workspace_recovery",
      attemptId: "attempt_interrupted",
      title: "Interrupted session",
      prompt: "Inspect recovery.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    store.create({
      id: "session_other_workspace",
      workspaceId: "workspace_other",
      attemptId: "attempt_other_workspace",
      title: "Other workspace",
      prompt: "Remain active.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    const report = store.recoverInterrupted("workspace_recovery", {
      reason: "app_restart",
      at: "2026-08-16T12:00:00.000Z",
    });

    assert.deepEqual(report, {
      workspaceId: "workspace_recovery",
      recoveredAt: "2026-08-16T12:00:00.000Z",
      reason: "app_restart",
      interruptedSessions: 1,
      interruptedAttempts: 1,
      sessionIds: ["session_interrupted"],
    });
    const recovered = store.get("session_interrupted");
    assert.equal(recovered?.status, "paused");
    assert.equal(recovered?.attempts[0]?.status, "paused");
    assert.equal(recovered?.endedAt, null);
    assert.equal(recovered?.metadata.interruptedByRecovery, true);
    assert.equal(recovered?.metadata.recoveredAt, "2026-08-16T12:00:00.000Z");
    assert.equal(recovered?.events.at(-1)?.kind, "session.recovery");
    assert.equal(recovered?.events.at(-1)?.payload.interruptedByRecovery, true);
    assert.equal(store.get("session_other_workspace")?.status, "active");
    assert.equal(store.recoverInterrupted("workspace_recovery").interruptedSessions, 0);
  } finally {
    store.close();
  }
});

test("session summary lists stay bounded when canonical sessions contain large event histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-summary-"));
  const databasePath = join(directory, "memory.sqlite");
  const store = new HoneycrispSessionStore({ databasePath });
  try {
    store.create({
      id: "session_large_history",
      workspaceId: "workspace_summary",
      attemptId: "attempt_large_history",
      title: "Large history",
      prompt: "Keep list DTOs bounded.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    store.appendEvent("session_large_history", {
      id: "event_large_history",
      kind: "agent.event",
      timestamp: "2026-08-16T12:00:00.000Z",
      summary: "Large event",
      payload: { output: "x".repeat(2 * 1024 * 1024) },
    });
    store.appendEvent("session_large_history", {
      id: "event_token_usage",
      kind: "beale.model_session_update",
      timestamp: "2026-08-16T12:01:00.000Z",
      summary: "Model session usage updated.",
      payload: {
        record: {
          patch: { metadata: { latestReportedTotalTokens: 12_345 } },
        },
      },
    });
    store.create({
      id: "session_other_summary_workspace",
      workspaceId: "workspace_other_summary",
      attemptId: "attempt_other_summary_workspace",
      title: "Other workspace",
      prompt: "Batch workspace catalogs.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  } finally {
    store.close();
  }

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const stored = inspection.prepare(`
      SELECT document_json, document_hash FROM honeycrisp_sessions WHERE id = ?
    `).get("session_large_history");
    const document = JSON.parse(stored.document_json);
    assert.deepEqual(document.events, []);
    assert.ok(stored.document_json.length < 10_000);
    assert.equal(
      stored.document_hash,
      createHash("sha256").update(stored.document_json).digest("hex"),
    );
    const event = inspection.prepare(`
      SELECT event_json, content_hash FROM honeycrisp_session_events WHERE session_id = ?
    `).get("session_large_history");
    assert.equal(
      event.content_hash,
      createHash("sha256").update(event.event_json).digest("hex"),
    );
    assert.ok(event.event_json.length > 2 * 1024 * 1024);
  } finally {
    inspection.close();
  }

  const listed = runCli(
    ["session", "list-summaries", "--workspace-id", "workspace_summary", "--json"],
    { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath },
  );
  assert.equal(listed.operation, "session.list_summaries");
  assert.equal(listed.result[0].id, "session_large_history");
  assert.equal(Object.hasOwn(listed.result[0], "events"), false);
  assert.equal(Object.hasOwn(listed.result[0], "finalResponse"), false);
  assert.equal(Object.hasOwn(listed.result[0].attempts[0], "capture"), false);
  assert.deepEqual(listed.result[0].tokenUsage, { totalTokens: 12_345 });

  const batched = runCli(
    [
      "session", "list-summaries",
      "--workspace-id", "workspace_summary",
      "--workspace-id", "workspace_other_summary",
      "--json",
    ],
    { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath },
  );
  assert.deepEqual(
    new Set(batched.result.map((session) => session.id)),
    new Set(["session_large_history", "session_other_summary_workspace"]),
  );
});

test("session migration transactionally normalizes legacy embedded event histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-migration-"));
  const databasePath = join(directory, "memory.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE honeycrisp_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      document_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const timestamp = "2026-08-16T12:00:00.000Z";
  const legacyDocument = {
    schemaVersion: 1,
    id: "session_legacy",
    workspaceId: "workspace_legacy",
    status: "active",
    title: "Legacy session",
    prompt: "Migrate safely.",
    summary: "Legacy session",
    provider: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    workflowId: null,
    profile: null,
    metadata: {},
    finalDisposition: null,
    finalResponse: null,
    attempts: [{
      id: "attempt_legacy",
      parentAttemptId: null,
      status: "active",
      summary: "Legacy attempt",
      startedAt: timestamp,
      endedAt: null,
      capture: {
        attemptId: "attempt_legacy",
        capturedAt: timestamp,
        schemaVersion: 5,
        request: {},
        agent: {},
        raw: { retained: true },
      },
      metadata: {},
    }],
    events: [{
      id: "event_legacy",
      kind: "agent.event",
      timestamp,
      summary: "Legacy event",
      payload: { retained: true },
    }],
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: null,
    updatedAt: timestamp,
    revision: 2,
  };
  legacy.prepare(`
    INSERT INTO honeycrisp_sessions (
      id, workspace_id, status, title, summary, document_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    legacyDocument.id,
    legacyDocument.workspaceId,
    legacyDocument.status,
    legacyDocument.title,
    legacyDocument.summary,
    JSON.stringify(legacyDocument),
    legacyDocument.revision,
    timestamp,
    timestamp,
  );
  legacy.close();

  const migrated = new HoneycrispSessionStore({ databasePath });
  try {
    assert.deepEqual(migrated.get("session_legacy")?.events, legacyDocument.events);
    assert.deepEqual(migrated.get("session_legacy")?.attempts[0].capture, legacyDocument.attempts[0].capture);
  } finally {
    migrated.close();
  }

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = inspection.prepare(`
      SELECT document_json, document_hash FROM honeycrisp_sessions WHERE id = ?
    `).get("session_legacy");
    assert.deepEqual(JSON.parse(row.document_json).events, []);
    assert.equal(JSON.parse(row.document_json).attempts[0].capture, null);
    assert.equal(typeof row.document_hash, "string");
    assert.deepEqual(
      inspection.prepare(`
        SELECT event_id, event_offset FROM honeycrisp_session_events WHERE session_id = ?
      `).all("session_legacy").map((event) => ({ ...event })),
      [{ event_id: "event_legacy", event_offset: 0 }],
    );
    assert.deepEqual(
      inspection.prepare(`
        SELECT attempt_id FROM honeycrisp_session_captures WHERE session_id = ?
      `).all("session_legacy").map((capture) => ({ ...capture })),
      [{ attempt_id: "attempt_legacy" }],
    );
  } finally {
    inspection.close();
  }
});

test("session CLI reports actionable integrity and database corruption failures", async () => {
  const integrityDirectory = await mkdtemp(join(tmpdir(), "honeycrisp-session-integrity-"));
  const integrityDatabasePath = join(integrityDirectory, "memory.sqlite");
  const store = new HoneycrispSessionStore({ databasePath: integrityDatabasePath });
  store.create({
    id: "session_integrity",
    workspaceId: "workspace_integrity",
    attemptId: "attempt_integrity",
    title: "Integrity session",
    prompt: "Detect corruption.",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  store.appendEventReceipt("session_integrity", {
    id: "event_integrity",
    kind: "agent.event",
    timestamp: "2026-08-16T12:00:00.000Z",
    summary: "Integrity event",
    payload: { retained: true },
  });
  store.close();
  const tamper = new DatabaseSync(integrityDatabasePath);
  tamper.prepare(`
    UPDATE honeycrisp_session_events SET event_json = ? WHERE session_id = ?
  `).run(JSON.stringify({
    id: "event_integrity",
    kind: "agent.event",
    timestamp: "2026-08-16T12:00:00.000Z",
    summary: "Tampered event",
    payload: null,
  }), "session_integrity");
  tamper.close();

  const integrityFailure = runCliFailure(
    ["session", "get", "--session-id", "session_integrity", "--json"],
    { ...process.env, HONEYCRISP_DATABASE_PATH: integrityDatabasePath },
  );
  assert.equal(integrityFailure.error.code, "session_integrity_failed");
  assert.match(integrityFailure.error.message, /preserve the database/iu);

  const corruptDirectory = await mkdtemp(join(tmpdir(), "honeycrisp-database-corrupt-"));
  const corruptDatabasePath = join(corruptDirectory, "memory.sqlite");
  await writeFile(corruptDatabasePath, "not a sqlite database");
  const corruptionFailure = runCliFailure(
    ["session", "get", "--session-id", "session_corrupt", "--json"],
    { ...process.env, HONEYCRISP_DATABASE_PATH: corruptDatabasePath },
  );
  assert.equal(corruptionFailure.error.code, "database_corrupt");
  assert.match(corruptionFailure.error.message, /restore a verified backup or run SQLite recovery/iu);
});

test("session cursor updates omit prior events and capture bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-update-"));
  const databasePath = join(directory, "memory.sqlite");
  const store = new HoneycrispSessionStore({ databasePath });
  try {
    store.create({
      id: "session_update",
      workspaceId: "workspace_update",
      attemptId: "attempt_update",
      title: "Cursor update",
      prompt: "Return only new events.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    store.appendEvent("session_update", {
      id: "event_before_cursor",
      kind: "agent.event",
      timestamp: "2026-08-16T12:00:00.000Z",
      summary: "Before cursor",
      payload: { output: "x".repeat(2 * 1024 * 1024) },
    });
    store.appendEvent("session_update", {
      id: "event_after_cursor",
      kind: "agent.event",
      timestamp: "2026-08-16T12:01:00.000Z",
      summary: "After cursor",
      payload: { output: "bounded" },
    });
  } finally {
    store.close();
  }

  const updated = runCli(
    ["session", "get-update", "--session-id", "session_update", "--after-event-id", "event_before_cursor", "--json"],
    { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath },
  );
  assert.equal(updated.operation, "session.get_update");
  assert.deepEqual(updated.result.events.map((event) => event.id), ["event_after_cursor"]);
  assert.equal(updated.result.eventOffset, 1);
  assert.equal(Object.hasOwn(updated.result.session, "events"), false);
  assert.equal(Object.hasOwn(updated.result.session.attempts[0], "capture"), false);
  assert.ok(JSON.stringify(updated).length < 20_000);

  const appendPath = join(directory, "append.json");
  await writeFile(appendPath, JSON.stringify({
    id: "event_receipt",
    kind: "agent.event",
    timestamp: "2026-08-16T12:02:00.000Z",
    summary: "Compact append response",
    payload: { output: "receipt" },
  }));
  const appended = runCli([
    "session", "append-event-receipt", "--session-id", "session_update", "--input", appendPath, "--json",
  ], { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath });
  assert.equal(appended.operation, "session.append_event_receipt");
  assert.equal(appended.result.sessionId, "session_update");
  assert.equal(appended.result.revision, 4);
  assert.ok(JSON.stringify(appended).length < 1_000);
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

test("session CLI reads remain available while the runtime holds a write transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-read-lock-"));
  const databasePath = join(directory, "memory.sqlite");
  const store = new HoneycrispSessionStore({ databasePath });
  store.create({
    id: "session_read_lock",
    workspaceId: "workspace_lock",
    attemptId: "attempt_read_lock",
    title: "Readable session",
    prompt: "Read while writing.",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  store.close();

  const writer = new DatabaseSync(databasePath);
  writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
  writer.prepare("UPDATE honeycrisp_sessions SET summary = summary WHERE id = ?").run("session_read_lock");
  try {
    const queried = runCli(
      ["session", "get", "--session-id", "session_read_lock", "--json"],
      { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath },
    );
    assert.equal(queried.ok, true);
    assert.equal(queried.result.id, "session_read_lock");
  } finally {
    writer.exec("ROLLBACK;");
    writer.close();
  }
});

test("session CLI writers wait for a short competing writer instead of returning database locked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-session-write-lock-"));
  const databasePath = join(directory, "memory.sqlite");
  const inputPath = join(directory, "event.json");
  const store = new HoneycrispSessionStore({ databasePath });
  store.create({
    id: "session_write_lock",
    workspaceId: "workspace_lock",
    attemptId: "attempt_write_lock",
    title: "Writable session",
    prompt: "Wait for the writer.",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  store.close();
  await writeFile(inputPath, JSON.stringify({
    id: "event_after_lock",
    kind: "agent.event",
    timestamp: "2026-08-16T12:00:00.000Z",
    summary: "Writer resumed.",
    payload: { eventType: "resumed" },
  }));

  const lockHolder = spawn(process.execPath, [
    "-e",
    "const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1]); database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;'); process.stdout.write('locked\\n'); setTimeout(() => { database.exec('ROLLBACK;'); database.close(); }, 250);",
    databasePath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const lockClosed = once(lockHolder, "close");
  await once(lockHolder.stdout, "data");
  const appended = runCli([
    "session", "append-event-receipt",
    "--session-id", "session_write_lock",
    "--input", inputPath,
    "--json",
  ], { ...process.env, HONEYCRISP_DATABASE_PATH: databasePath });
  assert.equal(appended.ok, true);
  assert.equal(appended.result.sessionId, "session_write_lock");
  assert.equal(appended.result.status, "active");
  assert.equal(appended.result.revision, 2);
  assert.equal(Object.hasOwn(appended.result, "events"), false);
  await lockClosed;
});

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return decodeHoneycrispProtocolEnvelope(JSON.parse(result.stdout));
}

function runCliFailure(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const envelope = decodeHoneycrispProtocolEnvelope(JSON.parse(result.stdout));
  assert.equal(envelope.ok, false);
  return envelope;
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
