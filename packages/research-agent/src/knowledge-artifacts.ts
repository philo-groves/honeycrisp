import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ReportDocument, RunbookDocument } from "./knowledge-types.js";
import { readHoneycrispReport } from "./report-document.js";
import { readHoneycrispRunbook } from "./runbook-document.js";
import {
  createResearchStorageLayout,
  resolveResearchStorageArtifact,
  type ResearchStorageArtifactManifestEntry,
} from "./storage.js";

const require = createRequire(import.meta.url);

export interface ResolvedKnowledgeArtifact {
  id: string;
  kind: string;
  purpose: string;
  path: string;
  relativePath: string;
  uri: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export function resolveKnowledgeArtifact(
  artifactId: string,
  options: { databasePath?: string; artifactDirectoryPath?: string; expectedKind?: string } = {},
): ResolvedKnowledgeArtifact {
  const cleanId = requiredText(artifactId, "artifactId");
  const layout = createResearchStorageLayout(options);
  const entry = resolveResearchStorageArtifact(layout, cleanId);
  if (!entry) throw new Error(`Artifact not found: ${cleanId}`);
  validateResolvedEntry(layout.artifactDirectoryPath, entry, options.expectedKind);
  return publicEntry(entry);
}

export function getKnowledgeRunbook(
  databasePath: string,
  artifactDirectoryPath: string,
  workspaceId: string,
  runbookId: string,
): RunbookDocument {
  const row = readArtifactRow(databasePath, "honeycrisp_runbooks", workspaceId, runbookId);
  const path = resolveStoredArtifactPath(artifactDirectoryPath, row, "runbook");
  return readHoneycrispRunbook(path, runbookId);
}

export function getKnowledgeReport(
  databasePath: string,
  artifactDirectoryPath: string,
  workspaceId: string,
  reportId: string,
): ReportDocument {
  const row = readArtifactRow(databasePath, "honeycrisp_reports", workspaceId, reportId);
  const path = resolveStoredArtifactPath(artifactDirectoryPath, row, "report");
  return readHoneycrispReport(path, reportId);
}

function readArtifactRow(
  databasePath: string,
  table: "honeycrisp_runbooks" | "honeycrisp_reports",
  workspaceId: string,
  id: string,
): { artifactId: string; relativePath: string } {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`SELECT artifact_id, relative_path FROM ${table} WHERE id = ? AND workspace_id = ?`)
      .get(requiredText(id, "id"), requiredText(workspaceId, "workspaceId")) as Record<string, unknown> | undefined;
    if (!row || typeof row.artifact_id !== "string" || typeof row.relative_path !== "string") {
      throw new Error(`${table === "honeycrisp_runbooks" ? "Runbook" : "Report"} not found in this workspace: ${id}`);
    }
    return { artifactId: row.artifact_id, relativePath: row.relative_path };
  } finally {
    database.close();
  }
}

function resolveStoredArtifactPath(
  artifactDirectoryPath: string,
  row: { artifactId: string; relativePath: string },
  expectedKind: "runbook" | "report",
): string {
  const layout = createResearchStorageLayout({ artifactDirectoryPath });
  const entry = resolveResearchStorageArtifact(layout, row.artifactId);
  if (entry) {
    validateResolvedEntry(layout.artifactDirectoryPath, entry, expectedKind);
    return entry.path;
  }
  // Rows written before the manifest became canonical retain a bounded path fallback.
  const path = resolveInside(layout.artifactDirectoryPath, row.relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${expectedKind === "runbook" ? "Runbook" : "Report"} artifact is missing: ${row.artifactId}`);
  return path;
}

function validateResolvedEntry(rootPath: string, entry: ResearchStorageArtifactManifestEntry, expectedKind?: string): void {
  if (expectedKind && entry.kind !== expectedKind) {
    throw new Error(`Artifact ${entry.id} has kind ${entry.kind}, expected ${expectedKind}.`);
  }
  resolveInside(rootPath, relative(resolve(rootPath), resolve(entry.path)));
  if (!existsSync(entry.path) || !statSync(entry.path).isFile()) throw new Error(`Artifact file is missing: ${entry.id}`);
}

function resolveInside(rootPath: string, relativePath: string): string {
  const root = resolve(rootPath);
  const path = resolve(root, relativePath);
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
    throw new Error("Artifact path escaped Honeycrisp storage.");
  }
  return path;
}

function publicEntry(entry: ResearchStorageArtifactManifestEntry): ResolvedKnowledgeArtifact {
  return {
    id: entry.id,
    kind: entry.kind,
    purpose: entry.purpose,
    path: entry.path,
    relativePath: entry.relativePath,
    uri: entry.uri,
    sizeBytes: entry.sizeBytes,
    contentHash: entry.contentHash,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function requiredText(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}
