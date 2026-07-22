import { nowIso } from "./ids.js";
import {
  RUNBOOK_STATUSES,
  RunbookStore,
  type RunbookCellInput,
  type RunbookStatus,
} from "./runbooks.js";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchArtifactRef, ResearchToolAction } from "./types.js";

const CELL_PARAMETERS = {
  type: "object",
  required: ["kind", "source"],
  properties: {
    kind: { type: "string", enum: ["markdown", "code"] },
    source: { type: "string", description: "Markdown prose or the exact executable code/command sequence." },
    language: { type: "string", description: "Language identifier such as sh, python, c, or text." },
    summary: { type: "string", description: "Concise purpose or interpretation of this cell." },
    stdout: { type: "string", description: "Bounded observed stdout when preserving a meaningful execution result." },
    stderr: { type: "string", description: "Bounded observed stderr when preserving a meaningful execution result." },
    exitCode: { type: "number", description: "Observed process exit code, if this cell records an execution." },
  },
};

const LIST_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string" },
    statuses: { type: "array", items: { type: "string", enum: [...RUNBOOK_STATUSES] } },
    limit: { type: "number" },
  },
};

const GET_PARAMETERS = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
};

const CREATE_PARAMETERS = {
  type: "object",
  required: ["title", "purpose"],
  properties: {
    title: { type: "string" },
    purpose: { type: "string", description: "The reusable research procedure, proof objective, or decision this runbook preserves." },
    status: { type: "string", enum: [...RUNBOOK_STATUSES] },
    cells: { type: "array", maxItems: 20, items: CELL_PARAMETERS },
  },
};

const APPEND_PARAMETERS = {
  type: "object",
  required: ["id", "expectedRevision", "cells"],
  properties: {
    id: { type: "string" },
    expectedRevision: { type: "number" },
    cells: { type: "array", minItems: 1, maxItems: 20, items: CELL_PARAMETERS },
    status: { type: "string", enum: [...RUNBOOK_STATUSES] },
  },
};

export function createRunbookTools(store: RunbookStore): ResearchExecutableTool[] {
  return [
    tool(
      "runbook.list",
      "runbook_list",
      "List workspace runbooks before creating or repeating a reusable procedure.",
      "read",
      LIST_PARAMETERS,
      (input) => ({
        output: store.list({
          ...(text(input.query) ? { query: text(input.query)! } : {}),
          ...(Array.isArray(input.statuses) ? { statuses: strings(input.statuses) as RunbookStatus[] } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        }),
      }),
    ),
    tool(
      "runbook.get",
      "runbook_get",
      "Read a bounded page of one workspace runbook, including recorded code cells and results.",
      "read",
      GET_PARAMETERS,
      (input) => ({
        output: store.get(requiredText(input.id, "id"), {
          ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        }),
      }),
    ),
    tool(
      "runbook.create",
      "runbook_create",
      "Create a revisioned Jupyter-format research runbook for a reusable procedure, proof sequence, or environment-specific workflow. Runbooks are artifacts, not memory nodes, and are not executed automatically.",
      "write",
      CREATE_PARAMETERS,
      (input) => {
        const created = store.create({
          title: requiredText(input.title, "title"),
          purpose: requiredText(input.purpose, "purpose"),
          ...(text(input.status) ? { status: text(input.status)! as RunbookStatus } : {}),
          ...(Array.isArray(input.cells) ? { cells: input.cells.map(parseCell) } : {}),
        });
        return { output: created.runbook, artifactRefs: [created.artifactRef] };
      },
    ),
    tool(
      "runbook.append",
      "runbook_append",
      "Append concise markdown or code cells and meaningful observed results to an existing runbook using its current revision. Use shell.run separately for execution; preserve only reusable steps and decisive outputs.",
      "write",
      APPEND_PARAMETERS,
      (input) => {
        const appended = store.append({
          id: requiredText(input.id, "id"),
          expectedRevision: requiredInteger(input.expectedRevision, "expectedRevision"),
          cells: requiredArray(input.cells, "cells").map(parseCell),
          ...(text(input.status) ? { status: text(input.status)! as RunbookStatus } : {}),
        });
        return { output: appended.runbook, artifactRefs: [appended.artifactRef] };
      },
    ),
  ];
}

function tool(
  name: string,
  transportName: string,
  description: string,
  sideEffects: "read" | "write",
  parameters: Record<string, unknown>,
  run: (input: Record<string, unknown>) => { output: unknown; artifactRefs?: ResearchArtifactRef[] },
): ResearchExecutableTool {
  return {
    descriptor: {
      name,
      transportName,
      description,
      actionClasses: [sideEffects === "read" ? "recall" : "synthesize"],
      sideEffects,
      requiredPermissions: [sideEffects === "read" ? "artifact:read" : "artifact:write"],
      inputSchema: parameters,
      metadata: { family: "runbook", format: "jupyter-nbformat-4" },
    },
    parameters: parameters as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action: ResearchToolAction): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try {
        const result = run(isRecord(action.input) ? action.input : {});
        return {
          action,
          status: "complete",
          startedAt,
          completedAt: nowIso(),
          summary: `${name} completed.`,
          output: result.output,
          ...(result.artifactRefs?.length ? { artifactRefs: result.artifactRefs } : {}),
          followUpActions: [],
        };
      } catch (error) {
        return {
          action,
          status: "error",
          startedAt,
          completedAt: nowIso(),
          summary: `${name} failed.`,
          error: { message: error instanceof Error ? error.message : String(error) },
          followUpActions: [],
        };
      }
    },
  };
}

function parseCell(value: unknown): RunbookCellInput {
  const input = requiredRecord(value, "cell");
  const kind = requiredText(input.kind, "cell kind");
  if (kind !== "markdown" && kind !== "code") throw new Error("cell kind must be markdown or code.");
  return {
    kind,
    source: requiredText(input.source, "cell source", true),
    ...(text(input.language) ? { language: text(input.language)! } : {}),
    ...(text(input.summary) ? { summary: text(input.summary)! } : {}),
    ...(typeof input.stdout === "string" ? { stdout: input.stdout } : {}),
    ...(typeof input.stderr === "string" ? { stderr: input.stderr } : {}),
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => text(item) ? [text(item)!] : []) : []; }
function requiredText(value: unknown, field: string, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} must be a ${allowEmpty ? "string" : "non-empty string"}.`); return allowEmpty ? value : value.trim(); }
function requiredInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`); return value; }
function requiredArray(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${field} must be an array.`); return value; }
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`${field} must be an object.`); return value; }
