import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applyDatabaseMigrations } from "./database-migrations.js";
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
  "primitive",
  "chain",
  "procedure",
  "trajectory",
] as const;
export const MEMORY_NODE_STATUSES = ["draft", "suspected", "confirmed", "rejected", "stale"] as const;
export const MEMORY_TIERS = ["session", "workspace", "subject"] as const;
export const MEMORY_EVIDENCE_KINDS = ["code", "artifact", "command", "url", "human_note"] as const;
export const MEMORY_EVIDENCE_PATH_BASES = ["workspace", "repository", "asset_root", "external"] as const;

export type MemoryNodeType = (typeof MEMORY_NODE_TYPES)[number];
export type MemoryNodeStatus = (typeof MEMORY_NODE_STATUSES)[number];
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export interface MemoryTierContext {
  sessionId?: string;
  workspaceId: string;
  workspaceName: string;
  subjectId?: string;
  subjectName?: string;
}

export interface MemoryEvidenceRef {
  id: string;
  kind: (typeof MEMORY_EVIDENCE_KINDS)[number];
  pathBase?: (typeof MEMORY_EVIDENCE_PATH_BASES)[number];
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
  tier: MemoryTier;
  sessionId: string | null;
  workspaceId: string;
  workspaceName: string;
  subjectId: string | null;
  subjectName: string | null;
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
  tier?: MemoryTier;
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
  tiers?: readonly MemoryTier[];
  types?: readonly MemoryNodeType[];
  statuses?: readonly MemoryNodeStatus[];
  assetIds?: readonly string[];
  tags?: readonly string[];
  limit?: number;
}

interface MemoryDatabaseBinding {
  database: DatabaseSync;
  databasePath: string;
  context: MemoryTierContext;
}

interface LocatedMemoryNode {
  binding: MemoryDatabaseBinding;
  node: MemoryNode;
}

export class MemoryGraphStore {
  public readonly databasePath: string;
  private readonly local: MemoryDatabaseBinding;

  public constructor(options: {
    workspaceRoot?: string;
    databasePath?: string;
    context?: MemoryTierContext;
  } = {}) {
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.databasePath = options.databasePath ?? getDefaultMemoryDatabasePath(options.workspaceRoot ?? process.cwd());
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    const context = normalizeTierContext(options.context ?? readStoredTierContext(DatabaseSync, this.databasePath, workspaceRoot), workspaceRoot);
    this.local = this.openBinding(DatabaseSync, this.databasePath, context);
  }

  public close(): void {
    this.local.database.close();
  }

  public getContext(): MemoryTierContext {
    return { ...this.local.context };
  }

  public save(input: SaveMemoryNodeInput): MemoryNode {
    validateNodeInput(input);
    const tier = input.tier ?? "workspace";
    const scopeKey = scopeKeyForTier(tier, this.local.context);
    const title = input.title.trim();
    const titleNorm = normalizeTitle(title);
    const existingLocation = this.findByIdentity(tier, scopeKey, input.type, titleNorm)
      ?? this.findVisibleByIdentity(input.type, titleNorm);
    const existing = existingLocation?.node ?? null;
    const target = existingLocation?.binding ?? this.local;
    const now = new Date().toISOString();
    const id = existing?.id ?? input.id ?? stableNodeId(tier, scopeKey, input.type, titleNorm);
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
          tier,
          sessionId: this.local.context.sessionId ?? null,
          workspaceId: this.local.context.workspaceId,
          workspaceName: this.local.context.workspaceName,
          subjectId: this.local.context.subjectId ?? null,
          subjectName: this.local.context.subjectName ?? null,
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
    validateCompleteNode(next);
    this.writeNode(target.database, next, titleNorm, existing ? scopeKeyForNode(existing) : scopeKey);
    return this.getFromDatabase(target.database, id)!;
  }

  public correct(id: string, expectedRevision: number, patch: Partial<Omit<SaveMemoryNodeInput, "id">>): MemoryNode {
    if (patch.tier !== undefined) throw new Error("Memory tier is immutable; save a new node in the intended tier.");
    const located = this.locate(id);
    const existing = located?.node;
    if (!existing || !located) throw new Error(`Memory node not found: ${id}`);
    if (existing.revision !== expectedRevision) {
      throw new Error(`Memory node revision conflict for ${id}: expected ${expectedRevision}, found ${existing.revision}.`);
    }
    const now = new Date().toISOString();
    const type = patch.type ?? existing.type;
    const title = patch.title?.trim() ?? existing.title;
    const nextId = type === existing.type ? id : stableNodeId(existing.tier, scopeKeyForNode(existing), type, normalizeTitle(title));
    const next: MemoryNode = {
      ...existing,
      id: nextId,
      type,
      title,
      ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.assetIds !== undefined ? { assetIds: unique(patch.assetIds) } : {}),
      ...(patch.tags !== undefined ? { tags: unique(patch.tags.map(normalizeTag)) } : {}),
      ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
      ...(patch.evidence !== undefined ? { evidence: mergeEvidence([], patch.evidence, nextId, now) } : {}),
      updatedAt: now,
      revision: existing.revision + 1,
    };
    validateNodeInput(next);
    validateCompleteNode(next);
    if (nextId === id) {
      this.writeNode(located.binding.database, next, normalizeTitle(next.title), scopeKeyForNode(next), expectedRevision);
    } else {
      this.writeRetypedNode(located.binding.database, id, next, normalizeTitle(next.title), expectedRevision);
    }
    return this.getFromDatabase(located.binding.database, nextId)!;
  }

  public get(id: string): MemoryNode | null {
    return this.locate(id)?.node ?? null;
  }

  private getFromDatabase(database: DatabaseSync, id: string): MemoryNode | null {
    const row = database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      tier: memoryTier(row.tier),
      sessionId: nullableText(row.session_id),
      workspaceId: text(row.workspace_id),
      workspaceName: text(row.workspace_name),
      subjectId: nullableText(row.subject_id),
      subjectName: nullableText(row.subject_name),
      type: nodeType(row.type),
      title: text(row.title),
      summary: text(row.summary),
      body: text(row.body),
      status: nodeStatus(row.status),
      confidence: number(row.confidence),
      assetIds: this.strings(database, "SELECT asset_id AS value FROM memory_node_assets WHERE node_id = ? ORDER BY asset_id", id),
      tags: this.strings(database, "SELECT tag AS value FROM memory_node_tags WHERE node_id = ? ORDER BY tag", id),
      attributes: jsonObject(row.attributes_json),
      evidence: (database.prepare("SELECT * FROM memory_evidence_refs WHERE node_id = ? ORDER BY created_at, id").all(id) as Record<string, unknown>[]).map(
        evidenceFromRow,
      ),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      revision: number(row.revision),
    };
  }

  public search(input: SearchMemoryNodesInput = {}): MemoryNode[] {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const nodes = this.searchBinding(this.local, input);
    const query = input.query?.trim() ?? "";
    return nodes
      .sort((left, right) =>
        (query ? memorySearchScore(right, query) - memorySearchScore(left, query) : 0)
        || right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  private searchBinding(binding: MemoryDatabaseBinding, input: SearchMemoryNodesInput): MemoryNode[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    const visibility = visibilityClause(binding, this.local.context);
    if (!visibility) return [];
    clauses.push(visibility.sql);
    params.push(...visibility.params);
    if (input.query?.trim()) {
      const terms = memorySearchTerms(input.query);
      if (terms.length === 0) return [];
      const termClause = `(
        lower(n.id) LIKE ? OR
        lower(n.type) LIKE ? OR
        lower(n.title) LIKE ? OR
        lower(n.summary) LIKE ? OR
        lower(n.body) LIKE ? OR
        lower(n.attributes_json) LIKE ? OR
        EXISTS (SELECT 1 FROM memory_node_assets a_query WHERE a_query.node_id = n.id AND lower(a_query.asset_id) LIKE ?) OR
        EXISTS (SELECT 1 FROM memory_node_tags t_query WHERE t_query.node_id = n.id AND lower(t_query.tag) LIKE ?) OR
        EXISTS (
          SELECT 1 FROM memory_evidence_refs e_query
          WHERE e_query.node_id = n.id AND (
            lower(e_query.path) LIKE ? OR
            lower(e_query.locator_json) LIKE ? OR
            lower(e_query.summary) LIKE ?
          )
        )
      )`;
      clauses.push(`(${terms.map(() => termClause).join(" OR ")})`);
      for (const term of terms) {
        const query = `%${term}%`;
        params.push(query, query, query, query, query, query, query, query, query, query, query);
      }
    }
    if (input.types?.length) {
      clauses.push(`n.type IN (${input.types.map(() => "?").join(",")})`);
      params.push(...input.types);
    }
    if (input.statuses?.length) {
      clauses.push(`n.status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    const tiers = input.tiers?.length ? input.tiers : ["workspace"];
    clauses.push(`n.tier IN (${tiers.map(() => "?").join(",")})`);
    params.push(...tiers);
    for (const assetId of input.assetIds ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_assets a WHERE a.node_id = n.id AND a.asset_id = ?)");
      params.push(assetId);
    }
    for (const tag of input.tags ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_tags t WHERE t.node_id = n.id AND t.tag = ?)");
      params.push(normalizeTag(tag));
    }
    params.push(100);
    const rows = binding.database
      .prepare(`SELECT n.id FROM memory_nodes n ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY n.updated_at DESC, n.id LIMIT ?`)
      .all(...params) as { id?: unknown }[];
    return rows.flatMap((row) => (typeof row.id === "string" ? [this.getFromDatabase(binding.database, row.id)!] : []));
  }

  public link(fromId: string, toId: string, relation: string, note = ""): MemoryEdge {
    const from = this.locate(fromId);
    const to = this.locate(toId);
    if (!from || !to) throw new Error("Both memory edge nodes must exist in the visible memory tiers.");
    const database = this.local.database;
    const cleanRelation = normalizeTag(relation);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO memory_edges(from_id, to_id, relation, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, relation) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(fromId, toId, cleanRelation, note.trim(), now, now);
    const row = database.prepare("SELECT * FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = ?").get(fromId, toId, cleanRelation) as Record<string, unknown>;
    return edgeFromRow(row);
  }

  public listEdges(nodeId?: string): MemoryEdge[] {
    const visibleIds = this.visibleNodeIds(this.local);
    if (nodeId) {
      const located = this.locate(nodeId);
      if (!located) return [];
      return (this.local.database.prepare("SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ? ORDER BY updated_at DESC").all(nodeId, nodeId) as Record<string, unknown>[])
        .map(edgeFromRow)
        .filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
    }
    return (this.local.database.prepare("SELECT * FROM memory_edges ORDER BY updated_at DESC").all() as Record<string, unknown>[])
      .map(edgeFromRow)
      .filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
  }

  private visibleNodeIds(binding: MemoryDatabaseBinding): Set<string> {
    const visibility = visibilityClause(binding, this.local.context);
    if (!visibility) return new Set();
    const rows = binding.database.prepare(`SELECT n.id FROM memory_nodes n WHERE ${visibility.sql}`).all(...visibility.params) as Array<{ id?: unknown }>;
    return new Set(rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []));
  }

  private locate(id: string): LocatedMemoryNode | null {
    const node = this.getFromDatabase(this.local.database, id);
    if (node && nodeIsVisible(node, this.local.context)) return { binding: this.local, node };
    return null;
  }

  private findByIdentity(tier: MemoryTier, scopeKey: string, type: MemoryNodeType, titleNorm: string): LocatedMemoryNode | null {
    const row = this.local.database
      .prepare("SELECT id FROM memory_nodes WHERE tier = ? AND scope_key = ? AND type = ? AND title_norm = ?")
      .get(tier, scopeKey, type, titleNorm) as { id?: unknown } | undefined;
    if (typeof row?.id !== "string") return null;
    const node = this.getFromDatabase(this.local.database, row.id);
    return node ? { binding: this.local, node } : null;
  }

  private findVisibleByIdentity(type: MemoryNodeType, titleNorm: string): LocatedMemoryNode | null {
    const visibility = visibilityClause(this.local, this.local.context);
    const row = this.local.database
      .prepare(
        `SELECT n.id FROM memory_nodes n
         WHERE n.type = ? AND n.title_norm = ? AND ${visibility.sql}
         ORDER BY CASE n.tier WHEN 'workspace' THEN 0 WHEN 'subject' THEN 1 ELSE 2 END,
                  n.updated_at DESC, n.id
         LIMIT 1`,
      )
      .get(type, titleNorm, ...visibility.params) as { id?: unknown } | undefined;
    if (typeof row?.id !== "string") return null;
    const node = this.getFromDatabase(this.local.database, row.id);
    return node ? { binding: this.local, node } : null;
  }

  private openBinding(
    Database: new (path: string) => DatabaseSync,
    databasePath: string,
    context: MemoryTierContext,
  ): MemoryDatabaseBinding {
    mkdirSync(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    MemoryGraphStore.initializeSchema(database);
    return { database, databasePath: resolveDatabasePath(databasePath), context };
  }

  public static initializeSchema(database: DatabaseSync): void {
    applyDatabaseMigrations(database, "honeycrisp_core", [
      {
        version: 1,
        name: "tiered_memory_graph_baseline",
        up(database) {
          database.exec(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        session_id TEXT,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        subject_id TEXT,
        subject_name TEXT,
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
        revision INTEGER NOT NULL DEFAULT 1
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
    `);
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_tier_identity_idx ON memory_nodes(tier, scope_key, type, title_norm);
      CREATE INDEX IF NOT EXISTS memory_nodes_context_idx ON memory_nodes(tier, scope_key, updated_at);
      CREATE INDEX IF NOT EXISTS memory_nodes_type_status_idx ON memory_nodes(type, status);
      CREATE INDEX IF NOT EXISTS memory_nodes_updated_at_idx ON memory_nodes(updated_at);
      CREATE INDEX IF NOT EXISTS memory_node_assets_asset_idx ON memory_node_assets(asset_id, node_id);
      CREATE INDEX IF NOT EXISTS memory_node_tags_tag_idx ON memory_node_tags(tag, node_id);
      CREATE INDEX IF NOT EXISTS memory_edges_to_idx ON memory_edges(to_id, relation);
      CREATE INDEX IF NOT EXISTS memory_evidence_node_idx ON memory_evidence_refs(node_id);
      DROP TABLE IF EXISTS honeycrisp_meta;
          `);
        },
      },
      {
        version: 2,
        name: "replace_finding_memory_with_trajectory",
        up(database) {
          database.prepare("UPDATE memory_nodes SET type = 'trajectory' WHERE type = 'finding'").run();
        },
      },
      {
        version: 3,
        name: "rename_legacy_finding_memory_ids",
        up(database) {
          renameLegacyFindingMemoryIds(database);
        },
      },
      {
        version: 4,
        name: "remove_peer_database_federation",
        up(database) {
          if (!tableExists(database, "memory_federated_edges")) return;
          const rows = database.prepare("SELECT * FROM memory_federated_edges").all() as Array<{
            from_id: string;
            to_id: string;
            relation: string;
            note: string;
            created_at: string;
            updated_at: string;
          }>;
          const insert = database.prepare(
            `INSERT INTO memory_edges(from_id, to_id, relation, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(from_id, to_id, relation) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
          );
          for (const row of rows) {
            insert.run(row.from_id, row.to_id, row.relation, row.note, row.created_at, row.updated_at);
          }
          database.exec("DROP TABLE memory_federated_edges");
        },
      },
      {
        version: 5,
        name: "workspace_runbook_artifacts",
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS honeycrisp_runbooks (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              workspace_name TEXT NOT NULL,
              subject_id TEXT,
              subject_name TEXT,
              session_id TEXT,
              title TEXT NOT NULL,
              purpose TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed', 'archived')),
              artifact_id TEXT NOT NULL UNIQUE,
              relative_path TEXT NOT NULL UNIQUE,
              content_hash TEXT NOT NULL,
              size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
              revision INTEGER NOT NULL CHECK (revision > 0),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS honeycrisp_runbooks_workspace_updated_idx
              ON honeycrisp_runbooks(workspace_id, updated_at);
            CREATE INDEX IF NOT EXISTS honeycrisp_runbooks_session_updated_idx
              ON honeycrisp_runbooks(session_id, updated_at);
          `);
        },
      },
    ]);
  }

  private writeNode(database: DatabaseSync, node: MemoryNode, titleNorm: string, scopeKey: string, expectedRevision?: number): void {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (expectedRevision !== undefined) {
        const row = database.prepare("SELECT revision FROM memory_nodes WHERE id = ?").get(node.id) as { revision?: unknown } | undefined;
        if (typeof row?.revision !== "number" || row.revision !== expectedRevision) {
          throw new Error(`Memory node revision conflict for ${node.id}: expected ${expectedRevision}, found ${String(row?.revision ?? "missing")}.`);
        }
      }
      database
        .prepare(
          `INSERT INTO memory_nodes(id, tier, scope_key, session_id, workspace_id, workspace_name, subject_id, subject_name, type, title, title_norm, summary, body, status, confidence, attributes_json, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_norm = excluded.title_norm, summary = excluded.summary,
             body = excluded.body, status = excluded.status, confidence = excluded.confidence, attributes_json = excluded.attributes_json,
             updated_at = excluded.updated_at, revision = excluded.revision`,
        )
        .run(node.id, node.tier, scopeKey, node.sessionId, node.workspaceId, node.workspaceName, node.subjectId, node.subjectName, node.type, node.title, titleNorm, node.summary, node.body, node.status, node.confidence, JSON.stringify(node.attributes), node.createdAt, node.updatedAt, node.revision);
      database.prepare("DELETE FROM memory_node_assets WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_tags WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_evidence_refs WHERE node_id = ?").run(node.id);
      for (const assetId of node.assetIds) database.prepare("INSERT INTO memory_node_assets(node_id, asset_id) VALUES (?, ?)").run(node.id, assetId);
      for (const tag of node.tags) database.prepare("INSERT INTO memory_node_tags(node_id, tag) VALUES (?, ?)").run(node.id, tag);
      for (const evidence of node.evidence) {
        database
          .prepare("INSERT INTO memory_evidence_refs(id, node_id, kind, path_base, path, locator_json, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(evidence.id, node.id, evidence.kind, evidence.pathBase ?? null, evidence.path ?? null, JSON.stringify(evidence.locator), evidence.summary, evidence.createdAt);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRetypedNode(
    database: DatabaseSync,
    previousId: string,
    node: MemoryNode,
    titleNorm: string,
    expectedRevision: number,
  ): void {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("PRAGMA defer_foreign_keys = ON");
      const row = database.prepare("SELECT revision FROM memory_nodes WHERE id = ?").get(previousId) as { revision?: unknown } | undefined;
      if (typeof row?.revision !== "number" || row.revision !== expectedRevision) {
        throw new Error(`Memory node revision conflict for ${previousId}: expected ${expectedRevision}, found ${String(row?.revision ?? "missing")}.`);
      }
      if (database.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(node.id)) {
        throw new Error(`Memory node reclassification conflicts with existing node: ${node.id}`);
      }
      database
        .prepare(
          `UPDATE memory_nodes
           SET id = ?, type = ?, title = ?, title_norm = ?, summary = ?, body = ?, status = ?, confidence = ?,
               attributes_json = ?, updated_at = ?, revision = ?
           WHERE id = ?`,
        )
        .run(node.id, node.type, node.title, titleNorm, node.summary, node.body, node.status, node.confidence, JSON.stringify(node.attributes), node.updatedAt, node.revision, previousId);
      database.prepare("UPDATE memory_node_assets SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_node_tags SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_evidence_refs SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      replaceMemoryEdgeNodeId(database, "memory_edges", previousId, node.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private strings(database: DatabaseSync, sql: string, value: string): string[] {
    return (database.prepare(sql).all(value) as { value?: unknown }[]).flatMap((row) => (typeof row.value === "string" ? [row.value] : []));
  }
}

function memorySearchTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z0-9][a-z0-9_./:-]*/g) ?? [];
  return [...new Set(terms.filter((term) => term.length > 1))].slice(0, 20);
}

function memorySearchScore(node: MemoryNode, query: string): number {
  const terms = memorySearchTerms(query);
  const id = node.id.toLowerCase();
  const type = node.type.toLowerCase();
  const title = node.title.toLowerCase();
  const summary = node.summary.toLowerCase();
  const body = node.body.toLowerCase();
  const attributes = JSON.stringify(node.attributes).toLowerCase();
  const assets = node.assetIds.join("\n").toLowerCase();
  const tags = node.tags.join("\n").toLowerCase();
  const evidence = node.evidence.map((item) => `${item.path ?? ""}\n${JSON.stringify(item.locator)}\n${item.summary}`).join("\n").toLowerCase();
  let score = query.toLowerCase().trim() === id ? 10_000 : 0;
  for (const term of terms) {
    if (id === term) score += 1_000;
    else if (id.includes(term)) score += 200;
    if (type === term) score += 80;
    if (title.includes(term)) score += 40;
    if (summary.includes(term)) score += 20;
    if (body.includes(term)) score += 10;
    if (attributes.includes(term)) score += 8;
    if (assets.includes(term)) score += 8;
    if (tags.includes(term)) score += 8;
    if (evidence.includes(term)) score += 6;
  }
  return score;
}

function validateNodeInput(input: { type: unknown; title: unknown; tier?: unknown; status?: unknown; confidence?: unknown; attributes?: unknown }): void {
  if (!MEMORY_NODE_TYPES.includes(input.type as MemoryNodeType)) throw new Error(`Unsupported memory node type: ${String(input.type)}`);
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Memory node title is required.");
  if (input.tier !== undefined && !MEMORY_TIERS.includes(input.tier as MemoryTier)) throw new Error(`Unsupported memory tier: ${String(input.tier)}`);
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

function validateCompleteNode(node: Pick<MemoryNode, "type" | "status" | "attributes" | "assetIds" | "evidence">): void {
  if (node.type === "hypothesis" && node.status === "confirmed") {
    throw new Error("A proven hypothesis must be reclassified as a primitive or chain instead of confirmed in place.");
  }
  if (node.type !== "bug") return;
  if (node.status !== "confirmed") throw new Error("Bug memories are reserved for confirmed historical flaw precedents.");
  if (node.attributes.historicalPrecedent !== true) throw new Error("Bug memories require attributes.historicalPrecedent=true.");
  if (node.assetIds.length === 0) throw new Error("Historical bug memories require at least one affected asset.");
  if (node.evidence.length === 0) throw new Error("Historical bug memories require precedent evidence.");
}

function readStoredTierContext(
  Database: new (path: string) => DatabaseSync,
  databasePath: string,
  workspaceRoot: string,
): MemoryTierContext | undefined {
  const database = new Database(databasePath);
  try {
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
        .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
    );
    if (!tables.has("workspaces") || !tables.has("scope_versions")) return undefined;
    const workspaceRow = database.prepare("SELECT id FROM workspaces WHERE workspace_path = ?").get(resolve(workspaceRoot)) as { id?: unknown } | undefined;
    const workspaceId = typeof workspaceRow?.id === "string" ? workspaceRow.id.trim() : "";
    if (!workspaceId) return undefined;
    const scopeRow = database
      .prepare("SELECT workspace_name, scope_owner FROM scope_versions WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(workspaceId) as Record<string, unknown> | undefined;
    const workspaceName = typeof scopeRow?.workspace_name === "string" && scopeRow.workspace_name.trim() ? scopeRow.workspace_name.trim() : "Workspace";
    const subjectName = typeof scopeRow?.scope_owner === "string" && scopeRow.scope_owner.trim() ? scopeRow.scope_owner.trim() : undefined;
    return {
      workspaceId,
      workspaceName,
      ...(subjectName ? { subjectId: stableSubjectId(subjectName), subjectName } : {}),
    };
  } finally {
    database.close();
  }
}

function normalizeTierContext(context: MemoryTierContext | undefined, workspaceRoot: string): MemoryTierContext {
  const resolvedRoot = resolve(workspaceRoot);
  const workspaceId = context?.workspaceId?.trim() || `workspace_${createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 20)}`;
  const workspaceName = context?.workspaceName?.trim() || basename(resolvedRoot) || "Workspace";
  const subjectName = context?.subjectName?.trim();
  const subjectId = context?.subjectId?.trim() || (subjectName ? stableSubjectId(subjectName) : undefined);
  return {
    ...(context?.sessionId?.trim() ? { sessionId: context.sessionId.trim() } : {}),
    workspaceId,
    workspaceName,
    ...(subjectId ? { subjectId } : {}),
    ...(subjectName ? { subjectName } : {}),
  };
}

function stableSubjectId(subjectName: string): string {
  const normalized = subjectName.trim().replace(/\s+/g, " ").toLowerCase();
  return `subject_${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function scopeKeyForTier(tier: MemoryTier, context: MemoryTierContext): string {
  if (tier === "session") {
    if (!context.sessionId) throw new Error("Session-tier memory requires a session id in workspace context.");
    return context.sessionId;
  }
  if (tier === "subject") {
    if (!context.subjectId) throw new Error("Subject-tier memory requires a scope owner or subject in workspace context.");
    return context.subjectId;
  }
  return context.workspaceId;
}

function scopeKeyForNode(node: MemoryNode): string {
  if (node.tier === "session") {
    if (!node.sessionId) throw new Error(`Session-tier memory is missing its session id: ${node.id}`);
    return node.sessionId;
  }
  if (node.tier === "subject") {
    if (!node.subjectId) throw new Error(`Subject-tier memory is missing its subject id: ${node.id}`);
    return node.subjectId;
  }
  return node.workspaceId;
}

function visibilityClause(
  _binding: MemoryDatabaseBinding,
  current: MemoryTierContext,
): { sql: string; params: string[] } {
  const clauses = ["(n.tier = 'workspace' AND n.scope_key = ?)"];
  const params = [current.workspaceId];
  if (current.sessionId) {
    clauses.push("(n.tier = 'session' AND n.scope_key = ?)");
    params.push(current.sessionId);
  }
  if (current.subjectId) {
    clauses.push("(n.tier = 'subject' AND n.scope_key = ?)");
    params.push(current.subjectId);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

function nodeIsVisible(node: MemoryNode, current: MemoryTierContext): boolean {
  if (node.tier === "session") return Boolean(current.sessionId) && node.sessionId === current.sessionId;
  if (node.tier === "subject") return Boolean(current.subjectId) && node.subjectId === current.subjectId;
  return node.workspaceId === current.workspaceId;
}

function resolveDatabasePath(path: string): string {
  return resolve(path);
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
function stableNodeId(tier: MemoryTier, scopeKey: string, type: MemoryNodeType, title: string): string { return `${type}_${createHash("sha256").update(`${tier}:${scopeKey}:${type}:${title}`).digest("hex").slice(0, 20)}`; }
function renameLegacyFindingMemoryIds(database: DatabaseSync): void {
  database.exec("PRAGMA defer_foreign_keys = ON");
  const rows = database
    .prepare("SELECT id, tier, scope_key, title_norm FROM memory_nodes WHERE type = 'trajectory' AND id GLOB 'finding_*'")
    .all() as Array<{ id: string; tier: MemoryTier; scope_key: string; title_norm: string }>;
  for (const row of rows) {
    const nextId = stableNodeId(row.tier, row.scope_key, "trajectory", row.title_norm);
    if (database.prepare("SELECT id FROM memory_nodes WHERE id = ?").get(nextId)) {
      throw new Error(`Cannot rename legacy finding memory ${row.id}; trajectory id already exists: ${nextId}.`);
    }
    database.prepare("UPDATE memory_nodes SET id = ? WHERE id = ?").run(nextId, row.id);
    database.prepare("UPDATE memory_node_assets SET node_id = ? WHERE node_id = ?").run(nextId, row.id);
    database.prepare("UPDATE memory_node_tags SET node_id = ? WHERE node_id = ?").run(nextId, row.id);
    database.prepare("UPDATE memory_evidence_refs SET node_id = ? WHERE node_id = ?").run(nextId, row.id);
    replaceMemoryEdgeNodeId(database, "memory_edges", row.id, nextId);
    if (tableExists(database, "memory_federated_edges")) {
      replaceMemoryEdgeNodeId(database, "memory_federated_edges", row.id, nextId);
    }
  }
}
function replaceMemoryEdgeNodeId(database: DatabaseSync, table: "memory_edges" | "memory_federated_edges", previousId: string, nextId: string): void {
  const edges = database
    .prepare(`SELECT from_id, to_id, relation, note, created_at, updated_at FROM ${table} WHERE from_id = ? OR to_id = ?`)
    .all(previousId, previousId) as Array<{ from_id: string; to_id: string; relation: string; note: string; created_at: string; updated_at: string }>;
  database.prepare(`DELETE FROM ${table} WHERE from_id = ? OR to_id = ?`).run(previousId, previousId);
  const insert = database.prepare(`INSERT INTO ${table} (from_id, to_id, relation, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const edge of edges) {
    insert.run(edge.from_id === previousId ? nextId : edge.from_id, edge.to_id === previousId ? nextId : edge.to_id, edge.relation, edge.note, edge.created_at, edge.updated_at);
  }
}
function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
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
function nullableText(value: unknown): string | null { return typeof value === "string" ? value : null; }
function number(value: unknown): number { if (typeof value !== "number") throw new Error("Expected SQLite number value."); return value; }
function memoryTier(value: unknown): MemoryTier { if (!MEMORY_TIERS.includes(value as MemoryTier)) throw new Error(`Unsupported stored memory tier: ${String(value)}`); return value as MemoryTier; }
function nodeType(value: unknown): MemoryNodeType { if (!MEMORY_NODE_TYPES.includes(value as MemoryNodeType)) throw new Error(`Unsupported stored memory node type: ${String(value)}`); return value as MemoryNodeType; }
function nodeStatus(value: unknown): MemoryNodeStatus { if (!MEMORY_NODE_STATUSES.includes(value as MemoryNodeStatus)) throw new Error(`Unsupported stored memory status: ${String(value)}`); return value as MemoryNodeStatus; }
