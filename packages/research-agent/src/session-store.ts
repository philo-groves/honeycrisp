import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  request: Record<string, unknown>;
  agent: Record<string, unknown>;
  researchProfile?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  storageManifest?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  raw: Record<string, unknown>;
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
};

export interface HoneycrispSessionUpdate {
  session: HoneycrispSessionSummary;
  finalResponse: string | null;
  events: HoneycrispSessionEvent[];
  eventOffset: number;
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

export class HoneycrispSessionStore {
  public readonly databasePath: string;
  private readonly database: DatabaseSync;

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
    this.database.exec(`
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
        id, workspace_id, status, title, summary, document_json, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.status,
      record.title,
      record.summary,
      JSON.stringify(record),
      record.revision,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  public get(sessionId: string): HoneycrispSessionRecord | null {
    const row = this.database.prepare(
      "SELECT document_json FROM honeycrisp_sessions WHERE id = ?",
    ).get(requiredString(sessionId, "Session id")) as { document_json?: unknown } | undefined;
    return row ? decodeStoredSession(row.document_json) : null;
  }

  public list(workspaceId: string, limit = 100): HoneycrispSessionRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT document_json FROM honeycrisp_sessions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(requiredString(workspaceId, "Workspace id"), boundedLimit) as Array<{ document_json?: unknown }>;
    return rows.map((row) => decodeStoredSession(row.document_json));
  }

  public listSummaries(workspaceId: string, limit = 100): HoneycrispSessionSummary[] {
    return this.list(workspaceId, limit).map(sessionSummary);
  }

  public listForWorkspaces(workspaceIds: readonly string[], limitPerWorkspace = 100): HoneycrispSessionRecord[] {
    const normalizedWorkspaceIds = [...new Set(workspaceIds.map((workspaceId) => requiredString(workspaceId, "Workspace id")))];
    if (normalizedWorkspaceIds.length === 0) return [];
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limitPerWorkspace)));
    const placeholders = normalizedWorkspaceIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT document_json FROM (
        SELECT document_json, updated_at, id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id
            ORDER BY updated_at DESC, id DESC
          ) AS workspace_rank
        FROM honeycrisp_sessions
        WHERE workspace_id IN (${placeholders})
      )
      WHERE workspace_rank <= ?
      ORDER BY updated_at DESC, id DESC
    `).all(...normalizedWorkspaceIds, boundedLimit) as Array<{ document_json?: unknown }>;
    return rows.map((row) => decodeStoredSession(row.document_json));
  }

  public listSummariesForWorkspaces(
    workspaceIds: readonly string[],
    limitPerWorkspace = 100,
  ): HoneycrispSessionSummary[] {
    return this.listForWorkspaces(workspaceIds, limitPerWorkspace).map(sessionSummary);
  }

  public getUpdate(sessionId: string, afterEventId?: string | null): HoneycrispSessionUpdate | null {
    const session = this.get(sessionId);
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
        SELECT document_json FROM honeycrisp_sessions
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY updated_at ASC, id ASC
      `).all(normalizedWorkspaceId) as Array<{ document_json?: unknown }>;
      const sessions = rows.map((row) => decodeStoredSession(row.document_json));
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
        session.events.push({
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
        session.revision += 1;
        session.updatedAt = recoveredAt;
        const result = this.database.prepare(`
          UPDATE honeycrisp_sessions
          SET status = ?, summary = ?, document_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'active'
        `).run(
          session.status,
          session.summary,
          JSON.stringify(session),
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
    return this.mutate(sessionId, undefined, (session) => {
      const normalized = normalizeEvent(event);
      if (session.events.some((candidate) => candidate.id === normalized.id)) return;
      session.events.push(normalized);
      if (normalized.kind === "session.title") {
        const payload = recordValue(normalized.payload);
        const title = optionalString(payload?.title);
        if (payload?.status === "generated" && title) session.title = title;
      }
    });
  }

  public appendEventReceipt(sessionId: string, event: HoneycrispSessionEvent): HoneycrispSessionMutationReceipt {
    return sessionMutationReceipt(this.appendEvent(sessionId, event));
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

      attempt.capture = {
        attemptId: attempt.id,
        capturedAt,
        schemaVersion: numberValue(capture.schemaVersion),
        request: recordValue(capture.request) ?? {},
        agent,
        ...(recordValue(capture.researchProfile) ? { researchProfile: recordValue(capture.researchProfile)! } : {}),
        ...(recordValue(capture.storage) ? { storage: recordValue(capture.storage)! } : {}),
        ...(recordValue(capture.storageManifest) ? { storageManifest: recordValue(capture.storageManifest)! } : {}),
        ...(recordValue(capture.runtimeConfig) ? { runtimeConfig: recordValue(capture.runtimeConfig)! } : {}),
        raw: capture,
      };
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
      const session = this.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (expectedRevision !== undefined && session.revision !== expectedRevision) {
        throw new Error(
          `Session revision conflict for ${sessionId}: expected ${expectedRevision}, received ${session.revision}.`,
        );
      }
      update(session);
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE honeycrisp_sessions
        SET status = ?, title = ?, summary = ?, document_json = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        session.status,
        session.title,
        session.summary,
        JSON.stringify(session),
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
}

function sessionSummary(session: HoneycrispSessionRecord): HoneycrispSessionSummary {
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
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
  };
}

function sessionMutationReceipt(session: HoneycrispSessionRecord): HoneycrispSessionMutationReceipt {
  return {
    sessionId: session.id,
    status: session.status,
    revision: session.revision,
    updatedAt: session.updatedAt,
  };
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
