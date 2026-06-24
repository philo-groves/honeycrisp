#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  bootstrapResearchRun,
  compileContextPacketV2,
  createLocalInspectionObservationEvent,
  createLocalInspectionTool,
  createMemoryDrivenController,
  createMemoryInspector,
  createPiLoopExecutor,
  createResearchFlowCapture,
  createResearchGoalFrame,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
  getAuthStatus,
  listAuthProviders,
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
  ResearchMemorySnapshot,
  ResearchToolDescriptor,
} from "@honeycrisp/research-agent";

const VERSION = "0.1.0";

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
  inspectRoots: string[];
  inspectPaths: string[];
  inspectAction: LocalInspectionAction;
  inspectBytes: number | undefined;
  capturePath: string | undefined;
  goalLoops: number | null | undefined;
  json: boolean;
  help: boolean;
  version: boolean;
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
  let maxTokens: number | undefined;
  let reasoning: ParsedArgs["reasoning"];
  let inspectAction: LocalInspectionAction = "read_text";
  let inspectBytes: number | undefined;
  let capturePath: string | undefined;
  let goalLoops: number | null | undefined;
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
    } else if (arg === "--capture") {
      capturePath = readOptionValue(argv, index, arg);
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
    inspectRoots,
    inspectPaths,
    inspectAction,
    inspectBytes,
    capturePath,
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
    "  --max-tokens <n>       Max output tokens for real mode",
    "  --reasoning <level>    Reasoning level for real mode",
    "  --inspect-root <path>  Allow a local root for read-only inspection",
    "  --inspect-path <path>  Inspect a local path before the loop",
    "  --inspect-action <a>   Inspection action: read_text or list",
    "  --inspect-bytes <n>    Max bytes for read_text inspection",
    "  --capture <path>       Write a local flow-capture JSON artifact",
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

    const inspectionSeed = await createInspectionSeed(args);

    const loopExecutor = args.mock
      ? undefined
      : await createRealLoopExecutor(args);

    const inspectionState =
      inspectionSeed.events.length > 0 && inspectionSeed.memory
        ? {
            events: inspectionSeed.events,
            memory: inspectionSeed.memory,
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
      ...(inspectionSeed.tools.length > 0 ? { tools: inspectionSeed.tools } : {}),
      ...(loopExecutor ? { loopExecutor } : {}),
      ...(args.goalLoops !== undefined
        ? { goalRun: { maxLoops: args.goalLoops } }
        : {}),
    });

    if (args.capturePath) {
      const capturePath = await writeFlowCapture(args.capturePath, result);
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

async function createRealLoopExecutor(args: ParsedArgs) {
  const auth = await verifyProviderAuth(args.provider, args.model);
  if (!auth.configured) {
    throw new Error(
      `real mode requires configured credentials for ${auth.providerName} (${auth.providerId}). Run: honeycrisp auth login ${auth.providerId}, or pass --mock for deterministic mode.`,
    );
  }

  return createPiLoopExecutor({
    provider: args.provider,
    model: args.model,
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
  });
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

await main();

async function createInspectionSeed(args: ParsedArgs): Promise<{
  events: ResearchEvent[];
  memory: ResearchMemorySnapshot | undefined;
  tools: ResearchToolDescriptor[];
}> {
  if (args.inspectPaths.length > 0 && args.inspectRoots.length === 0) {
    throw new Error("--inspect-path requires at least one --inspect-root.");
  }

  if (args.inspectRoots.length === 0) {
    return {
      events: [],
      memory: undefined,
      tools: [],
    };
  }

  const tool = createLocalInspectionTool({
    allowedRoots: args.inspectRoots,
    ...(args.inspectBytes ? { maxBytes: args.inspectBytes } : {}),
  });
  const events: ResearchEvent[] = [];

  for (const path of args.inspectPaths) {
    const result = await tool.inspect({
      action: args.inspectAction,
      path,
      ...(args.inspectBytes ? { maxBytes: args.inspectBytes } : {}),
    });
    events.push(createLocalInspectionObservationEvent(result));
  }

  return {
    events,
    memory: events.length > 0 ? routeEventsToMemorySnapshot(events) : undefined,
    tools: [tool.descriptor],
  };
}

async function writeFlowCapture(
  capturePath: string,
  result: Awaited<ReturnType<typeof bootstrapResearchRun>>,
): Promise<string> {
  const absolutePath = resolve(capturePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `${JSON.stringify(createResearchFlowCapture(result), null, 2)}\n`,
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
