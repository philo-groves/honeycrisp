import { createId, nowIso } from "./ids.js";
import {
  MEMORY_EVIDENCE_KINDS,
  MEMORY_EVIDENCE_PATH_BASES,
  MEMORY_NODE_STATUSES,
  MEMORY_NODE_TYPES,
  MemoryGraphStore,
  type MemoryEvidenceRef,
  type MemoryNodeStatus,
  type MemoryNodeType,
  type MemoryScope,
  type SaveMemoryNodeInput,
} from "./memory-graph.js";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

const ROOT_CAUSE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string" },
    scope: { type: "string", description: "Defaults to workspace. Use session for the current research session or subject for all knowledge associated with the current subject.", enum: ["session", "workspace", "subject"] },
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
    id: { type: "string" }, type: { type: "string", enum: [...MEMORY_NODE_TYPES], description: "Use hypothesis for a specific testable but unproven proposition, bug only for confirmed historical precedent, primitive for a flaw proven during current research, and chain for end-to-end reachability and impact. Evidence and finding are not memory node types." }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string" },
    status: { type: "string", enum: [...MEMORY_NODE_STATUSES] }, confidence: { type: "number" }, assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    attributes: {
      type: "object",
      description: "Type-specific structured details. Chain memories require non-empty impact and reachability strings.",
      properties: {
        rootCause: { type: "string", description: "Concise underlying security mechanism." },
        rootCauseKey: { type: "string", pattern: ROOT_CAUSE_KEY_PATTERN.source, description: "Stable lowercase-hyphenated identity for the underlying root cause." },
        impact: { type: "string", description: "Security consequence if the chain succeeds." },
        reachability: { type: "string", description: "Conditions and path by which the chain can be reached." },
      },
    },
    evidence: { type: "array", items: EVIDENCE_ITEM_PARAMETERS },
  },
  allOf: [
    {
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
    },
    {
      if: { properties: { type: { const: "bug" } }, required: ["type"] },
      then: {
        required: ["status", "assetIds", "attributes", "evidence"],
        properties: {
          status: { const: "confirmed" },
          assetIds: { type: "array", minItems: 1, items: { type: "string" } },
          attributes: {
            type: "object",
            required: ["historicalPrecedent"],
            properties: { historicalPrecedent: { const: true } },
          },
          evidence: { type: "array", minItems: 1, items: EVIDENCE_ITEM_PARAMETERS },
        },
      },
    },
    {
      if: { properties: { type: { const: "hypothesis" } }, required: ["type"] },
      then: {
        properties: {
          status: { type: "string", enum: ["draft", "suspected", "rejected", "stale"] },
        },
      },
    },
  ],
};
const CORRECT_PARAMETERS = {
  type: "object",
  required: ["id", "expectedRevision"],
  properties: {
    id: { type: "string" }, expectedRevision: { type: "number" }, type: { type: "string", enum: [...MEMORY_NODE_TYPES], description: "Reclassify a miscategorized node while preserving its evidence and relationships." }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string" },
    status: { type: "string", enum: [...MEMORY_NODE_STATUSES] }, confidence: { type: "number" }, assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } }, attributes: { type: "object" }, evidence: { type: "array", items: EVIDENCE_ITEM_PARAMETERS },
  },
};
const LINK_PARAMETERS = {
  type: "object", required: ["fromId", "toId", "relation"],
  properties: { fromId: { type: "string" }, toId: { type: "string" }, relation: { type: "string" }, note: { type: "string" } },
};
const MEMORY_REQUEST_INTENTS = ["create", "revise", "relate", "reconsider"] as const;
const REQUEST_EVIDENCE_REF_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    eventId: { type: "string", minLength: 1 },
    toolCallId: { type: "string", minLength: 1 },
    artifactId: { type: "string", minLength: 1 },
  },
  anyOf: [
    { required: ["eventId"] },
    { required: ["toolCallId"] },
    { required: ["artifactId"] },
  ],
};
const REQUEST_CANDIDATE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: [...MEMORY_NODE_TYPES] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    claim: { type: "string", minLength: 1, maxLength: 4_000 },
    attributes: {
      type: "object",
      additionalProperties: false,
      description: "Structured metadata supporting the requested type. rootCauseKey must be lowercase-hyphenated.",
      properties: {
        rootCause: { type: "string", minLength: 1, maxLength: 4_000 },
        rootCauseKey: { type: "string", minLength: 1, maxLength: 200, pattern: ROOT_CAUSE_KEY_PATTERN.source },
        impact: { type: "string", minLength: 1, maxLength: 4_000 },
        reachability: { type: "string", minLength: 1, maxLength: 4_000 },
        historicalPrecedent: { type: "boolean" },
      },
    },
  },
};
const REQUEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "reason"],
  properties: {
    intent: {
      type: "string",
      enum: [...MEMORY_REQUEST_INTENTS],
      description: "Request creation, revision, relationship maintenance, or reconsideration. The curator independently validates every request.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 4_000,
      description: "Why durable memory appears missing, incomplete, incorrectly related, or no longer valid.",
    },
    memoryId: { type: "string", minLength: 1 },
    candidate: REQUEST_CANDIDATE_PARAMETERS,
    relatedMemoryIds: {
      type: "array",
      maxItems: 16,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    evidenceRefs: {
      type: "array",
      maxItems: 16,
      items: REQUEST_EVIDENCE_REF_PARAMETERS,
    },
  },
  allOf: [
    {
      if: { properties: { intent: { const: "create" } }, required: ["intent"] },
      then: {
        required: ["candidate"],
        properties: {
          candidate: {
            ...REQUEST_CANDIDATE_PARAMETERS,
            required: ["title", "claim"],
          },
        },
      },
    },
    {
      if: { properties: { intent: { enum: ["revise", "reconsider"] } }, required: ["intent"] },
      then: { required: ["memoryId"] },
    },
    {
      if: { properties: { intent: { const: "relate" } }, required: ["intent"] },
      then: {
        required: ["memoryId", "relatedMemoryIds"],
        properties: {
          relatedMemoryIds: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
  ],
};

export function createCuratedMemoryTools(store: MemoryGraphStore): ResearchExecutableTool[] {
  return [
    createMemorySearchTool(store),
    createMemoryGetTool(store),
    createMemoryRequestTool(),
  ];
}

export function createMemoryGraphTools(store: MemoryGraphStore): ResearchExecutableTool[] {
  return [
    createMemorySearchTool(store),
    createMemoryGetTool(store),
    tool("memory.save", "memory_save", "Create or additively refine concise reusable knowledge with asset links and evidence references. Saving automatically associates the memory with the current session, workspace, and subject; updating it from another session or workspace adds that association. Exact subject-visible type-and-title identities are refined in place. Use hypothesis for a testable unproven proposition, then reject it when disproven or reclassify it as a primitive or chain when proven. Use bug only for a confirmed historical flaw precedent with an affected asset and precedent evidence. Use primitive for a flaw established during current research, trajectories for reusable research sequences, and chains for reviewed end-to-end reachability and impact. Evidence and finding are not node types. Do not store transcripts, routine narration, or bulk output.", "write", SAVE_PARAMETERS, (input) => {
      const id = string(input.id);
      return store.save({
        ...(id ? { id } : {}),
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
    tool("memory.correct", "memory_correct", "Exactly correct supplied fields or reclassify a memory node using its current revision. Reclassification preserves evidence and relationships and returns a new type-derived id.", "write", CORRECT_PARAMETERS, (input) => {
      const patch: Partial<Omit<SaveMemoryNodeInput, "id">> = {};
      if ("type" in input) patch.type = requiredString(input.type, "type") as MemoryNodeType;
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

function createMemorySearchTool(store: MemoryGraphStore): ResearchExecutableTool {
  return tool("memory.search", "memory_search", "Search memories associated with the current workspace by default. Use session or subject scope when narrower or broader recall is needed. Use before repeating prior research.", "read", SEARCH_PARAMETERS, (input) => {
    const query = string(input.query);
    const scope = string(input.scope) as MemoryScope | null;
    const types = strings(input.types) as MemoryNodeType[];
    const statuses = strings(input.statuses) as MemoryNodeStatus[];
    const assetIds = strings(input.assetIds);
    const tags = strings(input.tags);
    return store.search({
      ...(query ? { query } : {}),
      ...(scope ? { scope } : {}),
      ...(types.length ? { types } : {}),
      ...(statuses.length ? { statuses } : {}),
      ...(assetIds.length ? { assetIds } : {}),
      ...(tags.length ? { tags } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    });
  });
}

function createMemoryGetTool(store: MemoryGraphStore): ResearchExecutableTool {
  return tool("memory.get", "memory_get", "Read one durable memory node with evidence references.", "read", GET_PARAMETERS, (input) => store.get(requiredString(input.id, "id")));
}

function createMemoryRequestTool(): ResearchExecutableTool {
  return {
    descriptor: {
      name: "memory.request",
      transportName: "memory_request",
      description: "Request that the background memory curator create, revise, reconsider, or relate durable memory. The request is advisory and queued for independent validation and duplicate checking; it never mutates the memory graph directly.",
      actionClasses: ["synthesize"],
      sideEffects: "none",
      requiredPermissions: [],
      inputSchema: REQUEST_PARAMETERS,
    },
    parameters: REQUEST_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action: ResearchToolAction): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try {
        const input = isRecord(action.input) ? action.input : {};
        const intent = validateMemoryRequestInput(input);
        return {
          action,
          status: "complete",
          startedAt,
          completedAt: nowIso(),
          summary: "Memory request queued for curator review.",
          output: {
            requestId: createId("memory_request"),
            status: "queued",
            intent,
          },
          followUpActions: [],
        };
      } catch (error) {
        return {
          action,
          status: "error",
          startedAt,
          completedAt: nowIso(),
          summary: "Memory request could not be queued.",
          error: { message: error instanceof Error ? error.message : String(error) },
          followUpActions: [],
        };
      }
    },
  };
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
function validateMemoryRequestInput(input: Record<string, unknown>): (typeof MEMORY_REQUEST_INTENTS)[number] {
  assertOnlyKeys(input, ["intent", "reason", "memoryId", "candidate", "relatedMemoryIds", "evidenceRefs"], "memory request");
  const intent = requiredString(input.intent, "intent") as (typeof MEMORY_REQUEST_INTENTS)[number];
  if (!MEMORY_REQUEST_INTENTS.includes(intent)) throw new Error(`Unsupported memory request intent: ${intent}`);
  requiredBoundedString(input.reason, "reason", 4_000);

  const memoryId = input.memoryId === undefined
    ? undefined
    : requiredBoundedString(input.memoryId, "memoryId", 500);
  if ((intent === "revise" || intent === "reconsider" || intent === "relate") && !memoryId) {
    throw new Error(`memoryId is required for ${intent} requests.`);
  }

  if (input.candidate !== undefined) {
    const candidate = requiredRecord(input.candidate, "candidate");
    assertOnlyKeys(candidate, ["type", "title", "claim", "attributes"], "candidate");
    if (candidate.type !== undefined) {
      const type = requiredString(candidate.type, "candidate.type") as MemoryNodeType;
      if (!MEMORY_NODE_TYPES.includes(type)) throw new Error(`Unsupported candidate memory type: ${type}`);
    }
    if (candidate.title !== undefined) requiredBoundedString(candidate.title, "candidate.title", 200);
    if (candidate.claim !== undefined) requiredBoundedString(candidate.claim, "candidate.claim", 4_000);
    if (candidate.attributes !== undefined) validateMemoryRequestAttributes(candidate.attributes);
    if (intent === "create") {
      requiredBoundedString(candidate.title, "candidate.title", 200);
      requiredBoundedString(candidate.claim, "candidate.claim", 4_000);
    }
  } else if (intent === "create") {
    throw new Error("candidate is required for create requests.");
  }

  const relatedMemoryIds = input.relatedMemoryIds === undefined
    ? []
    : strictStringArray(input.relatedMemoryIds, "relatedMemoryIds", 16, 500);
  if (intent === "relate" && relatedMemoryIds.length === 0) {
    throw new Error("relatedMemoryIds must contain at least one id for relate requests.");
  }

  if (input.evidenceRefs !== undefined) {
    const evidenceRefs = requiredArray(input.evidenceRefs, "evidenceRefs");
    if (evidenceRefs.length > 16) throw new Error("evidenceRefs must contain at most 16 items.");
    for (const [index, value] of evidenceRefs.entries()) {
      const evidence = requiredRecord(value, `evidenceRefs[${index}]`);
      assertOnlyKeys(evidence, ["eventId", "toolCallId", "artifactId"], `evidenceRefs[${index}]`);
      const ids = ["eventId", "toolCallId", "artifactId"].flatMap((field) =>
        evidence[field] === undefined
          ? []
          : [requiredBoundedString(evidence[field], `evidenceRefs[${index}].${field}`, 500)]
      );
      if (ids.length === 0) throw new Error(`evidenceRefs[${index}] must identify an event, tool call, or artifact.`);
    }
  }
  return intent;
}
function validateMemoryRequestAttributes(value: unknown): void {
  const attributes = requiredRecord(value, "candidate.attributes");
  assertOnlyKeys(attributes, ["rootCause", "rootCauseKey", "impact", "reachability", "historicalPrecedent"], "candidate.attributes");
  for (const field of ["rootCause", "impact", "reachability"] as const) {
    if (attributes[field] !== undefined) requiredBoundedString(attributes[field], `candidate.attributes.${field}`, 4_000);
  }
  if (attributes.rootCauseKey !== undefined) {
    const rootCauseKey = requiredBoundedString(attributes.rootCauseKey, "candidate.attributes.rootCauseKey", 200);
    if (!ROOT_CAUSE_KEY_PATTERN.test(rootCauseKey)) {
      throw new Error("candidate.attributes.rootCauseKey must be lowercase-hyphenated.");
    }
  }
  if (attributes.historicalPrecedent !== undefined && typeof attributes.historicalPrecedent !== "boolean") {
    throw new Error("candidate.attributes.historicalPrecedent must be a boolean.");
  }
}
function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${field} contains unsupported field: ${unexpected}`);
}
function requiredBoundedString(value: unknown, field: string, maxLength: number): string {
  const result = requiredString(value, field);
  if (result.length > maxLength) throw new Error(`${field} must contain at most ${maxLength} characters.`);
  return result;
}
function strictStringArray(value: unknown, field: string, maxItems: number, maxItemLength: number): string[] {
  const items = requiredArray(value, field);
  if (items.length > maxItems) throw new Error(`${field} must contain at most ${maxItems} items.`);
  const normalized = items.map((item, index) => requiredBoundedString(item, `${field}[${index}]`, maxItemLength));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicate values.`);
  return normalized;
}
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
