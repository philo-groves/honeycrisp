import { createResearchGoalFrame } from "./goal.js";
import {
  advanceGoalRunState,
  appendGoalContinuationToLoopPlan,
  createGoalIteration,
  createGoalRunState,
  shouldContinueGoal,
  updateGoalFrameFromRunState,
} from "./goal-runtime.js";
import { createResearchEventId, nowIso } from "./ids.js";
import { planResearchLoop } from "./loop-planner.js";
import {
  inferResearchLoopExecutionMode,
  processResearchLoop,
} from "./loop-processor.js";
import { routeEventsToMemorySnapshot } from "./memory-routing.js";
import { createFirstRunMemoryController } from "./memory-controller.js";
import { createResearchTraceEventsFromLoopResult } from "./research-trace.js";
import type {
  ResearchEvent,
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchGoalNode,
  ResearchGoalRunOptions,
  ResearchGoalRunResult,
  ResearchLoopPlan,
  ResearchLoopProcessingResult,
  ResearchMemoryControllerDecision,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
  ResearchLoopExecutor,
  ResearchToolDescriptor,
} from "./types.js";

export interface BootstrapResearchRunInput extends ResearchGoalFrameOptions {
  prompt: string;
  events?: readonly ResearchEvent[];
  memory?: Partial<ResearchMemorySnapshot>;
  tools?: readonly ResearchToolDescriptor[];
  loopExecutor?: ResearchLoopExecutor;
  goalRun?: ResearchGoalRunOptions;
}

export interface BootstrapResearchRunResult {
  goalFrame: ResearchGoalFrame;
  decision: ResearchMemoryControllerDecision;
  loopPlan: ResearchLoopPlan;
  loopResult: ResearchLoopProcessingResult;
  goalRun: ResearchGoalRunResult;
  loopResults: readonly ResearchLoopProcessingResult[];
  events: readonly ResearchEvent[];
  memory: ResearchMemorySnapshot;
  piBase: {
    agentCorePackage: "@earendil-works/pi-agent-core";
    aiPackage: "@earendil-works/pi-ai";
  };
  writeback: readonly ResearchMemoryStoreKind[];
  response: string;
}

export async function bootstrapResearchRun(
  input: BootstrapResearchRunInput,
): Promise<BootstrapResearchRunResult> {
  let goalFrame = createResearchGoalFrame(input.prompt, input);
  const events: ResearchEvent[] = [
    ...(input.events ?? []),
    {
      id: createResearchEventId(),
      kind: "goal.created",
      timestamp: nowIso(),
      goalId: goalFrame.root.id,
      payload: {
        objective: goalFrame.root.objective,
        status: "active",
      },
    },
  ];
  let memory = routeEventsToMemorySnapshot(events, input.memory);
  let goalState = createGoalRunState(goalFrame, input.goalRun);
  const childNodes: ResearchGoalNode[] = [];
  const iterations: ResearchGoalRunResult["iterations"][number][] = [];
  const loopResults: ResearchLoopProcessingResult[] = [];
  let decision: ResearchMemoryControllerDecision | undefined;
  let loopPlan: ResearchLoopPlan | undefined;
  let loopResult: ResearchLoopProcessingResult | undefined;

  for (
    let iterationIndex = 0;
    iterationIndex < goalState.safetyMaxLoops && shouldContinueGoal(goalState);
    iterationIndex += 1
  ) {
    const controllerInput = {
      goalFrame,
      events,
      memory,
      ...(input.tools ? { tools: input.tools } : {}),
    };
    decision = createFirstRunMemoryController().decide(controllerInput);
    loopPlan = appendGoalContinuationToLoopPlan(
      planResearchLoop({ decision }),
      goalFrame,
      goalState,
    );
    loopResult = await processResearchLoop({
      loopPlan,
      ...(input.loopExecutor ? { executor: input.loopExecutor } : {}),
    });
    loopResults.push(loopResult);

    events.push(createMemoryDecisionEvent(goalFrame.root.id, decision));
    events.push(createContextCompiledEvent(goalFrame.root.id, decision));
    events.push(createLoopPlannedEvent(goalFrame.root.id, loopPlan));
    events.push(createLoopProcessedEvent(goalFrame.root.id, loopResult));
    events.push(
      ...createResearchTraceEventsFromLoopResult(loopResult, {
        goalId: goalFrame.root.id,
      }),
    );

    const transition = advanceGoalRunState({
      state: goalState,
      goalFrame,
      loopResult,
    });
    goalState = transition.state;
    events.push(transition.event);
    childNodes.push(
      createCompletedSubGoalNode({
        decision,
        loopResult,
        status: loopResult.status === "error" ? "blocked" : "complete",
      }),
    );
    iterations.push(
      createGoalIteration({
        index: iterationIndex,
        decision,
        loopPlan,
        loopResult,
        statusBefore: transition.statusBefore,
        statusAfter: transition.statusAfter,
        continuationReason: transition.continuationReason,
      }),
    );
    goalFrame = updateGoalFrameFromRunState(goalFrame, goalState, childNodes);
    memory = routeEventsToMemorySnapshot(events, memory);
  }

  if (!decision || !loopPlan || !loopResult) {
    throw new Error("Goal loop did not execute.");
  }

  const goalRun: ResearchGoalRunResult = {
    state: goalState,
    iterations,
  };
  const loopExecutionMode = inferResearchLoopExecutionMode(loopResult);

  const response = [
    `Honeycrisp initialized a research goal: ${goalFrame.root.objective}`,
    `Success gates: ${goalFrame.root.completionGates.length}`,
    `Stop gates: ${goalFrame.root.stopGates.length}`,
    `Goal status: ${goalRun.state.status} (${goalRun.state.terminalReason ?? "continuing"})`,
    `Goal loops: ${goalRun.state.loopsUsed}/${goalRun.state.maxLoops ?? "unbounded"}`,
    `Next action: ${decision.actionClass} - ${decision.subGoal.objective}`,
    `Loop plan: ${loopPlan.id}`,
    `Loop result: ${loopResult.status} via ${loopResult.executorName}`,
    `Execution mode: ${loopExecutionMode}`,
    "Runtime base: @earendil-works/pi-agent-core with @earendil-works/pi-ai.",
    "Research memory, storage, and domain-specific tools will be layered around Pi instead of replacing it.",
  ].join("\n");

  return {
    goalFrame,
    decision,
    loopPlan,
    loopResult,
    goalRun,
    loopResults,
    events,
    memory,
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    writeback: decision.writeback,
    response,
  };
}

function createMemoryDecisionEvent(
  goalId: string,
  decision: ResearchMemoryControllerDecision,
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "memory.decision",
    timestamp: nowIso(),
    goalId,
    payload: {
      actionClass: decision.actionClass,
      subGoal: decision.subGoal,
      actionScores: decision.actionScores,
      toolBudget: decision.toolBudget,
      writeback: decision.writeback,
    },
  };
}

function createContextCompiledEvent(
  goalId: string,
  decision: ResearchMemoryControllerDecision,
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "context.compiled",
    timestamp: nowIso(),
    goalId,
    payload: {
      activeSubGoalId: decision.contextPacket.activeSubGoal.id,
      evidenceRefs: decision.contextPacket.directEvidence.length,
      openQuestions: decision.contextPacket.openQuestions,
      toolPermissions: decision.contextPacket.toolPermissions,
    },
  };
}

function createLoopPlannedEvent(
  goalId: string,
  loopPlan: ResearchLoopPlan,
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "loop.planned",
    timestamp: nowIso(),
    goalId,
    payload: {
      loopPlanId: loopPlan.id,
      subGoalId: loopPlan.subGoal.id,
      permittedToolClasses: loopPlan.permittedToolClasses,
      actionBudget: loopPlan.actionBudget,
      expectedArtifacts: loopPlan.expectedArtifacts,
      writebackRequirements: loopPlan.writebackRequirements,
    },
  };
}

function createLoopProcessedEvent(
  goalId: string,
  loopResult: ResearchLoopProcessingResult,
): ResearchEvent {
  const executionMode = inferResearchLoopExecutionMode(loopResult);

  return {
    id: createResearchEventId(),
    kind: "loop.processed",
    timestamp: nowIso(),
    goalId,
    payload: {
      loopResultId: loopResult.id,
      loopPlanId: loopResult.loopPlanId,
      status: loopResult.status,
      executorName: loopResult.executorName,
      executionMode,
      summary: loopResult.output.text,
      artifacts: loopResult.output.artifacts,
      evidenceRefs: loopResult.output.evidenceRefs,
      claimRefs: loopResult.output.claimRefs,
      researchTrace: loopResult.output.researchTrace,
      raw: loopResult.output.raw,
      followUpRecommendation: loopResult.followUpRecommendation,
    },
  };
}

function createCompletedSubGoalNode(input: {
  decision: ResearchMemoryControllerDecision;
  loopResult: ResearchLoopProcessingResult;
  status: ResearchGoalNode["status"];
}): ResearchGoalNode {
  const now = nowIso();

  return {
    id: input.decision.subGoal.id,
    parentId: input.decision.subGoal.parentGoalId,
    status: input.status,
    objective: input.decision.subGoal.objective,
    rationale: input.decision.subGoal.rationale,
    completionGates: input.decision.subGoal.completionGates,
    stopGates: [],
    actionClass: input.decision.actionClass,
    memoryRefs: [
      ...input.loopResult.output.evidenceRefs,
      ...input.loopResult.output.claimRefs,
    ],
    expectedArtifacts: input.decision.subGoal.expectedArtifacts,
    resultSummary: input.loopResult.output.text,
    createdAt: input.loopResult.startedAt,
    updatedAt: now,
  };
}
