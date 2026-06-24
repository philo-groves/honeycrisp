import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  getDefaultMemoryDatabasePath,
  type SqliteMemoryEventLogOptions,
} from "./memory-event-log.js";
import {
  isResearchDerivedMemoryStatus,
  isResearchMemoryRecordKind,
} from "./memory-contracts.js";
import { createEmptyMemorySnapshot } from "./context-packet.js";
import type {
  ResearchClaimGraphEdge,
  ResearchClaimGraphRelationship,
  ResearchDerivedMemoryRecord,
  ResearchDerivedMemoryStatus,
  ResearchEvent,
  ResearchMemoryAuditOperation,
  ResearchMemoryAuditRecord,
  ResearchMemoryRef,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
} from "./types.js";

const require = createRequire(import.meta.url);

export interface ListMemoryRecordsOptions {
  kind?: ResearchDerivedMemoryRecord["kind"];
  status?: ResearchDerivedMemoryStatus;
  goalId?: string;
  subGoalId?: string;
  sourceEventId?: string;
  tag?: string;
  entity?: string;
  includeAudited?: boolean;
}

export interface UpdateMemoryRecordStatusInput {
  recordId: string;
  status: ResearchDerivedMemoryStatus;
  updatedAt: string;
  summary?: string;
  confidence?: number;
  evidenceFor?: readonly ResearchDerivedMemoryRecord["provenance"]["evidenceFor"][number][];
  evidenceAgainst?: readonly ResearchDerivedMemoryRecord["provenance"]["evidenceAgainst"][number][];
  supersededByRecordId?: string;
}

export interface ListClaimGraphEdgesOptions {
  sourceRecordId?: string;
  targetRecordId?: string;
  relationship?: ResearchClaimGraphRelationship;
  includeEvidenceEdges?: boolean;
}

export interface ListMemoryAuditRecordsOptions {
  recordId?: string;
  operation?: ResearchMemoryAuditOperation;
}

export interface DeleteMemoryRecordForPolicyInput {
  recordId: string;
  policy: string;
  timestamp: string;
  summary: string;
}

export interface MemoryRecordStore {
  write(record: ResearchDerivedMemoryRecord): ResearchDerivedMemoryRecord;
  writeMany(
    records: readonly ResearchDerivedMemoryRecord[],
  ): readonly ResearchDerivedMemoryRecord[];
  getById(recordId: string): ResearchDerivedMemoryRecord | undefined;
  list(options?: ListMemoryRecordsOptions): readonly ResearchDerivedMemoryRecord[];
  updateStatus(input: UpdateMemoryRecordStatusInput): ResearchDerivedMemoryRecord;
  addClaimGraphEdge(
    edge: Omit<ResearchClaimGraphEdge, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): ResearchClaimGraphEdge;
  listClaimGraphEdges(
    options?: ListClaimGraphEdgesOptions,
  ): readonly ResearchClaimGraphEdge[];
  listAuditRecords(
    options?: ListMemoryAuditRecordsOptions,
  ): readonly ResearchMemoryAuditRecord[];
  deleteRecordForPolicy(input: DeleteMemoryRecordForPolicyInput): void;
  close(): void;
}

export interface SqliteMemoryRecordStoreOptions
  extends Pick<SqliteMemoryEventLogOptions, "workspaceRoot" | "databasePath"> {}

export function createSqliteMemoryRecordStore(
  options: SqliteMemoryRecordStoreOptions = {},
): SqliteMemoryRecordStore {
  return new SqliteMemoryRecordStore(options);
}

export function createMemorySnapshotFromRecords(
  records: readonly ResearchDerivedMemoryRecord[],
  eventLog: readonly ResearchEvent[] = [],
): ResearchMemorySnapshot {
  const snapshot = createEmptyMemorySnapshot(eventLog);

  for (const record of records) {
    if (
      record.status === "tombstoned" ||
      record.status === "superseded" ||
      record.status === "stale"
    ) {
      continue;
    }

    if (record.kind === "prospective_check") {
      if (record.tags.includes("user-commitment")) {
        appendUniqueString(snapshot.userCommitments as string[], record.summary);
      } else {
        appendUniqueString(
          snapshot.prospectiveCommitments as string[],
          record.summary,
        );
      }
      continue;
    }

    const ref = createMemoryRef(record);

    if (record.kind === "evidence") {
      if (
        record.status === "contradicted" ||
        record.tags.includes("contradiction")
      ) {
        appendUniqueRef(snapshot.contradictions as ResearchMemoryRef[], ref);
      } else {
        appendUniqueRef(snapshot.directEvidence as ResearchMemoryRef[], ref);
      }
      continue;
    }
    if (record.kind === "semantic_claim" || record.kind === "hypothesis") {
      appendUniqueRef(snapshot.currentHypotheses as ResearchMemoryRef[], ref);
      continue;
    }
    if (record.kind === "procedure") {
      appendUniqueRef(snapshot.candidateProcedures as ResearchMemoryRef[], ref);
      continue;
    }

    appendUniqueRef(snapshot.priorEpisodes as ResearchMemoryRef[], ref);
  }

  return snapshot;
}

export function createMemorySnapshotFromRecordStore(
  store: MemoryRecordStore,
  eventLog: readonly ResearchEvent[] = [],
): ResearchMemorySnapshot {
  return createMemorySnapshotFromRecords(store.list(), eventLog);
}

export class SqliteMemoryRecordStore implements MemoryRecordStore {
  readonly databasePath: string;

  private readonly database: DatabaseSync;

  constructor(options: SqliteMemoryRecordStoreOptions = {}) {
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

  write(record: ResearchDerivedMemoryRecord): ResearchDerivedMemoryRecord {
    return this.writeMany([record])[0] as ResearchDerivedMemoryRecord;
  }

  writeMany(
    records: readonly ResearchDerivedMemoryRecord[],
  ): readonly ResearchDerivedMemoryRecord[] {
    if (records.length === 0) {
      return [];
    }

    return this.withTransaction(() => {
      const seen = new Set<string>();

      for (const record of records) {
        if (seen.has(record.id)) {
          throw new Error(`Duplicate memory record id in write batch: ${record.id}`);
        }
        seen.add(record.id);
        validateMemoryRecord(record);
        this.insertRecord(record);
        this.appendAuditRecord(createAuditRecord({
          recordId: record.id,
          operation: isPromotedProcedure(record) ? "promotion" : "write",
          timestamp: record.createdAt,
          summary: isPromotedProcedure(record)
            ? `Promoted procedure record ${record.id}.`
            : `Wrote memory record ${record.id}.`,
        }));
      }

      return [...records];
    });
  }

  getById(recordId: string): ResearchDerivedMemoryRecord | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM memory_records WHERE record_id = ?")
      .get(recordId);

    return row ? rowToRecord(row) : undefined;
  }

  list(
    options: ListMemoryRecordsOptions = {},
  ): readonly ResearchDerivedMemoryRecord[] {
    const clauses: string[] = [];
    const params: (number | string)[] = [];

    if (options.kind) {
      clauses.push("r.kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      clauses.push("r.status = ?");
      params.push(options.status);
    } else if (!options.includeAudited) {
      clauses.push("r.status NOT IN ('superseded', 'tombstoned', 'stale')");
    }
    if (options.goalId) {
      clauses.push("r.goal_id = ?");
      params.push(options.goalId);
    }
    if (options.subGoalId) {
      clauses.push("r.sub_goal_id = ?");
      params.push(options.subGoalId);
    }
    if (options.sourceEventId) {
      clauses.push(
        "EXISTS (SELECT 1 FROM memory_record_source_events se WHERE se.record_id = r.record_id AND se.source_event_id = ?)",
      );
      params.push(options.sourceEventId);
    }
    if (options.tag) {
      clauses.push(
        "EXISTS (SELECT 1 FROM memory_record_tags t WHERE t.record_id = r.record_id AND t.tag = ?)",
      );
      params.push(options.tag);
    }
    if (options.entity) {
      clauses.push(
        "EXISTS (SELECT 1 FROM memory_record_entities e WHERE e.record_id = r.record_id AND e.entity = ?)",
      );
      params.push(options.entity);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        [
          "SELECT r.record_json FROM memory_records r",
          where,
          "ORDER BY r.updated_at DESC, r.record_id ASC",
        ].join(" "),
      )
      .all(...params);

    return rows.map(rowToRecord);
  }

  updateStatus(
    input: UpdateMemoryRecordStatusInput,
  ): ResearchDerivedMemoryRecord {
    return this.withTransaction(() => {
      const existing = this.getById(input.recordId);
      if (!existing) {
        throw new Error(`Memory record not found: ${input.recordId}`);
      }
      if (!isResearchDerivedMemoryStatus(input.status)) {
        throw new Error(`Unsupported memory record status: ${input.status}`);
      }

      const next = {
        ...existing,
        status: input.status,
        updatedAt: input.updatedAt,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(typeof input.confidence === "number"
          ? { confidence: input.confidence }
          : {}),
        provenance: {
          ...existing.provenance,
          evidenceFor: mergeEvidenceRefs(
            existing.provenance.evidenceFor,
            input.evidenceFor ?? [],
          ),
          evidenceAgainst: mergeEvidenceRefs(
            existing.provenance.evidenceAgainst,
            input.evidenceAgainst ?? [],
          ),
        },
        evidenceRefIds: mergeStrings(existing.evidenceRefIds, [
          ...(input.evidenceFor ?? []).map((ref) => ref.id),
          ...(input.evidenceAgainst ?? []).map((ref) => ref.id),
        ]),
      } satisfies ResearchDerivedMemoryRecord;

      this.deleteRecordIndexes(input.recordId);
      this.replaceRecord(next);
      if (input.supersededByRecordId) {
        this.addClaimGraphEdge({
          sourceRecordId: input.supersededByRecordId,
          targetRecordId: input.recordId,
          relationship: "supersedes",
          summary: `Record ${input.supersededByRecordId} supersedes ${input.recordId}.`,
          createdAt: input.updatedAt,
        });
      }
      this.appendAuditRecord(createAuditRecord({
        recordId: input.recordId,
        operation: operationForStatus(input.status),
        timestamp: input.updatedAt,
        summary: `Updated memory record ${input.recordId} to ${input.status}.`,
        ...(input.supersededByRecordId
          ? { relatedRecordId: input.supersededByRecordId }
          : {}),
      }));

      return next;
    });
  }

  addClaimGraphEdge(
    edge: Omit<ResearchClaimGraphEdge, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): ResearchClaimGraphEdge {
    validateClaimGraphRelationship(edge.relationship);

    const createdAt = edge.createdAt ?? new Date().toISOString();
    const fullEdge: ResearchClaimGraphEdge = {
      id:
        edge.id ??
        createClaimGraphEdgeId({
          sourceRecordId: edge.sourceRecordId,
          relationship: edge.relationship,
          ...(edge.targetRecordId ? { targetRecordId: edge.targetRecordId } : {}),
          ...(edge.evidenceRefId ? { evidenceRefId: edge.evidenceRefId } : {}),
          ...(edge.summary ? { summary: edge.summary } : {}),
        }),
      sourceRecordId: edge.sourceRecordId,
      relationship: edge.relationship,
      createdAt,
      ...(edge.targetRecordId ? { targetRecordId: edge.targetRecordId } : {}),
      ...(edge.evidenceRefId ? { evidenceRefId: edge.evidenceRefId } : {}),
      ...(edge.summary ? { summary: edge.summary } : {}),
    };

    this.database
      .prepare(
        [
          "INSERT OR IGNORE INTO memory_claim_graph_edges (",
          "edge_id, source_record_id, relationship, target_record_id, evidence_ref_id, summary, created_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        fullEdge.id,
        fullEdge.sourceRecordId,
        fullEdge.relationship,
        fullEdge.targetRecordId ?? null,
        fullEdge.evidenceRefId ?? null,
        fullEdge.summary ?? null,
        fullEdge.createdAt,
      );

    return fullEdge;
  }

  listClaimGraphEdges(
    options: ListClaimGraphEdgesOptions = {},
  ): readonly ResearchClaimGraphEdge[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.sourceRecordId) {
      clauses.push("source_record_id = ?");
      params.push(options.sourceRecordId);
    }
    if (options.targetRecordId) {
      clauses.push("target_record_id = ?");
      params.push(options.targetRecordId);
    }
    if (options.relationship) {
      clauses.push("relationship = ?");
      params.push(options.relationship);
    }
    if (!options.includeEvidenceEdges) {
      clauses.push("target_record_id IS NOT NULL");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        [
          "SELECT edge_id, source_record_id, relationship, target_record_id, evidence_ref_id, summary, created_at",
          "FROM memory_claim_graph_edges",
          where,
          "ORDER BY created_at ASC, edge_id ASC",
        ].join(" "),
      )
      .all(...params);

    return rows.map(rowToClaimGraphEdge);
  }

  listAuditRecords(
    options: ListMemoryAuditRecordsOptions = {},
  ): readonly ResearchMemoryAuditRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];

    if (options.recordId) {
      clauses.push("record_id = ?");
      params.push(options.recordId);
    }
    if (options.operation) {
      clauses.push("operation = ?");
      params.push(options.operation);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        [
          "SELECT audit_id, record_id, operation, timestamp, summary, policy, related_record_id",
          "FROM memory_record_audit",
          where,
          "ORDER BY timestamp ASC, audit_id ASC",
        ].join(" "),
      )
      .all(...params);

    return rows.map(rowToAuditRecord);
  }

  deleteRecordForPolicy(input: DeleteMemoryRecordForPolicyInput): void {
    this.withTransaction(() => {
      const existing = this.getById(input.recordId);
      if (!existing) {
        throw new Error(`Memory record not found: ${input.recordId}`);
      }

      this.database
        .prepare("DELETE FROM memory_records WHERE record_id = ?")
        .run(input.recordId);
      this.appendAuditRecord(createAuditRecord({
        recordId: input.recordId,
        operation: "deletion",
        timestamp: input.timestamp,
        summary: input.summary,
        policy: input.policy,
      }));
    });
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

      CREATE TABLE IF NOT EXISTS memory_records (
        record_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        goal_id TEXT,
        sub_goal_id TEXT,
        confidence REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        source_event_ids_json TEXT NOT NULL,
        evidence_ref_ids_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_record_source_events (
        record_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        PRIMARY KEY (record_id, source_event_id),
        FOREIGN KEY (record_id) REFERENCES memory_records(record_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_record_tags (
        record_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (record_id, tag),
        FOREIGN KEY (record_id) REFERENCES memory_records(record_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_record_entities (
        record_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        PRIMARY KEY (record_id, entity),
        FOREIGN KEY (record_id) REFERENCES memory_records(record_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_claim_graph_edges (
        edge_id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        target_record_id TEXT,
        evidence_ref_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_record_audit (
        audit_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        summary TEXT NOT NULL,
        policy TEXT,
        related_record_id TEXT
      );

      CREATE INDEX IF NOT EXISTS memory_records_source_event_idx ON memory_record_source_events(source_event_id, record_id);
      CREATE INDEX IF NOT EXISTS memory_records_goal_id_idx ON memory_records(goal_id);
      CREATE INDEX IF NOT EXISTS memory_records_sub_goal_id_idx ON memory_records(sub_goal_id);
      CREATE INDEX IF NOT EXISTS memory_records_status_idx ON memory_records(status);
      CREATE INDEX IF NOT EXISTS memory_records_kind_idx ON memory_records(kind);
      CREATE INDEX IF NOT EXISTS memory_records_confidence_idx ON memory_records(confidence);
      CREATE INDEX IF NOT EXISTS memory_records_updated_at_idx ON memory_records(updated_at);
      CREATE INDEX IF NOT EXISTS memory_record_tags_tag_idx ON memory_record_tags(tag, record_id);
      CREATE INDEX IF NOT EXISTS memory_record_entities_entity_idx ON memory_record_entities(entity, record_id);
      CREATE INDEX IF NOT EXISTS memory_claim_graph_source_idx ON memory_claim_graph_edges(source_record_id);
      CREATE INDEX IF NOT EXISTS memory_claim_graph_target_idx ON memory_claim_graph_edges(target_record_id);
      CREATE INDEX IF NOT EXISTS memory_claim_graph_relationship_idx ON memory_claim_graph_edges(relationship);
      CREATE INDEX IF NOT EXISTS memory_record_audit_record_idx ON memory_record_audit(record_id);
      CREATE INDEX IF NOT EXISTS memory_record_audit_operation_idx ON memory_record_audit(operation);

      INSERT OR IGNORE INTO memory_schema_migrations(version, name, applied_at)
      VALUES (2, 'phase_4_record_store', datetime('now'));
    `);
  }

  private insertRecord(record: ResearchDerivedMemoryRecord): void {
    this.insertRecordRow(record);
    this.insertRecordIndexes(record);
    this.insertEvidenceGraphEdges(record);
  }

  private replaceRecord(record: ResearchDerivedMemoryRecord): void {
    this.database.prepare("DELETE FROM memory_records WHERE record_id = ?").run(record.id);
    this.insertRecord(record);
  }

  private insertRecordRow(record: ResearchDerivedMemoryRecord): void {
    this.database
      .prepare(
        [
          "INSERT INTO memory_records (",
          "record_id, kind, status, summary, goal_id, sub_goal_id, confidence,",
          "created_at, updated_at, valid_from, valid_until,",
          "source_event_ids_json, evidence_ref_ids_json, tags_json, entities_json, record_json",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        record.id,
        record.kind,
        record.status,
        record.summary,
        record.goalId ?? null,
        record.subGoalId ?? null,
        record.confidence ?? null,
        record.createdAt,
        record.updatedAt,
        record.validFrom ?? null,
        record.validUntil ?? null,
        JSON.stringify([...record.sourceEventIds]),
        JSON.stringify([...record.evidenceRefIds]),
        JSON.stringify([...record.tags]),
        JSON.stringify([...record.entities]),
        JSON.stringify(record),
      );
  }

  private insertRecordIndexes(record: ResearchDerivedMemoryRecord): void {
    const sourceStatement = this.database.prepare(
      "INSERT OR IGNORE INTO memory_record_source_events(record_id, source_event_id) VALUES (?, ?)",
    );
    for (const sourceEventId of record.sourceEventIds) {
      sourceStatement.run(record.id, sourceEventId);
    }

    const tagStatement = this.database.prepare(
      "INSERT OR IGNORE INTO memory_record_tags(record_id, tag) VALUES (?, ?)",
    );
    for (const tag of record.tags) {
      tagStatement.run(record.id, tag);
    }

    const entityStatement = this.database.prepare(
      "INSERT OR IGNORE INTO memory_record_entities(record_id, entity) VALUES (?, ?)",
    );
    for (const entity of record.entities) {
      entityStatement.run(record.id, entity);
    }
  }

  private deleteRecordIndexes(recordId: string): void {
    this.database
      .prepare("DELETE FROM memory_record_source_events WHERE record_id = ?")
      .run(recordId);
    this.database
      .prepare("DELETE FROM memory_record_tags WHERE record_id = ?")
      .run(recordId);
    this.database
      .prepare("DELETE FROM memory_record_entities WHERE record_id = ?")
      .run(recordId);
  }

  private insertEvidenceGraphEdges(record: ResearchDerivedMemoryRecord): void {
    for (const evidenceRef of record.provenance.evidenceFor) {
      this.addClaimGraphEdge({
        sourceRecordId: record.id,
        relationship: "supports",
        evidenceRefId: evidenceRef.id,
        createdAt: record.createdAt,
        ...(evidenceRef.summary ? { summary: evidenceRef.summary } : {}),
      });
    }
    for (const evidenceRef of record.provenance.evidenceAgainst) {
      this.addClaimGraphEdge({
        sourceRecordId: record.id,
        relationship: "contradicts",
        evidenceRefId: evidenceRef.id,
        createdAt: record.createdAt,
        ...(evidenceRef.summary ? { summary: evidenceRef.summary } : {}),
      });
    }
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

  private appendAuditRecord(record: ResearchMemoryAuditRecord): void {
    this.database
      .prepare(
        [
          "INSERT OR IGNORE INTO memory_record_audit (",
          "audit_id, record_id, operation, timestamp, summary, policy, related_record_id",
          ") VALUES (?, ?, ?, ?, ?, ?, ?)",
        ].join(" "),
      )
      .run(
        record.id,
        record.recordId,
        record.operation,
        record.timestamp,
        record.summary,
        record.policy ?? null,
        record.relatedRecordId ?? null,
      );
  }
}

function validateMemoryRecord(record: ResearchDerivedMemoryRecord): void {
  if (!record.id.startsWith("mem_")) {
    throw new Error(`Memory record id must use mem_ prefix: ${record.id}`);
  }
  if (!isResearchMemoryRecordKind(record.kind)) {
    throw new Error(`Unsupported memory record kind: ${String(record.kind)}`);
  }
  if (!isResearchDerivedMemoryStatus(record.status)) {
    throw new Error(`Unsupported memory record status: ${String(record.status)}`);
  }
  if (record.summary.trim().length === 0) {
    throw new Error(`Memory record summary is required: ${record.id}`);
  }
  if (record.sourceEventIds.length === 0) {
    throw new Error(`Memory record sourceEventIds are required: ${record.id}`);
  }
}

function validateClaimGraphRelationship(
  relationship: ResearchClaimGraphRelationship,
): void {
  if (
    ![
      "supports",
      "contradicts",
      "refines",
      "supersedes",
      "depends_on",
    ].includes(relationship)
  ) {
    throw new Error(`Unsupported claim graph relationship: ${String(relationship)}`);
  }
}

function rowToRecord(row: Record<string, unknown>): ResearchDerivedMemoryRecord {
  const value = row.record_json;
  if (typeof value !== "string") {
    throw new Error("Expected memory record row to contain record_json.");
  }

  const record = JSON.parse(value) as ResearchDerivedMemoryRecord;
  validateMemoryRecord(record);

  return record;
}

function rowToClaimGraphEdge(
  row: Record<string, unknown>,
): ResearchClaimGraphEdge {
  const relationship = readString(row, "relationship") as ResearchClaimGraphRelationship;
  validateClaimGraphRelationship(relationship);

  const targetRecordId = readNullableString(row, "target_record_id");
  const evidenceRefId = readNullableString(row, "evidence_ref_id");
  const summary = readNullableString(row, "summary");

  return {
    id: readString(row, "edge_id"),
    sourceRecordId: readString(row, "source_record_id"),
    relationship,
    createdAt: readString(row, "created_at"),
    ...(targetRecordId ? { targetRecordId } : {}),
    ...(evidenceRefId ? { evidenceRefId } : {}),
    ...(summary ? { summary } : {}),
  };
}

function rowToAuditRecord(row: Record<string, unknown>): ResearchMemoryAuditRecord {
  const policy = readNullableString(row, "policy");
  const relatedRecordId = readNullableString(row, "related_record_id");

  return {
    id: readString(row, "audit_id"),
    recordId: readString(row, "record_id"),
    operation: readString(row, "operation") as ResearchMemoryAuditOperation,
    timestamp: readString(row, "timestamp"),
    summary: readString(row, "summary"),
    ...(policy ? { policy } : {}),
    ...(relatedRecordId ? { relatedRecordId } : {}),
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

function mergeEvidenceRefs(
  existing: readonly ResearchDerivedMemoryRecord["provenance"]["evidenceFor"][number][],
  incoming: readonly ResearchDerivedMemoryRecord["provenance"]["evidenceFor"][number][],
) {
  const byId = new Map(existing.map((ref) => [ref.id, ref]));
  for (const ref of incoming) {
    byId.set(ref.id, ref);
  }

  return [...byId.values()];
}

function mergeStrings(
  existing: readonly string[],
  incoming: readonly string[],
): readonly string[] {
  return [...new Set([...existing, ...incoming])];
}

function createClaimGraphEdgeId(input: {
  sourceRecordId: string;
  relationship: ResearchClaimGraphRelationship;
  targetRecordId?: string;
  evidenceRefId?: string;
  summary?: string;
}): string {
  const hash = createHash("sha256")
    .update(input.sourceRecordId)
    .update("\0")
    .update(input.relationship)
    .update("\0")
    .update(input.targetRecordId ?? "")
    .update("\0")
    .update(input.evidenceRefId ?? "")
    .update("\0")
    .update(input.summary ?? "")
    .digest("hex")
    .slice(0, 24);

  return `edge_${hash}`;
}

function createAuditRecord(input: {
  recordId: string;
  operation: ResearchMemoryAuditOperation;
  timestamp: string;
  summary: string;
  policy?: string;
  relatedRecordId?: string;
}): ResearchMemoryAuditRecord {
  const hash = createHash("sha256")
    .update(input.recordId)
    .update("\0")
    .update(input.operation)
    .update("\0")
    .update(input.timestamp)
    .update("\0")
    .update(input.summary)
    .update("\0")
    .update(input.policy ?? "")
    .update("\0")
    .update(input.relatedRecordId ?? "")
    .digest("hex")
    .slice(0, 24);

  return {
    id: `audit_${hash}`,
    recordId: input.recordId,
    operation: input.operation,
    timestamp: input.timestamp,
    summary: input.summary,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.relatedRecordId ? { relatedRecordId: input.relatedRecordId } : {}),
  };
}

function operationForStatus(
  status: ResearchDerivedMemoryStatus,
): ResearchMemoryAuditOperation {
  switch (status) {
    case "tombstoned":
      return "tombstone";
    case "superseded":
      return "supersede";
    case "stale":
      return "expire";
    case "contradicted":
      return "contradiction";
    default:
      return "write";
  }
}

function isPromotedProcedure(record: ResearchDerivedMemoryRecord): boolean {
  return (
    record.kind === "procedure" &&
    record.guidance.durability === "durable"
  );
}

function createMemoryRef(record: ResearchDerivedMemoryRecord): ResearchMemoryRef {
  return {
    store: selectStore(record),
    id: record.id,
    recordKind: record.kind,
    status: record.status,
    sourceEventIds: record.sourceEventIds,
    summary: record.summary,
    ...(typeof record.confidence === "number"
      ? { confidence: record.confidence }
      : {}),
  };
}

function selectStore(record: ResearchDerivedMemoryRecord): ResearchMemoryStoreKind {
  switch (record.kind) {
    case "semantic_claim":
    case "belief":
      return "semantic";
    case "procedure":
      return "procedural";
    case "prospective_check":
      return "prospective";
    default:
      return record.kind;
  }
}

function appendUniqueRef(refs: ResearchMemoryRef[], ref: ResearchMemoryRef) {
  if (!refs.some((existing) => existing.id === ref.id)) {
    refs.push(ref);
  }
}

function appendUniqueString(values: string[], value: string) {
  if (!values.includes(value)) {
    values.push(value);
  }
}
