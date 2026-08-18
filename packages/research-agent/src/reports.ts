import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { MemoryGraphStore, type MemoryContext } from "./memory-graph.js";
import { registerResearchStorageArtifact, type ResearchStorageArtifactManifestEntry } from "./storage.js";
import type { ResearchArtifactRef, ResearchStorageLayout } from "./types.js";

const require = createRequire(import.meta.url);

export const REPORT_STATUSES = ["complete", "stale"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
const MAX_SUBMISSION_PACKET_BYTES = 128 * 1024 * 1024;

export interface ReportSubmissionPacket {
  artifactId: string;
  filename: string;
  sizeBytes: number;
  contentHash: string;
}

export interface ReportRecord {
  id: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string | null;
  subjectName: string | null;
  sessionId: string | null;
  title: string;
  summary: string;
  status: ReportStatus;
  artifactId: string;
  submissionPacket: ReportSubmissionPacket | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDocument extends ReportRecord {
  content: string;
}

interface ReportRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  subject_id: string | null;
  subject_name: string | null;
  session_id: string | null;
  title: string;
  summary: string;
  status: string;
  artifact_id: string;
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  submission_packet_artifact_id: string | null;
  submission_packet_filename: string | null;
  submission_packet_relative_path: string | null;
  submission_packet_content_hash: string | null;
  submission_packet_size_bytes: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class ReportStore {
  private readonly database: DatabaseSync;
  private readonly packetCandidateRoots: string[];

  public constructor(
    databasePath: string,
    private readonly storageLayout: ResearchStorageLayout,
    private readonly context: MemoryContext,
    options: { packetCandidateRoots?: readonly string[] } = {},
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    this.database = new DatabaseSync(databasePath);
    this.packetCandidateRoots = uniqueResolvedPaths(options.packetCandidateRoots ?? []);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    MemoryGraphStore.initializeSchema(this.database);
  }

  public close(): void { this.database.close(); }

  public list(options: { query?: string; statuses?: ReportStatus[]; limit?: number } = {}): ReportRecord[] {
    const query = options.query?.trim().toLowerCase() ?? "";
    const statuses = options.statuses?.filter((status) => REPORT_STATUSES.includes(status)) ?? [];
    const limit = clampInteger(options.limit ?? 50, 1, 200);
    return (this.database.prepare("SELECT * FROM honeycrisp_reports WHERE workspace_id = ? ORDER BY updated_at DESC, id")
      .all(this.context.workspaceId) as unknown as ReportRow[])
      .filter((row) => statuses.length === 0 || statuses.includes(row.status as ReportStatus))
      .filter((row) => !query || `${row.title}\n${row.summary}`.toLowerCase().includes(query))
      .slice(0, limit)
      .map((row) => this.toRecord(row));
  }

  public get(id: string): ReportDocument | null {
    const row = this.readRow(id);
    return row ? { ...this.toRecord(row), content: readFileSync(this.absolutePath(row.relative_path), "utf8") } : null;
  }

  public create(input: { title: string; summary: string; content: string; status?: ReportStatus; submissionPacketPath?: string }): {
    report: ReportRecord;
    artifactRef: ResearchArtifactRef;
    submissionPacketArtifactRef?: ResearchArtifactRef;
  } {
    const title = requiredText(input.title, "title", 240);
    const summary = requiredText(input.summary, "summary", 4_000);
    const content = requiredText(input.content, "content", 256_000);
    const status = input.status ?? "complete";
    validateStatus(status);
    const submissionPacketPath = input.submissionPacketPath
      ? validatedPacketSource(input.submissionPacketPath, this.packetCandidateRoots)
      : null;
    const id = `report_${randomUUID()}`;
    const now = new Date().toISOString();
    const relativePath = join("reports", safeSegment(this.context.workspaceId), `${id}.md`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const entry = this.writeAndRegister(id, relativePath, title, content);
      const packetEntry = submissionPacketPath
        ? this.importSubmissionPacket(id, title, submissionPacketPath)
        : null;
      this.database.prepare(`INSERT INTO honeycrisp_reports (
        id, workspace_id, workspace_name, subject_id, subject_name, session_id,
        title, summary, status, artifact_id, relative_path, content_hash, size_bytes,
        submission_packet_artifact_id, submission_packet_filename,
        submission_packet_relative_path, submission_packet_content_hash,
        submission_packet_size_bytes, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, this.context.workspaceId, this.context.workspaceName, this.context.subjectId ?? null,
        this.context.subjectName ?? null, this.context.sessionId ?? null, title, summary, status,
        id, relativePath, entry.contentHash, entry.sizeBytes,
        packetEntry?.id ?? null, packetEntry ? "submission.zip" : null,
        packetEntry?.relativePath ?? null, packetEntry?.contentHash ?? null,
        packetEntry?.sizeBytes ?? null, 1, now, now,
      );
      this.recordRevision(id, 1, now);
      this.database.exec("COMMIT");
      const row = this.readRow(id);
      if (!row) throw new Error(`Report was not persisted: ${id}`);
      return {
        report: this.toRecord(row),
        artifactRef: artifactRef(entry, title),
        ...(packetEntry ? { submissionPacketArtifactRef: submissionPacketArtifactRef(packetEntry, title) } : {}),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public revise(input: { id: string; expectedRevision: number; content: string; summary?: string; status?: ReportStatus; submissionPacketPath?: string }): {
    report: ReportRecord;
    artifactRef: ResearchArtifactRef;
    submissionPacketArtifactRef?: ResearchArtifactRef;
  } {
    const id = requiredText(input.id, "id", 200);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("expectedRevision must be a positive integer.");
    const content = requiredText(input.content, "content", 256_000);
    if (input.status) validateStatus(input.status);
    const submissionPacketPath = input.submissionPacketPath
      ? validatedPacketSource(input.submissionPacketPath, this.packetCandidateRoots)
      : null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.readRow(id);
      if (!row) throw new Error(`Report not found in this workspace: ${id}`);
      if (row.revision !== input.expectedRevision) throw new Error(`Report revision conflict for ${id}: expected ${input.expectedRevision}, found ${row.revision}.`);
      const summary = input.summary === undefined ? row.summary : requiredText(input.summary, "summary", 4_000);
      const status = input.status ?? row.status as ReportStatus;
      const revision = row.revision + 1;
      const updatedAt = new Date().toISOString();
      const entry = this.writeAndRegister(row.artifact_id, row.relative_path, row.title, content);
      const packetEntry = submissionPacketPath
        ? this.importSubmissionPacket(id, row.title, submissionPacketPath)
        : null;
      const packet = packetEntry ? submissionPacketFromEntry(packetEntry) : submissionPacketFromRow(row);
      this.database.prepare(`UPDATE honeycrisp_reports
        SET summary = ?, status = ?, content_hash = ?, size_bytes = ?,
          submission_packet_artifact_id = ?, submission_packet_filename = ?,
          submission_packet_relative_path = ?, submission_packet_content_hash = ?,
          submission_packet_size_bytes = ?, revision = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND revision = ?`).run(
        summary, status, entry.contentHash, entry.sizeBytes,
        packet?.artifactId ?? null, packet?.filename ?? null,
        packetEntry?.relativePath ?? row.submission_packet_relative_path,
        packet?.contentHash ?? null, packet?.sizeBytes ?? null,
        revision, updatedAt,
        id, this.context.workspaceId, input.expectedRevision,
      );
      this.recordRevision(id, revision, updatedAt);
      this.database.exec("COMMIT");
      const updated = this.readRow(id);
      if (!updated) throw new Error(`Report disappeared after revision: ${id}`);
      return {
        report: this.toRecord(updated),
        artifactRef: artifactRef(entry, row.title),
        ...(packetEntry ? { submissionPacketArtifactRef: submissionPacketArtifactRef(packetEntry, row.title) } : {}),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readRow(id: string): ReportRow | null {
    return (this.database.prepare("SELECT * FROM honeycrisp_reports WHERE id = ? AND workspace_id = ?")
      .get(id, this.context.workspaceId) as unknown as ReportRow | undefined) ?? null;
  }

  private recordRevision(artifactId: string, revision: number, createdAt: string): void {
    this.database.prepare(`INSERT INTO honeycrisp_artifact_revisions (
      artifact_kind, artifact_id, workspace_id, session_id, revision, created_at
    ) VALUES ('report', ?, ?, ?, ?, ?)`).run(
      artifactId,
      this.context.workspaceId,
      this.context.sessionId ?? null,
      revision,
      createdAt,
    );
  }

  private toRecord(row: ReportRow): ReportRecord {
    return {
      id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name,
      subjectId: row.subject_id, subjectName: row.subject_name, sessionId: row.session_id,
      title: row.title, summary: row.summary, status: row.status as ReportStatus,
      artifactId: row.artifact_id, submissionPacket: submissionPacketFromRow(row),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private writeAndRegister(artifactId: string, relativePath: string, title: string, content: string): ResearchStorageArtifactManifestEntry {
    const path = this.absolutePath(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return registerResearchStorageArtifact(this.storageLayout, { id: artifactId, path, kind: "report", purpose: `Research report: ${title}` });
  }

  private importSubmissionPacket(reportId: string, title: string, candidatePath: string): ResearchStorageArtifactManifestEntry {
    const sourcePath = validatedPacketSource(candidatePath, this.packetCandidateRoots);
    const relativePath = join("report-packets", safeSegment(this.context.workspaceId), reportId, "submission.zip");
    const path = this.absolutePath(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    copyFileSync(sourcePath, temporaryPath);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return registerResearchStorageArtifact(this.storageLayout, {
      id: `${reportId}_submission_packet`,
      path,
      kind: "submission-packet",
      purpose: `Submission packet for research report: ${title}`,
    });
  }

  private absolutePath(relativePath: string): string {
    const root = resolve(this.storageLayout.artifactDirectoryPath);
    const path = resolve(root, relativePath);
    const child = relative(root, path);
    if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\")) throw new Error("Report path escaped the artifact directory.");
    return path;
  }
}

function validateStatus(status: string): asserts status is ReportStatus {
  if (!REPORT_STATUSES.includes(status as ReportStatus)) throw new Error(`Unsupported report status: ${status}`);
}
function artifactRef(entry: ResearchStorageArtifactManifestEntry, title: string): ResearchArtifactRef {
  return { id: entry.id, kind: "report", uri: pathToFileURL(entry.path).href, summary: `Research report: ${title}`, contentHash: entry.contentHash };
}
function submissionPacketArtifactRef(entry: ResearchStorageArtifactManifestEntry, title: string): ResearchArtifactRef {
  return { id: entry.id, kind: "submission-packet", uri: pathToFileURL(entry.path).href, summary: `Submission packet for research report: ${title}`, contentHash: entry.contentHash };
}
function submissionPacketFromEntry(entry: ResearchStorageArtifactManifestEntry): ReportSubmissionPacket {
  return { artifactId: entry.id, filename: "submission.zip", sizeBytes: entry.sizeBytes, contentHash: entry.contentHash };
}
function submissionPacketFromRow(row: ReportRow): ReportSubmissionPacket | null {
  if (
    !row.submission_packet_artifact_id
    || !row.submission_packet_filename
    || !row.submission_packet_content_hash
    || row.submission_packet_size_bytes === null
  ) return null;
  return {
    artifactId: row.submission_packet_artifact_id,
    filename: row.submission_packet_filename,
    sizeBytes: row.submission_packet_size_bytes,
    contentHash: row.submission_packet_content_hash,
  };
}
function validatedPacketSource(value: string, allowedRoots: readonly string[]): string {
  const candidate = requiredText(value, "submissionPacketPath", 4_096);
  if (allowedRoots.length === 0) throw new Error("Submission packet import is unavailable without a configured workspace root.");
  const path = realpathSync(resolve(candidate));
  if (!allowedRoots.some((root) => pathInside(root, path))) {
    throw new Error("submissionPacketPath must resolve inside the active workspace.");
  }
  const file = statSync(path);
  if (!file.isFile()) throw new Error("submissionPacketPath must reference a file.");
  if (extname(path).toLowerCase() !== ".zip") throw new Error("submissionPacketPath must reference a .zip file.");
  if (file.size <= 0 || file.size > MAX_SUBMISSION_PACKET_BYTES) {
    throw new Error(`submissionPacketPath must be between 1 byte and ${MAX_SUBMISSION_PACKET_BYTES} bytes.`);
  }
  if (!hasZipSignature(path)) throw new Error("submissionPacketPath must contain a ZIP archive.");
  return path;
}
function hasZipSignature(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const signature = Buffer.alloc(4);
    if (readSync(descriptor, signature, 0, signature.length, 0) !== signature.length) return false;
    return signature[0] === 0x50 && signature[1] === 0x4b
      && ((signature[2] === 0x03 && signature[3] === 0x04)
        || (signature[2] === 0x05 && signature[3] === 0x06)
        || (signature[2] === 0x07 && signature[3] === 0x08));
  } finally {
    closeSync(descriptor);
  }
}
function uniqueResolvedPaths(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => realpathSync(resolve(value))))];
}
function pathInside(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return Boolean(child) && !isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\");
}
function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return value.trim();
}
function safeSegment(value: string): string { return value.replace(/[^a-zA-Z0-9_-]+/g, "_") || createHash("sha256").update(value).digest("hex").slice(0, 20); }
function clampInteger(value: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum; }
