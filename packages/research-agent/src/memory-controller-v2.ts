import { compileContextPacketV2 } from "./context-packet-v2.js";
import { createId } from "./ids.js";
import { createFirstRunMemoryController } from "./memory-controller.js";
import type {
  MemoryRetrievalCandidate,
  MemoryRetrievalResult,
} from "./memory-retriever.js";
import type {
  ResearchActionClass,
  ResearchActionScore,
  ResearchCompletionGate,
  ResearchContextPacket,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchGoalFrame,
  ResearchGoalNode,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
  ResearchSubGoal,
  ResearchToolBudget,
  ResearchToolDescriptor,
} from "./types.js";
import type { ResearchContextPacketV2 } from "./context-packet-v2.js";

const DEFAULT_WRITEBACK = ["event", "working", "episodic"] as const;

export interface MemoryDrivenControllerInput {
  goalFrame: ResearchGoalFrame;
  activeGoal?: ResearchGoalNode;
  retrieval?: MemoryRetrievalResult;
  memory?: Partial<ResearchMemorySnapshot>;
  events?: readonly ResearchEvent[];
  tools?: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  openQuestions?: readonly string[];
  writebackExpectations?: readonly ResearchMemoryStoreKind[];
}

export interface MemoryDrivenControllerDecision {
  subGoal: ResearchSubGoal;
  actionClass: ResearchActionClass;
  rationale: string;
  actionScores: readonly ResearchActionScore[];
  contextPacket?: ResearchContextPacket;
  contextPacketV2: ResearchContextPacketV2;
  toolBudget: ResearchToolBudget;
  completionGates: readonly ResearchCompletionGate[];
  writeback: readonly ResearchMemoryStoreKind[];
  supportingRecordIds: readonly string[];
  warnings: readonly string[];
  usedFirstRunFallback: boolean;
}

export class MemoryDrivenController {
  decide(input: MemoryDrivenControllerInput): MemoryDrivenControllerDecision {
    const retrieval = input.retrieval ?? createEmptyRetrieval();
    const tools = input.tools ?? [];
    const activeGoal = input.activeGoal ?? input.goalFrame.root;

    if (retrieval.candidates.length === 0) {
      return this.createFallbackDecision(input, activeGoal, retrieval, tools);
    }

    const actionScores = scoreMemoryDrivenActions({
      goalFrame: input.goalFrame,
      activeGoal,
      retrieval,
      tools,
      governance: input.governance,
    });
    const actionClass = actionScores[0]?.actionClass ?? "synthesize";
    const supportingCandidates = selectSupportingCandidates(actionClass, retrieval);
    const subGoal = createMemoryDrivenSubGoal({
      activeGoal,
      actionClass,
      supportingCandidates,
    });
    const completionGates = createSubGoalGates(actionClass, activeGoal, retrieval);
    const toolBudget = createToolBudget(input.governance, tools);
    const contextPacketV2 = compileContextPacketV2({
      goalFrame: input.goalFrame,
      activeGoal,
      activeSubGoal: subGoal,
      retrieval,
      tools,
      ...(input.governance ? { governance: input.governance } : {}),
      actionClass,
      openQuestions: input.openQuestions ?? [],
      writebackExpectations: input.writebackExpectations ?? DEFAULT_WRITEBACK,
    });

    return {
      subGoal,
      actionClass,
      rationale: createDecisionRationale(actionClass, supportingCandidates),
      actionScores,
      contextPacketV2,
      toolBudget,
      completionGates,
      writeback: input.writebackExpectations ?? DEFAULT_WRITEBACK,
      supportingRecordIds: supportingCandidates.map(
        (candidate) => candidate.record.id,
      ),
      warnings: [
        ...new Set(supportingCandidates.flatMap((candidate) => candidate.warnings)),
      ],
      usedFirstRunFallback: false,
    };
  }

  private createFallbackDecision(
    input: MemoryDrivenControllerInput,
    activeGoal: ResearchGoalNode,
    retrieval: MemoryRetrievalResult,
    tools: readonly ResearchToolDescriptor[],
  ): MemoryDrivenControllerDecision {
    const fallback = createFirstRunMemoryController().decide({
      goalFrame: input.goalFrame,
      activeGoal,
      ...(input.memory ? { memory: input.memory } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
    });
    const contextPacketV2 = compileContextPacketV2({
      goalFrame: input.goalFrame,
      activeGoal,
      activeSubGoal: fallback.subGoal,
      retrieval,
      tools,
      ...(input.governance ? { governance: input.governance } : {}),
      actionClass: fallback.actionClass,
      openQuestions: fallback.contextPacket.openQuestions,
      userCommitments: fallback.contextPacket.userCommitments,
      writebackExpectations: fallback.writeback,
    });

    return {
      subGoal: fallback.subGoal,
      actionClass: fallback.actionClass,
      rationale: `First-run fallback: ${fallback.rationale}`,
      actionScores: fallback.actionScores,
      contextPacket: fallback.contextPacket,
      contextPacketV2,
      toolBudget: fallback.toolBudget,
      completionGates: fallback.completionGates,
      writeback: fallback.writeback,
      supportingRecordIds: [],
      warnings: [],
      usedFirstRunFallback: true,
    };
  }
}

export function createMemoryDrivenController(): MemoryDrivenController {
  return new MemoryDrivenController();
}

function scoreMemoryDrivenActions(input: {
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  retrieval: MemoryRetrievalResult;
  tools: readonly ResearchToolDescriptor[];
  governance: ResearchGovernancePolicy | undefined;
}): ResearchActionScore[] {
  const scores: ResearchActionScore[] = [];
  const securitySensitive = input.goalFrame.riskFlags.some((flag) =>
    /security|vulnerability|exploit|rce|sandbox|privilege/i.test(flag),
  );
  const hasScope = input.goalFrame.scopeConstraints.length > 0;

  addScore(scores, "ask_user", securitySensitive && !hasScope ? 100 : 0,
    securitySensitive && !hasScope
      ? "Security-sensitive work still needs explicit scope."
      : "No blocking user clarification was inferred from memory.");

  addScore(scores, "stop", stopGateTriggered(input) ? 100 : 0,
    "A stop gate is supported by retrieved memory.");
  addScore(scores, "respond",
    completionGatesSatisfied(input) &&
      !(
        needsMoreDirectEvidence(input.retrieval) &&
        supportsAction(input.tools, "inspect", input.governance)
      )
      ? 95
      : 0,
    "Retrieved memory supports all root completion gates.");
  addScore(scores, "inspect",
    needsMoreDirectEvidence(input.retrieval) &&
      supportsAction(input.tools, "inspect", input.governance)
      ? 85
      : 0,
    "Direct evidence is missing and inspect-capable tools are available.");
  addScore(scores, "experiment",
    hasWeakHypothesis(input.retrieval) &&
      supportsAction(input.tools, "experiment", input.governance)
      ? 75
      : 0,
    "A weak hypothesis has evidence links and experiment-capable tools are available.");
  addScore(scores, "analyze",
    hasWeakHypothesis(input.retrieval) || input.retrieval.contradictions.length > 0
      ? 70
      : 0,
    "Retrieved claims or hypotheses need analysis before synthesis.");
  addScore(scores, "synthesize",
    input.retrieval.directEvidence.length > 0 ? 60 : 20,
    "Retrieved memory can be synthesized into the next goal update.");
  addScore(scores, "recall", 25,
    "Memory has already been retrieved; recall remains a low-priority continuation.");

  return scores
    .filter((score) => score.score > 0 && isAllowed(score.actionClass, input.governance))
    .sort((left, right) => right.score - left.score);
}

function addScore(
  scores: ResearchActionScore[],
  actionClass: ResearchActionClass,
  score: number,
  rationale: string,
) {
  scores.push({ actionClass, score, rationale });
}

function stopGateTriggered(input: {
  activeGoal: ResearchGoalNode;
  retrieval: MemoryRetrievalResult;
}): boolean {
  return input.activeGoal.stopGates.some((gate) =>
    input.retrieval.candidates.some((candidate) =>
      stopCandidateMatchesGate(candidate, gate, input.activeGoal),
    ),
  );
}

function completionGatesSatisfied(input: {
  activeGoal: ResearchGoalNode;
  retrieval: MemoryRetrievalResult;
}): boolean {
  return (
    input.activeGoal.completionGates.length > 0 &&
    input.activeGoal.completionGates.every((gate) =>
      input.retrieval.candidates.some((candidate) =>
        candidateMatchesGate(candidate, gate),
      ),
    )
  );
}

function candidateMatchesGate(
  candidate: MemoryRetrievalCandidate,
  gate: ResearchCompletionGate,
): boolean {
  const gateTokens = new Set(tokenize(gate.description));
  const candidateTokens = new Set(tokenize(candidate.record.summary));
  let overlap = 0;

  for (const token of gateTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap >= Math.min(2, gateTokens.size);
}

function stopCandidateMatchesGate(
  candidate: MemoryRetrievalCandidate,
  gate: ResearchCompletionGate,
  activeGoal: ResearchGoalNode,
): boolean {
  const summary = candidate.record.summary.toLowerCase();
  const sameGoal =
    !candidate.record.goalId || candidate.record.goalId === activeGoal.id;
  const hardBoundarySignal =
    /\b(outside|out-of|unsafe|unauthorized|forbidden|denied|policy|scope)\b/.test(
      summary,
    );
  const explicitStopSignal =
    /\bstop|stopped|halt|halted|triggered\b/.test(summary) ||
    (/\bblocked\b/.test(summary) && hardBoundarySignal) ||
    candidate.record.tags.includes("contradiction") ||
    candidate.record.tags.includes("uncertainty");

  return (
    explicitStopSignal &&
    (sameGoal || hardBoundarySignal) &&
    candidateMatchesGate(candidate, gate)
  );
}

function hasWeakHypothesis(retrieval: MemoryRetrievalResult): boolean {
  return retrieval.candidates.some(
    (candidate) =>
      (candidate.record.kind === "semantic_claim" ||
        candidate.record.kind === "hypothesis") &&
      (candidate.warnings.length > 0 ||
        candidate.record.status === "candidate" ||
        (candidate.record.confidence ?? 1) < 0.7),
  );
}

function needsMoreDirectEvidence(retrieval: MemoryRetrievalResult): boolean {
  return (
    retrieval.directEvidence.length === 0 ||
    retrieval.directEvidence.every((candidate) =>
      isRecoverableEvidenceGap(candidate),
    )
  );
}

function isRecoverableEvidenceGap(candidate: MemoryRetrievalCandidate): boolean {
  const summary = candidate.record.summary.toLowerCase();
  return /\b(enoent|eisdir|failed|blocked|unavailable|does not support|no direct|directory|path layout)\b/.test(
    summary,
  );
}

function selectSupportingCandidates(
  actionClass: ResearchActionClass,
  retrieval: MemoryRetrievalResult,
): readonly MemoryRetrievalCandidate[] {
  if (actionClass === "stop") {
    return retrieval.candidates.slice(0, 3);
  }
  if (actionClass === "respond" || actionClass === "synthesize") {
    return retrieval.candidates.slice(0, 5);
  }
  if (actionClass === "experiment" || actionClass === "analyze") {
    return [
      ...retrieval.contradictions,
      ...retrieval.candidates.filter(
        (candidate) =>
          candidate.record.kind === "semantic_claim" ||
          candidate.record.kind === "hypothesis",
      ),
    ].slice(0, 5);
  }
  if (actionClass === "inspect") {
    return retrieval.directEvidence.slice(0, 3);
  }

  return retrieval.candidates.slice(0, 3);
}

function createMemoryDrivenSubGoal(input: {
  activeGoal: ResearchGoalNode;
  actionClass: ResearchActionClass;
  supportingCandidates: readonly MemoryRetrievalCandidate[];
}): ResearchSubGoal {
  const objective =
    findNextWalkObjective(input.supportingCandidates) ??
    createSubGoalObjective(input.actionClass, input.activeGoal.objective);

  return {
    id: createId("subgoal"),
    parentGoalId: input.activeGoal.id,
    objective,
    rationale: createSubGoalRationale(input.actionClass, input.supportingCandidates),
    actionClass: input.actionClass,
    completionGates: [],
    expectedArtifacts: createExpectedArtifacts(input.actionClass),
  };
}

function findNextWalkObjective(
  candidates: readonly MemoryRetrievalCandidate[],
): string | undefined {
  const walkCandidate = candidates.find((candidate) =>
    /^walk\s+/i.test(candidate.record.summary),
  );

  return walkCandidate?.record.summary;
}

function createSubGoalObjective(
  actionClass: ResearchActionClass,
  rootObjective: string,
): string {
  switch (actionClass) {
    case "stop":
      return `Stop work on: ${rootObjective}`;
    case "respond":
      return `Prepare a memory-supported response for: ${rootObjective}`;
    case "inspect":
      return `Gather direct evidence for: ${rootObjective}`;
    case "analyze":
      return `Analyze retrieved evidence and weak claims for: ${rootObjective}`;
    case "experiment":
      return `Test the current hypothesis for: ${rootObjective}`;
    case "ask_user":
      return `Confirm missing scope before pursuing: ${rootObjective}`;
    case "recall":
      return `Refresh relevant memory for: ${rootObjective}`;
    case "search":
      return `Gather external evidence for: ${rootObjective}`;
    case "synthesize":
      return `Synthesize memory-backed progress for: ${rootObjective}`;
  }
}

function createSubGoalRationale(
  actionClass: ResearchActionClass,
  supportingCandidates: readonly MemoryRetrievalCandidate[],
): string {
  const refs = supportingCandidates.map((candidate) => candidate.record.id);
  const suffix = refs.length > 0 ? ` Supporting records: ${refs.join(", ")}.` : "";

  return `${actionClass} selected from retrieved memory, goal gates, and available tools.${suffix}`;
}

function createDecisionRationale(
  actionClass: ResearchActionClass,
  supportingCandidates: readonly MemoryRetrievalCandidate[],
): string {
  const reasons = supportingCandidates
    .flatMap((candidate) => candidate.reasons)
    .slice(0, 3);

  return [
    `Selected ${actionClass} from scored memory retrieval.`,
    reasons.length > 0 ? `Top reasons: ${reasons.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function createSubGoalGates(
  actionClass: ResearchActionClass,
  activeGoal: ResearchGoalNode,
  retrieval: MemoryRetrievalResult,
): ResearchCompletionGate[] {
  const description =
    actionClass === "stop"
      ? "The stop condition has been surfaced from memory."
      : actionClass === "respond"
        ? "The response is backed by retrieved memory and goal gates."
        : "The memory-driven bounded step has been completed or produced new evidence.";

  return [
    {
      id: createId("gate"),
      description,
      polarity: actionClass === "stop" ? "stop" : "success",
      evidenceEventIds: retrieval.candidates
        .flatMap((candidate) => candidate.record.sourceEventIds)
        .slice(0, 5),
    },
    ...activeGoal.completionGates.slice(0, 2),
  ];
}

function createExpectedArtifacts(
  actionClass: ResearchActionClass,
): readonly string[] {
  if (actionClass === "stop") {
    return ["stop rationale"];
  }
  if (actionClass === "respond") {
    return ["memory-supported response"];
  }
  if (actionClass === "inspect" || actionClass === "search") {
    return ["evidence notes", "candidate claims"];
  }
  if (actionClass === "experiment") {
    return ["experiment result", "hypothesis update"];
  }

  return ["memory analysis notes", "goal update"];
}

function supportsAction(
  tools: readonly ResearchToolDescriptor[],
  actionClass: ResearchActionClass,
  governance: ResearchGovernancePolicy | undefined,
): boolean {
  return (
    isAllowed(actionClass, governance) &&
    tools.some((tool) => tool.actionClasses.includes(actionClass))
  );
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

function createEmptyRetrieval(): MemoryRetrievalResult {
  return {
    candidates: [],
    directEvidence: [],
    contradictions: [],
    procedures: [],
    prospectiveChecks: [],
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}
