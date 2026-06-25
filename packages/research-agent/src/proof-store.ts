import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDefaultMemoryDatabasePath } from "./memory-event-log.js";
import {
  isResearchProofAttemptStatus,
  isResearchProofMethodKind,
  isResearchProofObligationStatus,
  isResearchProofResultStatus,
  isResearchProofSubjectKind,
} from "./memory-contracts.js";
import type {
  ResearchArtifactRef,
  ResearchEvent,
  ResearchProofAttempt,
  ResearchProofAttemptStatus,
  ResearchProofMethodDescriptor,
  ResearchProofObligation,
  ResearchProofObligationStatus,
  ResearchProofResultStatus,
  ResearchProofStateReadModel,
  ResearchProofSubjectRef,
} from "./types.js";

const require = createRequire(import.meta.url);

export interface ListProofObligationsOptions {
  status?: ResearchProofObligationStatus;
  goalId?: string;
  subGoalId?: string;
  findingRecordId?: string;
  subjectId?: string;
}

export interface ListProofAttemptsOptions {
  obligationId?: string;
  status?: ResearchProofAttemptStatus;
  result?: ResearchProofResultStatus;
  sourceEventId?: string;
}

export interface ProofStore {
  writeObligation(obligation: ResearchProofObligation): ResearchProofObligation;
  writeAttempt(attempt: ResearchProofAttempt): ResearchProofAttempt;
  applyEvent(event: ResearchEvent): readonly (ResearchProofObligation | ResearchProofAttempt)[];
  getObligationById(obligationId: string): ResearchProofObligation | undefined;
  getAttemptById(attemptId: string): ResearchProofAttempt | undefined;
  listObligations(options?: ListProofObligationsOptions): readonly ResearchProofObligation[];
  listAttempts(options?: ListProofAttemptsOptions): readonly ResearchProofAttempt[];
  readState(): ResearchProofStateReadModel;
  close(): void;
}

export interface SqliteProofStoreOptions {
  workspaceRoot?: string;
  databasePath?: string;
}

export function createSqliteProofStore(
  options: SqliteProofStoreOptions = {},
): SqliteProofStore {
  return new SqliteProofStore(options);
}

export class SqliteProofStore implements ProofStore {
  readonly databasePath: string;

  private readonly database: DatabaseSync;

  constructor(options: SqliteProofStoreOptions = {}) {
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.databasePath =
      options.databasePath ?? getDefaultMemoryDatabasePath(workspaceRoot);

    if (this.databasePath !== ":memory:") {
      mkdirSync(dirname(this.databasePath), { recursive: true });
    }

    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };
    this.database = new DatabaseSync(this.databasePath);
    this.initializeSchema();
  }

  writeObligation(obligation: ResearchProofObligation): ResearchProofObligation {
    validateProofObligation(obligation);
    this.database
      .prepare(
        [
          "INSERT OR REPLACE INTO proof_obligations (",
          "obligation_id, status, subject_kind, subject_id, goal_id, sub_goal_id,",
          "created_at, updated_at, obligation_json",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        obligation.id,
        obligation.status,
        obligation.subject.kind,
        obligation.subject.id,
        obligation.goalId ?? null,
        obligation.subGoalId ?? null,
        obligation.createdAt,
        obligation.updatedAt,
        JSON.stringify(obligation),
      );

    return obligation;
  }

  writeAttempt(attempt: ResearchProofAttempt): ResearchProofAttempt {
    validateProofAttempt(attempt);
    this.database
      .prepare(
        [
          "INSERT OR REPLACE INTO proof_attempts (",
          "attempt_id, obligation_id, status, result, verifier, created_at, updated_at, attempt_json",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        attempt.id,
        attempt.obligationId,
        attempt.status,
        attempt.result ?? null,
        attempt.verifier ?? null,
        attempt.createdAt,
        attempt.updatedAt,
        JSON.stringify(attempt),
      );
    this.database
      .prepare("DELETE FROM proof_attempt_source_events WHERE attempt_id = ?")
      .run(attempt.id);
    const sourceStatement = this.database.prepare(
      "INSERT OR IGNORE INTO proof_attempt_source_events(attempt_id, source_event_id) VALUES (?, ?)",
    );
    for (const sourceEventId of attempt.sourceEventIds) {
      sourceStatement.run(attempt.id, sourceEventId);
    }

    return attempt;
  }

  applyEvent(
    event: ResearchEvent,
  ): readonly (ResearchProofObligation | ResearchProofAttempt)[] {
    switch (event.kind) {
      case "proof.requested": {
        const obligation = createProofObligationFromEvent(event);
        this.writeObligation(obligation);
        return [obligation];
      }
      case "proof.attempted":
      case "proof.observed":
      case "proof.reviewed": {
        const attempt = createProofAttemptFromEvent(event);
        this.writeAttempt(attempt);
        return [attempt];
      }
      default:
        return [];
    }
  }

  getObligationById(obligationId: string): ResearchProofObligation | undefined {
    const row = this.database
      .prepare("SELECT obligation_json FROM proof_obligations WHERE obligation_id = ?")
      .get(obligationId);

    return row ? rowToObligation(row) : undefined;
  }

  getAttemptById(attemptId: string): ResearchProofAttempt | undefined {
    const row = this.database
      .prepare("SELECT attempt_json FROM proof_attempts WHERE attempt_id = ?")
      .get(attemptId);

    return row ? rowToAttempt(row) : undefined;
  }

  listObligations(
    options: ListProofObligationsOptions = {},
  ): readonly ResearchProofObligation[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.goalId) {
      clauses.push("goal_id = ?");
      params.push(options.goalId);
    }
    if (options.subGoalId) {
      clauses.push("sub_goal_id = ?");
      params.push(options.subGoalId);
    }
    if (options.subjectId) {
      clauses.push("subject_id = ?");
      params.push(options.subjectId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        [
          "SELECT obligation_json FROM proof_obligations",
          where,
          "ORDER BY updated_at DESC, obligation_id ASC",
        ].join(" "),
      )
      .all(...params);

    const obligations = rows.map(rowToObligation);

    return options.findingRecordId
      ? obligations.filter((obligation) =>
          obligation.findingRecordIds.includes(options.findingRecordId as string),
        )
      : obligations;
  }

  listAttempts(
    options: ListProofAttemptsOptions = {},
  ): readonly ResearchProofAttempt[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.obligationId) {
      clauses.push("a.obligation_id = ?");
      params.push(options.obligationId);
    }
    if (options.status) {
      clauses.push("a.status = ?");
      params.push(options.status);
    }
    if (options.result) {
      clauses.push("a.result = ?");
      params.push(options.result);
    }
    if (options.sourceEventId) {
      clauses.push(
        "EXISTS (SELECT 1 FROM proof_attempt_source_events se WHERE se.attempt_id = a.attempt_id AND se.source_event_id = ?)",
      );
      params.push(options.sourceEventId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        [
          "SELECT a.attempt_json FROM proof_attempts a",
          where,
          "ORDER BY a.updated_at DESC, a.attempt_id ASC",
        ].join(" "),
      )
      .all(...params);

    return rows.map(rowToAttempt);
  }

  readState(): ResearchProofStateReadModel {
    return {
      obligations: this.listObligations(),
      attempts: this.listAttempts(),
    };
  }

  close(): void {
    this.database.close();
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS proof_obligations (
        obligation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        goal_id TEXT,
        sub_goal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        obligation_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proof_attempts (
        attempt_id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        verifier TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attempt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proof_attempt_source_events (
        attempt_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        PRIMARY KEY(attempt_id, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS proof_obligations_status_idx ON proof_obligations(status);
      CREATE INDEX IF NOT EXISTS proof_obligations_subject_idx ON proof_obligations(subject_kind, subject_id);
      CREATE INDEX IF NOT EXISTS proof_obligations_goal_idx ON proof_obligations(goal_id);
      CREATE INDEX IF NOT EXISTS proof_attempts_obligation_idx ON proof_attempts(obligation_id);
      CREATE INDEX IF NOT EXISTS proof_attempts_status_idx ON proof_attempts(status);
      CREATE INDEX IF NOT EXISTS proof_attempts_result_idx ON proof_attempts(result);
      CREATE INDEX IF NOT EXISTS proof_attempt_source_events_event_idx ON proof_attempt_source_events(source_event_id);
    `);
  }
}

export function createProofObligationFromEvent(
  event: ResearchEvent,
): ResearchProofObligation {
  const payload = isRecord(event.payload) ? event.payload : {};
  const subject = readSubject(payload);
  const requiredResult = readProofResult(payload, "requiredResult");

  return {
    id: readString(payload, "obligationId") ?? createStableProofId("proof_obl", event),
    status: readObligationStatus(payload, "open"),
    subject,
    question:
      readString(payload, "question") ??
      readString(payload, "summary") ??
      "Verify the referenced research subject.",
    acceptableMethods: readMethods(payload),
    ...(requiredResult ? { requiredResult } : {}),
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.subGoalId ? { subGoalId: event.subGoalId } : {}),
    findingRecordIds: readStringArray(payload, "findingRecordIds"),
    hypothesisRecordIds: readStringArray(payload, "hypothesisRecordIds"),
    claimRecordIds: readStringArray(payload, "claimRecordIds"),
    evidenceRefIds: readStringArray(payload, "evidenceRefIds"),
    artifactRefs: readArtifactRefs(payload, event),
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    ...(isRecord(payload.domainMetadata)
      ? { domainMetadata: payload.domainMetadata }
      : {}),
  };
}

export function createProofAttemptFromEvent(
  event: ResearchEvent,
): ResearchProofAttempt {
  const payload = isRecord(event.payload) ? event.payload : {};
  const method = readMethod(payload);
  const result = readProofResult(payload, "result");
  const verifier = readString(payload, "verifier");

  return {
    id: readString(payload, "attemptId") ?? createStableProofId("proof_attempt", event),
    obligationId:
      readString(payload, "obligationId") ??
      createStableProofId("proof_obl", event, "implicit"),
    status: readAttemptStatus(payload, defaultAttemptStatus(event)),
    method,
    summary:
      readString(payload, "summary") ??
      readString(payload, "resultSummary") ??
      `${event.kind} via ${method.name}`,
    ...(result ? { result } : {}),
    ...(verifier ? { verifier } : {}),
    sourceEventIds: [event.id],
    evidenceRefIds: readStringArray(payload, "evidenceRefIds"),
    artifactRefs: readArtifactRefs(payload, event),
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    ...(isRecord(payload.domainMetadata)
      ? { domainMetadata: payload.domainMetadata }
      : {}),
  };
}

function validateProofObligation(obligation: ResearchProofObligation): void {
  if (!obligation.id.startsWith("proof_obl_")) {
    throw new Error(`Proof obligation id must use proof_obl_ prefix: ${obligation.id}`);
  }
  if (!isResearchProofObligationStatus(obligation.status)) {
    throw new Error(`Unsupported proof obligation status: ${obligation.status}`);
  }
  if (!isResearchProofSubjectKind(obligation.subject.kind)) {
    throw new Error(`Unsupported proof subject kind: ${obligation.subject.kind}`);
  }
  if (obligation.question.trim().length === 0) {
    throw new Error(`Proof obligation question is required: ${obligation.id}`);
  }
  for (const method of obligation.acceptableMethods) {
    validateProofMethod(method);
  }
}

function validateProofAttempt(attempt: ResearchProofAttempt): void {
  if (!attempt.id.startsWith("proof_attempt_")) {
    throw new Error(`Proof attempt id must use proof_attempt_ prefix: ${attempt.id}`);
  }
  if (!attempt.obligationId.startsWith("proof_obl_")) {
    throw new Error(`Proof attempt obligation id must use proof_obl_ prefix: ${attempt.obligationId}`);
  }
  if (!isResearchProofAttemptStatus(attempt.status)) {
    throw new Error(`Unsupported proof attempt status: ${attempt.status}`);
  }
  if (attempt.result && !isResearchProofResultStatus(attempt.result)) {
    throw new Error(`Unsupported proof result: ${attempt.result}`);
  }
  if (attempt.summary.trim().length === 0) {
    throw new Error(`Proof attempt summary is required: ${attempt.id}`);
  }
  if (attempt.sourceEventIds.length === 0) {
    throw new Error(`Proof attempt source events are required: ${attempt.id}`);
  }
  validateProofMethod(attempt.method);
}

function validateProofMethod(method: ResearchProofMethodDescriptor): void {
  if (!isResearchProofMethodKind(method.kind)) {
    throw new Error(`Unsupported proof method kind: ${method.kind}`);
  }
  if (method.name.trim().length === 0) {
    throw new Error("Proof method name is required.");
  }
}

function rowToObligation(row: Record<string, unknown>): ResearchProofObligation {
  const value = row.obligation_json;
  if (typeof value !== "string") {
    throw new Error("Expected proof obligation row to contain obligation_json.");
  }
  const obligation = JSON.parse(value) as ResearchProofObligation;
  validateProofObligation(obligation);

  return obligation;
}

function rowToAttempt(row: Record<string, unknown>): ResearchProofAttempt {
  const value = row.attempt_json;
  if (typeof value !== "string") {
    throw new Error("Expected proof attempt row to contain attempt_json.");
  }
  const attempt = JSON.parse(value) as ResearchProofAttempt;
  validateProofAttempt(attempt);

  return attempt;
}

function readSubject(payload: Record<string, unknown>): ResearchProofSubjectRef {
  const subject = payload.subject;
  if (isRecord(subject)) {
    const kind = readString(subject, "kind");
    const id = readString(subject, "id");
    const summary = readString(subject, "summary");
    if (kind && id && isResearchProofSubjectKind(kind)) {
      return {
        kind,
        id,
        ...(summary ? { summary } : {}),
      };
    }
  }
  const subjectSummary = readString(payload, "subjectSummary");

  return {
    kind: "external",
    id: readString(payload, "subjectId") ?? "unspecified",
    ...(subjectSummary ? { summary: subjectSummary } : {}),
  };
}

function readMethods(
  payload: Record<string, unknown>,
): readonly ResearchProofMethodDescriptor[] {
  const value = payload.acceptableMethods;
  if (Array.isArray(value)) {
    const methods = value.filter(isRecord).map(readMethod).filter(Boolean);
    if (methods.length > 0) {
      return methods;
    }
  }

  return [readMethod(payload)];
}

function readMethod(
  payload: Record<string, unknown>,
): ResearchProofMethodDescriptor {
  const method = isRecord(payload.method) ? payload.method : payload;
  const kind = readString(method, "kind");
  const name = readString(method, "name") ?? readString(method, "methodName");
  const methodKind = kind && isResearchProofMethodKind(kind)
    ? kind
    : "human_review";
  const description = readString(method, "description");
  const toolNames = readStringArray(method, "toolNames");
  const skillIds = readStringArray(method, "skillIds");
  const mcpServerIds = readStringArray(method, "mcpServerIds");
  const artifactRequirements = readStringArray(method, "artifactRequirements");

  return {
    kind: methodKind,
    name: name ?? labelForMethodKind(methodKind),
    ...(description ? { description } : {}),
    ...(toolNames.length > 0 ? { toolNames } : {}),
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    ...(artifactRequirements.length > 0 ? { artifactRequirements } : {}),
    ...(isRecord(method.domainMetadata)
      ? { domainMetadata: method.domainMetadata }
      : {}),
  };
}

function readObligationStatus(
  payload: Record<string, unknown>,
  fallback: ResearchProofObligationStatus,
): ResearchProofObligationStatus {
  const status = readString(payload, "status");

  return status && isResearchProofObligationStatus(status) ? status : fallback;
}

function readAttemptStatus(
  payload: Record<string, unknown>,
  fallback: ResearchProofAttemptStatus,
): ResearchProofAttemptStatus {
  const status = readString(payload, "status");

  return status && isResearchProofAttemptStatus(status) ? status : fallback;
}

function readProofResult(
  payload: Record<string, unknown>,
  key: string,
): ResearchProofResultStatus | undefined {
  const result = readString(payload, key);

  return result && isResearchProofResultStatus(result) ? result : undefined;
}

function defaultAttemptStatus(event: ResearchEvent): ResearchProofAttemptStatus {
  return event.kind === "proof.attempted" ? "planned" : "completed";
}

function readArtifactRefs(
  payload: Record<string, unknown>,
  event: ResearchEvent,
): readonly ResearchArtifactRef[] {
  const payloadRefs = Array.isArray(payload.artifactRefs)
    ? payload.artifactRefs.filter(isArtifactRef)
    : [];

  return payloadRefs.length > 0 ? payloadRefs : event.artifactRefs ?? [];
}

function isArtifactRef(value: unknown): value is ResearchArtifactRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string"
  );
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function labelForMethodKind(kind: ResearchProofMethodDescriptor["kind"]): string {
  return kind.replaceAll("_", " ");
}

function createStableProofId(
  prefix: "proof_obl" | "proof_attempt",
  event: ResearchEvent,
  discriminator = "",
): string {
  const hash = createHash("sha256")
    .update(prefix)
    .update("\0")
    .update(event.id)
    .update("\0")
    .update(discriminator)
    .digest("hex")
    .slice(0, 24);

  return `${prefix}_${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
