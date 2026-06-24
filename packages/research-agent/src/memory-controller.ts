import { createId } from "./ids.js";
import {
  compileContextPacket,
  normalizeMemorySnapshot,
} from "./context-packet.js";
import type {
  ResearchActionClass,
  ResearchActionScore,
  ResearchCompletionGate,
  ResearchGovernancePolicy,
  ResearchMemoryControllerDecision,
  ResearchMemoryControllerInput,
  ResearchSubGoal,
  ResearchToolBudget,
  ResearchToolDescriptor,
} from "./types.js";

const DEFAULT_WRITEBACK = ["event", "working", "episodic"] as const;

export class FirstRunMemoryController {
  decide(input: ResearchMemoryControllerInput): ResearchMemoryControllerDecision {
    const activeGoal = input.activeGoal ?? input.goalFrame.root;
    const tools = input.tools ?? [];
    const memory = normalizeMemorySnapshot(input.memory, input.events ?? []);
    const actionScores = scoreActionClasses(
      input.goalFrame.riskFlags,
      input.goalFrame.scopeConstraints,
      tools,
      input.governance,
    );
    const selectedAction = selectAction(actionScores);
    const toolBudget = createDecisionToolBudget(input.governance, tools);
    const completionGates = createSubGoalGates(
      selectedAction,
      activeGoal.completionGates,
    );
    const subGoal: ResearchSubGoal = {
      id: createId("subgoal"),
      parentGoalId: activeGoal.id,
      objective: createSubGoalObjective(selectedAction, activeGoal.objective),
      rationale: createSubGoalRationale(selectedAction),
      actionClass: selectedAction,
      completionGates,
      expectedArtifacts: createExpectedArtifacts(selectedAction),
    };
    const contextInput = {
      goalFrame: input.goalFrame,
      activeGoal,
      activeSubGoal: subGoal,
      memory,
      tools,
      writebackExpectations: DEFAULT_WRITEBACK,
      ...(input.governance ? { governance: input.governance } : {}),
    };
    const contextPacket = compileContextPacket(contextInput);

    return {
      subGoal,
      actionClass: selectedAction,
      rationale:
        "First-run memory state has no durable recall yet; action selection is based on the goal frame, policy, and available tools.",
      actionScores,
      contextPacket,
      toolBudget,
      completionGates,
      writeback: DEFAULT_WRITEBACK,
    };
  }
}

export function createFirstRunMemoryController(): FirstRunMemoryController {
  return new FirstRunMemoryController();
}

function scoreActionClasses(
  riskFlags: readonly string[],
  scopeConstraints: readonly string[],
  tools: readonly ResearchToolDescriptor[],
  governance: ResearchGovernancePolicy | undefined,
): ResearchActionScore[] {
  const securitySensitive = riskFlags.some((flag) =>
    /security|vulnerability|exploit|rce|sandbox|privilege/i.test(flag),
  );
  const hasScope = scopeConstraints.length > 0;
  const hasInspectTool = supportsAction(tools, "inspect", governance);
  const hasSearchTool = supportsAction(tools, "search", governance);
  const noExternalSearch = scopeConstraints.some((constraint) =>
    /no external search|do not search|no network|do not scan networks/i.test(
      constraint,
    ),
  );

  const scores: ResearchActionScore[] = [
    {
      actionClass: "ask_user",
      score: securitySensitive && !hasScope ? 100 : 15,
      rationale:
        securitySensitive && !hasScope
          ? "Security-sensitive research needs explicit scope before tool use."
          : "No blocking missing input was detected.",
    },
    {
      actionClass: "inspect",
      score: hasInspectTool ? 80 : 0,
      rationale: hasInspectTool
        ? "An inspect-capable tool is available for first evidence gathering."
        : "No inspect-capable tool is currently available.",
    },
    {
      actionClass: "search",
      score: hasSearchTool && !noExternalSearch ? 60 : 0,
      rationale:
        hasSearchTool && !noExternalSearch
          ? "Search is available and not excluded by scope constraints."
          : "Search is unavailable or excluded by scope constraints.",
    },
    {
      actionClass: "synthesize",
      score: 55,
      rationale:
        "A first-run synthesis can turn the goal frame into an initial research plan and evidence checklist.",
    },
    {
      actionClass: "respond",
      score: 10,
      rationale:
        "Responding immediately is low utility before at least one bounded research step.",
    },
  ];

  return scores
    .filter((score) => isAllowed(score.actionClass, governance))
    .sort((left, right) => right.score - left.score);
}

function selectAction(
  actionScores: readonly ResearchActionScore[],
): ResearchActionClass {
  return actionScores[0]?.actionClass ?? "synthesize";
}

function supportsAction(
  tools: readonly ResearchToolDescriptor[],
  actionClass: ResearchActionClass,
  governance: ResearchGovernancePolicy | undefined,
): boolean {
  if (!isAllowed(actionClass, governance)) {
    return false;
  }

  return tools.some((tool) => tool.actionClasses.includes(actionClass));
}

function isAllowed(
  actionClass: ResearchActionClass,
  governance: ResearchGovernancePolicy | undefined,
): boolean {
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
}

function createDecisionToolBudget(
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

function createSubGoalObjective(
  actionClass: ResearchActionClass,
  rootObjective: string,
): string {
  if (actionClass === "ask_user") {
    return `Confirm missing scope before pursuing: ${rootObjective}`;
  }
  if (actionClass === "inspect") {
    return `Gather first direct evidence for: ${rootObjective}`;
  }
  if (actionClass === "search") {
    return `Gather first external evidence for: ${rootObjective}`;
  }

  return `Prepare an initial research plan for: ${rootObjective}`;
}

function createSubGoalRationale(actionClass: ResearchActionClass): string {
  if (actionClass === "ask_user") {
    return "The goal frame indicates risk or missing boundaries that should be clarified before action.";
  }
  if (actionClass === "inspect") {
    return "Direct inspection is the most useful first step when local evidence tools are available.";
  }
  if (actionClass === "search") {
    return "External search can reduce uncertainty when allowed by scope.";
  }

  return "With no retrieved memory and no executable evidence tools selected, synthesis produces the next bounded plan.";
}

function createSubGoalGates(
  actionClass: ResearchActionClass,
  rootGates: readonly ResearchCompletionGate[],
): ResearchCompletionGate[] {
  const description =
    actionClass === "ask_user"
      ? "Required scope or missing input has been requested from the user."
      : "The next bounded research step has an explicit plan, evidence needs, and stop conditions.";

  return [
    {
      id: createId("gate"),
      description,
      polarity: "success",
    },
    ...rootGates.slice(0, 2),
  ];
}

function createExpectedArtifacts(
  actionClass: ResearchActionClass,
): readonly string[] {
  if (actionClass === "ask_user") {
    return ["scope clarification request"];
  }
  if (actionClass === "inspect" || actionClass === "search") {
    return ["evidence notes", "candidate claims"];
  }

  return ["initial research plan", "evidence checklist"];
}
