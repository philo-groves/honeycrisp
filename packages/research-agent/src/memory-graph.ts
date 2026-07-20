import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDefaultMemoryDatabasePath } from "./storage.js";

const require = createRequire(import.meta.url);

export const MEMORY_NODE_TYPES = [
  "asset",
  "bug",
  "invariant",
  "mitigation",
  "source",
  "sink",
  "hypothesis",
  "finding",
  "primitive",
  "chain",
  "procedure",
  "trajectory",
] as const;
export const MEMORY_NODE_STATUSES = ["draft", "suspected", "confirmed", "rejected", "stale"] as const;

export type MemoryNodeType = (typeof MEMORY_NODE_TYPES)[number];
export type MemoryNodeStatus = (typeof MEMORY_NODE_STATUSES)[number];

export interface MemoryEvidenceRef {
  id: string;
  kind: "code" | "artifact" | "command" | "url" | "human_note";
  pathBase?: "workspace" | "repository" | "asset_root" | "external";
  path?: string;
  locator: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

export interface MemoryEdge {
  fromId: string;
  toId: string;
  relation: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body: string;
  status: MemoryNodeStatus;
  confidence: number;
  assetIds: string[];
  tags: string[];
  attributes: Record<string, unknown>;
  evidence: MemoryEvidenceRef[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface SaveMemoryNodeInput {
  id?: string;
  type: MemoryNodeType;
  title: string;
  summary?: string;
  body?: string;
  status?: MemoryNodeStatus;
  confidence?: number;
  assetIds?: readonly string[];
  tags?: readonly string[];
  attributes?: Record<string, unknown>;
  evidence?: readonly Omit<MemoryEvidenceRef, "id" | "createdAt">[];
}

export interface SearchMemoryNodesInput {
  query?: string;
  types?: readonly MemoryNodeType[];
  statuses?: readonly MemoryNodeStatus[];
  assetIds?: readonly string[];
  tags?: readonly string[];
  limit?: number;
}

export class MemoryGraphStore {
  public readonly databasePath: string;
  private readonly database: DatabaseSync;

  public constructor(options: { workspaceRoot?: string; databasePath?: string } = {}) {
    this.databasePath = options.databasePath ?? getDefaultMemoryDatabasePath(options.workspaceRoot ?? process.cwd());
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initializeSchema();
  }

  public close(): void {
    this.database.close();
  }

  public save(input: SaveMemoryNodeInput): MemoryNode {
    validateNodeInput(input);
    const title = input.title.trim();
    const titleNorm = normalizeTitle(title);
    const existingRow = this.database.prepare("SELECT id FROM memory_nodes WHERE type = ? AND title_norm = ?").get(input.type, titleNorm) as
      | { id?: unknown }
      | undefined;
    const existing = typeof existingRow?.id === "string" ? this.get(existingRow.id) : null;
    const now = new Date().toISOString();
    const id = existing?.id ?? input.id ?? stableNodeId(input.type, titleNorm);
    if (!existing && input.id) {
      const conflicting = this.get(input.id);
      if (conflicting) throw new Error(`Memory node id already belongs to ${conflicting.type}: ${input.id}`);
    }
    const next: MemoryNode = existing
      ? {
          ...existing,
          summary: input.summary?.trim() || existing.summary,
          body: input.body?.trim() || existing.body,
          status: input.status ?? existing.status,
          confidence: input.confidence ?? existing.confidence,
          assetIds: unique([...existing.assetIds, ...(input.assetIds ?? [])]),
          tags: unique([...existing.tags, ...(input.tags ?? []).map(normalizeTag)]),
          attributes: mergeObjects(existing.attributes, input.attributes ?? {}),
          evidence: mergeEvidence(existing.evidence, input.evidence ?? [], id, now),
          updatedAt: now,
          revision: existing.revision + 1,
        }
      : {
          id,
          type: input.type,
          title,
          summary: input.summary?.trim() ?? "",
          body: input.body?.trim() ?? "",
          status: input.status ?? "draft",
          confidence: input.confidence ?? 0.5,
          assetIds: unique(input.assetIds ?? []),
          tags: unique((input.tags ?? []).map(normalizeTag)),
          attributes: input.attributes ?? {},
          evidence: mergeEvidence([], input.evidence ?? [], id, now),
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
    this.writeNode(next, titleNorm);
    return this.get(id)!;
  }

  public correct(id: string, expectedRevision: number, patch: Partial<Omit<SaveMemoryNodeInput, "id" | "type">>): MemoryNode {
    const existing = this.get(id);
    if (!existing) throw new Error(`Memory node not found: ${id}`);
    if (existing.revision !== expectedRevision) {
      throw new Error(`Memory node revision conflict for ${id}: expected ${expectedRevision}, found ${existing.revision}.`);
    }
    const now = new Date().toISOString();
    const next: MemoryNode = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.assetIds !== undefined ? { assetIds: unique(patch.assetIds) } : {}),
      ...(patch.tags !== undefined ? { tags: unique(patch.tags.map(normalizeTag)) } : {}),
      ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
      ...(patch.evidence !== undefined ? { evidence: mergeEvidence([], patch.evidence, id, now) } : {}),
      updatedAt: now,
      revision: existing.revision + 1,
    };
    validateNodeInput(next);
    this.writeNode(next, normalizeTitle(next.title), expectedRevision);
    return this.get(id)!;
  }

  public get(id: string): MemoryNode | null {
    const row = this.database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      type: nodeType(row.type),
      title: text(row.title),
      summary: text(row.summary),
      body: text(row.body),
      status: nodeStatus(row.status),
      confidence: number(row.confidence),
      assetIds: this.strings("SELECT asset_id AS value FROM memory_node_assets WHERE node_id = ? ORDER BY asset_id", id),
      tags: this.strings("SELECT tag AS value FROM memory_node_tags WHERE node_id = ? ORDER BY tag", id),
      attributes: jsonObject(row.attributes_json),
      evidence: (this.database.prepare("SELECT * FROM memory_evidence_refs WHERE node_id = ? ORDER BY created_at, id").all(id) as Record<string, unknown>[]).map(
        evidenceFromRow,
      ),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      revision: number(row.revision),
    };
  }

  public search(input: SearchMemoryNodesInput = {}): MemoryNode[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.query?.trim()) {
      const query = `%${input.query.trim().toLowerCase()}%`;
      clauses.push("(lower(n.title) LIKE ? OR lower(n.summary) LIKE ? OR lower(n.body) LIKE ? OR lower(n.attributes_json) LIKE ?)");
      params.push(query, query, query, query);
    }
    if (input.types?.length) {
      clauses.push(`n.type IN (${input.types.map(() => "?").join(",")})`);
      params.push(...input.types);
    }
    if (input.statuses?.length) {
      clauses.push(`n.status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    for (const assetId of input.assetIds ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_assets a WHERE a.node_id = n.id AND a.asset_id = ?)");
      params.push(assetId);
    }
    for (const tag of input.tags ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_tags t WHERE t.node_id = n.id AND t.tag = ?)");
      params.push(normalizeTag(tag));
    }
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    params.push(limit);
    const rows = this.database
      .prepare(`SELECT n.id FROM memory_nodes n ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY n.updated_at DESC, n.id LIMIT ?`)
      .all(...params) as { id?: unknown }[];
    return rows.flatMap((row) => (typeof row.id === "string" ? [this.get(row.id)!] : []));
  }

  public link(fromId: string, toId: string, relation: string, note = ""): MemoryEdge {
    if (!this.get(fromId) || !this.get(toId)) throw new Error("Both memory edge nodes must exist.");
    const cleanRelation = normalizeTag(relation);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO memory_edges(from_id, to_id, relation, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(fromId, toId, cleanRelation, note.trim(), now, now);
    const row = this.database.prepare("SELECT * FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = ?").get(fromId, toId, cleanRelation) as Record<string, unknown>;
    return edgeFromRow(row);
  }

  public listEdges(nodeId?: string): MemoryEdge[] {
    const rows = (nodeId
      ? this.database.prepare("SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ? ORDER BY updated_at DESC").all(nodeId, nodeId)
      : this.database.prepare("SELECT * FROM memory_edges ORDER BY updated_at DESC").all()) as Record<string, unknown>[];
    return rows.map(edgeFromRow);
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS honeycrisp_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        title_norm TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        confidence REAL NOT NULL DEFAULT 0.5,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(type, title_norm)
      );
      CREATE TABLE IF NOT EXISTS memory_node_assets (
        node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL,
        PRIMARY KEY(node_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS memory_node_tags (
        node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(node_id, tag)
      );
      CREATE TABLE IF NOT EXISTS memory_edges (
        from_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(from_id, to_id, relation)
      );
      CREATE TABLE IF NOT EXISTS memory_evidence_refs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path_base TEXT,
        path TEXT,
        locator_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_nodes_type_status_idx ON memory_nodes(type, status);
      CREATE INDEX IF NOT EXISTS memory_nodes_updated_at_idx ON memory_nodes(updated_at);
      CREATE INDEX IF NOT EXISTS memory_node_assets_asset_idx ON memory_node_assets(asset_id, node_id);
      CREATE INDEX IF NOT EXISTS memory_node_tags_tag_idx ON memory_node_tags(tag, node_id);
      CREATE INDEX IF NOT EXISTS memory_edges_to_idx ON memory_edges(to_id, relation);
      CREATE INDEX IF NOT EXISTS memory_evidence_node_idx ON memory_evidence_refs(node_id);
      INSERT OR REPLACE INTO honeycrisp_meta(key, value) VALUES ('schema_version', '1');
    `);
  }

  private writeNode(node: MemoryNode, titleNorm: string, expectedRevision?: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (expectedRevision !== undefined) {
        const row = this.database.prepare("SELECT revision FROM memory_nodes WHERE id = ?").get(node.id) as { revision?: unknown } | undefined;
        if (typeof row?.revision !== "number" || row.revision !== expectedRevision) {
          throw new Error(`Memory node revision conflict for ${node.id}: expected ${expectedRevision}, found ${String(row?.revision ?? "missing")}.`);
        }
      }
      this.database
        .prepare(
          `INSERT INTO memory_nodes(id, type, title, title_norm, summary, body, status, confidence, attributes_json, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_norm = excluded.title_norm, summary = excluded.summary,
             body = excluded.body, status = excluded.status, confidence = excluded.confidence, attributes_json = excluded.attributes_json,
             updated_at = excluded.updated_at, revision = excluded.revision`,
        )
        .run(node.id, node.type, node.title, titleNorm, node.summary, node.body, node.status, node.confidence, JSON.stringify(node.attributes), node.createdAt, node.updatedAt, node.revision);
      this.database.prepare("DELETE FROM memory_node_assets WHERE node_id = ?").run(node.id);
      this.database.prepare("DELETE FROM memory_node_tags WHERE node_id = ?").run(node.id);
      this.database.prepare("DELETE FROM memory_evidence_refs WHERE node_id = ?").run(node.id);
      for (const assetId of node.assetIds) this.database.prepare("INSERT INTO memory_node_assets(node_id, asset_id) VALUES (?, ?)").run(node.id, assetId);
      for (const tag of node.tags) this.database.prepare("INSERT INTO memory_node_tags(node_id, tag) VALUES (?, ?)").run(node.id, tag);
      for (const evidence of node.evidence) {
        this.database
          .prepare("INSERT INTO memory_evidence_refs(id, node_id, kind, path_base, path, locator_json, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(evidence.id, node.id, evidence.kind, evidence.pathBase ?? null, evidence.path ?? null, JSON.stringify(evidence.locator), evidence.summary, evidence.createdAt);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private strings(sql: string, value: string): string[] {
    return (this.database.prepare(sql).all(value) as { value?: unknown }[]).flatMap((row) => (typeof row.value === "string" ? [row.value] : []));
  }
}

function validateNodeInput(input: { type: unknown; title: unknown; status?: unknown; confidence?: unknown; attributes?: unknown }): void {
  if (!MEMORY_NODE_TYPES.includes(input.type as MemoryNodeType)) throw new Error(`Unsupported memory node type: ${String(input.type)}`);
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Memory node title is required.");
  if (input.status !== undefined && !MEMORY_NODE_STATUSES.includes(input.status as MemoryNodeStatus)) throw new Error(`Unsupported memory node status: ${String(input.status)}`);
  if (input.confidence !== undefined && (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)) throw new Error("Memory confidence must be between 0 and 1.");
  if (input.type === "chain") {
    const attributes = input.attributes;
    if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) throw new Error("Chain nodes require impact and reachability attributes.");
    const values = attributes as Record<string, unknown>;
    if (typeof values.impact !== "string" || !values.impact.trim() || typeof values.reachability !== "string" || !values.reachability.trim()) {
      throw new Error("Chain nodes require non-empty impact and reachability attributes.");
    }
  }
}

function validateEvidence(item: Omit<MemoryEvidenceRef, "id" | "createdAt">): void {
  if (!(["code", "artifact", "command", "url", "human_note"] as const).includes(item.kind)) {
    throw new Error(`Unsupported memory evidence kind: ${String(item.kind)}`);
  }
  if (item.pathBase !== undefined && !(["workspace", "repository", "asset_root", "external"] as const).includes(item.pathBase)) {
    throw new Error(`Unsupported memory evidence path base: ${String(item.pathBase)}`);
  }
  if (item.path !== undefined) {
    if (typeof item.path !== "string" || !item.path.trim()) throw new Error("Memory evidence path must be a non-empty string.");
    if (item.kind !== "url" && (/^(?:\/|~\/)/.test(item.path) || /^[A-Za-z]:[\\/]/.test(item.path))) {
      throw new Error("Memory evidence paths must be relative; use pathBase to identify their root.");
    }
  }
}

function normalizeTitle(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
function normalizeTag(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function stableNodeId(type: MemoryNodeType, title: string): string { return `${type}_${createHash("sha256").update(`${type}:${title}`).digest("hex").slice(0, 20)}`; }
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(); }
function mergeObjects(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> { return { ...base, ...update }; }
function mergeEvidence(existing: readonly MemoryEvidenceRef[], incoming: readonly Omit<MemoryEvidenceRef, "id" | "createdAt">[], nodeId: string, now: string): MemoryEvidenceRef[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    validateEvidence(item);
    const key = JSON.stringify([item.kind, item.pathBase ?? null, item.path ?? null, item.locator ?? {}, item.summary ?? ""]);
    const id = `evidence_${createHash("sha256").update(`${nodeId}:${key}`).digest("hex").slice(0, 20)}`;
    const pathBase = item.pathBase;
    const path = item.path;
    const next: MemoryEvidenceRef = { id, kind: item.kind, locator: item.locator ?? {}, summary: item.summary?.trim() ?? "", createdAt: byId.get(id)?.createdAt ?? now };
    if (pathBase) next.pathBase = pathBase;
    if (path) next.path = path;
    byId.set(id, next);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
function evidenceFromRow(row: Record<string, unknown>): MemoryEvidenceRef {
  const evidence: MemoryEvidenceRef = {
    id: text(row.id),
    kind: text(row.kind) as MemoryEvidenceRef["kind"],
    locator: jsonObject(row.locator_json),
    summary: text(row.summary),
    createdAt: text(row.created_at),
  };
  if (typeof row.path_base === "string") evidence.pathBase = row.path_base as NonNullable<MemoryEvidenceRef["pathBase"]>;
  if (typeof row.path === "string") evidence.path = row.path;
  return evidence;
}
function edgeFromRow(row: Record<string, unknown>): MemoryEdge { return { fromId: text(row.from_id), toId: text(row.to_id), relation: text(row.relation), note: text(row.note), createdAt: text(row.created_at), updatedAt: text(row.updated_at) }; }
function jsonObject(value: unknown): Record<string, unknown> { if (typeof value !== "string") return {}; const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Expected SQLite text value."); return value; }
function number(value: unknown): number { if (typeof value !== "number") throw new Error("Expected SQLite number value."); return value; }
function nodeType(value: unknown): MemoryNodeType { if (!MEMORY_NODE_TYPES.includes(value as MemoryNodeType)) throw new Error(`Unsupported stored memory node type: ${String(value)}`); return value as MemoryNodeType; }
function nodeStatus(value: unknown): MemoryNodeStatus { if (!MEMORY_NODE_STATUSES.includes(value as MemoryNodeStatus)) throw new Error(`Unsupported stored memory status: ${String(value)}`); return value as MemoryNodeStatus; }
