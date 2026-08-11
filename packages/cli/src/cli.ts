#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { HoneycrispControlStream } from "./control-stream.js";
import {
  runResearchAgent,
  createAnalysisTool,
  createCodeIntelligenceTools,
  createConfiguredResearchMcpClient,
  createConfiguredExperimentTool,
  createLocalInspectionObservationEvent,
  createLocalInspectionTool,
  createDeterministicAgentExecutor,
  createMemoryGraphTools,
  createRunbookTools,
  compileMemoryModelContext,
  createPiAgentExecutor,
  extractCompatiblePiAgentResumableState,
  createRepositorySearchTool,
  createResearchAgentFlowCapture,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createShellTool,
  createShellSafetyAuthorizer,
  BUNDLED_RESEARCH_PROFILE_IDS,
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  DEFAULT_SHELL_REVIEW_MODELS,
  createResearchWorkspaceContext,
  createMcpResearchTools,
  MemoryGraphStore,
  RunbookStore,
  createStorageListTool,
  createStructuredFileReadTool,
  getDefaultResearchModelConfigPath,
  getDefaultResearchToolConfigPath,
  createSynthesisTool,
  createSessionDispositionTool,
  getAuthStatus,
  getProviderModelCatalog,
  generateResearchSessionTitle,
  listAuthProviders,
  loadResearchSkillsFromDirectory,
  loadResearchStorageManifest,
  loadResearchMcpClientConfig,
  loadResearchExperimentConfig,
  loadResearchModelConfig,
  loadResearchToolConfig,
  loadResearchWorkspaceContextFile,
  loginAuthProvider,
  logoutAuthProvider,
  mergeResearchWorkspaceContexts,
  resolveResearchModelConfig,
  resolveMemoryTypeDescriptions,
  overrideResearchProfileMemoryDescriptions,
  RESEARCH_PROFILE_SCHEMA_VERSION,
  researchProfileHash,
  researchProfileWorkflow,
  resolveResearchProfile,
  verifyProviderAuth,
  workspaceContextFileReadHints,
  writeResearchModelConfig,
  writeResearchToolConfig,
  ResearchDispositionRecorder,
  selectResearchGoalObjective,
} from "@honeycrisp/research-agent";
import type {
  AuthEvent,
  AuthLoginCallbacks,
  AuthPrompt,
  LocalInspectionAction,
  ResearchModelEffort,
  ResearchEvent,
  ResearchExecutableTool,
  ResearchGovernancePolicy,
  ResearchLiveEventSink,
  ResearchAgentExecutor,
  ResearchModelConfigPreference,
  PiAgentResumableState,
  MemoryEvidenceRef,
  MemoryNodeStatus,
  MemoryNodeType,
  MemoryTypeDescriptions,
  MemoryTypeDescriptionsInput,
  ResearchModelMemoryContextNode,
  ResearchProfile,
  ResearchProfileModelJob,
  ResolvedResearchProfile,
  ResearchProfileWorkflow,
  ResearchToolConfigPreference,
  ResolvedResearchModelConfig,
  ResearchSkillDescriptor,
  ResearchToolDescriptor,
  ResearchToolSideEffect,
  ResearchToolRegistry,
  ResearchWorkspaceContext,
  ShellCommandAuthorizer,
  ShellNetworkAuthorization,
  ShellReviewerSelection,
  ShellSafetyMode,
  BundledResearchProfileId,
} from "@honeycrisp/research-agent";

const VERSION = "0.1.0";
const LIVE_EVENT_PREFIX = "HONEYCRISP_EVENT ";
const PROFILE_CATALOG_PROTOCOL_VERSION = 1 as const;
const MAX_MEMORY_ATTRIBUTES_JSON_CHARACTERS = 64_000;
const MAX_MEMORY_EVIDENCE_JSON_CHARACTERS = 64_000;
const MAX_MEMORY_EVIDENCE_JSON_TOTAL_CHARACTERS = 256_000;
const MAX_MEMORY_EVIDENCE_ITEMS = 64;
const BUNDLED_IMPLICIT_ALLOWED_SIDE_EFFECTS = new Set<ResearchToolSideEffect>(
  DEFAULT_SECURITY_RESEARCH_PROFILE.capabilities.allowedSideEffects.filter(
    (effect) => effect !== "network",
  ),
);

type ToolFamily =
  | "shell"
  | "local-inspection"
  | "repository-search"
  | "file-read"
  | "code"
  | "analysis"
  | "synthesis"
  | "storage"
  | "experiment";

type CliExecutorKind = "agent";
type CliToolExecutionMode = "sequential" | "parallel";

interface RuntimeToolConfig {
  toolFamilies: readonly ToolFamily[];
  disabledToolFamilies: readonly ToolFamily[];
  profileToolFamilyCeiling: readonly ToolFamily[];
  repoRoots: readonly string[];
  fileReadRoots: readonly string[];
  sourcePaths: readonly string[];
  projectNotes: readonly string[];
  workspaceContextPath?: string;
  allowedSideEffects: readonly ResearchToolSideEffect[];
  profileSideEffectCeiling: readonly ResearchToolSideEffect[];
  allowedMcpServers: readonly string[];
  profileMcpServerRestriction: readonly string[];
  mcpConfigPath?: string;
  mcpTimeoutMs?: number;
  experimentConfigPath?: string;
  shellOptionsPath?: string;
  selectedSkillIds: readonly string[];
  skillDirs: readonly string[];
  toolMaxCalls?: number;
  toolRuntimeMs?: number;
  toolMaxFiles?: number;
  toolMaxBytes?: number;
  toolMaxTokens?: number;
  toolConfigPath?: string;
  disableDefaultToolConfig: boolean;
}

interface ResolvedRuntimeToolConfig {
  runtimeTools: RuntimeToolConfig;
  capture: {
    configPath: string;
    exists: boolean;
    loaded: boolean;
    defaultDisabled: boolean;
    preference: ResearchToolConfigPreference;
  };
}

interface ParsedToolsConfigArgs {
  command: string | undefined;
  configPath: string | undefined;
  workspaceRoot: string;
  field: string | undefined;
  value: string | undefined;
  json: boolean;
  help: boolean;
}

interface ParsedArgs {
  prompt: string | undefined;
  goal: boolean;
  goalObjective: string | undefined;
  successGates: string[];
  failureOrStopGates: string[];
  scopeConstraints: string[];
  evidenceRequirements: string[];
  initialRiskFlags: string[];
  userPreferences: string[];
  mock: boolean;
  configPath: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  titleModel: string | undefined;
  titleEffort: ResearchModelEffort | undefined;
  shellSafetyMode: ShellSafetyMode;
  shellReviewModels: Readonly<Record<string, string>> | undefined;
  shellReviewEffort: ResearchModelEffort | undefined;
  memoryTypeDescriptions: MemoryTypeDescriptions | undefined;
  profilePath: string | undefined;
  resolvedResearchProfilePath: string | undefined;
  researchProfileHash: string | undefined;
  workflowId: string | undefined;
  maxTokens: number | undefined;
  reasoning: ResearchModelEffort | undefined;
  executor: CliExecutorKind;
  toolExecution: CliToolExecutionMode | undefined;
  inspectRoots: string[];
  inspectPaths: string[];
  inspectAction: LocalInspectionAction;
  inspectBytes: number | undefined;
  runtimeTools: RuntimeToolConfig;
  capturePath: string | undefined;
  sessionId: string | undefined;
  resumeCapturePath: string | undefined;
  resumeFallbackPrompt: string | undefined;
  eventStream: boolean;
  controlStream: boolean;
  workspaceRoot: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

interface ParsedToolsArgs {
  command: string | undefined;
  runtimeTools: RuntimeToolConfig;
  workspaceRoot: string;
  inspectRoots: string[];
  inspectPaths: string[];
  inspectAction: LocalInspectionAction;
  inspectBytes: number | undefined;
  json: boolean;
  help: boolean;
}

interface ParsedMemoryArgs {
  command: string | undefined;
  workspaceRoot: string;
  profilePath: string | undefined;
  positionals: string[];
  limit: number | undefined;
  summary: string | undefined;
  body: string | undefined;
  types: MemoryNodeType[];
  tags: string[];
  assetIds: string[];
  attributes: Record<string, unknown> | undefined;
  evidence: Array<Omit<MemoryEvidenceRef, "id" | "createdAt">> | undefined;
  expectedRevision: number | undefined;
  status: string | undefined;
  confidence: number | undefined;
  json: boolean;
  help: boolean;
}

interface ParsedProfileArgs {
  command: string | undefined;
  workspaceRoot: string;
  profilePath: string | undefined;
  profileId: BundledResearchProfileId | undefined;
  json: boolean;
  help: boolean;
}

interface ResolvedCliResearchProfile {
  resolvedResearchProfile: ResolvedResearchProfile;
  workflow: ResearchProfileWorkflow;
}

interface ResolvedSessionTitleRoute {
  provider: string;
  model: string;
  effort: ResearchModelEffort;
}

interface ParsedConfigArgs {
  command: string | undefined;
  configPath: string | undefined;
  workspaceRoot: string;
  field: string | undefined;
  value: string | undefined;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let prompt: string | undefined;
  let goal = false;
  let goalObjective: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  let mock = false;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let titleModel: string | undefined;
  let titleEffort: ResearchModelEffort | undefined;
  let shellSafetyMode: ShellSafetyMode = "auto_review";
  let shellReviewModels: Readonly<Record<string, string>> | undefined;
  let shellReviewEffort: ResearchModelEffort | undefined;
  let memoryTypeDescriptions: MemoryTypeDescriptions | undefined;
  let profilePath: string | undefined;
  let resolvedResearchProfilePath: string | undefined;
  let researchProfileHash: string | undefined;
  let workflowId: string | undefined;
  let executor: CliExecutorKind = "agent";
  let toolExecution: CliToolExecutionMode | undefined;
  let maxTokens: number | undefined;
  let reasoning: ParsedArgs["reasoning"];
  let inspectAction: LocalInspectionAction = "read_text";
  let inspectBytes: number | undefined;
  let capturePath: string | undefined;
  let sessionId: string | undefined;
  let resumeCapturePath: string | undefined;
  let resumeFallbackPrompt: string | undefined;
  let eventStream = false;
  let controlStream = false;
  let workspaceRoot = process.cwd();
  const toolFamilies: ToolFamily[] = [];
  const disabledToolFamilies: ToolFamily[] = [];
  const profileToolFamilyCeiling: ToolFamily[] = [];
  const repoRoots: string[] = [];
  const fileReadRoots: string[] = [];
  const sourcePaths: string[] = [];
  const projectNotes: string[] = [];
  let workspaceContextPath: string | undefined;
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const profileSideEffectCeiling: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
  let mcpConfigPath: string | undefined;
  let mcpTimeoutMs: number | undefined;
  let experimentConfigPath: string | undefined;
  let shellOptionsPath: string | undefined;
  const selectedSkillIds: string[] = [];
  const skillDirs: string[] = [];
  let toolMaxCalls: number | undefined;
  let toolRuntimeMs: number | undefined;
  let toolMaxFiles: number | undefined;
  let toolMaxBytes: number | undefined;
  let toolMaxTokens: number | undefined;
  let toolConfigPath: string | undefined;
  let disableDefaultToolConfig = false;
  const successGates: string[] = [];
  const failureOrStopGates: string[] = [];
  const scopeConstraints: string[] = [];
  const evidenceRequirements: string[] = [];
  const initialRiskFlags: string[] = [];
  const userPreferences: string[] = [];
  const inspectRoots: string[] = [];
  const inspectPaths: string[] = [];
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-p" || arg === "--prompt") {
      prompt = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--goal") {
      goal = true;
    } else if (arg === "--goal-objective") {
      goalObjective = readOptionValue(argv, index, arg);
      goal = true;
      index += 1;
    } else if (arg === "--success") {
      successGates.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--stop") {
      failureOrStopGates.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--scope" || arg === "--constraint") {
      scopeConstraints.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--evidence") {
      evidenceRequirements.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--risk") {
      initialRiskFlags.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--preference") {
      userPreferences.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--mock") {
      mock = true;
    } else if (arg === "--real") {
      throw new Error(
        "--real was removed because real model calls are now the default. Pass --mock for deterministic mode.",
      );
    } else if (arg === "--config") {
      configPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-config") {
      toolConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--no-default-tool-config") {
      disableDefaultToolConfig = true;
    } else if (arg === "--provider") {
      provider = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--model") {
      model = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--title-model") {
      titleModel = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--title-effort") {
      titleEffort = parseReasoning(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--executor") {
      executor = parseExecutor(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--tool-execution") {
      toolExecution = parseToolExecutionMode(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--max-tokens") {
      const value = Number.parseInt(readOptionValue(argv, index, arg), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--max-tokens requires a positive integer.");
      }
      maxTokens = value;
      index += 1;
    } else if (arg === "--reasoning") {
      reasoning = parseReasoning(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--effort") {
      reasoning = parseReasoning(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-root") {
      inspectRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-path") {
      inspectPaths.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-action") {
      inspectAction = parseInspectionAction(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-bytes") {
      const value = Number.parseInt(readOptionValue(argv, index, arg), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--inspect-bytes requires a positive integer.");
      }
      inspectBytes = value;
      index += 1;
    } else if (arg === "--tool-family") {
      toolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--disable-tool-family") {
      disabledToolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--profile-tool-family-ceiling") {
      profileToolFamilyCeiling.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--repo-root") {
      repoRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--file-read-root") {
      fileReadRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--source-path") {
      sourcePaths.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--project-note") {
      projectNotes.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--workspace-context") {
      workspaceContextPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--allowed-side-effect") {
      allowedSideEffects.push(parseToolSideEffect(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--profile-side-effect-ceiling") {
      const effect = parseToolSideEffect(readOptionValue(argv, index, arg));
      if (effect === "network") {
        throw new Error("--profile-side-effect-ceiling cannot delegate network authority; use --allowed-side-effect network.");
      }
      profileSideEffectCeiling.push(effect);
      index += 1;
    } else if (arg === "--tool-max-calls") {
      toolMaxCalls = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-runtime-ms") {
      toolRuntimeMs = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-files") {
      toolMaxFiles = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-bytes") {
      toolMaxBytes = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-tokens") {
      toolMaxTokens = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--allow-mcp-server") {
      allowedMcpServers.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--mcp-config") {
      mcpConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--mcp-timeout-ms") {
      mcpTimeoutMs = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--experiment-config") {
      experimentConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--shell-options") {
      shellOptionsPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--shell-safety-mode") {
      shellSafetyMode = parseShellSafetyMode(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--shell-review-models") {
      shellReviewModels = parseShellReviewModels(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--shell-review-effort") {
      shellReviewEffort = parseShellReviewEffort(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--memory-type-descriptions") {
      memoryTypeDescriptions = parseMemoryTypeDescriptionsOption(
        readOptionValue(argv, index, arg),
      );
      index += 1;
    } else if (arg === "--profile") {
      profilePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--resolved-research-profile") {
      resolvedResearchProfilePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--research-profile-hash") {
      researchProfileHash = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--workflow") {
      workflowId = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--skill") {
      selectedSkillIds.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--skill-dir") {
      skillDirs.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--capture") {
      capturePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--session-id") {
      sessionId = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--resume-capture") {
      resumeCapturePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--resume-fallback-prompt") {
      resumeFallbackPrompt = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--event-stream") {
      eventStream = true;
    } else if (arg === "--control-stream") {
      controlStream = true;
    } else if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (!prompt && positionals.length > 0) {
    prompt = positionals.join(" ");
  }
  if (profilePath && resolvedResearchProfilePath) {
    throw new Error("--profile and --resolved-research-profile are mutually exclusive.");
  }

  return {
    prompt,
    goal,
    goalObjective,
    successGates,
    failureOrStopGates,
    scopeConstraints,
    evidenceRequirements,
    initialRiskFlags,
    userPreferences,
    mock,
    configPath,
    provider,
    model,
    titleModel,
    titleEffort,
    shellSafetyMode,
    shellReviewModels,
    shellReviewEffort,
    memoryTypeDescriptions,
    profilePath,
    resolvedResearchProfilePath,
    researchProfileHash,
    workflowId,
    maxTokens,
    reasoning,
    executor,
    toolExecution,
    inspectRoots,
    inspectPaths,
    inspectAction,
    inspectBytes,
    runtimeTools: {
      toolFamilies,
      disabledToolFamilies,
      profileToolFamilyCeiling,
      repoRoots,
      fileReadRoots,
      sourcePaths,
      projectNotes,
      ...(workspaceContextPath ? { workspaceContextPath } : {}),
      allowedSideEffects,
      profileSideEffectCeiling,
      allowedMcpServers,
      profileMcpServerRestriction: [],
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      ...(mcpTimeoutMs ? { mcpTimeoutMs } : {}),
      ...(experimentConfigPath ? { experimentConfigPath } : {}),
      ...(shellOptionsPath ? { shellOptionsPath } : {}),
      selectedSkillIds,
      skillDirs,
      ...(toolMaxCalls ? { toolMaxCalls } : {}),
      ...(toolRuntimeMs ? { toolRuntimeMs } : {}),
      ...(toolMaxFiles ? { toolMaxFiles } : {}),
      ...(toolMaxBytes ? { toolMaxBytes } : {}),
      ...(toolMaxTokens ? { toolMaxTokens } : {}),
      ...(toolConfigPath ? { toolConfigPath } : {}),
      disableDefaultToolConfig,
    },
    capturePath,
    sessionId,
    resumeCapturePath,
    resumeFallbackPrompt,
    eventStream,
    controlStream,
    workspaceRoot,
    json,
    help,
    version,
  };
}

function parseProfileArgs(argv: readonly string[]): ParsedProfileArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let workspaceRoot = process.cwd();
  let profilePath: string | undefined;
  let profileId: BundledResearchProfileId | undefined;
  let json = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profile") {
      profilePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profile-id") {
      const value = readOptionValue(argv, index, arg);
      if (!BUNDLED_RESEARCH_PROFILE_IDS.includes(value as BundledResearchProfileId)) {
        throw new Error(`--profile-id must be one of: ${BUNDLED_RESEARCH_PROFILE_IDS.join(", ")}.`);
      }
      profileId = value as BundledResearchProfileId;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown profile option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    throw new Error(`Unexpected profile argument(s): ${positionals.join(" ")}`);
  }
  if (profilePath && profileId) {
    throw new Error("--profile and --profile-id cannot be used together.");
  }

  return {
    command,
    workspaceRoot,
    profilePath,
    profileId,
    json,
    help,
  };
}

function parseMemoryArgs(argv: readonly string[]): ParsedMemoryArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let workspaceRoot = process.cwd();
  let profilePath: string | undefined;
  let limit: number | undefined;
  let summary: string | undefined;
  let body: string | undefined;
  let attributes: Record<string, unknown> | undefined;
  let evidence: Array<Omit<MemoryEvidenceRef, "id" | "createdAt">> | undefined;
  let evidenceJsonCharacters = 0;
  let expectedRevision: number | undefined;
  let status: string | undefined;
  let confidence: number | undefined;
  let json = false;
  let help = false;
  const types: MemoryNodeType[] = [];
  const tags: string[] = [];
  const assetIds: string[] = [];
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profile") {
      profilePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(readOptionValue(argv, index, arg), 10);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--limit requires a positive integer.");
      limit = value;
      index += 1;
    } else if (arg === "--summary") {
      summary = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--body") {
      body = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--attributes-json") {
      if (attributes !== undefined) throw new Error("--attributes-json may be provided only once.");
      attributes = parseMemoryAttributesJson(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--evidence-json") {
      const value = readOptionValue(argv, index, arg);
      evidenceJsonCharacters += value.length;
      if (evidenceJsonCharacters > MAX_MEMORY_EVIDENCE_JSON_TOTAL_CHARACTERS) {
        throw new Error(`--evidence-json values exceed the ${MAX_MEMORY_EVIDENCE_JSON_TOTAL_CHARACTERS}-character total limit.`);
      }
      const items = parseMemoryEvidenceJson(value);
      evidence = [...(evidence ?? []), ...items];
      if (evidence.length > MAX_MEMORY_EVIDENCE_ITEMS) {
        throw new Error(`--evidence-json accepts at most ${MAX_MEMORY_EVIDENCE_ITEMS} evidence items.`);
      }
      index += 1;
    } else if (arg === "--type") {
      types.push(readOptionValue(argv, index, arg) as MemoryNodeType);
      index += 1;
    } else if (arg === "--tag") {
      tags.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--asset") {
      assetIds.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--expected-revision") {
      expectedRevision = Number.parseInt(readOptionValue(argv, index, arg), 10);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("--expected-revision requires a positive integer.");
      index += 1;
    } else if (arg === "--status") {
      status = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--confidence") {
      const value = Number.parseFloat(readOptionValue(argv, index, arg));
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("--confidence requires a number from 0 to 1.");
      confidence = value;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown memory option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    command,
    workspaceRoot,
    profilePath,
    positionals,
    limit,
    summary,
    body,
    types,
    tags,
    assetIds,
    attributes,
    evidence,
    expectedRevision,
    status,
    confidence,
    json,
    help,
  };
}

function parseMemoryAttributesJson(value: string): Record<string, unknown> {
  if (value.length > MAX_MEMORY_ATTRIBUTES_JSON_CHARACTERS) {
    throw new Error(`--attributes-json exceeds the ${MAX_MEMORY_ATTRIBUTES_JSON_CHARACTERS}-character limit.`);
  }
  const parsed = parseMemoryJson(value, "--attributes-json");
  if (!isRecord(parsed)) throw new Error("--attributes-json must be a JSON object.");
  return parsed;
}

function parseMemoryEvidenceJson(
  value: string,
): Array<Omit<MemoryEvidenceRef, "id" | "createdAt">> {
  if (value.length > MAX_MEMORY_EVIDENCE_JSON_CHARACTERS) {
    throw new Error(`Each --evidence-json value must not exceed ${MAX_MEMORY_EVIDENCE_JSON_CHARACTERS} characters.`);
  }
  const parsed = parseMemoryJson(value, "--evidence-json");
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((item, index) => parseMemoryEvidenceItem(item, index));
}

function parseMemoryJson(value: string, option: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${option} must contain valid JSON.`);
  }
}

function parseMemoryEvidenceItem(
  value: unknown,
  index: number,
): Omit<MemoryEvidenceRef, "id" | "createdAt"> {
  const label = `--evidence-json item ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  const knownKeys = new Set(["kind", "pathBase", "path", "locator", "summary"]);
  const unknownKey = Object.keys(value).find((key) => !knownKeys.has(key));
  if (unknownKey) throw new Error(`${label} has unknown field: ${unknownKey}.`);
  const kind = requiredMemoryEvidenceString(value.kind, `${label}.kind`);
  if (!isRecord(value.locator)) throw new Error(`${label}.locator must be a JSON object.`);
  if (typeof value.summary !== "string") throw new Error(`${label}.summary must be a string.`);
  const pathBase = optionalMemoryEvidenceString(value.pathBase, `${label}.pathBase`);
  const path = optionalMemoryEvidenceString(value.path, `${label}.path`);
  return {
    kind,
    ...(pathBase ? { pathBase } : {}),
    ...(path ? { path } : {}),
    locator: value.locator,
    summary: value.summary.trim(),
  };
}

function requiredMemoryEvidenceString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function optionalMemoryEvidenceString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredMemoryEvidenceString(value, label);
}

function parseConfigArgs(argv: readonly string[]): ParsedConfigArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let configPath: string | undefined;
  let workspaceRoot = process.cwd();
  let json = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config") {
      configPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown config option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (command === "set" && positionals.length > 2) {
    throw new Error("config set accepts exactly one field and one value.");
  }

  return {
    command,
    configPath,
    workspaceRoot,
    field: positionals[0],
    value: positionals[1],
    json,
    help,
  };
}

function parseToolsArgs(argv: readonly string[]): ParsedToolsArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let json = false;
  let help = false;
  let workspaceRoot = process.cwd();
  let inspectAction: LocalInspectionAction = "read_text";
  let inspectBytes: number | undefined;
  const inspectRoots: string[] = [];
  const inspectPaths: string[] = [];
  const toolFamilies: ToolFamily[] = [];
  const disabledToolFamilies: ToolFamily[] = [];
  const profileToolFamilyCeiling: ToolFamily[] = [];
  const repoRoots: string[] = [];
  const fileReadRoots: string[] = [];
  const sourcePaths: string[] = [];
  const projectNotes: string[] = [];
  let workspaceContextPath: string | undefined;
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const profileSideEffectCeiling: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
  let mcpConfigPath: string | undefined;
  let mcpTimeoutMs: number | undefined;
  let experimentConfigPath: string | undefined;
  let shellOptionsPath: string | undefined;
  const selectedSkillIds: string[] = [];
  const skillDirs: string[] = [];
  let toolMaxCalls: number | undefined;
  let toolRuntimeMs: number | undefined;
  let toolMaxFiles: number | undefined;
  let toolMaxBytes: number | undefined;
  let toolMaxTokens: number | undefined;
  let toolConfigPath: string | undefined;
  let disableDefaultToolConfig = false;

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-config") {
      toolConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--no-default-tool-config") {
      disableDefaultToolConfig = true;
    } else if (arg === "--inspect-root") {
      inspectRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-path") {
      inspectPaths.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-action") {
      inspectAction = parseInspectionAction(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--inspect-bytes") {
      inspectBytes = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-family") {
      toolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--disable-tool-family") {
      disabledToolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--profile-tool-family-ceiling") {
      profileToolFamilyCeiling.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--repo-root") {
      repoRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--file-read-root") {
      fileReadRoots.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--source-path") {
      sourcePaths.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--project-note") {
      projectNotes.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--workspace-context") {
      workspaceContextPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--allowed-side-effect") {
      allowedSideEffects.push(parseToolSideEffect(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--profile-side-effect-ceiling") {
      const effect = parseToolSideEffect(readOptionValue(argv, index, arg));
      if (effect === "network") {
        throw new Error("--profile-side-effect-ceiling cannot delegate network authority; use --allowed-side-effect network.");
      }
      profileSideEffectCeiling.push(effect);
      index += 1;
    } else if (arg === "--tool-max-calls") {
      toolMaxCalls = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-runtime-ms") {
      toolRuntimeMs = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-files") {
      toolMaxFiles = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-bytes") {
      toolMaxBytes = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-max-tokens") {
      toolMaxTokens = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--allow-mcp-server") {
      allowedMcpServers.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--mcp-config") {
      mcpConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--mcp-timeout-ms") {
      mcpTimeoutMs = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--experiment-config") {
      experimentConfigPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--shell-options") {
      shellOptionsPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--skill") {
      selectedSkillIds.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--skill-dir") {
      skillDirs.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown tools option: ${arg}`);
    } else if (arg) {
      throw new Error(`Unknown tools command argument: ${arg}`);
    }
  }

  return {
    command,
    runtimeTools: {
      toolFamilies,
      disabledToolFamilies,
      profileToolFamilyCeiling,
      repoRoots,
      fileReadRoots,
      sourcePaths,
      projectNotes,
      ...(workspaceContextPath ? { workspaceContextPath } : {}),
      allowedSideEffects,
      profileSideEffectCeiling,
      allowedMcpServers,
      profileMcpServerRestriction: [],
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      ...(mcpTimeoutMs ? { mcpTimeoutMs } : {}),
      ...(experimentConfigPath ? { experimentConfigPath } : {}),
      ...(shellOptionsPath ? { shellOptionsPath } : {}),
      selectedSkillIds,
      skillDirs,
      ...(toolMaxCalls ? { toolMaxCalls } : {}),
      ...(toolRuntimeMs ? { toolRuntimeMs } : {}),
      ...(toolMaxFiles ? { toolMaxFiles } : {}),
      ...(toolMaxBytes ? { toolMaxBytes } : {}),
      ...(toolMaxTokens ? { toolMaxTokens } : {}),
      ...(toolConfigPath ? { toolConfigPath } : {}),
      disableDefaultToolConfig,
    },
    workspaceRoot,
    inspectRoots,
    inspectPaths,
    inspectAction,
    inspectBytes,
    json,
    help,
  };
}

function parseToolsConfigArgs(argv: readonly string[]): ParsedToolsConfigArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let configPath: string | undefined;
  let workspaceRoot = process.cwd();
  let json = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--tool-config") {
      configPath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown tools config option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if ((command === "add" || command === "remove" || command === "set") && positionals.length > 2) {
    throw new Error(`tools config ${command} accepts exactly one field and one value.`);
  }
  if (command === "clear" && positionals.length > 1) {
    throw new Error("tools config clear accepts exactly one field.");
  }

  return {
    command,
    configPath,
    workspaceRoot,
    field: positionals[0],
    value: positionals[1],
    json,
    help,
  };
}

function parseReasoning(value: string): ResearchModelEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }

  throw new Error("--reasoning must be one of minimal, low, medium, high, xhigh, max.");
}

function parseShellSafetyMode(value: string): ShellSafetyMode {
  if (value === "manual_approval" || value === "auto_review" || value === "danger") {
    return value;
  }
  throw new Error("--shell-safety-mode must be manual_approval, auto_review, or danger.");
}

function parseShellReviewEffort(value: string): ResearchModelEffort {
  return parseAuxiliaryModelEffort(value, "--shell-review-effort");
}

function parseAuxiliaryModelEffort(value: string, option: string): ResearchModelEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new Error(`${option} must be one of minimal, low, medium, high, xhigh, max.`);
}

function parseShellReviewModels(value: string): Readonly<Record<string, string>> {
  return parseProviderModelMap(value, "--shell-review-models");
}

function parseProviderModelMap(value: string, option: string): Readonly<Record<string, string>> {
  if (value.length > 16_000) {
    throw new Error(`${option} JSON is too large.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${option} must be a JSON object mapping providers to model IDs.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${option} must be a JSON object mapping providers to model IDs.`);
  }
  const result: Record<string, string> = {};
  for (const [rawProvider, rawModel] of Object.entries(parsed)) {
    const provider = rawProvider.trim();
    const model = typeof rawModel === "string" ? rawModel.trim() : "";
    if (!provider || provider.length > 200 || !model || model.length > 200) {
      throw new Error(`${option} requires non-empty provider and model strings.`);
    }
    result[provider] = model;
  }
  return result;
}

function parseMemoryTypeDescriptionsOption(value: string): MemoryTypeDescriptions {
  if (value.length > 64_000) {
    throw new Error("--memory-type-descriptions JSON is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("--memory-type-descriptions must be a JSON object mapping memory types to descriptions.");
  }
  if (!isRecord(parsed)) {
    throw new Error("--memory-type-descriptions must be a JSON object mapping memory types to descriptions.");
  }
  try {
    const resolved = resolveMemoryTypeDescriptions(parsed as MemoryTypeDescriptionsInput);
    const overlay: Record<string, string> = {};
    for (const type of Object.keys(parsed)) {
      const description = resolved[type];
      if (description !== undefined) overlay[type] = description;
    }
    return Object.freeze(overlay);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--memory-type-descriptions is invalid: ${message}`);
  }
}

function parseInspectionAction(value: string): LocalInspectionAction {
  if (value === "list" || value === "read_text") {
    return value;
  }

  throw new Error("--inspect-action must be one of list, read_text.");
}

function parseExecutor(value: string): CliExecutorKind {
  if (value === "agent") {
    return value;
  }

  throw new Error("--executor must be agent.");
}

function parseToolExecutionMode(value: string): CliToolExecutionMode {
  if (value === "sequential" || value === "parallel") {
    return value;
  }

  throw new Error("--tool-execution must be one of sequential, parallel.");
}

function parseToolFamily(value: string): ToolFamily {
  if (
    value === "shell" ||
    value === "local-inspection" ||
    value === "repository-search" ||
    value === "file-read" ||
    value === "code" ||
    value === "analysis" ||
    value === "synthesis" ||
    value === "storage" ||
    value === "experiment"
  ) {
    return value;
  }

  throw new Error(
    "--tool-family must be one of shell, local-inspection, repository-search, file-read, code, analysis, synthesis, storage, experiment.",
  );
}

function parseToolSideEffect(value: string): ResearchToolSideEffect {
  if (
    value === "none" ||
    value === "read" ||
    value === "write" ||
    value === "network" ||
    value === "process"
  ) {
    return value;
  }

  throw new Error(
    "--allowed-side-effect must be one of none, read, write, network, process.",
  );
}

function parsePositiveIntegerOption(
  argv: readonly string[],
  index: number,
  option: string,
): number {
  const value = Number.parseInt(readOptionValue(argv, index, option), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }

  return value;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }

  return value;
}

function uniqueRuntimeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function usage(): string {
  return [
    "Usage: honeycrisp -p <prompt> [--json]",
    "       honeycrisp tools list [options]",
    "       honeycrisp memory <command> [options]",
    "       honeycrisp profile resolve --workspace-root <path> [--profile <path>] --json",
    "",
    "Options:",
    "  -p, --prompt <prompt>  Research request for the agent",
    "  --goal                 Continue the same Pi session until the objective is complete or strictly blocked",
    "  --goal-objective <text> Concise persistent objective separate from the research prompt (implies --goal)",
    "  --success <gate>       Add a success/completion gate",
    "  --stop <gate>          Add a failure or stop gate",
    "  --scope <constraint>   Add a scope constraint",
    "  --evidence <need>      Add an evidence requirement",
    "  --risk <flag>          Add an initial risk flag",
    "  --preference <pref>    Add a user preference",
    "  --mock                 Use the deterministic mock executor (default: real model calls)",
    "  --config <path>        JSON provider/model/effort preference config for real mode",
    "                         Defaults to .honeycrisp/config.json under --workspace-root when present",
    "  --provider <provider>  Override configured/default provider for real mode",
    "  --model <model>        Override configured/default model for real mode",
    "  --title-model <model>  Generate a session title with this model from the selected provider",
    "  --title-effort <level> Reasoning effort for session title generation (default: medium)",
    "  --executor <kind>      agent (default: agent)",
    "  --max-tokens <n>       Max output tokens for real mode",
    "  --effort <level>       Model effort for real mode: minimal, low, medium, high, xhigh, max",
    "  --reasoning <level>    Alias for --effort",
    "  --tool-execution <m>   Agent tool execution mode: sequential or parallel",
    "  --inspect-root <path>  Allow a local root for read-only inspection",
    "  --inspect-path <path>  Make a local path available for inspection",
    "  --inspect-action <a>   Inspection action: read_text or list",
    "  --inspect-bytes <n>    Max bytes for read_text inspection",
    "  --tool-family <name>   Enable shell, local-inspection, repository-search, file-read, code, analysis, synthesis, storage, or experiment",
    "  --shell-options <path> Harness-wide shell utility policy JSON",
    "  --shell-safety-mode <m> Shell safety: manual_approval, auto_review (default), or danger",
    "  --shell-review-models <json> Provider-to-small-reviewer-model JSON object",
    "                               Defaults: openai-codex=gpt-5.6-luna, anthropic=claude-haiku-4-5, xai=grok-4.3",
    "  --shell-review-effort <level> Small-model review effort (default: medium)",
    "  --memory-type-descriptions <json> Per-memory-type description overrides used by active agents",
    "  --profile <path>       Explicit research profile JSON (overrides the workspace default)",
    "  --resolved-research-profile <path> Exact normalized research profile JSON supplied by a host",
    "  --research-profile-hash <hash> Require the resolved profile to match this SHA-256 hash",
    "  --workflow <id>        Select a workflow from the resolved research profile",
    "  --disable-tool-family <name> Disable a tool family after implicit/default enables",
    "  --profile-tool-family-ceiling <name> Let the active profile request this family within a host ceiling",
    "  --tool-config <path>   Runtime tool preference config (default: .honeycrisp/tools.json)",
    "  --no-default-tool-config Ignore .honeycrisp/tools.json unless --tool-config is provided",
    "  --repo-root <path>     Add a known repository context hint and enable repository.search unless disabled",
    "  --file-read-root <p>   Add a file.read context hint and enable file.read unless disabled",
    "  --source-path <path>   Add a materialized source context path",
    "  --project-note <text>  Add a project/workspace note to compiled context",
    "  --workspace-context <p> JSON workspace context file to merge with CLI hints",
    "  --allowed-side-effect <s> Allow tool side effect: none, read, write, network, process",
    "  --profile-side-effect-ceiling <s> Let the profile request none, read, write, or process within a host ceiling",
    "  --tool-max-calls <n>   Max tool calls for governance",
    "  --tool-runtime-ms <n>  Max runtime per tool call in milliseconds",
    "  --tool-max-files <n>   Max files for file-oriented tools",
    "  --tool-max-bytes <n>   Max bytes for file-oriented tools",
    "  --tool-max-tokens <n>  Max tool output tokens",
    "  --allow-mcp-server <s> Allow an MCP server name in runtime config",
    "  --mcp-config <path>    JSON MCP stdio server config",
    "  --mcp-timeout-ms <n>   MCP request timeout in milliseconds",
    "  --experiment-config <p> JSON allowlisted experiment config",
    "  --skill-dir <path>     Load local skills from child directories containing SKILL.md",
    "  --skill <id>           Request a loaded skill by id",
    "  --capture <path>       Write a local flow-capture JSON artifact",
    "  --session-id <id>     Stable provider affinity ID for this research session",
    "  --resume-capture <p>  Resume compatible model context from a prior capture",
    "  --resume-fallback-prompt <text>  Prompt used when prior state is unavailable",
    "  --event-stream         Write prefixed live JSON events to stdout",
    "  --control-stream       Read host control JSONL from stdin",
    "  --workspace-root <p>   Workspace root for durable runtime memory",
    "  --json                 Print the initialized run as JSON",
    "  -h, --help             Show help",
    "  -v, --version          Show version",
    "",
    "Memory commands:",
    "  memory state                     Summarize durable knowledge",
    "  memory list                      List durable knowledge nodes",
    "  memory search <query>            Search durable knowledge nodes",
    "  memory get <node-id>             Show one node and its evidence",
    "  memory save <type> <title>       Add or refine a node",
    "  memory correct <node-id>         Correct a node by revision",
    "  memory link <from> <to> <rel>    Link two nodes",
    "",
    "Memory options:",
    "  --workspace-root <path>  Workspace root containing .honeycrisp memory",
    "  --type <type>           Filter nodes; with correct, reclassify one node",
    "  --status <status>       Filter or set node status",
    "  --tag <tag>             Filter or add a tag (repeatable)",
    "  --asset <asset-id>      Filter or add an asset link (repeatable)",
    "  --summary <text>        Set a concise summary or relationship note",
    "  --body <text>           Set supporting detail",
    "  --confidence <0..1>     Set confidence",
    "  --expected-revision <n> Required for exact correction",
    "  --limit <n>             Limit returned nodes",
    "  --json                  Print JSON",
    "",
    "Profile commands:",
    "  profile resolve                  Resolve and normalize the active research profile",
    "",
    "Profile options:",
    "  --workspace-root <path>  Workspace root used for .honeycrisp/profile.json discovery",
    "  --profile <path>         Explicit research profile JSON (highest precedence)",
    "  --json                   Print the versioned profile catalog envelope",
    "",
    "Model commands:",
    "  models list [provider]          List Pi models and supported effort levels",
    "",
    "Tool debug commands:",
    "  tools list                       Show configured tools, MCP allowlist, and selected skills",
    "  tools config show                Show project runtime tool preferences",
    "  config show                      Show project model preference and authorization status",
    "  config set <field> <value>       Set provider, model, or effort preference",
  ].join("\n");
}

function profileUsage(): string {
  return [
    "Usage: honeycrisp profile resolve --workspace-root <path> [--profile <path> | --profile-id <security-research|mathematics>] --json",
    "",
    "Resolves an explicit profile or selected bundled profile, then .honeycrisp/profile.json, then the bundled security profile.",
  ].join("\n");
}

async function handleProfileCommand(argv: readonly string[]): Promise<void> {
  const args = parseProfileArgs(argv);
  if (!args.command || args.help) {
    console.log(profileUsage());
    return;
  }
  if (args.command !== "resolve") {
    throw new Error(`Unknown profile command: ${args.command}`);
  }

  const resolvedProfile = await resolveResearchProfile({
    workspaceRoot: args.workspaceRoot,
    ...(args.profilePath ? { profilePath: args.profilePath } : {}),
    ...(args.profileId ? { bundledProfileId: args.profileId } : {}),
  });
  const envelope = {
    catalogProtocolVersion: PROFILE_CATALOG_PROTOCOL_VERSION,
    supportedResearchProfileSchemaVersions: [RESEARCH_PROFILE_SCHEMA_VERSION],
    profile: resolvedProfile.profile,
    hash: resolvedProfile.hash,
    source: resolvedProfile.source,
    ...(resolvedProfile.path ? { path: resolvedProfile.path } : {}),
  };

  if (args.json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.log(`${envelope.profile.id}@${envelope.profile.version}\t${envelope.hash}\t${envelope.source}`);
}

async function resolveCliResearchProfile(args: Pick<
  ParsedArgs,
  | "workspaceRoot"
  | "profilePath"
  | "resolvedResearchProfilePath"
  | "researchProfileHash"
  | "workflowId"
  | "memoryTypeDescriptions"
>): Promise<ResolvedCliResearchProfile> {
  const profilePath = args.resolvedResearchProfilePath ?? args.profilePath;
  let resolvedResearchProfile = await resolveResearchProfile({
    workspaceRoot: args.workspaceRoot,
    ...(profilePath ? { profilePath } : {}),
  });

  if (args.memoryTypeDescriptions !== undefined) {
    const profile = overrideResearchProfileMemoryDescriptions(
      resolvedResearchProfile.profile,
      args.memoryTypeDescriptions,
    );
    resolvedResearchProfile = {
      ...resolvedResearchProfile,
      profile,
      hash: researchProfileHash(profile),
    };
  }

  if (
    args.researchProfileHash !== undefined &&
    !/^[a-f0-9]{64}$/u.test(args.researchProfileHash)
  ) {
    throw new Error("--research-profile-hash must be a lowercase SHA-256 hash.");
  }
  if (
    args.researchProfileHash !== undefined &&
    args.researchProfileHash !== resolvedResearchProfile.hash
  ) {
    throw new Error(
      `Research profile hash mismatch: expected ${args.researchProfileHash}, resolved ${resolvedResearchProfile.hash}.`,
    );
  }
  validateResearchProfileModelJobs(resolvedResearchProfile.profile);

  return {
    resolvedResearchProfile,
    workflow: researchProfileWorkflow(
      resolvedResearchProfile.profile,
      args.workflowId,
    ),
  };
}

function validateResearchProfileModelJobs(profile: ResearchProfile): void {
  for (const [name, job] of [
    ["sessionTitle", profile.modelJobs.sessionTitle],
    ["shellReview", profile.modelJobs.shellReview],
  ] as const) {
    const effort = parseResearchProfileModelJobEffort(job, name);
    if (job?.provider && job.model) {
      validateModelRoute(`Research profile ${name}`, {
        provider: job.provider,
        model: job.model,
        effort: effort ?? "medium",
      });
    }
  }
}

function resolveSessionTitleRoute(
  args: ParsedArgs,
  resolvedResearchProfile: ResolvedResearchProfile,
  modelConfig: ResolvedResearchModelConfig | undefined,
): ResolvedSessionTitleRoute | undefined {
  const job = resolvedResearchProfile.profile.modelJobs.sessionTitle;
  const activeProvider = modelConfig?.provider;
  const profileRouteApplies =
    !job?.provider || !activeProvider || job.provider === activeProvider;
  const model =
    args.titleModel ?? (profileRouteApplies ? job?.model : undefined);
  if (!model) return undefined;
  const provider = activeProvider ?? job?.provider;
  if (!provider) {
    throw new Error(
      "Session title model routing requires a provider from the active model config or research profile.",
    );
  }
  const route = {
    provider,
    model,
    effort:
      args.titleEffort ??
      (profileRouteApplies
        ? parseResearchProfileModelJobEffort(job, "sessionTitle")
        : undefined) ??
      "medium",
  };
  validateModelRoute("Session title", route);
  return route;
}

function resolveShellReviewerSelection(
  args: ParsedArgs,
  resolvedResearchProfile: ResolvedResearchProfile,
  provider: string | undefined,
): ShellReviewerSelection | undefined {
  if (!provider) return undefined;
  const job = resolvedResearchProfile.profile.modelJobs.shellReview;
  const profileRouteApplies = !job?.provider || job.provider === provider;
  const model =
    args.shellReviewModels?.[provider] ??
    (profileRouteApplies ? job?.model : undefined) ??
    DEFAULT_SHELL_REVIEW_MODELS[provider];
  if (!model) return undefined;
  const selection: ShellReviewerSelection = {
    provider,
    model,
    reasoningEffort:
      args.shellReviewEffort ??
      (profileRouteApplies
        ? parseResearchProfileModelJobEffort(job, "shellReview")
        : undefined) ??
      "medium",
  };
  validateModelRoute("Shell review", {
    provider: selection.provider,
    model: selection.model,
    effort: selection.reasoningEffort,
  });
  return selection;
}

function parseResearchProfileModelJobEffort(
  job: ResearchProfileModelJob | undefined,
  name: string,
): ResearchModelEffort | undefined {
  if (!job?.effort) return undefined;
  try {
    return parseReasoning(job.effort);
  } catch {
    throw new Error(
      `Research profile ${name} effort is unsupported: ${job.effort}.`,
    );
  }
}

function validateModelRoute(
  label: string,
  route: ResolvedSessionTitleRoute,
): void {
  const provider = getProviderModelCatalog(route.provider)[0];
  const model = provider?.models.find((entry) => entry.id === route.model);
  if (!provider || !model) {
    throw new Error(`${label} model is unavailable: ${route.provider}/${route.model}.`);
  }
  if (!model.effortLevels.includes(route.effort)) {
    throw new Error(
      `${label} effort ${route.effort} is unavailable for ${route.provider}/${route.model}.`,
    );
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  try {
    if (argv[0] === "auth") {
      await handleAuthCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "models") {
      handleModelsCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "memory") {
      await handleMemoryCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "profile") {
      await handleProfileCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "tools") {
      await handleToolsCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "config") {
      await handleConfigCommand(argv.slice(1));
      return;
    }

    const args = parseArgs(argv);

    if (args.help) {
      console.log(usage());
      return;
    }

    if (args.version) {
      console.log(VERSION);
      return;
    }

    if (!args.prompt) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }
    if (args.goal && args.mock) {
      throw new Error("--goal requires the Pi agent executor and cannot be combined with --mock.");
    }

    const { resolvedResearchProfile, workflow } = await resolveCliResearchProfile(args);

    const liveEventSink = args.eventStream ? createCliLiveEventSink() : undefined;
    const controlStream = args.controlStream
      ? new HoneycrispControlStream(input, (event) => {
          void liveEventSink?.({
            schemaVersion: 1,
            kind: "agent.event",
            timestamp: new Date().toISOString(),
            payload: { eventType: "control.received", ...event },
          });
        })
      : undefined;
    controlStream?.start();
    let runtimeConfig: Awaited<ReturnType<typeof createRuntimeConfig>> | undefined;
    try {
      let modelConfig: ResolvedResearchModelConfig | undefined;
      let shellNetworkAuthorization = defaultCliShellNetworkAuthorization();
      const shellAuthorizer = createShellSafetyAuthorizer({
        researchProfileName: resolvedResearchProfile.profile.name,
        getMode: () => controlStream?.getShellSafetyMode() ?? args.shellSafetyMode,
        getNetworkAuthorization: () => shellNetworkAuthorization,
        getReviewerSelection: (): ShellReviewerSelection | undefined => {
          const provider =
            controlStream?.getModelSelection()?.provider ??
            modelConfig?.provider ??
            args.provider;
          return resolveShellReviewerSelection(
            args,
            resolvedResearchProfile,
            provider,
          );
        },
        requestManualApproval: (request, signal) => {
          if (!controlStream || !liveEventSink) {
            return Promise.resolve({
              decision: "denied",
              reason: "Manual Approval requires both the control stream and live event stream.",
            });
          }
          return controlStream.waitForShellApproval(request.approvalRequestId, signal);
        },
        onRequested: (event) => emitShellSafetyEvent(liveEventSink, event),
        onResolved: (event) => emitShellSafetyEvent(liveEventSink, event),
      });
      runtimeConfig = await createRuntimeConfig({
        ...args,
        shellAuthorizer,
        resolvedResearchProfile,
      });
      shellNetworkAuthorization = runtimeConfig.shellNetworkAuthorization;
      const dispositionRecorder = runtimeConfig.dispositionRecorder;
      let resumableState: PiAgentResumableState | undefined;
      let effectivePrompt = args.resumeFallbackPrompt ?? args.prompt;
      const agentExecutor = args.mock
        ? createDeterministicAgentExecutor()
        : createRealAgentExecutor(
            args,
            resolvedResearchProfile,
            workflow.id,
            runtimeConfig.toolRegistry,
            (modelConfig = await resolveResearchModelConfig({
              workspaceRoot: args.workspaceRoot,
              ...(args.configPath ? { configPath: args.configPath } : {}),
              ...(args.provider ? { provider: args.provider } : {}),
              ...(args.model ? { model: args.model } : {}),
              ...(args.reasoning ? { effort: args.reasoning } : {}),
            })),
            runtimeConfig.dispositionRecorder,
            controlStream,
            (resumableState = args.resumeCapturePath
              ? await loadCompatibleResumeState(
                  args.resumeCapturePath,
                  modelConfig,
                  resolvedResearchProfile.hash,
                  workflow.id,
                )
              : undefined),
          );
      if (resumableState) effectivePrompt = args.prompt;
      const sessionTitleRoute = args.mock
        ? undefined
        : resolveSessionTitleRoute(args, resolvedResearchProfile, modelConfig);
      const sessionTitle = startSessionTitleGeneration(
        { ...args, prompt: effectivePrompt },
        sessionTitleRoute,
        resolvedResearchProfile,
        liveEventSink,
        controlStream?.signal,
      );

      const inspectionState =
        runtimeConfig.events.length > 0
          ? { events: runtimeConfig.events }
          : {};

      const result = await runResearchAgent({
        prompt: effectivePrompt,
        workspaceRoot: args.workspaceRoot,
        workspaceContext: runtimeConfig.workspaceContext,
        memoryContext: runtimeConfig.memoryContext,
        ...inspectionState,
        ...(runtimeConfig.tools.length > 0 ? { tools: runtimeConfig.tools } : {}),
        ...(runtimeConfig.skills.length > 0 ? { skills: runtimeConfig.skills } : {}),
        // Passing an explicit (possibly empty) host selection makes the CLI's
        // skill authority visible at the runResearchAgent boundary.
        selectedSkillIds: runtimeConfig.runtimeTools.selectedSkillIds,
        ...(runtimeConfig.governance ? { governance: runtimeConfig.governance } : {}),
        resolvedResearchProfile,
        workflowId: workflow.id,
        researchIntent: {
          successGates: args.successGates,
          failureOrStopGates: args.failureOrStopGates,
          scopeConstraints: args.scopeConstraints,
          evidenceRequirements: args.evidenceRequirements,
          initialRiskFlags: args.initialRiskFlags,
          userPreferences: args.userPreferences,
        },
        executor: agentExecutor,
        finalDispositionProvider: () => dispositionRecorder.get(),
        ...(liveEventSink ? { eventSink: liveEventSink } : {}),
        ...(controlStream ? { signal: controlStream.signal } : {}),
      });
      await sessionTitle;

      if (args.capturePath) {
        const capturePath = await writeFlowCapture(
          args.capturePath,
          result,
          {
            ...runtimeConfig.capture,
            modelConfig: modelConfig
              ? createModelConfigCapture(modelConfig)
              : { mode: "mock" },
          },
        );
        if (!args.json) {
          if (!args.eventStream) console.log(`Flow capture: ${capturePath}`);
        }
      }

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!args.eventStream) console.log(result.response);
    } finally {
      controlStream?.close();
      await runtimeConfig?.cleanup?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`honeycrisp: ${message}`);
    process.exitCode = 1;
  }
}

function startSessionTitleGeneration(
  args: ParsedArgs,
  route: ResolvedSessionTitleRoute | undefined,
  resolvedResearchProfile: ResolvedResearchProfile,
  liveEventSink: ResearchLiveEventSink | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (args.mock || !route || !liveEventSink || !args.prompt) {
    return Promise.resolve();
  }
  return generateResearchSessionTitle({
    provider: route.provider,
    model: route.model,
    prompt: args.prompt,
    effort: route.effort,
    researchProfile: resolvedResearchProfile.profile,
    ...(signal ? { signal } : {}),
  })
    .then((title) =>
      liveEventSink({
        schemaVersion: 1,
        kind: "session.title",
        timestamp: new Date().toISOString(),
        payload: {
          status: "generated",
          title,
          provider: route.provider,
          model: route.model,
          effort: route.effort,
        },
      }),
    )
    .catch((error) =>
      liveEventSink({
        schemaVersion: 1,
        kind: "session.title",
        timestamp: new Date().toISOString(),
        payload: {
          status: "error",
          provider: route.provider,
          model: route.model,
          effort: route.effort,
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      }),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

async function loadCompatibleResumeState(
  capturePath: string,
  modelConfig: ResolvedResearchModelConfig,
  researchProfileHash: string,
  workflowId: string,
): Promise<PiAgentResumableState | undefined> {
  try {
    const capture = JSON.parse(await readFile(resolve(capturePath), "utf8")) as unknown;
    if (!isRecord(capture) || !isRecord(capture.agent)) return undefined;
    return extractCompatiblePiAgentResumableState(
      capture.agent.raw,
      modelConfig.provider,
      modelConfig.model,
      { researchProfileHash, workflowId },
    );
  } catch {
    return undefined;
  }
}

function createRealAgentExecutor(
  args: ParsedArgs,
  resolvedResearchProfile: ResolvedResearchProfile,
  workflowId: string,
  toolRegistry: ResearchToolRegistry | undefined,
  modelConfig: ResolvedResearchModelConfig,
  dispositionRecorder: ResearchDispositionRecorder,
  controlStream: HoneycrispControlStream | undefined,
  resumableState?: PiAgentResumableState,
): ResearchAgentExecutor {
  const providerSessionId = args.sessionId?.trim() || resumableState?.providerSessionId;
  const executorInput = {
    provider: modelConfig.provider,
    model: modelConfig.model,
    ...(providerSessionId ? { sessionId: providerSessionId } : {}),
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    ...(modelConfig.effort ? { reasoning: modelConfig.effort } : {}),
    ...(toolRegistry ? { toolRegistry } : {}),
  };

  return createPiAgentExecutor({
    ...executorInput,
    ...(args.goal
      ? {
          goal: {
            objective: selectResearchGoalObjective({
              ...(args.goalObjective !== undefined ? { explicitObjective: args.goalObjective } : {}),
              ...(resumableState?.goal ? { resumedGoal: resumableState.goal } : {}),
              prompt: args.prompt!,
            }),
            getDisposition: () => dispositionRecorder.get(),
            resetDisposition: () => dispositionRecorder.resetForGoalContinuation(),
          },
        }
      : {}),
    ...(args.toolExecution ? { toolExecution: args.toolExecution } : {}),
    researchProfile: resolvedResearchProfile.profile,
    workflowId,
    ...(resolvedResearchProfile.profile.capabilities.collaborationEnabled
      ? {}
      : { subagents: false as const }),
    ...(resumableState ? { resumableState } : {}),
    ...(controlStream
      ? {
          getModelSelection: () => controlStream.getModelSelection(),
          getSteeringMessages: async () =>
            (await controlStream.takeSteeringInstructions()).map((instruction) => ({
              role: "user" as const,
              content: `User steering for the active research run:\n\n${instruction}`,
              timestamp: Date.now(),
            })),
          waitForSteeringMessages: async (signal?: AbortSignal) =>
            (await controlStream.waitForSteeringInstructions(signal)).map((instruction) => ({
              role: "user" as const,
              content: `User steering for the active research run:\n\n${instruction}`,
              timestamp: Date.now(),
            })),
        }
      : {}),
  });
}

function createModelConfigCapture(
  modelConfig: ResolvedResearchModelConfig,
): Record<string, unknown> {
  return {
    provider: modelConfig.provider,
    model: modelConfig.model,
    ...(modelConfig.effort ? { effort: modelConfig.effort } : {}),
    source: modelConfig.source,
    ...(modelConfig.configPath ? { configPath: modelConfig.configPath } : {}),
  };
}

function createCliLiveEventSink(): ResearchLiveEventSink {
  return (event) => {
    output.write(`${LIVE_EVENT_PREFIX}${JSON.stringify(event)}\n`);
  };
}

async function emitShellSafetyEvent(
  sink: ResearchLiveEventSink | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await sink?.({
    schemaVersion: 1,
    kind: "agent.event",
    timestamp: new Date().toISOString(),
    payload,
  });
}

async function handleMemoryCommand(argv: readonly string[]): Promise<void> {
  const args = parseMemoryArgs(argv);
  if (!args.command || args.help) {
    console.log(memoryUsage());
    return;
  }
  const resolvedProfile = await resolveResearchProfile({
    workspaceRoot: args.workspaceRoot,
    ...(args.profilePath ? { profilePath: args.profilePath } : {}),
  });
  const store = new MemoryGraphStore({
    workspaceRoot: args.workspaceRoot,
    resolvedProfile,
  });
  try {
    if (args.command === "list" || args.command === "search") {
      const query = args.command === "search" ? args.positionals.join(" ") : "";
      const nodes = store.search({
        ...(query ? { query } : {}),
        ...(args.types.length ? { types: args.types } : {}),
        ...(args.status ? { statuses: [args.status as MemoryNodeStatus] } : {}),
        ...(args.assetIds.length ? { assetIds: args.assetIds } : {}),
        ...(args.tags.length ? { tags: args.tags } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      });
      printMemoryOutput(args, nodes, (value) => value.length ? value.map((node) => `${node.id}\t${node.type}\t${node.status}\t${node.title}`).join("\n") : "No durable knowledge nodes found.");
      return;
    }
    if (args.command === "get") {
      const id = requireMemoryPositional(args, "get <node-id>");
      const node = store.get(id);
      printMemoryOutput(args, node, (value) => value ? JSON.stringify(value, null, 2) : `No durable knowledge node found: ${id}`);
      return;
    }
    if (args.command === "save") {
      const type = requireMemoryPositional(args, "save <type> <title>") as MemoryNodeType;
      const title = args.positionals[1];
      if (!title) throw new Error("save requires a quoted title after the node type.");
      const node = store.save({
        type,
        title,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.status ? { status: args.status as MemoryNodeStatus } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        ...(args.assetIds.length ? { assetIds: args.assetIds } : {}),
        ...(args.tags.length ? { tags: args.tags } : {}),
        ...(args.attributes !== undefined ? { attributes: args.attributes } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      });
      printMemoryOutput(args, node, (value) => `${value.id}\t${value.type}\t${value.status}\t${value.title}`);
      return;
    }
    if (args.command === "correct") {
      const id = requireMemoryPositional(args, "correct <node-id> --expected-revision <n>");
      if (args.expectedRevision === undefined) throw new Error("correct requires --expected-revision.");
      if (args.types.length > 1) throw new Error("correct accepts at most one --type value.");
      const node = store.correct(id, args.expectedRevision, {
        ...(args.types[0] ? { type: args.types[0] } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.status ? { status: args.status as MemoryNodeStatus } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        ...(args.assetIds.length ? { assetIds: args.assetIds } : {}),
        ...(args.tags.length ? { tags: args.tags } : {}),
        ...(args.attributes !== undefined ? { attributes: args.attributes } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      });
      printMemoryOutput(args, node, (value) => `${value.id}\trevision ${value.revision}\t${value.status}\t${value.title}`);
      return;
    }
    if (args.command === "link") {
      const [fromId, toId, relation] = args.positionals;
      if (!fromId || !toId || !relation) throw new Error("link requires <from-id> <to-id> <relation>.");
      const edge = store.link(fromId, toId, relation, args.summary ?? "");
      printMemoryOutput(args, edge, (value) => `${value.fromId}\t${value.relation}\t${value.toId}`);
      return;
    }
    if (args.command === "state") {
      const nodes = store.search({ limit: 100 });
      const edges = store.listEdges();
      const state = {
        databasePath: store.databasePath,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        typeCounts: countStrings(nodes.map((node) => node.type)),
        statusCounts: countStrings(nodes.map((node) => node.status)),
        nodes,
        edges,
      };
      printMemoryOutput(args, state, (value) => [`Database: ${value.databasePath}`, `Nodes: ${value.nodeCount}`, `Relationships: ${value.edgeCount}`].join("\n"));
      return;
    }
    throw new Error(`Unknown memory command: ${args.command}`);
  } finally {
    store.close();
  }
}

function requireMemoryPositional(args: ParsedMemoryArgs, usage: string): string {
  const value = args.positionals[0];
  if (!value) throw new Error(`memory ${usage}`);
  return value;
}

function printMemoryOutput<T>(
  args: ParsedMemoryArgs,
  value: T,
  render: (value: T) => string,
): void {
  console.log(args.json ? JSON.stringify(value, null, 2) : render(value));
}

function countStrings(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

async function handleToolsCommand(argv: readonly string[]): Promise<void> {
  if (argv[0] === "config") {
    await handleToolsConfigCommand(argv.slice(1));
    return;
  }

  const args = parseToolsArgs(argv);

  if (!args.command || args.help) {
    console.log(toolsUsage());
    return;
  }

  if (args.command !== "list") {
    throw new Error(`Unknown tools command: ${args.command}`);
  }

  const runtime = await createRuntimeConfig(args);
  try {
    if (args.json) {
      console.log(JSON.stringify(runtime.capture, null, 2));
      return;
    }

    console.log(renderToolsList(runtime.capture));
  } finally {
    await runtime.cleanup?.();
  }
}

async function handleToolsConfigCommand(argv: readonly string[]): Promise<void> {
  const args = parseToolsConfigArgs(argv);

  if (!args.command || args.help) {
    console.log(toolsConfigUsage());
    return;
  }

  if (args.command === "show") {
    if (args.field || args.value) {
      throw new Error("tools config show does not accept positional arguments.");
    }
    const inspection = await createToolConfigInspection(args);
    printConfigOutput(args, inspection, renderToolConfigInspection);
    return;
  }

  if (args.command === "add" || args.command === "remove") {
    if (!args.field || !args.value) {
      throw new Error(`tools config ${args.command} requires a field and value.`);
    }
    const configPath = resolveToolConfigPath(args);
    const exists = await pathExists(configPath);
    const current = exists ? await loadResearchToolConfig(configPath) : {};
    const updated = updateToolConfigArrayPreference(
      current,
      args.command,
      args.field,
      args.value,
    );
    await writeResearchToolConfig({ configPath, preference: updated.preference });
    const inspection = await createToolConfigInspection(args);
    printConfigOutput(
      args,
      {
        updated: updated.change,
        ...inspection,
      },
      (value) => [
        `Updated tool config: ${value.configPath}`,
        renderToolConfigInspection(value),
      ].join("\n"),
    );
    return;
  }

  if (args.command === "set") {
    if (!args.field || !args.value) {
      throw new Error("tools config set requires a field and value.");
    }
    const configPath = resolveToolConfigPath(args);
    const exists = await pathExists(configPath);
    const current = exists ? await loadResearchToolConfig(configPath) : {};
    const updated = updateToolConfigScalarPreference(
      current,
      "set",
      args.field,
      args.value,
    );
    await writeResearchToolConfig({ configPath, preference: updated.preference });
    const inspection = await createToolConfigInspection(args);
    printConfigOutput(
      args,
      {
        updated: updated.change,
        ...inspection,
      },
      (value) => [
        `Updated tool config: ${value.configPath}`,
        renderToolConfigInspection(value),
      ].join("\n"),
    );
    return;
  }

  if (args.command === "clear") {
    if (!args.field || args.value) {
      throw new Error("tools config clear requires exactly one field.");
    }
    const configPath = resolveToolConfigPath(args);
    const exists = await pathExists(configPath);
    const current = exists ? await loadResearchToolConfig(configPath) : {};
    const updated = clearToolConfigPreference(current, args.field);
    await writeResearchToolConfig({ configPath, preference: updated.preference });
    const inspection = await createToolConfigInspection(args);
    printConfigOutput(
      args,
      {
        updated: updated.change,
        ...inspection,
      },
      (value) => [
        `Updated tool config: ${value.configPath}`,
        renderToolConfigInspection(value),
      ].join("\n"),
    );
    return;
  }

  throw new Error(`Unknown tools config command: ${args.command}`);
}

async function handleConfigCommand(argv: readonly string[]): Promise<void> {
  const args = parseConfigArgs(argv);

  if (!args.command || args.help) {
    console.log(configUsage());
    return;
  }

  if (args.command === "show") {
    if (args.field || args.value) {
      throw new Error("config show does not accept positional arguments.");
    }
    const inspection = await createConfigInspection(args);
    printConfigOutput(args, inspection, renderConfigInspection);
    return;
  }

  if (args.command === "set") {
    if (!args.field || !args.value) {
      throw new Error("config set requires: provider <id>, model <id>, or effort <level>.");
    }
    const update = parseConfigSetUpdate(args.field, args.value);
    const configPath = resolveConfigPath(args);
    const exists = await pathExists(configPath);
    const current = exists ? await loadResearchModelConfig(configPath) : {};
    await writeResearchModelConfig({
      configPath,
      preference: {
        ...current,
        ...update,
      },
    });
    const inspection = await createConfigInspection(args);
    printConfigOutput(
      args,
      {
        updated: update,
        ...inspection,
      },
      (value) => [
        `Updated config: ${value.configPath}`,
        renderConfigInspection(value),
      ].join("\n"),
    );
    return;
  }

  throw new Error(`Unknown config command: ${args.command}`);
}

function configUsage(): string {
  return [
    "Usage: honeycrisp config <command> [options]",
    "",
    "Commands:",
    "  show                       Show model preference and authorization status",
    "  set provider <id>          Set preferred provider",
    "  set model <id>             Set preferred model",
    "  set effort <level>         Set effort: minimal, low, medium, high, xhigh, or max",
    "",
    "Options:",
    "  --config <path>            Preference config path",
    "  --workspace-root <path>    Project root for default .honeycrisp/config.json",
    "  --json                     Print JSON",
  ].join("\n");
}

function toolsConfigUsage(): string {
  return [
    "Usage: honeycrisp tools config <command> [options]",
    "",
    "Commands:",
    "  show                              Show persisted runtime tool preferences",
    "  add skill-dir <path>              Add a local skill directory",
    "  remove skill-dir <path>           Remove a local skill directory",
    "  add skill <id>                    Select a loaded skill id",
    "  remove skill <id>                 Deselect a skill id",
    "  set mcp-config <path>             Set the MCP client config path",
    "  clear mcp-config                  Clear the MCP client config path",
    "  add allow-mcp-server <name>       Allow an MCP server name",
    "  remove allow-mcp-server <name>    Remove an allowed MCP server name",
    "  set mcp-timeout-ms <n>            Set MCP request timeout in milliseconds",
    "  clear mcp-timeout-ms              Clear MCP request timeout",
    "",
    "Options:",
    "  --tool-config <path>              Runtime tool preference config path",
    "  --workspace-root <path>           Project root for default .honeycrisp/tools.json",
    "  --json                            Print JSON",
  ].join("\n");
}

async function createToolConfigInspection(args: {
  configPath: string | undefined;
  workspaceRoot: string;
}): Promise<{
  configPath: string;
  exists: boolean;
  preference: ResearchToolConfigPreference;
}> {
  const configPath = resolveToolConfigPath(args);
  const exists = await pathExists(configPath);
  const preference = exists ? await loadResearchToolConfig(configPath) : {};
  return {
    configPath,
    exists,
    preference,
  };
}

function resolveToolConfigPath(args: {
  configPath: string | undefined;
  workspaceRoot: string;
}): string {
  return args.configPath
    ? resolve(args.configPath)
    : getDefaultResearchToolConfigPath(args.workspaceRoot);
}

function renderToolConfigInspection(input: {
  configPath: string;
  exists: boolean;
  preference: ResearchToolConfigPreference;
}): string {
  return [
    `Tool config path: ${input.configPath}`,
    `Tool config exists: ${input.exists ? "yes" : "no"}`,
    `Skill directories: ${renderConfigList(input.preference.skillDirs)}`,
    `Selected skills: ${renderConfigList(input.preference.selectedSkillIds)}`,
    `MCP config: ${input.preference.mcpConfigPath ?? "(not set)"}`,
    `Allowed MCP servers: ${renderConfigList(input.preference.allowedMcpServers)}`,
    `MCP timeout: ${input.preference.mcpTimeoutMs ? `${input.preference.mcpTimeoutMs} ms` : "(default)"}`,
  ].join("\n");
}

function renderConfigList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}

type ToolConfigArrayField =
  | "toolFamilies"
  | "disabledToolFamilies"
  | "repoRoots"
  | "fileReadRoots"
  | "sourcePaths"
  | "projectNotes"
  | "allowedSideEffects"
  | "allowedMcpServers"
  | "selectedSkillIds"
  | "skillDirs";

type ToolConfigScalarField =
  | "workspaceContextPath"
  | "mcpConfigPath"
  | "mcpTimeoutMs"
  | "experimentConfigPath"
  | "toolMaxCalls"
  | "toolRuntimeMs"
  | "toolMaxFiles"
  | "toolMaxBytes"
  | "toolMaxTokens";

function updateToolConfigArrayPreference(
  current: ResearchToolConfigPreference,
  command: "add" | "remove",
  fieldName: string,
  value: string,
): {
  preference: ResearchToolConfigPreference;
  change: Record<string, unknown>;
} {
  const field = parseToolConfigArrayField(fieldName);
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`tools config ${command} ${fieldName} requires a non-empty value.`);
  }

  const existing = current[field] ?? [];
  const next =
    command === "add"
      ? uniqueRuntimeStrings([...existing, trimmed])
      : existing.filter((item) => item !== trimmed);
  return {
    preference: {
      ...current,
      [field]: next,
    },
    change: {
      command,
      field,
      value: trimmed,
    },
  };
}

function updateToolConfigScalarPreference(
  current: ResearchToolConfigPreference,
  command: "set",
  fieldName: string,
  value: string,
): {
  preference: ResearchToolConfigPreference;
  change: Record<string, unknown>;
} {
  const field = parseToolConfigScalarField(fieldName);
  const parsed = parseToolConfigScalarValue(field, value);
  return {
    preference: {
      ...current,
      [field]: parsed,
    },
    change: {
      command,
      field,
      value: parsed,
    },
  };
}

function clearToolConfigPreference(
  current: ResearchToolConfigPreference,
  fieldName: string,
): {
  preference: ResearchToolConfigPreference;
  change: Record<string, unknown>;
} {
  const field = parseToolConfigClearField(fieldName);
  const preference = { ...current };
  delete preference[field];
  return {
    preference,
    change: {
      command: "clear",
      field,
    },
  };
}

function parseToolConfigClearField(
  fieldName: string,
): ToolConfigArrayField | ToolConfigScalarField {
  try {
    return parseToolConfigArrayField(fieldName);
  } catch {
    return parseToolConfigScalarField(fieldName);
  }
}

function parseToolConfigArrayField(fieldName: string): ToolConfigArrayField {
  switch (fieldName) {
    case "tool-family":
    case "toolFamilies":
      return "toolFamilies";
    case "disable-tool-family":
    case "disabled-tool-family":
    case "disabledToolFamilies":
      return "disabledToolFamilies";
    case "repo-root":
    case "repoRoots":
      return "repoRoots";
    case "file-read-root":
    case "fileReadRoots":
      return "fileReadRoots";
    case "source-path":
    case "sourcePaths":
      return "sourcePaths";
    case "project-note":
    case "projectNotes":
      return "projectNotes";
    case "allowed-side-effect":
    case "allowedSideEffects":
      return "allowedSideEffects";
    case "allow-mcp-server":
    case "allowed-mcp-server":
    case "mcp-server":
    case "allowedMcpServers":
      return "allowedMcpServers";
    case "skill":
    case "selected-skill":
    case "selectedSkillIds":
      return "selectedSkillIds";
    case "skill-dir":
    case "skillDirs":
      return "skillDirs";
    default:
      throw new Error(`Unknown tools config list field: ${fieldName}.`);
  }
}

function parseToolConfigScalarField(fieldName: string): ToolConfigScalarField {
  switch (fieldName) {
    case "workspace-context":
    case "workspaceContextPath":
      return "workspaceContextPath";
    case "mcp-config":
    case "mcpConfigPath":
      return "mcpConfigPath";
    case "mcp-timeout-ms":
    case "mcpTimeoutMs":
      return "mcpTimeoutMs";
    case "experiment-config":
    case "experimentConfigPath":
      return "experimentConfigPath";
    case "tool-max-calls":
    case "toolMaxCalls":
      return "toolMaxCalls";
    case "tool-runtime-ms":
    case "toolRuntimeMs":
      return "toolRuntimeMs";
    case "tool-max-files":
    case "toolMaxFiles":
      return "toolMaxFiles";
    case "tool-max-bytes":
    case "toolMaxBytes":
      return "toolMaxBytes";
    case "tool-max-tokens":
    case "toolMaxTokens":
      return "toolMaxTokens";
    default:
      throw new Error(`Unknown tools config scalar field: ${fieldName}.`);
  }
}

function parseToolConfigScalarValue(
  field: ToolConfigScalarField,
  value: string,
): string | number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`tools config set ${field} requires a non-empty value.`);
  }

  if (
    field === "mcpTimeoutMs" ||
    field === "toolMaxCalls" ||
    field === "toolRuntimeMs" ||
    field === "toolMaxFiles" ||
    field === "toolMaxBytes" ||
    field === "toolMaxTokens"
  ) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`tools config set ${field} requires a positive integer.`);
    }
    return parsed;
  }

  return trimmed;
}

async function createConfigInspection(args: {
  configPath: string | undefined;
  workspaceRoot: string;
}): Promise<{
  configPath: string;
  exists: boolean;
  preference: ResearchModelConfigPreference;
  resolved: ResolvedResearchModelConfig | null;
  authorization: {
    authorized: boolean;
    message?: string;
  };
}> {
  const configPath = resolveConfigPath(args);
  const exists = await pathExists(configPath);
  const preference = exists ? await loadResearchModelConfig(configPath) : {};
  try {
    const resolved = await resolveResearchModelConfig({
      workspaceRoot: args.workspaceRoot,
      ...(args.configPath || exists ? { configPath } : {}),
    });
    return {
      configPath,
      exists,
      preference,
      resolved,
      authorization: {
        authorized: true,
      },
    };
  } catch (error) {
    return {
      configPath,
      exists,
      preference,
      resolved: null,
      authorization: {
        authorized: false,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function parseConfigSetUpdate(
  field: string,
  value: string,
): ResearchModelConfigPreference {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`config set ${field} requires a non-empty value.`);
  }

  if (field === "provider") {
    return { provider: trimmed };
  }
  if (field === "model") {
    return { model: trimmed };
  }
  if (field === "effort" || field === "reasoning") {
    return { effort: parseReasoning(trimmed) };
  }

  throw new Error("config set field must be provider, model, or effort.");
}

function resolveConfigPath(args: {
  configPath: string | undefined;
  workspaceRoot: string;
}): string {
  return args.configPath
    ? resolve(args.configPath)
    : getDefaultResearchModelConfigPath(args.workspaceRoot);
}

function printConfigOutput<T>(
  args: { json: boolean },
  value: T,
  render: (value: T) => string,
): void {
  if (args.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(render(value));
}

function renderConfigInspection(input: {
  configPath: string;
  exists: boolean;
  preference: ResearchModelConfigPreference;
  resolved: ResolvedResearchModelConfig | null;
  authorization: {
    authorized: boolean;
    message?: string;
  };
}): string {
  return [
    `Config path: ${input.configPath}`,
    `Config exists: ${input.exists ? "yes" : "no"}`,
    `Provider preference: ${input.preference.provider ?? "(not set)"}`,
    `Model preference: ${input.preference.model ?? "(not set)"}`,
    `Effort preference: ${input.preference.effort ?? "(not set)"}`,
    input.resolved
      ? `Resolved provider: ${input.resolved.provider}`
      : "Resolved provider: (none)",
    input.resolved
      ? `Resolved model: ${input.resolved.model}`
      : "Resolved model: (none)",
    input.resolved
      ? `Resolved source: ${input.resolved.source}`
      : "Resolved source: (none)",
    input.authorization.authorized
      ? "Authorization: authorized"
      : `Authorization: not authorized${input.authorization.message ? ` - ${input.authorization.message}` : ""}`,
  ].join("\n");
}

function toolsUsage(): string {
  return [
    "Usage: honeycrisp tools list [options]",
    "",
    "Options:",
    "  --tool-family <name>        Enable shell, local-inspection, repository-search, file-read, code, analysis, synthesis, storage, or experiment",
    "  --shell-options <path>      Harness-wide shell utility policy JSON",
    "  --disable-tool-family <n>   Disable a tool family after implicit/default enables",
    "  --tool-config <path>        Runtime tool preference config (default: .honeycrisp/tools.json)",
    "  --no-default-tool-config    Ignore .honeycrisp/tools.json unless --tool-config is provided",
    "  --repo-root <path>          Add a known repository context hint and enable repository.search unless disabled",
    "  --file-read-root <path>     Add a file.read context hint and enable file.read unless disabled",
    "  --source-path <path>        Add a materialized source context path",
    "  --project-note <text>       Add a project/workspace note to compiled context",
    "  --workspace-context <path>  JSON workspace context file to merge with CLI hints",
    "  --inspect-root <path>       Enable local.inspection for this root unless disabled",
    "  --allowed-side-effect <s>   Allow side effect: none, read, write, network, process",
    "  --profile-tool-family-ceiling <name> Let the active profile request this family within a host ceiling",
    "  --profile-side-effect-ceiling <s> Let the profile request none, read, write, or process within a host ceiling",
    "  --tool-max-calls <n>        Max tool calls",
    "  --tool-runtime-ms <n>       Max runtime per tool call in milliseconds",
    "  --tool-max-files <n>        Max file count",
    "  --tool-max-bytes <n>        Max file bytes",
    "  --tool-max-tokens <n>       Max tool output tokens",
    "  --allow-mcp-server <name>   Record an allowed MCP server name",
    "  --mcp-config <path>         JSON MCP stdio server config",
    "  --mcp-timeout-ms <n>        MCP request timeout in milliseconds",
    "  --experiment-config <path>  JSON allowlisted experiment config",
    "  --skill-dir <path>          Load local skills from child directories containing SKILL.md",
    "  --skill <id>                Request a loaded skill by id",
    "  --workspace-root <path>     Workspace root for storage.list metadata",
    "  --json                      Print JSON",
  ].join("\n");
}

function renderToolsList(capture: Record<string, unknown>): string {
  const tools = isRecordArray(capture.tools);
  const mcp = isRecord(capture.mcp) ? capture.mcp : {};
  const skills = isRecord(capture.skills) ? capture.skills : {};

  return [
    "Configured tools:",
    ...(tools.length > 0
      ? tools.map((tool) => {
          const name = typeof tool.name === "string" ? tool.name : "unknown";
          const classes = Array.isArray(tool.actionClasses)
            ? tool.actionClasses.join(",")
            : "";
          return `- ${name}${classes ? ` (${classes})` : ""}`;
        })
      : ["- none"]),
    `Allowed MCP servers: ${Array.isArray(mcp.allowedServers) && mcp.allowedServers.length > 0 ? mcp.allowedServers.join(", ") : "none"}`,
    `Loaded skills: ${
      Array.isArray(skills.loaded) && skills.loaded.length > 0
        ? skills.loaded
            .map((skill) =>
              isRecord(skill) && typeof skill.id === "string" ? skill.id : "unknown",
            )
            .join(", ")
        : "none"
    }`,
    `Selected skills: ${Array.isArray(skills.selectedIds) && skills.selectedIds.length > 0 ? skills.selectedIds.join(", ") : "none"}`,
  ].join("\n");
}

function memoryUsage(): string {
  return [
    "Usage: honeycrisp memory <command> [options]",
    "",
    "Commands:",
    "  state                     Summarize durable knowledge",
    "  list                      List durable knowledge nodes",
    "  search <query>            Search durable knowledge nodes",
    "  get <node-id>             Show one node and its evidence",
    "  save <type> <title>       Add or refine a node",
    "  correct <node-id>         Correct a node by revision",
    "  link <from> <to> <rel>    Link two nodes",
    "",
    "Options:",
    "  --workspace-root <path>  Workspace root containing .honeycrisp memory",
    "  --profile <path>         Explicit research profile (otherwise use the workspace default)",
    "  --type <type>           Filter nodes; with correct, reclassify one node",
    "  --status <status>       Filter or set node status",
    "  --tag <tag>             Filter or add a tag (repeatable)",
    "  --asset <asset-id>      Filter or add an asset link (repeatable)",
    "  --summary <text>        Set a concise summary or relationship note",
    "  --body <text>           Set supporting detail",
    "  --attributes-json <obj> Set profile-defined attributes (save/correct; 64,000 characters)",
    "  --evidence-json <json>  Set evidence object/array (save/correct; repeatable, 64 items)",
    "  --confidence <0..1>     Set confidence",
    "  --expected-revision <n> Required for exact correction",
    "  --limit <n>             Limit returned nodes",
    "  --json                  Print JSON",
    "  -h, --help              Show help",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

await main();

async function createRuntimeConfig(args: {
  prompt?: string | undefined;
  inspectRoots: string[];
  inspectPaths: string[];
  inspectAction: LocalInspectionAction;
  inspectBytes: number | undefined;
  runtimeTools: RuntimeToolConfig;
  workspaceRoot?: string;
  shellAuthorizer?: ShellCommandAuthorizer;
  resolvedResearchProfile?: ResolvedResearchProfile;
}): Promise<{
  events: ResearchEvent[];
  tools: ResearchToolDescriptor[];
  toolRegistry: ResearchToolRegistry | undefined;
  skills: ResearchSkillDescriptor[];
  governance: ResearchGovernancePolicy | undefined;
  workspaceContext: ResearchWorkspaceContext;
  memoryContext: readonly ResearchModelMemoryContextNode[];
  runtimeTools: RuntimeToolConfig;
  capture: Record<string, unknown>;
  dispositionRecorder: ResearchDispositionRecorder;
  memoryGraph: MemoryGraphStore;
  shellNetworkAuthorization: ShellNetworkAuthorization;
  cleanup?: () => Promise<void>;
}> {
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const resolvedResearchProfile = args.resolvedResearchProfile ?? await resolveResearchProfile({
    workspaceRoot,
  });
  const resolvedRuntimeTools = await resolveRuntimeToolConfig({
    runtimeTools: args.runtimeTools,
    workspaceRoot,
  });
  const runtimeTools = applyResearchProfileCapabilityDefaults(
    resolvedRuntimeTools.runtimeTools,
    resolvedResearchProfile,
  );
  const runtimeArgs = { ...args, runtimeTools };
  const families = resolveEnabledToolFamilies(runtimeArgs);
  const executableTools: ResearchExecutableTool[] = [];
  const toolDescriptors: ResearchToolDescriptor[] = [];
  const events: ResearchEvent[] = [];
  const profileDisabledSkillIds = new Set(
    resolvedResearchProfile.profile.capabilities.disabledSkillIds,
  );
  const explicitlySelectedSkillIds = new Set(runtimeTools.selectedSkillIds);
  const skills = loadCliSkills(runtimeTools.skillDirs).filter(
    (skill) =>
      !profileDisabledSkillIds.has(skill.id) ||
      explicitlySelectedSkillIds.has(skill.id),
  );
  const governance = createCliGovernance(runtimeTools);
  const cleanupCallbacks: (() => Promise<void>)[] = [];
  const dispositionRecorder = new ResearchDispositionRecorder();
  const dispositionTool = createSessionDispositionTool(dispositionRecorder);
  executableTools.push(dispositionTool);
  toolDescriptors.push(dispositionTool.descriptor);
  const storageLayout = createResearchStorageLayout({
    workspaceRoot,
  });
  const workspaceContext = mergeResearchWorkspaceContexts({
    base: createResearchWorkspaceContext({
      workspaceRoot,
      knownRepositories: runtimeTools.repoRoots.map((root) => ({
        rootPath: root,
        role: "known_repository",
        source: "cli",
      })),
      materializedSourcePaths: runtimeTools.sourcePaths,
      projectNotes: runtimeTools.projectNotes,
    }),
    ...(runtimeTools.workspaceContextPath
      ? {
          overlay: loadResearchWorkspaceContextFile(
            runtimeTools.workspaceContextPath,
          ),
        }
      : {}),
  });
  const shellNetworkAuthorization = resolveCliShellNetworkAuthorization(
    workspaceContext,
    runtimeTools,
  );
  const memoryGraph = new MemoryGraphStore({
    workspaceRoot,
    resolvedProfile: resolvedResearchProfile,
    ...(workspaceContext.memoryContext
      ? {
          context: workspaceContext.memoryContext,
        }
      : {}),
  });
  const memoryTools = resolvedResearchProfile.profile.capabilities.memoryEnabled
    ? createMemoryGraphTools(memoryGraph)
    : [];
  executableTools.push(...memoryTools);
  toolDescriptors.push(...memoryTools.map((tool) => tool.descriptor));
  cleanupCallbacks.push(async () => memoryGraph.close());
  if (resolvedResearchProfile.profile.capabilities.runbooksEnabled) {
    const runbooks = new RunbookStore(
      memoryGraph.databasePath,
      storageLayout,
      memoryGraph.getContext(),
    );
    const runbookTools = createRunbookTools(runbooks);
    executableTools.push(...runbookTools);
    toolDescriptors.push(...runbookTools.map((tool) => tool.descriptor));
    cleanupCallbacks.push(async () => runbooks.close());
  }
  const memoryContext = args.prompt && resolvedResearchProfile.profile.capabilities.memoryEnabled
    ? compileMemoryModelContext(memoryGraph, args.prompt)
    : [];
  const mcpCapture = await configureRuntimeMcpTools({
    runtimeTools,
    executableTools,
    toolDescriptors,
    cleanupCallbacks,
  });

  validateSelectedSkillIds(skills, runtimeTools.selectedSkillIds);

  if (families.has("local-inspection")) {
    if (args.inspectRoots.length === 0) {
      throw new Error("local-inspection requires at least one --inspect-root.");
    }

    const tool = createLocalInspectionTool({
      allowedRoots: args.inspectRoots,
      ...(args.inspectBytes ? { maxBytes: args.inspectBytes } : {}),
    });
    executableTools.push(tool.executable);
    toolDescriptors.push(tool.descriptor);

    for (const path of args.inspectPaths) {
      const result = await tool.inspect({
        action: args.inspectAction,
        path,
        ...(args.inspectBytes ? { maxBytes: args.inspectBytes } : {}),
      });
      events.push(createLocalInspectionObservationEvent(result));
    }
  } else if (args.inspectPaths.length > 0) {
    throw new Error(
      "--inspect-path requires local-inspection; remove --disable-tool-family local-inspection.",
    );
  }

  if (families.has("shell")) {
    const tool = createShellTool({
      workspaceRoot,
      ...(args.shellAuthorizer ? { authorize: args.shellAuthorizer } : {}),
      ...(runtimeTools.shellOptionsPath
        ? { shellOptionsPath: runtimeTools.shellOptionsPath }
        : {}),
      ...(runtimeTools.toolMaxBytes
        ? { maxOutputBytes: runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("repository-search")) {
    const tool = createRepositorySearchTool({
      roots: repositorySearchRootsFromWorkspaceContext(workspaceContext),
      ...(runtimeTools.toolMaxBytes
        ? { maxFileBytes: runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("file-read")) {
    const tool = createStructuredFileReadTool({
      contextRoots: workspaceContextFileReadHints(workspaceContext),
      ...(runtimeTools.toolMaxBytes
        ? { maxBytes: runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("code")) {
    const tools = createCodeIntelligenceTools({
      roots: repositorySearchRootsFromWorkspaceContext(workspaceContext),
      ...(runtimeTools.toolMaxBytes
        ? { maxFileBytes: runtimeTools.toolMaxBytes }
        : {}),
      ...(runtimeTools.toolMaxFiles
        ? { maxFiles: runtimeTools.toolMaxFiles }
        : {}),
    });
    executableTools.push(...tools);
    toolDescriptors.push(...tools.map((tool) => tool.descriptor));
  }

  if (families.has("analysis")) {
    const tool = createAnalysisTool();
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("synthesis")) {
    const tool = createSynthesisTool();
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("experiment")) {
    if (!runtimeTools.experimentConfigPath) {
      throw new Error("experiment tool family requires --experiment-config.");
    }
    const tool = createConfiguredExperimentTool({
      config: loadResearchExperimentConfig(runtimeTools.experimentConfigPath),
      storageLayout,
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("storage")) {
    const tool = createStorageListTool({
      storageLayout,
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  return {
    events,
    tools: toolDescriptors,
    toolRegistry:
      executableTools.length > 0
        ? createResearchToolRegistry(executableTools)
        : undefined,
    skills,
    governance,
    workspaceContext,
    memoryContext,
    runtimeTools,
    dispositionRecorder,
    memoryGraph,
    shellNetworkAuthorization,
    capture: createRuntimeCapture({
      families,
      args: runtimeArgs,
      tools: toolDescriptors,
      skills,
      governance,
      workspaceContext,
      shellNetworkAuthorization,
      toolConfigCapture: resolvedRuntimeTools.capture,
      ...(mcpCapture ? { mcpCapture } : {}),
    }),
    ...(cleanupCallbacks.length > 0
      ? {
          async cleanup() {
            await Promise.all(cleanupCallbacks.map((cleanup) => cleanup()));
          },
        }
      : {}),
  };
}

async function resolveRuntimeToolConfig(input: {
  runtimeTools: RuntimeToolConfig;
  workspaceRoot: string;
}): Promise<ResolvedRuntimeToolConfig> {
  const configPath = input.runtimeTools.toolConfigPath
    ? resolve(input.runtimeTools.toolConfigPath)
    : getDefaultResearchToolConfigPath(input.workspaceRoot);
  const shouldLoad =
    Boolean(input.runtimeTools.toolConfigPath) ||
    !input.runtimeTools.disableDefaultToolConfig;
  const exists = shouldLoad ? await pathExists(configPath) : false;
  if (input.runtimeTools.toolConfigPath && !exists) {
    throw new Error(`Research tool config file not found: ${configPath}`);
  }

  const preference = exists ? await loadResearchToolConfig(configPath) : {};
  const persisted = runtimeToolConfigFromPreference(
    preference,
    input.runtimeTools,
  );
  return {
    runtimeTools: mergeRuntimeToolConfig(persisted, input.runtimeTools),
    capture: {
      configPath,
      exists,
      loaded: exists,
      defaultDisabled:
        input.runtimeTools.disableDefaultToolConfig &&
        !input.runtimeTools.toolConfigPath,
      preference,
    },
  };
}

function runtimeToolConfigFromPreference(
  preference: ResearchToolConfigPreference,
  runtimeTools: RuntimeToolConfig,
): RuntimeToolConfig {
  return {
    toolFamilies: (preference.toolFamilies ?? []).map(parseToolFamily),
    disabledToolFamilies: (preference.disabledToolFamilies ?? []).map(parseToolFamily),
    profileToolFamilyCeiling: [],
    repoRoots: preference.repoRoots ?? [],
    fileReadRoots: preference.fileReadRoots ?? [],
    sourcePaths: preference.sourcePaths ?? [],
    projectNotes: preference.projectNotes ?? [],
    ...(preference.workspaceContextPath
      ? { workspaceContextPath: preference.workspaceContextPath }
      : {}),
    allowedSideEffects: (preference.allowedSideEffects ?? []).map(parseToolSideEffect),
    profileSideEffectCeiling: [],
    allowedMcpServers: preference.allowedMcpServers ?? [],
    profileMcpServerRestriction: [],
    ...(preference.mcpConfigPath ? { mcpConfigPath: preference.mcpConfigPath } : {}),
    ...(preference.mcpTimeoutMs ? { mcpTimeoutMs: preference.mcpTimeoutMs } : {}),
    ...(preference.experimentConfigPath
      ? { experimentConfigPath: preference.experimentConfigPath }
      : {}),
    selectedSkillIds: preference.selectedSkillIds ?? [],
    skillDirs: preference.skillDirs ?? [],
    ...(preference.toolMaxCalls ? { toolMaxCalls: preference.toolMaxCalls } : {}),
    ...(preference.toolRuntimeMs ? { toolRuntimeMs: preference.toolRuntimeMs } : {}),
    ...(preference.toolMaxFiles ? { toolMaxFiles: preference.toolMaxFiles } : {}),
    ...(preference.toolMaxBytes ? { toolMaxBytes: preference.toolMaxBytes } : {}),
    ...(preference.toolMaxTokens ? { toolMaxTokens: preference.toolMaxTokens } : {}),
    ...(runtimeTools.toolConfigPath ? { toolConfigPath: runtimeTools.toolConfigPath } : {}),
    ...(runtimeTools.shellOptionsPath
      ? { shellOptionsPath: runtimeTools.shellOptionsPath }
      : {}),
    disableDefaultToolConfig: runtimeTools.disableDefaultToolConfig,
  };
}

function mergeRuntimeToolConfig(
  persisted: RuntimeToolConfig,
  cli: RuntimeToolConfig,
): RuntimeToolConfig {
  return {
    toolFamilies: uniqueRuntimeStrings([
      ...persisted.toolFamilies,
      ...cli.toolFamilies,
    ]) as ToolFamily[],
    disabledToolFamilies: uniqueRuntimeStrings([
      ...persisted.disabledToolFamilies,
      ...cli.disabledToolFamilies,
    ]) as ToolFamily[],
    profileToolFamilyCeiling: uniqueRuntimeStrings([
      ...persisted.profileToolFamilyCeiling,
      ...cli.profileToolFamilyCeiling,
    ]) as ToolFamily[],
    repoRoots: uniqueRuntimeStrings([...persisted.repoRoots, ...cli.repoRoots]),
    fileReadRoots: uniqueRuntimeStrings([
      ...persisted.fileReadRoots,
      ...cli.fileReadRoots,
    ]),
    sourcePaths: uniqueRuntimeStrings([
      ...persisted.sourcePaths,
      ...cli.sourcePaths,
    ]),
    projectNotes: uniqueRuntimeStrings([
      ...persisted.projectNotes,
      ...cli.projectNotes,
    ]),
    ...(cli.workspaceContextPath || persisted.workspaceContextPath
      ? { workspaceContextPath: cli.workspaceContextPath ?? persisted.workspaceContextPath }
      : {}),
    allowedSideEffects: uniqueRuntimeStrings([
      ...persisted.allowedSideEffects,
      ...cli.allowedSideEffects,
    ]) as ResearchToolSideEffect[],
    profileSideEffectCeiling: uniqueRuntimeStrings([
      ...persisted.profileSideEffectCeiling,
      ...cli.profileSideEffectCeiling,
    ]) as ResearchToolSideEffect[],
    allowedMcpServers: uniqueRuntimeStrings([
      ...persisted.allowedMcpServers,
      ...cli.allowedMcpServers,
    ]),
    profileMcpServerRestriction: uniqueRuntimeStrings([
      ...persisted.profileMcpServerRestriction,
      ...cli.profileMcpServerRestriction,
    ]),
    ...(cli.mcpConfigPath || persisted.mcpConfigPath
      ? { mcpConfigPath: cli.mcpConfigPath ?? persisted.mcpConfigPath }
      : {}),
    ...(cli.mcpTimeoutMs || persisted.mcpTimeoutMs
      ? { mcpTimeoutMs: cli.mcpTimeoutMs ?? persisted.mcpTimeoutMs }
      : {}),
    ...(cli.experimentConfigPath || persisted.experimentConfigPath
      ? {
          experimentConfigPath:
            cli.experimentConfigPath ?? persisted.experimentConfigPath,
        }
      : {}),
    ...(cli.shellOptionsPath || persisted.shellOptionsPath
      ? { shellOptionsPath: cli.shellOptionsPath ?? persisted.shellOptionsPath }
      : {}),
    selectedSkillIds: uniqueRuntimeStrings([
      ...persisted.selectedSkillIds,
      ...cli.selectedSkillIds,
    ]),
    skillDirs: uniqueRuntimeStrings([...persisted.skillDirs, ...cli.skillDirs]),
    ...(cli.toolMaxCalls || persisted.toolMaxCalls
      ? { toolMaxCalls: cli.toolMaxCalls ?? persisted.toolMaxCalls }
      : {}),
    ...(cli.toolRuntimeMs || persisted.toolRuntimeMs
      ? { toolRuntimeMs: cli.toolRuntimeMs ?? persisted.toolRuntimeMs }
      : {}),
    ...(cli.toolMaxFiles || persisted.toolMaxFiles
      ? { toolMaxFiles: cli.toolMaxFiles ?? persisted.toolMaxFiles }
      : {}),
    ...(cli.toolMaxBytes || persisted.toolMaxBytes
      ? { toolMaxBytes: cli.toolMaxBytes ?? persisted.toolMaxBytes }
      : {}),
    ...(cli.toolMaxTokens || persisted.toolMaxTokens
      ? { toolMaxTokens: cli.toolMaxTokens ?? persisted.toolMaxTokens }
      : {}),
    ...(cli.toolConfigPath ? { toolConfigPath: cli.toolConfigPath } : {}),
    disableDefaultToolConfig: cli.disableDefaultToolConfig,
  };
}

function applyResearchProfileCapabilityDefaults(
  runtimeTools: RuntimeToolConfig,
  resolvedResearchProfile: ResolvedResearchProfile,
): RuntimeToolConfig {
  const capabilities = resolvedResearchProfile.profile.capabilities;
  const hostRequestedFamilies = new Set(runtimeTools.toolFamilies);
  const trustedBundledDefaults = resolvedResearchProfile.source === "bundled-default";
  const hostFamilyCeiling = new Set(runtimeTools.profileToolFamilyCeiling);
  const hostSideEffectCeiling = new Set(runtimeTools.profileSideEffectCeiling);
  const profileDefaultFamilies = trustedBundledDefaults
    ? capabilities.defaultToolFamilies.map(parseToolFamily)
    : capabilities.defaultToolFamilies
        .map(parseToolFamily)
        .filter((family) => hostFamilyCeiling.has(family));
  const profileDisabledFamilies = capabilities.disabledToolFamilies.map(parseToolFamily);
  const profileHostBoundedSideEffects = trustedBundledDefaults
    ? capabilities.allowedSideEffects.filter(
        (effect) => BUNDLED_IMPLICIT_ALLOWED_SIDE_EFFECTS.has(effect),
      )
    : capabilities.allowedSideEffects.filter(
        (effect) => effect !== "network" && hostSideEffectCeiling.has(effect),
      );
  const allowedSideEffects = trustedBundledDefaults && runtimeTools.allowedSideEffects.length > 0
    ? runtimeTools.allowedSideEffects
    : uniqueRuntimeStrings([
        ...profileHostBoundedSideEffects,
        ...runtimeTools.allowedSideEffects,
      ]) as ResearchToolSideEffect[];

  return {
    ...runtimeTools,
    toolFamilies: uniqueRuntimeStrings([
      ...profileDefaultFamilies,
      ...runtimeTools.toolFamilies,
    ]) as ToolFamily[],
    disabledToolFamilies: uniqueRuntimeStrings([
      ...profileDisabledFamilies.filter(
        (family) => !hostRequestedFamilies.has(family),
      ),
      ...runtimeTools.disabledToolFamilies,
    ]) as ToolFamily[],
    allowedSideEffects: allowedSideEffects.length > 0 ? allowedSideEffects : ["none"],
    profileMcpServerRestriction: capabilities.allowedMcpServerIds,
    selectedSkillIds: runtimeTools.selectedSkillIds,
  };
}

function defaultCliShellNetworkAuthorization(): ShellNetworkAuthorization {
  return {
    sideEffectAllowed: false,
    authorizationRecorded: false,
    profile: "offline",
    allowedDestinations: [],
  };
}

function resolveCliShellNetworkAuthorization(
  workspaceContext: ResearchWorkspaceContext,
  runtimeTools: RuntimeToolConfig,
): ShellNetworkAuthorization {
  const authorization = workspaceContext.authorization;
  const profile = authorization?.networkProfile === "scoped" || authorization?.networkProfile === "elevated"
    ? authorization.networkProfile
    : "offline";
  return {
    sideEffectAllowed: runtimeTools.allowedSideEffects.includes("network"),
    authorizationRecorded: authorization?.recorded === true,
    profile,
    allowedDestinations: authorization?.allowedNetworkDestinations ?? [],
    ...(authorization?.source ? { source: authorization.source } : {}),
    ...(authorization?.scopeId ? { scopeId: authorization.scopeId } : {}),
    ...(authorization?.scopeName ? { scopeName: authorization.scopeName } : {}),
    ...(authorization?.activeFrom ? { activeFrom: authorization.activeFrom } : {}),
    ...(authorization?.expiresAt ? { expiresAt: authorization.expiresAt } : {}),
  };
}

async function configureRuntimeMcpTools(input: {
  runtimeTools: RuntimeToolConfig;
  executableTools: ResearchExecutableTool[];
  toolDescriptors: ResearchToolDescriptor[];
  cleanupCallbacks: (() => Promise<void>)[];
}): Promise<Record<string, unknown> | undefined> {
  if (!input.runtimeTools.mcpConfigPath) {
    return undefined;
  }

  const config = loadResearchMcpClientConfig(input.runtimeTools.mcpConfigPath);
  const configuredServers = config.servers.map((server) => server.name);
  const hostAuthorizedServers =
    input.runtimeTools.allowedMcpServers.length > 0
      ? input.runtimeTools.allowedMcpServers
      : config.allowedServers;
  const missingAllowedServers = hostAuthorizedServers.filter(
    (serverName) => !configuredServers.includes(serverName),
  );
  if (missingAllowedServers.length > 0) {
    throw new Error(
      `Allowed MCP server(s) are not defined in ${input.runtimeTools.mcpConfigPath}: ${missingAllowedServers.join(", ")}`,
    );
  }
  const allowedServers = restrictMcpServersToProfile(
    hostAuthorizedServers,
    input.runtimeTools.profileMcpServerRestriction,
  );

  const timeoutMs = input.runtimeTools.mcpTimeoutMs ?? config.timeoutMs;
  const client = createConfiguredResearchMcpClient({
    ...config,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  input.cleanupCallbacks.push(() => client.close());

  try {
    const discovery = await createMcpResearchTools({
      client,
      allowedServers,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    input.executableTools.push(...discovery.tools);
    input.toolDescriptors.push(...discovery.descriptors);

    return {
      status: "configured",
      configPath: input.runtimeTools.mcpConfigPath,
      configuredServers,
      hostAuthorizedServers,
      profileRestriction: input.runtimeTools.profileMcpServerRestriction,
      allowedServers,
      timeoutMs: timeoutMs ?? null,
      discoveredCapabilities: discovery.descriptors.map((descriptor) => ({
        name: descriptor.name,
        transportName: descriptor.transportName,
        actionClasses: descriptor.actionClasses,
        sideEffects: descriptor.sideEffects,
        requiredPermissions: descriptor.requiredPermissions,
        metadata: descriptor.metadata ?? {},
      })),
      resourceTemplates: discovery.resourceTemplates,
      deniedCapabilities: discovery.deniedCapabilities,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `MCP discovery failed for ${input.runtimeTools.mcpConfigPath}: ${message}`,
    );
  }
}

function restrictMcpServersToProfile(
  hostAuthorizedServers: readonly string[],
  profileRestriction: readonly string[],
): string[] {
  const hostAuthorized = uniqueRuntimeStrings(hostAuthorizedServers);
  if (profileRestriction.length === 0) return hostAuthorized;
  const profileAllowed = new Set(profileRestriction);
  return hostAuthorized.filter((serverId) => profileAllowed.has(serverId));
}

function resolveEnabledToolFamilies(args: {
  inspectRoots: readonly string[];
  inspectPaths: readonly string[];
  runtimeTools: RuntimeToolConfig;
}): Set<ToolFamily> {
  const families = new Set<ToolFamily>(args.runtimeTools.toolFamilies);

  if (args.inspectRoots.length > 0 || args.inspectPaths.length > 0) {
    families.add("local-inspection");
  }
  if (args.runtimeTools.repoRoots.length > 0) {
    families.add("repository-search");
  }
  if (
    args.runtimeTools.sourcePaths.length > 0 ||
    args.runtimeTools.workspaceContextPath
  ) {
    families.add("repository-search");
  }
  if (
    args.runtimeTools.fileReadRoots.length > 0 ||
    args.runtimeTools.repoRoots.length > 0 ||
    args.runtimeTools.sourcePaths.length > 0 ||
    args.runtimeTools.workspaceContextPath
  ) {
    families.add("file-read");
  }
  if (
    args.runtimeTools.repoRoots.length > 0 ||
    args.runtimeTools.sourcePaths.length > 0 ||
    args.runtimeTools.workspaceContextPath
  ) {
    families.add("code");
  }

  for (const family of args.runtimeTools.disabledToolFamilies) {
    families.delete(family);
  }

  return families;
}

function createCliGovernance(
  config: RuntimeToolConfig,
): ResearchGovernancePolicy | undefined {
  const governance: ResearchGovernancePolicy = {};

  if (config.allowedSideEffects.length > 0) {
    governance.allowedSideEffects = config.allowedSideEffects;
  }
  if (config.toolMaxCalls) {
    governance.maxToolCalls = config.toolMaxCalls;
  }
  if (config.toolRuntimeMs) {
    governance.maxRuntimeMs = config.toolRuntimeMs;
  }
  if (config.toolMaxFiles) {
    governance.maxFiles = config.toolMaxFiles;
  }
  if (config.toolMaxBytes) {
    governance.maxBytes = config.toolMaxBytes;
  }
  if (config.toolMaxTokens) {
    governance.maxTokens = config.toolMaxTokens;
  }

  return Object.keys(governance).length > 0 ? governance : undefined;
}

function loadCliSkills(skillDirs: readonly string[]): ResearchSkillDescriptor[] {
  return skillDirs.flatMap((skillDir) =>
    loadResearchSkillsFromDirectory(resolve(skillDir)),
  );
}

function validateSelectedSkillIds(
  skills: readonly ResearchSkillDescriptor[],
  selectedSkillIds: readonly string[],
): void {
  if (selectedSkillIds.length === 0) {
    return;
  }

  const loadedIds = new Set(skills.map((skill) => skill.id));
  const missing = selectedSkillIds.filter((id) => !loadedIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Selected skill(s) not loaded: ${missing.join(", ")}. Use --skill-dir to load local skills first.`,
    );
  }
}

function createRuntimeCapture(input: {
  families: ReadonlySet<ToolFamily>;
  args: {
    runtimeTools: RuntimeToolConfig;
  };
  tools: readonly ResearchToolDescriptor[];
  skills: readonly ResearchSkillDescriptor[];
  governance: ResearchGovernancePolicy | undefined;
  workspaceContext: ResearchWorkspaceContext;
  shellNetworkAuthorization: ShellNetworkAuthorization;
  toolConfigCapture: ResolvedRuntimeToolConfig["capture"];
  mcpCapture?: Record<string, unknown>;
}): Record<string, unknown> {
  const hostAuthorizedMcpServers = input.args.runtimeTools.allowedMcpServers;
  const allowedMcpServers = restrictMcpServersToProfile(
    hostAuthorizedMcpServers,
    input.args.runtimeTools.profileMcpServerRestriction,
  );
  return {
    toolConfig: input.toolConfigCapture,
    workspaceContext: input.workspaceContext,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      transportName: tool.transportName,
      actionClasses: tool.actionClasses,
      sideEffects: tool.sideEffects,
      requiredPermissions: tool.requiredPermissions,
      artifactLocations: tool.artifactLocations ?? [],
      metadata: tool.metadata ?? {},
    })),
    toolFamilies: {
      enabled: [...input.families],
      requested: input.args.runtimeTools.toolFamilies,
      disabled: input.args.runtimeTools.disabledToolFamilies,
      profileCeiling: input.args.runtimeTools.profileToolFamilyCeiling,
    },
    profileSideEffectCeiling: input.args.runtimeTools.profileSideEffectCeiling,
    governance: input.governance ?? null,
    shellNetworkAuthorization: input.shellNetworkAuthorization,
    mcp:
      input.mcpCapture ??
      {
        hostAuthorizedServers: hostAuthorizedMcpServers,
        profileRestriction: input.args.runtimeTools.profileMcpServerRestriction,
        allowedServers: allowedMcpServers,
        discoveredCapabilities: [],
        status:
          allowedMcpServers.length > 0
            ? "no_mcp_client_configured"
            : "not_configured",
      },
    skills: {
      loaded: input.skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        description: skill.description,
        domainTags: skill.domainTags,
        source: skill.source,
      })),
      selectedIds: input.args.runtimeTools.selectedSkillIds,
    },
  };
}

function repositorySearchRootsFromWorkspaceContext(
  workspaceContext: ResearchWorkspaceContext,
): string[] {
  const roots = [
    ...workspaceContext.knownRepositories.map((repository) => repository.rootPath),
    ...workspaceContext.materializedSourcePaths,
  ];
  return roots.length > 0 ? [...new Set(roots)] : [workspaceContext.workspaceRoot];
}

async function writeFlowCapture(
  capturePath: string,
  result: Awaited<ReturnType<typeof runResearchAgent>>,
  runtimeConfig?: Record<string, unknown>,
): Promise<string> {
  const absolutePath = resolve(capturePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const capture = createResearchAgentFlowCapture(result);
  await writeFile(
    absolutePath,
    `${JSON.stringify(
      runtimeConfig ? { ...capture, runtimeConfig } : capture,
      null,
      2,
    )}\n`,
    "utf8",
  );

  return absolutePath;
}

async function handleAuthCommand(argv: readonly string[]): Promise<void> {
  const command = argv[0] ?? "status";

  if (command === "list") {
    for (const provider of listAuthProviders()) {
      console.log(
        `${provider.id}\t${provider.name}\t${provider.authMethods.join(", ")}`,
      );
    }
    return;
  }

  if (command === "status") {
    const status = await getAuthStatus(argv[1]);
    console.log(`Auth file: ${status.authFile}`);
    if (status.providers.length === 0) {
      console.log(argv[1] ? `No provider found: ${argv[1]}` : "No providers found.");
      return;
    }

    for (const provider of status.providers) {
      const stored = provider.storedCredentialType ?? "not stored";
      console.log(
        `${provider.id}\t${provider.name}\t${provider.authMethods.join(", ")}\t${stored}`,
      );
    }
    return;
  }

  if (command === "login") {
    const providerId = argv[1];
    if (!providerId) {
      throw new Error("Usage: honeycrisp auth login <provider>");
    }

    const callbacks = createTerminalAuthCallbacks();
    try {
      const result = await loginAuthProvider(providerId, callbacks);
      console.log(
        `Logged in to ${result.providerName} (${result.providerId}) using ${result.credentialType}.`,
      );
      console.log(`Credentials saved to ${result.authFile}`);
    } finally {
      callbacks.close();
    }
    return;
  }

  if (command === "logout") {
    const providerId = argv[1];
    if (!providerId) {
      throw new Error("Usage: honeycrisp auth logout <provider>");
    }

    await logoutAuthProvider(providerId);
    console.log(`Removed stored credentials for ${providerId}.`);
    return;
  }

  if (command === "verify") {
    const providerId = argv[1];
    if (!providerId) {
      throw new Error("Usage: honeycrisp auth verify <provider> [model]");
    }

    const result = await verifyProviderAuth(providerId, argv[2]);
    const source = result.source ? ` via ${result.source}` : "";
    console.log(
      `${result.providerName} (${result.providerId}) model ${result.modelId}: ${
        result.configured ? `configured${source}` : "not configured"
      }`,
    );
    return;
  }

  throw new Error(
    "Usage: honeycrisp auth <list|status|login|logout|verify> [provider] [model]",
  );
}

function handleModelsCommand(argv: readonly string[]): void {
  const command = argv[0] ?? "list";
  if (command !== "list") {
    throw new Error("Usage: honeycrisp models list [provider] [--json]");
  }
  const providerId = argv.find((value, index) => index > 0 && !value.startsWith("--"));
  const catalogs = getProviderModelCatalog(providerId);
  if (providerId && catalogs.length === 0) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ providers: catalogs }, null, 2));
    return;
  }
  for (const provider of catalogs) {
    for (const model of provider.models) {
      console.log(
        `${provider.providerId}\t${model.id}\t${model.name}\t${model.effortLevels.join(", ")}`,
      );
    }
  }
}

function createTerminalAuthCallbacks(): AuthLoginCallbacks & { close(): void } {
  const rl = createInterface({ input, output });

  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.signal?.aborted) {
        throw new Error("Prompt cancelled");
      }

      if (prompt.type === "select") {
        console.log(`\n${prompt.message}`);
        prompt.options.forEach((option, index) => {
          const description = option.description ? ` - ${option.description}` : "";
          console.log(`  ${index + 1}. ${option.label}${description}`);
        });
        const answer = await rl.question(`Enter number (1-${prompt.options.length}): `);
        const selected = prompt.options[Number.parseInt(answer, 10) - 1];
        if (!selected) {
          throw new Error("Invalid selection");
        }

        return selected.id;
      }

      const label = prompt.placeholder
        ? `${prompt.message} (${prompt.placeholder}): `
        : `${prompt.message}: `;

      if (prompt.type === "secret" && input.isTTY) {
        return readSecret(label);
      }

      if (prompt.signal) {
        return rl.question(label, { signal: prompt.signal });
      }

      return rl.question(label);
    },
    notify(event: AuthEvent): void {
      if (event.type === "auth_url") {
        console.log(`\nOpen this URL in your browser:\n${event.url}`);
        if (event.instructions) {
          console.log(event.instructions);
        }
        console.log();
      } else if (event.type === "device_code") {
        console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
        console.log(`Enter code: ${event.userCode}`);
        console.log();
      } else {
        console.log(event.message);
      }
    },
    close(): void {
      rl.close();
    },
  };
}

function readSecret(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off("data", onData);
      if (input.isTTY) {
        input.setRawMode(wasRaw);
      }
    };

    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const onData = (data: Buffer) => {
      const chunk = data.toString("utf8");
      if (chunk === "\u0003") {
        cleanup();
        reject(new Error("Input cancelled"));
        return;
      }

      if (chunk === "\r" || chunk === "\n") {
        finish();
        return;
      }

      if (chunk === "\u007f") {
        value = value.slice(0, -1);
        return;
      }

      value += chunk;
    };

    output.write(message);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
