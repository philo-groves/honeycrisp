#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  bootstrapResearchRun,
  compileContextPacketV2,
  createAnalysisTool,
  createConfiguredResearchMcpClient,
  createConfiguredExperimentTool,
  createLocalInspectionObservationEvent,
  createLocalInspectionTool,
  createDeterministicLoopExecutor,
  createMemoryDrivenController,
  createMemoryInspector,
  createPiAgentLoopExecutor,
  createPiLoopExecutor,
  createRepositorySearchTool,
  createResearchFlowCapture,
  createResearchGoalFrame,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createResearchWorkspaceContext,
  createMcpResearchTools,
  createStorageListTool,
  createStructuredFileReadTool,
  getDefaultResearchModelConfigPath,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
  createSqliteProofStore,
  createSynthesisTool,
  getAuthStatus,
  listAuthProviders,
  loadResearchSkillsFromDirectory,
  loadResearchStorageManifest,
  loadResearchMcpClientConfig,
  loadResearchExperimentConfig,
  loadResearchModelConfig,
  loadResearchWorkspaceContextFile,
  loginAuthProvider,
  logoutAuthProvider,
  mergeResearchWorkspaceContexts,
  resolveResearchModelConfig,
  routeEventsToMemorySnapshot,
  verifyProviderAuth,
  workspaceContextFileReadHints,
  writeResearchModelConfig,
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
  ResearchLoopExecutor,
  ResearchMemorySnapshot,
  ResearchModelConfigPreference,
  ResolvedResearchModelConfig,
  ResearchSkillDescriptor,
  ResearchToolDescriptor,
  ResearchToolSideEffect,
  ResearchToolRegistry,
  ResearchWorkspaceContext,
} from "@honeycrisp/research-agent";

const VERSION = "0.1.0";

type ToolFamily =
  | "local-inspection"
  | "repository-search"
  | "file-read"
  | "analysis"
  | "synthesis"
  | "storage"
  | "experiment";

type CliExecutorKind = "complete-simple" | "agent";
type CliToolExecutionMode = "sequential" | "parallel";

interface RuntimeToolConfig {
  toolFamilies: readonly ToolFamily[];
  disabledToolFamilies: readonly ToolFamily[];
  repoRoots: readonly string[];
  fileReadRoots: readonly string[];
  sourcePaths: readonly string[];
  projectNotes: readonly string[];
  workspaceContextPath?: string;
  allowedSideEffects: readonly ResearchToolSideEffect[];
  allowedMcpServers: readonly string[];
  mcpConfigPath?: string;
  mcpTimeoutMs?: number;
  experimentConfigPath?: string;
  selectedSkillIds: readonly string[];
  skillDirs: readonly string[];
  toolMaxCalls?: number;
  toolRuntimeMs?: number;
  toolMaxFiles?: number;
  toolMaxBytes?: number;
  toolMaxTokens?: number;
}

interface ParsedArgs {
  prompt: string | undefined;
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
  workspaceRoot: string;
  goalLoops: number | null | undefined;
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
  positionals: string[];
  goal: string | undefined;
  questions: string[];
  limit: number | undefined;
  json: boolean;
  help: boolean;
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
  let json = false;
  let help = false;
  let version = false;
  let mock = false;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let executor: CliExecutorKind = "complete-simple";
  let toolExecution: CliToolExecutionMode | undefined;
  let maxTokens: number | undefined;
  let reasoning: ParsedArgs["reasoning"];
  let inspectAction: LocalInspectionAction = "read_text";
  let inspectBytes: number | undefined;
  let capturePath: string | undefined;
  let workspaceRoot = process.cwd();
  let goalLoops: number | null | undefined;
  const toolFamilies: ToolFamily[] = [];
  const disabledToolFamilies: ToolFamily[] = [];
  const repoRoots: string[] = [];
  const fileReadRoots: string[] = [];
  const sourcePaths: string[] = [];
  const projectNotes: string[] = [];
  let workspaceContextPath: string | undefined;
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
  let mcpConfigPath: string | undefined;
  let mcpTimeoutMs: number | undefined;
  let experimentConfigPath: string | undefined;
  const selectedSkillIds: string[] = [];
  const skillDirs: string[] = [];
  let toolMaxCalls: number | undefined;
  let toolRuntimeMs: number | undefined;
  let toolMaxFiles: number | undefined;
  let toolMaxBytes: number | undefined;
  let toolMaxTokens: number | undefined;
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
    } else if (arg === "--provider") {
      provider = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--model") {
      model = readOptionValue(argv, index, arg);
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
    } else if (arg === "--skill") {
      selectedSkillIds.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--skill-dir") {
      skillDirs.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--capture") {
      capturePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--goal-loops") {
      goalLoops = parseGoalLoops(readOptionValue(argv, index, arg));
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

  return {
    prompt,
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
      repoRoots,
      fileReadRoots,
      sourcePaths,
      projectNotes,
      ...(workspaceContextPath ? { workspaceContextPath } : {}),
      allowedSideEffects,
      allowedMcpServers,
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      ...(mcpTimeoutMs ? { mcpTimeoutMs } : {}),
      ...(experimentConfigPath ? { experimentConfigPath } : {}),
      selectedSkillIds,
      skillDirs,
      ...(toolMaxCalls ? { toolMaxCalls } : {}),
      ...(toolRuntimeMs ? { toolRuntimeMs } : {}),
      ...(toolMaxFiles ? { toolMaxFiles } : {}),
      ...(toolMaxBytes ? { toolMaxBytes } : {}),
      ...(toolMaxTokens ? { toolMaxTokens } : {}),
    },
    capturePath,
    workspaceRoot,
    goalLoops,
    json,
    help,
    version,
  };
}

function parseMemoryArgs(argv: readonly string[]): ParsedMemoryArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let workspaceRoot = process.cwd();
  let goal: string | undefined;
  let limit: number | undefined;
  let json = false;
  let help = false;
  const questions: string[] = [];
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--goal" || arg === "--prompt") {
      goal = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--question") {
      questions.push(readOptionValue(argv, index, arg));
      index += 1;
    } else if (arg === "--limit") {
      const value = Number.parseInt(readOptionValue(argv, index, arg), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit requires a positive integer.");
      }
      limit = value;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown memory option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  return {
    command,
    workspaceRoot,
    positionals,
    goal,
    questions,
    limit,
    json,
    help,
  };
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
  const repoRoots: string[] = [];
  const fileReadRoots: string[] = [];
  const sourcePaths: string[] = [];
  const projectNotes: string[] = [];
  let workspaceContextPath: string | undefined;
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
  let mcpConfigPath: string | undefined;
  let mcpTimeoutMs: number | undefined;
  let experimentConfigPath: string | undefined;
  const selectedSkillIds: string[] = [];
  const skillDirs: string[] = [];
  let toolMaxCalls: number | undefined;
  let toolRuntimeMs: number | undefined;
  let toolMaxFiles: number | undefined;
  let toolMaxBytes: number | undefined;
  let toolMaxTokens: number | undefined;

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
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
      inspectBytes = parsePositiveIntegerOption(argv, index, arg);
      index += 1;
    } else if (arg === "--tool-family") {
      toolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
      index += 1;
    } else if (arg === "--disable-tool-family") {
      disabledToolFamilies.push(parseToolFamily(readOptionValue(argv, index, arg)));
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
      repoRoots,
      fileReadRoots,
      sourcePaths,
      projectNotes,
      ...(workspaceContextPath ? { workspaceContextPath } : {}),
      allowedSideEffects,
      allowedMcpServers,
      ...(mcpConfigPath ? { mcpConfigPath } : {}),
      ...(mcpTimeoutMs ? { mcpTimeoutMs } : {}),
      ...(experimentConfigPath ? { experimentConfigPath } : {}),
      selectedSkillIds,
      skillDirs,
      ...(toolMaxCalls ? { toolMaxCalls } : {}),
      ...(toolRuntimeMs ? { toolRuntimeMs } : {}),
      ...(toolMaxFiles ? { toolMaxFiles } : {}),
      ...(toolMaxBytes ? { toolMaxBytes } : {}),
      ...(toolMaxTokens ? { toolMaxTokens } : {}),
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

function parseReasoning(value: string): ResearchModelEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }

  throw new Error("--reasoning must be one of minimal, low, medium, high, xhigh.");
}

function parseInspectionAction(value: string): LocalInspectionAction {
  if (value === "list" || value === "read_text") {
    return value;
  }

  throw new Error("--inspect-action must be one of list, read_text.");
}

function parseGoalLoops(value: string): number | null {
  if (value === "none" || value === "unbounded") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--goal-loops requires a positive integer, none, or unbounded.");
  }

  return parsed;
}

function parseExecutor(value: string): CliExecutorKind {
  if (value === "complete-simple" || value === "agent") {
    return value;
  }

  throw new Error("--executor must be one of complete-simple, agent.");
}

function parseToolExecutionMode(value: string): CliToolExecutionMode {
  if (value === "sequential" || value === "parallel") {
    return value;
  }

  throw new Error("--tool-execution must be one of sequential, parallel.");
}

function parseToolFamily(value: string): ToolFamily {
  if (
    value === "local-inspection" ||
    value === "repository-search" ||
    value === "file-read" ||
    value === "analysis" ||
    value === "synthesis" ||
    value === "storage" ||
    value === "experiment"
  ) {
    return value;
  }

  throw new Error(
    "--tool-family must be one of local-inspection, repository-search, file-read, analysis, synthesis, storage, experiment.",
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
    "",
    "Options:",
    "  -p, --prompt <prompt>  Research prompt to turn into a root goal",
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
    "  --executor <kind>      complete-simple or agent (default: complete-simple)",
    "  --max-tokens <n>       Max output tokens for real mode",
    "  --effort <level>       Model effort for real mode: minimal, low, medium, high, xhigh",
    "  --reasoning <level>    Alias for --effort",
    "  --tool-execution <m>   Agent tool execution mode: sequential or parallel",
    "  --inspect-root <path>  Allow a local root for read-only inspection",
    "  --inspect-path <path>  Inspect a local path before the loop",
    "  --inspect-action <a>   Inspection action: read_text or list",
    "  --inspect-bytes <n>    Max bytes for read_text inspection",
    "  --tool-family <name>   Enable local-inspection, repository-search, file-read, analysis, synthesis, storage, or experiment",
    "  --disable-tool-family <name> Disable a tool family after implicit/default enables",
    "  --repo-root <path>     Add a known repository context hint and enable repository.search unless disabled",
    "  --file-read-root <p>   Add a file.read context hint and enable file.read unless disabled",
    "  --source-path <path>   Add a materialized source context path",
    "  --project-note <text>  Add a project/workspace note to the context packet",
    "  --workspace-context <p> JSON workspace context file to merge with CLI hints",
    "  --allowed-side-effect <s> Allow tool side effect: none, read, write, network, process",
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
    "  --workspace-root <p>   Workspace root for durable runtime memory",
    "  --goal-loops <n|none>  Max loops, or none for no configured loop limit",
    "  --json                 Print the initialized run as JSON",
    "  -h, --help             Show help",
    "  -v, --version          Show version",
    "",
    "Memory commands:",
    "  memory timeline                  Show accepted event timeline",
    "  memory event <event-id>           Show one accepted raw event",
    "  memory records-for-event <id>     Show derived records for an event",
    "  memory recall --goal <text>       Run a recall query",
    "  memory preconscious --goal <text> Show preconscious candidates",
    "  memory context --goal <text>      Show compiled context selections",
    "  memory decision --goal <text>     Explain selected action",
    "  memory hypotheses                 Show hypotheses and semantic claims",
    "  memory findings                   Show finding records",
    "  memory finding <record-id>        Show one finding with evidence/proof links",
    "  memory proof-state                Show proof obligations and attempts",
    "  memory proof-obligations          Show proof obligations",
    "  memory proof-obligation <id>      Show one proof obligation",
    "  memory proof-attempts             Show proof attempts",
    "  memory proof-attempt <id>         Show one proof attempt",
    "  memory claim-graph                Show claim graph edges",
    "  memory prospective-checks         Show prospective checks",
    "  memory debug-capture              Show read-only memory debug capture",
    "",
    "Memory options:",
    "  --workspace-root <path>  Workspace root containing .honeycrisp memory",
    "  --goal, --prompt <text>  Goal text for recall, context, or decision",
    "  --question <text>       Add an open question to recall",
    "  --limit <n>             Limit recall candidates",
    "  --json                  Print JSON",
    "",
    "Tool debug commands:",
    "  tools list                       Show configured tools, MCP allowlist, and selected skills",
    "  config show                      Show project model preference and authorization status",
    "  config set <field> <value>       Set provider, model, or effort preference",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  try {
    if (argv[0] === "auth") {
      await handleAuthCommand(argv.slice(1));
      return;
    }

    if (argv[0] === "memory") {
      await handleMemoryCommand(argv.slice(1));
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

    const runtimeConfig = await createRuntimeConfig(args);
    try {
      let modelConfig: ResolvedResearchModelConfig | undefined;
      const loopExecutor = args.mock
        ? createDeterministicLoopExecutor(
            runtimeConfig.toolRegistry
              ? { toolRegistry: runtimeConfig.toolRegistry }
              : {},
          )
        : createRealLoopExecutor(
            args,
            runtimeConfig.toolRegistry,
            (modelConfig = await resolveResearchModelConfig({
              workspaceRoot: args.workspaceRoot,
              ...(args.configPath ? { configPath: args.configPath } : {}),
              ...(args.provider ? { provider: args.provider } : {}),
              ...(args.model ? { model: args.model } : {}),
              ...(args.reasoning ? { effort: args.reasoning } : {}),
            })),
          );

      const inspectionState =
        runtimeConfig.events.length > 0 && runtimeConfig.memory
          ? {
              events: runtimeConfig.events,
              memory: runtimeConfig.memory,
            }
          : {};

      const result = await bootstrapResearchRun({
        prompt: args.prompt,
        workspaceRoot: args.workspaceRoot,
        successGates: args.successGates,
        failureOrStopGates: args.failureOrStopGates,
        scopeConstraints: args.scopeConstraints,
        evidenceRequirements: args.evidenceRequirements,
        initialRiskFlags: args.initialRiskFlags,
        userPreferences: args.userPreferences,
        workspaceContext: runtimeConfig.workspaceContext,
        ...inspectionState,
        ...(runtimeConfig.tools.length > 0 ? { tools: runtimeConfig.tools } : {}),
        ...(runtimeConfig.skills.length > 0 ? { skills: runtimeConfig.skills } : {}),
        ...(args.runtimeTools.selectedSkillIds.length > 0
          ? { selectedSkillIds: args.runtimeTools.selectedSkillIds }
          : {}),
        ...(runtimeConfig.governance ? { governance: runtimeConfig.governance } : {}),
        loopExecutor,
        durableMemory: true,
        ...(args.goalLoops !== undefined
          ? { goalRun: { maxLoops: args.goalLoops } }
          : {}),
      });

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
          console.log(`Flow capture: ${capturePath}`);
        }
      }

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.response);
    } finally {
      await runtimeConfig.cleanup?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`honeycrisp: ${message}`);
    process.exitCode = 1;
  }
}

function createRealLoopExecutor(
  args: ParsedArgs,
  toolRegistry: ResearchToolRegistry | undefined,
  modelConfig: ResolvedResearchModelConfig,
): ResearchLoopExecutor {
  const executorInput = {
    provider: modelConfig.provider,
    model: modelConfig.model,
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    ...(modelConfig.effort ? { reasoning: modelConfig.effort } : {}),
    ...(toolRegistry ? { toolRegistry } : {}),
  };

  return args.executor === "agent"
    ? createPiAgentLoopExecutor({
        ...executorInput,
        ...(args.toolExecution ? { toolExecution: args.toolExecution } : {}),
      })
    : createPiLoopExecutor(executorInput);
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

async function handleMemoryCommand(argv: readonly string[]): Promise<void> {
  const args = parseMemoryArgs(argv);

  if (!args.command || args.help) {
    console.log(memoryUsage());
    return;
  }

  const eventLog = createSqliteMemoryEventLog({
    workspaceRoot: args.workspaceRoot,
  });
  const recordStore = createSqliteMemoryRecordStore({
    workspaceRoot: args.workspaceRoot,
  });
  const proofStore = createSqliteProofStore({
    workspaceRoot: args.workspaceRoot,
  });
  const inspector = createMemoryInspector({ eventLog, recordStore, proofStore });

  try {
    if (args.command === "timeline") {
      printMemoryOutput(args, inspector.eventTimeline(), renderTimeline);
      return;
    }

    if (args.command === "agent-state") {
      printMemoryOutput(
        args,
        inspector.showAgentState({ storage: createMemoryCommandStorageReadModel(args) }),
        renderAgentState,
      );
      return;
    }

    if (args.command === "event") {
      const eventId = requireMemoryPositional(args, "event <event-id>");
      printMemoryOutput(
        args,
        inspector.showEventById(eventId) ?? null,
        (event) => (event ? JSON.stringify(event, null, 2) : `No event found: ${eventId}`),
      );
      return;
    }

    if (args.command === "records-for-event") {
      const eventId = requireMemoryPositional(
        args,
        "records-for-event <event-id>",
      );
      printMemoryOutput(
        args,
        inspector.showDerivedRecordsForEvent(eventId),
        renderRecords,
      );
      return;
    }

    if (args.command === "recall") {
      const { retrieval } = createRecallInspection(args, inspector);
      printMemoryOutput(
        args,
        retrieval,
        (value) => renderRecords(value.candidates.map((candidate) => candidate.record)),
      );
      return;
    }

    if (args.command === "preconscious") {
      const { retrieval } = createRecallInspection(args, inspector);
      printMemoryOutput(
        args,
        inspector.showPreconsciousPacket(retrieval),
        renderPreconsciousPacket,
      );
      return;
    }

    if (args.command === "context") {
      const { contextPacket } = createDecisionInspection(args, inspector);
      printMemoryOutput(
        args,
        inspector.showCompiledContextPacket(contextPacket),
        renderContextSelections,
      );
      return;
    }

    if (args.command === "decision") {
      const { decision } = createDecisionInspection(args, inspector);
      printMemoryOutput(
        args,
        inspector.explainSelectedAction(decision),
        renderDecisionExplanation,
      );
      return;
    }

    if (args.command === "hypotheses") {
      printMemoryOutput(args, inspector.showHypotheses(), renderRecords);
      return;
    }

    if (args.command === "findings") {
      printMemoryOutput(args, inspector.showFindings(), renderRecords);
      return;
    }

    if (args.command === "finding") {
      const recordId = requireMemoryPositional(args, "finding <record-id>");
      printMemoryOutput(
        args,
        inspector.showFindingById(recordId) ?? null,
        renderFindingDetails,
      );
      return;
    }

    if (args.command === "claim-graph") {
      printMemoryOutput(args, inspector.showClaimGraph(), renderClaimGraph);
      return;
    }

    if (args.command === "prospective-checks") {
      printMemoryOutput(args, inspector.showProspectiveChecks(), renderRecords);
      return;
    }

    if (args.command === "proof-state") {
      printMemoryOutput(args, inspector.showProofState(), renderProofState);
      return;
    }

    if (args.command === "proof-obligations") {
      printMemoryOutput(
        args,
        inspector.showProofObligations(),
        renderProofObligations,
      );
      return;
    }

    if (args.command === "proof-obligation") {
      const obligationId = requireMemoryPositional(
        args,
        "proof-obligation <obligation-id>",
      );
      printMemoryOutput(
        args,
        inspector.showProofObligationById(obligationId) ?? null,
        renderProofObligation,
      );
      return;
    }

    if (args.command === "proof-attempts") {
      printMemoryOutput(
        args,
        inspector.showProofAttempts(),
        renderProofAttempts,
      );
      return;
    }

    if (args.command === "proof-attempt") {
      const attemptId = requireMemoryPositional(args, "proof-attempt <attempt-id>");
      printMemoryOutput(
        args,
        inspector.showProofAttemptById(attemptId) ?? null,
        renderProofAttempt,
      );
      return;
    }

    if (args.command === "debug-capture") {
      const captureInput = args.goal
        ? createDecisionInspection(args, inspector)
        : undefined;
      printMemoryOutput(
        args,
        inspector.captureDebug(
          captureInput
            ? {
                retrieval: captureInput.retrieval,
                contextPacketV2: captureInput.contextPacket,
                decision: captureInput.decision,
              }
            : {},
        ),
        (capture) => [
          `Accepted events: ${capture.acceptedEvents.length}`,
          `Rejected events: ${capture.rejectedEvents.length}`,
          `Candidate writes: ${capture.candidateWrites.length}`,
          `Committed writes: ${capture.committedWrites.length}`,
          capture.retrievalResults
            ? `Retrieval candidates: ${capture.retrievalResults.candidateCount}`
            : "Retrieval candidates: not captured",
          capture.contextSelections
            ? `Context sections: ${capture.contextSelections.sections.length}`
            : "Context sections: not captured",
          capture.controllerDecision
            ? `Decision: ${capture.controllerDecision.actionClass}`
            : "Decision: not captured",
        ].join("\n"),
      );
      return;
    }

    throw new Error(`Unknown memory command: ${args.command}`);
  } finally {
    eventLog.close();
    recordStore.close();
    proofStore.close();
  }
}

async function handleToolsCommand(argv: readonly string[]): Promise<void> {
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
    "  set effort <level>         Set effort: minimal, low, medium, high, or xhigh",
    "",
    "Options:",
    "  --config <path>            Preference config path",
    "  --workspace-root <path>    Project root for default .honeycrisp/config.json",
    "  --json                     Print JSON",
  ].join("\n");
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
    "  --tool-family <name>        Enable local-inspection, repository-search, file-read, analysis, synthesis, storage, or experiment",
    "  --disable-tool-family <n>   Disable a tool family after implicit/default enables",
    "  --repo-root <path>          Add a known repository context hint and enable repository.search unless disabled",
    "  --file-read-root <path>     Add a file.read context hint and enable file.read unless disabled",
    "  --source-path <path>        Add a materialized source context path",
    "  --project-note <text>       Add a project/workspace note to the context packet",
    "  --workspace-context <path>  JSON workspace context file to merge with CLI hints",
    "  --inspect-root <path>       Enable local.inspection for this root unless disabled",
    "  --allowed-side-effect <s>   Allow side effect: none, read, write, network, process",
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
    "  timeline                  Show accepted event timeline",
    "  agent-state               Show Beale-facing memory/proof/storage state",
    "  event <event-id>           Show one accepted raw event",
    "  records-for-event <id>     Show derived records for an event",
    "  recall --goal <text>       Run a recall query",
    "  preconscious --goal <text> Show preconscious candidates",
    "  context --goal <text>      Show compiled context selections",
    "  decision --goal <text>     Explain selected action",
    "  hypotheses                 Show hypotheses and semantic claims",
    "  findings                   Show finding records",
    "  finding <record-id>        Show one finding with evidence/proof links",
    "  proof-state                Show proof obligations and attempts",
    "  proof-obligations          Show proof obligations",
    "  proof-obligation <id>      Show one proof obligation",
    "  proof-attempts             Show proof attempts",
    "  proof-attempt <id>         Show one proof attempt",
    "  claim-graph                Show claim graph edges",
    "  prospective-checks         Show prospective checks",
    "  debug-capture              Show read-only memory debug capture",
    "",
    "Options:",
    "  --workspace-root <path>  Workspace root containing .honeycrisp memory",
    "  --goal, --prompt <text>  Goal text for recall, context, or decision",
    "  --question <text>       Add an open question to recall",
    "  --limit <n>             Limit recall candidates",
    "  --json                  Print JSON",
    "  -h, --help              Show help",
  ].join("\n");
}

function createMemoryCommandStorageReadModel(args: ParsedMemoryArgs) {
  const layout = createResearchStorageLayout({ workspaceRoot: args.workspaceRoot });
  const manifest = loadResearchStorageManifest(layout);
  return {
    rootPath: layout.rootPath,
    databasePath: layout.databasePath,
    directories: layout.directories,
    artifacts: manifest.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      uri: artifact.uri,
      summary: artifact.purpose,
      contentHash: artifact.contentHash,
    })),
  };
}

function requireMemoryPositional(
  args: ParsedMemoryArgs,
  usageHint: string,
): string {
  const value = args.positionals[0];
  if (!value) {
    throw new Error(`Usage: honeycrisp memory ${usageHint}`);
  }

  return value;
}

function createRecallInspection(
  args: ParsedMemoryArgs,
  inspector: ReturnType<typeof createMemoryInspector>,
) {
  const goalFrame = createResearchGoalFrame(
    args.goal ?? "Goal: Inspect durable memory",
  );
  const retrieval = inspector.runRecallQuery({
    activeGoal: goalFrame.root,
    openQuestions: args.questions,
    ...(args.limit ? { limit: args.limit } : {}),
  });

  return { goalFrame, retrieval };
}

function createDecisionInspection(
  args: ParsedMemoryArgs,
  inspector: ReturnType<typeof createMemoryInspector>,
) {
  const { goalFrame, retrieval } = createRecallInspection(args, inspector);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });
  const proofState = inspector.showProofState();
  const contextPacket = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: decision.subGoal,
    retrieval,
    proofState,
    tools: [],
  });

  return { goalFrame, retrieval, decision, contextPacket, proofState };
}

function printMemoryOutput<T>(
  args: ParsedMemoryArgs,
  value: T,
  renderText: (value: T) => string,
): void {
  if (args.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(renderText(value));
}

function renderTimeline(
  timeline: ReturnType<ReturnType<typeof createMemoryInspector>["eventTimeline"]>,
): string {
  if (timeline.length === 0) {
    return "No memory events found.";
  }

  return timeline
    .map((event) =>
      [
        event.sequence ?? "-",
        event.timestamp,
        event.kind,
        event.id,
        event.summary,
      ].join("\t"),
    )
    .join("\n");
}

function renderRecords(
  records: readonly {
    kind: string;
    status: string;
    id: string;
    confidence?: number;
    summary: string;
  }[],
): string {
  if (records.length === 0) {
    return "No memory records found.";
  }

  return records
    .map((record) =>
      [
        record.kind,
        record.status,
        record.id,
        record.confidence ?? "-",
        record.summary,
      ].join("\t"),
    )
    .join("\n");
}

function renderAgentState(
  state: ReturnType<ReturnType<typeof createMemoryInspector>["showAgentState"]>,
): string {
  const memory = state.memory;
  return [
    `Evidence: ${memory.evidence.length}`,
    `Hypotheses: ${memory.hypotheses.length}`,
    `Findings: ${memory.findings.length}`,
    `Procedures: ${memory.procedures.length}`,
    `Prospective checks: ${memory.prospectiveChecks.length}`,
    `Proof obligations: ${state.proof.obligations.length}`,
    `Proof attempts: ${state.proof.attempts.length}`,
    `Storage artifacts: ${state.storage.artifacts.length}`,
  ].join("\n");
}

function renderPreconsciousPacket(
  packet: ReturnType<
    ReturnType<typeof createMemoryInspector>["showPreconsciousPacket"]
  >,
): string {
  if (packet.candidates.length === 0) {
    return "No recall candidates found.";
  }

  return packet.candidates
    .map((candidate) =>
      [
        candidate.score,
        candidate.kind,
        candidate.status,
        candidate.recordId,
        candidate.summary,
      ].join("\t"),
    )
    .join("\n");
}

function renderContextSelections(
  context: ReturnType<
    ReturnType<typeof createMemoryInspector>["showCompiledContextPacket"]
  >,
): string {
  if (context.sections.length === 0) {
    return "No context sections found.";
  }

  return [
    [
      "context",
      `items=${context.sections.reduce((sum, section) => sum + section.itemCount, 0)}`,
      `tokens=${context.estimatedTokens}/${context.tokenBudget}`,
      `compaction=${context.compaction.reason}`,
      `removed=${context.compaction.removedRecordIds.join(",") || "-"}`,
    ].join("\t"),
    ...context.sections
      .map((section) =>
        [
          section.label,
          `items=${section.itemCount}`,
          `tokens=${section.estimatedTokens}/${section.tokenBudget}`,
          `selected=${section.selectedRecordIds.join(",") || "-"}`,
        ].join("\t"),
      ),
  ].join("\n");
}

function renderDecisionExplanation(
  decision: ReturnType<
    ReturnType<typeof createMemoryInspector>["explainSelectedAction"]
  >,
): string {
  return [
    `Action: ${decision.actionClass}`,
    `Subgoal: ${decision.subGoalObjective}`,
    `Rationale: ${decision.rationale}`,
    `Supporting records: ${decision.supportingRecordIds.join(", ") || "-"}`,
    `Warnings: ${decision.warnings.join(", ") || "-"}`,
  ].join("\n");
}

function renderFindingDetails(
  detail: ReturnType<
    ReturnType<typeof createMemoryInspector>["showFindingById"]
  > | null,
): string {
  if (!detail) {
    return "No finding found.";
  }

  return [
    `${detail.finding.kind}\t${detail.finding.findingStatus}\t${detail.finding.id}`,
    detail.finding.summary,
    `Evidence for: ${detail.evidenceFor.map((ref) => ref.id).join(", ") || "-"}`,
    `Evidence against: ${detail.evidenceAgainst.map((ref) => ref.id).join(", ") || "-"}`,
    `Hypotheses: ${detail.linkedHypothesisRecordIds.join(", ") || "-"}`,
    `Claims: ${detail.linkedClaimRecordIds.join(", ") || "-"}`,
    `Proof attempts: ${detail.proofAttemptIds.join(", ") || "-"}`,
    `Artifacts: ${detail.artifactRefs.map((ref) => ref.id).join(", ") || "-"}`,
  ].join("\n");
}

function renderProofState(
  state: ReturnType<ReturnType<typeof createMemoryInspector>["showProofState"]>,
): string {
  return [
    `Proof obligations: ${state.obligations.length}`,
    `Proof attempts: ${state.attempts.length}`,
  ].join("\n");
}

function renderProofObligations(
  obligations: ReturnType<
    ReturnType<typeof createMemoryInspector>["showProofObligations"]
  >,
): string {
  if (obligations.length === 0) {
    return "No proof obligations found.";
  }

  return obligations
    .map((obligation) =>
      [
        obligation.status,
        obligation.id,
        obligation.subject.kind,
        obligation.subject.id,
        obligation.question,
      ].join("\t"),
    )
    .join("\n");
}

function renderProofObligation(
  obligation: ReturnType<
    ReturnType<typeof createMemoryInspector>["showProofObligationById"]
  > | null,
): string {
  if (!obligation) {
    return "No proof obligation found.";
  }

  return [
    `${obligation.status}\t${obligation.id}`,
    `Subject: ${obligation.subject.kind}:${obligation.subject.id}`,
    `Question: ${obligation.question}`,
    `Findings: ${obligation.findingRecordIds.join(", ") || "-"}`,
    `Evidence: ${obligation.evidenceRefIds.join(", ") || "-"}`,
    `Artifacts: ${obligation.artifactRefs.map((ref) => ref.id).join(", ") || "-"}`,
  ].join("\n");
}

function renderProofAttempts(
  attempts: ReturnType<
    ReturnType<typeof createMemoryInspector>["showProofAttempts"]
  >,
): string {
  if (attempts.length === 0) {
    return "No proof attempts found.";
  }

  return attempts
    .map((attempt) =>
      [
        attempt.status,
        attempt.result ?? "-",
        attempt.id,
        attempt.obligationId,
        attempt.method.kind,
        attempt.summary,
      ].join("\t"),
    )
    .join("\n");
}

function renderProofAttempt(
  attempt: ReturnType<
    ReturnType<typeof createMemoryInspector>["showProofAttemptById"]
  > | null,
): string {
  if (!attempt) {
    return "No proof attempt found.";
  }

  return [
    `${attempt.status}\t${attempt.result ?? "-"}\t${attempt.id}`,
    `Obligation: ${attempt.obligationId}`,
    `Method: ${attempt.method.kind} (${attempt.method.name})`,
    `Evidence: ${attempt.evidenceRefIds.join(", ") || "-"}`,
    `Artifacts: ${attempt.artifactRefs.map((ref) => ref.id).join(", ") || "-"}`,
    attempt.summary,
  ].join("\n");
}

function renderClaimGraph(
  edges: ReturnType<ReturnType<typeof createMemoryInspector>["showClaimGraph"]>,
): string {
  if (edges.length === 0) {
    return "No claim graph edges found.";
  }

  return edges
    .map((edge) =>
      [
        edge.sourceRecordId,
        edge.relationship,
        edge.targetRecordId,
        edge.evidenceRefId ?? "-",
      ].join("\t"),
    )
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

await main();

async function createRuntimeConfig(args: {
  inspectRoots: string[];
  inspectPaths: string[];
  inspectAction: LocalInspectionAction;
  inspectBytes: number | undefined;
  runtimeTools: RuntimeToolConfig;
  workspaceRoot?: string;
}): Promise<{
  events: ResearchEvent[];
  memory: ResearchMemorySnapshot | undefined;
  tools: ResearchToolDescriptor[];
  toolRegistry: ResearchToolRegistry | undefined;
  skills: ResearchSkillDescriptor[];
  governance: ResearchGovernancePolicy | undefined;
  workspaceContext: ResearchWorkspaceContext;
  capture: Record<string, unknown>;
  cleanup?: () => Promise<void>;
}> {
  const families = resolveEnabledToolFamilies(args);
  const executableTools: ResearchExecutableTool[] = [];
  const toolDescriptors: ResearchToolDescriptor[] = [];
  const events: ResearchEvent[] = [];
  const skills = loadCliSkills(args.runtimeTools.skillDirs);
  const governance = createCliGovernance(args.runtimeTools);
  const cleanupCallbacks: (() => Promise<void>)[] = [];
  const storageLayout = createResearchStorageLayout({
    workspaceRoot: args.workspaceRoot ?? process.cwd(),
  });
  const workspaceContext = mergeResearchWorkspaceContexts({
    base: createResearchWorkspaceContext({
      workspaceRoot: args.workspaceRoot ?? process.cwd(),
      storageLayout,
      knownRepositories: args.runtimeTools.repoRoots.map((root) => ({
        rootPath: root,
        role: "known_repository",
        source: "cli",
      })),
      materializedSourcePaths: args.runtimeTools.sourcePaths,
      projectNotes: args.runtimeTools.projectNotes,
    }),
    ...(args.runtimeTools.workspaceContextPath
      ? {
          overlay: loadResearchWorkspaceContextFile(
            args.runtimeTools.workspaceContextPath,
          ),
        }
      : {}),
  });
  const mcpCapture = await configureRuntimeMcpTools({
    runtimeTools: args.runtimeTools,
    executableTools,
    toolDescriptors,
    cleanupCallbacks,
  });

  validateSelectedSkillIds(skills, args.runtimeTools.selectedSkillIds);

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

  if (families.has("repository-search")) {
    const tool = createRepositorySearchTool({
      roots: repositorySearchRootsFromWorkspaceContext(workspaceContext),
      ...(args.runtimeTools.toolMaxBytes
        ? { maxFileBytes: args.runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("file-read")) {
    const tool = createStructuredFileReadTool({
      contextRoots: workspaceContextFileReadHints(workspaceContext),
      ...(args.runtimeTools.toolMaxBytes
        ? { maxBytes: args.runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
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
    if (!args.runtimeTools.experimentConfigPath) {
      throw new Error("experiment tool family requires --experiment-config.");
    }
    const tool = createConfiguredExperimentTool({
      config: loadResearchExperimentConfig(args.runtimeTools.experimentConfigPath),
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
    memory: events.length > 0 ? routeEventsToMemorySnapshot(events) : undefined,
    tools: toolDescriptors,
    toolRegistry:
      executableTools.length > 0
        ? createResearchToolRegistry(executableTools)
        : undefined,
    skills,
    governance,
    workspaceContext,
    capture: createRuntimeCapture({
      families,
      args,
      tools: toolDescriptors,
      skills,
      governance,
      workspaceContext,
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
  const allowedServers =
    input.runtimeTools.allowedMcpServers.length > 0
      ? input.runtimeTools.allowedMcpServers
      : config.allowedServers;
  const missingAllowedServers = allowedServers.filter(
    (serverName) => !configuredServers.includes(serverName),
  );
  if (missingAllowedServers.length > 0) {
    throw new Error(
      `Allowed MCP server(s) are not defined in ${input.runtimeTools.mcpConfigPath}: ${missingAllowedServers.join(", ")}`,
    );
  }

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
  mcpCapture?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
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
    },
    governance: input.governance ?? null,
    mcp:
      input.mcpCapture ??
      {
        allowedServers: input.args.runtimeTools.allowedMcpServers,
        discoveredCapabilities: [],
        status:
          input.args.runtimeTools.allowedMcpServers.length > 0
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
  result: Awaited<ReturnType<typeof bootstrapResearchRun>>,
  runtimeConfig?: Record<string, unknown>,
): Promise<string> {
  const absolutePath = resolve(capturePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const capture = createResearchFlowCapture(result);
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
