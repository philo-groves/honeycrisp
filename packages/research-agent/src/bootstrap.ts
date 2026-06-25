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
import {
  createResearchStorageLayout,
  ensureResearchStorageLayout,
  registerResearchStorageArtifactRef,
} from "./storage.js";
import type { ResearchContextPacketV2 } from "./context-packet-v2.js";
import {
  createDeterministicMemoryRetriever,
  type MemoryRetrievalResult,
  type MemoryRetriever,
} from "./memory-retriever.js";
import {
  createMemoryDrivenController,
  type MemoryDrivenControllerDecision,
} from "./memory-controller-v2.js";
import {
  createMemorySnapshotFromRecordStore,
  createSqliteMemoryRecordStore,
  type MemoryRecordStore,
} from "./memory-record-store.js";
import { routeEventsToMemorySnapshot } from "./memory-routing.js";
import { createFirstRunMemoryController } from "./memory-controller.js";
import {
  createSqliteMemoryEventLog,
  type MemoryEventLog,
} from "./memory-event-log.js";
import {
  createDeterministicMemoryWritePipeline,
  type MemoryWritePipeline,
} from "./memory-write-pipeline.js";
import { createResearchTraceEventsFromLoopResult } from "./research-trace.js";
import type {
  ResearchEvent,
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchGoalNode,
  ResearchGoalRunOptions,
  ResearchGoalRunResult,
  ResearchGovernancePolicy,
  ResearchLoopExecutor,
  ResearchLoopPlan,
  ResearchLoopProcessingResult,
  ResearchMemoryControllerDecision,
  ResearchMemoryControllerInput,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
  ResearchSelectedSkill,
  ResearchSkillDescriptor,
  ResearchStorageLayout,
  ResearchSubGoal,
  ResearchToolDescriptor,
} from "./types.js";

export interface ResearchDurableMemoryIntegrationOptions {
  eventLog?: MemoryEventLog;
  recordStore?: MemoryRecordStore;
  writePipeline?: MemoryWritePipeline;
  retriever?: MemoryRetriever;
  closeStores?: boolean;
}

export interface ResearchDurableMemoryRunSummary {
  enabled: boolean;
  databasePath?: string;
  eventLogCount: number;
  recordCount: number;
  eventsAppended: number;
  recordsWritten: number;
  latestRetrievalCandidateCount: number;
  usedMemoryDrivenController: boolean;
  usedFirstRunFallback: boolean;
  latestContextPacketV2?: ResearchContextPacketV2;
}

export interface BootstrapResearchRunInput extends ResearchGoalFrameOptions {
  prompt: string;
  workspaceRoot?: string;
  storageLayout?: ResearchStorageLayout;
  durableMemory?: boolean | ResearchDurableMemoryIntegrationOptions;
  events?: readonly ResearchEvent[];
  memory?: Partial<ResearchMemorySnapshot>;
  tools?: readonly ResearchToolDescriptor[];
  skills?: readonly ResearchSkillDescriptor[];
  selectedSkillIds?: readonly string[];
  governance?: ResearchGovernancePolicy;
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
  storageLayout: ResearchStorageLayout;
  durableMemory?: ResearchDurableMemoryRunSummary;
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
  const storageLayout = ensureResearchStorageLayout(
    input.storageLayout ??
      createResearchStorageLayout({
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    }),
  );
  const durableMemory = createDurableMemoryRuntime({
    option: input.durableMemory,
    storageLayout,
    workspaceRoot: input.workspaceRoot,
  });
  let goalFrame = createResearchGoalFrame(input.prompt, input);
  const initialEvents: ResearchEvent[] = [
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
  const events: ResearchEvent[] = [];
  let memory = routeEventsToMemorySnapshot([], input.memory);
  const durableStats = createDurableMemoryStats(durableMemory);
  if (durableMemory) {
    const appended = appendAndConsolidateDurableEvents({
      durableMemory,
      events: initialEvents,
      stats: durableStats,
    });
    events.push(...appended);
    memory = refreshMemorySnapshot({
      durableMemory,
      localEvents: events,
      ...(input.memory ? { base: input.memory } : {}),
    });
  } else {
    events.push(...initialEvents);
    memory = routeEventsToMemorySnapshot(events, input.memory);
  }
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
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.selectedSkillIds
        ? { selectedSkillIds: input.selectedSkillIds }
        : {}),
      ...(input.governance ? { governance: input.governance } : {}),
    };
    const controllerResult = decideWithRuntimeMemory({
      durableMemory,
      controllerInput,
      recentEvents: events.slice(-20),
    });
    decision = controllerResult.decision;
    updateDurableMemoryDecisionStats(durableStats, controllerResult);
    loopPlan = appendGoalContinuationToLoopPlan(
      planResearchLoop({ decision }),
      goalFrame,
      goalState,
    );
    loopResult = await processResearchLoop({
      loopPlan,
      ...(input.loopExecutor ? { executor: input.loopExecutor } : {}),
      storageLayout,
    });
    loopResults.push(loopResult);

    const iterationEvents: ResearchEvent[] = [];
    iterationEvents.push(createMemoryDecisionEvent(goalFrame.root.id, decision));
    iterationEvents.push(createContextCompiledEvent(goalFrame.root.id, decision, storageLayout));
    iterationEvents.push(createLoopPlannedEvent(goalFrame.root.id, loopPlan));
    iterationEvents.push(...(loopResult.output.toolEvents ?? []));
    iterationEvents.push(createLoopProcessedEvent(goalFrame.root.id, loopResult));
    iterationEvents.push(
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
    iterationEvents.push(transition.event);
    const acceptedIterationEvents = durableMemory
      ? appendAndConsolidateDurableEvents({
          durableMemory,
          events: iterationEvents,
          stats: durableStats,
        })
      : iterationEvents;
    events.push(...acceptedIterationEvents);
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
    memory = refreshMemorySnapshot({
      durableMemory,
      localEvents: events,
      base: memory,
    });
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

  try {
    return {
    goalFrame,
    decision,
    loopPlan,
    loopResult,
    goalRun,
    loopResults,
    events,
    memory,
    storageLayout,
    ...(durableMemory
      ? { durableMemory: finalizeDurableMemorySummary(durableMemory, durableStats) }
      : {}),
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    writeback: decision.writeback,
    response,
    };
  } finally {
    durableMemory?.close();
  }
}

interface DurableMemoryRuntime {
  storageLayout: ResearchStorageLayout;
  eventLog: MemoryEventLog;
  recordStore: MemoryRecordStore;
  writePipeline: MemoryWritePipeline;
  retriever: MemoryRetriever;
  close(): void;
}

interface DurableMemoryStats {
  eventsAppended: number;
  recordsWritten: number;
  latestRetrievalCandidateCount: number;
  usedMemoryDrivenController: boolean;
  usedFirstRunFallback: boolean;
  latestContextPacketV2?: ResearchContextPacketV2;
}

function createDurableMemoryRuntime(input: {
  option: BootstrapResearchRunInput["durableMemory"];
  storageLayout: ResearchStorageLayout;
  workspaceRoot: string | undefined;
}): DurableMemoryRuntime | undefined {
  if (!input.option) {
    return undefined;
  }

  const options =
    typeof input.option === "object" ? input.option : {};
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const eventLog =
    options.eventLog ??
    createSqliteMemoryEventLog({
      workspaceRoot,
      databasePath: input.storageLayout.databasePath,
      artifactDirectoryPath: input.storageLayout.artifactDirectoryPath,
    });
  const recordStore =
    options.recordStore ??
    createSqliteMemoryRecordStore({
      workspaceRoot,
      databasePath: input.storageLayout.databasePath,
    });
  const writePipeline =
    options.writePipeline ?? createDeterministicMemoryWritePipeline();
  const retriever = options.retriever ?? createDeterministicMemoryRetriever();
  const closeStores =
    options.closeStores ?? (!options.eventLog && !options.recordStore);

  return {
    storageLayout: input.storageLayout,
    eventLog,
    recordStore,
    writePipeline,
    retriever,
    close() {
      if (!closeStores) {
        return;
      }
      eventLog.close();
      recordStore.close();
    },
  };
}

function createDurableMemoryStats(
  durableMemory: DurableMemoryRuntime | undefined,
): DurableMemoryStats {
  return {
    eventsAppended: 0,
    recordsWritten: 0,
    latestRetrievalCandidateCount: 0,
    usedMemoryDrivenController: false,
    usedFirstRunFallback: !durableMemory,
  };
}

function appendAndConsolidateDurableEvents(input: {
  durableMemory: DurableMemoryRuntime;
  events: readonly ResearchEvent[];
  stats: DurableMemoryStats;
}): readonly ResearchEvent[] {
  if (input.events.length === 0) {
    return [];
  }

  const appended = input.durableMemory.eventLog.appendMany(input.events);
  input.stats.eventsAppended += appended.length;
  const candidateRecords = input.durableMemory.writePipeline.deriveMany(appended);
  registerEventArtifactRefs(input.durableMemory.storageLayout, appended);
  const newRecords = candidateRecords.filter(
    (record) => !input.durableMemory.recordStore.getById(record.id),
  );
  if (newRecords.length > 0) {
    input.durableMemory.recordStore.writeMany(newRecords);
    input.stats.recordsWritten += newRecords.length;
  }

  return appended;
}

function registerEventArtifactRefs(
  storageLayout: ResearchStorageLayout,
  events: readonly ResearchEvent[],
): void {
  for (const event of events) {
    for (const artifactRef of event.artifactRefs ?? []) {
      registerResearchStorageArtifactRef(storageLayout, artifactRef, [event.id]);
    }
  }
}

function refreshMemorySnapshot(input: {
  durableMemory: DurableMemoryRuntime | undefined;
  localEvents: readonly ResearchEvent[];
  base?: Partial<ResearchMemorySnapshot>;
}): ResearchMemorySnapshot {
  if (!input.durableMemory) {
    return routeEventsToMemorySnapshot(input.localEvents, input.base);
  }

  return createMemorySnapshotFromRecordStore(
    input.durableMemory.recordStore,
    input.durableMemory.eventLog.listAll(),
  );
}

function decideWithRuntimeMemory(input: {
  durableMemory: DurableMemoryRuntime | undefined;
  controllerInput: ResearchMemoryControllerInput;
  recentEvents: readonly ResearchEvent[];
}): {
  decision: ResearchMemoryControllerDecision;
  retrieval?: MemoryRetrievalResult;
  memoryDrivenDecision?: MemoryDrivenControllerDecision;
  usedMemoryDrivenController: boolean;
} {
  const fallback = createFirstRunMemoryController().decide(input.controllerInput);
  if (!input.durableMemory) {
    return {
      decision: fallback,
      usedMemoryDrivenController: false,
    };
  }

  const retrieval = input.durableMemory.retriever.retrieve({
    activeGoal: input.controllerInput.activeGoal ?? input.controllerInput.goalFrame.root,
    completionGates: input.controllerInput.goalFrame.root.completionGates,
    stopGates: input.controllerInput.goalFrame.root.stopGates,
    recentEvents: input.recentEvents,
    openQuestions: fallback.contextPacket.openQuestions,
    actionClass: fallback.actionClass,
    tools: input.controllerInput.tools ?? [],
    ...(input.controllerInput.governance
      ? { governance: input.controllerInput.governance }
      : {}),
    recordStore: input.durableMemory.recordStore,
  });
  const memoryDrivenDecision = createMemoryDrivenController().decide({
    goalFrame: input.controllerInput.goalFrame,
    activeGoal: input.controllerInput.activeGoal ?? input.controllerInput.goalFrame.root,
    retrieval,
    ...(input.controllerInput.memory
      ? { memory: input.controllerInput.memory }
      : {}),
    ...(input.controllerInput.events
      ? { events: input.controllerInput.events }
      : {}),
    tools: input.controllerInput.tools ?? [],
    ...(input.controllerInput.governance
      ? { governance: input.controllerInput.governance }
      : {}),
    openQuestions: fallback.contextPacket.openQuestions,
    writebackExpectations: fallback.writeback,
  });

  if (
    memoryDrivenDecision.usedFirstRunFallback ||
    !hasUsefulDurableRetrieval(retrieval)
  ) {
    return {
      decision: fallback,
      retrieval,
      memoryDrivenDecision,
      usedMemoryDrivenController: false,
    };
  }

  return {
    decision: mergeMemoryDrivenDecision({
      fallback,
      memoryDrivenDecision,
      ...(input.controllerInput.memory
        ? { memory: input.controllerInput.memory }
        : {}),
    }),
    retrieval,
    memoryDrivenDecision,
    usedMemoryDrivenController: true,
  };
}

function updateDurableMemoryDecisionStats(
  stats: DurableMemoryStats,
  result: ReturnType<typeof decideWithRuntimeMemory>,
): void {
  if (result.retrieval) {
    stats.latestRetrievalCandidateCount = result.retrieval.candidates.length;
  }
  if (result.memoryDrivenDecision) {
    stats.usedFirstRunFallback = result.memoryDrivenDecision.usedFirstRunFallback;
    stats.latestContextPacketV2 = result.memoryDrivenDecision.contextPacketV2;
  }
  if (result.usedMemoryDrivenController) {
    stats.usedMemoryDrivenController = true;
    stats.usedFirstRunFallback = false;
  }
}

function hasUsefulDurableRetrieval(retrieval: MemoryRetrievalResult): boolean {
  return retrieval.candidates.some((candidate) => {
    const record = candidate.record;
    if (
      record.kind === "evidence" ||
      record.kind === "semantic_claim" ||
      record.kind === "hypothesis" ||
      record.kind === "finding" ||
      record.kind === "belief" ||
      record.kind === "procedure" ||
      record.kind === "prospective_check"
    ) {
      return true;
    }

    return (
      record.tags.includes("loop-result") ||
      record.tags.includes("visible-note") ||
      record.tags.includes("error") ||
      record.tags.includes("artifact")
    );
  });
}

function mergeMemoryDrivenDecision(input: {
  fallback: ResearchMemoryControllerDecision;
  memoryDrivenDecision: MemoryDrivenControllerDecision;
  memory?: Partial<ResearchMemorySnapshot>;
}): ResearchMemoryControllerDecision {
  const memory = input.memory ?? {};
  const contextPacket = {
    ...input.fallback.contextPacket,
    activeSubGoal: input.memoryDrivenDecision.subGoal,
    directEvidence: memory.directEvidence ?? input.fallback.contextPacket.directEvidence,
    priorObservations:
      memory.priorEpisodes ?? input.fallback.contextPacket.priorObservations,
    candidateProcedures:
      memory.candidateProcedures ?? input.fallback.contextPacket.candidateProcedures,
    currentHypotheses:
      memory.currentHypotheses ?? input.fallback.contextPacket.currentHypotheses,
    currentFindings:
      memory.currentFindings ?? input.fallback.contextPacket.currentFindings,
    contradictions:
      memory.contradictions ?? input.fallback.contextPacket.contradictions,
    userCommitments: mergeContextStrings([
      ...input.fallback.contextPacket.userCommitments,
      ...(memory.userCommitments ?? []),
      ...(memory.prospectiveCommitments ?? []),
    ]),
    toolBudget: input.memoryDrivenDecision.toolBudget,
    writebackExpectations: input.memoryDrivenDecision.writeback,
  };

  return {
    subGoal: input.memoryDrivenDecision.subGoal,
    actionClass: input.memoryDrivenDecision.actionClass,
    rationale: input.memoryDrivenDecision.rationale,
    actionScores: input.memoryDrivenDecision.actionScores,
    selectedSkills: input.fallback.selectedSkills,
    candidateToolActions: input.fallback.candidateToolActions,
    skippedToolActions: input.fallback.skippedToolActions,
    contextPacket,
    toolBudget: input.memoryDrivenDecision.toolBudget,
    completionGates: input.memoryDrivenDecision.completionGates,
    writeback: input.memoryDrivenDecision.writeback,
  };
}

function mergeContextStrings(values: readonly string[]): readonly string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
}

function finalizeDurableMemorySummary(
  durableMemory: DurableMemoryRuntime,
  stats: DurableMemoryStats,
): ResearchDurableMemoryRunSummary {
  const databasePath = "databasePath" in durableMemory.eventLog
    ? String(durableMemory.eventLog.databasePath)
    : undefined;

  return {
    enabled: true,
    ...(databasePath ? { databasePath } : {}),
    eventLogCount: durableMemory.eventLog.listAll().length,
    recordCount: durableMemory.recordStore.list().length,
    eventsAppended: stats.eventsAppended,
    recordsWritten: stats.recordsWritten,
    latestRetrievalCandidateCount: stats.latestRetrievalCandidateCount,
    usedMemoryDrivenController: stats.usedMemoryDrivenController,
    usedFirstRunFallback: stats.usedFirstRunFallback,
    ...(stats.latestContextPacketV2
      ? { latestContextPacketV2: stats.latestContextPacketV2 }
      : {}),
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
      selectedSkills: decision.selectedSkills.map(createSelectedSkillEventPayload),
      candidateToolActions: decision.candidateToolActions,
      skippedToolActions: decision.skippedToolActions,
      toolBudget: decision.toolBudget,
      writeback: decision.writeback,
    },
  };
}

function createContextCompiledEvent(
  goalId: string,
  decision: ResearchMemoryControllerDecision,
  storageLayout: ResearchStorageLayout,
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "context.compiled",
    timestamp: nowIso(),
    goalId,
    payload: {
      activeGoalId: decision.contextPacket.activeGoal.id,
      activeGoal: createGoalNodeEventPayload(decision.contextPacket.activeGoal),
      activeSubGoalId: decision.contextPacket.activeSubGoal.id,
      activeSubGoal: createSubGoalEventPayload(decision.contextPacket.activeSubGoal),
      evidenceRefs: decision.contextPacket.directEvidence.length,
      openQuestions: decision.contextPacket.openQuestions,
      selectedSkills: decision.contextPacket.selectedSkills.map(
        createSelectedSkillEventPayload,
      ),
      toolPermissions: decision.contextPacket.toolPermissions,
      candidateToolActions: decision.contextPacket.candidateToolActions,
      skippedToolActions: decision.contextPacket.skippedToolActions,
      storage: storageLayout,
    },
  };
}

function createGoalNodeEventPayload(
  goal: ResearchGoalNode,
): Record<string, unknown> {
  return {
    id: goal.id,
    ...(goal.parentId ? { parentId: goal.parentId } : {}),
    status: goal.status,
    objective: goal.objective,
    ...(goal.rationale ? { rationale: goal.rationale } : {}),
    completionGates: goal.completionGates,
    stopGates: goal.stopGates,
    ...(goal.actionClass ? { actionClass: goal.actionClass } : {}),
    expectedArtifacts: goal.expectedArtifacts,
    ...(goal.resultSummary ? { resultSummary: goal.resultSummary } : {}),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function createSubGoalEventPayload(
  subGoal: ResearchSubGoal,
): Record<string, unknown> {
  return {
    id: subGoal.id,
    parentGoalId: subGoal.parentGoalId,
    objective: subGoal.objective,
    rationale: subGoal.rationale,
    actionClass: subGoal.actionClass,
    completionGates: subGoal.completionGates,
    expectedArtifacts: subGoal.expectedArtifacts,
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
      selectedSkills: loopPlan.contextPacket.selectedSkills.map(
        createSelectedSkillEventPayload,
      ),
      candidateToolActions: loopPlan.candidateToolActions,
      skippedToolActions: loopPlan.skippedToolActions,
      actionBudget: loopPlan.actionBudget,
      expectedArtifacts: loopPlan.expectedArtifacts,
      writebackRequirements: loopPlan.writebackRequirements,
    },
  };
}

function createSelectedSkillEventPayload(skill: ResearchSelectedSkill): {
  id: string;
  version?: string;
  selectionReasons: readonly string[];
} {
  return {
    id: skill.id,
    ...(skill.version ? { version: skill.version } : {}),
    selectionReasons: skill.selectionReasons,
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
