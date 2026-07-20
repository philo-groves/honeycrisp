import type {
  ResearchGovernancePolicy,
  ResearchMemorySnapshot,
  ResearchToolBudget,
  ResearchToolDescriptor,
  ResearchToolPermission,
} from "./types.js";

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

export function createToolPermissions(
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

export function createToolBudget(
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
