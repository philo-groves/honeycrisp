import { nowIso } from "./ids.js";
import { FindingStore, type FindingEvidenceInput } from "./findings.js";
import type { FindingEvidenceKind, FindingStatus } from "./knowledge-types.js";
import type { ResearchExecutableTool, ResearchToolExecutionContext, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

const EVIDENCE_KINDS: FindingEvidenceKind[] = ["code", "artifact", "command", "url", "runbook_execution", "independent_verification", "report", "disclosure"];
const FINDING_STATUSES: FindingStatus[] = ["hypothesis", "observed", "reproduced", "verified", "report_ready", "disclosed", "stale", "rejected"];
const EVIDENCE_SCHEMA = {
  type: "object",
  required: ["kind", "summary"],
  properties: {
    kind: { type: "string", enum: EVIDENCE_KINDS },
    referenceId: { type: "string", description: "Durable evidence identity. For runbook_execution use the runId emitted by runbook.run; for report use the exact reportId; for disclosure use the exact disclosureReference." },
    contentHash: { type: "string" },
    summary: { type: "string" },
    independent: { type: "boolean" },
    metadata: { type: "object" },
  },
};

export interface FindingToolDefaults {
  sourceRevision?: string;
  environmentFingerprint?: string;
}

export function createFindingTools(store: FindingStore, defaults: FindingToolDefaults = {}): ResearchExecutableTool[] {
  return [
    findingTool("finding.list", "finding_list", "List canonical workspace findings with lifecycle, evidence gates, staleness, and append-only transitions. Use this before pursuing a possible vulnerability so completed or rejected territory is not repeated.", "read", { type: "object", properties: {} }, () => store.list()),
    findingTool("finding.create", "finding_create", "Create one canonical hypothesis-stage finding linked to existing durable memory. This does not claim observation or verification.", "write", {
      type: "object",
      required: ["memoryNodeId"],
      properties: {
        memoryNodeId: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, impact: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 }, sourceRevision: { type: "string" }, environmentFingerprint: { type: "string" },
        evidence: { type: "array", items: EVIDENCE_SCHEMA },
      },
    }, (input, context) => store.create({
      memoryNodeId: requiredString(input.memoryNodeId, "memoryNodeId"),
      ...(string(input.title) ? { title: string(input.title)! } : {}),
      ...(string(input.summary) ? { summary: string(input.summary)! } : {}),
      ...(string(input.impact) ? { impact: string(input.impact)! } : {}),
      ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
      ...(string(input.sourceRevision) ?? defaults.sourceRevision
        ? { sourceRevision: string(input.sourceRevision) ?? defaults.sourceRevision! }
        : {}),
      ...(string(input.environmentFingerprint) ?? defaults.environmentFingerprint
        ? { environmentFingerprint: string(input.environmentFingerprint) ?? defaults.environmentFingerprint! }
        : {}),
      ...(Array.isArray(input.evidence) ? { evidence: input.evidence.map(parseEvidence) } : {}),
    }, context?.modelAuthor, context?.agentId)),
    findingTool("finding.transition", "finding_transition", "Advance or correct a canonical finding through evidence-gated lifecycle transitions. Observation requires direct evidence; reproduction requires the runId of a successful Honeycrisp runbook execution; verification must be independent; report-ready and disclosed states require exact matching durable references.", "write", {
      type: "object",
      required: ["id", "expectedRevision", "toStatus", "reason"],
      properties: {
        id: { type: "string" }, expectedRevision: { type: "number" }, toStatus: { type: "string", enum: FINDING_STATUSES }, reason: { type: "string" },
        evidence: { type: "array", items: EVIDENCE_SCHEMA }, sourceRevision: { type: "string" }, environmentFingerprint: { type: "string" },
        reproductionRunbookId: { type: "string" }, reportId: { type: "string" }, disclosureReference: { type: "string" },
      },
    }, (input, context) => store.transition(requiredString(input.id, "id"), {
      expectedRevision: requiredInteger(input.expectedRevision, "expectedRevision"),
      toStatus: requiredStatus(input.toStatus),
      reason: requiredString(input.reason, "reason"),
      ...(Array.isArray(input.evidence) ? { evidence: input.evidence.map(parseEvidence) } : {}),
      ...(string(input.sourceRevision) ?? defaults.sourceRevision
        ? { sourceRevision: string(input.sourceRevision) ?? defaults.sourceRevision! }
        : {}),
      ...(string(input.environmentFingerprint) ?? defaults.environmentFingerprint
        ? { environmentFingerprint: string(input.environmentFingerprint) ?? defaults.environmentFingerprint! }
        : {}),
      ...(input.reproductionRunbookId !== undefined ? { reproductionRunbookId: string(input.reproductionRunbookId) } : {}),
      ...(input.reportId !== undefined ? { reportId: string(input.reportId) } : {}),
      ...(input.disclosureReference !== undefined ? { disclosureReference: string(input.disclosureReference) } : {}),
    }, context?.modelAuthor, context?.agentId)),
  ];
}

function findingTool(name: string, transportName: string, description: string, sideEffects: "read" | "write", parameters: Record<string, unknown>, run: (input: Record<string, unknown>, context?: ResearchToolExecutionContext) => unknown): ResearchExecutableTool {
  return {
    descriptor: { name, transportName, description, actionClasses: [sideEffects === "read" ? "recall" : "synthesize"], sideEffects, requiredPermissions: [sideEffects === "read" ? "memory:read" : "memory:write"], inputSchema: parameters },
    parameters: parameters as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action: ResearchToolAction, context?: ResearchToolExecutionContext): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try { return { action, status: "complete", startedAt, completedAt: nowIso(), summary: `${name} completed.`, output: run(isRecord(action.input) ? action.input : {}, context), followUpActions: [] }; }
      catch (error) { return { action, status: "error", startedAt, completedAt: nowIso(), summary: `${name} failed.`, error: { message: error instanceof Error ? error.message : String(error) }, followUpActions: [] }; }
    },
  };
}
function parseEvidence(value: unknown): FindingEvidenceInput { const input = requiredRecord(value, "evidence"); return { kind: requiredEvidenceKind(input.kind), summary: requiredString(input.summary, "evidence.summary"), ...(string(input.referenceId) ? { referenceId: string(input.referenceId) } : {}), ...(string(input.contentHash) ? { contentHash: string(input.contentHash) } : {}), ...(input.independent === true ? { independent: true } : {}), ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}) }; }
function requiredStatus(value: unknown): FindingStatus { if (typeof value === "string" && FINDING_STATUSES.includes(value as FindingStatus)) return value as FindingStatus; throw new Error("toStatus is invalid."); }
function requiredEvidenceKind(value: unknown): FindingEvidenceKind { if (typeof value === "string" && EVIDENCE_KINDS.includes(value as FindingEvidenceKind)) return value as FindingEvidenceKind; throw new Error("evidence.kind is invalid."); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`${field} must be an object.`); return value; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requiredString(value: unknown, field: string): string { const result = string(value); if (!result) throw new Error(`${field} must be a non-empty string.`); return result; }
function requiredInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`); return value; }
