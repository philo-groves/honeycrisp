import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applyDatabaseMigrations } from "./database-migrations.js";
import {
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  normalizeResearchProfile,
  researchProfileHash,
} from "./research-profile.js";
import type {
  ResearchProfileMemory,
  ResearchProfileMemoryType,
  ResolvedResearchProfile,
} from "./research-profile.js";
import { getDefaultMemoryDatabasePath } from "./storage.js";
import { resolveStoredResearchWorkspaceBinding } from "./workspace-binding.js";

const require = createRequire(import.meta.url);
const NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE = normalizeResearchProfile(
  DEFAULT_SECURITY_RESEARCH_PROFILE,
);

export const MEMORY_CATALOG_HASH_DOMAIN = "honeycrisp:memory-catalog:v1\0";
export const MEMORY_CATALOG_COMPATIBILITY_HASH_DOMAIN = "honeycrisp:memory-catalog-compatibility:v1\0";
export const MEMORY_NODE_VALIDATION_HASH_DOMAIN = "honeycrisp:memory-node-validation:v1\0";
export const DEFAULT_SECURITY_MEMORY_CATALOG_HASH = memoryCatalogHash(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory,
);
export const DEFAULT_SECURITY_MEMORY_CATALOG_COMPATIBILITY_HASH = memoryCatalogCompatibilityHash(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory,
);

export const MEMORY_NODE_TYPES: readonly string[] = Object.freeze(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory.types.map((type) => type.id),
);
export const MEMORY_NODE_STATUSES: readonly string[] = Object.freeze(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory.statuses.map((status) => status.id),
);
export const MEMORY_SCOPES = ["session", "workspace", "subject"] as const;
export const MEMORY_EVIDENCE_KINDS: readonly string[] = Object.freeze(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory.evidenceKinds.map((kind) => kind.id),
);
export const MEMORY_EVIDENCE_PATH_BASES: readonly string[] = Object.freeze(
  DEFAULT_SECURITY_RESEARCH_PROFILE.memory.evidencePathBases.map((base) => base.id),
);

export type MemoryNodeType = string;
export type MemoryNodeStatus = string;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryContext {
  sessionId?: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string;
  subjectName: string;
}

export interface MemoryWorkspaceMembership {
  id: string;
  name: string;
}

export interface MemoryEvidenceRef {
  id: string;
  kind: string;
  pathBase?: string;
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

export interface MemoryNodeLinkInput {
  nodeId: string;
  relation: string;
  note?: string;
}

export type MemoryNodeValidationKind = "full" | "scoped" | "inherited";

export interface MemoryNodeProfileIdentity {
  hash: string;
  id: string;
  version: string;
}

export interface MemoryNodeCatalogValidation {
  nodeRevision: number;
  catalogHash: string;
  contentHash: string;
  kind: MemoryNodeValidationKind;
  validatedAt: string;
  researchProfile?: MemoryNodeProfileIdentity;
}

export type MemoryNodeProvenance =
  | {
      state: "legacy_unrecorded";
      catalogHash: null;
      activeCatalog: false;
      validation: null;
    }
  | {
      state: "catalog_unvalidated";
      catalogHash: string;
      activeCatalog: boolean;
      validation: null;
    }
  | {
      state: "active_validated";
      catalogHash: string;
      activeCatalog: true;
      validation: MemoryNodeCatalogValidation;
    }
  | {
      state: "foreign_validated";
      catalogHash: string;
      activeCatalog: false;
      validation: MemoryNodeCatalogValidation;
    };

export interface MemoryNode {
  id: string;
  sessionIds: string[];
  workspaces: MemoryWorkspaceMembership[];
  subjectId: string;
  subjectName: string;
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
  provenance: MemoryNodeProvenance;
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
  /** Outgoing links created atomically with this node write. */
  links?: readonly MemoryNodeLinkInput[];
}

export interface SearchMemoryNodesInput {
  query?: string;
  scope?: MemoryScope;
  types?: readonly MemoryNodeType[];
  statuses?: readonly MemoryNodeStatus[];
  assetIds?: readonly string[];
  tags?: readonly string[];
  limit?: number;
}

interface MemoryDatabaseBinding {
  database: DatabaseSync;
  databasePath: string;
  context: MemoryContext;
}

interface LocatedMemoryNode {
  binding: MemoryDatabaseBinding;
  node: MemoryNode;
}

interface ActiveMemoryCatalog {
  memory: ResearchProfileMemory;
  hash: string;
  json: string;
  profile?: MemoryNodeProfileIdentity;
  preservesLegacyNodeIds: boolean;
  typesById: ReadonlyMap<string, ResearchProfileMemoryType>;
  typesByAlias: ReadonlyMap<string, ResearchProfileMemoryType>;
  evidenceKinds: ReadonlyMap<string, ResearchProfileMemory["evidenceKinds"][number]>;
  evidencePathBases: ReadonlyMap<string, ResearchProfileMemory["evidencePathBases"][number]>;
  relationIds: ReadonlySet<string>;
}

interface MemoryNodeWriteProvenance {
  catalogHash: string | null;
  validation?: {
    kind: MemoryNodeValidationKind;
    profile?: MemoryNodeProfileIdentity;
  };
}

interface MemoryConstraintValidationScope {
  full: boolean;
  status: boolean;
  attributes: boolean;
  assetIds: boolean;
  evidence: boolean;
  neighbors: boolean;
}

interface PreparedMemoryLink {
  toId: string;
  relation: string;
  note: string;
  neighborType: string;
}

export interface MemoryGraphStoreOptions {
  workspaceRoot?: string;
  databasePath?: string;
  context?: MemoryContext;
  resolvedProfile?: ResolvedResearchProfile;
  profileMemory?: ResearchProfileMemory;
}

export class MemoryGraphStore {
  public readonly databasePath: string;
  private readonly local: MemoryDatabaseBinding;
  private readonly catalog: ActiveMemoryCatalog;

  public constructor(options: MemoryGraphStoreOptions = {}) {
    if (options.resolvedProfile && options.profileMemory) {
      throw new Error("Memory graph accepts either resolvedProfile or profileMemory, not both.");
    }
    if (options.resolvedProfile) {
      const actualProfileHash = researchProfileHash(options.resolvedProfile.profile);
      if (actualProfileHash !== options.resolvedProfile.hash) {
        throw new Error(
          `Resolved research profile hash mismatch: expected ${options.resolvedProfile.hash}, computed ${actualProfileHash}.`,
        );
      }
    }
    const profileIdentity = options.resolvedProfile
      ? {
          hash: options.resolvedProfile.hash,
          id: options.resolvedProfile.profile.id,
          version: options.resolvedProfile.profile.version,
        }
      : options.profileMemory
        ? undefined
        : {
            hash: researchProfileHash(NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE),
            id: NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE.id,
            version: NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE.version,
          };
    this.catalog = createActiveMemoryCatalog(
      options.resolvedProfile?.profile.memory
        ?? options.profileMemory
        ?? NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE.memory,
      profileIdentity,
    );
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.databasePath = options.databasePath ?? getDefaultMemoryDatabasePath(options.workspaceRoot ?? process.cwd());
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    const storedBinding = options.context
      ? undefined
      : resolveStoredResearchWorkspaceBinding({
          workspaceRoot,
          databasePath: this.databasePath,
        });
    const context = normalizeMemoryContext(
      options.context ?? storedBinding?.memoryContext,
      workspaceRoot,
    );
    this.local = this.openBinding(DatabaseSync, this.databasePath, context);
  }

  public close(): void {
    this.local.database.close();
  }

  public getContext(): MemoryContext {
    return { ...this.local.context };
  }

  public getProfileMemory(): ResearchProfileMemory {
    return this.catalog.memory;
  }

  public getMemoryCatalogHash(): string {
    return this.catalog.hash;
  }

  public save(input: SaveMemoryNodeInput): MemoryNode {
    validateNodeShape(input);
    const memoryType = this.requireCreatableType(input.type);
    const canonicalInput: SaveMemoryNodeInput = {
      ...input,
      type: memoryType.id,
    };
    const title = input.title.trim();
    const titleNorm = normalizeTitle(title);
    const existingLocation = this.findByIdentity(memoryType.id, titleNorm);
    this.validateExplicitNodeFields(canonicalInput, memoryType, !existingLocation);
    const existing = existingLocation?.node ?? null;
    const target = existingLocation?.binding ?? this.local;
    const now = new Date().toISOString();
    let id = existing?.id
      ?? canonicalInput.id
      ?? stableNodeId(this.local.context.subjectId, memoryType.id, titleNorm, this.catalog);
    if (!existing) {
      const conflicting = this.getFromDatabase(this.local.database, id);
      if (conflicting && canonicalInput.id) {
        throw new Error(`Memory node id already belongs to ${conflicting.type}: ${canonicalInput.id}`);
      }
      if (conflicting) {
        id = stableNodeId(
          this.local.context.subjectId,
          memoryType.id,
          titleNorm,
          this.catalog,
          true,
        );
        const catalogConflict = this.getFromDatabase(this.local.database, id);
        if (catalogConflict) {
          throw new Error(`Memory node identity conflicts with existing ${catalogConflict.type}: ${id}`);
        }
      }
    }
    const preparedLinks = this.prepareMemoryLinks([id], canonicalInput.links ?? []);
    const next: MemoryNode = existing
      ? {
          ...existing,
          sessionIds: mergeSessionMemberships(existing.sessionIds, this.local.context.sessionId),
          workspaces: mergeWorkspaceMemberships(existing.workspaces, this.local.context),
          summary: canonicalInput.summary?.trim() || existing.summary,
          body: canonicalInput.body?.trim() || existing.body,
          status: canonicalInput.status ?? existing.status,
          confidence: canonicalInput.confidence ?? existing.confidence,
          assetIds: unique([...existing.assetIds, ...(canonicalInput.assetIds ?? [])]),
          tags: unique([...existing.tags, ...(canonicalInput.tags ?? []).map(normalizeTag)]),
          attributes: mergeObjects(existing.attributes, canonicalInput.attributes ?? {}),
          evidence: mergeEvidence(existing.evidence, canonicalInput.evidence ?? [], id, now, this.catalog),
          updatedAt: now,
          revision: existing.revision + 1,
        }
      : {
          id,
          sessionIds: this.local.context.sessionId ? [this.local.context.sessionId] : [],
          workspaces: [{ id: this.local.context.workspaceId, name: this.local.context.workspaceName }],
          subjectId: this.local.context.subjectId,
          subjectName: this.local.context.subjectName,
          type: memoryType.id,
          title,
          summary: canonicalInput.summary?.trim() ?? "",
          body: canonicalInput.body?.trim() ?? "",
          status: canonicalInput.status ?? memoryType.defaultStatus,
          confidence: canonicalInput.confidence ?? 0.5,
          assetIds: unique(canonicalInput.assetIds ?? []),
          tags: unique((canonicalInput.tags ?? []).map(normalizeTag)),
          attributes: canonicalInput.attributes ?? {},
          evidence: mergeEvidence([], canonicalInput.evidence ?? [], id, now, this.catalog),
          createdAt: now,
          updatedAt: now,
          revision: 1,
          provenance: {
            state: "catalog_unvalidated",
            catalogHash: this.catalog.hash,
            activeCatalog: true,
            validation: null,
          },
        };
    const existingIsActivelyValidated = existing?.provenance.state === "active_validated";
    let validationKind: MemoryNodeValidationKind | null = null;
    if (!existing || nodeConstraintFieldsWereProvided(canonicalInput)) {
      const requiresFullValidation = !existing || !existingIsActivelyValidated;
      this.validateCompleteNode(
        next,
        memoryType,
        target.database,
        id,
        requiresFullValidation ? fullConstraintValidationScope() : constraintValidationScope(canonicalInput),
        new Set(preparedLinks.map((link) => link.neighborType)),
      );
      validationKind = requiresFullValidation ? "full" : "scoped";
    } else if (existingIsActivelyValidated) {
      validationKind = "inherited";
    }
    this.writeNode(
      target.database,
      next,
      titleNorm,
      activeCatalogWriteProvenance(this.catalog, validationKind),
      preparedLinks,
    );
    return this.getFromDatabase(target.database, id)!;
  }

  public correct(id: string, expectedRevision: number, patch: Partial<Omit<SaveMemoryNodeInput, "id">>): MemoryNode {
    const located = this.locate(id);
    const existing = located?.node;
    if (!existing || !located) throw new Error(`Memory node not found: ${id}`);
    if (existing.revision !== expectedRevision) {
      throw new Error(`Memory node revision conflict for ${id}: expected ${expectedRevision}, found ${existing.revision}.`);
    }
    validateNodeShape({ ...existing, ...patch });
    const now = new Date().toISOString();
    const requestedType = patch.type === undefined ? undefined : this.requireCreatableType(patch.type);
    const type = requestedType?.id ?? existing.type;
    const memoryType = requestedType ?? this.catalog.typesById.get(existing.type);
    const existingCatalogHash = existing.provenance.catalogHash;
    const participatesInActiveCatalog = nodeCanParticipateInActiveCatalog(existing, this.catalog);
    const targetsActiveCatalog = requestedType !== undefined
      || (existingCatalogHash !== null && participatesInActiveCatalog);
    const targetCatalogHash = requestedType !== undefined ? this.catalog.hash : existingCatalogHash;
    if (!memoryType && correctionTouchesCatalogFields(patch)) {
      throw new Error(`Cannot validate catalog fields for unknown stored memory node type: ${existing.type}`);
    }
    if (memoryType) this.validateExplicitNodeFields({ ...patch, type, title: patch.title ?? existing.title }, memoryType, false);
    const title = patch.title?.trim() ?? existing.title;
    const reidentifiesNode = requestedType !== undefined
      && (type !== existing.type || !participatesInActiveCatalog);
    const nextId = reidentifiesNode
      ? stableNodeId(
          existing.subjectId,
          type,
          normalizeTitle(title),
          this.catalog,
          type === existing.type && !participatesInActiveCatalog,
        )
      : id;
    if (patch.links !== undefined && requestedType === undefined && !participatesInActiveCatalog) {
      throw new Error("Memory nodes from another catalog must be explicitly reclassified before linking.");
    }
    const preparedLinks = this.prepareMemoryLinks([id, nextId], patch.links ?? []);
    const next: MemoryNode = {
      ...existing,
      id: nextId,
      sessionIds: mergeSessionMemberships(existing.sessionIds, this.local.context.sessionId),
      workspaces: mergeWorkspaceMemberships(existing.workspaces, this.local.context),
      type,
      title,
      ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.assetIds !== undefined ? { assetIds: unique(patch.assetIds) } : {}),
      ...(patch.tags !== undefined ? { tags: unique(patch.tags.map(normalizeTag)) } : {}),
      ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
      ...(patch.evidence !== undefined ? { evidence: mergeEvidence([], patch.evidence, nextId, now, this.catalog) } : {}),
      updatedAt: now,
      revision: existing.revision + 1,
    };
    const touchesCatalogFields = correctionTouchesCatalogFields(patch);
    let activeValidationKind: MemoryNodeValidationKind | null = null;
    if (memoryType && (requestedType !== undefined || touchesCatalogFields)) {
      const requiresFullValidation = requestedType !== undefined
        || (targetsActiveCatalog && existing.provenance.state !== "active_validated");
      this.validateCompleteNode(
        next,
        memoryType,
        located.binding.database,
        id,
        requiresFullValidation ? fullConstraintValidationScope() : constraintValidationScope(patch),
        new Set(preparedLinks.map((link) => link.neighborType)),
      );
      if (targetsActiveCatalog) activeValidationKind = requiresFullValidation ? "full" : "scoped";
    } else if (targetsActiveCatalog && existing.provenance.state === "active_validated") {
      activeValidationKind = "inherited";
    }
    let writeProvenance = activeValidationKind
      ? activeCatalogWriteProvenance(this.catalog, activeValidationKind)
      : { catalogHash: targetCatalogHash } satisfies MemoryNodeWriteProvenance;
    if (
      !targetsActiveCatalog
      && !touchesCatalogFields
      && existing.provenance.state === "foreign_validated"
    ) {
      writeProvenance = catalogWriteProvenance(
        existing.provenance.catalogHash,
        "inherited",
        existing.provenance.validation.researchProfile,
      );
    }
    if (nextId === id) {
      this.writeNode(
        located.binding.database,
        next,
        normalizeTitle(next.title),
        writeProvenance,
        preparedLinks,
        expectedRevision,
      );
    } else {
      this.writeRetypedNode(
        located.binding.database,
        id,
        next,
        normalizeTitle(next.title),
        writeProvenance,
        preparedLinks,
        expectedRevision,
      );
    }
    return this.getFromDatabase(located.binding.database, nextId)!;
  }

  public get(id: string): MemoryNode | null {
    return this.locate(id)?.node ?? null;
  }

  private getFromDatabase(database: DatabaseSync, id: string): MemoryNode | null {
    const row = database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const node: Omit<MemoryNode, "provenance"> = {
      id: text(row.id),
      sessionIds: this.strings(database, "SELECT session_id AS value FROM memory_node_sessions WHERE node_id = ? ORDER BY session_id", id),
      workspaces: (database
        .prepare("SELECT workspace_id, workspace_name FROM memory_node_workspaces WHERE node_id = ? ORDER BY workspace_name, workspace_id")
        .all(id) as Array<{ workspace_id: unknown; workspace_name: unknown }>).map((membership) => ({
          id: text(membership.workspace_id),
          name: text(membership.workspace_name),
        })),
      subjectId: text(row.subject_id),
      subjectName: text(row.subject_name),
      type: text(row.type),
      title: text(row.title),
      summary: text(row.summary),
      body: text(row.body),
      status: text(row.status),
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
    return {
      ...node,
      provenance: readMemoryNodeProvenance(database, node, nullableText(row.catalog_hash), this.catalog),
    };
  }

  public search(input: SearchMemoryNodesInput = {}): MemoryNode[] {
    const normalizedInput = input.types?.length
      ? {
          ...input,
          types: input.types.map((type) => {
            const normalizedType = type.trim();
            return this.catalog.typesByAlias.get(normalizedType)?.id ?? normalizedType;
          }),
        }
      : input;
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const nodes = this.searchBinding(this.local, normalizedInput);
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
    const visibility = visibilityClause(this.local.context);
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
    const scope = input.scope ?? "workspace";
    if (scope === "session") {
      if (!this.local.context.sessionId) return [];
      clauses.push("EXISTS (SELECT 1 FROM memory_node_sessions s_scope WHERE s_scope.node_id = n.id AND s_scope.session_id = ?)");
      params.push(this.local.context.sessionId);
    } else if (scope === "workspace") {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_workspaces w_scope WHERE w_scope.node_id = n.id AND w_scope.workspace_id = ?)");
      params.push(this.local.context.workspaceId);
    }
    for (const assetId of input.assetIds ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_assets a WHERE a.node_id = n.id AND a.asset_id = ?)");
      params.push(assetId);
    }
    for (const tag of input.tags ?? []) {
      clauses.push("EXISTS (SELECT 1 FROM memory_node_tags t WHERE t.node_id = n.id AND t.tag = ?)");
      params.push(normalizeTag(tag));
    }
    const rows = binding.database
      .prepare(`SELECT n.id FROM memory_nodes n ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY n.updated_at DESC, n.id`)
      .all(...params) as { id?: unknown }[];
    return rows
      .flatMap((row) => {
        if (typeof row.id !== "string") return [];
        const node = this.getFromDatabase(binding.database, row.id);
        return node && nodeCanParticipateInActiveCatalog(node, this.catalog) ? [node] : [];
      })
      .slice(0, 100);
  }

  public link(fromId: string, toId: string, relation: string, note = ""): MemoryEdge {
    const from = this.locate(fromId);
    const to = this.locate(toId);
    if (!from || !to) throw new Error("Both memory edge nodes must belong to the current subject.");
    if (!nodeCanParticipateInActiveCatalog(from.node, this.catalog)
      || !nodeCanParticipateInActiveCatalog(to.node, this.catalog)) {
      throw new Error("Memory edge nodes from another catalog must be explicitly reclassified before linking.");
    }
    const database = this.local.database;
    const requestedRelation = relation.trim();
    const cleanRelation = this.catalog.relationIds.has(requestedRelation)
      ? requestedRelation
      : normalizeTag(requestedRelation);
    if (!cleanRelation) throw new Error("Memory edge relation must be a non-empty relation ID.");
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
    const visibility = visibilityClause(this.local.context);
    const rows = binding.database
      .prepare(`SELECT n.id FROM memory_nodes n WHERE ${visibility.sql}`)
      .all(...visibility.params) as Array<{ id?: unknown }>;
    return new Set(rows.flatMap((row) => {
      if (typeof row.id !== "string") return [];
      const node = this.getFromDatabase(binding.database, row.id);
      return node && nodeCanParticipateInActiveCatalog(node, this.catalog) ? [node.id] : [];
    }));
  }

  private locate(id: string): LocatedMemoryNode | null {
    const node = this.getFromDatabase(this.local.database, id);
    if (node && nodeIsVisible(node, this.local.context)) return { binding: this.local, node };
    return null;
  }

  private findByIdentity(type: MemoryNodeType, titleNorm: string): LocatedMemoryNode | null {
    const rows = this.local.database
      .prepare(
        `SELECT n.id FROM memory_nodes n
         WHERE n.subject_id = ? AND n.catalog_hash IS NOT NULL AND n.type = ? AND n.title_norm = ?
         ORDER BY CASE WHEN n.catalog_hash = ? THEN 0 ELSE 1 END, n.updated_at DESC, n.id`,
      )
      .all(this.local.context.subjectId, type, titleNorm, this.catalog.hash) as Array<{ id?: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      const node = this.getFromDatabase(this.local.database, row.id);
      if (node && nodeCanParticipateInActiveCatalog(node, this.catalog)) {
        return { binding: this.local, node };
      }
    }
    return null;
  }

  private requireCreatableType(typeOrAlias: string): ResearchProfileMemoryType {
    const normalizedType = typeOrAlias.trim();
    const memoryType = this.catalog.typesByAlias.get(normalizedType);
    if (!memoryType) throw new Error(`Unsupported memory node type: ${String(typeOrAlias)}`);
    if (memoryType.lifecycle === "retired") {
      throw new Error(`Memory node type is retired and cannot be written: ${memoryType.id}`);
    }
    if (!memoryType.creatable) {
      throw new Error(`Memory node type is not creatable: ${memoryType.id}`);
    }
    return memoryType;
  }

  private validateExplicitNodeFields(
    input: Pick<SaveMemoryNodeInput, "type" | "title" | "status" | "attributes" | "evidence">,
    memoryType: ResearchProfileMemoryType,
    isNew: boolean,
  ): void {
    if (isNew && memoryType.requiresExplicitStatus && input.status === undefined) {
      throw new Error(`Memory node type ${memoryType.id} requires an explicit status.`);
    }
    if (input.status !== undefined && !memoryType.allowedStatuses.includes(input.status)) {
      if (memoryType.id === "hypothesis" && input.status === "confirmed") {
        throw new Error("A proven hypothesis must be reclassified as a primitive or chain instead of confirmed in place.");
      }
      throw new Error(`Memory node type ${memoryType.id} does not allow status: ${String(input.status)}`);
    }
    if (input.attributes !== undefined) validateAttributeValues(input.attributes, memoryType);
    for (const evidence of input.evidence ?? []) validateEvidence(evidence, this.catalog);
  }

  private validateCompleteNode(
    node: Pick<MemoryNode, "id" | "type" | "status" | "attributes" | "assetIds" | "evidence">,
    memoryType: ResearchProfileMemoryType,
    database: DatabaseSync,
    relationshipNodeId: string,
    scope: MemoryConstraintValidationScope,
    prospectiveNeighborTypes: ReadonlySet<string> = new Set(),
  ): void {
    if (scope.full && !memoryType.allowedStatuses.includes(node.status)) {
      if (memoryType.id === "hypothesis" && node.status === "confirmed") {
        throw new Error("A proven hypothesis must be reclassified as a primitive or chain instead of confirmed in place.");
      }
      throw new Error(`Memory node type ${memoryType.id} does not allow status: ${node.status}`);
    }
    if (scope.full) validateAttributeValues(node.attributes, memoryType);
    for (const requirement of memoryType.requirements ?? []) {
      if (requirement.statuses?.length && !requirement.statuses.includes(node.status)) continue;
      if (scope.full || scope.status || scope.attributes) {
        const requiredAttributes = requirement.requiredAttributes ?? [];
        const missingAttributes = requiredAttributes.filter(
          (name) => !hasRequiredAttribute(node.attributes, name),
        );
        if (missingAttributes.length > 0) {
          if (memoryType.id === "chain" && (missingAttributes.includes("impact") || missingAttributes.includes("reachability"))) {
            throw new Error("Chain nodes require non-empty impact and reachability attributes.");
          }
          throw new Error(`Memory node type ${memoryType.id} requires non-empty attributes: ${missingAttributes.join(", ")}.`);
        }
        if (!scope.full && scope.status) {
          validateAttributeValues(
            Object.fromEntries(requiredAttributes.map((name) => [name, node.attributes[name]])),
            memoryType,
          );
        }
      }
      if (requirement.requireAssetLinks && (scope.full || scope.status || scope.assetIds) && node.assetIds.length === 0) {
        if (memoryType.id === "bug") throw new Error("Historical bug memories require at least one affected asset.");
        throw new Error(`Memory node type ${memoryType.id} requires at least one asset link.`);
      }
      if (requirement.requireEvidence && (scope.full || scope.status || scope.evidence) && node.evidence.length === 0) {
        if (memoryType.id === "bug") throw new Error("Historical bug memories require precedent evidence.");
        throw new Error(`Memory node type ${memoryType.id} requires evidence.`);
      }
      if (requirement.requiredNeighborTypes?.length && (scope.full || scope.status || scope.neighbors)) {
        const neighborTypes = new Set([
          ...this.memoryNeighborTypes(database, relationshipNodeId),
          ...prospectiveNeighborTypes,
        ]);
        const missingNeighbors = requirement.requiredNeighborTypes.filter((type) => !neighborTypes.has(type));
        if (missingNeighbors.length > 0) {
          throw new Error(`Memory node type ${memoryType.id} requires linked neighbor types: ${missingNeighbors.join(", ")}.`);
        }
      }
    }
  }

  private prepareMemoryLinks(
    sourceIds: readonly string[],
    inputs: readonly MemoryNodeLinkInput[],
  ): PreparedMemoryLink[] {
    const prepared = new Map<string, PreparedMemoryLink>();
    const selfIds = new Set(sourceIds);
    for (const input of inputs) {
      const toId = input.nodeId?.trim();
      if (!toId) throw new Error("Memory link nodeId must be a non-empty string.");
      if (selfIds.has(toId)) throw new Error("Memory nodes cannot link to themselves.");
      const target = this.locate(toId);
      if (!target) throw new Error(`Memory link target does not belong to the current subject: ${toId}`);
      if (!nodeCanParticipateInActiveCatalog(target.node, this.catalog)) {
        throw new Error(`Memory link target from another catalog must be explicitly reclassified: ${toId}`);
      }
      const requestedRelation = input.relation?.trim();
      if (!requestedRelation) throw new Error("Memory link relation must be a non-empty relation ID.");
      const relation = this.catalog.relationIds.has(requestedRelation)
        ? requestedRelation
        : normalizeTag(requestedRelation);
      if (!relation) throw new Error("Memory link relation must be a non-empty relation ID.");
      const link: PreparedMemoryLink = {
        toId,
        relation,
        note: input.note?.trim() ?? "",
        neighborType: target.node.type,
      };
      prepared.set(`${toId}\0${relation}`, link);
    }
    return [...prepared.values()];
  }

  private memoryNeighborTypes(database: DatabaseSync, nodeId: string): ReadonlySet<string> {
    const rows = database.prepare(`
      SELECT other.id
      FROM memory_edges edge
      JOIN memory_nodes other
        ON other.id = CASE WHEN edge.from_id = ? THEN edge.to_id ELSE edge.from_id END
      WHERE edge.from_id = ? OR edge.to_id = ?
    `).all(nodeId, nodeId, nodeId) as Array<{ id?: unknown }>;
    const types = rows.flatMap((row) => {
      if (typeof row.id !== "string") return [];
      const neighbor = this.getFromDatabase(database, row.id);
      return neighbor && nodeCanParticipateInActiveCatalog(neighbor, this.catalog)
        ? [neighbor.type]
        : [];
    });
    return new Set(types);
  }

  private openBinding(
    Database: new (path: string) => DatabaseSync,
    databasePath: string,
    context: MemoryContext,
  ): MemoryDatabaseBinding {
    mkdirSync(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    try {
      database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      MemoryGraphStore.initializeSchema(database);
      registerMemoryCatalogSnapshot(database, this.catalog);
      return { database, databasePath: resolveDatabasePath(databasePath), context };
    } catch (error) {
      database.close();
      throw error;
    }
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
      {
        version: 6,
        name: "memory_context_memberships",
        up(database) {
          database.exec(`
            CREATE TABLE memory_node_sessions (
              node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
              session_id TEXT NOT NULL,
              PRIMARY KEY(node_id, session_id)
            );
            CREATE TABLE memory_node_workspaces (
              node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
              workspace_id TEXT NOT NULL,
              workspace_name TEXT NOT NULL,
              PRIMARY KEY(node_id, workspace_id)
            );
            INSERT OR IGNORE INTO memory_node_sessions(node_id, session_id)
              SELECT id, session_id FROM memory_nodes WHERE session_id IS NOT NULL AND trim(session_id) <> '';
            INSERT OR IGNORE INTO memory_node_workspaces(node_id, workspace_id, workspace_name)
              SELECT id, workspace_id, workspace_name FROM memory_nodes;
            UPDATE memory_nodes
              SET subject_id = 'subject_workspace:' || workspace_id
              WHERE subject_id IS NULL OR trim(subject_id) = '';
            UPDATE memory_nodes
              SET subject_name = workspace_name
              WHERE subject_name IS NULL OR trim(subject_name) = '';
            DROP INDEX IF EXISTS memory_nodes_tier_identity_idx;
            DROP INDEX IF EXISTS memory_nodes_context_idx;
            ALTER TABLE memory_nodes DROP COLUMN tier;
            ALTER TABLE memory_nodes DROP COLUMN scope_key;
            ALTER TABLE memory_nodes DROP COLUMN session_id;
            ALTER TABLE memory_nodes DROP COLUMN workspace_id;
            ALTER TABLE memory_nodes DROP COLUMN workspace_name;
            CREATE INDEX memory_nodes_subject_identity_idx ON memory_nodes(subject_id, type, title_norm, updated_at);
            CREATE INDEX memory_node_sessions_session_idx ON memory_node_sessions(session_id, node_id);
            CREATE INDEX memory_node_workspaces_workspace_idx ON memory_node_workspaces(workspace_id, node_id);
          `);
        },
      },
      {
        version: 7,
        name: "memory_catalog_provenance",
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS memory_catalog_snapshots (
              catalog_hash TEXT PRIMARY KEY,
              schema_version INTEGER NOT NULL CHECK (schema_version = 1),
              catalog_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS memory_catalog_snapshots_immutable_update
              BEFORE UPDATE ON memory_catalog_snapshots
              BEGIN
                SELECT RAISE(ABORT, 'memory catalog snapshots are immutable');
              END;
            CREATE TRIGGER IF NOT EXISTS memory_catalog_snapshots_immutable_delete
              BEFORE DELETE ON memory_catalog_snapshots
              BEGIN
                SELECT RAISE(ABORT, 'memory catalog snapshots are immutable');
              END;
          `);
          if (!tableHasColumn(database, "memory_nodes", "catalog_hash")) {
            database.exec(
              "ALTER TABLE memory_nodes ADD COLUMN catalog_hash TEXT REFERENCES memory_catalog_snapshots(catalog_hash)",
            );
          }
          database.exec(`
            CREATE TABLE IF NOT EXISTS memory_node_catalog_validations (
              node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE ON UPDATE CASCADE,
              node_revision INTEGER NOT NULL CHECK (node_revision > 0),
              catalog_hash TEXT NOT NULL REFERENCES memory_catalog_snapshots(catalog_hash),
              node_content_hash TEXT NOT NULL,
              validation_kind TEXT NOT NULL CHECK (validation_kind IN ('full', 'scoped', 'inherited')),
              research_profile_hash TEXT,
              research_profile_id TEXT,
              research_profile_version TEXT,
              validated_at TEXT NOT NULL,
              CHECK (
                (research_profile_hash IS NULL AND research_profile_id IS NULL AND research_profile_version IS NULL)
                OR
                (research_profile_hash IS NOT NULL AND research_profile_id IS NOT NULL AND research_profile_version IS NOT NULL)
              ),
              PRIMARY KEY(node_id, node_revision, catalog_hash)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_catalog_identity_idx
              ON memory_nodes(subject_id, catalog_hash, type, title_norm)
              WHERE catalog_hash IS NOT NULL;
            CREATE INDEX IF NOT EXISTS memory_node_catalog_validations_catalog_idx
              ON memory_node_catalog_validations(catalog_hash, node_id, node_revision);
          `);
        },
      },
      {
        version: 8,
        name: "workspace_report_artifacts",
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS honeycrisp_reports (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              workspace_name TEXT NOT NULL,
              subject_id TEXT,
              subject_name TEXT,
              session_id TEXT,
              title TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL CHECK (status IN ('complete', 'stale')),
              artifact_id TEXT NOT NULL UNIQUE,
              relative_path TEXT NOT NULL UNIQUE,
              content_hash TEXT NOT NULL,
              size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
              revision INTEGER NOT NULL CHECK (revision > 0),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS honeycrisp_reports_workspace_updated_idx
              ON honeycrisp_reports(workspace_id, updated_at);
            CREATE INDEX IF NOT EXISTS honeycrisp_reports_session_updated_idx
              ON honeycrisp_reports(session_id, updated_at);
          `);
        },
      },
      {
        version: 9,
        name: "workspace_artifact_revision_events",
        up(database) {
          database.exec(`
            CREATE TABLE IF NOT EXISTS honeycrisp_artifact_revisions (
              artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('runbook', 'report')),
              artifact_id TEXT NOT NULL,
              workspace_id TEXT NOT NULL,
              session_id TEXT,
              revision INTEGER NOT NULL CHECK (revision > 0),
              created_at TEXT NOT NULL,
              PRIMARY KEY (artifact_kind, artifact_id, revision)
            );
            CREATE INDEX IF NOT EXISTS honeycrisp_artifact_revisions_workspace_created_idx
              ON honeycrisp_artifact_revisions(workspace_id, created_at);
            CREATE INDEX IF NOT EXISTS honeycrisp_artifact_revisions_session_created_idx
              ON honeycrisp_artifact_revisions(session_id, created_at);

            INSERT OR IGNORE INTO honeycrisp_artifact_revisions (
              artifact_kind, artifact_id, workspace_id, session_id, revision, created_at
            )
            SELECT 'runbook', id, workspace_id, session_id, revision, updated_at
            FROM honeycrisp_runbooks;

            INSERT OR IGNORE INTO honeycrisp_artifact_revisions (
              artifact_kind, artifact_id, workspace_id, session_id, revision, created_at
            )
            SELECT 'report', id, workspace_id, session_id, revision, updated_at
            FROM honeycrisp_reports;
          `);
        },
      },
    ]);
  }

  private writeNode(
    database: DatabaseSync,
    node: MemoryNode,
    titleNorm: string,
    provenance: MemoryNodeWriteProvenance,
    links: readonly PreparedMemoryLink[] = [],
    expectedRevision?: number,
  ): void {
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
          `INSERT INTO memory_nodes(id, subject_id, subject_name, type, title, title_norm, summary, body, status, confidence, attributes_json, created_at, updated_at, revision, catalog_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id, subject_name = excluded.subject_name,
             type = excluded.type, title = excluded.title, title_norm = excluded.title_norm, summary = excluded.summary,
             body = excluded.body, status = excluded.status, confidence = excluded.confidence, attributes_json = excluded.attributes_json,
             updated_at = excluded.updated_at, revision = excluded.revision, catalog_hash = excluded.catalog_hash`,
        )
        .run(
          node.id,
          node.subjectId,
          node.subjectName,
          node.type,
          node.title,
          titleNorm,
          node.summary,
          node.body,
          node.status,
          node.confidence,
          JSON.stringify(node.attributes),
          node.createdAt,
          node.updatedAt,
          node.revision,
          provenance.catalogHash,
        );
      database.prepare("DELETE FROM memory_node_sessions WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_workspaces WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_assets WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_tags WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_evidence_refs WHERE node_id = ?").run(node.id);
      for (const sessionId of node.sessionIds) database.prepare("INSERT INTO memory_node_sessions(node_id, session_id) VALUES (?, ?)").run(node.id, sessionId);
      for (const workspace of node.workspaces) database.prepare("INSERT INTO memory_node_workspaces(node_id, workspace_id, workspace_name) VALUES (?, ?, ?)").run(node.id, workspace.id, workspace.name);
      for (const assetId of node.assetIds) database.prepare("INSERT INTO memory_node_assets(node_id, asset_id) VALUES (?, ?)").run(node.id, assetId);
      for (const tag of node.tags) database.prepare("INSERT INTO memory_node_tags(node_id, tag) VALUES (?, ?)").run(node.id, tag);
      for (const evidence of node.evidence) {
        database
          .prepare("INSERT INTO memory_evidence_refs(id, node_id, kind, path_base, path, locator_json, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(evidence.id, node.id, evidence.kind, evidence.pathBase ?? null, evidence.path ?? null, JSON.stringify(evidence.locator), evidence.summary, evidence.createdAt);
      }
      writePreparedMemoryLinks(database, node.id, links, node.updatedAt);
      writeMemoryNodeValidation(database, node, provenance);
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
    provenance: MemoryNodeWriteProvenance,
    links: readonly PreparedMemoryLink[],
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
               attributes_json = ?, updated_at = ?, revision = ?, catalog_hash = ?
           WHERE id = ?`,
        )
        .run(
          node.id,
          node.type,
          node.title,
          titleNorm,
          node.summary,
          node.body,
          node.status,
          node.confidence,
          JSON.stringify(node.attributes),
          node.updatedAt,
          node.revision,
          provenance.catalogHash,
          previousId,
        );
      database.prepare("UPDATE memory_node_assets SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_node_tags SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_evidence_refs SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_node_sessions SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("UPDATE memory_node_workspaces SET node_id = ? WHERE node_id = ?").run(node.id, previousId);
      database.prepare("DELETE FROM memory_node_sessions WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_workspaces WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_assets WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_node_tags WHERE node_id = ?").run(node.id);
      database.prepare("DELETE FROM memory_evidence_refs WHERE node_id = ?").run(node.id);
      for (const sessionId of node.sessionIds) database.prepare("INSERT INTO memory_node_sessions(node_id, session_id) VALUES (?, ?)").run(node.id, sessionId);
      for (const workspace of node.workspaces) database.prepare("INSERT INTO memory_node_workspaces(node_id, workspace_id, workspace_name) VALUES (?, ?, ?)").run(node.id, workspace.id, workspace.name);
      for (const assetId of node.assetIds) database.prepare("INSERT INTO memory_node_assets(node_id, asset_id) VALUES (?, ?)").run(node.id, assetId);
      for (const tag of node.tags) database.prepare("INSERT INTO memory_node_tags(node_id, tag) VALUES (?, ?)").run(node.id, tag);
      for (const evidence of node.evidence) {
        database
          .prepare("INSERT INTO memory_evidence_refs(id, node_id, kind, path_base, path, locator_json, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(evidence.id, node.id, evidence.kind, evidence.pathBase ?? null, evidence.path ?? null, JSON.stringify(evidence.locator), evidence.summary, evidence.createdAt);
      }
      replaceMemoryEdgeNodeId(database, "memory_edges", previousId, node.id);
      writePreparedMemoryLinks(database, node.id, links, node.updatedAt);
      writeMemoryNodeValidation(database, node, provenance);
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

function createActiveMemoryCatalog(
  memory: ResearchProfileMemory,
  profile: MemoryNodeProfileIdentity | undefined,
): ActiveMemoryCatalog {
  const normalizedMemory = normalizeProfileMemory(memory);
  const json = stableJson(normalizedMemory);
  const hash = memoryCatalogHashFromJson(json);
  const typesById = new Map(normalizedMemory.types.map((type) => [type.id, type]));
  const typesByAlias = new Map<string, ResearchProfileMemoryType>();
  for (const memoryType of normalizedMemory.types) {
    typesByAlias.set(memoryType.id, memoryType);
    for (const alias of memoryType.aliases ?? []) typesByAlias.set(alias, memoryType);
  }
  return {
    memory: normalizedMemory,
    hash,
    json,
    ...(profile ? { profile: { ...profile } } : {}),
    preservesLegacyNodeIds:
      memoryCatalogCompatibilityHashFromNormalized(normalizedMemory)
      === DEFAULT_SECURITY_MEMORY_CATALOG_COMPATIBILITY_HASH,
    typesById,
    typesByAlias,
    evidenceKinds: new Map(normalizedMemory.evidenceKinds.map((kind) => [kind.id, kind])),
    evidencePathBases: new Map(normalizedMemory.evidencePathBases.map((base) => [base.id, base])),
    relationIds: new Set((normalizedMemory.relations ?? []).map((relation) => relation.id)),
  };
}

export function memoryCatalogHash(memory: ResearchProfileMemory): string {
  return memoryCatalogHashFromJson(normalizedMemoryCatalogJson(memory));
}

/**
 * Hashes the catalog-wide stored-row validation contract. This is used only to
 * recognize the pre-profile security memory universe. Recorded profile
 * catalogs retain their exact snapshot hash and are compared per node so that
 * unrelated additive catalog changes do not orphan compatible knowledge.
 */
export function memoryCatalogCompatibilityHash(memory: ResearchProfileMemory): string {
  return memoryCatalogCompatibilityHashFromNormalized(normalizeProfileMemory(memory));
}

function memoryCatalogHashFromJson(json: string): string {
  return createHash("sha256")
    .update(MEMORY_CATALOG_HASH_DOMAIN)
    .update(json)
    .digest("hex");
}

function normalizedMemoryCatalogJson(memory: ResearchProfileMemory): string {
  return stableJson(normalizeProfileMemory(memory));
}

function normalizeProfileMemory(memory: ResearchProfileMemory): ResearchProfileMemory {
  return normalizeResearchProfile({
    ...NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE,
    capabilities: {
      ...NORMALIZED_DEFAULT_SECURITY_RESEARCH_PROFILE.capabilities,
      memoryEnabled: false,
    },
    memory,
  }).memory;
}

function memoryCatalogCompatibilityHashFromNormalized(memory: ResearchProfileMemory): string {
  return createHash("sha256")
    .update(MEMORY_CATALOG_COMPATIBILITY_HASH_DOMAIN)
    .update(stableJson(memoryCatalogCompatibilityProjection(memory)))
    .digest("hex");
}

function memoryCatalogCompatibilityProjection(memory: ResearchProfileMemory): unknown {
  return {
    schemaVersion: 1,
    types: sortedById(memory.types).map((memoryType) =>
      memoryTypeCompatibilityProjection(memory, memoryType)),
    evidenceKinds: sortedById(memory.evidenceKinds).map(evidenceKindCompatibilityProjection),
    evidencePathBases: sortedById(memory.evidencePathBases).map(evidencePathBaseCompatibilityProjection),
  };
}

function memoryTypeCompatibilityProjection(
  memory: ResearchProfileMemory,
  memoryType: ResearchProfileMemoryType,
): unknown {
  const statusesById = new Map(memory.statuses.map((status) => [status.id, status]));
  return {
    id: memoryType.id,
    allowedStatuses: sortedUniqueStrings(memoryType.allowedStatuses),
    statuses: sortedUniqueStrings(memoryType.allowedStatuses).map((statusId) => {
      const status = statusesById.get(statusId);
      return status
        ? {
            id: status.id,
            terminal: status.terminal === true,
            polarity: status.polarity ?? "neutral",
          }
        : { id: statusId, unresolved: true };
    }),
    attributes: Object.fromEntries(
      Object.entries(memoryType.attributes ?? {})
        .sort(([left], [right]) => ordinalCompare(left, right))
        .map(([id, definition]) => [
          id,
          {
            type: definition.type,
            ...(definition.pattern ? { pattern: definition.pattern } : {}),
            ...(definition.enum
              ? { enum: sortedUniqueValues(definition.enum) }
              : {}),
          },
        ]),
    ),
    requirements: [...(memoryType.requirements ?? [])]
      .map((requirement) => ({
        ...(requirement.statuses?.length
          ? { statuses: sortedUniqueStrings(requirement.statuses) }
          : {}),
        ...(requirement.requiredAttributes?.length
          ? { requiredAttributes: sortedUniqueStrings(requirement.requiredAttributes) }
          : {}),
        ...(requirement.requireEvidence === true ? { requireEvidence: true } : {}),
        ...(requirement.requireAssetLinks === true ? { requireAssetLinks: true } : {}),
        ...(requirement.requiredNeighborTypes?.length
          ? { requiredNeighborTypes: sortedUniqueStrings(requirement.requiredNeighborTypes) }
          : {}),
      }))
      .sort((left, right) => ordinalCompare(stableJson(left), stableJson(right))),
  };
}

function evidenceKindCompatibilityProjection(
  kind: ResearchProfileMemory["evidenceKinds"][number],
): unknown {
  return { id: kind.id, allowsPath: kind.allowsPath === true };
}

function evidencePathBaseCompatibilityProjection(
  base: ResearchProfileMemory["evidencePathBases"][number],
): unknown {
  return { id: base.id, pathFormat: base.pathFormat ?? "relative" };
}

function sortedById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => ordinalCompare(left.id, right.id));
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinalCompare);
}

function sortedUniqueValues(
  values: readonly (string | number | boolean)[],
): Array<string | number | boolean> {
  const byJson = new Map(values.map((value) => [stableJson(value), value]));
  return [...byJson.entries()]
    .sort(([left], [right]) => ordinalCompare(left, right))
    .map(([, value]) => value);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function registerMemoryCatalogSnapshot(database: DatabaseSync, catalog: ActiveMemoryCatalog): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO memory_catalog_snapshots(catalog_hash, schema_version, catalog_json, created_at)
       VALUES (?, 1, ?, ?)`,
    )
    .run(catalog.hash, catalog.json, new Date().toISOString());
  const row = database
    .prepare(
      "SELECT schema_version, catalog_json FROM memory_catalog_snapshots WHERE catalog_hash = ?",
    )
    .get(catalog.hash) as { schema_version?: unknown; catalog_json?: unknown } | undefined;
  const storedJson = typeof row?.catalog_json === "string" ? row.catalog_json : undefined;
  if (
    row?.schema_version !== 1
    || storedJson === undefined
    || storedJson !== catalog.json
    || memoryCatalogHashFromJson(storedJson) !== catalog.hash
  ) {
    throw new Error(`Stored memory catalog snapshot does not match catalog hash: ${catalog.hash}.`);
  }
}

function activeCatalogWriteProvenance(
  catalog: ActiveMemoryCatalog,
  validationKind: MemoryNodeValidationKind | null,
): MemoryNodeWriteProvenance {
  return validationKind
    ? catalogWriteProvenance(catalog.hash, validationKind, catalog.profile)
    : { catalogHash: catalog.hash };
}

function catalogWriteProvenance(
  catalogHash: string,
  kind: MemoryNodeValidationKind,
  profile: MemoryNodeProfileIdentity | undefined,
): MemoryNodeWriteProvenance {
  return {
    catalogHash,
    validation: {
      kind,
      ...(profile ? { profile: { ...profile } } : {}),
    },
  };
}

function writeMemoryNodeValidation(
  database: DatabaseSync,
  node: MemoryNode,
  provenance: MemoryNodeWriteProvenance,
): void {
  if (!provenance.validation) return;
  if (!provenance.catalogHash) {
    throw new Error(`Cannot validate memory node ${node.id} without recorded catalog provenance.`);
  }
  const profile = provenance.validation.profile;
  database
    .prepare(
      `INSERT INTO memory_node_catalog_validations(
         node_id, node_revision, catalog_hash, node_content_hash, validation_kind,
         research_profile_hash, research_profile_id, research_profile_version, validated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      node.id,
      node.revision,
      provenance.catalogHash,
      memoryNodeValidationHash(node),
      provenance.validation.kind,
      profile?.hash ?? null,
      profile?.id ?? null,
      profile?.version ?? null,
      node.updatedAt,
    );
}

function readMemoryNodeProvenance(
  database: DatabaseSync,
  node: Omit<MemoryNode, "provenance">,
  catalogHash: string | null,
  activeCatalog: ActiveMemoryCatalog,
): MemoryNodeProvenance {
  if (catalogHash === null) {
    return {
      state: "legacy_unrecorded",
      catalogHash: null,
      activeCatalog: false,
      validation: null,
    };
  }
  const isExactActiveCatalog = catalogHash === activeCatalog.hash;
  const snapshot = database
    .prepare("SELECT schema_version, catalog_json FROM memory_catalog_snapshots WHERE catalog_hash = ?")
    .get(catalogHash) as { schema_version?: unknown; catalog_json?: unknown } | undefined;
  const snapshotJson = typeof snapshot?.catalog_json === "string" ? snapshot.catalog_json : undefined;
  const snapshotIsValid = snapshot?.schema_version === 1
    && snapshotJson !== undefined
    && memoryCatalogHashFromJson(snapshotJson) === catalogHash;
  const sourceMemory = snapshotIsValid && snapshotJson !== undefined
    ? parseMemoryCatalogSnapshot(snapshotJson)
    : undefined;
  const isActiveCatalog = isExactActiveCatalog
    || (sourceMemory !== undefined
      && memoryNodeCatalogsAreCompatible(node, sourceMemory, activeCatalog.memory));
  const row = snapshotIsValid
    ? database
        .prepare(
          `SELECT node_revision, catalog_hash, node_content_hash, validation_kind,
                  research_profile_hash, research_profile_id, research_profile_version, validated_at
           FROM memory_node_catalog_validations
           WHERE node_id = ? AND node_revision = ? AND catalog_hash = ?`,
        )
        .get(node.id, node.revision, catalogHash) as Record<string, unknown> | undefined
    : undefined;
  if (
    !row
    || row.node_content_hash !== memoryNodeValidationHash(node)
    || !isMemoryNodeValidationKind(row.validation_kind)
  ) {
    return {
      state: "catalog_unvalidated",
      catalogHash,
      activeCatalog: isActiveCatalog,
      validation: null,
    };
  }
  const profileHash = nullableText(row.research_profile_hash);
  const profileId = nullableText(row.research_profile_id);
  const profileVersion = nullableText(row.research_profile_version);
  const hasProfile = profileHash !== null && profileId !== null && profileVersion !== null;
  const validation: MemoryNodeCatalogValidation = {
    nodeRevision: number(row.node_revision),
    catalogHash: text(row.catalog_hash),
    contentHash: text(row.node_content_hash),
    kind: row.validation_kind,
    validatedAt: text(row.validated_at),
    ...(hasProfile
      ? { researchProfile: { hash: profileHash, id: profileId, version: profileVersion } }
      : {}),
  };
  return isActiveCatalog
    ? {
        state: "active_validated",
        catalogHash,
        activeCatalog: true,
        validation,
      }
    : {
        state: "foreign_validated",
        catalogHash,
        activeCatalog: false,
        validation,
      };
}

function memoryNodeValidationHash(node: Omit<MemoryNode, "provenance"> | MemoryNode): string {
  return createHash("sha256")
    .update(MEMORY_NODE_VALIDATION_HASH_DOMAIN)
    .update(stableJson({
      id: node.id,
      sessionIds: [...node.sessionIds].sort(),
      workspaces: [...node.workspaces].sort((left, right) => left.id.localeCompare(right.id)),
      subjectId: node.subjectId,
      subjectName: node.subjectName,
      type: node.type,
      title: node.title,
      summary: node.summary,
      body: node.body,
      status: node.status,
      confidence: node.confidence,
      assetIds: [...node.assetIds].sort(),
      tags: [...node.tags].sort(),
      attributes: node.attributes,
      evidence: [...node.evidence].sort((left, right) => left.id.localeCompare(right.id)),
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      revision: node.revision,
    }))
    .digest("hex");
}

function nodeCanParticipateInActiveCatalog(
  node: MemoryNode,
  activeCatalog: Pick<ActiveMemoryCatalog, "preservesLegacyNodeIds">,
): boolean {
  return node.provenance.catalogHash === null
    ? activeCatalog.preservesLegacyNodeIds
    : node.provenance.activeCatalog;
}

function parseMemoryCatalogSnapshot(json: string): ResearchProfileMemory | undefined {
  try {
    return normalizeProfileMemory(JSON.parse(json) as ResearchProfileMemory);
  } catch {
    return undefined;
  }
}

function memoryNodeCatalogsAreCompatible(
  node: Pick<MemoryNode, "type" | "status" | "attributes" | "evidence">,
  sourceMemory: ResearchProfileMemory,
  activeMemory: ResearchProfileMemory,
): boolean {
  const sourceProjection = memoryNodeCatalogCompatibilityProjection(node, sourceMemory);
  const activeProjection = memoryNodeCatalogCompatibilityProjection(node, activeMemory);
  return sourceProjection !== undefined
    && activeProjection !== undefined
    && stableJson(sourceProjection) === stableJson(activeProjection);
}

function memoryNodeCatalogCompatibilityProjection(
  node: Pick<MemoryNode, "type" | "status" | "attributes" | "evidence">,
  memory: ResearchProfileMemory,
): unknown | undefined {
  const memoryType = memory.types.find((candidate) => candidate.id === node.type);
  if (!memoryType) return undefined;
  const typeProjection = memoryNodeTypeCompatibilityProjection(node, memory, memoryType);
  if (typeProjection === undefined) return undefined;
  const evidenceKinds = new Map(memory.evidenceKinds.map((kind) => [kind.id, kind]));
  const evidencePathBases = new Map(memory.evidencePathBases.map((base) => [base.id, base]));
  const usedEvidenceKinds = sortedUniqueStrings(node.evidence.map((evidence) => evidence.kind));
  const usedPathBases = sortedUniqueStrings(
    node.evidence.flatMap((evidence) => evidence.pathBase ? [evidence.pathBase] : []),
  );
  const projectedEvidenceKinds = usedEvidenceKinds.map((kindId) => {
    const kind = evidenceKinds.get(kindId);
    return kind ? evidenceKindCompatibilityProjection(kind) : undefined;
  });
  const projectedPathBases = usedPathBases.map((baseId) => {
    const base = evidencePathBases.get(baseId);
    return base ? evidencePathBaseCompatibilityProjection(base) : undefined;
  });
  if (projectedEvidenceKinds.some((kind) => kind === undefined)
    || projectedPathBases.some((base) => base === undefined)) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    type: typeProjection,
    evidenceKinds: projectedEvidenceKinds,
    evidencePathBases: projectedPathBases,
  };
}

function memoryNodeTypeCompatibilityProjection(
  node: Pick<MemoryNode, "type" | "status" | "attributes">,
  memory: ResearchProfileMemory,
  memoryType: ResearchProfileMemoryType,
): unknown | undefined {
  if (!memoryType.allowedStatuses.includes(node.status)) return undefined;
  const status = memory.statuses.find((candidate) => candidate.id === node.status);
  if (!status) return undefined;
  const attributes = Object.fromEntries(
    Object.keys(node.attributes)
      .sort(ordinalCompare)
      .map((id) => {
        const definition = memoryType.attributes?.[id];
        return [
          id,
          definition
            ? {
                type: definition.type,
                ...(definition.pattern ? { pattern: definition.pattern } : {}),
                ...(definition.enum ? { enum: sortedUniqueValues(definition.enum) } : {}),
              }
            : { unresolved: true },
        ];
      }),
  );
  const requirements = [...(memoryType.requirements ?? [])]
    .filter((requirement) => !requirement.statuses?.length || requirement.statuses.includes(node.status))
    .map((requirement) => ({
      ...(requirement.requiredAttributes?.length
        ? { requiredAttributes: sortedUniqueStrings(requirement.requiredAttributes) }
        : {}),
      ...(requirement.requireEvidence === true ? { requireEvidence: true } : {}),
      ...(requirement.requireAssetLinks === true ? { requireAssetLinks: true } : {}),
      ...(requirement.requiredNeighborTypes?.length
        ? { requiredNeighborTypes: sortedUniqueStrings(requirement.requiredNeighborTypes) }
        : {}),
    }))
    .sort((left, right) => ordinalCompare(stableJson(left), stableJson(right)));
  return {
    id: memoryType.id,
    status: {
      id: status.id,
      terminal: status.terminal === true,
      polarity: status.polarity ?? "neutral",
    },
    attributes,
    requirements,
  };
}

function isMemoryNodeValidationKind(value: unknown): value is MemoryNodeValidationKind {
  return value === "full" || value === "scoped" || value === "inherited";
}

function nodeConstraintFieldsWereProvided(input: SaveMemoryNodeInput): boolean {
  return input.status !== undefined
    || input.attributes !== undefined
    || input.assetIds !== undefined
    || input.evidence !== undefined
    || input.links !== undefined;
}

function fullConstraintValidationScope(): MemoryConstraintValidationScope {
  return { full: true, status: true, attributes: true, assetIds: true, evidence: true, neighbors: true };
}

function constraintValidationScope(
  input: Partial<Pick<SaveMemoryNodeInput, "status" | "attributes" | "assetIds" | "evidence" | "links">>,
): MemoryConstraintValidationScope {
  return {
    full: false,
    status: input.status !== undefined,
    attributes: input.attributes !== undefined,
    assetIds: input.assetIds !== undefined,
    evidence: input.evidence !== undefined,
    neighbors: input.links !== undefined,
  };
}

function correctionTouchesCatalogFields(
  patch: Partial<Omit<SaveMemoryNodeInput, "id">>,
): boolean {
  return patch.type !== undefined
    || patch.status !== undefined
    || patch.attributes !== undefined
    || patch.assetIds !== undefined
    || patch.evidence !== undefined
    || patch.links !== undefined;
}

function validateAttributeValues(
  attributes: Record<string, unknown>,
  memoryType: ResearchProfileMemoryType,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    const definition = memoryType.attributes?.[name];
    // Profile definitions constrain recognized fields while extension metadata remains open.
    if (!definition) continue;
    const validType = definition.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === definition.type;
    if (!validType) {
      throw new Error(`Memory node type ${memoryType.id} attribute ${name} must be a ${definition.type}.`);
    }
    if (definition.enum && !definition.enum.includes(value as never)) {
      throw new Error(`Memory node type ${memoryType.id} attribute ${name} has an unsupported value.`);
    }
    if (definition.pattern && typeof value === "string" && !new RegExp(definition.pattern, "u").test(value)) {
      throw new Error(`Memory node type ${memoryType.id} attribute ${name} does not match its required pattern.`);
    }
  }
}

function hasRequiredAttribute(attributes: Record<string, unknown>, name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(attributes, name)) return false;
  const value = attributes[name];
  return typeof value !== "string" || value.trim().length > 0;
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

function validateNodeShape(input: {
  type: unknown;
  title: unknown;
  status?: unknown;
  confidence?: unknown;
  attributes?: unknown;
  links?: unknown;
}): void {
  if (typeof input.type !== "string" || !input.type.trim()) throw new Error("Memory node type is required.");
  if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Memory node title is required.");
  if (input.status !== undefined && (typeof input.status !== "string" || !input.status.trim())) throw new Error("Memory node status must be a non-empty string.");
  if (input.confidence !== undefined && (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)) throw new Error("Memory confidence must be between 0 and 1.");
  if (input.attributes !== undefined && !isRecord(input.attributes)) throw new Error("Memory node attributes must be an object.");
  if (input.links !== undefined && !Array.isArray(input.links)) throw new Error("Memory node links must be an array.");
}

function normalizeMemoryContext(context: MemoryContext | undefined, workspaceRoot: string): MemoryContext {
  const resolvedRoot = resolve(workspaceRoot);
  const workspaceId = context?.workspaceId?.trim() || `workspace_${createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 20)}`;
  const workspaceName = context?.workspaceName?.trim() || basename(resolvedRoot) || "Workspace";
  const recordedSubjectName = context?.subjectName?.trim();
  const recordedSubjectId = context?.subjectId?.trim();
  const subjectName = recordedSubjectName || workspaceName;
  const subjectId = recordedSubjectId || (recordedSubjectName ? stableSubjectId(recordedSubjectName) : fallbackSubjectId(workspaceId));
  return {
    ...(context?.sessionId?.trim() ? { sessionId: context.sessionId.trim() } : {}),
    workspaceId,
    workspaceName,
    subjectId,
    subjectName,
  };
}

function stableSubjectId(subjectName: string): string {
  const normalized = subjectName.trim().replace(/\s+/g, " ").toLowerCase();
  return `subject_${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function fallbackSubjectId(workspaceId: string): string {
  return `subject_workspace:${workspaceId}`;
}

function visibilityClause(current: MemoryContext): { sql: string; params: string[] } {
  return {
    sql: "n.subject_id = ? AND EXISTS (SELECT 1 FROM memory_node_workspaces visible_workspace WHERE visible_workspace.node_id = n.id)",
    params: [current.subjectId],
  };
}

function nodeIsVisible(node: MemoryNode, current: MemoryContext): boolean {
  return node.subjectId === current.subjectId && node.workspaces.length > 0;
}

function resolveDatabasePath(path: string): string {
  return resolve(path);
}

function validateEvidence(
  item: Omit<MemoryEvidenceRef, "id" | "createdAt">,
  catalog: ActiveMemoryCatalog,
): void {
  const evidenceKind = catalog.evidenceKinds.get(item.kind);
  if (!evidenceKind) {
    throw new Error(`Unsupported memory evidence kind: ${String(item.kind)}`);
  }
  const pathBase = item.pathBase === undefined
    ? undefined
    : catalog.evidencePathBases.get(item.pathBase);
  if (item.pathBase !== undefined && !pathBase) {
    throw new Error(`Unsupported memory evidence path base: ${String(item.pathBase)}`);
  }
  if (item.path !== undefined) {
    if (typeof item.path !== "string" || !item.path.trim()) throw new Error("Memory evidence path must be a non-empty string.");
    if (!evidenceKind.allowsPath) throw new Error(`Memory evidence kind ${item.kind} does not allow a path.`);
    const pathFormat = pathBase?.pathFormat ?? "relative";
    const url = isUrlEvidencePath(item.path);
    if (pathFormat === "url" && !url) {
      throw new Error(`Memory evidence path base ${item.pathBase ?? "(none)"} requires a URL.`);
    }
    if (pathFormat !== "url" && !url && isAbsoluteEvidencePath(item.path)) {
      throw new Error("Memory evidence paths must be relative; use pathBase to identify their root.");
    }
    if (pathFormat === "relative" && url) {
      throw new Error(`Memory evidence path base ${item.pathBase ?? "(none)"} requires a relative path.`);
    }
  }
}

function isUrlEvidencePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function isAbsoluteEvidencePath(value: string): boolean {
  return /^(?:[\\/]|~[\\/])/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeTitle(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
function normalizeTag(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function stableNodeId(
  subjectId: string,
  type: MemoryNodeType,
  title: string,
  catalog: Pick<ActiveMemoryCatalog, "hash">,
  forceCatalogIdentity = false,
): string {
  // Stable type IDs, not presentation labels or whole-catalog revisions, are
  // the durable identity contract. The exact catalog hash is only a collision
  // namespace when an incompatible catalog already owns the primary ID.
  const identity = forceCatalogIdentity
    ? stableJson({ catalogHash: catalog.hash, subjectId, title, type })
    : `${subjectId}:${type}:${title}`;
  return `${type}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}
function legacyStableNodeId(tier: string, scopeKey: string, type: MemoryNodeType, title: string): string { return `${type}_${createHash("sha256").update(`${tier}:${scopeKey}:${type}:${title}`).digest("hex").slice(0, 20)}`; }
function renameLegacyFindingMemoryIds(database: DatabaseSync): void {
  database.exec("PRAGMA defer_foreign_keys = ON");
  const rows = database
    .prepare("SELECT id, tier, scope_key, title_norm FROM memory_nodes WHERE type = 'trajectory' AND id GLOB 'finding_*'")
    .all() as Array<{ id: string; tier: string; scope_key: string; title_norm: string }>;
  for (const row of rows) {
    const nextId = legacyStableNodeId(row.tier, row.scope_key, "trajectory", row.title_norm);
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
function writePreparedMemoryLinks(
  database: DatabaseSync,
  fromId: string,
  links: readonly PreparedMemoryLink[],
  now: string,
): void {
  const statement = database.prepare(
    `INSERT INTO memory_edges(from_id, to_id, relation, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_id, to_id, relation)
     DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  );
  for (const link of links) {
    statement.run(fromId, link.toId, link.relation, link.note, now, now);
  }
}
function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .some((row) => row.name === column);
}
function unique(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(); }
function mergeSessionMemberships(existing: readonly string[], sessionId: string | undefined): string[] {
  return unique([...existing, ...(sessionId ? [sessionId] : [])]);
}
function mergeWorkspaceMemberships(existing: readonly MemoryWorkspaceMembership[], context: MemoryContext): MemoryWorkspaceMembership[] {
  const byId = new Map(existing.map((workspace) => [workspace.id, workspace]));
  byId.set(context.workspaceId, { id: context.workspaceId, name: context.workspaceName });
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}
function mergeObjects(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> { return { ...base, ...update }; }
function mergeEvidence(
  existing: readonly MemoryEvidenceRef[],
  incoming: readonly Omit<MemoryEvidenceRef, "id" | "createdAt">[],
  nodeId: string,
  now: string,
  catalog: ActiveMemoryCatalog,
): MemoryEvidenceRef[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    validateEvidence(item, catalog);
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
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function jsonObject(value: unknown): Record<string, unknown> { if (typeof value !== "string") return {}; const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Expected SQLite text value."); return value; }
function nullableText(value: unknown): string | null { if (value === null || value === undefined) return null; return text(value); }
function number(value: unknown): number { if (typeof value !== "number") throw new Error("Expected SQLite number value."); return value; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}
