import type { RunResearchAgentResult } from "./bootstrap.js";
import type {
  ResearchContextPacketV2,
  ResearchContextPacketV2SectionLabel,
} from "./context-packet-v2.js";
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
  ResearchMemoryRef,
  ResearchNextPromptSuggestion,
  ResearchStorageLayout,
  ResearchTrace,
  ResearchWorkspaceContext,
} from "./types.js";

export interface ResearchFlowEventCapture {
  id: string;
  kind: ResearchEvent["kind"];
  timestamp: string;
  summary: string;
  payload: unknown;
}

interface ResearchContextCapture {
  preconsciousCandidateCount: number;
  tokenBudget: number;
  estimatedTokens: number;
  compaction: ResearchContextPacketV2["compaction"];
  sections: readonly {
    label: ResearchContextPacketV2SectionLabel;
    itemCount: number;
    tokenBudget: number;
    estimatedTokens: number;
    selectedRecordIds: readonly string[];
    droppedRecordIds: readonly string[];
    selectionReasons: readonly {
      recordId: string;
      reasons: readonly string[];
      warnings: readonly string[];
    }[];
  }[];
}

interface ResearchMemoryCapture {
  counts: {
    eventLog: number;
    directEvidence: number;
    priorEpisodes: number;
    candidateProcedures: number;
    currentHypotheses: number;
    currentFindings: number;
    contradictions: number;
    prospectiveCommitments: number;
    userCommitments: number;
  };
  directEvidence: readonly ResearchMemoryRef[];
  priorEpisodes: readonly ResearchMemoryRef[];
  currentHypotheses: readonly ResearchMemoryRef[];
  currentFindings: readonly ResearchMemoryRef[];
  contradictions: readonly ResearchMemoryRef[];
  prospectiveCommitments: readonly string[];
  userCommitments: readonly string[];
}

export interface ResearchAgentFlowCapture {
  schemaVersion: 3;
  capturedAt: string;
  request: { prompt: string };
  agent: {
    id: string;
    status: "complete" | "error";
    executorName: string;
    startedAt: string;
    completedAt: string;
    outputText: string;
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
  contextV2?: ResearchContextCapture;
  memoryIntegration?: {
    enabled: true;
    databasePath?: string;
    eventLogCount: number;
    recordCount: number;
    proofObligationCount: number;
    proofAttemptCount: number;
    eventsAppended: number;
    recordsWritten: number;
    latestRetrievalCandidateCount: number;
  };
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
  memory: ResearchMemoryCapture;
  eventTimeline: readonly ResearchFlowEventCapture[];
}

export function createResearchAgentFlowCapture(
  result: RunResearchAgentResult,
  options: { capturedAt?: string } = {},
): ResearchAgentFlowCapture {
  const contextPacket = result.durableMemory?.latestContextPacketV2;
  return {
    schemaVersion: 3,
    capturedAt: options.capturedAt ?? nowIso(),
    request: { prompt: result.prompt },
    agent: {
      id: result.agentRun.id,
      status: result.agentRun.status,
      executorName: result.agentRun.executorName,
      startedAt: result.agentRun.startedAt,
      completedAt: result.agentRun.completedAt,
      outputText: result.agentRun.output.text,
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
    ...(contextPacket ? { contextV2: captureContext(contextPacket) } : {}),
    ...(result.durableMemory
      ? {
          memoryIntegration: {
            enabled: true,
            ...(result.durableMemory.databasePath
              ? { databasePath: result.durableMemory.databasePath }
              : {}),
            eventLogCount: result.durableMemory.eventLogCount,
            recordCount: result.durableMemory.recordCount,
            proofObligationCount: result.durableMemory.proofObligationCount,
            proofAttemptCount: result.durableMemory.proofAttemptCount,
            eventsAppended: result.durableMemory.eventsAppended,
            recordsWritten: result.durableMemory.recordsWritten,
            latestRetrievalCandidateCount:
              result.durableMemory.latestRetrievalCandidateCount,
          },
        }
      : {}),
    storageManifest: captureStorage(result.storageLayout),
    memory: captureMemory(result),
    eventTimeline: result.events.map(captureEvent),
  };
}

function captureContext(packet: ResearchContextPacketV2): ResearchContextCapture {
  return {
    preconsciousCandidateCount: packet.preconsciousCandidateCount,
    tokenBudget: packet.tokenBudget,
    estimatedTokens: packet.estimatedTokens,
    compaction: packet.compaction,
    sections: packet.sections.map((section) => ({
      label: section.label,
      itemCount: section.items.length,
      tokenBudget: section.tokenBudget,
      estimatedTokens: section.estimatedTokens,
      selectedRecordIds: section.items.map((item) => item.recordId),
      droppedRecordIds: section.droppedRecordIds,
      selectionReasons: section.items.map((item) => ({
        recordId: item.recordId,
        reasons: item.selectionReasons,
        warnings: item.warnings,
      })),
    })),
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

function captureMemory(result: RunResearchAgentResult): ResearchMemoryCapture {
  const memory = result.memory;
  return {
    counts: {
      eventLog: memory.eventLog.length,
      directEvidence: memory.directEvidence.length,
      priorEpisodes: memory.priorEpisodes.length,
      candidateProcedures: memory.candidateProcedures.length,
      currentHypotheses: memory.currentHypotheses.length,
      currentFindings: memory.currentFindings.length,
      contradictions: memory.contradictions.length,
      prospectiveCommitments: memory.prospectiveCommitments.length,
      userCommitments: memory.userCommitments.length,
    },
    directEvidence: memory.directEvidence,
    priorEpisodes: memory.priorEpisodes,
    currentHypotheses: memory.currentHypotheses,
    currentFindings: memory.currentFindings,
    contradictions: memory.contradictions,
    prospectiveCommitments: memory.prospectiveCommitments,
    userCommitments: memory.userCommitments,
  };
}

function captureEvent(event: ResearchEvent): ResearchFlowEventCapture {
  const payload = event.payload as Record<string, unknown>;
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    summary:
      typeof payload.summary === "string" ? payload.summary : event.kind,
    payload: event.payload,
  };
}
