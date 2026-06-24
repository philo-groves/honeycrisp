export type ResearchGoalStatus =
  | "pending"
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "stopped"
  | "usage_limited"
  | "budget_limited"
  | "superseded";

export type ResearchActionClass =
  | "recall"
  | "search"
  | "inspect"
  | "analyze"
  | "experiment"
  | "synthesize"
  | "ask_user"
  | "respond"
  | "stop";

export type ResearchGatePolarity = "success" | "failure" | "stop";

export type ResearchMemoryStoreKind =
  | "event"
  | "evidence"
  | "working"
  | "episodic"
  | "semantic"
  | "procedural"
  | "hypothesis"
  | "prospective";

export type ResearchToolSideEffect =
  | "none"
  | "read"
  | "write"
  | "network"
  | "process";

export type ResearchAcceptedRawEventKind =
  | "goal.created"
  | "goal.updated"
  | "memory.decision"
  | "memory.routed"
  | "context.compiled"
  | "loop.planned"
  | "loop.processed"
  | "artifact.tombstoned"
  | "tool.requested"
  | "tool.observed"
  | "model.visible_note"
  | "model.claim"
  | "model.hypothesis"
  | "user.commitment"
  | "error.observed";

export type ResearchMemoryRouteTarget =
  | "directEvidence"
  | "priorEpisodes"
  | "candidateProcedures"
  | "currentHypotheses"
  | "contradictions"
  | "prospectiveCommitments"
  | "userCommitments";

export type ResearchEventId = `evt_${string}`;

export type ResearchEventSequence = number;

export type ResearchMemoryRecordId = `mem_${string}`;

export type ResearchDerivedMemoryStatus =
  | "candidate"
  | "active"
  | "confirmed"
  | "contradicted"
  | "superseded"
  | "stale"
  | "tombstoned";

export type ResearchMemoryRecordKind =
  | "evidence"
  | "episodic"
  | "semantic_claim"
  | "hypothesis"
  | "belief"
  | "procedure"
  | "prospective_check"
  | "working";

export type ResearchMemoryEvidenceRelationship =
  | "supports"
  | "weakens"
  | "contradicts"
  | "mentions"
  | "derived_from";

export type ResearchClaimGraphRelationship =
  | "supports"
  | "contradicts"
  | "refines"
  | "supersedes"
  | "depends_on";

export type ResearchMemoryAuditOperation =
  | "write"
  | "promotion"
  | "contradiction"
  | "tombstone"
  | "supersede"
  | "expire"
  | "deletion";

export interface ResearchArtifactRef {
  id: string;
  kind: string;
  uri?: string;
  summary?: string;
  contentHash?: string;
}

export interface ResearchMemoryEvidenceRef {
  id: string;
  relationship: ResearchMemoryEvidenceRelationship;
  sourceEventId?: string;
  recordId?: string;
  artifactRefId?: string;
  summary?: string;
  confidence?: number;
}

export type ResearchMemoryDerivationKind =
  | "direct_evidence"
  | "model_visible_inference"
  | "model_visible_hypothesis"
  | "user_commitment"
  | "runtime_consolidation"
  | "context_reference";

export interface ResearchMemoryProvenance {
  sourceEventIds: readonly string[];
  evidenceFor: readonly ResearchMemoryEvidenceRef[];
  evidenceAgainst: readonly ResearchMemoryEvidenceRef[];
  artifactRefs: readonly ResearchArtifactRef[];
  derivedFromRecordIds: readonly string[];
  derivation: ResearchMemoryDerivationKind;
  note?: string;
}

export type ResearchRawEventPayload = unknown;

export interface ResearchCompletionGate {
  id: string;
  description: string;
  polarity: ResearchGatePolarity;
  satisfied?: boolean;
  evidenceEventIds?: readonly string[];
}

export interface ResearchMemoryRef {
  store: ResearchMemoryStoreKind;
  id: string;
  recordKind?: ResearchMemoryRecordKind;
  status?: ResearchDerivedMemoryStatus;
  sourceEventIds?: readonly string[];
  summary?: string;
  confidence?: number;
}

export interface ResearchEvent {
  id: string;
  sequence?: ResearchEventSequence;
  kind: ResearchAcceptedRawEventKind;
  timestamp: string;
  goalId?: string;
  loopId?: string;
  subGoalId?: string;
  payload: ResearchRawEventPayload;
  payloadHash?: string;
  artifactRefs?: readonly ResearchArtifactRef[];
  schemaVersion?: number;
}

export interface ResearchBaseMemoryRecord {
  id: string;
  kind: ResearchMemoryRecordKind;
  status: ResearchDerivedMemoryStatus;
  summary: string;
  sourceEventIds: readonly string[];
  evidenceRefIds: readonly string[];
  provenance: ResearchMemoryProvenance;
  goalId?: string;
  subGoalId?: string;
  confidence?: number;
  tags: readonly string[];
  entities: readonly string[];
  createdAt: string;
  updatedAt: string;
  validFrom?: string;
  validUntil?: string;
}

export interface ResearchEvidenceMemoryRecord
  extends ResearchBaseMemoryRecord {
  kind: "evidence";
  evidenceKind: "tool_observation" | "user_statement" | "artifact" | "runtime";
  payloadRef: {
    sourceEventId: string;
    payloadHash?: string;
  };
}

export interface ResearchEpisodicMemoryRecord
  extends ResearchBaseMemoryRecord {
  kind: "episodic";
  episodeKind:
    | "goal_transition"
    | "loop_plan"
    | "loop_result"
    | "memory_decision"
    | "context_compilation"
    | "visible_note"
    | "tool_request"
    | "artifact_lifecycle"
    | "error";
}

export interface ResearchSemanticClaimRecord
  extends ResearchBaseMemoryRecord {
  kind: "semantic_claim";
  claim: string;
}

export interface ResearchHypothesisMemoryRecord
  extends ResearchBaseMemoryRecord {
  kind: "hypothesis";
  hypothesis: string;
}

export interface ResearchBeliefMemoryRecord extends ResearchBaseMemoryRecord {
  kind: "belief";
  belief: string;
}

export interface ResearchProcedureMemoryRecord
  extends ResearchBaseMemoryRecord {
  kind: "procedure";
  procedure: string;
  guidance:
    | {
        durability: "candidate";
        promotionRequired: "repeated_usefulness_or_explicit_promotion";
        observedUsefulCount?: number;
      }
    | {
        durability: "durable";
        promotionReason: "repeated_usefulness";
        usefulCount: number;
        supportingEventIds: readonly string[];
      }
    | {
        durability: "durable";
        promotionReason: "explicit_promotion";
        promotedByEventId: string;
      };
}

export interface ResearchProspectiveMemoryRecord
  extends ResearchBaseMemoryRecord {
  kind: "prospective_check";
  check: string;
  trigger: string;
}

export interface ResearchWorkingMemoryRecord extends ResearchBaseMemoryRecord {
  kind: "working";
  expiresAfterLoopId?: string;
}

export type ResearchDerivedMemoryRecord =
  | ResearchEvidenceMemoryRecord
  | ResearchEpisodicMemoryRecord
  | ResearchSemanticClaimRecord
  | ResearchHypothesisMemoryRecord
  | ResearchBeliefMemoryRecord
  | ResearchProcedureMemoryRecord
  | ResearchProspectiveMemoryRecord
  | ResearchWorkingMemoryRecord;

export interface ResearchContextPacketRef {
  refId: string;
  target:
    | "event"
    | "memory_record"
    | "artifact"
    | "goal"
    | "sub_goal"
    | "context_section";
  summary: string;
  sourceEventIds?: readonly string[];
  recordIds?: readonly string[];
  confidence?: number;
}

export interface ResearchClaimGraphEdge {
  id: string;
  sourceRecordId: string;
  relationship: ResearchClaimGraphRelationship;
  targetRecordId?: string;
  evidenceRefId?: string;
  summary?: string;
  createdAt: string;
}

export interface ResearchMemoryAuditRecord {
  id: string;
  recordId: string;
  operation: ResearchMemoryAuditOperation;
  timestamp: string;
  summary: string;
  policy?: string;
  relatedRecordId?: string;
}

export interface ResearchMemoryRoute {
  id: string;
  sourceEventId: string;
  target: ResearchMemoryRouteTarget;
  reason: string;
  confidence: number;
  memoryRef?: ResearchMemoryRef;
  value?: string;
}

export interface ResearchTraceItem {
  text: string;
  evidenceRefIds?: readonly string[];
  confidence?: number;
}

export interface ResearchEvidenceLink {
  evidenceRefId: string;
  supports?: readonly string[];
  weakens?: readonly string[];
  note?: string;
}

export type ResearchGoalAssessmentStatus =
  | "continue"
  | "ready_to_respond"
  | "complete"
  | "blocked"
  | "stopped";

export interface ResearchGoalAssessment {
  status: ResearchGoalAssessmentStatus;
  rationale: string;
  satisfiedGateIds?: readonly string[];
  unsatisfiedGateIds?: readonly string[];
  triggeredStopGateIds?: readonly string[];
  blockerKey?: string;
  evidenceRefIds?: readonly string[];
}

export interface ResearchTrace {
  observations: readonly ResearchTraceItem[];
  inferences: readonly ResearchTraceItem[];
  hypotheses: readonly ResearchTraceItem[];
  assumptions: readonly ResearchTraceItem[];
  rejectedPaths: readonly ResearchTraceItem[];
  uncertainty: readonly ResearchTraceItem[];
  nextQuestions: readonly ResearchTraceItem[];
  evidenceLinks: readonly ResearchEvidenceLink[];
  goalAssessment: ResearchGoalAssessment;
}

export interface ResearchGoalNode {
  id: string;
  parentId?: string;
  status: ResearchGoalStatus;
  objective: string;
  rationale?: string;
  completionGates: readonly ResearchCompletionGate[];
  stopGates: readonly ResearchCompletionGate[];
  actionClass?: ResearchActionClass;
  memoryRefs: readonly ResearchMemoryRef[];
  expectedArtifacts: readonly string[];
  resultSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPromptFrame {
  rawPrompt: string;
  normalizedPrompt: string;
  rootGoal: string;
  successGates: readonly string[];
  failureOrStopGates: readonly string[];
  scopeConstraints: readonly string[];
  userPreferences: readonly string[];
  evidenceRequirements: readonly string[];
  initialRiskFlags: readonly string[];
}

export interface ResearchGoalFrame {
  prompt: ResearchPromptFrame;
  root: ResearchGoalNode;
  nodes: readonly ResearchGoalNode[];
  scopeConstraints: readonly string[];
  evidenceRequirements: readonly string[];
  riskFlags: readonly string[];
  userPreferences: readonly string[];
}

export interface ResearchGoalFrameOptions {
  rootGoal?: string;
  successGates?: readonly string[];
  failureOrStopGates?: readonly string[];
  scopeConstraints?: readonly string[];
  evidenceRequirements?: readonly string[];
  initialRiskFlags?: readonly string[];
  userPreferences?: readonly string[];
}

export interface ResearchToolDescriptor {
  name: string;
  description: string;
  actionClasses: readonly ResearchActionClass[];
  sideEffects: ResearchToolSideEffect;
  requiredPermissions: readonly string[];
  transportName?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  expectedLatencyMs?: number;
  estimatedCost?: string;
  validationHooks?: readonly string[];
  artifactLocations?: readonly string[];
  memoryWritebackDefaults?: readonly ResearchMemoryStoreKind[];
}

export interface ResearchToolPermission {
  toolName: string;
  actionClasses: readonly ResearchActionClass[];
  sideEffects: ResearchToolSideEffect;
  requiredPermissions: readonly string[];
}

export interface ResearchToolBudget {
  maxToolCalls: number;
  maxRuntimeMs?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxTokens?: number;
}

export interface ResearchToolAction {
  id: string;
  actionClass: ResearchActionClass;
  toolName: string;
  input: Record<string, unknown>;
  expectedOutputs?: readonly string[];
  budget?: Partial<ResearchToolBudget>;
  memoryWritebackTargets?: readonly ResearchMemoryStoreKind[];
}

export type ResearchSkippedToolActionCode =
  | "action_class_not_selected"
  | "action_class_not_permitted"
  | "tool_unavailable"
  | "tool_does_not_support_action"
  | "side_effect_not_permitted"
  | "permission_not_permitted"
  | "tool_budget_exhausted";

export interface ResearchSkippedToolAction {
  action: ResearchToolAction;
  code: ResearchSkippedToolActionCode;
  reason: string;
}

export interface ResearchSubGoal {
  id: string;
  parentGoalId: string;
  objective: string;
  rationale: string;
  actionClass: ResearchActionClass;
  completionGates: readonly ResearchCompletionGate[];
  expectedArtifacts: readonly string[];
}

export interface ResearchMemorySnapshot {
  eventLog: readonly ResearchEvent[];
  directEvidence: readonly ResearchMemoryRef[];
  priorEpisodes: readonly ResearchMemoryRef[];
  candidateProcedures: readonly ResearchMemoryRef[];
  currentHypotheses: readonly ResearchMemoryRef[];
  contradictions: readonly ResearchMemoryRef[];
  prospectiveCommitments: readonly string[];
  userCommitments: readonly string[];
}

export interface ResearchGovernancePolicy {
  allowedActionClasses?: readonly ResearchActionClass[];
  deniedActionClasses?: readonly ResearchActionClass[];
  allowedSideEffects?: readonly ResearchToolSideEffect[];
  deniedSideEffects?: readonly ResearchToolSideEffect[];
  allowedPermissions?: readonly string[];
  deniedPermissions?: readonly string[];
  maxToolCalls?: number;
  maxRuntimeMs?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxTokens?: number;
}

export interface ResearchActionScore {
  actionClass: ResearchActionClass;
  score: number;
  rationale: string;
}

export interface ResearchContextPacket {
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  activeSubGoal: ResearchSubGoal;
  directEvidence: readonly ResearchMemoryRef[];
  priorObservations: readonly ResearchMemoryRef[];
  candidateProcedures: readonly ResearchMemoryRef[];
  currentHypotheses: readonly ResearchMemoryRef[];
  contradictions: readonly ResearchMemoryRef[];
  openQuestions: readonly string[];
  userCommitments: readonly string[];
  toolPermissions: readonly ResearchToolPermission[];
  toolBudget: ResearchToolBudget;
  governancePolicy?: ResearchGovernancePolicy;
  candidateToolActions: readonly ResearchToolAction[];
  skippedToolActions: readonly ResearchSkippedToolAction[];
  writebackExpectations: readonly ResearchMemoryStoreKind[];
}

export interface ResearchMemoryControllerInput {
  goalFrame: ResearchGoalFrame;
  activeGoal?: ResearchGoalNode;
  memory?: Partial<ResearchMemorySnapshot>;
  tools?: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  events?: readonly ResearchEvent[];
}

export interface ResearchMemoryControllerDecision {
  subGoal: ResearchSubGoal;
  actionClass: ResearchActionClass;
  rationale: string;
  actionScores: readonly ResearchActionScore[];
  candidateToolActions: readonly ResearchToolAction[];
  skippedToolActions: readonly ResearchSkippedToolAction[];
  contextPacket: ResearchContextPacket;
  toolBudget: ResearchToolBudget;
  completionGates: readonly ResearchCompletionGate[];
  writeback: readonly ResearchMemoryStoreKind[];
}

export interface ResearchRequiredContextSection {
  label:
    | "goal_frame"
    | "active_sub_goal"
    | "direct_evidence"
    | "prior_observations"
    | "candidate_procedures"
    | "current_hypotheses"
    | "contradictions"
    | "open_questions"
    | "user_commitments"
    | "tool_permissions"
    | "candidate_tool_actions"
    | "skipped_tool_actions";
  description: string;
  itemCount: number;
  required: boolean;
}

export interface ResearchLoopPlan {
  id: string;
  rootGoalId: string;
  subGoal: ResearchSubGoal;
  reason: string;
  requiredContext: readonly ResearchRequiredContextSection[];
  permittedToolClasses: readonly ResearchActionClass[];
  actionBudget: ResearchToolBudget;
  governancePolicy?: ResearchGovernancePolicy;
  candidateToolActions: readonly ResearchToolAction[];
  skippedToolActions: readonly ResearchSkippedToolAction[];
  expectedArtifacts: readonly string[];
  completionGates: readonly ResearchCompletionGate[];
  writebackRequirements: readonly ResearchMemoryStoreKind[];
  contextPacket: ResearchContextPacket;
  loopPrompt: string;
}

export type ResearchLoopProcessingStatus = "complete" | "blocked" | "error";

export type ResearchLoopExecutionMode = "deterministic" | "model" | "custom";

export type ResearchLoopFollowUpRecommendation =
  | "continue_branch"
  | "create_sibling"
  | "refine_goal_tree"
  | "respond"
  | "blocked";

export interface ResearchLoopContextSection {
  label: ResearchRequiredContextSection["label"];
  required: boolean;
  content: unknown;
}

export interface ResearchLoopModelInput {
  loopPrompt: string;
  contextSections: readonly ResearchLoopContextSection[];
  permittedToolClasses: readonly ResearchActionClass[];
  toolBudget: ResearchToolBudget;
}

export interface ResearchLoopExecutionInput {
  loopPlan: ResearchLoopPlan;
  modelInput: ResearchLoopModelInput;
  signal?: AbortSignal;
}

export interface ResearchLoopExecutionOutput {
  text: string;
  artifacts: readonly string[];
  evidenceRefs: readonly ResearchMemoryRef[];
  claimRefs: readonly ResearchMemoryRef[];
  followUpActions: readonly string[];
  toolEvents?: readonly ResearchEvent[];
  researchTrace?: ResearchTrace;
  raw?: unknown;
}

export interface ResearchLoopExecutor {
  name: string;
  execute(
    input: ResearchLoopExecutionInput,
  ): Promise<ResearchLoopExecutionOutput>;
}

export interface ResearchCompletionGateResult {
  gateId: string;
  description: string;
  satisfied: boolean;
  evidence?: string;
}

export interface ResearchLoopProcessingResult {
  id: string;
  loopPlanId: string;
  subGoalId: string;
  status: ResearchLoopProcessingStatus;
  executorName: string;
  startedAt: string;
  completedAt: string;
  modelInput: ResearchLoopModelInput;
  output: ResearchLoopExecutionOutput;
  completionGateResults: readonly ResearchCompletionGateResult[];
  followUpRecommendation: ResearchLoopFollowUpRecommendation;
  followUpRationale: string;
}

export type ResearchGoalRunTerminalReason =
  | "complete"
  | "blocked"
  | "stop_gate"
  | "ready_to_respond"
  | "loop_limit"
  | "safety_limit";

export interface ResearchGoalRunOptions {
  maxLoops?: number | null;
  safetyMaxLoops?: number;
  minLoopsBeforeRespond?: number;
  blockedThreshold?: number;
}

export interface ResearchGoalRunState {
  goalId: string;
  objective: string;
  status: ResearchGoalStatus;
  startedAt: string;
  updatedAt: string;
  loopsUsed: number;
  maxLoops: number | null;
  safetyMaxLoops: number;
  minLoopsBeforeRespond: number;
  blockedThreshold: number;
  consecutiveBlockedCount: number;
  lastBlockerKey?: string;
  terminalReason?: ResearchGoalRunTerminalReason;
  statusReason?: string;
}

export interface ResearchGoalRunIteration {
  index: number;
  decision: ResearchMemoryControllerDecision;
  loopPlan: ResearchLoopPlan;
  loopResult: ResearchLoopProcessingResult;
  statusBefore: ResearchGoalStatus;
  statusAfter: ResearchGoalStatus;
  continuationReason: string;
}

export interface ResearchGoalRunResult {
  state: ResearchGoalRunState;
  iterations: readonly ResearchGoalRunIteration[];
}
