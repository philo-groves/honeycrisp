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

export type ResearchToolSideEffect =
  | "none"
  | "read"
  | "write"
  | "network"
  | "process";

export type ResearchEventKind =
  | "context.compiled"
  | "tool.requested"
  | "tool.observed"
  | "model.visible_note"
  | "model.observation"
  | "model.claim"
  | "model.hypothesis"
  | "error.observed";

export type ResearchEventId = `evt_${string}`;

export type ResearchEventSequence = number;


export interface ResearchArtifactRef {
  id: string;
  kind: string;
  uri?: string;
  summary?: string;
  contentHash?: string;
}

export type ResearchRawEventPayload = unknown;

export interface ResearchEvent {
  id: string;
  sequence?: ResearchEventSequence;
  kind: ResearchEventKind;
  timestamp: string;
  agentId?: string;
  agentPath?: string;
  parentAgentId?: string;
  payload: ResearchRawEventPayload;
  payloadHash?: string;
  artifactRefs?: readonly ResearchArtifactRef[];
  schemaVersion?: number;
}

export type ResearchWorkspaceRepositoryRole =
  | "known_repository"
  | "materialized_source"
  | "workspace";

export interface ResearchWorkspaceRepositoryContext {
  rootPath: string;
  contentRoots?: readonly string[];
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

export interface ResearchMemoryTierContext {
  sessionId?: string;
  workspaceId: string;
  workspaceName: string;
  subjectId?: string;
  subjectName?: string;
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

export interface ResearchCollaborationToolDescriptor {
  name: string;
  description: string;
}

export interface ResearchAgentExecutor {
  name: string;
  collaborationTools?: readonly ResearchCollaborationToolDescriptor[];
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
