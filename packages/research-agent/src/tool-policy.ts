import type {
  ResearchGovernancePolicy,
  ResearchToolBudget,
  ResearchToolDescriptor,
  ResearchToolPermission,
} from "./types.js";

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
    if (governance?.deniedActionClasses?.includes(actionClass)) return false;
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
  if (governance?.deniedSideEffects?.includes(sideEffect)) return false;
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
    ...(governance?.maxToolCalls !== undefined
      ? { maxToolCalls: governance.maxToolCalls }
      : tools.length === 0
        ? { maxToolCalls: 0 }
        : {}),
    ...(governance?.maxRuntimeMs
      ? { maxRuntimeMs: governance.maxRuntimeMs }
      : {}),
    ...(governance?.maxFiles ? { maxFiles: governance.maxFiles } : {}),
    ...(governance?.maxBytes ? { maxBytes: governance.maxBytes } : {}),
    ...(governance?.maxTokens ? { maxTokens: governance.maxTokens } : {}),
  };
}
