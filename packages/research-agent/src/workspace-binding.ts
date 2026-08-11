import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeResearchProfile,
  researchProfileHash,
  resolveResearchProfile,
  type ResolvedResearchProfile,
} from "./research-profile.js";
import { getDefaultMemoryDatabasePath } from "./storage.js";
import type {
  ResearchMemoryContext,
  ResearchWorkspaceAuthorizationContext,
} from "./types.js";

const require = createRequire(import.meta.url);
const ALLOWED_NETWORK_ASSET_KINDS = new Set([
  "domain",
  "host",
  "ip_range",
  "service",
]);
const MAX_ALLOWED_NETWORK_DESTINATIONS = 200;

export interface ResolveStoredResearchWorkspaceBindingOptions {
  workspaceRoot?: string;
  databasePath?: string;
  externalSessionId?: string;
}

export interface StoredResearchWorkspaceBinding {
  schemaVersion: 1;
  source: "beale" | "deterministic";
  memoryContext: ResearchMemoryContext;
  authorization?: ResearchWorkspaceAuthorizationContext;
}

export interface ResolveStoredResearchProfileOptions {
  workspaceRoot?: string;
  databasePath?: string;
}

export type StoredResolvedResearchProfile = Omit<
  ResolvedResearchProfile,
  "path"
>;

/**
 * Resolve the durable identity and recorded authorization associated with a
 * workspace without returning the database path or any raw host metadata.
 */
export function resolveStoredResearchWorkspaceBinding(
  options: ResolveStoredResearchWorkspaceBindingOptions = {},
): StoredResearchWorkspaceBinding {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sessionId = normalizeExternalSessionId(options.externalSessionId);
  const fallback = deterministicBinding(workspaceRoot, sessionId);
  const databasePath =
    options.databasePath ?? getDefaultMemoryDatabasePath(workspaceRoot);
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    return fallback;
  }

  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => DatabaseSync;
  };
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const workspace = readStoredWorkspace(database, workspaceRoot);
    if (!workspace) return fallback;
    const scope = readActiveScope(database, workspace.id);
    const workspaceName = nonEmptyText(scope?.workspace_name)
      ?? (basename(workspaceRoot) || "Workspace");
    const subject = readStoredSubject(database, workspace.id);
    const scopeOwner = nonEmptyText(scope?.scope_owner);
    const subjectName = subject?.name ?? scopeOwner ?? workspaceName;
    const subjectId = subject?.id
      ?? (scopeOwner
        ? stableSubjectId(scopeOwner)
        : fallbackSubjectId(workspace.id));
    const memoryContext: ResearchMemoryContext = {
      ...(sessionId ? { sessionId } : {}),
      workspaceId: workspace.id,
      workspaceName,
      subjectId,
      subjectName,
    };
    const authorization = scope
      ? projectStoredAuthorization(database, scope)
      : undefined;

    return {
      schemaVersion: 1,
      source: "beale",
      memoryContext,
      ...(authorization ? { authorization } : {}),
    };
  } catch {
    throw new Error("Stored workspace binding could not be resolved.");
  } finally {
    database?.close();
  }
}

/**
 * Resolve Beale's active immutable profile snapshot for a workspace, falling
 * back to Honeycrisp's workspace profile resolution when no snapshot exists.
 * Host storage paths, including a snapshot's source_path, are never returned.
 */
export async function resolveStoredResearchProfile(
  options: ResolveStoredResearchProfileOptions = {},
): Promise<StoredResolvedResearchProfile> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const databasePath =
    options.databasePath ?? getDefaultMemoryDatabasePath(workspaceRoot);
  let snapshot: Record<string, unknown> | undefined;

  if (databasePath !== ":memory:" && existsSync(databasePath)) {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => DatabaseSync;
    };
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const workspace = readStoredWorkspace(database, workspaceRoot);
      snapshot = workspace
        ? readActiveResearchProfileSnapshot(database, workspace.id)
        : undefined;
    } catch {
      throw new Error("Stored research profile could not be resolved.");
    } finally {
      database?.close();
    }
  }

  if (snapshot) {
    try {
      return validateStoredResearchProfileSnapshot(snapshot);
    } catch {
      throw new Error("Stored research profile snapshot failed validation.");
    }
  }

  try {
    return withoutResearchProfilePath(
      await resolveResearchProfile({ workspaceRoot }),
    );
  } catch {
    throw new Error("Workspace research profile could not be resolved.");
  }
}

function deterministicBinding(
  workspaceRoot: string,
  sessionId: string | undefined,
): StoredResearchWorkspaceBinding {
  const workspaceId = `workspace_${createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 20)}`;
  const workspaceName = basename(workspaceRoot) || "Workspace";
  return {
    schemaVersion: 1,
    source: "deterministic",
    memoryContext: {
      ...(sessionId ? { sessionId } : {}),
      workspaceId,
      workspaceName,
      subjectId: fallbackSubjectId(workspaceId),
      subjectName: workspaceName,
    },
  };
}

function readStoredWorkspace(
  database: DatabaseSync,
  workspaceRoot: string,
): { id: string } | undefined {
  const columns = tableColumns(database, "workspaces");
  if (!columns.has("id") || !columns.has("workspace_path")) return undefined;
  const row = database
    .prepare("SELECT id FROM workspaces WHERE workspace_path = ?")
    .get(workspaceRoot) as Record<string, unknown> | undefined;
  const id = nonEmptyText(row?.id);
  return id ? { id } : undefined;
}

function readActiveResearchProfileSnapshot(
  database: DatabaseSync,
  workspaceId: string,
): Record<string, unknown> | undefined {
  const columns = tableColumns(database, "research_profile_snapshots");
  for (const required of [
    "workspace_id",
    "profile_id",
    "profile_version",
    "profile_hash",
    "source",
    "profile_json",
    "active",
  ]) {
    if (!columns.has(required)) return undefined;
  }
  return database
    .prepare(
      `SELECT profile_id, profile_version, profile_hash, source, profile_json
       FROM research_profile_snapshots
       WHERE workspace_id = ? AND active = 1
       LIMIT 1`,
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
}

function validateStoredResearchProfileSnapshot(
  snapshot: Record<string, unknown>,
): StoredResolvedResearchProfile {
  const expectedId = nonEmptyText(snapshot.profile_id);
  const expectedVersion = nonEmptyText(snapshot.profile_version);
  const expectedHash = nonEmptyText(snapshot.profile_hash);
  const source = snapshot.source;
  if (
    !expectedId
    || !expectedVersion
    || !expectedHash
    || (source !== "bundled-default"
      && source !== "workspace-default"
      && source !== "explicit")
    || typeof snapshot.profile_json !== "string"
  ) {
    throw new Error("Invalid stored research profile snapshot.");
  }
  const profile = normalizeResearchProfile(JSON.parse(snapshot.profile_json));
  const hash = researchProfileHash(profile);
  if (
    profile.id !== expectedId
    || profile.version !== expectedVersion
    || hash !== expectedHash
  ) {
    throw new Error("Stored research profile snapshot provenance does not match its content.");
  }
  return { profile, hash, source };
}

function withoutResearchProfilePath(
  resolved: ResolvedResearchProfile,
): StoredResolvedResearchProfile {
  return {
    profile: resolved.profile,
    hash: resolved.hash,
    source: resolved.source,
  };
}

function readActiveScope(
  database: DatabaseSync,
  workspaceId: string,
): Record<string, unknown> | undefined {
  const columns = tableColumns(database, "scope_versions");
  if (!columns.has("workspace_id") || !columns.has("status")) return undefined;
  const orderBy = columns.has("version")
    ? "version DESC"
    : columns.has("created_at")
      ? "created_at DESC"
      : "rowid DESC";
  return database
    .prepare(
      `SELECT * FROM scope_versions
       WHERE workspace_id = ? AND status = 'active'
       ORDER BY ${orderBy}
       LIMIT 1`,
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
}

function readStoredSubject(
  database: DatabaseSync,
  workspaceId: string,
): { id: string; name: string } | undefined {
  const columns = tableColumns(database, "workspace_research_subjects");
  if (
    !columns.has("workspace_id")
    || !columns.has("subject_id")
    || !columns.has("display_name")
  ) {
    return undefined;
  }
  const row = database
    .prepare(
      "SELECT subject_id, display_name FROM workspace_research_subjects WHERE workspace_id = ?",
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
  const id = nonEmptyText(row?.subject_id);
  const name = nonEmptyText(row?.display_name);
  return id && name ? { id, name } : undefined;
}

function projectStoredAuthorization(
  database: DatabaseSync,
  scope: Record<string, unknown>,
): ResearchWorkspaceAuthorizationContext | undefined {
  const scopeId = nonEmptyText(scope.id);
  const scopeName = nonEmptyText(scope.workspace_name);
  const scopeOwner = nonEmptyText(scope.scope_owner);
  const description = nonEmptyText(scope.description_markdown);
  const rules = nonEmptyText(scope.rules_markdown);
  const assetCount = scopeId ? countScopeAssets(database, scopeId) : 0;
  const recorded = Boolean(
    (scopeName && scopeName !== "Untitled Workspace")
    || scopeOwner
    || description
    || rules
    || assetCount > 0,
  );
  if (!recorded) return undefined;

  const networkProfile = readNetworkProfile(scope.network_policy_json);
  const includesNetworkDestinations =
    networkProfile === "scoped" || networkProfile === "elevated";
  const allowedNetworkDestinations =
    scopeId && includesNetworkDestinations
      ? readAllowedNetworkDestinations(database, scopeId)
      : [];
  const activeFrom = nonEmptyText(scope.active_from);
  const expiresAt = nonEmptyText(scope.expires_at);
  return {
    recorded: true,
    source: "beale",
    ...(scopeId ? { scopeId } : {}),
    ...(scopeName ? { scopeName } : {}),
    ...(scopeOwner ? { scopeOwner } : {}),
    ...(networkProfile ? { networkProfile } : {}),
    ...(includesNetworkDestinations
      ? { allowedNetworkDestinations }
      : {}),
    ...(activeFrom ? { activeFrom } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function countScopeAssets(database: DatabaseSync, scopeId: string): number {
  const columns = tableColumns(database, "scope_assets");
  if (!columns.has("scope_version_id")) return 0;
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM scope_assets WHERE scope_version_id = ?")
    .get(scopeId) as Record<string, unknown> | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function readAllowedNetworkDestinations(
  database: DatabaseSync,
  scopeId: string,
): string[] {
  const columns = tableColumns(database, "scope_assets");
  if (
    !columns.has("scope_version_id")
    || !columns.has("direction")
    || !columns.has("kind")
    || !columns.has("value")
  ) {
    return [];
  }
  const orderBy = columns.has("created_at") && columns.has("id")
    ? "created_at, id"
    : columns.has("created_at")
      ? "created_at"
      : columns.has("id")
        ? "id"
        : "rowid";
  const rows = database
    .prepare(
      `SELECT kind, value FROM scope_assets
       WHERE scope_version_id = ? AND direction = 'in_scope'
       ORDER BY ${orderBy}`,
    )
    .all(scopeId) as Record<string, unknown>[];
  const destinations = new Set<string>();
  for (const row of rows) {
    const kind = nonEmptyText(row.kind);
    const value = safeProjectedText(row.value);
    if (!kind || !ALLOWED_NETWORK_ASSET_KINDS.has(kind) || !value) continue;
    destinations.add(value);
    if (destinations.size >= MAX_ALLOWED_NETWORK_DESTINATIONS) break;
  }
  return [...destinations];
}

function readNetworkProfile(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return undefined;
    return safeProjectedText(parsed.defaultProfile);
  } catch {
    return undefined;
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return new Set();
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[])
      .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
  );
}

function normalizeExternalSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 500 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("External session id must be at most 500 printable characters.");
  }
  return normalized;
}

function stableSubjectId(subjectName: string): string {
  const normalized = subjectName.trim().replace(/\s+/g, " ").toLowerCase();
  return `subject_${createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 20)}`;
}

function fallbackSubjectId(workspaceId: string): string {
  return `subject_workspace:${workspaceId}`;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeProjectedText(value: unknown): string | undefined {
  const text = nonEmptyText(value);
  if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(text)) {
    return undefined;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
