import { nowIso } from "./ids.js";
import type { MemoryGraphStore, MemoryNode } from "./memory-graph.js";
import { REPORT_STATUSES, ReportStore, type ReportStatus } from "./reports.js";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchArtifactRef, ResearchToolAction } from "./types.js";

const LIST_PARAMETERS = { type: "object", properties: { query: { type: "string" }, statuses: { type: "array", items: { type: "string", enum: [...REPORT_STATUSES] } }, limit: { type: "number" } } };
const GET_PARAMETERS = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
const CREATE_PARAMETERS = { type: "object", required: ["title", "summary", "content"], properties: {
  title: { type: "string" }, summary: { type: "string", description: "A concise catalog description." },
  content: { type: "string", description: "The complete Markdown report." }, status: { type: "string", enum: [...REPORT_STATUSES] },
  sourceChainId: { type: "string", description: "The confirmed, reportable chain this report documents." },
} };
const REVISE_PARAMETERS = { type: "object", required: ["id", "expectedRevision", "content"], properties: {
  id: { type: "string" }, expectedRevision: { type: "number" }, content: { type: "string", description: "The complete replacement Markdown report." },
  summary: { type: "string" }, status: { type: "string", enum: [...REPORT_STATUSES] },
} };

export interface ReportToolPolicy {
  requireConfirmedChain?: boolean;
  memoryGraph?: Pick<MemoryGraphStore, "get" | "getContext">;
}

export function createReportTools(store: ReportStore, policy: ReportToolPolicy = {}): ResearchExecutableTool[] {
  const createParameters = policy.requireConfirmedChain
    ? { ...CREATE_PARAMETERS, required: [...CREATE_PARAMETERS.required, "sourceChainId"] }
    : CREATE_PARAMETERS;
  return [
    tool("report.list", "report_list", "List workspace reports before creating or revising a shareable result.", "read", LIST_PARAMETERS, (input) => ({ output: store.list({
      ...(text(input.query) ? { query: text(input.query)! } : {}),
      ...(Array.isArray(input.statuses) ? { statuses: strings(input.statuses) as ReportStatus[] } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    }) })),
    tool("report.get", "report_get", "Read the full Markdown content of one workspace report.", "read", GET_PARAMETERS, (input) => ({ output: store.get(requiredText(input.id, "id")) })),
    tool("report.create", "report_create", policy.requireConfirmedChain
      ? "Create a complete, revisioned Markdown report for a confirmed, reportable vulnerability chain. Observations, hypotheses, and primitives are not report-ready."
      : "Create a complete, revisioned Markdown report when a result is ready to share. Reports are artifacts, not memories.", "write", createParameters, (input) => {
      if (policy.requireConfirmedChain) requireReportableSecurityChain(input.sourceChainId, policy.memoryGraph);
      const created = store.create({ title: requiredText(input.title, "title"), summary: requiredText(input.summary, "summary"), content: requiredText(input.content, "content"), ...(text(input.status) ? { status: text(input.status)! as ReportStatus } : {}) });
      return { output: created.report, artifactRefs: [created.artifactRef] };
    }),
    tool("report.revise", "report_revise", "Replace a report with a complete revised Markdown document, or mark it stale, using its current revision.", "write", REVISE_PARAMETERS, (input) => {
      const revised = store.revise({ id: requiredText(input.id, "id"), expectedRevision: requiredInteger(input.expectedRevision, "expectedRevision"), content: requiredText(input.content, "content"), ...(text(input.summary) ? { summary: text(input.summary)! } : {}), ...(text(input.status) ? { status: text(input.status)! as ReportStatus } : {}) });
      return { output: revised.report, artifactRefs: [revised.artifactRef] };
    }),
  ];
}

function requireReportableSecurityChain(
  value: unknown,
  memoryGraph: ReportToolPolicy["memoryGraph"],
): MemoryNode {
  if (!memoryGraph) throw new Error("Security report eligibility requires the active memory graph.");
  const sourceChainId = requiredText(value, "sourceChainId");
  const chain = memoryGraph.get(sourceChainId);
  const workspaceId = memoryGraph.getContext().workspaceId;
  if (!chain || !chain.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error(`Report source chain is not recorded in this workspace: ${sourceChainId}.`);
  }
  if (chain.type !== "chain") {
    throw new Error("Security reports require a primitive upgraded to a chain; observations, hypotheses, and primitives are not report-ready.");
  }
  if (chain.status !== "confirmed") {
    throw new Error("Security reports require a confirmed chain that meets proof-of-vulnerability and independent-review criteria.");
  }
  if (!text(chain.attributes.impact) || !text(chain.attributes.reachability) || chain.evidence.length === 0) {
    throw new Error("Security reports require a confirmed chain with impact, reachability, and proof evidence.");
  }
  return chain;
}

function tool(name: string, transportName: string, description: string, sideEffects: "read" | "write", parameters: Record<string, unknown>, run: (input: Record<string, unknown>) => { output: unknown; artifactRefs?: ResearchArtifactRef[] }): ResearchExecutableTool {
  return { descriptor: { name, transportName, description, actionClasses: [sideEffects === "read" ? "recall" : "synthesize"], sideEffects, requiredPermissions: [sideEffects === "read" ? "artifact:read" : "artifact:write"], inputSchema: parameters, metadata: { family: "report", format: "markdown" } }, parameters: parameters as NonNullable<ResearchExecutableTool["parameters"]>, async execute(action: ResearchToolAction): Promise<ResearchToolExecutionResult> {
    const startedAt = nowIso();
    try { const result = run(isRecord(action.input) ? action.input : {}); return { action, status: "complete", startedAt, completedAt: nowIso(), summary: `${name} completed.`, output: result.output, ...(result.artifactRefs?.length ? { artifactRefs: result.artifactRefs } : {}), followUpActions: [] }; }
    catch (error) { return { action, status: "error", startedAt, completedAt: nowIso(), summary: `${name} failed.`, error: { message: error instanceof Error ? error.message : String(error) }, followUpActions: [] }; }
  } };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => text(item) ? [text(item)!] : []) : []; }
function requiredText(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`); return value.trim(); }
function requiredInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`); return value; }
