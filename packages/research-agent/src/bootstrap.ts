import { createResearchGoalFrame } from "./goal.js";
import { createId, nowIso } from "./ids.js";
import { planResearchLoop } from "./loop-planner.js";
import { createFirstRunMemoryController } from "./memory-controller.js";
import type {
  ResearchEvent,
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchLoopPlan,
  ResearchMemoryControllerDecision,
  ResearchMemoryStoreKind,
  ResearchToolDescriptor,
} from "./types.js";

export interface BootstrapResearchRunInput extends ResearchGoalFrameOptions {
  prompt: string;
  tools?: readonly ResearchToolDescriptor[];
}

export interface BootstrapResearchRunResult {
  goalFrame: ResearchGoalFrame;
  decision: ResearchMemoryControllerDecision;
  loopPlan: ResearchLoopPlan;
  events: readonly ResearchEvent[];
  piBase: {
    agentCorePackage: "@earendil-works/pi-agent-core";
    aiPackage: "@earendil-works/pi-ai";
  };
  writeback: readonly ResearchMemoryStoreKind[];
  response: string;
}

export function bootstrapResearchRun(
  input: BootstrapResearchRunInput,
): BootstrapResearchRunResult {
  const goalFrame = createResearchGoalFrame(input.prompt, input);
  const events: ResearchEvent[] = [
    {
      id: createId("event"),
      kind: "goal.created",
      timestamp: nowIso(),
      goalId: goalFrame.root.id,
      payload: {
        objective: goalFrame.root.objective,
      },
    },
  ];
  const controllerInput = {
    goalFrame,
    events,
    ...(input.tools ? { tools: input.tools } : {}),
  };
  const decision = createFirstRunMemoryController().decide(controllerInput);
  const loopPlan = planResearchLoop({ decision });
  events.push({
    id: createId("event"),
    kind: "memory.decision",
    timestamp: nowIso(),
    goalId: goalFrame.root.id,
    payload: {
      actionClass: decision.actionClass,
      subGoal: decision.subGoal,
      actionScores: decision.actionScores,
      toolBudget: decision.toolBudget,
      writeback: decision.writeback,
    },
  });
  events.push({
    id: createId("event"),
    kind: "context.compiled",
    timestamp: nowIso(),
    goalId: goalFrame.root.id,
    payload: {
      activeSubGoalId: decision.contextPacket.activeSubGoal.id,
      evidenceRefs: decision.contextPacket.directEvidence.length,
      openQuestions: decision.contextPacket.openQuestions,
      toolPermissions: decision.contextPacket.toolPermissions,
    },
  });
  events.push({
    id: createId("event"),
    kind: "loop.planned",
    timestamp: nowIso(),
    goalId: goalFrame.root.id,
    payload: {
      loopPlanId: loopPlan.id,
      subGoalId: loopPlan.subGoal.id,
      permittedToolClasses: loopPlan.permittedToolClasses,
      actionBudget: loopPlan.actionBudget,
      expectedArtifacts: loopPlan.expectedArtifacts,
      writebackRequirements: loopPlan.writebackRequirements,
    },
  });

  const response = [
    `Honeycrisp initialized a research goal: ${goalFrame.root.objective}`,
    `Success gates: ${goalFrame.root.completionGates.length}`,
    `Stop gates: ${goalFrame.root.stopGates.length}`,
    `Next action: ${decision.actionClass} - ${decision.subGoal.objective}`,
    `Loop plan: ${loopPlan.id}`,
    "Runtime base: @earendil-works/pi-agent-core with @earendil-works/pi-ai.",
    "Research memory, storage, and domain-specific tools will be layered around Pi instead of replacing it.",
  ].join("\n");

  return {
    goalFrame,
    decision,
    loopPlan,
    events,
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    writeback: decision.writeback,
    response,
  };
}
