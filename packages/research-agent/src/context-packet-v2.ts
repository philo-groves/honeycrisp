import type {
  MemoryRetrievalCandidate,
  MemoryRetrievalResult,
} from "./memory-retriever.js";
import type {
  ResearchActionClass,
  ResearchDerivedMemoryRecord,
  ResearchGovernancePolicy,
  ResearchGoalFrame,
  ResearchGoalNode,
  ResearchMemoryStoreKind,
  ResearchSubGoal,
  ResearchToolBudget,
  ResearchToolDescriptor,
  ResearchToolPermission,
} from "./types.js";

export type ResearchContextPacketV2SectionLabel =
  | "direct_evidence"
  | "prior_episodes"
  | "candidate_procedures"
  | "current_hypotheses"
  | "contradictions_uncertainty"
  | "prospective_commitments";

export type ResearchContextPacketV2ItemLabel =
  | "direct_evidence"
  | "episode"
  | "procedure"
  | "inference"
  | "hypothesis"
  | "belief"
  | "uncertainty"
  | "prospective_check";

export interface ResearchContextPacketV2Item {
  recordId: string;
  recordKind: ResearchDerivedMemoryRecord["kind"];
  status: ResearchDerivedMemoryRecord["status"];
  label: ResearchContextPacketV2ItemLabel;
  summary: string;
  score: number;
  confidence?: number;
  sourceEventIds: readonly string[];
  selectionReasons: readonly string[];
  warnings: readonly string[];
  estimatedTokens: number;
}

export interface ResearchContextPacketV2Section {
  label: ResearchContextPacketV2SectionLabel;
  tokenBudget: number;
  estimatedTokens: number;
  items: readonly ResearchContextPacketV2Item[];
  droppedRecordIds: readonly string[];
}

export interface ResearchContextPacketV2 {
  schemaVersion: 2;
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  activeSubGoal: ResearchSubGoal;
  actionClass?: ResearchActionClass;
  preconsciousCandidateCount: number;
  sections: readonly ResearchContextPacketV2Section[];
  openQuestions: readonly string[];
  userCommitments: readonly string[];
  toolPermissions: readonly ResearchToolPermission[];
  toolBudget: ResearchToolBudget;
  writebackExpectations: readonly ResearchMemoryStoreKind[];
}

export interface CompileContextPacketV2Input {
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  activeSubGoal: ResearchSubGoal;
  retrieval: MemoryRetrievalResult;
  tools: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  actionClass?: ResearchActionClass;
  openQuestions?: readonly string[];
  userCommitments?: readonly string[];
  writebackExpectations?: readonly ResearchMemoryStoreKind[];
  sectionTokenBudgets?: Partial<Record<ResearchContextPacketV2SectionLabel, number>>;
}

const DEFAULT_SECTION_TOKEN_BUDGETS: Record<
  ResearchContextPacketV2SectionLabel,
  number
> = {
  direct_evidence: 220,
  prior_episodes: 180,
  candidate_procedures: 160,
  current_hypotheses: 180,
  contradictions_uncertainty: 160,
  prospective_commitments: 120,
};

export function compileContextPacketV2(
  input: CompileContextPacketV2Input,
): ResearchContextPacketV2 {
  const sectionBudgets = {
    ...DEFAULT_SECTION_TOKEN_BUDGETS,
    ...(input.sectionTokenBudgets ?? {}),
  };
  const sections: ResearchContextPacketV2Section[] = [
    compileSection(
      "direct_evidence",
      input.retrieval.directEvidence,
      sectionBudgets.direct_evidence,
    ),
    compileSection(
      "prior_episodes",
      input.retrieval.candidates.filter((candidate) =>
        isPriorEpisodeCandidate(candidate),
      ),
      sectionBudgets.prior_episodes,
    ),
    compileSection(
      "candidate_procedures",
      input.retrieval.procedures,
      sectionBudgets.candidate_procedures,
    ),
    compileSection(
      "current_hypotheses",
      input.retrieval.candidates.filter((candidate) =>
        isCurrentHypothesisCandidate(candidate),
      ),
      sectionBudgets.current_hypotheses,
    ),
    compileSection(
      "contradictions_uncertainty",
      input.retrieval.contradictions,
      sectionBudgets.contradictions_uncertainty,
      { includeAtLeastOne: input.retrieval.contradictions.length > 0 },
    ),
    compileSection(
      "prospective_commitments",
      input.retrieval.prospectiveChecks,
      sectionBudgets.prospective_commitments,
    ),
  ];

  return {
    schemaVersion: 2,
    goalFrame: input.goalFrame,
    activeGoal: input.activeGoal,
    activeSubGoal: input.activeSubGoal,
    ...(input.actionClass ? { actionClass: input.actionClass } : {}),
    preconsciousCandidateCount: input.retrieval.candidates.length,
    sections,
    openQuestions: input.openQuestions ?? [],
    userCommitments: [
      ...input.goalFrame.scopeConstraints,
      ...input.goalFrame.userPreferences,
      ...(input.userCommitments ?? []),
    ],
    toolPermissions: createToolPermissions(input.tools, input.governance),
    toolBudget: createToolBudget(input.governance, input.tools),
    writebackExpectations: input.writebackExpectations ?? [
      "event",
      "working",
      "episodic",
    ],
  };
}

function compileSection(
  label: ResearchContextPacketV2SectionLabel,
  candidates: readonly MemoryRetrievalCandidate[],
  tokenBudget: number,
  options: {
    includeAtLeastOne?: boolean;
  } = {},
): ResearchContextPacketV2Section {
  const items: ResearchContextPacketV2Item[] = [];
  const droppedRecordIds: string[] = [];
  let usedTokens = 0;

  for (const candidate of candidates) {
    const remaining = Math.max(0, tokenBudget - usedTokens);
    const allowOverflowFirst =
      options.includeAtLeastOne === true && items.length === 0;
    if (remaining === 0 && !allowOverflowFirst) {
      droppedRecordIds.push(candidate.record.id);
      continue;
    }

    const item = createItem(candidate, remaining || tokenBudget);
    if (
      usedTokens + item.estimatedTokens <= tokenBudget ||
      allowOverflowFirst
    ) {
      items.push(item);
      usedTokens = Math.min(tokenBudget, usedTokens + item.estimatedTokens);
    } else {
      droppedRecordIds.push(candidate.record.id);
    }
  }

  return {
    label,
    tokenBudget,
    estimatedTokens: usedTokens,
    items,
    droppedRecordIds,
  };
}

function createItem(
  candidate: MemoryRetrievalCandidate,
  remainingTokens: number,
): ResearchContextPacketV2Item {
  const summary = truncateToTokenBudget(candidate.record.summary, remainingTokens);
  const item: ResearchContextPacketV2Item = {
    recordId: candidate.record.id,
    recordKind: candidate.record.kind,
    status: candidate.record.status,
    label: labelRecord(candidate.record),
    summary,
    score: candidate.score,
    sourceEventIds: candidate.record.sourceEventIds,
    selectionReasons: candidate.reasons,
    warnings: candidate.warnings,
    estimatedTokens: estimateTokens(summary),
  };

  return {
    ...item,
    ...(typeof candidate.record.confidence === "number"
      ? { confidence: candidate.record.confidence }
      : {}),
  };
}

function labelRecord(
  record: ResearchDerivedMemoryRecord,
): ResearchContextPacketV2ItemLabel {
  if (
    record.status === "contradicted" ||
    record.tags.includes("contradiction") ||
    record.tags.includes("uncertainty")
  ) {
    return "uncertainty";
  }
  switch (record.kind) {
    case "evidence":
      return "direct_evidence";
    case "episodic":
    case "working":
      return "episode";
    case "procedure":
      return "procedure";
    case "semantic_claim":
      return "inference";
    case "hypothesis":
      return "hypothesis";
    case "belief":
      return "belief";
    case "prospective_check":
      return "prospective_check";
  }
}

function isPriorEpisodeCandidate(candidate: MemoryRetrievalCandidate): boolean {
  return (
    candidate.record.kind === "episodic" || candidate.record.kind === "working"
  );
}

function isCurrentHypothesisCandidate(
  candidate: MemoryRetrievalCandidate,
): boolean {
  return (
    candidate.record.kind === "semantic_claim" ||
    candidate.record.kind === "hypothesis" ||
    candidate.record.kind === "belief"
  );
}

function truncateToTokenBudget(value: string, tokenBudget: number): string {
  const maxChars = Math.max(12, tokenBudget * 4);
  if (estimateTokens(value) <= tokenBudget) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function createToolPermissions(
  tools: readonly ResearchToolDescriptor[],
  governance: ResearchGovernancePolicy | undefined,
): ResearchToolPermission[] {
  return tools
    .map((tool) => ({
      toolName: tool.name,
      actionClasses: tool.actionClasses.filter((actionClass) => {
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
      }),
      sideEffects: tool.sideEffects,
      requiredPermissions: tool.requiredPermissions,
    }))
    .filter((tool) => tool.actionClasses.length > 0);
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
