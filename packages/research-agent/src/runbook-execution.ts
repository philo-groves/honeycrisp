import { randomUUID } from "node:crypto";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";
import { RunbookStore, type RunbookExecutionPlanCell } from "./runbooks.js";

export interface RunbookExecutionRequest {
  runbookId: string;
  cellId?: string;
  signal?: AbortSignal;
}

export interface RunbookExecutionUpdate {
  type: "runbook_execution";
  runbookId: string;
  runId: string;
  cellId: string | null;
  status: "running" | "succeeded" | "failed" | "blocked" | "skipped";
  durationMs?: number;
  error?: string;
}

export interface RunbookExecutorOptions {
  store: RunbookStore;
  shellTool: ResearchExecutableTool;
  signal?: AbortSignal;
  onUpdate?(update: RunbookExecutionUpdate): void | Promise<void>;
}

export function createRunbookExecutor(options: RunbookExecutorOptions): (
  request: RunbookExecutionRequest,
) => Promise<void> {
  const activeRunbooks = new Set<string>();
  return async (request) => {
    const runbookId = requiredText(request.runbookId, "runbookId");
    if (activeRunbooks.has(runbookId)) throw new Error(`Runbook is already executing: ${runbookId}`);
    const cells = options.store.executionPlan(runbookId, request.cellId);
    const runId = `runbook_run_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    activeRunbooks.add(runbookId);
    options.store.beginExecution(runbookId, runId, cells.map((cell) => cell.id));
    await options.onUpdate?.({ type: "runbook_execution", runbookId, runId, cellId: null, status: "running" });
    let finalStatus: "succeeded" | "failed" | "blocked" = "succeeded";
    let finalError: string | undefined;
    let completedCount = 0;
    try {
      for (const cell of cells) {
        const signal = request.signal ?? options.signal;
        throwIfAborted(signal);
        const cellStartedAt = new Date().toISOString();
        const cellStartedMs = Date.now();
        options.store.beginCellExecution(runbookId, runId, cell.id);
        await options.onUpdate?.({ type: "runbook_execution", runbookId, runId, cellId: cell.id, status: "running" });
        let result: ResearchToolExecutionResult;
        try {
          result = await executeCell(options.shellTool, runbookId, runId, cell, signal);
        } catch (error) {
          const message = errorMessage(error);
          const completedAt = new Date().toISOString();
          const durationMs = Math.max(0, Date.now() - cellStartedMs);
          options.store.completeCellExecution({
            id: runbookId,
            runId,
            cellId: cell.id,
            status: "failed",
            startedAt: cellStartedAt,
            completedAt,
            durationMs,
            error: message,
          });
          completedCount += 1;
          await options.onUpdate?.({
            type: "runbook_execution",
            runbookId,
            runId,
            cellId: cell.id,
            status: "failed",
            durationMs,
            error: message,
          });
          finalStatus = "failed";
          finalError = message;
          break;
        }
        const output = shellOutput(result.output);
        const status = result.status === "complete" ? "succeeded" : result.status === "error" ? "failed" : "blocked";
        const completedAt = new Date().toISOString();
        const durationMs = Math.max(0, Date.now() - cellStartedMs);
        options.store.completeCellExecution({
          id: runbookId,
          runId,
          cellId: cell.id,
          status,
          startedAt: cellStartedAt,
          completedAt,
          durationMs,
          ...(output.stdout ? { stdout: output.stdout } : {}),
          ...(output.stderr ? { stderr: output.stderr } : {}),
          ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
          ...(result.error?.message ? { error: result.error.message } : {}),
        });
        completedCount += 1;
        await options.onUpdate?.({
          type: "runbook_execution",
          runbookId,
          runId,
          cellId: cell.id,
          status,
          durationMs,
          ...(result.error?.message ? { error: result.error.message } : {}),
        });
        if (status !== "succeeded") {
          finalStatus = status;
          finalError = result.error?.message ?? result.summary;
          break;
        }
      }
    } catch (error) {
      finalStatus = "failed";
      finalError = errorMessage(error);
    } finally {
      const skipped = cells.slice(completedCount).map((cell) => cell.id);
      if (skipped.length > 0) {
        options.store.skipCellExecutions(runbookId, runId, skipped, finalError ?? "Skipped after an earlier cell did not succeed.");
        for (const cellId of skipped) {
          await options.onUpdate?.({
            type: "runbook_execution",
            runbookId,
            runId,
            cellId,
            status: "skipped",
            durationMs: 0,
            error: finalError ?? "Skipped after an earlier cell did not succeed.",
          });
        }
      }
      const completedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startedMs);
      options.store.completeExecution({
        id: runbookId,
        runId,
        status: finalStatus,
        startedAt,
        completedAt,
        durationMs,
        ...(finalError ? { error: finalError } : {}),
      });
      activeRunbooks.delete(runbookId);
      await options.onUpdate?.({
        type: "runbook_execution",
        runbookId,
        runId,
        cellId: null,
        status: finalStatus,
        durationMs,
        ...(finalError ? { error: finalError } : {}),
      });
    }
  };
}

export function createRunbookExecutionTool(
  executeRunbook: (request: RunbookExecutionRequest) => Promise<void>,
): ResearchExecutableTool {
  const parameters = {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Runbook ID to execute." },
      cellId: { type: "string", description: "Optional code cell ID. Omit to run every code cell in order." },
    },
  };
  return {
    descriptor: {
      name: "runbook.run",
      transportName: "runbook_run",
      description: "Execute one runbook code cell or the complete ordered runbook through the normal Honeycrisp shell safety boundary. Use this for proofing; Auto-Review denies proof commands issued directly through shell.run outside a runbook.",
      actionClasses: ["experiment"],
      sideEffects: "process",
      requiredPermissions: ["process:spawn"],
      inputSchema: parameters,
      metadata: { family: "runbook", format: "jupyter-nbformat-4", proofBoundary: true },
    },
    parameters,
    async execute(action, context) {
      const startedAt = new Date().toISOString();
      try {
        await executeRunbook({
          runbookId: requiredText(action.input.id, "id"),
          ...(typeof action.input.cellId === "string" && action.input.cellId.trim()
            ? { cellId: action.input.cellId.trim() }
            : {}),
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        return {
          action,
          status: "complete",
          startedAt,
          completedAt: new Date().toISOString(),
          summary: "Runbook execution completed.",
          followUpActions: [],
        };
      } catch (error) {
        return {
          action,
          status: "error",
          startedAt,
          completedAt: new Date().toISOString(),
          summary: "Runbook execution failed.",
          error: { message: errorMessage(error) },
          followUpActions: ["Inspect the recorded cell result and repair the runbook before retrying."],
        };
      }
    },
  };
}

async function executeCell(
  shellTool: ResearchExecutableTool,
  runbookId: string,
  runId: string,
  cell: RunbookExecutionPlanCell,
  signal?: AbortSignal,
): Promise<ResearchToolExecutionResult> {
  const action: ResearchToolAction = {
    id: `runbook_cell_${randomUUID()}`,
    actionClass: "experiment",
    toolName: "shell.run",
    input: cellInvocation(cell),
  };
  return shellTool.execute(action, {
    ...(signal ? { signal } : {}),
    runbookContext: { runbookId, runId, cellId: cell.id },
  });
}

function cellInvocation(cell: RunbookExecutionPlanCell): Record<string, unknown> {
  const language = cell.language?.trim().toLowerCase();
  if (!language) throw new Error(`Runbook code cell ${cell.id} requires an explicit language.`);
  if (["shell", "sh", "posix-shell"].includes(language)) return { command: cell.source };
  if (language === "bash") return { utility: "bash", args: ["-lc", cell.source] };
  if (language === "zsh") return { utility: "zsh", args: ["-lc", cell.source] };
  if (["python", "python3", "py"].includes(language)) return { utility: "python3", args: ["-c", cell.source] };
  if (["javascript", "js", "node"].includes(language)) return { utility: "node", args: ["-e", cell.source] };
  if (language === "ruby") return { utility: "ruby", args: ["-e", cell.source] };
  if (language === "perl") return { utility: "perl", args: ["-e", cell.source] };
  if (["powershell", "pwsh"].includes(language)) return { utility: "pwsh", args: ["-NoProfile", "-Command", cell.source] };
  throw new Error(`Runbook code cell ${cell.id} uses unsupported language ${cell.language}.`);
}

function shellOutput(value: unknown): { stdout?: string; stderr?: string; exitCode?: number | null } {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.stdout === "string" ? { stdout: value.stdout } : {}),
    ...(typeof value.stderr === "string" ? { stderr: value.stderr } : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null ? { exitCode: value.exitCode as number | null } : {}),
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Runbook execution was aborted.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
