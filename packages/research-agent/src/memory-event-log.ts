import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  resolve,
} from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  isResearchEventId,
  normalizeResearchEventSequence,
} from "./ids.js";
import {
  isAcceptedRawEventKind,
  routeEventsToMemorySnapshot,
} from "./memory-routing.js";
import type {
  ResearchArtifactRef,
  ResearchEvent,
  ResearchEventSequence,
  ResearchMemorySnapshot,
} from "./types.js";

const CURRENT_EVENT_SCHEMA_VERSION = 1;
const DEFAULT_DATABASE_RELATIVE_PATH = ".honeycrisp/memory/memory.sqlite";
const DEFAULT_ARTIFACT_RELATIVE_PATH = ".honeycrisp/memory/artifacts";

const require = createRequire(import.meta.url);

export interface MemoryEventSequenceRange {
  fromSequence?: ResearchEventSequence;
  toSequence?: ResearchEventSequence;
  limit?: number;
}

export type MemoryEventRejectionHook = (
  event: ResearchEvent,
) => string | undefined;

export interface MemoryEventLog {
  append(event: ResearchEvent): ResearchEvent;
  appendMany(events: readonly ResearchEvent[]): readonly ResearchEvent[];
  getById(eventId: string): ResearchEvent | undefined;
  listBySequenceRange(range?: MemoryEventSequenceRange): readonly ResearchEvent[];
  listByGoalId(goalId: string): readonly ResearchEvent[];
  listByLoopId(loopId: string): readonly ResearchEvent[];
  listBySubGoalId(subGoalId: string): readonly ResearchEvent[];
  listByKind(kind: ResearchEvent["kind"]): readonly ResearchEvent[];
  listAll(): readonly ResearchEvent[];
  close(): void;
}

export interface SqliteMemoryEventLogOptions {
  workspaceRoot?: string;
  databasePath?: string;
  artifactDirectoryPath?: string;
  rejectionHooks?: readonly MemoryEventRejectionHook[];
}

interface NormalizedMemoryEvent {
  event: ResearchEvent;
  payloadJson: string;
  artifactRefsJson: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function createSqliteMemoryEventLog(
  options: SqliteMemoryEventLogOptions = {},
): SqliteMemoryEventLog {
  return new SqliteMemoryEventLog(options);
}

export function getDefaultMemoryDatabasePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_DATABASE_RELATIVE_PATH);
}

export function getDefaultMemoryArtifactDirectoryPath(
  workspaceRoot: string,
): string {
  return resolve(workspaceRoot, DEFAULT_ARTIFACT_RELATIVE_PATH);
}

export function createMemorySnapshotFromEventLog(
  eventLog: MemoryEventLog,
  base?: Partial<ResearchMemorySnapshot>,
): ResearchMemorySnapshot {
  return routeEventsToMemorySnapshot(eventLog.listAll(), base);
}

export function validateMemoryEventForAppend(
  event: ResearchEvent,
  rejectionHooks: readonly MemoryEventRejectionHook[] = [],
): void {
  if (!isResearchEventId(event.id)) {
    throw new Error(`Memory event id must use canonical evt UUID format: ${event.id}`);
  }
  if (!isAcceptedRawEventKind(event.kind)) {
    throw new Error(`Unsupported memory event kind: ${String(event.kind)}`);
  }
  if (!isIsoTimestamp(event.timestamp)) {
    throw new Error(`Memory event timestamp must be an ISO timestamp: ${event.id}`);
  }
  validateOptionalString(event.goalId, "goalId", event.id);
  validateOptionalString(event.loopId, "loopId", event.id);
  validateOptionalString(event.subGoalId, "subGoalId", event.id);

  const schemaVersion =
    event.schemaVersion ?? CURRENT_EVENT_SCHEMA_VERSION;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`Memory event schemaVersion must be a positive integer: ${event.id}`);
  }

  const privateThoughtPath = findPrivateThoughtLikeData(event.payload);
  if (privateThoughtPath) {
    throw new Error(
      `Memory event payload appears to contain private thought-like data at ${privateThoughtPath}`,
    );
  }

  normalizePayload(event.payload, "payload");
  normalizeArtifactRefs(event.artifactRefs ?? [], event.id);

  for (const hook of rejectionHooks) {
    const reason = hook(event);
    if (reason) {
      throw new Error(`Memory event rejected by hook: ${reason}`);
    }
  }
}

export function computeMemoryEventPayloadHash(payload: unknown): string {
  const payloadJson = stableJsonStringify(normalizePayload(payload, "payload"));

  return createHash("sha256").update(payloadJson).digest("hex");
}

export class SqliteMemoryEventLog implements MemoryEventLog {
  readonly databasePath: string;
  readonly artifactDirectoryPath: string;

  private readonly database: DatabaseSync;
  private readonly rejectionHooks: readonly MemoryEventRejectionHook[];

  constructor(options: SqliteMemoryEventLogOptions = {}) {
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.databasePath =
      options.databasePath ?? getDefaultMemoryDatabasePath(workspaceRoot);
    this.artifactDirectoryPath =
      options.artifactDirectoryPath ??
      getDefaultMemoryArtifactDirectoryPath(workspaceRoot);
    this.rejectionHooks = options.rejectionHooks ?? [];

    ensureMemoryDirectories(this.databasePath, this.artifactDirectoryPath);

    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };
    this.database = new DatabaseSync(this.databasePath);
    this.initializeSchema();
  }

  append(event: ResearchEvent): ResearchEvent {
    return this.appendMany([event])[0] as ResearchEvent;
  }

  appendMany(events: readonly ResearchEvent[]): readonly ResearchEvent[] {
    if (events.length === 0) {
      return [];
    }

    return this.withTransaction(() => {
      const appended: ResearchEvent[] = [];
      const incomingIds = new Set<string>();

      for (const event of events) {
        if (incomingIds.has(event.id)) {
          throw new Error(`Duplicate memory event id in append batch: ${event.id}`);
        }
        incomingIds.add(event.id);
        if (this.getById(event.id)) {
          throw new Error(`Memory event already exists: ${event.id}`);
        }

        const sequence = this.nextSequence();
        const normalized = normalizeEventForInsert(
          event,
          sequence,
          this.rejectionHooks,
        );
        this.insertEvent(normalized);
        appended.push(normalized.event);
      }

      return appended;
    });
  }

  getById(eventId: string): ResearchEvent | undefined {
    const row = this.database
      .prepare(
        [
          "SELECT sequence, event_id, timestamp, kind, goal_id, loop_id, sub_goal_id,",
          "payload_json, payload_hash, artifact_refs_json, schema_version",
          "FROM memory_events WHERE event_id = ?",
        ].join(" "),
      )
      .get(eventId);

    return row ? rowToEvent(row) : undefined;
  }

  listBySequenceRange(
    range: MemoryEventSequenceRange = {},
  ): readonly ResearchEvent[] {
    const clauses: string[] = [];
    const params: (number | string)[] = [];

    if (range.fromSequence !== undefined) {
      clauses.push("sequence >= ?");
      params.push(normalizeResearchEventSequence(range.fromSequence));
    }
    if (range.toSequence !== undefined) {
      clauses.push("sequence <= ?");
      params.push(normalizeResearchEventSequence(range.toSequence));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit =
      range.limit === undefined
        ? ""
        : ` LIMIT ${normalizePositiveLimit(range.limit)}`;
    const rows = this.database
      .prepare(
        [
          "SELECT sequence, event_id, timestamp, kind, goal_id, loop_id, sub_goal_id,",
          "payload_json, payload_hash, artifact_refs_json, schema_version",
          "FROM memory_events",
          where,
          "ORDER BY sequence ASC",
          limit,
        ].join(" "),
      )
      .all(...params);

    return rows.map(rowToEvent);
  }

  listByGoalId(goalId: string): readonly ResearchEvent[] {
    return this.listByColumn("goal_id", goalId);
  }

  listByLoopId(loopId: string): readonly ResearchEvent[] {
    return this.listByColumn("loop_id", loopId);
  }

  listBySubGoalId(subGoalId: string): readonly ResearchEvent[] {
    return this.listByColumn("sub_goal_id", subGoalId);
  }

  listByKind(kind: ResearchEvent["kind"]): readonly ResearchEvent[] {
    if (!isAcceptedRawEventKind(kind)) {
      throw new Error(`Unsupported memory event kind: ${String(kind)}`);
    }

    return this.listByColumn("kind", kind);
  }

  listAll(): readonly ResearchEvent[] {
    return this.listBySequenceRange();
  }

  close(): void {
    this.database.close();
  }

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS memory_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL,
        goal_id TEXT,
        loop_id TEXT,
        sub_goal_id TEXT,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        schema_version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_event_artifacts (
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        uri TEXT,
        summary TEXT,
        content_hash TEXT,
        artifact_ref_json TEXT NOT NULL,
        PRIMARY KEY (sequence, artifact_id),
        FOREIGN KEY (sequence) REFERENCES memory_events(sequence)
      );

      CREATE INDEX IF NOT EXISTS memory_events_event_id_idx ON memory_events(event_id);
      CREATE INDEX IF NOT EXISTS memory_events_goal_id_idx ON memory_events(goal_id);
      CREATE INDEX IF NOT EXISTS memory_events_loop_id_idx ON memory_events(loop_id);
      CREATE INDEX IF NOT EXISTS memory_events_sub_goal_id_idx ON memory_events(sub_goal_id);
      CREATE INDEX IF NOT EXISTS memory_events_kind_idx ON memory_events(kind);
      CREATE INDEX IF NOT EXISTS memory_events_timestamp_idx ON memory_events(timestamp);
      CREATE INDEX IF NOT EXISTS memory_event_artifacts_artifact_id_idx ON memory_event_artifacts(artifact_id);
      CREATE INDEX IF NOT EXISTS memory_event_artifacts_event_id_idx ON memory_event_artifacts(event_id);

      CREATE TRIGGER IF NOT EXISTS memory_events_no_update
      BEFORE UPDATE ON memory_events
      BEGIN
        SELECT RAISE(ABORT, 'memory_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS memory_events_no_delete
      BEFORE DELETE ON memory_events
      BEGIN
        SELECT RAISE(ABORT, 'memory_events is append-only');
      END;

      INSERT OR IGNORE INTO memory_schema_migrations(version, name, applied_at)
      VALUES (1, 'phase_2_event_log', datetime('now'));
    `);
  }

  private insertEvent(normalized: NormalizedMemoryEvent): void {
    const event = normalized.event;
    const sequence = event.sequence;
    if (sequence === undefined) {
      throw new Error(`Normalized memory event is missing sequence: ${event.id}`);
    }

    this.database
      .prepare(
        [
          "INSERT INTO memory_events (",
          "sequence, event_id, timestamp, kind, goal_id, loop_id, sub_goal_id,",
          "payload_json, payload_hash, artifact_refs_json, schema_version",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        sequence,
        event.id,
        event.timestamp,
        event.kind,
        event.goalId ?? null,
        event.loopId ?? null,
        event.subGoalId ?? null,
        normalized.payloadJson,
        event.payloadHash ?? computeMemoryEventPayloadHash(event.payload),
        normalized.artifactRefsJson,
        event.schemaVersion ?? CURRENT_EVENT_SCHEMA_VERSION,
      );

    for (const artifactRef of event.artifactRefs ?? []) {
      this.database
        .prepare(
          [
            "INSERT INTO memory_event_artifacts (",
            "sequence, event_id, artifact_id, kind, uri, summary, content_hash, artifact_ref_json",
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ].join(" "),
        )
        .run(
          sequence,
          event.id,
          artifactRef.id,
          artifactRef.kind,
          artifactRef.uri ?? null,
          artifactRef.summary ?? null,
          artifactRef.contentHash ?? null,
          stableJsonStringify(normalizeJsonValue(artifactRef, "artifactRef")),
        );
    }
  }

  private listByColumn(column: string, value: string): readonly ResearchEvent[] {
    if (value.trim().length === 0) {
      throw new Error(`Memory event ${column} query requires a non-empty value.`);
    }

    const rows = this.database
      .prepare(
        [
          "SELECT sequence, event_id, timestamp, kind, goal_id, loop_id, sub_goal_id,",
          "payload_json, payload_hash, artifact_refs_json, schema_version",
          `FROM memory_events WHERE ${column} = ? ORDER BY sequence ASC`,
        ].join(" "),
      )
      .all(value);

    return rows.map(rowToEvent);
  }

  private nextSequence(): ResearchEventSequence {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM memory_events")
      .get();
    const value = row?.next_sequence;

    if (typeof value !== "number") {
      throw new Error("Could not compute next memory event sequence.");
    }

    return normalizeResearchEventSequence(value);
  }

  private withTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");

      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if rollback itself fails.
      }
      throw error;
    }
  }
}

function normalizeEventForInsert(
  event: ResearchEvent,
  sequence: ResearchEventSequence,
  rejectionHooks: readonly MemoryEventRejectionHook[],
): NormalizedMemoryEvent {
  validateMemoryEventForAppend(event, rejectionHooks);

  const normalizedPayload = normalizePayload(event.payload, "payload");
  const payloadJson = stableJsonStringify(normalizedPayload);
  const payloadHash = createHash("sha256").update(payloadJson).digest("hex");

  if (event.payloadHash && event.payloadHash !== payloadHash) {
    throw new Error(`Memory event payloadHash does not match payload: ${event.id}`);
  }

  const artifactRefs = normalizeArtifactRefs(event.artifactRefs ?? [], event.id);
  const artifactRefsJson = stableJsonStringify(
    normalizeJsonValue(artifactRefs, "artifactRefs"),
  );
  const normalizedEvent: ResearchEvent = {
    id: event.id,
    sequence,
    kind: event.kind,
    timestamp: event.timestamp,
    payload: normalizedPayload,
    payloadHash,
    artifactRefs,
    schemaVersion: event.schemaVersion ?? CURRENT_EVENT_SCHEMA_VERSION,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.loopId ? { loopId: event.loopId } : {}),
    ...(event.subGoalId ? { subGoalId: event.subGoalId } : {}),
  };

  return {
    event: normalizedEvent,
    payloadJson,
    artifactRefsJson,
  };
}

function ensureMemoryDirectories(
  databasePath: string,
  artifactDirectoryPath: string,
): void {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  mkdirSync(artifactDirectoryPath, { recursive: true });
}

function rowToEvent(row: Record<string, unknown>): ResearchEvent {
  const kind = readString(row, "kind");
  if (!isAcceptedRawEventKind(kind)) {
    throw new Error(`Stored memory event has unsupported kind: ${kind}`);
  }

  const sequence = normalizeResearchEventSequence(readNumber(row, "sequence"));
  const artifactRefs = parseArtifactRefs(row, "artifact_refs_json");
  const event: ResearchEvent = {
    id: readString(row, "event_id"),
    sequence,
    kind,
    timestamp: readString(row, "timestamp"),
    payload: parseJson(row, "payload_json"),
    payloadHash: readString(row, "payload_hash"),
    artifactRefs,
    schemaVersion: readNumber(row, "schema_version"),
  };
  const goalId = readNullableString(row, "goal_id");
  const loopId = readNullableString(row, "loop_id");
  const subGoalId = readNullableString(row, "sub_goal_id");

  return {
    ...event,
    ...(goalId ? { goalId } : {}),
    ...(loopId ? { loopId } : {}),
    ...(subGoalId ? { subGoalId } : {}),
  };
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string.`);
  }

  return value;
}

function readNullableString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string or null.`);
  }

  return value;
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected SQLite column ${key} to be a number.`);
  }

  return value;
}

function parseJson(row: Record<string, unknown>, key: string): JsonValue {
  return JSON.parse(readString(row, key)) as JsonValue;
}

function parseArtifactRefs(
  row: Record<string, unknown>,
  key: string,
): readonly ResearchArtifactRef[] {
  const value = JSON.parse(readString(row, key)) as unknown;
  if (!Array.isArray(value)) {
    throw new Error(`Expected SQLite column ${key} to contain an artifact ref array.`);
  }

  return normalizeArtifactRefs(value as readonly ResearchArtifactRef[], "stored event");
}

function validateOptionalString(
  value: string | undefined,
  field: string,
  eventId: string,
): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new Error(`Memory event ${field} must be non-empty when present: ${eventId}`);
  }
}

function isIsoTimestamp(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function normalizePayload(value: unknown, path: string): JsonValue {
  if (!isPlainRecord(value)) {
    throw new Error(`Memory event ${path} must be a JSON object.`);
  }

  return normalizeJsonValue(value, path);
}

function normalizeArtifactRefs(
  artifactRefs: readonly ResearchArtifactRef[],
  eventId: string,
): readonly ResearchArtifactRef[] {
  if (!Array.isArray(artifactRefs)) {
    throw new Error(`Memory event artifactRefs must be an array: ${eventId}`);
  }

  return artifactRefs.map((ref, index) => {
    if (!isPlainRecord(ref)) {
      throw new Error(`Memory event artifactRefs[${index}] must be an object: ${eventId}`);
    }
    if (typeof ref.id !== "string" || ref.id.trim().length === 0) {
      throw new Error(`Memory event artifactRefs[${index}].id is required: ${eventId}`);
    }
    if (typeof ref.kind !== "string" || ref.kind.trim().length === 0) {
      throw new Error(`Memory event artifactRefs[${index}].kind is required: ${eventId}`);
    }

    const normalized: ResearchArtifactRef = {
      id: ref.id,
      kind: ref.kind,
      ...(typeof ref.uri === "string" ? { uri: ref.uri } : {}),
      ...(typeof ref.summary === "string" ? { summary: ref.summary } : {}),
      ...(typeof ref.contentHash === "string"
        ? { contentHash: ref.contentHash }
        : {}),
    };

    normalizeJsonValue(normalized, `artifactRefs[${index}]`);

    return normalized;
  });
}

function normalizeJsonValue(value: unknown, path: string): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Memory event ${path} must contain only finite numbers.`);
    }

    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeJsonValue(item, `${path}[${index}]`),
    );
  }
  if (isPlainRecord(value)) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) {
        throw new Error(`Memory event ${path}.${key} cannot be undefined.`);
      }
      normalized[key] = normalizeJsonValue(item, `${path}.${key}`);
    }

    return normalized;
  }

  throw new Error(`Memory event ${path} contains a non-JSON value.`);
}

function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function findPrivateThoughtLikeData(
  value: unknown,
  path = "payload",
): string | undefined {
  if (typeof value === "string") {
    return /private[-_\s]?thought|chain[-_\s]?of[-_\s]?thought|hidden[-_\s]?reasoning|internal[-_\s]?scratchpad/i.test(
      value,
    )
      ? path
      : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPrivateThoughtLikeData(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateThoughtLikeKey(key)) {
        return `${path}.${key}`;
      }
      const found = findPrivateThoughtLikeData(item, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function isPrivateThoughtLikeKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();

  return (
    normalized === "privatethought" ||
    normalized === "privatethoughts" ||
    normalized === "chainofthought" ||
    normalized === "hiddenreasoning" ||
    normalized === "internalthought" ||
    normalized === "internalthoughts" ||
    normalized === "internalscratchpad" ||
    normalized === "scratchpad"
  );
}

function normalizePositiveLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Memory event sequence range limit must be a positive safe integer.");
  }

  return limit;
}
