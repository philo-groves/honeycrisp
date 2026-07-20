import { nowIso } from "./ids.js";
import {
  MEMORY_EVIDENCE_KINDS,
  MEMORY_EVIDENCE_PATH_BASES,
  MEMORY_NODE_STATUSES,
  MEMORY_NODE_TYPES,
  MemoryGraphStore,
  type MemoryEvidenceRef,
  type MemoryNodeStatus,
  type MemoryNodeType,
  type MemoryTier,
  type SaveMemoryNodeInput,
} from "./memory-graph.js";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string" },
    tiers: { type: "array", items: { type: "string", enum: ["session", "workspace", "subject"] } },
    types: { type: "array", items: { type: "string", enum: [...MEMORY_NODE_TYPES] } },
    statuses: { type: "array", items: { type: "string", enum: [...MEMORY_NODE_STATUSES] } },
    assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    limit: { type: "number" },
  },
};
const EVIDENCE_ITEM_PARAMETERS = {
  type: "object",
  required: ["kind", "summary"],
  properties: {
    kind: { type: "string", enum: [...MEMORY_EVIDENCE_KINDS] },
    pathBase: { type: "string", enum: [...MEMORY_EVIDENCE_PATH_BASES] },
    path: { type: "string" },
    locator: { type: "object" },
    summary: { type: "string" },
  },
};
const GET_PARAMETERS = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
const SAVE_PARAMETERS = {
  type: "object",
  required: ["type", "title"],
  properties: {
    id: { type: "string" }, tier: { type: "string", enum: ["session", "workspace", "subject"] }, type: { type: "string", enum: [...MEMORY_NODE_TYPES] }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string" },
    status: { type: "string", enum: [...MEMORY_NODE_STATUSES] }, confidence: { type: "number" }, assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    attributes: {
      type: "object",
      description: "Type-specific structured details. Chain memories require non-empty impact and reachability strings.",
      properties: {
        impact: { type: "string", description: "Security consequence if the chain succeeds." },
        reachability: { type: "string", description: "Conditions and path by which the chain can be reached." },
      },
    },
    evidence: { type: "array", items: EVIDENCE_ITEM_PARAMETERS },
  },
  allOf: [{
    if: { properties: { type: { const: "chain" } }, required: ["type"] },
    then: {
      required: ["attributes"],
      properties: {
        attributes: {
          type: "object",
          required: ["impact", "reachability"],
          properties: {
            impact: { type: "string", minLength: 1 },
            reachability: { type: "string", minLength: 1 },
          },
        },
      },
    },
  }],
};
const CORRECT_PARAMETERS = {
  type: "object",
  required: ["id", "expectedRevision"],
  properties: {
    id: { type: "string" }, expectedRevision: { type: "number" }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string" },
    status: { type: "string", enum: [...MEMORY_NODE_STATUSES] }, confidence: { type: "number" }, assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } }, attributes: { type: "object" }, evidence: { type: "array", items: EVIDENCE_ITEM_PARAMETERS },
  },
};
const LINK_PARAMETERS = {
  type: "object", required: ["fromId", "toId", "relation"],
  properties: { fromId: { type: "string" }, toId: { type: "string" }, relation: { type: "string" }, note: { type: "string" } },
};

export function createMemoryGraphTools(store: MemoryGraphStore): ResearchExecutableTool[] {
  return [
    tool("memory.search", "memory_search", "Search visible session, workspace, and subject knowledge. Use before repeating prior research.", "read", SEARCH_PARAMETERS, (input) => {
      const query = string(input.query);
      const tiers = strings(input.tiers) as MemoryTier[];
      const types = strings(input.types) as MemoryNodeType[];
      const statuses = strings(input.statuses) as MemoryNodeStatus[];
      const assetIds = strings(input.assetIds);
      const tags = strings(input.tags);
      return store.search({
        ...(query ? { query } : {}),
        ...(tiers.length ? { tiers } : {}),
        ...(types.length ? { types } : {}),
        ...(statuses.length ? { statuses } : {}),
        ...(assetIds.length ? { assetIds } : {}),
        ...(tags.length ? { tags } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      });
    }),
    tool("memory.get", "memory_get", "Read one durable memory node with evidence references.", "read", GET_PARAMETERS, (input) => store.get(requiredString(input.id, "id"))),
    tool("memory.save", "memory_save", "Create or additively refine concise reusable knowledge. Choose session for run-specific state, workspace for target-specific knowledge, or subject for knowledge useful across this owner's workspaces. Do not store transcripts, task narration, or bulk output.", "write", SAVE_PARAMETERS, (input) => {
      const id = string(input.id);
      const tier = string(input.tier);
      return store.save({
        ...(id ? { id } : {}),
        ...(tier ? { tier: tier as MemoryTier } : {}),
        type: requiredString(input.type, "type") as MemoryNodeType,
        title: requiredString(input.title, "title"),
        ...(input.summary !== undefined ? { summary: requiredString(input.summary, "summary", true) } : {}),
        ...(input.body !== undefined ? { body: requiredString(input.body, "body", true) } : {}),
        ...(string(input.status) ? { status: string(input.status) as MemoryNodeStatus } : {}),
        ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
        ...(Array.isArray(input.assetIds) ? { assetIds: strings(input.assetIds) } : {}),
        ...(Array.isArray(input.tags) ? { tags: strings(input.tags) } : {}),
        ...(record(input.attributes) ? { attributes: record(input.attributes)! } : {}),
        ...(Array.isArray(input.evidence) ? { evidence: input.evidence.map(parseEvidence) } : {}),
      });
    }),
    tool("memory.correct", "memory_correct", "Exactly correct supplied fields on a memory node using its current revision.", "write", CORRECT_PARAMETERS, (input) => {
      const patch: Partial<Omit<SaveMemoryNodeInput, "id" | "type">> = {};
      if ("title" in input) patch.title = requiredString(input.title, "title");
      if ("summary" in input) patch.summary = requiredString(input.summary, "summary", true);
      if ("body" in input) patch.body = requiredString(input.body, "body", true);
      if ("status" in input) patch.status = requiredString(input.status, "status") as MemoryNodeStatus;
      if ("confidence" in input) patch.confidence = requiredNumber(input.confidence, "confidence");
      if ("assetIds" in input) patch.assetIds = strings(input.assetIds);
      if ("tags" in input) patch.tags = strings(input.tags);
      if ("attributes" in input) patch.attributes = requiredRecord(input.attributes, "attributes");
      if ("evidence" in input) patch.evidence = requiredArray(input.evidence, "evidence").map(parseEvidence);
      return store.correct(requiredString(input.id, "id"), requiredInteger(input.expectedRevision, "expectedRevision"), patch);
    }),
    tool("memory.link", "memory_link", "Create or refine a directed relationship between durable memory nodes.", "write", LINK_PARAMETERS, (input) =>
      store.link(requiredString(input.fromId, "fromId"), requiredString(input.toId, "toId"), requiredString(input.relation, "relation"), string(input.note) ?? "")),
  ];
}

function tool(
  name: string,
  transportName: string,
  description: string,
  sideEffects: "read" | "write",
  parameters: Record<string, unknown>,
  run: (input: Record<string, unknown>) => unknown,
): ResearchExecutableTool {
  return {
    descriptor: { name, transportName, description, actionClasses: [sideEffects === "read" ? "recall" : "synthesize"], sideEffects, requiredPermissions: [sideEffects === "read" ? "memory:read" : "memory:write"], inputSchema: parameters },
    parameters: parameters as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action: ResearchToolAction): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try {
        const output = run(isRecord(action.input) ? action.input : {});
        return { action, status: "complete", startedAt, completedAt: nowIso(), summary: `${name} completed.`, output, followUpActions: [] };
      } catch (error) {
        return { action, status: "error", startedAt, completedAt: nowIso(), summary: `${name} failed.`, error: { message: error instanceof Error ? error.message : String(error) }, followUpActions: [] };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> | null { return isRecord(value) ? value : null; }
function string(value: unknown): string | null { return typeof value === "string" ? value.trim() : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []) : []; }
function requiredString(value: unknown, field: string, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${field} must be a ${allowEmpty ? "string" : "non-empty string"}.`); return value.trim(); }
function requiredInteger(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`); return value; }
function requiredNumber(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a number.`); return value; }
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw new Error(`${field} must be an object.`); return value; }
function requiredArray(value: unknown, field: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${field} must be an array.`); return value; }
function parseEvidence(value: unknown): Omit<MemoryEvidenceRef, "id" | "createdAt"> {
  const input = requiredRecord(value, "evidence item");
  const kind = requiredString(input.kind, "evidence kind") as MemoryEvidenceRef["kind"];
  const result: Omit<MemoryEvidenceRef, "id" | "createdAt"> = {
    kind,
    locator: input.locator === undefined ? {} : requiredRecord(input.locator, "evidence locator"),
    summary: input.summary === undefined ? "" : requiredString(input.summary, "evidence summary", true),
  };
  if (input.pathBase !== undefined) result.pathBase = requiredString(input.pathBase, "evidence pathBase") as NonNullable<MemoryEvidenceRef["pathBase"]>;
  if (input.path !== undefined) result.path = requiredString(input.path, "evidence path");
  return result;
}
