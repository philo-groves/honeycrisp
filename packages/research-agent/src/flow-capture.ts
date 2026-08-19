import type { RunResearchAgentResult } from "./bootstrap.js";
import { nowIso } from "./ids.js";
import {
  getResearchStorageManifestPath,
  loadResearchStorageManifest,
  type ResearchStorageArtifactManifestEntry,
} from "./storage.js";
import type {
  ResearchAvailableToolContext,
  ResearchModelMemoryContextNode,
  ResearchModelSkillContext,
  ResearchModelWorkspaceContext,
} from "./model-context.js";
import type {
  ResearchCollaborationToolDescriptor,
  ResearchEvent,
  ResearchNextPromptSuggestion,
  ResearchStorageLayout,
  ResearchTrace,
  ResearchWorkspaceContext,
} from "./types.js";

export interface ResearchFlowEventCapture {
  id: string;
  kind: ResearchEvent["kind"] | "agent.control";
  timestamp: string;
  agentId?: string;
  agentPath?: string;
  parentAgentId?: string;
  summary: string;
  payload: unknown;
}

export interface ResearchAgentFlowCapture {
  schemaVersion: 5;
  capturedAt: string;
  request: { prompt: string };
  researchProfile?: {
    schemaVersion: number;
    id: string;
    version: string;
    hash: string;
    source: RunResearchAgentResult["resolvedResearchProfile"]["source"];
    path?: string;
    workflowId: string;
    snapshot: RunResearchAgentResult["resolvedResearchProfile"]["profile"];
  };
  agent: {
    id: string;
    status: "complete" | "error";
    executorName: string;
    startedAt: string;
    completedAt: string;
    outputText: string;
    finalDisposition: RunResearchAgentResult["finalDisposition"];
    goal?: RunResearchAgentResult["agentRun"]["output"]["goal"];
    nextPromptSuggestions?: readonly ResearchNextPromptSuggestion[];
    researchTrace?: ResearchTrace;
    raw?: unknown;
  };
  context: {
    workspaceContext: ResearchModelWorkspaceContext;
    memory: readonly ResearchModelMemoryContextNode[];
    selectedSkills: readonly ResearchModelSkillContext[];
    availableTools: readonly ResearchAvailableToolContext[];
    collaborationTools: readonly ResearchCollaborationToolDescriptor[];
  };
  workspaceContext: ResearchWorkspaceContext;
  storage: ResearchStorageLayout;
  storageManifest: {
    path: string;
    artifactCount: number;
    artifacts: readonly Pick<
      ResearchStorageArtifactManifestEntry,
      | "id"
      | "kind"
      | "purpose"
      | "relativePath"
      | "sizeBytes"
      | "contentHash"
      | "sourceEventIds"
    >[];
  };
  eventTimeline: readonly ResearchFlowEventCapture[];
}

export function createResearchAgentFlowCapture(
  result: RunResearchAgentResult,
  options: { capturedAt?: string } = {},
): ResearchAgentFlowCapture {
  const capturedAt = options.capturedAt ?? nowIso();
  const nextPromptSuggestions = result.agentRun.output.nextPromptSuggestions
    ?? result.finalDisposition.nextPromptSuggestions;
  return {
    schemaVersion: 5,
    capturedAt,
    request: { prompt: result.prompt },
    ...(result.resolvedResearchProfile && result.researchWorkflow ? {
      researchProfile: {
        schemaVersion: result.resolvedResearchProfile.profile.schemaVersion,
        id: result.resolvedResearchProfile.profile.id,
        version: result.resolvedResearchProfile.profile.version,
        hash: result.resolvedResearchProfile.hash,
        source: result.resolvedResearchProfile.source,
        ...(result.resolvedResearchProfile.path ? { path: result.resolvedResearchProfile.path } : {}),
        workflowId: result.researchWorkflow.id,
        snapshot: result.resolvedResearchProfile.profile,
      },
    } : {}),
    agent: {
      id: result.agentRun.id,
      status: result.agentRun.status,
      executorName: result.agentRun.executorName,
      startedAt: result.agentRun.startedAt,
      completedAt: result.agentRun.completedAt,
      outputText: result.agentRun.output.text,
      finalDisposition: result.finalDisposition,
      ...(result.agentRun.output.goal ? { goal: result.agentRun.output.goal } : {}),
      ...(nextPromptSuggestions
        ? { nextPromptSuggestions }
        : {}),
      ...(result.agentRun.output.researchTrace
        ? { researchTrace: result.agentRun.output.researchTrace }
        : {}),
      ...(result.agentRun.output.raw !== undefined
        ? { raw: result.agentRun.output.raw }
        : {}),
    },
    context: {
      workspaceContext: result.modelWorkspaceContext,
      memory: result.memoryContext,
      selectedSkills: result.modelSelectedSkills,
      availableTools: result.availableTools,
      collaborationTools: result.collaborationTools,
    },
    workspaceContext: result.workspaceContext,
    storage: result.storageLayout,
    storageManifest: captureStorage(result.storageLayout),
    eventTimeline: [
      ...result.events.map(captureEvent),
      ...captureAgentControlEvents(result.agentRun.output.raw, result.agentRun.id, capturedAt),
    ],
  };
}

function captureStorage(
  layout: ResearchStorageLayout,
): ResearchAgentFlowCapture["storageManifest"] {
  const manifest = loadResearchStorageManifest(layout);
  return {
    path: getResearchStorageManifestPath(layout),
    artifactCount: manifest.artifacts.length,
    artifacts: manifest.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      purpose: artifact.purpose,
      relativePath: artifact.relativePath,
      sizeBytes: artifact.sizeBytes,
      contentHash: artifact.contentHash,
      sourceEventIds: artifact.sourceEventIds,
    })),
  };
}


function captureEvent(event: ResearchEvent): ResearchFlowEventCapture {
  const payload = event.payload as Record<string, unknown>;
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.agentPath ? { agentPath: event.agentPath } : {}),
    ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
    summary:
      typeof payload.summary === "string" ? payload.summary : event.kind,
    payload: event.payload,
  };
}

const CAPTURED_AGENT_CONTROL_TYPES = new Set([
  "goal_lifecycle",
  "research_checkpoint",
  "research_loop_guard",
]);

function captureAgentControlEvents(
  raw: unknown,
  agentRunId: string,
  fallbackTimestamp: string,
): ResearchFlowEventCapture[] {
  if (!isRecord(raw) || !Array.isArray(raw.agentEvents)) return [];
  return raw.agentEvents.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const type = nonEmptyString(candidate.type);
    if (!type || !CAPTURED_AGENT_CONTROL_TYPES.has(type)) return [];
    const eventId = nonEmptyString(candidate.eventId) ?? `agent_control_${agentRunId}_${index}`;
    return [{
      id: eventId,
      kind: "agent.control" as const,
      timestamp: nonEmptyString(candidate.timestamp) ?? fallbackTimestamp,
      ...(nonEmptyString(candidate.agentId) ? { agentId: nonEmptyString(candidate.agentId)! } : {}),
      ...(nonEmptyString(candidate.agentPath) ? { agentPath: nonEmptyString(candidate.agentPath)! } : {}),
      ...(nonEmptyString(candidate.parentAgentId)
        ? { parentAgentId: nonEmptyString(candidate.parentAgentId)! }
        : {}),
      summary: `Honeycrisp host control: ${type}`,
      payload: candidate,
    }];
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
