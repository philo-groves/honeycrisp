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

export interface ResearchContextPacket {
  goalFrame: ResearchGoalFrame;
  activeGoal: ResearchGoalNode;
  directEvidence: readonly ResearchMemoryRef[];
  priorObservations: readonly ResearchMemoryRef[];
  candidateProcedures: readonly ResearchMemoryRef[];
  currentHypotheses: readonly ResearchMemoryRef[];
  contradictions: readonly ResearchMemoryRef[];
  openQuestions: readonly string[];
  userCommitments: readonly string[];
  writebackExpectations: readonly ResearchMemoryStoreKind[];
}
