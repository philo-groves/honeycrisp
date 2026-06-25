import type { BootstrapResearchRunResult } from "./bootstrap.js";
import type {
  ResearchContextPacketV2,
  ResearchContextPacketV2SectionLabel,
} from "./context-packet-v2.js";
import { nowIso } from "./ids.js";
import { inferResearchLoopExecutionMode } from "./loop-processor.js";
import {
  getResearchStorageManifestPath,
  loadResearchStorageManifest,
  type ResearchStorageArtifactManifestEntry,
} from "./storage.js";
import type {
  ResearchContextPacket,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchLoopExecutionMode,
  ResearchLoopProcessingResult,
  ResearchMemoryRef,
  ResearchMemorySnapshot,
  ResearchSelectedSkill,
  ResearchSkippedToolAction,
  ResearchStorageLayout,
  ResearchToolBudget,
  ResearchToolAction,
  ResearchToolPermission,
  ResearchTrace,
} from "./types.js";

export interface ResearchFlowEventCapture {
  id: string;
  kind: ResearchEvent["kind"];
  timestamp: string;
  goalId?: string;
  summary: string;
  payload: unknown;
}

export interface ResearchFlowCapture {
  schemaVersion: 1;
  capturedAt: string;
  goal: {
    id: string;
    objective: string;
    scopeConstraints: readonly string[];
    evidenceRequirements: readonly string[];
    riskFlags: readonly string[];
  };
  decision: {
    actionClass: string;
    subGoalId: string;
    subGoalObjective: string;
    rationale: string;
  };
  goalRun: {
    status: string;
    terminalReason?: string;
    loopsUsed: number;
    maxLoops: number | null;
    safetyMaxLoops: number;
    blockedThreshold: number;
    consecutiveBlockedCount: number;
    statusReason?: string;
  };
  loop: {
    planId: string;
    resultId: string;
    status: ResearchLoopProcessingResult["status"];
    executorName: string;
    executionMode: ResearchLoopExecutionMode;
    outputText: string;
    followUpRecommendation: string;
    followUpRationale: string;
    researchTrace?: ResearchTrace;
    raw?: unknown;
  };
  context: {
    directEvidence: readonly ResearchMemoryRef[];
    priorObservations: readonly ResearchMemoryRef[];
    currentHypotheses: readonly ResearchMemoryRef[];
    openQuestions: readonly string[];
    userCommitments: readonly string[];
    toolPermissions: readonly ResearchToolPermission[];
    toolBudget: ResearchToolBudget;
    governancePolicy?: ResearchGovernancePolicy;
    selectedSkills: readonly ResearchSelectedSkill[];
    candidateToolActions: readonly ResearchToolAction[];
    skippedToolActions: readonly ResearchSkippedToolAction[];
  };
  storage: ResearchStorageLayout;
  contextV2?: {
    preconsciousCandidateCount: number;
    tokenBudget: number;
    estimatedTokens: number;
    compaction: {
      reason: "context_token_budget_exceeded" | "not_needed";
      acceptedTokenBudget: number;
      estimatedTokensBeforeCompaction: number;
      estimatedTokensAfterCompaction: number;
      removedRecordIds: readonly string[];
      removedTokenCount: number;
    };
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
  };
  memoryIntegration?: {
    enabled: boolean;
    databasePath?: string;
    eventLogCount: number;
    recordCount: number;
    eventsAppended: number;
    recordsWritten: number;
    latestRetrievalCandidateCount: number;
    usedMemoryDrivenController: boolean;
    usedFirstRunFallback: boolean;
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
  memory: {
    counts: {
      eventLog: number;
      directEvidence: number;
      priorEpisodes: number;
      candidateProcedures: number;
      currentHypotheses: number;
      contradictions: number;
      prospectiveCommitments: number;
      userCommitments: number;
    };
    directEvidence: readonly ResearchMemoryRef[];
    priorEpisodes: readonly ResearchMemoryRef[];
    currentHypotheses: readonly ResearchMemoryRef[];
    contradictions: readonly ResearchMemoryRef[];
    prospectiveCommitments: readonly string[];
    userCommitments: readonly string[];
  };
  eventTimeline: readonly ResearchFlowEventCapture[];
}

export function createResearchFlowCapture(
  result: BootstrapResearchRunResult,
  options: {
    capturedAt?: string;
    contextPacketV2?: ResearchContextPacketV2;
  } = {},
): ResearchFlowCapture {
  const contextPacketV2 =
    options.contextPacketV2 ?? result.durableMemory?.latestContextPacketV2;

  return {
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? nowIso(),
    goal: {
      id: result.goalFrame.root.id,
      objective: result.goalFrame.root.objective,
      scopeConstraints: result.goalFrame.scopeConstraints,
      evidenceRequirements: result.goalFrame.evidenceRequirements,
      riskFlags: result.goalFrame.riskFlags,
    },
    decision: {
      actionClass: result.decision.actionClass,
      subGoalId: result.decision.subGoal.id,
      subGoalObjective: result.decision.subGoal.objective,
      rationale: result.decision.rationale,
    },
    goalRun: {
      status: result.goalRun.state.status,
      ...(result.goalRun.state.terminalReason
        ? { terminalReason: result.goalRun.state.terminalReason }
        : {}),
      loopsUsed: result.goalRun.state.loopsUsed,
      maxLoops: result.goalRun.state.maxLoops,
      safetyMaxLoops: result.goalRun.state.safetyMaxLoops,
      blockedThreshold: result.goalRun.state.blockedThreshold,
      consecutiveBlockedCount: result.goalRun.state.consecutiveBlockedCount,
      ...(result.goalRun.state.statusReason
        ? { statusReason: result.goalRun.state.statusReason }
        : {}),
    },
    loop: createLoopCapture(result.loopResult),
    context: createContextCapture(result.decision.contextPacket),
    storage: result.storageLayout,
    ...(contextPacketV2
      ? { contextV2: createContextV2Capture(contextPacketV2) }
      : {}),
    ...(result.durableMemory
      ? { memoryIntegration: createMemoryIntegrationCapture(result.durableMemory) }
      : {}),
    storageManifest: createStorageManifestCapture(result.storageLayout),
    memory: createMemoryCapture(result.memory),
    eventTimeline: result.events.map(captureEvent),
  };
}

function createMemoryIntegrationCapture(
  durableMemory: NonNullable<BootstrapResearchRunResult["durableMemory"]>,
): NonNullable<ResearchFlowCapture["memoryIntegration"]> {
  return {
    enabled: durableMemory.enabled,
    ...(durableMemory.databasePath
      ? { databasePath: durableMemory.databasePath }
      : {}),
    eventLogCount: durableMemory.eventLogCount,
    recordCount: durableMemory.recordCount,
    eventsAppended: durableMemory.eventsAppended,
    recordsWritten: durableMemory.recordsWritten,
    latestRetrievalCandidateCount: durableMemory.latestRetrievalCandidateCount,
    usedMemoryDrivenController: durableMemory.usedMemoryDrivenController,
    usedFirstRunFallback: durableMemory.usedFirstRunFallback,
  };
}

function createStorageManifestCapture(
  storageLayout: ResearchStorageLayout,
): ResearchFlowCapture["storageManifest"] {
  const manifest = loadResearchStorageManifest(storageLayout);

  return {
    path: getResearchStorageManifestPath(storageLayout),
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

function createLoopCapture(
  loopResult: ResearchLoopProcessingResult,
): ResearchFlowCapture["loop"] {
  return {
    planId: loopResult.loopPlanId,
    resultId: loopResult.id,
    status: loopResult.status,
    executorName: loopResult.executorName,
    executionMode: inferResearchLoopExecutionMode(loopResult),
    outputText: loopResult.output.text,
    followUpRecommendation: loopResult.followUpRecommendation,
    followUpRationale: loopResult.followUpRationale,
    ...(loopResult.output.researchTrace
      ? { researchTrace: loopResult.output.researchTrace }
      : {}),
    ...(loopResult.output.raw ? { raw: loopResult.output.raw } : {}),
  };
}

function createContextCapture(
  contextPacket: ResearchContextPacket,
): ResearchFlowCapture["context"] {
  return {
    directEvidence: contextPacket.directEvidence,
    priorObservations: contextPacket.priorObservations,
    currentHypotheses: contextPacket.currentHypotheses,
    openQuestions: contextPacket.openQuestions,
    userCommitments: contextPacket.userCommitments,
    toolPermissions: contextPacket.toolPermissions,
    toolBudget: contextPacket.toolBudget,
    ...(contextPacket.governancePolicy
      ? { governancePolicy: contextPacket.governancePolicy }
      : {}),
    selectedSkills: contextPacket.selectedSkills,
    candidateToolActions: contextPacket.candidateToolActions,
    skippedToolActions: contextPacket.skippedToolActions,
  };
}

function createContextV2Capture(
  contextPacket: ResearchContextPacketV2,
): NonNullable<ResearchFlowCapture["contextV2"]> {
  return {
    preconsciousCandidateCount: contextPacket.preconsciousCandidateCount,
    tokenBudget: contextPacket.tokenBudget,
    estimatedTokens: contextPacket.estimatedTokens,
    compaction: contextPacket.compaction,
    sections: contextPacket.sections.map((section) => ({
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

function createMemoryCapture(
  memory: ResearchMemorySnapshot,
): ResearchFlowCapture["memory"] {
  return {
    counts: {
      eventLog: memory.eventLog.length,
      directEvidence: memory.directEvidence.length,
      priorEpisodes: memory.priorEpisodes.length,
      candidateProcedures: memory.candidateProcedures.length,
      currentHypotheses: memory.currentHypotheses.length,
      contradictions: memory.contradictions.length,
      prospectiveCommitments: memory.prospectiveCommitments.length,
      userCommitments: memory.userCommitments.length,
    },
    directEvidence: memory.directEvidence,
    priorEpisodes: memory.priorEpisodes,
    currentHypotheses: memory.currentHypotheses,
    contradictions: memory.contradictions,
    prospectiveCommitments: memory.prospectiveCommitments,
    userCommitments: memory.userCommitments,
  };
}

function captureEvent(event: ResearchEvent): ResearchFlowEventCapture {
  return {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    summary: summarizeEvent(event),
    payload: event.payload,
  };
}

function summarizeEvent(event: ResearchEvent): string {
  const payload = event.payload;
  if (isRecord(payload)) {
    const summary = readString(payload, "summary");
    if (summary) {
      return truncate(summary, 700);
    }

    const text = readString(payload, "text");
    if (text) {
      return truncate(text, 700);
    }

    const objective = readString(payload, "objective");
    if (objective) {
      return truncate(objective, 700);
    }
  }

  return truncate(event.kind, 700);
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}...`;
}
