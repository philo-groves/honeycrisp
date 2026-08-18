import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { MemoryGraphStore, type MemoryContext } from "./memory-graph.js";
import {
  registerResearchStorageArtifact,
  type ResearchStorageArtifactManifestEntry,
} from "./storage.js";
import type { ResearchArtifactRef, ResearchStorageLayout } from "./types.js";

const require = createRequire(import.meta.url);

export const RUNBOOK_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type RunbookStatus = (typeof RUNBOOK_STATUSES)[number];
export type RunbookCellKind = "markdown" | "code";
export type RunbookExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "skipped";
export const RUNBOOK_PROOF_TARGETS = ["localhost", "device", "vm", "web", "other"] as const;
export type RunbookProofTarget = (typeof RUNBOOK_PROOF_TARGETS)[number];

export interface RunbookExecutionState {
  runId: string;
  status: RunbookExecutionStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  proofTarget: RunbookProofTarget;
  deviceOs?: string;
}

export interface RunbookExecutionPlanCell {
  id: string;
  source: string;
  language: string | null;
}

export interface RunbookCellInput {
  kind: RunbookCellKind;
  source: string;
  language?: string;
  summary?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface RunbookRecord {
  id: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string | null;
  subjectName: string | null;
  sessionId: string | null;
  title: string;
  purpose: string;
  status: RunbookStatus;
  artifactId: string;
  cellCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookPage extends RunbookRecord {
  offset: number;
  totalCells: number;
  cells: RunbookCellInput[];
}

interface RunbookRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  subject_id: string | null;
  subject_name: string | null;
  session_id: string | null;
  title: string;
  purpose: string;
  status: string;
  artifact_id: string;
  relative_path: string;
  content_hash: string;
  size_bytes: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface NotebookCell {
  id?: string;
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: number | null;
  outputs?: Array<Record<string, unknown>>;
}

interface RunbookNotebook {
  cells: NotebookCell[];
  metadata: {
    honeycrisp: Record<string, unknown>;
  };
  nbformat: 4;
  nbformat_minor: 5;
}

export class RunbookStore {
  private readonly database: DatabaseSync;

  public constructor(
    private readonly databasePath: string,
    private readonly storageLayout: ResearchStorageLayout,
    private readonly context: MemoryContext,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    MemoryGraphStore.initializeSchema(this.database);
  }

  public close(): void {
    this.database.close();
  }

  public list(options: { query?: string; statuses?: RunbookStatus[]; limit?: number } = {}): RunbookRecord[] {
    const query = options.query?.trim().toLowerCase() ?? "";
    const statuses = options.statuses?.filter((status) => RUNBOOK_STATUSES.includes(status)) ?? [];
    const limit = clampInteger(options.limit ?? 50, 1, 200);
    return (this.database
      .prepare("SELECT * FROM honeycrisp_runbooks WHERE workspace_id = ? ORDER BY updated_at DESC, id")
      .all(this.context.workspaceId) as unknown as RunbookRow[])
      .filter((row) => statuses.length === 0 || statuses.includes(row.status as RunbookStatus))
      .filter((row) => !query || `${row.title}\n${row.purpose}`.toLowerCase().includes(query))
      .slice(0, limit)
      .map((row) => this.toRecord(row));
  }

  public get(id: string, options: { offset?: number; limit?: number } = {}): RunbookPage | null {
    const row = this.readRow(id);
    if (!row) return null;
    const notebook = this.readNotebook(row);
    const offset = clampInteger(options.offset ?? 0, 0, notebook.cells.length);
    const limit = clampInteger(options.limit ?? 40, 1, 100);
    return {
      ...this.toRecord(row, notebook.cells.length),
      offset,
      totalCells: notebook.cells.length,
      cells: notebook.cells.slice(offset, offset + limit).map(notebookCellToInput),
    };
  }

  public create(input: {
    title: string;
    purpose: string;
    status?: RunbookStatus;
    cells?: RunbookCellInput[];
  }): { runbook: RunbookRecord; artifactRef: ResearchArtifactRef } {
    const title = requiredText(input.title, "title", 240);
    const purpose = requiredText(input.purpose, "purpose", 4_000);
    const status = input.status ?? "active";
    validateStatus(status);
    const cells = (input.cells ?? []).map(validateCell);
    if (cells.length > 20) throw new Error("A runbook can be created with at most 20 cells.");

    const id = `runbook_${randomUUID()}`;
    const artifactId = id;
    const now = new Date().toISOString();
    const relativePath = join("runbooks", safeSegment(this.context.workspaceId), `${id}.ipynb`);
    const notebook = createNotebook({ id, title, purpose, status, context: this.context, revision: 1, createdAt: now, updatedAt: now, cells });

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const entry = this.writeAndRegister(id, artifactId, relativePath, title, notebook);
      this.database
        .prepare(
          `INSERT INTO honeycrisp_runbooks (
             id, workspace_id, workspace_name, subject_id, subject_name, session_id,
             title, purpose, status, artifact_id, relative_path, content_hash,
             size_bytes, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.context.workspaceId,
          this.context.workspaceName,
          this.context.subjectId ?? null,
          this.context.subjectName ?? null,
          this.context.sessionId ?? null,
          title,
          purpose,
          status,
          artifactId,
          relativePath,
          entry.contentHash,
          entry.sizeBytes,
          1,
          now,
          now,
        );
      this.recordRevision(id, 1, now);
      this.database.exec("COMMIT");
      const row = this.readRow(id);
      if (!row) throw new Error(`Runbook was not persisted: ${id}`);
      return { runbook: this.toRecord(row, notebook.cells.length), artifactRef: artifactRef(entry, title) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public append(input: {
    id: string;
    expectedRevision: number;
    cells: RunbookCellInput[];
    status?: RunbookStatus;
  }): { runbook: RunbookRecord; artifactRef: ResearchArtifactRef } {
    const id = requiredText(input.id, "id", 200);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("expectedRevision must be a positive integer.");
    if (!Array.isArray(input.cells) || input.cells.length === 0) throw new Error("cells must contain at least one cell.");
    if (input.cells.length > 20) throw new Error("At most 20 cells can be appended at once.");
    const cells = input.cells.map(validateCell);
    if (input.status) validateStatus(input.status);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.readRow(id);
      if (!row) throw new Error(`Runbook not found in this workspace: ${id}`);
      if (row.revision !== input.expectedRevision) {
        throw new Error(`Runbook revision conflict for ${id}: expected ${input.expectedRevision}, found ${row.revision}.`);
      }
      const current = this.readNotebook(row);
      const revision = row.revision + 1;
      const updatedAt = new Date().toISOString();
      const status = input.status ?? row.status as RunbookStatus;
      const notebook: RunbookNotebook = {
        ...current,
        cells: [...current.cells, ...cells.map(inputToNotebookCell)],
        metadata: {
          honeycrisp: {
            ...current.metadata.honeycrisp,
            status,
            revision,
            updatedAt,
          },
        },
      };
      const entry = this.writeAndRegister(id, row.artifact_id, row.relative_path, row.title, notebook);
      this.database
        .prepare(
          `UPDATE honeycrisp_runbooks
           SET status = ?, content_hash = ?, size_bytes = ?, revision = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND revision = ?`,
        )
        .run(status, entry.contentHash, entry.sizeBytes, revision, updatedAt, id, this.context.workspaceId, input.expectedRevision);
      this.recordRevision(id, revision, updatedAt);
      this.database.exec("COMMIT");
      const updated = this.readRow(id);
      if (!updated) throw new Error(`Runbook disappeared after append: ${id}`);
      return { runbook: this.toRecord(updated, notebook.cells.length), artifactRef: artifactRef(entry, row.title) };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public executionPlan(id: string, cellId?: string): RunbookExecutionPlanCell[] {
    const row = this.readRow(requiredText(id, "id", 200));
    if (!row) throw new Error(`Runbook not found in this workspace: ${id}`);
    if (row.status === "archived") throw new Error("Archived runbooks cannot be executed.");
    const notebook = this.readNotebook(row);
    const cells = notebook.cells
      .map((cell, index) => ({ cell, id: notebookCellId(cell, index) }))
      .filter(({ cell }) => cell.cell_type === "code")
      .filter(({ id: candidateId }) => !cellId || candidateId === cellId)
      .map(({ cell, id: candidateId }) => {
        const honeycrisp = isRecord(cell.metadata.honeycrisp) ? cell.metadata.honeycrisp : {};
        const vscode = isRecord(cell.metadata.vscode) ? cell.metadata.vscode : {};
        return {
          id: candidateId,
          source: cell.source.join(""),
          language: typeof honeycrisp.language === "string"
            ? honeycrisp.language
            : typeof vscode.languageId === "string"
              ? vscode.languageId
              : null,
        };
      });
    if (cellId && cells.length === 0) throw new Error(`Code cell not found in runbook ${id}: ${cellId}`);
    if (cells.length === 0) throw new Error("Runbook has no executable code cells.");
    return cells;
  }

  public beginExecution(
    id: string,
    runId: string,
    cellIds: readonly string[],
    proofTarget: RunbookProofTarget,
    deviceOs?: string,
  ): void {
    const startedAt = new Date().toISOString();
    this.updateNotebook(id, (notebook) => {
      notebook.metadata.honeycrisp.latestRun = {
        runId,
        status: "running",
        startedAt,
        cellCount: cellIds.length,
        proofTarget,
        ...(deviceOs ? { deviceOs } : {}),
      };
      notebook.cells.forEach((cell, index) => {
        const cellId = notebookCellId(cell, index);
        if (!cellIds.includes(cellId)) return;
        setCellExecution(cell, { runId, status: "queued", startedAt, proofTarget, ...(deviceOs ? { deviceOs } : {}) });
      });
    });
  }

  public beginCellExecution(
    id: string,
    runId: string,
    cellId: string,
    proofTarget: RunbookProofTarget,
    deviceOs?: string,
  ): void {
    const startedAt = new Date().toISOString();
    this.updateNotebook(id, (notebook) => {
      const cell = requireNotebookCell(notebook, cellId);
      setCellExecution(cell, { runId, status: "running", startedAt, proofTarget, ...(deviceOs ? { deviceOs } : {}) });
    });
  }

  public completeCellExecution(input: {
    id: string;
    runId: string;
    cellId: string;
    status: "succeeded" | "failed" | "blocked";
    startedAt: string;
    completedAt: string;
    durationMs: number;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
    proofTarget: RunbookProofTarget;
    deviceOs?: string;
  }): void {
    this.updateNotebook(input.id, (notebook) => {
      const cell = requireNotebookCell(notebook, input.cellId);
      setCellExecution(cell, {
        runId: input.runId,
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
        proofTarget: input.proofTarget,
        ...(input.deviceOs ? { deviceOs: input.deviceOs } : {}),
      });
      const honeycrisp = isRecord(cell.metadata.honeycrisp) ? cell.metadata.honeycrisp : {};
      cell.metadata.honeycrisp = {
        ...honeycrisp,
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      };
      cell.execution_count = (cell.execution_count ?? 0) + 1;
      cell.outputs = [];
      if (input.stdout) cell.outputs.push({ output_type: "stream", name: "stdout", text: sourceLines(input.stdout) });
      if (input.stderr) cell.outputs.push({ output_type: "stream", name: "stderr", text: sourceLines(input.stderr) });
      if (input.error && !input.stderr) {
        cell.outputs.push({ output_type: "error", ename: input.status, evalue: input.error, traceback: [input.error] });
      }
    });
  }

  public skipCellExecutions(
    id: string,
    runId: string,
    cellIds: readonly string[],
    reason: string,
    proofTarget: RunbookProofTarget,
    deviceOs?: string,
  ): void {
    if (cellIds.length === 0) return;
    const completedAt = new Date().toISOString();
    this.updateNotebook(id, (notebook) => {
      notebook.cells.forEach((cell, index) => {
        const cellId = notebookCellId(cell, index);
        if (!cellIds.includes(cellId)) return;
        setCellExecution(cell, {
          runId,
          status: "skipped",
          startedAt: completedAt,
          completedAt,
          durationMs: 0,
          error: reason.slice(0, 2_000),
          proofTarget,
          ...(deviceOs ? { deviceOs } : {}),
        });
      });
    });
  }

  public completeExecution(input: {
    id: string;
    runId: string;
    status: "succeeded" | "failed" | "blocked";
    startedAt: string;
    completedAt: string;
    durationMs: number;
    error?: string;
    proofTarget: RunbookProofTarget;
    deviceOs?: string;
  }): void {
    this.updateNotebook(input.id, (notebook) => {
      notebook.metadata.honeycrisp.latestRun = {
        runId: input.runId,
        status: input.status,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
        proofTarget: input.proofTarget,
        ...(input.deviceOs ? { deviceOs: input.deviceOs } : {}),
      };
    });
  }

  private updateNotebook(id: string, mutate: (notebook: RunbookNotebook) => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.readRow(requiredText(id, "id", 200));
      if (!row) throw new Error(`Runbook not found in this workspace: ${id}`);
      const notebook = this.readNotebook(row);
      mutate(notebook);
      const revision = row.revision + 1;
      const updatedAt = new Date().toISOString();
      notebook.metadata.honeycrisp = {
        ...notebook.metadata.honeycrisp,
        revision,
        updatedAt,
      };
      const entry = this.writeAndRegister(id, row.artifact_id, row.relative_path, row.title, notebook);
      this.database.prepare(
        `UPDATE honeycrisp_runbooks
         SET content_hash = ?, size_bytes = ?, revision = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND revision = ?`,
      ).run(entry.contentHash, entry.sizeBytes, revision, updatedAt, id, this.context.workspaceId, row.revision);
      this.recordRevision(id, revision, updatedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readRow(id: string): RunbookRow | null {
    return (this.database
      .prepare("SELECT * FROM honeycrisp_runbooks WHERE id = ? AND workspace_id = ?")
      .get(id, this.context.workspaceId) as unknown as RunbookRow | undefined) ?? null;
  }

  private recordRevision(artifactId: string, revision: number, createdAt: string): void {
    this.database.prepare(`INSERT INTO honeycrisp_artifact_revisions (
      artifact_kind, artifact_id, workspace_id, session_id, revision, created_at
    ) VALUES ('runbook', ?, ?, ?, ?, ?)`).run(
      artifactId,
      this.context.workspaceId,
      this.context.sessionId ?? null,
      revision,
      createdAt,
    );
  }

  private toRecord(row: RunbookRow, knownCellCount?: number): RunbookRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      sessionId: row.session_id,
      title: row.title,
      purpose: row.purpose,
      status: row.status as RunbookStatus,
      artifactId: row.artifact_id,
      cellCount: knownCellCount ?? this.readNotebook(row).cells.length,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readNotebook(row: RunbookRow): RunbookNotebook {
    const path = this.absolutePath(row.relative_path);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.nbformat !== 4 || !Array.isArray(parsed.cells) || !isRecord(parsed.metadata) || !isRecord(parsed.metadata.honeycrisp)) {
      throw new Error(`Runbook artifact is not a supported Honeycrisp nbformat 4 notebook: ${row.id}`);
    }
    return parsed as unknown as RunbookNotebook;
  }

  private writeAndRegister(
    id: string,
    artifactId: string,
    relativePath: string,
    title: string,
    notebook: RunbookNotebook,
  ): ResearchStorageArtifactManifestEntry {
    const path = this.absolutePath(relativePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(notebook, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return registerResearchStorageArtifact(this.storageLayout, {
      id: artifactId,
      path,
      kind: "runbook",
      purpose: `Research runbook: ${title}`,
    });
  }

  private absolutePath(relativePath: string): string {
    const root = resolve(this.storageLayout.artifactDirectoryPath);
    const path = resolve(root, relativePath);
    const child = relative(root, path);
    if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\")) throw new Error("Runbook path escaped the artifact directory.");
    return path;
  }
}

function createNotebook(input: {
  id: string;
  title: string;
  purpose: string;
  status: RunbookStatus;
  context: MemoryContext;
  revision: number;
  createdAt: string;
  updatedAt: string;
  cells: RunbookCellInput[];
}): RunbookNotebook {
  return {
    cells: [
      inputToNotebookCell({ kind: "markdown", source: `# ${input.title}\n\n${input.purpose}`, summary: "Runbook purpose" }),
      ...input.cells.map(inputToNotebookCell),
    ],
    metadata: {
      honeycrisp: {
        schemaVersion: 1,
        artifactFamily: "runbook",
        runbookId: input.id,
        workspaceId: input.context.workspaceId,
        workspaceName: input.context.workspaceName,
        subjectId: input.context.subjectId ?? null,
        subjectName: input.context.subjectName ?? null,
        sessionId: input.context.sessionId ?? null,
        status: input.status,
        revision: input.revision,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function inputToNotebookCell(cell: RunbookCellInput): NotebookCell {
  const metadata: Record<string, unknown> = {
    honeycrisp: {
      ...(cell.language ? { language: cell.language } : {}),
      ...(cell.summary ? { summary: cell.summary } : {}),
      recordedAt: new Date().toISOString(),
      ...(cell.exitCode !== undefined ? { exitCode: cell.exitCode } : {}),
    },
    ...(cell.language ? { vscode: { languageId: cell.language } } : {}),
  };
  const id = `cell-${randomUUID()}`;
  if (cell.kind === "markdown") return { id, cell_type: "markdown", metadata, source: sourceLines(cell.source) };
  const outputs: Array<Record<string, unknown>> = [];
  if (cell.stdout) outputs.push({ output_type: "stream", name: "stdout", text: sourceLines(cell.stdout) });
  if (cell.stderr) outputs.push({ output_type: "stream", name: "stderr", text: sourceLines(cell.stderr) });
  return { id, cell_type: "code", metadata, source: sourceLines(cell.source), execution_count: null, outputs };
}

function notebookCellId(cell: NotebookCell, index: number): string {
  return typeof cell.id === "string" && cell.id.trim() ? cell.id.trim() : `cell-${index + 1}`;
}

function requireNotebookCell(notebook: RunbookNotebook, cellId: string): NotebookCell {
  const cell = notebook.cells.find((candidate, index) => notebookCellId(candidate, index) === cellId);
  if (!cell || cell.cell_type !== "code") throw new Error(`Runbook code cell not found: ${cellId}`);
  return cell;
}

function setCellExecution(cell: NotebookCell, execution: RunbookExecutionState): void {
  const honeycrisp = isRecord(cell.metadata.honeycrisp) ? cell.metadata.honeycrisp : {};
  cell.metadata.honeycrisp = { ...honeycrisp, latestRun: execution };
}

function notebookCellToInput(cell: NotebookCell): RunbookCellInput {
  const honeycrisp = isRecord(cell.metadata?.honeycrisp) ? cell.metadata.honeycrisp : {};
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  return {
    kind: cell.cell_type,
    source: cell.source.join(""),
    ...(typeof honeycrisp.language === "string" ? { language: honeycrisp.language } : {}),
    ...(typeof honeycrisp.summary === "string" ? { summary: honeycrisp.summary } : {}),
    ...(typeof honeycrisp.exitCode === "number" ? { exitCode: honeycrisp.exitCode } : {}),
    ...streamOutput(outputs, "stdout"),
    ...streamOutput(outputs, "stderr"),
  };
}

function streamOutput(outputs: Array<Record<string, unknown>>, name: "stdout" | "stderr"): Partial<RunbookCellInput> {
  const text = outputs
    .filter((output) => output.output_type === "stream" && output.name === name)
    .flatMap((output) => Array.isArray(output.text) ? output.text.filter((item): item is string => typeof item === "string") : typeof output.text === "string" ? [output.text] : [])
    .join("");
  return text ? { [name]: text } : {};
}

function validateCell(value: RunbookCellInput): RunbookCellInput {
  if (!isRecord(value)) throw new Error("Each runbook cell must be an object.");
  if (value.kind !== "markdown" && value.kind !== "code") throw new Error("Runbook cell kind must be markdown or code.");
  const source = requiredText(value.source, "cell source", 64_000);
  const language = optionalText(value.language, "cell language", 40);
  const summary = optionalText(value.summary, "cell summary", 500);
  const stdout = optionalText(value.stdout, "cell stdout", 64_000, true);
  const stderr = optionalText(value.stderr, "cell stderr", 64_000, true);
  if (value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)) throw new Error("cell exitCode must be a non-negative integer.");
  return {
    kind: value.kind,
    source,
    ...(language ? { language } : {}),
    ...(summary ? { summary } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
  };
}

function validateStatus(status: string): asserts status is RunbookStatus {
  if (!RUNBOOK_STATUSES.includes(status as RunbookStatus)) throw new Error(`Unsupported runbook status: ${status}`);
}

function artifactRef(entry: ResearchStorageArtifactManifestEntry, title: string): ResearchArtifactRef {
  return {
    id: entry.id,
    kind: "runbook",
    uri: pathToFileURL(entry.path).href,
    summary: `Research runbook: ${title}`,
    contentHash: entry.contentHash,
  };
}

function sourceLines(source: string): string[] {
  const lines = source.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return lines.length > 0 ? lines : [""];
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} must be a string.`);
  if (value.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return allowEmpty ? value : value.trim();
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return segment || createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
