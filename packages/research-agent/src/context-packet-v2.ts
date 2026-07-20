import type {
  MemoryRetrievalCandidate,
  MemoryRetrievalResult,
} from "./memory-retriever.js";
import type {
  ResearchActionClass,
  ResearchDerivedMemoryRecord,
  ResearchGovernancePolicy,
  ResearchMemoryStoreKind,
  ResearchProofAttempt,
  ResearchProofObligation,
  ResearchProofStateReadModel,
  ResearchToolBudget,
  ResearchToolDescriptor,
  ResearchToolPermission,
  ResearchWorkspaceContext,
} from "./types.js";

export type ResearchContextPacketV2SectionLabel =
  | "workspace_context"
  | "direct_evidence"
  | "prior_episodes"
  | "candidate_procedures"
  | "current_hypotheses"
  | "current_findings"
  | "proof_state"
  | "contradictions_uncertainty"
  | "prospective_commitments";

export type ResearchContextPacketV2ItemLabel =
  | "workspace_context"
  | "direct_evidence"
  | "episode"
  | "procedure"
  | "inference"
  | "hypothesis"
  | "finding"
  | "proof_obligation"
  | "proof_attempt"
  | "belief"
  | "uncertainty"
  | "prospective_check";

export interface ResearchContextPacketV2Item {
  recordId: string;
  recordKind:
    | ResearchDerivedMemoryRecord["kind"]
    | "proof_obligation"
    | "proof_attempt"
    | "workspace_context";
  status:
    | ResearchDerivedMemoryRecord["status"]
    | ResearchProofObligation["status"]
    | ResearchProofAttempt["status"];
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
  prompt?: string;
  workspaceContext?: ResearchWorkspaceContext;
  actionClass?: ResearchActionClass;
  preconsciousCandidateCount: number;
  tokenBudget: number;
  estimatedTokens: number;
  compaction: {
    reason: "context_token_budget_exceeded" | "not_needed";
    acceptedTokenBudget: number;
    estimatedTokensBeforeCompaction: number;
    estimatedTokensAfterCompaction: number;
    removedRecordIds: readonly string[];
    removedTokenCount: number;
  };
  sections: readonly ResearchContextPacketV2Section[];
  openQuestions: readonly string[];
  userCommitments: readonly string[];
  toolPermissions: readonly ResearchToolPermission[];
  toolBudget: ResearchToolBudget;
  writebackExpectations: readonly ResearchMemoryStoreKind[];
}

export interface CompileContextPacketV2Input {
  prompt?: string;
  workspaceContext?: ResearchWorkspaceContext;
  retrieval: MemoryRetrievalResult;
  proofState?: ResearchProofStateReadModel;
  tools: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  actionClass?: ResearchActionClass;
  openQuestions?: readonly string[];
  userCommitments?: readonly string[];
  writebackExpectations?: readonly ResearchMemoryStoreKind[];
  sectionTokenBudgets?: Partial<Record<ResearchContextPacketV2SectionLabel, number>>;
  contextTokenBudget?: number;
}

const DEFAULT_SECTION_TOKEN_BUDGETS: Record<
  ResearchContextPacketV2SectionLabel,
  number
> = {
  workspace_context: 160,
  direct_evidence: 220,
  prior_episodes: 180,
  candidate_procedures: 160,
  current_hypotheses: 180,
  current_findings: 180,
  proof_state: 180,
  contradictions_uncertainty: 160,
  prospective_commitments: 120,
};
const DEFAULT_CONTEXT_TOKEN_BUDGET = 960;

export function compileContextPacketV2(
  input: CompileContextPacketV2Input,
): ResearchContextPacketV2 {
  const sectionBudgets = {
    ...DEFAULT_SECTION_TOKEN_BUDGETS,
    ...(input.sectionTokenBudgets ?? {}),
  };
  const directEvidenceCandidates = input.retrieval.directEvidence;
  const priorEpisodeCandidates = input.retrieval.candidates.filter(
    (candidate) => isPriorEpisodeCandidate(candidate),
  );
  const compiledSections: ResearchContextPacketV2Section[] = [
    compileWorkspaceSection(
      input.workspaceContext,
      sectionBudgets.workspace_context,
    ),
    compileSection(
      "direct_evidence",
      directEvidenceCandidates,
      sectionBudgets.direct_evidence,
    ),
    compileSection(
      "prior_episodes",
      priorEpisodeCandidates,
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
      "current_findings",
      input.retrieval.findings,
      sectionBudgets.current_findings,
    ),
    compileProofSection(
      input.proofState ?? { obligations: [], attempts: [] },
      sectionBudgets.proof_state,
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
  const acceptedTokenBudget =
    positiveInteger(input.contextTokenBudget) ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const compacted = compactSectionsToTokenBudget(
    compiledSections,
    acceptedTokenBudget,
  );

  return {
    schemaVersion: 2,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.workspaceContext
      ? { workspaceContext: input.workspaceContext }
      : {}),
    ...(input.actionClass ? { actionClass: input.actionClass } : {}),
    preconsciousCandidateCount: input.retrieval.candidates.length,
    tokenBudget: acceptedTokenBudget,
    estimatedTokens: compacted.estimatedTokensAfterCompaction,
    compaction: compacted.compaction,
    sections: compacted.sections,
    openQuestions: input.openQuestions ?? [],
    userCommitments: input.userCommitments ?? [],
    toolPermissions: createToolPermissions(input.tools, input.governance),
    toolBudget: createToolBudget(input.governance, input.tools),
    writebackExpectations: input.writebackExpectations ?? [
      "event",
      "working",
      "episodic",
    ],
  };
}

function compileWorkspaceSection(
  workspaceContext: ResearchWorkspaceContext | undefined,
  tokenBudget: number,
): ResearchContextPacketV2Section {
  if (!workspaceContext) {
    return {
      label: "workspace_context",
      tokenBudget,
      estimatedTokens: 0,
      items: [],
      droppedRecordIds: [],
    };
  }

  const summary = truncateToTokenBudget(
    [
      `workspace=${workspaceContext.workspaceRoot}`,
      `memory_db=${workspaceContext.memory.databasePath}`,
      `storage_root=${workspaceContext.memory.rootPath}`,
      `artifact_dir=${workspaceContext.memory.artifactDirectoryPath}`,
      workspaceContext.authorization?.recorded
        ? `authorization=recorded source=${workspaceContext.authorization.source}` +
          (workspaceContext.authorization.scopeName
            ? ` scope=${workspaceContext.authorization.scopeName}`
            : "") +
          (workspaceContext.authorization.networkProfile
            ? ` network=${workspaceContext.authorization.networkProfile}`
            : "")
        : "",
      workspaceContext.knownRepositories.length > 0
        ? `repositories=${workspaceContext.knownRepositories
            .map((repository) => repository.rootPath)
            .join(",")}`
        : "",
      workspaceContext.materializedSourcePaths.length > 0
        ? `source_paths=${workspaceContext.materializedSourcePaths.join(",")}`
        : "",
      workspaceContext.projectNotes.length > 0
        ? `notes=${workspaceContext.projectNotes.join(" | ")}`
        : "",
      workspaceContext.memory.rules.length > 0
        ? `storage_rules=${workspaceContext.memory.rules.join(" ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    tokenBudget,
  );
  const item: ResearchContextPacketV2Item = {
    recordId: `workspace:${workspaceContext.workspaceRoot}`,
    recordKind: "workspace_context",
    status: "active",
    label: "workspace_context",
    summary,
    score: 95,
    sourceEventIds: [],
    selectionReasons: [
      "Workspace context is operator-provided run context, not semantic memory.",
      "Repository and source paths are discoverability hints and persistence locations.",
    ],
    warnings: [],
    estimatedTokens: estimateTokens(summary),
  };

  return {
    label: "workspace_context",
    tokenBudget,
    estimatedTokens: item.estimatedTokens,
    items: [item],
    droppedRecordIds: [],
  };
}

function compileProofSection(
  proofState: ResearchProofStateReadModel,
  tokenBudget: number,
): ResearchContextPacketV2Section {
  const items = [
    ...proofState.obligations.map(createProofObligationItem),
    ...proofState.attempts.map(createProofAttemptItem),
  ].sort((left, right) => right.score - left.score);
  const kept: ResearchContextPacketV2Item[] = [];
  const droppedRecordIds: string[] = [];
  let usedTokens = 0;

  for (const item of items) {
    if (usedTokens + item.estimatedTokens > tokenBudget) {
      droppedRecordIds.push(item.recordId);
      continue;
    }
    kept.push(item);
    usedTokens += item.estimatedTokens;
  }

  return {
    label: "proof_state",
    tokenBudget,
    estimatedTokens: usedTokens,
    items: kept,
    droppedRecordIds,
  };
}

function createProofObligationItem(
  obligation: ResearchProofObligation,
): ResearchContextPacketV2Item {
  const summary = [
    obligation.question,
    `subject=${obligation.subject.kind}:${obligation.subject.id}`,
    obligation.findingRecordIds.length > 0
      ? `findings=${obligation.findingRecordIds.join(",")}`
      : "",
  ].filter(Boolean).join(" ");

  return {
    recordId: obligation.id,
    recordKind: "proof_obligation",
    status: obligation.status,
    label: "proof_obligation",
    summary,
    score: scoreProofObligation(obligation),
    sourceEventIds: [],
    selectionReasons: [`Proof obligation status is ${obligation.status}.`],
    warnings: obligation.status === "failed" ? ["Proof obligation failed."] : [],
    estimatedTokens: estimateTokens(summary),
  };
}

function createProofAttemptItem(
  attempt: ResearchProofAttempt,
): ResearchContextPacketV2Item {
  const summary = [
    attempt.summary,
    `method=${attempt.method.kind}`,
    attempt.result ? `result=${attempt.result}` : "",
  ].filter(Boolean).join(" ");

  return {
    recordId: attempt.id,
    recordKind: "proof_attempt",
    status: attempt.status,
    label: "proof_attempt",
    summary,
    score: scoreProofAttempt(attempt),
    sourceEventIds: attempt.sourceEventIds,
    selectionReasons: [`Proof attempt status is ${attempt.status}.`],
    warnings: attempt.result === "fail" ? ["Proof attempt failed."] : [],
    estimatedTokens: estimateTokens(summary),
  };
}

function compactSectionsToTokenBudget(
  sections: readonly ResearchContextPacketV2Section[],
  acceptedTokenBudget: number,
): {
  sections: ResearchContextPacketV2Section[];
  estimatedTokensAfterCompaction: number;
  compaction: ResearchContextPacketV2["compaction"];
} {
  const estimatedTokensBeforeCompaction = totalSectionTokens(sections);
  if (estimatedTokensBeforeCompaction <= acceptedTokenBudget) {
    return {
      sections: sections.map(cloneSection),
      estimatedTokensAfterCompaction: estimatedTokensBeforeCompaction,
      compaction: {
        reason: "not_needed",
        acceptedTokenBudget,
        estimatedTokensBeforeCompaction,
        estimatedTokensAfterCompaction: estimatedTokensBeforeCompaction,
        removedRecordIds: [],
        removedTokenCount: 0,
      },
    };
  }

  const removeIds = new Set<string>();
  let currentTokens = estimatedTokensBeforeCompaction;
  const removableItems = sections
    .flatMap((section, sectionIndex) =>
      section.items.map((item, itemIndex) => ({
        sectionIndex,
        itemIndex,
        item,
      })),
    )
    .sort((left, right) =>
      left.item.score - right.item.score ||
      (left.item.confidence ?? 0) - (right.item.confidence ?? 0) ||
      right.item.estimatedTokens - left.item.estimatedTokens ||
      right.item.recordId.localeCompare(left.item.recordId),
    );

  for (const removable of removableItems) {
    if (currentTokens <= acceptedTokenBudget) break;
    removeIds.add(removable.item.recordId);
    currentTokens = Math.max(0, currentTokens - removable.item.estimatedTokens);
  }

  const compactedSections = sections.map((section) => {
    const keptItems = section.items.filter((item) => !removeIds.has(item.recordId));
    const prunedRecordIds = section.items
      .filter((item) => removeIds.has(item.recordId))
      .map((item) => item.recordId);
    return {
      ...section,
      estimatedTokens: totalItemTokens(keptItems),
      items: keptItems,
      droppedRecordIds: [
        ...section.droppedRecordIds,
        ...prunedRecordIds,
      ],
    };
  });
  const estimatedTokensAfterCompaction = totalSectionTokens(compactedSections);
  const removedRecordIds = [...removeIds];
  return {
    sections: compactedSections,
    estimatedTokensAfterCompaction,
    compaction: {
      reason: "context_token_budget_exceeded",
      acceptedTokenBudget,
      estimatedTokensBeforeCompaction,
      estimatedTokensAfterCompaction,
      removedRecordIds,
      removedTokenCount:
        estimatedTokensBeforeCompaction - estimatedTokensAfterCompaction,
    },
  };
}

function cloneSection(
  section: ResearchContextPacketV2Section,
): ResearchContextPacketV2Section {
  return {
    ...section,
    items: [...section.items],
    droppedRecordIds: [...section.droppedRecordIds],
  };
}

function totalSectionTokens(
  sections: readonly ResearchContextPacketV2Section[],
): number {
  return sections.reduce((sum, section) => sum + section.estimatedTokens, 0);
}

function totalItemTokens(
  items: readonly ResearchContextPacketV2Item[],
): number {
  return items.reduce((sum, item) => sum + item.estimatedTokens, 0);
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
    case "finding":
      return "finding";
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

function scoreProofObligation(obligation: ResearchProofObligation): number {
  switch (obligation.status) {
    case "open":
      return 80;
    case "in_progress":
      return 75;
    case "failed":
    case "blocked":
      return 70;
    case "satisfied":
      return 55;
    case "superseded":
    case "tombstoned":
      return 10;
  }
}

function scoreProofAttempt(attempt: ResearchProofAttempt): number {
  if (attempt.result === "fail" || attempt.result === "blocked") {
    return 75;
  }
  if (attempt.result === "pass") {
    return 65;
  }
  if (attempt.status === "running" || attempt.status === "planned") {
    return 60;
  }
  if (attempt.result === "inconclusive") {
    return 55;
  }

  return 40;
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

function positiveInteger(value: number | undefined): number | null {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : null;
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
    .filter(
      (tool) =>
        tool.actionClasses.length > 0 &&
        isSideEffectAllowed(tool.sideEffects, governance) &&
        arePermissionsAllowed(tool.requiredPermissions, governance),
    );
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
