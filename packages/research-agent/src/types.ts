export type ResearchGoalStatus =
  | "pending"
  | "active"
  | "complete"
  | "blocked"
  | "superseded";

export type ResearchActionClass =
  | "recall"
  | "search"
  | "inspect"
  | "analyze"
  | "experiment"
  | "synthesize"
  | "ask_user"
  | "respond";

export type ResearchGatePolarity = "success" | "failure" | "stop";

export type ResearchMemoryStoreKind =
  | "event"
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
  summary?: string;
  confidence?: number;
}

export interface ResearchEvent {
  id: string;
  kind:
    | "goal.created"
    | "memory.decision"
    | "context.compiled"
    | "loop.planned";
  timestamp: string;
  goalId?: string;
  payload: unknown;
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
  maxTokens?: number;
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
  maxToolCalls?: number;
  maxRuntimeMs?: number;
  maxFiles?: number;
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
    | "tool_permissions";
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
  expectedArtifacts: readonly string[];
  completionGates: readonly ResearchCompletionGate[];
  writebackRequirements: readonly ResearchMemoryStoreKind[];
  contextPacket: ResearchContextPacket;
  loopPrompt: string;
}
