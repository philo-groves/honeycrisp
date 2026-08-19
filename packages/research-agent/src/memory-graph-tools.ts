import { nowIso } from "./ids.js";
import {
  MemoryGraphStore,
  type MemoryEvidenceRef,
  type MemoryNodeLinkInput,
  type MemoryNodeStatus,
  type MemoryNodeType,
  type MemoryScope,
  type SaveMemoryNodeInput,
} from "./memory-graph.js";
import { formatResearchProfileMemoryTypes } from "./memory-taxonomy.js";
import type {
  ResearchProfileAttributeDefinition,
  ResearchProfileMemory,
  ResearchProfileMemoryRequirement,
  ResearchProfileMemoryType,
} from "./research-profile.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionContext,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

const GET_PARAMETERS = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
const DEFAULT_MODEL_MEMORY_SEARCH_LIMIT = 8;
const MAX_MODEL_MEMORY_SEARCH_LIMIT = 25;
const MAX_SEARCH_CARD_SUMMARY_CHARACTERS = 700;
const MAX_SEARCH_CARD_TAGS = 6;
const MAX_SEARCH_CARD_EVIDENCE_REFS = 3;

interface MemoryToolSchemas {
  search: Record<string, unknown>;
  save: Record<string, unknown>;
  correct: Record<string, unknown>;
  link: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

function createMemoryToolSchemas(memory: ResearchProfileMemory): MemoryToolSchemas {
  const readableTypeIds = catalogIdsAndAliases(
    memory.types.filter((type) => type.lifecycle === "active"),
  );
  const creatableTypes = memory.types.filter(
    (type) => type.lifecycle === "active" && type.creatable,
  );
  const creatableTypeIds = catalogIdsAndAliases(creatableTypes);
  const statusIds = memory.statuses.map((status) => status.id);
  const statusDescription = memory.statuses
    .map((status) => `${status.id} (${status.name}): ${status.description}`)
    .join("\n");
  const evidence = createEvidenceSchema(memory);
  const nodeLink = createNodeLinkSchema(memory);
  const typeDescription = [
    "Use a stable type ID or one of its aliases. Aliases are persisted as their canonical type ID.",
    ...formatResearchProfileMemoryTypes(memory, { creatableOnly: true }),
  ].join("\n");
  const attributes = {
    type: "object",
    description: "Type-specific structured details defined by the active memory catalog.",
  };
  const sharedSaveProperties = {
    id: { type: "string" },
    type: { type: "string", enum: creatableTypeIds, description: typeDescription },
    title: { type: "string" },
    summary: { type: "string" },
    body: { type: "string" },
    status: { type: "string", enum: statusIds, description: statusDescription },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    assetIds: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    attributes,
    evidence: { type: "array", items: evidence },
    links: {
      type: "array",
      description: "Outgoing links created atomically with this memory write.",
      items: nodeLink,
    },
  };
  return {
    search: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", description: "Defaults to workspace. Use session for the current research session or subject for all knowledge associated with the current subject.", enum: ["session", "workspace", "subject"] },
        types: { type: "array", items: { type: "string", enum: readableTypeIds } },
        statuses: { type: "array", items: { type: "string", enum: statusIds } },
        assetIds: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number", minimum: 1, maximum: MAX_MODEL_MEMORY_SEARCH_LIMIT },
      },
    },
    save: {
      type: "object",
      required: ["type", "title"],
      properties: sharedSaveProperties,
      allOf: creatableTypes.flatMap((type) => createTypeConditions(type, evidence, nodeLink)),
    },
    correct: {
      type: "object",
      required: ["id", "expectedRevision"],
      properties: {
        ...sharedSaveProperties,
        id: { type: "string" },
        expectedRevision: { type: "number" },
        type: {
          type: "string",
          enum: creatableTypeIds,
          description: "Reclassify a miscategorized node to a creatable type from the active memory catalog while preserving its evidence and relationships.",
        },
      },
    },
    link: createLinkSchema(memory),
    evidence,
  };
}

function catalogIdsAndAliases(types: readonly ResearchProfileMemoryType[]): string[] {
  return [...new Set(types.flatMap((type) => [type.id, ...(type.aliases ?? [])]))];
}

function createEvidenceSchema(memory: ResearchProfileMemory): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    type: "object",
    required: ["kind", "summary"],
    properties: {
      kind: {
        type: "string",
        enum: memory.evidenceKinds.map((kind) => kind.id),
        description: memory.evidenceKinds.map((kind) => `${kind.id} (${kind.name}): ${kind.description}`).join("\n"),
      },
      pathBase: {
        type: "string",
        enum: memory.evidencePathBases.map((base) => base.id),
        description: memory.evidencePathBases
          .map((base) => `${base.id} (${base.name}, ${base.pathFormat ?? "relative"}): ${base.description}`)
          .join("\n"),
      },
      path: { type: "string" },
      locator: { type: "object" },
      summary: { type: "string" },
    },
  };
  const pathlessKinds = memory.evidenceKinds.filter((kind) => !kind.allowsPath);
  if (pathlessKinds.length > 0) {
    schema.allOf = pathlessKinds.map((kind) => ({
      if: { properties: { kind: { const: kind.id } }, required: ["kind"] },
      then: { not: { required: ["path"] } },
    }));
  }
  return schema;
}

function createLinkSchema(memory: ResearchProfileMemory): Record<string, unknown> {
  const relationCatalog = memory.relations?.length
    ? memory.relations.map((relation) => `${relation.id} (${relation.name}): ${relation.description}`).join("\n")
    : "This profile does not suggest any relation IDs.";
  return {
    type: "object",
    required: ["fromId", "toId", "relation"],
    properties: {
      fromId: { type: "string" },
      toId: { type: "string" },
      relation: {
        type: "string",
        description: `Relations are open strings. Prefer a profile relation when it fits:\n${relationCatalog}`,
      },
      note: { type: "string" },
    },
  };
}

function createNodeLinkSchema(memory: ResearchProfileMemory): Record<string, unknown> {
  const relationCatalog = memory.relations?.length
    ? memory.relations.map((relation) => `${relation.id} (${relation.name}): ${relation.description}`).join("\n")
    : "This profile does not suggest any relation IDs.";
  return {
    type: "object",
    required: ["nodeId", "relation"],
    properties: {
      nodeId: { type: "string", description: "Existing subject-visible memory node to link from the node being saved." },
      relation: {
        type: "string",
        description: `Relations are open strings. Prefer a profile relation when it fits:\n${relationCatalog}`,
      },
      note: { type: "string" },
    },
  };
}

function createTypeConditions(
  memoryType: ResearchProfileMemoryType,
  evidenceSchema: Record<string, unknown>,
  nodeLinkSchema: Record<string, unknown>,
): Record<string, unknown>[] {
  const baseThen: Record<string, unknown> = {
    properties: {
      status: {
        type: "string",
        enum: [...memoryType.allowedStatuses],
        default: memoryType.defaultStatus,
      },
      attributes: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(memoryType.attributes ?? {}).map(([name, definition]) => [
            name,
            attributeSchema(definition, false),
          ]),
        ),
      },
    },
  };
  if (memoryType.requiresExplicitStatus) baseThen.required = ["status"];
  const conditions: Record<string, unknown>[] = [{
    if: { properties: { type: { enum: [memoryType.id, ...(memoryType.aliases ?? [])] } }, required: ["type"] },
    then: baseThen,
  }];
  for (const requirement of memoryType.requirements ?? []) {
    conditions.push({
      if: requirementCondition(memoryType, requirement),
      then: requirementSchema(requirement, memoryType, evidenceSchema, nodeLinkSchema),
    });
  }
  return conditions;
}

function requirementCondition(
  memoryType: ResearchProfileMemoryType,
  requirement: ResearchProfileMemoryRequirement,
): Record<string, unknown> {
  const typeCondition = {
    properties: { type: { enum: [memoryType.id, ...(memoryType.aliases ?? [])] } },
    required: ["type"],
  };
  if (!requirement.statuses?.length) return typeCondition;
  const statusCondition = {
    properties: { status: { enum: [...requirement.statuses] } },
    required: ["status"],
  };
  if (!requirement.statuses.includes(memoryType.defaultStatus) || memoryType.requiresExplicitStatus) {
    return {
      properties: {
        ...(typeCondition.properties as Record<string, unknown>),
        ...(statusCondition.properties as Record<string, unknown>),
      },
      required: ["type", "status"],
    };
  }
  return {
    ...typeCondition,
    allOf: [{
      anyOf: [statusCondition, { not: { required: ["status"] } }],
    }],
  };
}

function requirementSchema(
  requirement: ResearchProfileMemoryRequirement,
  memoryType: ResearchProfileMemoryType,
  evidenceSchema: Record<string, unknown>,
  nodeLinkSchema: Record<string, unknown>,
): Record<string, unknown> {
  const required: string[] = [];
  const properties: Record<string, unknown> = {};
  if (requirement.requiredAttributes?.length) {
    required.push("attributes");
    properties.attributes = {
      type: "object",
      required: [...requirement.requiredAttributes],
      properties: Object.fromEntries(requirement.requiredAttributes.map((name) => [
        name,
        attributeSchema(memoryType.attributes![name]!, true),
      ])),
    };
  }
  if (requirement.requireAssetLinks) {
    required.push("assetIds");
    properties.assetIds = { type: "array", minItems: 1, items: { type: "string" } };
  }
  if (requirement.requireEvidence) {
    required.push("evidence");
    properties.evidence = { type: "array", minItems: 1, items: evidenceSchema };
  }
  if (requirement.requiredNeighborTypes?.length) {
    required.push("links");
    properties.links = {
      type: "array",
      minItems: 1,
      items: nodeLinkSchema,
      description: `Create atomic links to satisfy required neighbor types: ${requirement.requiredNeighborTypes.join(", ")}.`,
    };
  }
  return {
    ...(required.length ? { required } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

function attributeSchema(
  definition: ResearchProfileAttributeDefinition,
  required: boolean,
): Record<string, unknown> {
  return {
    type: definition.type,
    description: definition.description,
    ...(definition.pattern ? { pattern: definition.pattern } : {}),
    ...(definition.enum ? { enum: [...definition.enum] } : {}),
    ...(required && definition.type === "string" ? { minLength: 1 } : {}),
  };
}

export function createMemoryGraphTools(store: MemoryGraphStore): ResearchExecutableTool[] {
  const memory = store.getProfileMemory();
  const schemas = createMemoryToolSchemas(memory);
  const typeCatalog = formatResearchProfileMemoryTypes(memory, { creatableOnly: true }).join("\n");
  const seenMemoryRevisions = new Map<string, Map<string, number>>();
  return [
    createMemorySearchTool(store, schemas.search, seenMemoryRevisions),
    createMemoryGetTool(store, seenMemoryRevisions),
    tool("memory.save", "memory_save", `Create or additively refine concise reusable knowledge with links and evidence references. Saving automatically associates the memory with the current session, workspace, and subject; updating it from another session or workspace adds that association. Exact subject-visible type-and-title identities are refined in place. Use the active memory catalog below and do not store transcripts, routine narration, or bulk output.\n${typeCatalog}`, "write", schemas.save, (input, context) => {
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
        ...(Array.isArray(input.links) ? { links: input.links.map(parseMemoryLink) } : {}),
      }, context?.modelAuthor);
    }),
    tool("memory.correct", "memory_correct", "Exactly correct supplied fields or reclassify a memory node using its current revision. Reclassification preserves evidence and relationships and returns a new type-derived id. Retired and non-creatable types remain readable but cannot be reclassification targets.", "write", schemas.correct, (input, context) => {
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
      if ("links" in input) patch.links = requiredArray(input.links, "links").map(parseMemoryLink);
      return store.correct(requiredString(input.id, "id"), requiredInteger(input.expectedRevision, "expectedRevision"), patch, context?.modelAuthor);
    }),
    tool("memory.link", "memory_link", "Create or refine a directed relationship between durable memory nodes. Profile relation IDs are advisory; other concise relation IDs remain valid.", "write", schemas.link, (input, context) =>
      store.link(requiredString(input.fromId, "fromId"), requiredString(input.toId, "toId"), requiredString(input.relation, "relation"), string(input.note) ?? "", context?.modelAuthor)),
  ];
}

function createMemorySearchTool(
  store: MemoryGraphStore,
  schema: Record<string, unknown>,
  seenMemoryRevisions: Map<string, Map<string, number>>,
): ResearchExecutableTool {
  return tool("memory.search", "memory_search", "Search memories associated with the current workspace by default. Results are compact cards; use memory.get only for a memory whose complete body or evidence is needed. Unchanged memories already seen by this agent are returned as short references. Use session or subject scope when narrower or broader recall is needed. Use before repeating prior research.", "read", schema, (input, context) => {
    const query = string(input.query);
    const scope = string(input.scope) as MemoryScope | null;
    const types = strings(input.types) as MemoryNodeType[];
    const statuses = strings(input.statuses) as MemoryNodeStatus[];
    const assetIds = strings(input.assetIds);
    const tags = strings(input.tags);
    const requestedLimit = typeof input.limit === "number"
      ? Math.floor(input.limit)
      : DEFAULT_MODEL_MEMORY_SEARCH_LIMIT;
    const limit = Math.max(1, Math.min(MAX_MODEL_MEMORY_SEARCH_LIMIT, requestedLimit));
    const nodes = store.search({
      ...(query ? { query } : {}),
      ...(scope ? { scope } : {}),
      ...(types.length ? { types } : {}),
      ...(statuses.length ? { statuses } : {}),
      ...(assetIds.length ? { assetIds } : {}),
      ...(tags.length ? { tags } : {}),
      limit,
    });
    const edges = store.listEdgesForNodes(nodes.map((node) => node.id));
    const relationshipCounts = new Map<string, number>();
    for (const edge of edges) {
      relationshipCounts.set(edge.fromId, (relationshipCounts.get(edge.fromId) ?? 0) + 1);
      relationshipCounts.set(edge.toId, (relationshipCounts.get(edge.toId) ?? 0) + 1);
    }
    const seen = agentSeenMemoryRevisions(seenMemoryRevisions, context?.agentId);
    let unchangedCount = 0;
    const results = nodes.map((node) => {
      const unchanged = seen.get(node.id) === node.revision;
      seen.set(node.id, node.revision);
      if (unchanged) {
        unchangedCount += 1;
        return {
          detail: "reference",
          id: node.id,
          type: node.type,
          title: node.title,
          status: node.status,
          revision: node.revision,
        };
      }
      return {
        detail: "summary",
        id: node.id,
        type: node.type,
        title: node.title,
        summary: truncateText(node.summary, MAX_SEARCH_CARD_SUMMARY_CHARACTERS),
        status: node.status,
        confidence: node.confidence,
        ...(node.tags.length > 0 ? { tags: node.tags.slice(0, MAX_SEARCH_CARD_TAGS) } : {}),
        evidenceCount: node.evidence.length,
        ...(node.evidence.length > 0
          ? {
              evidenceRefs: node.evidence.slice(0, MAX_SEARCH_CARD_EVIDENCE_REFS).map((evidence) => ({
                id: evidence.id,
                kind: evidence.kind,
                ...(evidence.pathBase ? { pathBase: evidence.pathBase } : {}),
                ...(evidence.path ? { path: evidence.path } : {}),
              })),
            }
          : {}),
        relationshipCount: relationshipCounts.get(node.id) ?? 0,
        updatedAt: node.updatedAt,
        revision: node.revision,
      };
    });
    return {
      results,
      resultCount: results.length,
      unchangedReferenceCount: unchangedCount,
      detail: "summary",
      recall: "Use memory.get with a result ID to read its complete body, attributes, evidence, and relationships.",
    };
  });
}

function createMemoryGetTool(
  store: MemoryGraphStore,
  seenMemoryRevisions: Map<string, Map<string, number>>,
): ResearchExecutableTool {
  return tool("memory.get", "memory_get", "Read one durable memory node with its complete body, attributes, evidence references, and relationships.", "read", GET_PARAMETERS, (input, context) => {
    const node = store.get(requiredString(input.id, "id"));
    if (!node) return null;
    agentSeenMemoryRevisions(seenMemoryRevisions, context?.agentId).set(node.id, node.revision);
    const relationships = store.listEdgesForNodes([node.id]).map((edge) =>
      edge.fromId === node.id
        ? {
            direction: "outgoing",
            relation: edge.relation,
            memoryId: edge.toId,
            ...(edge.note ? { note: edge.note } : {}),
            createdAt: edge.createdAt,
            updatedAt: edge.updatedAt,
          }
        : {
            direction: "incoming",
            relation: edge.relation,
            memoryId: edge.fromId,
            ...(edge.note ? { note: edge.note } : {}),
            createdAt: edge.createdAt,
            updatedAt: edge.updatedAt,
          }
    );
    return { ...node, relationships };
  });
}

function tool(
  name: string,
  transportName: string,
  description: string,
  sideEffects: "read" | "write",
  parameters: Record<string, unknown>,
  run: (input: Record<string, unknown>, context?: ResearchToolExecutionContext) => unknown,
): ResearchExecutableTool {
  return {
    descriptor: { name, transportName, description, actionClasses: [sideEffects === "read" ? "recall" : "synthesize"], sideEffects, requiredPermissions: [sideEffects === "read" ? "memory:read" : "memory:write"], inputSchema: parameters },
    parameters: parameters as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action: ResearchToolAction, context?: ResearchToolExecutionContext): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try {
        const output = run(isRecord(action.input) ? action.input : {}, context);
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

function agentSeenMemoryRevisions(
  seenMemoryRevisions: Map<string, Map<string, number>>,
  agentId: string | undefined,
): Map<string, number> {
  const key = agentId?.trim() || "default";
  const existing = seenMemoryRevisions.get(key);
  if (existing) return existing;
  const created = new Map<string, number>();
  seenMemoryRevisions.set(key, created);
  return created;
}

function truncateText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function parseMemoryLink(value: unknown): MemoryNodeLinkInput {
  const input = requiredRecord(value, "memory link");
  return {
    nodeId: requiredString(input.nodeId, "memory link nodeId"),
    relation: requiredString(input.relation, "memory link relation"),
    ...(input.note === undefined
      ? {}
      : { note: requiredString(input.note, "memory link note", true) }),
  };
}
