import type {
  MemoryEdge,
  MemoryEvidenceRef,
  MemoryGraphStore,
  MemoryNode,
} from "./memory-graph.js";
import type {
  ResearchSelectedSkill,
  ResearchToolDescriptor,
  ResearchWorkspaceAuthorizationContext,
  ResearchWorkspaceContext,
  ResearchWorkspaceRepositoryContext,
} from "./types.js";

const DEFAULT_MEMORY_NODE_LIMIT = 12;
const DEFAULT_MEMORY_CHARACTER_BUDGET = 24_000;
const MAX_BODY_CHARACTERS = 3_000;
const MAX_RELATIONSHIPS_PER_NODE = 8;
const MAX_EVIDENCE_REFS_PER_NODE = 8;

const QUERY_STOP_WORDS = new Set([
  "about",
  "against",
  "also",
  "and",
  "been",
  "continue",
  "from",
  "have",
  "into",
  "module",
  "next",
  "research",
  "that",
  "the",
  "this",
  "through",
  "using",
  "with",
]);

export interface ResearchModelWorkspaceContext {
  schemaVersion: 1;
  authorization?: ResearchWorkspaceAuthorizationContext;
  memory?: {
    sessionId?: string;
    workspace: { id: string; name: string };
    subject?: { id: string; name: string };
  };
  knownRepositories: readonly ResearchWorkspaceRepositoryContext[];
  materializedSourcePaths: readonly string[];
  projectNotes: readonly string[];
}

export interface ResearchModelMemoryRelationship {
  direction: "incoming" | "outgoing";
  relation: string;
  memoryId: string;
  note?: string;
}

export interface ResearchModelMemoryContextNode {
  id: string;
  scope: {
    sessions: readonly string[];
    workspaces: readonly { id: string; name: string }[];
    subject: { id: string; name: string };
  };
  type: MemoryNode["type"];
  title: string;
  summary: string;
  body?: string;
  status: MemoryNode["status"];
  confidence: number;
  assetIds: readonly string[];
  tags: readonly string[];
  attributes?: Record<string, unknown>;
  evidence: readonly MemoryEvidenceRef[];
  relationships: readonly ResearchModelMemoryRelationship[];
  updatedAt: string;
  revision: number;
}

export interface ResearchAvailableToolContext {
  name: string;
  description: string;
  actionClasses: ResearchToolDescriptor["actionClasses"];
  sideEffects: ResearchToolDescriptor["sideEffects"];
}

export interface ResearchModelSkillContext {
  id: string;
  description: string;
  instructions: string;
  runbook?: string;
}

export function createModelWorkspaceContext(
  context: ResearchWorkspaceContext,
): ResearchModelWorkspaceContext {
  const memory = context.memoryContext;
  return {
    schemaVersion: 1,
    ...(context.authorization ? { authorization: context.authorization } : {}),
    ...(memory
      ? {
          memory: {
            ...(memory.sessionId ? { sessionId: memory.sessionId } : {}),
            workspace: {
              id: memory.workspaceId,
              name: memory.workspaceName,
            },
            ...(memory.subjectId && memory.subjectName
              ? {
                  subject: {
                    id: memory.subjectId,
                    name: memory.subjectName,
                  },
                }
              : {}),
          },
        }
      : {}),
    knownRepositories: context.knownRepositories,
    materializedSourcePaths: context.materializedSourcePaths,
    projectNotes: context.projectNotes,
  };
}

export function createAvailableToolContext(
  tools: readonly ResearchToolDescriptor[],
): ResearchAvailableToolContext[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    actionClasses: tool.actionClasses,
    sideEffects: tool.sideEffects,
  }));
}

export function createModelSkillContext(
  skills: readonly ResearchSelectedSkill[],
): ResearchModelSkillContext[] {
  return skills.map((skill) => ({
    id: skill.id,
    description: skill.description,
    instructions: skill.instructions,
    ...(skill.runbook ? { runbook: skill.runbook } : {}),
  }));
}

export function compileMemoryModelContext(
  store: MemoryGraphStore,
  prompt: string,
  options: {
    maxNodes?: number;
    maxCharacters?: number;
  } = {},
): ResearchModelMemoryContextNode[] {
  const nodes = new Map<string, MemoryNode>();
  const current = store.getContext();
  for (const node of store.search({ scope: "workspace", limit: 100 })) nodes.set(node.id, node);
  for (const node of store.search({ scope: "session", limit: 100 })) nodes.set(node.id, node);
  for (const term of queryTerms(prompt).slice(0, 12)) {
    for (const node of store.search({ query: term, scope: "subject", limit: 20 })) {
      nodes.set(node.id, node);
    }
  }
  return selectMemoryModelContext({
    nodes: [...nodes.values()],
    edges: store.listEdges(),
    prompt,
    ...(current.sessionId ? { sessionId: current.sessionId } : {}),
    workspaceId: current.workspaceId,
    ...options,
  });
}

export function selectMemoryModelContext(input: {
  nodes: readonly MemoryNode[];
  edges: readonly MemoryEdge[];
  prompt: string;
  maxNodes?: number;
  maxCharacters?: number;
  sessionId?: string;
  workspaceId?: string;
}): ResearchModelMemoryContextNode[] {
  const maxNodes = clampInteger(input.maxNodes, DEFAULT_MEMORY_NODE_LIMIT, 1, 100);
  const maxCharacters = clampInteger(
    input.maxCharacters,
    DEFAULT_MEMORY_CHARACTER_BUDGET,
    1_000,
    200_000,
  );
  const terms = queryTerms(input.prompt);
  const relevance = new Map(
    input.nodes.map((node) => [node.id, relevanceScore(node, terms)]),
  );
  const seedIds = new Set(
    input.nodes
      .filter((node) => (input.sessionId ? node.sessionIds.includes(input.sessionId) : false) || (relevance.get(node.id) ?? 0) > 0)
      .map((node) => node.id),
  );
  const linkedIds = new Set(
    input.edges.flatMap((edge) => {
      if (seedIds.has(edge.fromId)) return [edge.toId];
      if (seedIds.has(edge.toId)) return [edge.fromId];
      return [];
    }),
  );
  const ranked = input.nodes
    .filter((node) =>
      (input.workspaceId ? node.workspaces.some((workspace) => workspace.id === input.workspaceId) : true) ||
      (relevance.get(node.id) ?? 0) > 0 ||
      linkedIds.has(node.id),
    )
    .sort((left, right) => {
      const scoreDifference =
        rankScore(right, relevance.get(right.id) ?? 0, linkedIds.has(right.id), input.sessionId, input.workspaceId) -
        rankScore(left, relevance.get(left.id) ?? 0, linkedIds.has(left.id), input.sessionId, input.workspaceId);
      return (
        scoreDifference ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
      );
    });

  const selected: ResearchModelMemoryContextNode[] = [];
  let usedCharacters = 2;
  for (const node of ranked) {
    if (selected.length >= maxNodes) break;
    const projected = projectMemoryNode(node, input.edges, false);
    const projectedSize = JSON.stringify(projected).length + 1;
    if (usedCharacters + projectedSize <= maxCharacters) {
      selected.push(projected);
      usedCharacters += projectedSize;
      continue;
    }

    const compact = projectMemoryNode(node, input.edges, true);
    const compactSize = JSON.stringify(compact).length + 1;
    if (usedCharacters + compactSize <= maxCharacters) {
      selected.push(compact);
      usedCharacters += compactSize;
    }
  }
  return selected;
}

function projectMemoryNode(
  node: MemoryNode,
  edges: readonly MemoryEdge[],
  compact: boolean,
): ResearchModelMemoryContextNode {
  const attributes = Object.keys(node.attributes).length > 0 ? node.attributes : undefined;
  return {
    id: node.id,
    scope: {
      sessions: node.sessionIds,
      workspaces: node.workspaces,
      subject: { id: node.subjectId, name: node.subjectName },
    },
    type: node.type,
    title: node.title,
    summary: node.summary,
    ...(!compact && node.body
      ? { body: truncate(node.body, MAX_BODY_CHARACTERS) }
      : {}),
    status: node.status,
    confidence: node.confidence,
    assetIds: node.assetIds,
    tags: node.tags,
    ...(!compact && attributes ? { attributes } : {}),
    evidence: node.evidence.slice(0, compact ? 4 : MAX_EVIDENCE_REFS_PER_NODE),
    relationships: relationshipsForNode(node.id, edges).slice(
      0,
      compact ? 4 : MAX_RELATIONSHIPS_PER_NODE,
    ),
    updatedAt: node.updatedAt,
    revision: node.revision,
  };
}

function relationshipsForNode(
  nodeId: string,
  edges: readonly MemoryEdge[],
): ResearchModelMemoryRelationship[] {
  const relationships: ResearchModelMemoryRelationship[] = [];
  for (const edge of edges) {
    if (edge.fromId === nodeId) {
      relationships.push({
        direction: "outgoing",
        relation: edge.relation,
        memoryId: edge.toId,
        ...(edge.note ? { note: edge.note } : {}),
      });
    }
    if (edge.toId === nodeId) {
      relationships.push({
        direction: "incoming",
        relation: edge.relation,
        memoryId: edge.fromId,
        ...(edge.note ? { note: edge.note } : {}),
      });
    }
  }
  return relationships;
}

function relevanceScore(node: MemoryNode, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const title = node.title.toLowerCase();
  const summary = node.summary.toLowerCase();
  const body = node.body.toLowerCase();
  const metadata = [
    ...node.tags,
    ...node.assetIds,
    ...node.evidence.flatMap((evidence) => [
      evidence.summary,
      evidence.path ?? "",
      JSON.stringify(evidence.locator),
    ]),
  ].join(" ").toLowerCase();
  return terms.reduce((score, term) =>
    score +
    (title.includes(term) ? 8 : 0) +
    (summary.includes(term) ? 5 : 0) +
    (body.includes(term) ? 2 : 0) +
    (metadata.includes(term) ? 3 : 0), 0);
}

function rankScore(
  node: MemoryNode,
  relevance: number,
  linked: boolean,
  sessionId: string | undefined,
  workspaceId: string | undefined,
): number {
  const contextWeight = sessionId && node.sessionIds.includes(sessionId)
    ? 1_000
    : workspaceId && node.workspaces.some((workspace) => workspace.id === workspaceId)
      ? 80
      : 0;
  const statusWeight = node.status === "confirmed" ? 20 : node.status === "rejected" ? -20 : 0;
  const typeWeight = node.type === "hypothesis" ? 8 : 0;
  return contextWeight + relevance * 100 + (linked ? 40 : 0) + statusWeight + typeWeight;
}

function queryTerms(prompt: string): string[] {
  return [...new Set(
    (prompt.toLowerCase().match(/[a-z0-9_.:/-]{3,}/g) ?? [])
      .filter((term) => !QUERY_STOP_WORDS.has(term)),
  )].slice(0, 40);
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}
