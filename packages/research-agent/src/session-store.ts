import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyDatabaseMigrations } from "./database-migrations.js";
import { getDefaultMemoryDatabasePath } from "./storage.js";

export const HONEYCRISP_SESSION_SCHEMA_VERSION = 1 as const;

export type HoneycrispSessionStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "stopped";

export interface HoneycrispSessionDisposition {
  outcome: string;
  summary: string;
  externalStateRequired: boolean;
  blockerDependencies: readonly unknown[];
  recordedAt?: string;
  [key: string]: unknown;
}

export interface HoneycrispSessionEvent {
  id: string;
  kind: string;
  timestamp: string;
  summary: string;
  payload: unknown;
  agentId?: string;
  agentPath?: string;
  parentAgentId?: string;
}

export interface HoneycrispSessionCapture {
  attemptId: string;
  capturedAt: string;
  schemaVersion: number;
  eventStreams: {
    timeline: HoneycrispSessionCaptureEventReference;
    agentDiagnostics: HoneycrispSessionCaptureEventReference;
  };
  raw: Record<string, unknown>;
}

export interface HoneycrispSessionCaptureEventReference {
  source: "honeycrisp_session_events";
  sessionId: string;
  attemptId: string;
  count: number;
}

export interface HoneycrispSessionCaptureSummary {
  attemptId: string;
  capturedAt: string;
  schemaVersion: number;
  sizeBytes: number;
  contentHash: string;
  eventStreams: HoneycrispSessionCapture["eventStreams"];
}

export interface HoneycrispSessionAttempt {
  id: string;
  parentAttemptId: string | null;
  status: HoneycrispSessionStatus;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  capture: HoneycrispSessionCapture | null;
  metadata: Record<string, unknown>;
}

export interface HoneycrispSessionRecord {
  schemaVersion: typeof HONEYCRISP_SESSION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  status: HoneycrispSessionStatus;
  title: string;
  prompt: string;
  summary: string;
  provider: string | null;
  model: string;
  reasoningEffort: string;
  workflowId: string | null;
  profile: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  finalDisposition: HoneycrispSessionDisposition | null;
  finalResponse: string | null;
  attempts: HoneycrispSessionAttempt[];
  events: HoneycrispSessionEvent[];
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  revision: number;
}

export type HoneycrispSessionAttemptSummary = Omit<HoneycrispSessionAttempt, "capture">;

export type HoneycrispSessionSummary = Omit<
  HoneycrispSessionRecord,
  "attempts" | "events" | "finalResponse"
> & {
  attempts: HoneycrispSessionAttemptSummary[];
  tokenUsage: { totalTokens: number };
};

export interface HoneycrispSessionUpdate {
  session: HoneycrispSessionSummary;
  finalResponse: string | null;
  events: HoneycrispSessionEvent[];
  eventOffset: number;
  nextAfterEventId: string | null;
  hasEarlier: boolean;
  hasMore: boolean;
}

export type HoneycrispSessionEventStream = "all" | "transcript" | "trace";

export interface HoneycrispSessionEventPageInput {
  afterEventId?: string | null;
  limit?: number;
  maxBytes?: number;
  tail?: boolean;
  stream?: HoneycrispSessionEventStream;
}

export interface HoneycrispSessionEventPage {
  sessionId: string;
  stream: HoneycrispSessionEventStream;
  events: HoneycrispSessionEvent[];
  eventOffset: number;
  nextAfterEventId: string | null;
  hasEarlier: boolean;
  hasMore: boolean;
}

export interface HoneycrispSessionCollaborationState {
  sessionId: string;
  revision: number;
  rooms: HoneycrispSessionEvent[];
  members: HoneycrispSessionEvent[];
  messages: HoneycrispSessionEvent[];
}

export interface HoneycrispSessionMutationReceipt {
  sessionId: string;
  status: HoneycrispSessionStatus;
  revision: number;
  updatedAt: string;
}

export interface CreateHoneycrispSessionInput {
  id: string;
  workspaceId: string;
  attemptId: string;
  title: string;
  prompt: string;
  provider?: string | null;
  model: string;
  reasoningEffort: string;
  workflowId?: string | null;
  profile?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  attemptMetadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface HoneycrispSessionTransitionInput {
  status: HoneycrispSessionStatus;
  summary: string;
  attemptId?: string;
  expectedRevision?: number;
  disposition?: HoneycrispSessionDisposition | null;
  metadata?: Record<string, unknown>;
  configuration?: {
    prompt?: string;
    provider?: string | null;
    model?: string;
    reasoningEffort?: string;
    workflowId?: string | null;
  };
  at?: string;
}

export interface RecoverInterruptedHoneycrispSessionsInput {
  reason?: string;
  at?: string;
}

export interface HoneycrispSessionRecoveryReport {
  workspaceId: string;
  recoveredAt: string;
  reason: string;
  interruptedSessions: number;
  interruptedAttempts: number;
  sessionIds: string[];
}

export interface ImportHoneycrispSessionCaptureInput {
  attemptId: string;
  capture: unknown;
  expectedRevision?: number;
}

export interface BeginHoneycrispSessionAttemptInput {
  attemptId: string;
  parentAttemptId?: string | null;
  summary: string;
  expectedRevision?: number;
  startedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface HoneycrispSessionStoreOptions {
  databasePath?: string;
  workspaceRoot?: string;
  readOnly?: boolean;
}

interface StoredSessionRow {
  document_json?: unknown;
  document_hash?: unknown;
}

interface StoredSessionEventRow {
  event_json?: unknown;
  content_hash?: unknown;
}

interface StoredSessionCaptureRow {
  attempt_id?: unknown;
  capture_json?: unknown;
  content_hash?: unknown;
}

const HONEYCRISP_SESSION_MIGRATIONS = [
  {
    version: 1,
    name: "create_session_aggregates",
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS honeycrisp_sessions (
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
        CREATE INDEX IF NOT EXISTS honeycrisp_sessions_workspace_updated
        ON honeycrisp_sessions(workspace_id, updated_at DESC, id DESC);
      `);
    },
  },
  {
    version: 2,
    name: "normalize_session_event_streams",
    up(database: DatabaseSync): void {
      if (!columnExists(database, "honeycrisp_sessions", "document_hash")) {
        database.exec("ALTER TABLE honeycrisp_sessions ADD COLUMN document_hash TEXT;");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS honeycrisp_session_events (
          session_id TEXT NOT NULL REFERENCES honeycrisp_sessions(id) ON DELETE CASCADE,
          event_offset INTEGER NOT NULL CHECK (event_offset >= 0),
          event_id TEXT NOT NULL,
          event_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          PRIMARY KEY(session_id, event_offset),
          UNIQUE(session_id, event_id)
        );
      `);
      const rows = database.prepare(
        "SELECT id, document_json FROM honeycrisp_sessions ORDER BY created_at ASC, id ASC",
      ).all() as Array<{ id?: unknown; document_json?: unknown }>;
      const deleteEvents = database.prepare("DELETE FROM honeycrisp_session_events WHERE session_id = ?");
      const insertEvent = database.prepare(`
        INSERT INTO honeycrisp_session_events (
          session_id, event_offset, event_id, event_json, content_hash
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const updateDocument = database.prepare(`
        UPDATE honeycrisp_sessions SET document_json = ?, document_hash = ? WHERE id = ?
      `);
      for (const row of rows) {
        const sessionId = requiredStoredString(row.id, "Honeycrisp session id");
        const session = decodeStoredSession(row.document_json);
        if (session.events.length > 0) {
          deleteEvents.run(sessionId);
          for (const [offset, candidate] of session.events.entries()) {
            const event = normalizeEvent(candidate);
            const eventDocument = JSON.stringify(event);
            insertEvent.run(sessionId, offset, event.id, eventDocument, hashJson(eventDocument));
          }
        }
        const document = storedSessionDocument(session, false);
        updateDocument.run(document, hashJson(document), sessionId);
      }
    },
  },
  {
    version: 3,
    name: "normalize_session_captures",
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS honeycrisp_session_captures (
          session_id TEXT NOT NULL REFERENCES honeycrisp_sessions(id) ON DELETE CASCADE,
          attempt_id TEXT NOT NULL,
          capture_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          PRIMARY KEY(session_id, attempt_id)
        );
      `);
      const rows = database.prepare(
        "SELECT id, document_json FROM honeycrisp_sessions ORDER BY created_at ASC, id ASC",
      ).all() as Array<{ id?: unknown; document_json?: unknown }>;
      const upsertCapture = database.prepare(`
        INSERT INTO honeycrisp_session_captures (
          session_id, attempt_id, capture_json, content_hash
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, attempt_id) DO UPDATE SET
          capture_json = excluded.capture_json,
          content_hash = excluded.content_hash
      `);
      const updateDocument = database.prepare(`
        UPDATE honeycrisp_sessions SET document_json = ?, document_hash = ? WHERE id = ?
      `);
      for (const row of rows) {
        const sessionId = requiredStoredString(row.id, "Honeycrisp session id");
        const session = decodeStoredSession(row.document_json);
        for (const attempt of session.attempts) {
          if (!attempt.capture) continue;
          const document = JSON.stringify(attempt.capture);
          upsertCapture.run(sessionId, attempt.id, document, hashJson(document));
        }
        const document = storedSessionDocument(session);
        updateDocument.run(document, hashJson(document), sessionId);
      }
    },
  },
  {
    version: 4,
    name: "compact_session_capture_event_histories",
    up(database: DatabaseSync): void {
      const rows = database.prepare(`
        SELECT session_id, attempt_id, capture_json, content_hash
        FROM honeycrisp_session_captures
        ORDER BY session_id ASC, attempt_id ASC
      `).all() as Array<{
        session_id?: unknown;
        attempt_id?: unknown;
        capture_json?: unknown;
        content_hash?: unknown;
      }>;
      const update = database.prepare(`
        UPDATE honeycrisp_session_captures
        SET capture_json = ?, content_hash = ?
        WHERE session_id = ? AND attempt_id = ?
      `);
      for (const row of rows) {
        const sessionId = requiredStoredString(row.session_id, "Honeycrisp session capture session id");
        const attemptId = requiredStoredString(row.attempt_id, "Honeycrisp session capture attempt id");
        const document = requiredStoredString(row.capture_json, "Honeycrisp session capture");
        verifyJsonHash(document, row.content_hash, "Honeycrisp session capture");
        const compacted = compactStoredCapture(JSON.parse(document) as unknown, sessionId, attemptId);
        const compactedDocument = JSON.stringify(compacted);
        update.run(compactedDocument, hashJson(compactedDocument), sessionId, attemptId);
      }
    },
  },
] as const;

export class HoneycrispSessionStore {
  public readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly normalizedEventStorage: boolean;
  private readonly normalizedCaptureStorage: boolean;
  private readonly sessionDocumentHashes: boolean;

  public constructor(options: HoneycrispSessionStoreOptions = {}) {
    this.databasePath = options.databasePath
      ?? process.env.HONEYCRISP_DATABASE_PATH?.trim()
      ?? getDefaultMemoryDatabasePath(options.workspaceRoot ?? process.cwd());
    const readOnly = options.readOnly === true
      && this.databasePath !== ":memory:"
      && existsSync(this.databasePath);
    if (readOnly) {
      const readDatabase = new DatabaseSync(this.databasePath, { readOnly: true });
      readDatabase.exec("PRAGMA busy_timeout = 5000;");
      readDatabase.exec("PRAGMA foreign_keys = ON;");
      const schema = readDatabase.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_sessions'",
      ).get() as { present?: unknown } | undefined;
      if (schema?.present === 1) {
        this.database = readDatabase;
        this.normalizedEventStorage = tableExists(readDatabase, "honeycrisp_session_events");
        this.normalizedCaptureStorage = tableExists(readDatabase, "honeycrisp_session_captures");
        this.sessionDocumentHashes = columnExists(readDatabase, "honeycrisp_sessions", "document_hash");
        return;
      }
      readDatabase.close();
    }
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    if (this.databasePath !== ":memory:") chmodSync(this.databasePath, 0o600);
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec("PRAGMA journal_mode = WAL;");
    applyDatabaseMigrations(this.database, "honeycrisp_sessions", HONEYCRISP_SESSION_MIGRATIONS);
    this.normalizedEventStorage = true;
    this.normalizedCaptureStorage = true;
    this.sessionDocumentHashes = true;
  }

  public close(): void {
    this.database.close();
  }

  public create(input: CreateHoneycrispSessionInput): HoneycrispSessionRecord {
    const now = input.createdAt ?? new Date().toISOString();
    const record: HoneycrispSessionRecord = {
      schemaVersion: HONEYCRISP_SESSION_SCHEMA_VERSION,
      id: requiredString(input.id, "Session id"),
      workspaceId: requiredString(input.workspaceId, "Workspace id"),
      status: "active",
      title: requiredString(input.title, "Session title"),
      prompt: requiredString(input.prompt, "Session prompt"),
      summary: "Honeycrisp research session started.",
      provider: optionalString(input.provider),
      model: requiredString(input.model, "Session model"),
      reasoningEffort: requiredString(input.reasoningEffort, "Session reasoning effort"),
      workflowId: optionalString(input.workflowId),
      profile: input.profile ?? null,
      metadata: input.metadata ?? {},
      finalDisposition: null,
      finalResponse: null,
      attempts: [{
        id: requiredString(input.attemptId, "Attempt id"),
        parentAttemptId: null,
        status: "active",
        summary: "Honeycrisp research attempt started.",
        startedAt: now,
        endedAt: null,
        capture: null,
        metadata: input.attemptMetadata ?? {},
      }],
      events: [],
      createdAt: now,
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      revision: 1,
    };
    this.database.prepare(`
      INSERT INTO honeycrisp_sessions (
        id, workspace_id, status, title, summary, document_json, document_hash,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.status,
      record.title,
      record.summary,
      storedSessionDocument(record),
      sessionDocumentHash(record),
      record.revision,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  public get(sessionId: string): HoneycrispSessionRecord | null {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const session = this.getSessionCore(normalizedSessionId);
    if (!session) return null;
    if (this.normalizedEventStorage) session.events = this.readEvents(normalizedSessionId);
    if (this.normalizedCaptureStorage) this.hydrateCaptures(session);
    return session;
  }

  public getSummary(sessionId: string): HoneycrispSessionSummary | null {
    const session = this.getSessionCore(requiredString(sessionId, "Session id"));
    if (!session) return null;
    return sessionSummary(session, this.readSummaryTokenUsage([session.id]).get(session.id) ?? 0);
  }

  public getCapture(sessionId: string, attemptId: string): HoneycrispSessionCapture | null {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const normalizedAttemptId = requiredString(attemptId, "Attempt id");
    const row = this.database.prepare(`
      SELECT attempt_id, capture_json, content_hash FROM honeycrisp_session_captures
      WHERE session_id = ? AND attempt_id = ?
    `).get(normalizedSessionId, normalizedAttemptId) as StoredSessionCaptureRow | undefined;
    return row ? decodeCaptureRow(row, normalizedSessionId) : null;
  }

  public listCaptureSummaries(sessionId: string): HoneycrispSessionCaptureSummary[] {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const rows = this.database.prepare(`
      SELECT attempt_id, capture_json, content_hash FROM honeycrisp_session_captures
      WHERE session_id = ? ORDER BY attempt_id ASC
    `).all(normalizedSessionId) as StoredSessionCaptureRow[];
    return rows.map((row) => {
      const document = requiredStoredString(row.capture_json, "Honeycrisp session capture");
      const capture = decodeCaptureRow(row, normalizedSessionId);
      return {
        attemptId: capture.attemptId,
        capturedAt: capture.capturedAt,
        schemaVersion: capture.schemaVersion,
        sizeBytes: Buffer.byteLength(document),
        contentHash: requiredStoredString(row.content_hash, "Honeycrisp session capture hash"),
        eventStreams: capture.eventStreams,
      };
    });
  }

  public list(workspaceId: string, limit = 100): HoneycrispSessionRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""} FROM honeycrisp_sessions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(requiredString(workspaceId, "Workspace id"), boundedLimit) as StoredSessionRow[];
    return rows.map((row) => this.decodeSessionRow(row)).map((session) => {
      if (this.normalizedEventStorage) session.events = this.readEvents(session.id);
      if (this.normalizedCaptureStorage) this.hydrateCaptures(session);
      return session;
    });
  }

  public listSummaries(workspaceId: string, limit = 100): HoneycrispSessionSummary[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""} FROM honeycrisp_sessions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(requiredString(workspaceId, "Workspace id"), boundedLimit) as StoredSessionRow[];
    const sessions = rows.map((row) => this.decodeSessionRow(row));
    const tokenUsage = this.readSummaryTokenUsage(sessions.map((session) => session.id));
    return sessions.map((session) => sessionSummary(session, tokenUsage.get(session.id) ?? 0));
  }

  public listForWorkspaces(workspaceIds: readonly string[], limitPerWorkspace = 100): HoneycrispSessionRecord[] {
    const normalizedWorkspaceIds = [...new Set(workspaceIds.map((workspaceId) => requiredString(workspaceId, "Workspace id")))];
    if (normalizedWorkspaceIds.length === 0) return [];
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limitPerWorkspace)));
    const placeholders = normalizedWorkspaceIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""} FROM (
        SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""}, updated_at, id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id
            ORDER BY updated_at DESC, id DESC
          ) AS workspace_rank
        FROM honeycrisp_sessions
        WHERE workspace_id IN (${placeholders})
      )
      WHERE workspace_rank <= ?
      ORDER BY updated_at DESC, id DESC
    `).all(...normalizedWorkspaceIds, boundedLimit) as StoredSessionRow[];
    return rows.map((row) => this.decodeSessionRow(row)).map((session) => {
      if (this.normalizedEventStorage) session.events = this.readEvents(session.id);
      if (this.normalizedCaptureStorage) this.hydrateCaptures(session);
      return session;
    });
  }

  public listSummariesForWorkspaces(
    workspaceIds: readonly string[],
    limitPerWorkspace = 100,
  ): HoneycrispSessionSummary[] {
    const normalizedWorkspaceIds = [...new Set(workspaceIds.map((workspaceId) => requiredString(workspaceId, "Workspace id")))];
    if (normalizedWorkspaceIds.length === 0) return [];
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limitPerWorkspace)));
    const placeholders = normalizedWorkspaceIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""} FROM (
        SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""}, updated_at, id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id
            ORDER BY updated_at DESC, id DESC
          ) AS workspace_rank
        FROM honeycrisp_sessions
        WHERE workspace_id IN (${placeholders})
      )
      WHERE workspace_rank <= ?
      ORDER BY updated_at DESC, id DESC
    `).all(...normalizedWorkspaceIds, boundedLimit) as StoredSessionRow[];
    const sessions = rows.map((row) => this.decodeSessionRow(row));
    const tokenUsage = this.readSummaryTokenUsage(sessions.map((session) => session.id));
    return sessions.map((session) => sessionSummary(session, tokenUsage.get(session.id) ?? 0));
  }

  public getUpdate(
    sessionId: string,
    afterEventId?: string | null,
    input: Omit<HoneycrispSessionEventPageInput, "afterEventId" | "stream"> = {},
  ): HoneycrispSessionUpdate | null {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    if (this.normalizedEventStorage) {
      const session = this.getSessionCore(normalizedSessionId);
      if (!session) return null;
      const page = this.getEventPage(normalizedSessionId, {
        ...input,
        ...(afterEventId !== undefined ? { afterEventId } : {}),
        stream: "all",
        tail: optionalString(afterEventId) ? false : input.tail ?? true,
      });
      return {
        session: sessionSummary(session),
        finalResponse: session.finalResponse,
        events: page.events,
        eventOffset: page.eventOffset,
        nextAfterEventId: page.nextAfterEventId,
        hasEarlier: page.hasEarlier,
        hasMore: page.hasMore,
      };
    }
    const session = this.get(normalizedSessionId);
    if (!session) return null;
    const normalizedAfterEventId = optionalString(afterEventId);
    const matchedIndex = normalizedAfterEventId
      ? session.events.findIndex((event) => event.id === normalizedAfterEventId)
      : -1;
    const eventOffset = matchedIndex >= 0 ? matchedIndex + 1 : 0;
    return {
      session: sessionSummary(session),
      finalResponse: session.finalResponse,
      events: session.events.slice(eventOffset),
      eventOffset,
      nextAfterEventId: session.events.at(-1)?.id ?? null,
      hasEarlier: eventOffset > 0,
      hasMore: false,
    };
  }

  public getEventPage(sessionId: string, input: HoneycrispSessionEventPageInput = {}): HoneycrispSessionEventPage {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    if (!this.getSessionCore(normalizedSessionId)) throw new Error(`Session not found: ${normalizedSessionId}`);
    const stream = input.stream ?? "all";
    if (stream !== "all" && stream !== "transcript" && stream !== "trace") {
      throw new Error(`Unsupported session event stream: ${stream}.`);
    }
    const limit = boundedInteger(input.limit, 500, 1, 2_000);
    const maxBytes = boundedInteger(input.maxBytes, 2 * 1024 * 1024, 1_024, 8 * 1024 * 1024);
    const afterEventId = optionalString(input.afterEventId);
    const cursorOffset = afterEventId ? this.eventOffsetForCursor(normalizedSessionId, afterEventId) : null;
    const tail = input.tail === true && !afterEventId;
    const filter = eventStreamSql(stream);
    const direction = tail ? "DESC" : "ASC";
    const comparison = cursorOffset === null ? "" : "AND event_offset > ?";
    const query = this.database.prepare(`
      SELECT event_offset, event_json, content_hash FROM honeycrisp_session_events
      WHERE session_id = ? ${comparison} ${filter}
      ORDER BY event_offset ${direction}
      LIMIT ?
    `);
    const rows = (cursorOffset === null
      ? query.all(normalizedSessionId, limit + 1)
      : query.all(normalizedSessionId, cursorOffset, limit + 1)
    ) as Array<StoredSessionEventRow & { event_offset?: unknown }>;
    const orderedRows = tail ? [...rows].reverse() : rows;
    const selected: typeof orderedRows = [];
    let bytes = 0;
    const candidates = tail ? [...orderedRows].reverse() : orderedRows;
    for (const row of candidates) {
      if (selected.length >= limit) break;
      const document = requiredStoredString(row.event_json, "Honeycrisp session event");
      const nextBytes = Buffer.byteLength(document);
      if (selected.length > 0 && bytes + nextBytes > maxBytes) break;
      selected.push(row);
      bytes += Math.min(nextBytes, maxBytes);
    }
    if (tail) selected.reverse();
    const events = selected.map((row) => {
      const document = requiredStoredString(row.event_json, "Honeycrisp session event");
      return Buffer.byteLength(document) > maxBytes
        ? projectOversizedSessionEvent(decodeEventRow(row), Buffer.byteLength(document))
        : decodeEventRow(row);
    });
    const firstOffset = numericOffset(selected[0]?.event_offset);
    const lastOffset = numericOffset(selected.at(-1)?.event_offset);
    const bounds = this.eventStreamBounds(normalizedSessionId, stream);
    return {
      sessionId: normalizedSessionId,
      stream,
      events,
      eventOffset: firstOffset ?? (cursorOffset === null ? 0 : cursorOffset + 1),
      nextAfterEventId: events.at(-1)?.id ?? afterEventId ?? null,
      hasEarlier: firstOffset !== null && bounds.minimum !== null && firstOffset > bounds.minimum,
      hasMore: lastOffset !== null && bounds.maximum !== null && lastOffset < bounds.maximum,
    };
  }

  public getEventDetails(sessionId: string, eventIds: readonly string[]): HoneycrispSessionEvent[] {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const normalizedIds = [...new Set(eventIds.map((eventId) => requiredString(eventId, "Session event id")))];
    if (normalizedIds.length === 0) return [];
    if (normalizedIds.length > 100) throw new Error("At most 100 session event details may be requested at once.");
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT event_json, content_hash FROM honeycrisp_session_events
      WHERE session_id = ? AND (
        event_id IN (${placeholders})
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(event_json, '$.payload.records')) AS nested
          WHERE json_extract(nested.value, '$.id') IN (${placeholders})
        )
      )
      ORDER BY event_offset ASC
    `).all(normalizedSessionId, ...normalizedIds, ...normalizedIds) as StoredSessionEventRow[];
    return rows.map(decodeEventRow);
  }

  public getCollaborationState(sessionId: string, messageLimit = 200): HoneycrispSessionCollaborationState {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const session = this.getSessionCore(normalizedSessionId);
    if (!session) throw new Error(`Session not found: ${normalizedSessionId}`);
    const readKind = (kind: string, limit: number): HoneycrispSessionEvent[] => {
      const rows = this.database.prepare(`
        SELECT event_json, content_hash FROM honeycrisp_session_events
        WHERE session_id = ? AND json_extract(event_json, '$.kind') = ?
        ORDER BY event_offset DESC
        LIMIT ?
      `).all(normalizedSessionId, kind, limit) as StoredSessionEventRow[];
      return rows.map(decodeEventRow).reverse();
    };
    const roomEvents = readKind("beale.breakout_room", 2_000);
    const memberEvents = readKind("beale.breakout_member", 4_000);
    const messageEvents = readKind(
      "beale.breakout_message",
      boundedInteger(messageLimit, 200, 1, 1_000),
    );
    return {
      sessionId: normalizedSessionId,
      revision: session.revision,
      rooms: latestRecordEvents(roomEvents),
      members: latestRecordEvents(memberEvents),
      messages: messageEvents,
    };
  }

  public recoverInterrupted(
    workspaceId: string,
    input: RecoverInterruptedHoneycrispSessionsInput = {},
  ): HoneycrispSessionRecoveryReport {
    const normalizedWorkspaceId = requiredString(workspaceId, "Workspace id");
    const recoveredAt = input.at ?? new Date().toISOString();
    const reason = optionalString(input.reason) ?? "workspace_open";
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const rows = this.database.prepare(`
        SELECT document_json, document_hash FROM honeycrisp_sessions
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY updated_at ASC, id ASC
      `).all(normalizedWorkspaceId) as StoredSessionRow[];
      const sessions = rows.map((row) => this.decodeSessionRow(row));
      let interruptedAttempts = 0;
      for (const session of sessions) {
        const recoveredAttemptIds: string[] = [];
        for (const attempt of session.attempts) {
          if (attempt.status !== "active") continue;
          attempt.status = "paused";
          attempt.summary = "Paused after the Honeycrisp process was interrupted.";
          attempt.endedAt = null;
          attempt.metadata = {
            ...attempt.metadata,
            interruptedByRecovery: true,
            recoveryReason: reason,
            recoveredAt,
          };
          recoveredAttemptIds.push(attempt.id);
          interruptedAttempts += 1;
        }
        session.status = "paused";
        session.summary = "Paused after the Honeycrisp process was interrupted.";
        session.endedAt = null;
        session.metadata = {
          ...session.metadata,
          interruptedByRecovery: true,
          recoveryReason: reason,
          recoveredAt,
          previousStatus: "active",
          recoveredAttemptIds,
        };
        const recoveryEvent = normalizeEvent({
          id: `session_recovery_${randomUUID()}`,
          kind: "session.recovery",
          timestamp: recoveredAt,
          summary: "Workspace recovery paused an interrupted Honeycrisp session.",
          payload: {
            interruptedByRecovery: true,
            previousStatus: "active",
            recoveredAt,
            reason,
            attemptId: recoveredAttemptIds.at(-1) ?? null,
            recoveredAttemptIds,
          },
          agentPath: "/root",
        });
        this.insertEvents(session.id, [recoveryEvent]);
        session.revision += 1;
        session.updatedAt = recoveredAt;
        const document = storedSessionDocument(session);
        const result = this.database.prepare(`
          UPDATE honeycrisp_sessions
          SET status = ?, summary = ?, document_json = ?, document_hash = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'active'
        `).run(
          session.status,
          session.summary,
          document,
          hashJson(document),
          session.revision,
          session.updatedAt,
          session.id,
          session.revision - 1,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`Session revision conflict while recovering ${session.id}.`);
        }
      }
      this.database.exec("COMMIT;");
      return {
        workspaceId: normalizedWorkspaceId,
        recoveredAt,
        reason,
        interruptedSessions: sessions.length,
        interruptedAttempts,
        sessionIds: sessions.map((session) => session.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  public beginAttempt(sessionId: string, input: BeginHoneycrispSessionAttemptInput): HoneycrispSessionRecord {
    return this.mutate(sessionId, input.expectedRevision, (session) => {
      if (session.status === "active") {
        throw new Error(`Session ${session.id} already has an active attempt.`);
      }
      const now = input.startedAt ?? new Date().toISOString();
      session.status = "active";
      session.summary = requiredString(input.summary, "Attempt summary");
      session.endedAt = null;
      session.attempts.push({
        id: requiredString(input.attemptId, "Attempt id"),
        parentAttemptId: optionalString(input.parentAttemptId),
        status: "active",
        summary: session.summary,
        startedAt: now,
        endedAt: null,
        capture: null,
        metadata: input.metadata ?? {},
      });
    });
  }

  public appendEvent(sessionId: string, event: HoneycrispSessionEvent): HoneycrispSessionRecord {
    const session = this.appendNormalizedEvent(sessionId, event);
    session.events = this.readEvents(session.id);
    this.hydrateCaptures(session);
    return session;
  }

  public appendEventReceipt(sessionId: string, event: HoneycrispSessionEvent): HoneycrispSessionMutationReceipt {
    return sessionMutationReceipt(this.appendNormalizedEvent(sessionId, event));
  }

  public transition(sessionId: string, input: HoneycrispSessionTransitionInput): HoneycrispSessionRecord {
    return this.mutate(sessionId, input.expectedRevision, (session) => {
      const now = input.at ?? new Date().toISOString();
      session.status = input.status;
      session.summary = requiredString(input.summary, "Lifecycle summary");
      session.metadata = { ...session.metadata, ...(input.metadata ?? {}) };
      if (input.configuration) {
        if (input.configuration.prompt !== undefined) {
          session.prompt = requiredString(input.configuration.prompt, "Session prompt");
        }
        if (input.configuration.provider !== undefined) {
          session.provider = optionalString(input.configuration.provider);
        }
        if (input.configuration.model !== undefined) {
          session.model = requiredString(input.configuration.model, "Session model");
        }
        if (input.configuration.reasoningEffort !== undefined) {
          session.reasoningEffort = input.configuration.reasoningEffort.trim();
        }
        if (input.configuration.workflowId !== undefined) {
          session.workflowId = optionalString(input.configuration.workflowId);
        }
      }
      if (input.disposition !== undefined) session.finalDisposition = input.disposition;
      const attempt = input.attemptId
        ? session.attempts.find((candidate) => candidate.id === input.attemptId)
        : session.attempts.at(-1);
      if (attempt) {
        attempt.status = input.status;
        attempt.summary = session.summary;
        attempt.endedAt = terminalStatus(input.status) ? now : null;
      }
      session.endedAt = terminalStatus(input.status) ? now : null;
    });
  }

  public importCapture(sessionId: string, input: ImportHoneycrispSessionCaptureInput): HoneycrispSessionRecord {
    const capture = decodeCapture(input.capture);
    return this.mutate(sessionId, input.expectedRevision, (session) => {
      const attempt = session.attempts.find((candidate) => candidate.id === input.attemptId);
      if (!attempt) throw new Error(`Attempt not found for capture import: ${input.attemptId}`);
      if (attempt.capture) throw new Error(`Attempt ${attempt.id} already has an imported capture.`);

      const capturedAt = optionalString(capture.capturedAt) ?? new Date().toISOString();
      const agent = recordValue(capture.agent) ?? {};
      const goal = recordValue(agent.goal);
      const goalStatus = optionalString(goal?.status);
      const agentStatus = optionalString(agent.status);
      const completed = agentStatus === "complete" && goalStatus !== "active";
      const status: HoneycrispSessionStatus = completed && goalStatus === "blocked"
        ? "blocked"
        : completed
          ? "completed"
          : "failed";
      const summary = completionSummary(agentStatus, goalStatus, agent);
      const disposition = decodeDisposition(agent.finalDisposition);
      const response = optionalString(agent.outputText);

      attempt.capture = compactImportedCapture(capture, session.id, attempt.id, capturedAt);
      attempt.status = status;
      attempt.summary = summary;
      attempt.endedAt = capturedAt;
      session.status = status;
      session.summary = summary;
      session.finalDisposition = disposition;
      session.finalResponse = response;
      session.endedAt = capturedAt;

      for (const candidate of Array.isArray(capture.eventTimeline) ? capture.eventTimeline : []) {
        const event = captureEvent(candidate);
        if (event && !session.events.some((existing) => existing.id === event.id)) session.events.push(event);
      }
    });
  }

  private mutate(
    sessionId: string,
    expectedRevision: number | undefined,
    update: (session: HoneycrispSessionRecord) => void,
  ): HoneycrispSessionRecord {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const session = this.getSessionCore(requiredString(sessionId, "Session id"));
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new Error(
          `Session revision conflict for ${sessionId}: expected ${expectedRevision}, received ${session.revision}.`,
        );
      }
      const storedEventCount = session.events.length;
      update(session);
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      this.insertEvents(session.id, session.events.slice(storedEventCount));
      this.insertCaptures(session);
      const document = storedSessionDocument(session);
      const result = this.database.prepare(`
        UPDATE honeycrisp_sessions
        SET status = ?, title = ?, summary = ?, document_json = ?, document_hash = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        session.status,
        session.title,
        session.summary,
        document,
        hashJson(document),
        session.revision,
        session.updatedAt,
        session.id,
        session.revision - 1,
      );
      if (Number(result.changes) !== 1) throw new Error(`Session revision conflict for ${sessionId}.`);
      this.database.exec("COMMIT;");
      return session;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private appendNormalizedEvent(sessionId: string, event: HoneycrispSessionEvent): HoneycrispSessionRecord {
    const normalizedSessionId = requiredString(sessionId, "Session id");
    const normalized = normalizeEvent(event);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const session = this.getSessionCore(normalizedSessionId);
      if (!session) throw new Error(`Session not found: ${normalizedSessionId}`);
      const duplicate = this.database.prepare(`
        SELECT 1 AS present FROM honeycrisp_session_events
        WHERE session_id = ? AND event_id = ?
      `).get(normalizedSessionId, normalized.id) as { present?: unknown } | undefined;
      if (duplicate?.present !== 1) {
        this.insertEvents(normalizedSessionId, [normalized]);
        if (normalized.kind === "session.title") {
          const payload = recordValue(normalized.payload);
          const title = optionalString(payload?.title);
          if (payload?.status === "generated" && title) session.title = title;
        }
      }
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      const document = storedSessionDocument(session);
      const result = this.database.prepare(`
        UPDATE honeycrisp_sessions
        SET title = ?, document_json = ?, document_hash = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        session.title,
        document,
        hashJson(document),
        session.revision,
        session.updatedAt,
        session.id,
        session.revision - 1,
      );
      if (Number(result.changes) !== 1) throw new Error(`Session revision conflict for ${normalizedSessionId}.`);
      this.database.exec("COMMIT;");
      return session;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  private getSessionCore(sessionId: string): HoneycrispSessionRecord | null {
    const row = this.database.prepare(`
      SELECT document_json${this.sessionDocumentHashes ? ", document_hash" : ""}
      FROM honeycrisp_sessions WHERE id = ?
    `).get(sessionId) as StoredSessionRow | undefined;
    return row ? this.decodeSessionRow(row) : null;
  }

  private decodeSessionRow(row: StoredSessionRow): HoneycrispSessionRecord {
    const document = requiredStoredString(row.document_json, "Honeycrisp session document");
    if (this.sessionDocumentHashes) verifyJsonHash(document, row.document_hash, "Honeycrisp session document");
    return decodeStoredSession(document);
  }

  private readEvents(sessionId: string, fromOffset = 0): HoneycrispSessionEvent[] {
    if (!this.normalizedEventStorage) return [];
    const rows = this.database.prepare(`
      SELECT event_json, content_hash FROM honeycrisp_session_events
      WHERE session_id = ? AND event_offset >= ?
      ORDER BY event_offset ASC
    `).all(sessionId, fromOffset) as StoredSessionEventRow[];
    return rows.map(decodeEventRow);
  }

  private eventStreamBounds(
    sessionId: string,
    stream: HoneycrispSessionEventStream,
  ): { minimum: number | null; maximum: number | null } {
    const row = this.database.prepare(`
      SELECT MIN(event_offset) AS minimum, MAX(event_offset) AS maximum
      FROM honeycrisp_session_events
      WHERE session_id = ? ${eventStreamSql(stream)}
    `).get(sessionId) as { minimum?: unknown; maximum?: unknown } | undefined;
    return {
      minimum: numericOffset(row?.minimum),
      maximum: numericOffset(row?.maximum),
    };
  }

  private eventOffsetForCursor(sessionId: string, eventId: string): number | null {
    const row = this.database.prepare(`
      SELECT event_offset FROM honeycrisp_session_events
      WHERE session_id = ? AND (
        event_id = ?
        OR EXISTS (
          SELECT 1 FROM json_each(json_extract(event_json, '$.payload.records')) AS nested
          WHERE json_extract(nested.value, '$.id') = ?
        )
      )
      ORDER BY event_offset DESC
      LIMIT 1
    `).get(sessionId, eventId, eventId) as { event_offset?: unknown } | undefined;
    return numericOffset(row?.event_offset);
  }

  private readSummaryTokenUsage(sessionIds: readonly string[]): Map<string, number> {
    const totals = new Map<string, number>();
    if (!this.normalizedEventStorage || sessionIds.length === 0) return totals;
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT session_id, event_json FROM honeycrisp_session_events
      WHERE session_id IN (${placeholders})
        AND json_extract(event_json, '$.kind') = 'beale.model_session_update'
    `).all(...sessionIds) as Array<{ session_id?: unknown; event_json?: unknown }>;
    for (const row of rows) {
      if (typeof row.session_id !== "string" || typeof row.event_json !== "string") continue;
      const event = recordValue(JSON.parse(row.event_json));
      const payload = recordValue(event?.payload);
      const record = recordValue(payload?.record);
      const patch = recordValue(record?.patch);
      const metadata = recordValue(patch?.metadata);
      const totalTokens = finiteNonNegativeNumber(metadata?.latestReportedTotalTokens);
      if (totalTokens === null) continue;
      totals.set(row.session_id, Math.max(totals.get(row.session_id) ?? 0, totalTokens));
    }
    return totals;
  }

  private insertEvents(sessionId: string, events: readonly HoneycrispSessionEvent[]): void {
    if (events.length === 0) return;
    const offsetRow = this.database.prepare(`
      SELECT COALESCE(MAX(event_offset), -1) + 1 AS next_offset
      FROM honeycrisp_session_events WHERE session_id = ?
    `).get(sessionId) as { next_offset?: unknown } | undefined;
    let offset = typeof offsetRow?.next_offset === "number" ? offsetRow.next_offset : 0;
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO honeycrisp_session_events (
        session_id, event_offset, event_id, event_json, content_hash
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      const normalized = normalizeEvent(event);
      const document = JSON.stringify(normalized);
      const result = insert.run(sessionId, offset, normalized.id, document, hashJson(document));
      if (Number(result.changes) === 1) offset += 1;
    }
  }

  private hydrateCaptures(session: HoneycrispSessionRecord): void {
    if (!this.normalizedCaptureStorage) return;
    const rows = this.database.prepare(`
      SELECT attempt_id, capture_json, content_hash FROM honeycrisp_session_captures
      WHERE session_id = ?
    `).all(session.id) as StoredSessionCaptureRow[];
    const captures = new Map(rows.map((row) => {
      const attemptId = requiredStoredString(row.attempt_id, "Honeycrisp session capture attempt id");
      return [attemptId, decodeCaptureRow(row, session.id)] as const;
    }));
    for (const attempt of session.attempts) attempt.capture = captures.get(attempt.id) ?? attempt.capture;
  }

  private insertCaptures(session: HoneycrispSessionRecord): void {
    const existingRows = this.database.prepare(`
      SELECT attempt_id FROM honeycrisp_session_captures WHERE session_id = ?
    `).all(session.id) as Array<{ attempt_id?: unknown }>;
    const existingAttemptIds = new Set(existingRows.flatMap((row) =>
      typeof row.attempt_id === "string" ? [row.attempt_id] : []
    ));
    const insert = this.database.prepare(`
      INSERT INTO honeycrisp_session_captures (
        session_id, attempt_id, capture_json, content_hash
      ) VALUES (?, ?, ?, ?)
    `);
    for (const attempt of session.attempts) {
      if (!attempt.capture || existingAttemptIds.has(attempt.id)) continue;
      const document = JSON.stringify(attempt.capture);
      insert.run(session.id, attempt.id, document, hashJson(document));
    }
  }
}

function storedSessionDocument(session: HoneycrispSessionRecord, stripCaptures = true): string {
  return JSON.stringify({
    ...session,
    attempts: stripCaptures
      ? session.attempts.map((attempt) => ({ ...attempt, capture: null }))
      : session.attempts,
    events: [],
  });
}

function sessionDocumentHash(session: HoneycrispSessionRecord): string {
  return hashJson(storedSessionDocument(session));
}

function hashJson(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

function verifyJsonHash(document: string, storedHash: unknown, label: string): void {
  if (typeof storedHash !== "string" || storedHash.length !== 64 || hashJson(document) !== storedHash) {
    throw new Error(`${label} failed its integrity check.`);
  }
}

function requiredStoredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing or invalid.`);
  return value;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) throw new Error(`Invalid table name: ${table}.`);
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .some((row) => row.name === column);
}

function sessionSummary(session: HoneycrispSessionRecord, totalTokens = 0): HoneycrispSessionSummary {
  return {
    schemaVersion: session.schemaVersion,
    id: session.id,
    workspaceId: session.workspaceId,
    status: session.status,
    title: session.title,
    prompt: session.prompt,
    summary: session.summary,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    workflowId: session.workflowId,
    profile: session.profile,
    metadata: session.metadata,
    finalDisposition: session.finalDisposition,
    attempts: session.attempts.map(({ capture: _capture, ...attempt }) => attempt),
    tokenUsage: { totalTokens },
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
  };
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function sessionMutationReceipt(session: HoneycrispSessionRecord): HoneycrispSessionMutationReceipt {
  return {
    sessionId: session.id,
    status: session.status,
    revision: session.revision,
    updatedAt: session.updatedAt,
  };
}

function compactImportedCapture(
  capture: Record<string, unknown>,
  sessionId: string,
  attemptId: string,
  capturedAt: string,
): HoneycrispSessionCapture {
  const timelineCount = Array.isArray(capture.eventTimeline) ? capture.eventTimeline.length : 0;
  const agent = recordValue(capture.agent);
  const agentRaw = recordValue(agent?.raw);
  const agentDiagnosticCount = Array.isArray(agentRaw?.agentEvents) ? agentRaw.agentEvents.length : 0;
  const eventStreams: HoneycrispSessionCapture["eventStreams"] = {
    timeline: sessionCaptureEventReference(sessionId, attemptId, timelineCount),
    agentDiagnostics: sessionCaptureEventReference(sessionId, attemptId, agentDiagnosticCount),
  };
  const compactedRaw: Record<string, unknown> = { ...capture };
  delete compactedRaw.eventTimeline;
  compactedRaw.eventTimelineRef = eventStreams.timeline;
  if (agent) {
    const compactedAgent: Record<string, unknown> = { ...agent };
    if (agentRaw) {
      const compactedAgentRaw: Record<string, unknown> = { ...agentRaw };
      delete compactedAgentRaw.agentEvents;
      compactedAgentRaw.agentEventsRef = eventStreams.agentDiagnostics;
      compactedAgent.raw = compactedAgentRaw;
    }
    compactedRaw.agent = compactedAgent;
  }
  return {
    attemptId,
    capturedAt,
    schemaVersion: numberValue(capture.schemaVersion),
    eventStreams,
    raw: compactedRaw,
  };
}

function compactStoredCapture(value: unknown, sessionId: string, attemptId: string): HoneycrispSessionCapture {
  if (!isRecord(value)) throw new Error("Honeycrisp session capture is invalid.");
  const raw = recordValue(value.raw) ?? value;
  const capturedAt = optionalString(value.capturedAt) ?? optionalString(raw.capturedAt) ?? new Date(0).toISOString();
  const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : value.schemaVersion;
  const compacted = compactImportedCapture({ ...raw, schemaVersion }, sessionId, attemptId, capturedAt);
  const storedStreams = recordValue(value.eventStreams);
  const storedTimeline = recordValue(storedStreams?.timeline);
  const storedDiagnostics = recordValue(storedStreams?.agentDiagnostics);
  const eventStreams: HoneycrispSessionCapture["eventStreams"] = {
    timeline: sessionCaptureEventReference(
      sessionId,
      attemptId,
      finiteNonNegativeNumber(storedTimeline?.count) ?? compacted.eventStreams.timeline.count,
    ),
    agentDiagnostics: sessionCaptureEventReference(
      sessionId,
      attemptId,
      finiteNonNegativeNumber(storedDiagnostics?.count) ?? compacted.eventStreams.agentDiagnostics.count,
    ),
  };
  const compactedRaw: Record<string, unknown> = { ...compacted.raw, eventTimelineRef: eventStreams.timeline };
  const compactedAgent = recordValue(compactedRaw.agent);
  const compactedAgentRaw = recordValue(compactedAgent?.raw);
  if (compactedAgent && compactedAgentRaw) {
    compactedRaw.agent = {
      ...compactedAgent,
      raw: { ...compactedAgentRaw, agentEventsRef: eventStreams.agentDiagnostics },
    };
  }
  return {
    ...compacted,
    schemaVersion: typeof value.schemaVersion === "number" ? numberValue(value.schemaVersion) : compacted.schemaVersion,
    eventStreams,
    raw: compactedRaw,
  };
}

function sessionCaptureEventReference(
  sessionId: string,
  attemptId: string,
  count: number,
): HoneycrispSessionCaptureEventReference {
  return {
    source: "honeycrisp_session_events",
    sessionId,
    attemptId,
    count: Math.max(0, Math.trunc(count)),
  };
}

function decodeCaptureRow(row: StoredSessionCaptureRow, sessionId: string): HoneycrispSessionCapture {
  const attemptId = requiredStoredString(row.attempt_id, "Honeycrisp session capture attempt id");
  const document = requiredStoredString(row.capture_json, "Honeycrisp session capture");
  verifyJsonHash(document, row.content_hash, "Honeycrisp session capture");
  const parsed = JSON.parse(document) as unknown;
  return compactStoredCapture(parsed, sessionId, attemptId);
}

function decodeEventRow(row: StoredSessionEventRow): HoneycrispSessionEvent {
  const document = requiredStoredString(row.event_json, "Honeycrisp session event");
  verifyJsonHash(document, row.content_hash, "Honeycrisp session event");
  return normalizeEvent(JSON.parse(document) as HoneycrispSessionEvent);
}

function projectOversizedSessionEvent(event: HoneycrispSessionEvent, sizeBytes: number): HoneycrispSessionEvent {
  const payload = recordValue(event.payload);
  if (event.kind === "beale.trace_batch" && Array.isArray(payload?.records)) {
    return {
      ...event,
      payload: {
        detailAvailableOnRequest: true,
        sizeBytes,
        records: payload.records.slice(0, 256).flatMap((candidate) => {
          const record = recordValue(candidate);
          if (!record) return [];
          return [{
            id: optionalString(record.id) ?? `projected_${randomUUID()}`,
            runId: optionalString(record.runId) ?? "",
            attemptId: optionalString(record.attemptId),
            sequence: finiteNonNegativeNumber(record.sequence) ?? 0,
            type: optionalString(record.type) ?? "research_event",
            source: optionalString(record.source) ?? "executor",
            summary: truncateText(optionalString(record.summary) ?? "Large trace event", 400),
            payload: { detailAvailableOnRequest: true, sizeBytes },
            sensitivity: optionalString(record.sensitivity) ?? "internal",
            modelVisible: record.modelVisible !== false,
            createdAt: optionalString(record.createdAt) ?? event.timestamp,
            artifactId: optionalString(record.artifactId),
            toolCallId: optionalString(record.toolCallId),
            approvalId: optionalString(record.approvalId),
          }];
        }),
      },
    };
  }
  if (event.kind === "beale.transcript") {
    const record = recordValue(payload?.record);
    if (record) {
      return {
        ...event,
        payload: {
          record: {
            ...record,
            contentMarkdown: truncateText(optionalString(record.contentMarkdown) ?? "", 8_000),
            metadata: {
              ...(recordValue(record.metadata) ?? {}),
              detailAvailableOnRequest: true,
              sizeBytes,
            },
          },
        },
      };
    }
  }
  return {
    ...event,
    payload: { detailAvailableOnRequest: true, sizeBytes },
  };
}

function eventStreamSql(stream: HoneycrispSessionEventStream): string {
  if (stream === "transcript") return "AND json_extract(event_json, '$.kind') = 'beale.transcript'";
  if (stream === "trace") {
    return `AND json_extract(event_json, '$.kind') NOT IN (
      'beale.transcript', 'beale.breakout_room', 'beale.breakout_member', 'beale.breakout_message'
    )`;
  }
  return "";
}

function latestRecordEvents(events: readonly HoneycrispSessionEvent[]): HoneycrispSessionEvent[] {
  const latest = new Map<string, HoneycrispSessionEvent>();
  for (const event of events) {
    const payload = recordValue(event.payload);
    const record = recordValue(payload?.record);
    const id = optionalString(record?.id) ?? event.id;
    latest.set(id, event);
  }
  return [...latest.values()];
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function truncateText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function numericOffset(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function decodeStoredSession(value: unknown): HoneycrispSessionRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!isRecord(parsed)
    || parsed.schemaVersion !== HONEYCRISP_SESSION_SCHEMA_VERSION
    || typeof parsed.id !== "string"
    || typeof parsed.workspaceId !== "string"
    || typeof parsed.revision !== "number") {
    throw new Error("Stored Honeycrisp session is invalid or unsupported.");
  }
  return parsed as unknown as HoneycrispSessionRecord;
}

function decodeCapture(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || (value.schemaVersion !== 4 && value.schemaVersion !== 5)) {
    throw new Error("Honeycrisp capture must use schema version 4 or 5.");
  }
  if (!isRecord(value.agent) || !isRecord(value.request)) {
    throw new Error("Honeycrisp capture is missing its request or agent record.");
  }
  return value;
}

function decodeDisposition(value: unknown): HoneycrispSessionDisposition | null {
  const disposition = recordValue(value);
  if (!disposition) return null;
  const outcome = optionalString(disposition.outcome);
  const summary = optionalString(disposition.summary);
  if (!outcome || !summary || typeof disposition.externalStateRequired !== "boolean") return null;
  return {
    ...disposition,
    outcome,
    summary,
    externalStateRequired: disposition.externalStateRequired,
    blockerDependencies: Array.isArray(disposition.blockerDependencies)
      ? disposition.blockerDependencies
      : [],
  };
}

function captureEvent(value: unknown): HoneycrispSessionEvent | null {
  const event = recordValue(value);
  if (!event) return null;
  const id = optionalString(event.id) ?? `capture_event_${randomUUID()}`;
  const kind = optionalString(event.kind);
  if (!kind) return null;
  return normalizeEvent({
    id,
    kind,
    timestamp: optionalString(event.timestamp) ?? new Date().toISOString(),
    summary: optionalString(event.summary) ?? kind,
    payload: event.payload ?? null,
    ...(optionalString(event.agentId) ? { agentId: optionalString(event.agentId)! } : {}),
    ...(optionalString(event.agentPath) ? { agentPath: optionalString(event.agentPath)! } : {}),
    ...(optionalString(event.parentAgentId) ? { parentAgentId: optionalString(event.parentAgentId)! } : {}),
  });
}

function normalizeEvent(event: HoneycrispSessionEvent): HoneycrispSessionEvent {
  return {
    id: requiredString(event.id, "Session event id"),
    kind: requiredString(event.kind, "Session event kind"),
    timestamp: requiredString(event.timestamp, "Session event timestamp"),
    summary: requiredString(event.summary, "Session event summary"),
    payload: event.payload,
    ...(optionalString(event.agentId) ? { agentId: optionalString(event.agentId)! } : {}),
    ...(optionalString(event.agentPath) ? { agentPath: optionalString(event.agentPath)! } : {}),
    ...(optionalString(event.parentAgentId) ? { parentAgentId: optionalString(event.parentAgentId)! } : {}),
  };
}

function completionSummary(agentStatus: string | null, goalStatus: string | null, agent: Record<string, unknown>): string {
  if (agentStatus === "complete" && goalStatus === "blocked") {
    return "Honeycrisp stopped because the research goal is genuinely blocked on external state.";
  }
  if (agentStatus === "complete" && goalStatus === "active") {
    return "Honeycrisp exited while the research goal was still active.";
  }
  if (agentStatus === "complete") return "Honeycrisp completed the research session.";
  return `Honeycrisp process failed: ${optionalString(agent.outputText) ?? "Unknown Honeycrisp error."}`;
}

function terminalStatus(status: HoneycrispSessionStatus): boolean {
  return status === "blocked" || status === "completed" || status === "failed" || status === "stopped";
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} must be a non-empty string.`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Honeycrisp capture schema version is invalid.");
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
