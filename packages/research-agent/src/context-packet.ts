import type {
  ResearchContextPacket,
  ResearchGovernancePolicy,
  ResearchGoalFrame,
  ResearchGoalNode,
  ResearchMemoryRef,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
  ResearchSelectedSkill,
  ResearchSkippedToolAction,
  ResearchSubGoal,
  ResearchToolBudget,
  ResearchToolAction,
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
  selectedSkills?: readonly ResearchSelectedSkill[];
  candidateToolActions?: readonly ResearchToolAction[];
  skippedToolActions?: readonly ResearchSkippedToolAction[];
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
    candidateProcedures: [
      ...input.memory.candidateProcedures,
      ...createSkillProcedureRefs(input.selectedSkills ?? []),
    ],
    currentHypotheses: input.memory.currentHypotheses,
    currentFindings: input.memory.currentFindings,
    contradictions: input.memory.contradictions,
    openQuestions: createOpenQuestions(input.goalFrame, input.memory),
    userCommitments: [
      ...input.goalFrame.scopeConstraints,
      ...input.goalFrame.userPreferences,
      ...input.memory.userCommitments,
    ],
    toolPermissions: createToolPermissions(input.tools, input.governance),
    toolBudget,
    ...(input.governance ? { governancePolicy: input.governance } : {}),
    selectedSkills: input.selectedSkills ?? [],
    candidateToolActions: input.candidateToolActions ?? [],
    skippedToolActions: input.skippedToolActions ?? [],
    writebackExpectations: input.writebackExpectations ?? [
      "event",
      "working",
      "episodic",
    ],
  };
}

function createSkillProcedureRefs(
  selectedSkills: readonly ResearchSelectedSkill[],
): ResearchMemoryRef[] {
  return selectedSkills.flatMap((skill) => {
    if (!skill.runbook) {
      return [];
    }

    return [{
      store: "procedural",
      id: `skill:${skill.id}:runbook`,
      recordKind: "procedure",
      status: "candidate",
      summary: skill.runbook,
      confidence: 0.75,
    }];
  });
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
    currentFindings: [],
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
    currentFindings: memory?.currentFindings ?? empty.currentFindings,
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
    .filter(
      (tool) =>
        tool.actionClasses.length > 0 &&
        isSideEffectAllowed(tool.sideEffects, governance) &&
        arePermissionsAllowed(tool.requiredPermissions, governance),
    );
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

function isSideEffectAllowed(
  sideEffect: ResearchToolDescriptor["sideEffects"],
  governance: ResearchGovernancePolicy | undefined,
): boolean {
  if (governance?.deniedSideEffects?.includes(sideEffect)) {
    return false;
  }
  if (
    governance?.allowedSideEffects &&
    !governance.allowedSideEffects.includes(sideEffect)
  ) {
    return false;
  }

  return true;
}

function arePermissionsAllowed(
  permissions: readonly string[],
  governance: ResearchGovernancePolicy | undefined,
): boolean {
  if (
    permissions.some((permission) =>
      governance?.deniedPermissions?.includes(permission),
    )
  ) {
    return false;
  }

  if (
    governance?.allowedPermissions &&
    permissions.some(
      (permission) => !governance.allowedPermissions?.includes(permission),
    )
  ) {
    return false;
  }

  return true;
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
    ...(governance?.maxBytes ? { maxBytes: governance.maxBytes } : {}),
    ...(governance?.maxTokens ? { maxTokens: governance.maxTokens } : {}),
  };
}
