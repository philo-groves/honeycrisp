#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  bootstrapResearchRun,
  compileContextPacketV2,
  createAnalysisTool,
  createLocalInspectionObservationEvent,
  createLocalInspectionTool,
  createDeterministicLoopExecutor,
  createMemoryDrivenController,
  createMemoryInspector,
  createPiAgentLoopExecutor,
  createPiLoopExecutor,
  createRepositorySearchTool,
  createResearchToolRegistry,
  createResearchFlowCapture,
  createResearchGoalFrame,
  createStructuredFileReadTool,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
  createSynthesisTool,
  getAuthStatus,
  listAuthProviders,
  loadResearchSkillsFromDirectory,
  loginAuthProvider,
  logoutAuthProvider,
  routeEventsToMemorySnapshot,
  verifyProviderAuth,
} from "@honeycrisp/research-agent";
import type {
  AuthEvent,
  AuthLoginCallbacks,
  AuthPrompt,
  LocalInspectionAction,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchMemorySnapshot,
  ResearchSkillDescriptor,
  ResearchToolDescriptor,
  ResearchToolSideEffect,
  ResearchToolRegistry,
} from "@honeycrisp/research-agent";

const VERSION = "0.1.0";

type ToolFamily =
  | "local-inspection"
  | "repository-search"
  | "file-read"
  | "analysis"
  | "synthesis";

type CliExecutorKind = "complete-simple" | "agent";
type CliToolExecutionMode = "sequential" | "parallel";

interface RuntimeToolConfig {
  toolFamilies: readonly ToolFamily[];
  disabledToolFamilies: readonly ToolFamily[];
  repoRoots: readonly string[];
  fileReadRoots: readonly string[];
  allowedSideEffects: readonly ResearchToolSideEffect[];
  allowedMcpServers: readonly string[];
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
  provider: string;
  model: string;
  maxTokens: number | undefined;
  reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
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

function parseArgs(argv: readonly string[]): ParsedArgs {
  let prompt: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  let mock = false;
  let provider = "openai-codex";
  let model = "gpt-5.3-codex-spark";
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
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
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
      allowedSideEffects,
      allowedMcpServers,
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

function parseToolsArgs(argv: readonly string[]): ParsedToolsArgs {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let json = false;
  let help = false;
  let inspectAction: LocalInspectionAction = "read_text";
  let inspectBytes: number | undefined;
  const inspectRoots: string[] = [];
  const inspectPaths: string[] = [];
  const toolFamilies: ToolFamily[] = [];
  const disabledToolFamilies: ToolFamily[] = [];
  const repoRoots: string[] = [];
  const fileReadRoots: string[] = [];
  const allowedSideEffects: ResearchToolSideEffect[] = [];
  const allowedMcpServers: string[] = [];
  const selectedSkillIds: string[] = [];
  const skillDirs: string[] = [];
  let toolMaxCalls: number | undefined;
  let toolRuntimeMs: number | undefined;
  let toolMaxFiles: number | undefined;
  let toolMaxBytes: number | undefined;
  let toolMaxTokens: number | undefined;

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--inspect-root") {
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
      allowedSideEffects,
      allowedMcpServers,
      selectedSkillIds,
      skillDirs,
      ...(toolMaxCalls ? { toolMaxCalls } : {}),
      ...(toolRuntimeMs ? { toolRuntimeMs } : {}),
      ...(toolMaxFiles ? { toolMaxFiles } : {}),
      ...(toolMaxBytes ? { toolMaxBytes } : {}),
      ...(toolMaxTokens ? { toolMaxTokens } : {}),
    },
    inspectRoots,
    inspectPaths,
    inspectAction,
    inspectBytes,
    json,
    help,
  };
}

function parseReasoning(value: string): ParsedArgs["reasoning"] {
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
    value === "synthesis"
  ) {
    return value;
  }

  throw new Error(
    "--tool-family must be one of local-inspection, repository-search, file-read, analysis, synthesis.",
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
    "  --provider <provider>  Model provider for real mode (default: openai-codex)",
    "  --model <model>        Model id for real mode (default: gpt-5.3-codex-spark)",
    "  --executor <kind>      complete-simple or agent (default: complete-simple)",
    "  --max-tokens <n>       Max output tokens for real mode",
    "  --reasoning <level>    Reasoning level for real mode",
    "  --tool-execution <m>   Agent tool execution mode: sequential or parallel",
    "  --inspect-root <path>  Allow a local root for read-only inspection",
    "  --inspect-path <path>  Inspect a local path before the loop",
    "  --inspect-action <a>   Inspection action: read_text or list",
    "  --inspect-bytes <n>    Max bytes for read_text inspection",
    "  --tool-family <name>   Enable local-inspection, repository-search, file-read, analysis, or synthesis",
    "  --disable-tool-family <name> Disable a tool family after implicit/default enables",
    "  --repo-root <path>     Enable repository.search for this root unless disabled",
    "  --file-read-root <p>   Enable file.read for this allowed root unless disabled",
    "  --allowed-side-effect <s> Allow tool side effect: none, read, write, network, process",
    "  --tool-max-calls <n>   Max tool calls for governance",
    "  --tool-runtime-ms <n>  Max runtime per tool call in milliseconds",
    "  --tool-max-files <n>   Max files for file-oriented tools",
    "  --tool-max-bytes <n>   Max bytes for file-oriented tools",
    "  --tool-max-tokens <n>  Max tool output tokens",
    "  --allow-mcp-server <s> Allow an MCP server name in runtime config",
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

    const loopExecutor = args.mock
      ? createDeterministicLoopExecutor(
          runtimeConfig.toolRegistry
            ? { toolRegistry: runtimeConfig.toolRegistry }
            : {},
        )
      : await createRealLoopExecutor(args, runtimeConfig.toolRegistry);

    const inspectionState =
      runtimeConfig.events.length > 0 && runtimeConfig.memory
        ? {
            events: runtimeConfig.events,
            memory: runtimeConfig.memory,
          }
        : {};

    const result = await bootstrapResearchRun({
      prompt: args.prompt,
      successGates: args.successGates,
      failureOrStopGates: args.failureOrStopGates,
      scopeConstraints: args.scopeConstraints,
      evidenceRequirements: args.evidenceRequirements,
      initialRiskFlags: args.initialRiskFlags,
      userPreferences: args.userPreferences,
      ...inspectionState,
      ...(runtimeConfig.tools.length > 0 ? { tools: runtimeConfig.tools } : {}),
      ...(runtimeConfig.skills.length > 0 ? { skills: runtimeConfig.skills } : {}),
      ...(args.runtimeTools.selectedSkillIds.length > 0
        ? { selectedSkillIds: args.runtimeTools.selectedSkillIds }
        : {}),
      ...(runtimeConfig.governance ? { governance: runtimeConfig.governance } : {}),
      loopExecutor,
      ...(args.goalLoops !== undefined
        ? { goalRun: { maxLoops: args.goalLoops } }
        : {}),
    });
    persistTopLevelRunEvents(args.workspaceRoot, result.events);

    if (args.capturePath) {
      const capturePath = await writeFlowCapture(
        args.capturePath,
        result,
        runtimeConfig.capture,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`honeycrisp: ${message}`);
    process.exitCode = 1;
  }
}

function persistTopLevelRunEvents(
  workspaceRoot: string,
  events: readonly ResearchEvent[],
): void {
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  try {
    eventLog.appendMany(events);
  } finally {
    eventLog.close();
  }
}

async function createRealLoopExecutor(
  args: ParsedArgs,
  toolRegistry: ResearchToolRegistry | undefined,
) {
  const auth = await verifyProviderAuth(args.provider, args.model);
  if (!auth.configured) {
    throw new Error(
      `real mode requires configured credentials for ${auth.providerName} (${auth.providerId}). Run: honeycrisp auth login ${auth.providerId}, or pass --mock for deterministic mode.`,
    );
  }

  const executorInput = {
    provider: args.provider,
    model: args.model,
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    ...(toolRegistry ? { toolRegistry } : {}),
  };

  return args.executor === "agent"
    ? createPiAgentLoopExecutor({
        ...executorInput,
        ...(args.toolExecution ? { toolExecution: args.toolExecution } : {}),
      })
    : createPiLoopExecutor(executorInput);
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
  const inspector = createMemoryInspector({ eventLog, recordStore });

  try {
    if (args.command === "timeline") {
      printMemoryOutput(args, inspector.eventTimeline(), renderTimeline);
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

    if (args.command === "claim-graph") {
      printMemoryOutput(args, inspector.showClaimGraph(), renderClaimGraph);
      return;
    }

    if (args.command === "prospective-checks") {
      printMemoryOutput(args, inspector.showProspectiveChecks(), renderRecords);
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
  if (args.json) {
    console.log(JSON.stringify(runtime.capture, null, 2));
    return;
  }

  console.log(renderToolsList(runtime.capture));
}

function toolsUsage(): string {
  return [
    "Usage: honeycrisp tools list [options]",
    "",
    "Options:",
    "  --tool-family <name>        Enable local-inspection, repository-search, file-read, analysis, or synthesis",
    "  --disable-tool-family <n>   Disable a tool family after implicit/default enables",
    "  --repo-root <path>          Enable repository.search for this root unless disabled",
    "  --file-read-root <path>     Enable file.read for this allowed root unless disabled",
    "  --inspect-root <path>       Enable local.inspection for this root unless disabled",
    "  --allowed-side-effect <s>   Allow side effect: none, read, write, network, process",
    "  --tool-max-calls <n>        Max tool calls",
    "  --tool-runtime-ms <n>       Max runtime per tool call in milliseconds",
    "  --tool-max-files <n>        Max file count",
    "  --tool-max-bytes <n>        Max file bytes",
    "  --tool-max-tokens <n>       Max tool output tokens",
    "  --allow-mcp-server <name>   Record an allowed MCP server name",
    "  --skill-dir <path>          Load local skills from child directories containing SKILL.md",
    "  --skill <id>                Request a loaded skill by id",
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
    "  event <event-id>           Show one accepted raw event",
    "  records-for-event <id>     Show derived records for an event",
    "  recall --goal <text>       Run a recall query",
    "  preconscious --goal <text> Show preconscious candidates",
    "  context --goal <text>      Show compiled context selections",
    "  decision --goal <text>     Explain selected action",
    "  hypotheses                 Show hypotheses and semantic claims",
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
  const contextPacket = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: decision.subGoal,
    retrieval,
    tools: [],
  });

  return { goalFrame, retrieval, decision, contextPacket };
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
  records: ReturnType<ReturnType<typeof createMemoryInspector>["showHypotheses"]>,
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

  return context.sections
    .map((section) =>
      [
        section.label,
        `items=${section.itemCount}`,
        `tokens=${section.estimatedTokens}/${section.tokenBudget}`,
        `selected=${section.selectedRecordIds.join(",") || "-"}`,
      ].join("\t"),
    )
    .join("\n");
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
}): Promise<{
  events: ResearchEvent[];
  memory: ResearchMemorySnapshot | undefined;
  tools: ResearchToolDescriptor[];
  toolRegistry: ResearchToolRegistry | undefined;
  skills: ResearchSkillDescriptor[];
  governance: ResearchGovernancePolicy | undefined;
  capture: Record<string, unknown>;
}> {
  const families = resolveEnabledToolFamilies(args);
  const executableTools = [];
  const toolDescriptors: ResearchToolDescriptor[] = [];
  const events: ResearchEvent[] = [];
  const skills = loadCliSkills(args.runtimeTools.skillDirs);
  const governance = createCliGovernance(args.runtimeTools);

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
    if (args.runtimeTools.repoRoots.length === 0) {
      throw new Error("repository-search requires --repo-root.");
    }

    if (args.runtimeTools.repoRoots.length > 1) {
      throw new Error("repository-search currently accepts one --repo-root.");
    }

    const root = args.runtimeTools.repoRoots[0];
    if (!root) {
      throw new Error("repository-search requires --repo-root.");
    }

    const tool = createRepositorySearchTool({
      root,
      ...(args.runtimeTools.toolMaxBytes
        ? { maxFileBytes: args.runtimeTools.toolMaxBytes }
        : {}),
    });
    executableTools.push(tool);
    toolDescriptors.push(tool.descriptor);
  }

  if (families.has("file-read")) {
    if (args.runtimeTools.fileReadRoots.length === 0) {
      throw new Error("file-read requires at least one --file-read-root.");
    }

    const tool = createStructuredFileReadTool({
      allowedRoots: args.runtimeTools.fileReadRoots,
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
    capture: createRuntimeCapture({
      families,
      args,
      tools: toolDescriptors,
      skills,
      governance,
    }),
  };
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
  if (args.runtimeTools.fileReadRoots.length > 0) {
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
}): Record<string, unknown> {
  return {
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
    mcp: {
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
