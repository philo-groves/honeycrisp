import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyDatabaseMigrations } from "./database-migrations.js";
import type {
  FindingEvidenceKind,
  FindingEvidenceSummary,
  FindingStatus,
  FindingSummary,
  FindingTransitionSummary,
  ModelAuthorSummary,
} from "./knowledge-types.js";
import type { MemoryGraphStore, MemoryNode } from "./memory-graph.js";
import type { ModelAuthor } from "./model-authorship.js";

const DIRECT_OBSERVATION_KINDS = new Set<FindingEvidenceKind>(["code", "artifact", "command", "url"]);
const TERMINAL_FINDING_STATUSES = new Set<FindingStatus>(["disclosed", "rejected"]);

const ALLOWED_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  hypothesis: ["observed", "rejected"],
  observed: ["reproduced", "stale", "rejected"],
  reproduced: ["verified", "stale", "rejected"],
  verified: ["report_ready", "stale", "rejected"],
  report_ready: ["disclosed", "stale", "rejected"],
  disclosed: ["stale"],
  stale: ["observed", "reproduced", "verified", "report_ready", "rejected"],
  rejected: ["hypothesis"],
};

export interface FindingEvidenceInput {
  kind: FindingEvidenceKind;
  referenceId?: string | null;
  contentHash?: string | null;
  summary: string;
  sessionId?: string | null;
  actorId?: string | null;
  independent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateFindingInput {
  memoryNodeId: string;
  title?: string;
  summary?: string;
  impact?: string;
  confidence?: number;
  sourceRevision?: string | null;
  environmentFingerprint?: string | null;
  evidence?: FindingEvidenceInput[];
}

export interface TransitionFindingInput {
  expectedRevision: number;
  toStatus: FindingStatus;
  reason: string;
  evidence?: FindingEvidenceInput[];
  sourceRevision?: string | null;
  environmentFingerprint?: string | null;
  reproductionRunbookId?: string | null;
  reportId?: string | null;
  disclosureReference?: string | null;
}

export class FindingStore {
  private readonly database: DatabaseSync;

  public constructor(private readonly memoryGraph: MemoryGraphStore) {
    this.database = new DatabaseSync(memoryGraph.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    initializeFindingSchema(this.database);
  }

  public close(): void {
    this.database.close();
  }

  public create(input: CreateFindingInput, author?: ModelAuthor, actorId?: string): FindingSummary {
    const context = this.memoryGraph.getContext();
    const memory = this.requireWorkspaceMemory(input.memoryNodeId);
    const existing = this.database.prepare(
      "SELECT id FROM honeycrisp_findings WHERE workspace_id = ? AND memory_node_id = ?",
    ).get(context.workspaceId, memory.id) as { id?: unknown } | undefined;
    if (typeof existing?.id === "string") return this.get(existing.id)!;

    const now = new Date().toISOString();
    const id = stableFindingId(context.workspaceId, memory.id);
    const evidence = normalizeEvidenceInputs(input.evidence ?? [], context.sessionId ?? null, actorId ?? null);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO honeycrisp_findings (
        id, workspace_id, subject_id, memory_node_id, origin_session_id,
        title, summary, impact, status, stale_from_status, confidence,
        source_revision, environment_fingerprint, reproduction_runbook_id,
        report_id, disclosure_reference, stale_reason, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hypothesis', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 1)`).run(
        id,
        context.workspaceId,
        context.subjectId ?? `subject_workspace:${context.workspaceId}`,
        memory.id,
        context.sessionId ?? null,
        normalizedText(input.title) ?? memory.title,
        normalizedText(input.summary) ?? memory.summary,
        normalizedText(input.impact) ?? "",
        confidence(input.confidence ?? memory.confidence),
        nullableText(input.sourceRevision),
        nullableText(input.environmentFingerprint),
        now,
        now,
      );
      const evidenceIds = this.insertEvidence(id, evidence, now);
      this.insertTransition(id, 1, null, "hypothesis", "Finding candidate created from durable research memory.", actorId ?? null, evidenceIds, now);
      this.insertAuthor(id, 1, author, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  public transition(id: string, input: TransitionFindingInput, author?: ModelAuthor, actorId?: string): FindingSummary {
    const current = this.get(id);
    if (!current) throw new Error(`Finding not found: ${id}.`);
    if (current.revision !== input.expectedRevision) {
      throw new Error(`Finding revision conflict for ${id}: expected ${input.expectedRevision}, found ${current.revision}.`);
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(input.toStatus)) {
      throw new Error(`Finding transition ${current.status} -> ${input.toStatus} is not allowed.`);
    }
    const context = this.memoryGraph.getContext();
    if (current.workspaceId !== context.workspaceId) throw new Error("Finding is outside the active workspace.");
    const now = new Date().toISOString();
    const newEvidence = normalizeEvidenceInputs(input.evidence ?? [], context.sessionId ?? null, actorId ?? null);
    const accumulated = [...current.evidence, ...newEvidence.map((item, index) => ({
      id: `pending_${index}`,
      ...item,
      createdAt: now,
    }))];
    validateTransitionEvidence(this.database, current, input, accumulated);

    const nextRevision = current.revision + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const evidenceIds = this.insertEvidence(id, newEvidence, now);
      const staleFromStatus = input.toStatus === "stale"
        ? (current.status === "stale" ? current.staleFromStatus : current.status)
        : null;
      const result = this.database.prepare(`UPDATE honeycrisp_findings SET
        status = ?, stale_from_status = ?, source_revision = ?, environment_fingerprint = ?,
        reproduction_runbook_id = ?, report_id = ?, disclosure_reference = ?, stale_reason = ?,
        updated_at = ?, revision = ? WHERE id = ? AND revision = ?`).run(
        input.toStatus,
        staleFromStatus,
        input.sourceRevision === undefined ? current.sourceRevision : nullableText(input.sourceRevision),
        input.environmentFingerprint === undefined ? current.environmentFingerprint : nullableText(input.environmentFingerprint),
        input.reproductionRunbookId === undefined ? current.reproductionRunbookId : nullableText(input.reproductionRunbookId),
        input.reportId === undefined ? current.reportId : nullableText(input.reportId),
        input.disclosureReference === undefined ? current.disclosureReference : nullableText(input.disclosureReference),
        input.toStatus === "stale" ? requiredText(input.reason, "Staleness reason") : null,
        now,
        nextRevision,
        id,
        current.revision,
      );
      if (Number(result.changes) !== 1) throw new Error(`Finding revision conflict for ${id}.`);
      this.insertTransition(id, nextRevision, current.status, input.toStatus, requiredText(input.reason, "Transition reason"), actorId ?? null, evidenceIds, now);
      this.insertAuthor(id, nextRevision, author, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  public get(id: string): FindingSummary | null {
    const context = this.memoryGraph.getContext();
    const rows = readFindings(this.database, context.workspaceId, id);
    return rows[0] ?? null;
  }

  public list(): FindingSummary[] {
    return readFindings(this.database, this.memoryGraph.getContext().workspaceId);
  }

  public refreshStaleness(sourceRevision: string | null, environmentFingerprint: string | null, actorId = "host"): FindingSummary[] {
    const changed: FindingSummary[] = [];
    for (const finding of this.list()) {
      if (finding.status === "hypothesis" || finding.status === "rejected" || finding.status === "stale") continue;
      const reasons = stalenessReasons(finding, sourceRevision, environmentFingerprint);
      if (reasons.length === 0) continue;
      changed.push(this.transition(finding.id, {
        expectedRevision: finding.revision,
        toStatus: "stale",
        reason: reasons.join(" "),
        sourceRevision,
        environmentFingerprint,
      }, undefined, actorId));
    }
    return changed;
  }

  private requireWorkspaceMemory(id: string): MemoryNode {
    const memory = this.memoryGraph.get(requiredText(id, "Memory node id"));
    if (!memory) throw new Error(`Memory node not found: ${id}.`);
    const context = this.memoryGraph.getContext();
    if (!memory.workspaces.some((workspace) => workspace.id === context.workspaceId)) {
      throw new Error("Finding memory must belong to the active workspace.");
    }
    return memory;
  }

  private insertEvidence(findingId: string, evidence: readonly NormalizedFindingEvidence[], now: string): string[] {
    const insert = this.database.prepare(`INSERT INTO honeycrisp_finding_evidence (
      id, finding_id, kind, reference_id, content_hash, summary, session_id,
      actor_id, independent, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    return evidence.map((item) => {
      const id = `finding_evidence_${randomUUID()}`;
      insert.run(id, findingId, item.kind, item.referenceId, item.contentHash, item.summary,
        item.sessionId, item.actorId, item.independent ? 1 : 0, stableJson(item.metadata), now);
      return id;
    });
  }

  private insertTransition(
    findingId: string,
    revision: number,
    fromStatus: FindingStatus | null,
    toStatus: FindingStatus,
    reason: string,
    actorId: string | null,
    evidenceIds: readonly string[],
    now: string,
  ): void {
    this.database.prepare(`INSERT INTO honeycrisp_finding_transitions (
      id, finding_id, finding_revision, from_status, to_status, reason, actor_id, evidence_ids_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `finding_transition_${randomUUID()}`, findingId, revision, fromStatus, toStatus, reason,
      actorId, stableJson([...evidenceIds]), now,
    );
  }

  private insertAuthor(findingId: string, revision: number, author: ModelAuthor | undefined, now: string): void {
    if (!author?.provider.trim() || !author.model.trim()) return;
    this.database.prepare(`INSERT OR IGNORE INTO honeycrisp_finding_authorship
      (finding_id, revision, provider, model, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(findingId, revision, author.provider.trim(), author.model.trim(), now);
  }
}

interface NormalizedFindingEvidence {
  kind: FindingEvidenceKind;
  referenceId: string | null;
  contentHash: string | null;
  summary: string;
  sessionId: string | null;
  actorId: string | null;
  independent: boolean;
  metadata: Record<string, unknown>;
}

export function initializeFindingSchema(database: DatabaseSync): void {
  applyDatabaseMigrations(database, "honeycrisp_findings", [{
    version: 1,
    name: "evidence_gated_finding_lifecycle",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS honeycrisp_findings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          memory_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          origin_session_id TEXT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          impact TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('hypothesis','observed','reproduced','verified','report_ready','disclosed','stale','rejected')),
          stale_from_status TEXT,
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          source_revision TEXT,
          environment_fingerprint TEXT,
          reproduction_runbook_id TEXT,
          report_id TEXT,
          disclosure_reference TEXT,
          stale_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          UNIQUE(workspace_id, memory_node_id)
        );
        CREATE INDEX IF NOT EXISTS honeycrisp_findings_workspace_status_idx
          ON honeycrisp_findings(workspace_id, status, updated_at);
        CREATE TABLE IF NOT EXISTS honeycrisp_finding_evidence (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL REFERENCES honeycrisp_findings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('code','artifact','command','url','runbook_execution','independent_verification','report','disclosure')),
          reference_id TEXT,
          content_hash TEXT,
          summary TEXT NOT NULL,
          session_id TEXT,
          actor_id TEXT,
          independent INTEGER NOT NULL CHECK (independent IN (0,1)),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS honeycrisp_finding_evidence_finding_idx
          ON honeycrisp_finding_evidence(finding_id, created_at);
        CREATE TABLE IF NOT EXISTS honeycrisp_finding_transitions (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL REFERENCES honeycrisp_findings(id) ON DELETE CASCADE,
          finding_revision INTEGER NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          reason TEXT NOT NULL,
          actor_id TEXT,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS honeycrisp_finding_transitions_finding_idx
          ON honeycrisp_finding_transitions(finding_id, created_at);
        CREATE TABLE IF NOT EXISTS honeycrisp_finding_authorship (
          finding_id TEXT NOT NULL REFERENCES honeycrisp_findings(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(finding_id, revision, provider, model)
        );
      `);
    },
  }, {
    version: 2,
    name: "ordered_finding_transitions",
    up(db) {
      if (!tableHasColumn(db, "honeycrisp_finding_transitions", "finding_revision")) {
        db.exec("ALTER TABLE honeycrisp_finding_transitions ADD COLUMN finding_revision INTEGER;");
        db.exec(`UPDATE honeycrisp_finding_transitions AS transition_row SET finding_revision = (
          SELECT COUNT(*) FROM honeycrisp_finding_transitions AS earlier
          WHERE earlier.finding_id = transition_row.finding_id
            AND (earlier.created_at < transition_row.created_at
              OR (earlier.created_at = transition_row.created_at AND earlier.rowid <= transition_row.rowid))
        );`);
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS honeycrisp_finding_transitions_revision_idx
        ON honeycrisp_finding_transitions(finding_id, finding_revision);`);
    },
  }]);
}

export function readFindings(database: DatabaseSync, workspaceId: string, findingId?: string): FindingSummary[] {
  if (!tableExists(database, "honeycrisp_findings")) return [];
  const rows = database.prepare(`SELECT * FROM honeycrisp_findings
    WHERE workspace_id = ?${findingId ? " AND id = ?" : ""}
    ORDER BY updated_at DESC, id`).all(...(findingId ? [workspaceId, findingId] : [workspaceId])) as SqlRow[];
  const evidence = groupedEvidence(database, new Set(rows.map((row) => requiredSqlText(row.id))));
  const transitions = groupedTransitions(database, new Set(rows.map((row) => requiredSqlText(row.id))));
  const authors = groupedAuthors(database, new Set(rows.map((row) => requiredSqlText(row.id))));
  return rows.map((row) => ({
    id: requiredSqlText(row.id),
    workspaceId: requiredSqlText(row.workspace_id),
    subjectId: requiredSqlText(row.subject_id),
    memoryNodeId: requiredSqlText(row.memory_node_id),
    originSessionId: optionalSqlText(row.origin_session_id),
    title: requiredSqlText(row.title),
    summary: requiredSqlText(row.summary),
    impact: requiredSqlText(row.impact),
    status: findingStatus(row.status),
    staleFromStatus: row.stale_from_status === null ? null : findingStatus(row.stale_from_status),
    confidence: requiredSqlNumber(row.confidence),
    sourceRevision: optionalSqlText(row.source_revision),
    environmentFingerprint: optionalSqlText(row.environment_fingerprint),
    reproductionRunbookId: optionalSqlText(row.reproduction_runbook_id),
    reportId: optionalSqlText(row.report_id),
    disclosureReference: optionalSqlText(row.disclosure_reference),
    staleReason: optionalSqlText(row.stale_reason),
    evidence: evidence.get(requiredSqlText(row.id)) ?? [],
    transitions: transitions.get(requiredSqlText(row.id)) ?? [],
    authors: authors.get(requiredSqlText(row.id)) ?? [],
    createdAt: requiredSqlText(row.created_at),
    updatedAt: requiredSqlText(row.updated_at),
    revision: requiredSqlNumber(row.revision),
  }));
}

export function refreshFindingStaleness(input: {
  databasePath: string;
  workspaceId: string;
  sourceRevision?: string | null;
  environmentFingerprint?: string | null;
  actorId?: string;
}): FindingSummary[] {
  const database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  try {
    initializeFindingSchema(database);
    const changed: FindingSummary[] = [];
    for (const finding of readFindings(database, input.workspaceId)) {
      if (finding.status === "hypothesis" || finding.status === "rejected" || finding.status === "stale") continue;
      const reasons = stalenessReasons(
        finding,
        nullableText(input.sourceRevision),
        nullableText(input.environmentFingerprint),
      );
      if (reasons.length === 0) continue;
      const now = new Date().toISOString();
      const nextRevision = finding.revision + 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = database.prepare(`UPDATE honeycrisp_findings SET
          status = 'stale', stale_from_status = ?, source_revision = ?, environment_fingerprint = ?,
          stale_reason = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?`).run(
          finding.status,
          nullableText(input.sourceRevision),
          nullableText(input.environmentFingerprint),
          reasons.join(" "),
          now,
          nextRevision,
          finding.id,
          finding.revision,
        );
        if (Number(result.changes) !== 1) throw new Error(`Finding revision conflict for ${finding.id}.`);
        database.prepare(`INSERT INTO honeycrisp_finding_transitions (
          id, finding_id, finding_revision, from_status, to_status, reason, actor_id, evidence_ids_json, created_at
        ) VALUES (?, ?, ?, ?, 'stale', ?, ?, '[]', ?)`).run(
          `finding_transition_${randomUUID()}`,
          finding.id,
          nextRevision,
          finding.status,
          reasons.join(" "),
          input.actorId?.trim() || "host",
          now,
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      changed.push(readFindings(database, input.workspaceId, finding.id)[0]!);
    }
    return changed;
  } finally {
    database.close();
  }
}

function validateTransitionEvidence(
  database: DatabaseSync,
  current: FindingSummary,
  input: TransitionFindingInput,
  evidence: readonly FindingEvidenceSummary[],
): void {
  if (input.toStatus === "observed" && !evidence.some((item) =>
    DIRECT_OBSERVATION_KINDS.has(item.kind) && Boolean(item.referenceId || item.contentHash))) {
    throw new Error("Observed findings require direct code, artifact, command, or URL evidence.");
  }
  if (input.toStatus === "reproduced") {
    const runbookId = nullableText(input.reproductionRunbookId) ?? current.reproductionRunbookId;
    const execution = evidence.find((item) => item.kind === "runbook_execution" && item.referenceId
      && successfulRunbookExecutionExists(database, current.workspaceId, runbookId, item.referenceId));
    if (!runbookId || !execution) {
      throw new Error("Reproduced findings require a successful runbook execution and reproductionRunbookId.");
    }
  }
  if (input.toStatus === "verified") {
    const verification = evidence.find((item) => item.kind === "independent_verification" && item.independent);
    if (!verification || !verification.referenceId || (current.originSessionId && verification.sessionId === current.originSessionId)) {
      throw new Error("Verified findings require evidence from an independent verifier outside the originating session.");
    }
  }
  if (input.toStatus === "report_ready") {
    const reportId = nullableText(input.reportId) ?? current.reportId;
    if (!reportId || !workspaceResourceExists(database, "honeycrisp_reports", reportId, current.workspaceId)
      || !evidence.some((item) => item.kind === "report" && item.referenceId === reportId)) {
      throw new Error("Report-ready findings require a report reference and report evidence.");
    }
  }
  if (input.toStatus === "disclosed") {
    const disclosure = nullableText(input.disclosureReference) ?? current.disclosureReference;
    if (!disclosure || !evidence.some((item) => item.kind === "disclosure" && item.referenceId === disclosure)) {
      throw new Error("Disclosed findings require a disclosure reference and disclosure evidence.");
    }
  }
}

function stalenessReasons(finding: FindingSummary, sourceRevision: string | null, environmentFingerprint: string | null): string[] {
  const reasons: string[] = [];
  if (finding.sourceRevision && sourceRevision && finding.sourceRevision !== sourceRevision) {
    reasons.push(`Recorded source revision ${finding.sourceRevision} differs from current revision ${sourceRevision}.`);
  }
  if (finding.environmentFingerprint && environmentFingerprint && finding.environmentFingerprint !== environmentFingerprint) {
    reasons.push("The current execution environment differs from the verified environment fingerprint.");
  }
  return reasons;
}

function normalizeEvidenceInputs(items: readonly FindingEvidenceInput[], defaultSessionId: string | null, defaultActorId: string | null): NormalizedFindingEvidence[] {
  return items.map((item) => ({
    kind: findingEvidenceKind(item.kind),
    referenceId: nullableText(item.referenceId),
    contentHash: nullableText(item.contentHash),
    summary: requiredText(item.summary, "Finding evidence summary"),
    sessionId: item.sessionId === undefined ? defaultSessionId : nullableText(item.sessionId),
    actorId: item.actorId === undefined ? defaultActorId : nullableText(item.actorId),
    independent: item.independent === true,
    metadata: isRecord(item.metadata) ? item.metadata : {},
  }));
}

function groupedEvidence(database: DatabaseSync, findingIds: ReadonlySet<string>): Map<string, FindingEvidenceSummary[]> {
  const grouped = new Map<string, FindingEvidenceSummary[]>();
  if (findingIds.size === 0 || !tableExists(database, "honeycrisp_finding_evidence")) return grouped;
  for (const row of database.prepare("SELECT * FROM honeycrisp_finding_evidence ORDER BY created_at, id").all() as SqlRow[]) {
    const findingId = requiredSqlText(row.finding_id);
    if (!findingIds.has(findingId)) continue;
    grouped.set(findingId, [...(grouped.get(findingId) ?? []), {
      id: requiredSqlText(row.id),
      kind: findingEvidenceKind(row.kind),
      referenceId: optionalSqlText(row.reference_id),
      contentHash: optionalSqlText(row.content_hash),
      summary: requiredSqlText(row.summary),
      sessionId: optionalSqlText(row.session_id),
      actorId: optionalSqlText(row.actor_id),
      independent: row.independent === 1,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: requiredSqlText(row.created_at),
    }]);
  }
  return grouped;
}

function groupedTransitions(database: DatabaseSync, findingIds: ReadonlySet<string>): Map<string, FindingTransitionSummary[]> {
  const grouped = new Map<string, FindingTransitionSummary[]>();
  if (findingIds.size === 0 || !tableExists(database, "honeycrisp_finding_transitions")) return grouped;
  for (const row of database.prepare("SELECT * FROM honeycrisp_finding_transitions ORDER BY finding_id, finding_revision").all() as SqlRow[]) {
    const findingId = requiredSqlText(row.finding_id);
    if (!findingIds.has(findingId)) continue;
    grouped.set(findingId, [...(grouped.get(findingId) ?? []), {
      id: requiredSqlText(row.id),
      revision: requiredSqlNumber(row.finding_revision),
      fromStatus: row.from_status === null ? null : findingStatus(row.from_status),
      toStatus: findingStatus(row.to_status),
      reason: requiredSqlText(row.reason),
      actorId: optionalSqlText(row.actor_id),
      evidenceIds: parseJsonStringArray(row.evidence_ids_json),
      createdAt: requiredSqlText(row.created_at),
    }]);
  }
  return grouped;
}

function groupedAuthors(database: DatabaseSync, findingIds: ReadonlySet<string>): Map<string, ModelAuthorSummary[]> {
  const grouped = new Map<string, ModelAuthorSummary[]>();
  if (findingIds.size === 0 || !tableExists(database, "honeycrisp_finding_authorship")) return grouped;
  for (const row of database.prepare(`SELECT finding_id, provider, model
    FROM honeycrisp_finding_authorship ORDER BY finding_id, revision, provider, model`).all() as SqlRow[]) {
    const findingId = requiredSqlText(row.finding_id);
    if (!findingIds.has(findingId)) continue;
    const author = { provider: requiredSqlText(row.provider), model: requiredSqlText(row.model) };
    const current = grouped.get(findingId) ?? [];
    if (!current.some((item) => item.provider === author.provider && item.model === author.model)) {
      grouped.set(findingId, [...current, author]);
    }
  }
  return grouped;
}

function stableFindingId(workspaceId: string, memoryNodeId: string): string {
  return `finding_${createHash("sha256").update(`${workspaceId}\0${memoryNodeId}`).digest("hex").slice(0, 20)}`;
}

function workspaceResourceExists(database: DatabaseSync, table: "honeycrisp_runbooks" | "honeycrisp_reports", id: string, workspaceId: string): boolean {
  return tableExists(database, table)
    && Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, workspaceId));
}

function successfulRunbookExecutionExists(
  database: DatabaseSync,
  workspaceId: string,
  runbookId: string | null,
  runId: string,
): boolean {
  return Boolean(runbookId)
    && tableExists(database, "honeycrisp_runbook_executions")
    && Boolean(database.prepare(`SELECT 1 FROM honeycrisp_runbook_executions
      WHERE workspace_id = ? AND runbook_id = ? AND run_id = ? AND status = 'succeeded'`)
      .get(workspaceId, runbookId, runId));
}

type SqlRow = Record<string, unknown>;
function confidence(value: number): number { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Finding confidence must be between 0 and 1."); return value; }
function requiredText(value: unknown, label: string): string { const text = normalizedText(value); if (!text) throw new Error(`${label} must be a non-empty string.`); return text; }
function normalizedText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function nullableText(value: unknown): string | null { return normalizedText(value); }
function requiredSqlText(value: unknown): string { if (typeof value !== "string") throw new Error("Expected SQLite text value."); return value; }
function optionalSqlText(value: unknown): string | null { return typeof value === "string" ? value : null; }
function requiredSqlNumber(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected SQLite numeric value."); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function parseJsonObject(value: unknown): Record<string, unknown> { if (typeof value !== "string") return {}; const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : {}; }
function parseJsonStringArray(value: unknown): string[] { if (typeof value !== "string") return []; const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (!value || typeof value !== "object") return JSON.stringify(value); return `{${Object.entries(value as Record<string, unknown>).filter(([, nested]) => nested !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`; }
function tableExists(database: DatabaseSync, table: string): boolean { return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)); }
function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean { return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).some((row) => row.name === column); }
function findingStatus(value: unknown): FindingStatus { if (value === "hypothesis" || value === "observed" || value === "reproduced" || value === "verified" || value === "report_ready" || value === "disclosed" || value === "stale" || value === "rejected") return value; throw new Error(`Invalid finding status: ${String(value)}.`); }
function findingEvidenceKind(value: unknown): FindingEvidenceKind { if (value === "code" || value === "artifact" || value === "command" || value === "url" || value === "runbook_execution" || value === "independent_verification" || value === "report" || value === "disclosure") return value; throw new Error(`Invalid finding evidence kind: ${String(value)}.`); }

export function findingIsTerminal(status: FindingStatus): boolean {
  return TERMINAL_FINDING_STATUSES.has(status);
}
