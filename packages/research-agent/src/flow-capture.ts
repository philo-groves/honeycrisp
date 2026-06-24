import type { BootstrapResearchRunResult } from "./bootstrap.js";
import { nowIso } from "./ids.js";
import type {
  ResearchContextPacket,
  ResearchEvent,
  ResearchLoopProcessingResult,
  ResearchMemoryRef,
  ResearchMemorySnapshot,
  ResearchToolBudget,
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
    outputText: string;
    followUpRecommendation: string;
    followUpRationale: string;
    researchTrace?: ResearchTrace;
  };
  context: {
    directEvidence: readonly ResearchMemoryRef[];
    priorObservations: readonly ResearchMemoryRef[];
    currentHypotheses: readonly ResearchMemoryRef[];
    openQuestions: readonly string[];
    userCommitments: readonly string[];
    toolPermissions: readonly ResearchToolPermission[];
    toolBudget: ResearchToolBudget;
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
  } = {},
): ResearchFlowCapture {
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
    memory: createMemoryCapture(result.memory),
    eventTimeline: result.events.map(captureEvent),
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
    outputText: loopResult.output.text,
    followUpRecommendation: loopResult.followUpRecommendation,
    followUpRationale: loopResult.followUpRationale,
    ...(loopResult.output.researchTrace
      ? { researchTrace: loopResult.output.researchTrace }
      : {}),
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
