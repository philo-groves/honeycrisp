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

export type ResearchMemoryStoreKind =
  | "event"
  | "evidence"
  | "finding"
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
  | "memory.routed"
  | "memory.reviewed"
  | "context.compiled"
  | "artifact.updated"
  | "artifact.tombstoned"
  | "tool.requested"
  | "tool.observed"
  | "model.visible_note"
  | "model.observation"
  | "model.claim"
  | "model.hypothesis"
  | "finding.proposed"
  | "finding.updated"
  | "finding.reviewed"
  | "proof.requested"
  | "proof.attempted"
  | "proof.observed"
  | "proof.reviewed"
  | "user.commitment"
  | "error.observed";

export type ResearchMemoryRouteTarget =
  | "directEvidence"
  | "priorEpisodes"
  | "candidateProcedures"
  | "currentHypotheses"
  | "currentFindings"
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
  | "finding"
  | "belief"
  | "procedure"
  | "prospective_check"
  | "working";

export type ResearchFindingStatus =
  | "candidate"
  | "needs_evidence"
  | "supported"
  | "verified"
  | "superseded"
  | "rejected"
  | "out_of_scope"
  | "tombstoned";

export type ResearchProofSubjectKind =
  | "goal"
  | "sub_goal"
  | "memory_record"
  | "artifact"
  | "external";

export type ResearchProofMethodKind =
  | "mathematical_proof"
  | "empirical_reproduction"
  | "static_analysis"
  | "dynamic_execution"
  | "artifact_validation"
  | "investigation_corroboration"
  | "human_review"
  | "domain_skill"
  | "mcp_provider";

export type ResearchProofObligationStatus =
  | "open"
  | "in_progress"
  | "satisfied"
  | "failed"
  | "blocked"
  | "superseded"
  | "tombstoned";

export type ResearchProofAttemptStatus =
  | "planned"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "superseded";

export type ResearchProofResultStatus =
  | "pass"
  | "fail"
  | "inconclusive"
  | "blocked"
  | "superseded";

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

export interface ResearchFindingMemoryRecord extends ResearchBaseMemoryRecord {
  kind: "finding";
  finding: string;
  findingStatus: ResearchFindingStatus;
  linkedHypothesisRecordIds: readonly string[];
  linkedClaimRecordIds: readonly string[];
  proofAttemptIds: readonly string[];
  domainLabels: readonly string[];
  domainMetadata?: Record<string, unknown>;
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
  | ResearchFindingMemoryRecord
  | ResearchBeliefMemoryRecord
  | ResearchProcedureMemoryRecord
  | ResearchProspectiveMemoryRecord
  | ResearchWorkingMemoryRecord;

export interface ResearchProofSubjectRef {
  kind: ResearchProofSubjectKind;
  id: string;
  summary?: string;
}

export interface ResearchProofMethodDescriptor {
  kind: ResearchProofMethodKind;
  name: string;
  description?: string;
  toolNames?: readonly string[];
  skillIds?: readonly string[];
  mcpServerIds?: readonly string[];
  artifactRequirements?: readonly string[];
  domainMetadata?: Record<string, unknown>;
}

export interface ResearchProofObligation {
  id: string;
  status: ResearchProofObligationStatus;
  subject: ResearchProofSubjectRef;
  question: string;
  acceptableMethods: readonly ResearchProofMethodDescriptor[];
  requiredResult?: ResearchProofResultStatus;
  goalId?: string;
  subGoalId?: string;
  findingRecordIds: readonly string[];
  hypothesisRecordIds: readonly string[];
  claimRecordIds: readonly string[];
  evidenceRefIds: readonly string[];
  artifactRefs: readonly ResearchArtifactRef[];
  createdAt: string;
  updatedAt: string;
  domainMetadata?: Record<string, unknown>;
}

export interface ResearchProofAttempt {
  id: string;
  obligationId: string;
  status: ResearchProofAttemptStatus;
  method: ResearchProofMethodDescriptor;
  summary: string;
  result?: ResearchProofResultStatus;
  verifier?: string;
  sourceEventIds: readonly string[];
  evidenceRefIds: readonly string[];
  artifactRefs: readonly ResearchArtifactRef[];
  createdAt: string;
  updatedAt: string;
  domainMetadata?: Record<string, unknown>;
}

export interface ResearchProofStateReadModel {
  obligations: readonly ResearchProofObligation[];
  attempts: readonly ResearchProofAttempt[];
}

export interface ResearchMemoryReadModel {
  evidence: readonly ResearchEvidenceMemoryRecord[];
  episodes: readonly ResearchEpisodicMemoryRecord[];
  semanticClaims: readonly ResearchSemanticClaimRecord[];
  hypotheses: readonly ResearchHypothesisMemoryRecord[];
  findings: readonly ResearchFindingMemoryRecord[];
  beliefs: readonly ResearchBeliefMemoryRecord[];
  procedures: readonly ResearchProcedureMemoryRecord[];
  prospectiveChecks: readonly ResearchProspectiveMemoryRecord[];
  working: readonly ResearchWorkingMemoryRecord[];
}

export interface ResearchStorageReadModel {
  rootPath?: string;
  databasePath?: string;
  directories: readonly ResearchStorageDirectory[];
  artifacts: readonly ResearchArtifactRef[];
}

export type ResearchWorkspaceRepositoryRole =
  | "known_repository"
  | "materialized_source"
  | "workspace";

export interface ResearchWorkspaceRepositoryContext {
  rootPath: string;
  label?: string;
  role: ResearchWorkspaceRepositoryRole;
  source?: "cli" | "config" | "beale" | "inferred";
  repositoryUrl?: string;
  notes?: readonly string[];
}

export interface ResearchWorkspaceAuthorizationContext {
  recorded: true;
  source: "beale" | "cli" | "config";
  scopeId?: string;
  scopeName?: string;
  scopeOwner?: string;
  networkProfile?: string;
  activeFrom?: string;
  expiresAt?: string;
}

export interface ResearchMemoryPeerContext {
  databasePath: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string;
  subjectName: string;
}

export interface ResearchMemoryTierContext {
  sessionId?: string;
  workspaceId: string;
  workspaceName: string;
  subjectId?: string;
  subjectName?: string;
  peers: readonly ResearchMemoryPeerContext[];
}

export interface ResearchWorkspaceContext {
  schemaVersion: 1;
  workspaceRoot: string;
  memoryTierContext?: ResearchMemoryTierContext;
  authorization?: ResearchWorkspaceAuthorizationContext;
  knownRepositories: readonly ResearchWorkspaceRepositoryContext[];
  materializedSourcePaths: readonly string[];
  projectNotes: readonly string[];
}

export interface ResearchContextUsageReadModel {
  latestContextEventId?: string;
  estimatedTokens?: number;
  tokenBudget?: number;
  compacted?: boolean;
  removedRecordIds?: readonly string[];
}

export interface ResearchAgentStateReadModel {
  latestContext?: ResearchContextPacketRef;
  memory: ResearchMemoryReadModel;
  proof: ResearchProofStateReadModel;
  storage: ResearchStorageReadModel;
  contextUsage?: ResearchContextUsageReadModel;
}

export interface ResearchContextPacketRef {
  refId: string;
  target:
    | "event"
    | "memory_record"
    | "artifact"
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

export interface ResearchTrace {
  observations: readonly ResearchTraceItem[];
  inferences: readonly ResearchTraceItem[];
  hypotheses: readonly ResearchTraceItem[];
  assumptions: readonly ResearchTraceItem[];
  rejectedPaths: readonly ResearchTraceItem[];
  uncertainty: readonly ResearchTraceItem[];
  nextQuestions: readonly ResearchTraceItem[];
  evidenceLinks: readonly ResearchEvidenceLink[];
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
  metadata?: Record<string, unknown>;
}

export interface ResearchSkillDescriptor {
  id: string;
  version?: string;
  description: string;
  domainTags: readonly string[];
  instructions: string;
  recommendedToolNames?: readonly string[];
  recommendedActionClasses?: readonly ResearchActionClass[];
  governanceHints?: Partial<ResearchGovernancePolicy>;
  runbook?: string;
  source?: {
    kind: "local" | "mcp" | "inline";
    uri?: string;
  };
}

export interface ResearchSelectedSkill {
  id: string;
  version?: string;
  description: string;
  domainTags: readonly string[];
  instructions: string;
  recommendedToolNames: readonly string[];
  recommendedActionClasses: readonly ResearchActionClass[];
  governanceHints?: Partial<ResearchGovernancePolicy>;
  runbook?: string;
  source?: ResearchSkillDescriptor["source"];
  selectionReasons: readonly string[];
}

export interface ResearchToolPermission {
  toolName: string;
  actionClasses: readonly ResearchActionClass[];
  sideEffects: ResearchToolSideEffect;
  requiredPermissions: readonly string[];
}

export interface ResearchToolBudget {
  maxToolCalls?: number;
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

export interface ResearchMemorySnapshot {
  eventLog: readonly ResearchEvent[];
  directEvidence: readonly ResearchMemoryRef[];
  priorEpisodes: readonly ResearchMemoryRef[];
  candidateProcedures: readonly ResearchMemoryRef[];
  currentHypotheses: readonly ResearchMemoryRef[];
  currentFindings: readonly ResearchMemoryRef[];
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

export type ResearchStorageDirectoryName = "artifacts";

export interface ResearchStorageDirectory {
  name: ResearchStorageDirectoryName;
  path: string;
  purpose: string;
}

export interface ResearchStorageLayout {
  schemaVersion: 1;
  rootPath: string;
  databasePath: string;
  artifactDirectoryPath: string;
  directories: readonly ResearchStorageDirectory[];
  rules: readonly string[];
}

export interface ResearchNextPromptSuggestion {
  title: string;
  promptMarkdown: string;
  rationale?: string;
}

export interface ResearchAgentContextSection {
  label: string;
  content: unknown;
}

export interface ResearchAgentModelInput {
  prompt: string;
  contextSections: readonly ResearchAgentContextSection[];
  toolBudget: ResearchToolBudget;
  storageLayout: ResearchStorageLayout;
}

export interface ResearchAgentExecutionInput {
  modelInput: ResearchAgentModelInput;
  governance?: ResearchGovernancePolicy;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
}

export interface ResearchAgentExecutionOutput {
  text: string;
  nextPromptSuggestions?: readonly ResearchNextPromptSuggestion[];
  toolEvents?: readonly ResearchEvent[];
  researchTrace?: ResearchTrace;
  raw?: unknown;
}

export interface ResearchAgentExecutor {
  name: string;
  execute(input: ResearchAgentExecutionInput): Promise<ResearchAgentExecutionOutput>;
}

export interface ResearchAgentRunResult {
  id: string;
  status: "complete" | "error";
  executorName: string;
  startedAt: string;
  completedAt: string;
  modelInput: ResearchAgentModelInput;
  output: ResearchAgentExecutionOutput;
}

export type ResearchLiveEventKind =
  | "agent.event"
  | "model.output"
  | "model.thought"
  | "research.event"
  | "tool.progress";

export interface ResearchLiveEvent {
  schemaVersion: 1;
  kind: ResearchLiveEventKind;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type ResearchLiveEventSink = (
  event: ResearchLiveEvent,
) => void | Promise<void>;
