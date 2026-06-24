import type {
  ResearchContextPacket,
  ResearchGovernancePolicy,
  ResearchGoalFrame,
  ResearchGoalNode,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
  ResearchSubGoal,
  ResearchToolBudget,
  ResearchToolDescriptor,
  ResearchToolPermission,
} from "./types.js";

export interface CompileContextPacketInput {
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  activeSubGoal: ResearchSubGoal;
  memory: ResearchMemorySnapshot;
  tools: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  writebackExpectations?: readonly ResearchMemoryStoreKind[];
}

export function compileContextPacket(
  input: CompileContextPacketInput,
): ResearchContextPacket {
  const toolBudget = createToolBudget(input.governance, input.tools);

  return {
    goalFrame: input.goalFrame,
    activeGoal: input.activeGoal,
    activeSubGoal: input.activeSubGoal,
    directEvidence: input.memory.directEvidence,
    priorObservations: input.memory.priorEpisodes,
    candidateProcedures: input.memory.candidateProcedures,
    currentHypotheses: input.memory.currentHypotheses,
    contradictions: input.memory.contradictions,
    openQuestions: createOpenQuestions(input.goalFrame, input.memory),
    userCommitments: [
      ...input.goalFrame.scopeConstraints,
      ...input.goalFrame.userPreferences,
      ...input.memory.userCommitments,
    ],
    toolPermissions: createToolPermissions(input.tools, input.governance),
    toolBudget,
    writebackExpectations: input.writebackExpectations ?? [
      "event",
      "working",
      "episodic",
    ],
  };
}

export function createEmptyMemorySnapshot(
  eventLog: ResearchMemorySnapshot["eventLog"] = [],
): ResearchMemorySnapshot {
  return {
    eventLog,
    directEvidence: [],
    priorEpisodes: [],
    candidateProcedures: [],
    currentHypotheses: [],
    contradictions: [],
    prospectiveCommitments: [],
    userCommitments: [],
  };
}

export function normalizeMemorySnapshot(
  memory: Partial<ResearchMemorySnapshot> | undefined,
  eventLog: ResearchMemorySnapshot["eventLog"] = [],
): ResearchMemorySnapshot {
  const empty = createEmptyMemorySnapshot(eventLog);

  return {
    eventLog: memory?.eventLog ?? empty.eventLog,
    directEvidence: memory?.directEvidence ?? empty.directEvidence,
    priorEpisodes: memory?.priorEpisodes ?? empty.priorEpisodes,
    candidateProcedures:
      memory?.candidateProcedures ?? empty.candidateProcedures,
    currentHypotheses: memory?.currentHypotheses ?? empty.currentHypotheses,
    contradictions: memory?.contradictions ?? empty.contradictions,
    prospectiveCommitments:
      memory?.prospectiveCommitments ?? empty.prospectiveCommitments,
    userCommitments: memory?.userCommitments ?? empty.userCommitments,
  };
}

function createOpenQuestions(
  goalFrame: ResearchGoalFrame,
  memory: ResearchMemorySnapshot,
): string[] {
  const questions: string[] = [];

  if (memory.directEvidence.length === 0) {
    questions.push("What evidence is available to satisfy the root goal?");
  }
  if (goalFrame.scopeConstraints.length === 0) {
    questions.push("What scope constraints should bound this research run?");
  }
  if (memory.currentHypotheses.length === 0) {
    questions.push("What initial hypotheses should be tested first?");
  }

  return questions;
}

function createToolPermissions(
  tools: readonly ResearchToolDescriptor[],
  governance: ResearchGovernancePolicy | undefined,
): ResearchToolPermission[] {
  return tools
    .map((tool) => ({
      toolName: tool.name,
      actionClasses: filterActionClasses(tool.actionClasses, governance),
      sideEffects: tool.sideEffects,
      requiredPermissions: tool.requiredPermissions,
    }))
    .filter((tool) => tool.actionClasses.length > 0);
}

function filterActionClasses(
  actionClasses: ResearchToolDescriptor["actionClasses"],
  governance: ResearchGovernancePolicy | undefined,
) {
  return actionClasses.filter((actionClass) => {
    if (governance?.deniedActionClasses?.includes(actionClass)) {
      return false;
    }
    if (
      governance?.allowedActionClasses &&
      !governance.allowedActionClasses.includes(actionClass)
    ) {
      return false;
    }

    return true;
  });
}

function createToolBudget(
  governance: ResearchGovernancePolicy | undefined,
  tools: readonly ResearchToolDescriptor[],
): ResearchToolBudget {
  return {
    maxToolCalls: governance?.maxToolCalls ?? (tools.length > 0 ? 3 : 0),
    ...(governance?.maxRuntimeMs
      ? { maxRuntimeMs: governance.maxRuntimeMs }
      : {}),
    ...(governance?.maxFiles ? { maxFiles: governance.maxFiles } : {}),
    ...(governance?.maxTokens ? { maxTokens: governance.maxTokens } : {}),
  };
}
