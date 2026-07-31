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
  kind: ResearchEvent["kind"];
  timestamp: string;
  agentId?: string;
  agentPath?: string;
  parentAgentId?: string;
  summary: string;
  payload: unknown;
}

export interface ResearchAgentFlowCapture {
  schemaVersion: 4;
  capturedAt: string;
  request: { prompt: string };
  agent: {
    id: string;
    status: "complete" | "error";
    executorName: string;
    startedAt: string;
    completedAt: string;
    outputText: string;
    finalDisposition: RunResearchAgentResult["finalDisposition"];
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
  return {
    schemaVersion: 4,
    capturedAt: options.capturedAt ?? nowIso(),
    request: { prompt: result.prompt },
    agent: {
      id: result.agentRun.id,
      status: result.agentRun.status,
      executorName: result.agentRun.executorName,
      startedAt: result.agentRun.startedAt,
      completedAt: result.agentRun.completedAt,
      outputText: result.agentRun.output.text,
      finalDisposition: result.finalDisposition,
      ...(result.agentRun.output.nextPromptSuggestions
        ? { nextPromptSuggestions: result.agentRun.output.nextPromptSuggestions }
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
    eventTimeline: result.events.map(captureEvent),
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
