import { createId, nowIso } from "./ids.js";
import { createAuthenticatedModels } from "./auth.js";
import {
  extractResearchTraceFromText,
  normalizeResearchTrace,
  renderResearchTraceContract,
} from "./research-trace.js";
import type {
  Context,
  Message,
  ToolCall,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createToolResultMessage,
  type ResearchToolExecutionResult,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import type {
  ResearchCompletionGateResult,
  ResearchContextPacket,
  ResearchEvent,
  ResearchLoopContextSection,
  ResearchLoopExecutionMode,
  ResearchLoopExecutionInput,
  ResearchLoopExecutionOutput,
  ResearchLoopExecutor,
  ResearchLoopFollowUpRecommendation,
  ResearchLoopModelInput,
  ResearchLoopPlan,
  ResearchLoopProcessingResult,
  ResearchTrace,
} from "./types.js";

export interface ProcessResearchLoopInput {
  loopPlan: ResearchLoopPlan;
  executor?: ResearchLoopExecutor;
  signal?: AbortSignal;
}

export async function processResearchLoop(
  input: ProcessResearchLoopInput,
): Promise<ResearchLoopProcessingResult> {
  const startedAt = nowIso();
  const modelInput = compileLoopModelInput(input.loopPlan);
  const executor = input.executor ?? createDeterministicLoopExecutor();

  try {
    const output = await executor.execute({
      loopPlan: input.loopPlan,
      modelInput,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const completedAt = nowIso();

    return {
      id: createId("loopresult"),
      loopPlanId: input.loopPlan.id,
      subGoalId: input.loopPlan.subGoal.id,
      status: "complete",
      executorName: executor.name,
      startedAt,
      completedAt,
      modelInput,
      output,
      completionGateResults: evaluateCompletionGates(input.loopPlan, output),
      ...recommendFollowUp(input.loopPlan, output),
    };
  } catch (error) {
    const completedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const output: ResearchLoopExecutionOutput = {
      text: message,
      artifacts: [],
      evidenceRefs: [],
      claimRefs: [],
      followUpActions: ["Report the loop processing error before continuing."],
    };

    return {
      id: createId("loopresult"),
      loopPlanId: input.loopPlan.id,
      subGoalId: input.loopPlan.subGoal.id,
      status: "error",
      executorName: executor.name,
      startedAt,
      completedAt,
      modelInput,
      output,
      completionGateResults: evaluateCompletionGates(input.loopPlan, output),
      followUpRecommendation: "blocked",
      followUpRationale: "Loop processing raised an error.",
    };
  }
}

export function compileLoopModelInput(
  loopPlan: ResearchLoopPlan,
): ResearchLoopModelInput {
  return {
    loopPrompt: loopPlan.loopPrompt,
    contextSections: createLoopContextSections(loopPlan.contextPacket),
    permittedToolClasses: loopPlan.permittedToolClasses,
    toolBudget: loopPlan.actionBudget,
  };
}

export function createDeterministicLoopExecutor(): ResearchLoopExecutor {
  return {
    name: "deterministic-first-run",
    async execute(input: ResearchLoopExecutionInput) {
      const { loopPlan } = input;
      const text = renderDeterministicLoopOutput(loopPlan);
      const researchTrace = createDeterministicResearchTrace(loopPlan);

      return {
        text,
        artifacts: [...loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: createFollowUpActions(loopPlan),
        researchTrace,
        raw: {
          mode: "deterministic",
          note: "No model call was made.",
        },
      };
    },
  };
}

export interface CreatePiLoopExecutorOptions {
  provider: string;
  model: string;
  authFile?: string;
  maxTokens?: number;
  reasoning?: SimpleStreamOptions["reasoning"];
  models?: Pick<Models, "getModel" | "completeSimple">;
  toolRegistry?: ResearchToolRegistry;
}

type ExtractedToolCall = {
  call: ToolCall;
  source: "native" | "text";
};

export function createPiLoopExecutor(
  options: CreatePiLoopExecutorOptions,
): ResearchLoopExecutor {
  return {
    name: `pi:${options.provider}/${options.model}`,
    async execute(input: ResearchLoopExecutionInput) {
      const models =
        options.models ??
        createAuthenticatedModels(
          options.authFile ? { authFile: options.authFile } : {},
        );
      const model = models.getModel(options.provider, options.model);
      if (!model) {
        throw new Error(
          `Unknown model ${options.provider}/${options.model}`,
        );
      }

      const context = createPiContext(input.modelInput, options.toolRegistry);
      const streamOptions = createPiStreamOptions(options, input.signal);
      const toolEvents: ResearchEvent[] = [];
      let message = await models.completeSimple(model, context, streamOptions);
      const modelCalls = [createModelCallMetadata(message)];
      let toolCallCount = 0;

      for (
        let turnIndex = 0;
        turnIndex < input.loopPlan.actionBudget.maxToolCalls;
        turnIndex += 1
      ) {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          break;
        }

        const toolCalls = extractModelToolCalls(message, options.toolRegistry);
        if (toolCalls.length === 0 || !options.toolRegistry) {
          break;
        }

        context.messages.push(message);
        for (const toolCall of toolCalls) {
          if (toolCallCount >= input.loopPlan.actionBudget.maxToolCalls) {
            break;
          }

          const execution = await options.toolRegistry.executeToolCall(toolCall.call, {
            goalId: input.loopPlan.rootGoalId,
            subGoalId: input.loopPlan.subGoal.id,
            permittedActionClasses: input.loopPlan.permittedToolClasses,
            defaultActionClass: input.loopPlan.subGoal.actionClass,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          toolCallCount += 1;
          toolEvents.push(...execution.events);
          context.messages.push(createToolResultContextMessage(toolCall, execution.result));
        }

        message = await models.completeSimple(model, context, streamOptions);
        modelCalls.push(createModelCallMetadata(message));
      }

      const text = extractAssistantText(message.content);
      const researchTrace = extractResearchTraceFromText(text);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(
          message.errorMessage ?? `Model stopped: ${message.stopReason}`,
        );
      }

      return {
        text,
        artifacts: [...input.loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [
          "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
        ],
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        ...(researchTrace ? { researchTrace } : {}),
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          stopReason: message.stopReason,
          responseId: message.responseId,
          usage: message.usage,
          toolCallCount,
          modelCalls,
        },
      };
    },
  };
}

export function inferResearchLoopExecutionMode(
  loopResult: Pick<ResearchLoopProcessingResult, "executorName" | "output">,
): ResearchLoopExecutionMode {
  const raw = loopResult.output.raw;

  if (isRecord(raw) && raw.mode === "deterministic") {
    return "deterministic";
  }

  if (
    loopResult.executorName.startsWith("pi:") ||
    (isRecord(raw) &&
      typeof raw.provider === "string" &&
      typeof raw.model === "string")
  ) {
    return "model";
  }

  if (loopResult.executorName === "deterministic-first-run") {
    return "deterministic";
  }

  return "custom";
}

function createLoopContextSections(
  packet: ResearchContextPacket,
): ResearchLoopContextSection[] {
  return [
    {
      label: "goal_frame",
      required: true,
      content: packet.goalFrame,
    },
    {
      label: "active_sub_goal",
      required: true,
      content: packet.activeSubGoal,
    },
    {
      label: "direct_evidence",
      required: false,
      content: packet.directEvidence,
    },
    {
      label: "prior_observations",
      required: false,
      content: packet.priorObservations,
    },
    {
      label: "candidate_procedures",
      required: false,
      content: packet.candidateProcedures,
    },
    {
      label: "current_hypotheses",
      required: false,
      content: packet.currentHypotheses,
    },
    {
      label: "contradictions",
      required: false,
      content: packet.contradictions,
    },
    {
      label: "open_questions",
      required: true,
      content: packet.openQuestions,
    },
    {
      label: "user_commitments",
      required: true,
      content: packet.userCommitments,
    },
    {
      label: "tool_permissions",
      required: false,
      content: packet.toolPermissions,
    },
  ];
}

function createPiContext(
  modelInput: ResearchLoopModelInput,
  toolRegistry: ResearchToolRegistry | undefined,
): Context {
  return {
    systemPrompt: [
      "You are Honeycrisp, a goal-oriented research agent built on Pi.",
      "Execute only the current bounded loop. Preserve evidence, inference, hypotheses, uncertainty, and user commitments as distinct categories.",
      "Do not claim that files were inspected unless evidence is present in the supplied context.",
      toolRegistry && toolRegistry.size > 0
        ? "Use available tool calls for permitted bounded actions. Do not print tool-call JSON when native tool calls are available."
        : "If a tool action is needed but unavailable, return a concise tool action JSON object before explaining the blocker.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          "Execute this planned research loop.",
          "",
          "## Loop Prompt",
          modelInput.loopPrompt,
          "",
          "## Labeled Context Sections",
          ...modelInput.contextSections.map(
            (section) =>
              `### ${section.label} (${section.required ? "required" : "optional"})\n${formatContextContent(section.content)}`,
          ),
          "",
          "## Output Shape",
          "Return concise markdown with: Result, Evidence Used, Assumptions, Open Questions, Suggested Next Step.",
          "",
          "## Visible Research Trace",
          renderResearchTraceContract(),
        ].join("\n"),
      },
    ],
    ...(toolRegistry && toolRegistry.size > 0
      ? { tools: toolRegistry.toPiTools() }
      : {}),
  };
}

function createPiStreamOptions(
  options: CreatePiLoopExecutorOptions,
  signal: AbortSignal | undefined,
): SimpleStreamOptions {
  return {
    ...(typeof options.maxTokens === "number"
      ? { maxTokens: options.maxTokens }
      : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(signal ? { signal } : {}),
  };
}

function formatContextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractAssistantText(
  content: Awaited<ReturnType<Models["completeSimple"]>>["content"],
): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function extractModelToolCalls(
  message: Awaited<ReturnType<Models["completeSimple"]>>,
  toolRegistry: ResearchToolRegistry | undefined,
): ExtractedToolCall[] {
  const nativeCalls = message.content.filter(
    (item): item is ToolCall => item.type === "toolCall",
  );
  if (nativeCalls.length > 0) {
    return nativeCalls.map((call) => ({ call, source: "native" }));
  }

  const text = extractAssistantText(message.content);
  const textCall = text
    ? extractTextToolCall(text, toolRegistry)
    : undefined;
  return textCall ? [{ call: textCall, source: "text" }] : [];
}

function createModelCallMetadata(
  message: Awaited<ReturnType<Models["completeSimple"]>>,
): Record<string, unknown> {
  return {
    stopReason: message.stopReason,
    responseId: message.responseId,
    usage: message.usage,
    contentTypes: message.content.map((item) => item.type),
  };
}

function extractTextToolCall(
  text: string,
  toolRegistry: ResearchToolRegistry | undefined,
): ToolCall | undefined {
  const json = extractFirstJsonObject(text);
  if (!json) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const toolName = readToolName(parsed);
    if (!toolName || !toolRegistry?.find(toolName)) {
      return undefined;
    }

    const args = { ...parsed };
    delete args.toolName;
    delete args.name;

    return {
      type: "toolCall",
      id: createId("toolcall"),
      name: toolName,
      arguments: args,
    };
  } catch {
    return undefined;
  }
}

function readToolName(payload: Record<string, unknown>): string | undefined {
  const value = payload.toolName ?? payload.name;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = inString;
      continue;
    }

    if (character === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1).trim();
      }
    }
  }

  return undefined;
}

function createToolResultContextMessage(
  toolCall: ExtractedToolCall,
  result: ResearchToolExecutionResult,
): Message {
  if (toolCall.source === "native") {
    return createToolResultMessage(result, toolCall.call.id, toolCall.call.name);
  }

  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      "Tool result for the textual tool action request:",
      JSON.stringify(
        {
          toolCallId: toolCall.call.id,
          toolName: toolCall.call.name,
          status: result.status,
          summary: result.summary,
          output: result.output,
          error: result.error,
          followUpActions: result.followUpActions,
        },
        null,
        2,
      ),
    ].join("\n"),
  };
}

function renderDeterministicLoopOutput(loopPlan: ResearchLoopPlan): string {
  const lines = [
    `Sub-goal: ${loopPlan.subGoal.objective}`,
    "",
    "Initial loop result:",
    `- Action class: ${loopPlan.subGoal.actionClass}`,
    `- Expected artifacts: ${loopPlan.expectedArtifacts.join(", ") || "none"}`,
    `- Tool calls available in this loop: ${loopPlan.actionBudget.maxToolCalls}`,
    "",
    "Evidence checklist:",
    ...loopPlan.contextPacket.openQuestions.map((question) => `- ${question}`),
  ];

  if (loopPlan.contextPacket.userCommitments.length > 0) {
    lines.push("", "User commitments to preserve:");
    lines.push(
      ...loopPlan.contextPacket.userCommitments.map(
        (commitment) => `- ${commitment}`,
      ),
    );
  }

  return lines.join("\n");
}

function createDeterministicResearchTrace(
  loopPlan: ResearchLoopPlan,
): ResearchTrace {
  return normalizeResearchTrace({
    observations:
      loopPlan.contextPacket.directEvidence.length > 0
        ? [
            {
              text: `The context packet contains ${loopPlan.contextPacket.directEvidence.length} direct evidence reference(s).`,
              evidenceRefIds: loopPlan.contextPacket.directEvidence.map(
                (ref) => ref.id,
              ),
              confidence: 1,
            },
          ]
        : [
            {
              text: "No direct evidence references were supplied to this loop.",
              confidence: 1,
            },
          ],
    inferences: [
      {
        text: `The selected bounded action is ${loopPlan.subGoal.actionClass}.`,
        confidence: 0.8,
      },
    ],
    assumptions: loopPlan.contextPacket.userCommitments.map((commitment) => ({
      text: commitment,
      confidence: 1,
    })),
    uncertainty: loopPlan.contextPacket.openQuestions.map((question) => ({
      text: question,
      confidence: 0.9,
    })),
    nextQuestions: loopPlan.contextPacket.openQuestions.map((question) => ({
      text: question,
      confidence: 0.9,
    })),
    evidenceLinks: loopPlan.contextPacket.directEvidence.map((ref) => ({
      evidenceRefId: ref.id,
      supports: [loopPlan.subGoal.id],
      note: "Direct evidence supplied to the current bounded loop.",
    })),
    goalAssessment: {
      status: "continue",
      rationale:
        "The deterministic executor does not prove root goal completion.",
      unsatisfiedGateIds: loopPlan.contextPacket.goalFrame.root.completionGates.map(
        (gate) => gate.id,
      ),
    },
  });
}

function createFollowUpActions(loopPlan: ResearchLoopPlan): string[] {
  if (loopPlan.subGoal.actionClass === "ask_user") {
    return ["Ask the user for the missing scope or constraints."];
  }

  if (loopPlan.permittedToolClasses.length === 0) {
    return [
      "Respond with the initial plan, or register tools before continuing.",
    ];
  }

  return [
    "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
  ];
}

function evaluateCompletionGates(
  loopPlan: ResearchLoopPlan,
  output: ResearchLoopExecutionOutput,
): ResearchCompletionGateResult[] {
  const hasOutput = output.text.trim().length > 0;

  return loopPlan.completionGates.map((gate) => ({
    gateId: gate.id,
    description: gate.description,
    satisfied: hasOutput,
    ...(hasOutput ? { evidence: "loop output text" } : {}),
  }));
}

function recommendFollowUp(
  loopPlan: ResearchLoopPlan,
  output: ResearchLoopExecutionOutput,
): {
  followUpRecommendation: ResearchLoopFollowUpRecommendation;
  followUpRationale: string;
} {
  if (loopPlan.subGoal.actionClass === "ask_user") {
    return {
      followUpRecommendation: "respond",
      followUpRationale:
        "The loop result is a user-facing clarification request.",
    };
  }

  if (output.evidenceRefs.length > 0 || output.claimRefs.length > 0) {
    return {
      followUpRecommendation: "continue_branch",
      followUpRationale:
        "The loop produced memory references that can drive another bounded step.",
    };
  }

  if ((output.researchTrace?.hypotheses.length ?? 0) > 0) {
    return {
      followUpRecommendation: "continue_branch",
      followUpRationale:
        "The loop produced visible hypotheses that can drive another bounded step.",
    };
  }

  return {
    followUpRecommendation: "respond",
    followUpRationale:
      "The deterministic first-loop processor produced a bounded plan but no new evidence or claims.",
  };
}
