import { createId, nowIso } from "./ids.js";
import { createAuthenticatedModels } from "./auth.js";
import {
  extractResearchTraceFromText,
  normalizeResearchTrace,
  renderResearchTraceContract,
  stripResearchTraceFromText,
} from "./research-trace.js";
import { createRepeatAvoidanceTargets } from "./repeat-targets.js";
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
  type ExecuteToolCallOptions,
  getToolTransportName,
  type ResearchExecutableTool,
  type ResearchToolExecutionResult,
  type ResearchToolExecutionRecord,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import { createResearchStorageLayout } from "./storage.js";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
  ResearchCompletionGateResult,
  ResearchEvent,
  ResearchLoopContextSection,
  ResearchLoopExecutionMode,
  ResearchLoopExecutionInput,
  ResearchLoopExecutionOutput,
  ResearchLoopExecutor,
  ResearchLiveEventSink,
  ResearchLoopFollowUpRecommendation,
  ResearchLoopModelInput,
  ResearchLoopPlan,
  ResearchLoopProcessingResult,
  ResearchNextPromptSuggestion,
  ResearchStorageLayout,
  ResearchTrace,
} from "./types.js";

export interface ProcessResearchLoopInput {
  loopPlan: ResearchLoopPlan;
  executor?: ResearchLoopExecutor;
  storageLayout?: ResearchStorageLayout;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
}

const NEXT_PROMPTS_FENCE = "honeycrisp-next-prompts-json";
const NEXT_PROMPT_SUGGESTION_COUNT = 3;

export async function processResearchLoop(
  input: ProcessResearchLoopInput,
): Promise<ResearchLoopProcessingResult> {
  const startedAt = nowIso();
  const storageLayout = input.storageLayout ?? createResearchStorageLayout();
  const modelInput = compileLoopModelInput(input.loopPlan, {
    storageLayout,
  });
  const executor = input.executor ?? createDeterministicLoopExecutor();

  try {
    const output = await executor.execute({
      loopPlan: input.loopPlan,
      modelInput,
      storageLayout,
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
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
      nextPromptSuggestions: createFallbackNextPromptSuggestions(
        input.loopPlan,
        message,
      ),
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
  options: {
    storageLayout?: ResearchStorageLayout;
  } = {},
): ResearchLoopModelInput {
  const storageLayout = options.storageLayout ?? createResearchStorageLayout();

  return {
    loopPrompt: loopPlan.loopPrompt,
    contextSections: createLoopContextSections(loopPlan, storageLayout),
    permittedToolClasses: loopPlan.permittedToolClasses,
    toolBudget: loopPlan.actionBudget,
    storageLayout,
  };
}

export interface CreateDeterministicLoopExecutorOptions {
  toolRegistry?: ResearchToolRegistry;
}

export function createDeterministicLoopExecutor(
  options: CreateDeterministicLoopExecutorOptions = {},
): ResearchLoopExecutor {
  return {
    name: "deterministic-first-run",
    async execute(input: ResearchLoopExecutionInput) {
      const { loopPlan } = input;
      const plannedExecutions = await executeControllerPlannedToolActions({
        loopPlan,
        ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const text = renderDeterministicLoopOutput(loopPlan, plannedExecutions);
      const researchTrace = createDeterministicResearchTrace(
        loopPlan,
        plannedExecutions,
      );
      const toolEvents = plannedExecutions.flatMap((record) => record.events);

      return {
        text,
        artifacts: [...loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: createFollowUpActions(loopPlan),
        nextPromptSuggestions: createFallbackNextPromptSuggestions(loopPlan, text),
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        researchTrace,
        raw: {
          mode: "deterministic",
          note: "No model call was made.",
          toolCallCount: plannedExecutions.length,
          plannedToolCallCount: plannedExecutions.length,
          skippedCandidateToolActions: loopPlan.skippedToolActions,
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

      const streamOptions = createPiStreamOptions(options, input.signal);
      const toolEvents: ResearchEvent[] = [];
      let toolCallCount = 0;
      const plannedExecutions = await executeControllerPlannedToolActions({
        loopPlan: input.loopPlan,
        ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}),
        ...(input.eventSink ? { eventSink: input.eventSink } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      toolCallCount += plannedExecutions.length;
      toolEvents.push(...plannedExecutions.flatMap((record) => record.events));

      const context = createPiContext(
        input.modelInput,
        createFreeFormToolRegistry(
          options.toolRegistry,
          input.modelInput,
          input.loopPlan.actionBudget.maxToolCalls - toolCallCount,
        ),
      );
      if (plannedExecutions.length > 0) {
        context.messages.push(
          createPlannedToolResultContextMessage(plannedExecutions),
        );
      }

      let message = await models.completeSimple(model, context, streamOptions);
      const modelCalls = [createModelCallMetadata(message)];

      for (
        let turnIndex = 0;
        turnIndex < input.loopPlan.actionBudget.maxToolCalls;
        turnIndex += 1
      ) {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          break;
        }

        if (toolCallCount >= input.loopPlan.actionBudget.maxToolCalls) {
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

          const execution = await options.toolRegistry.executeToolCall(
            toolCall.call,
            createLoopToolExecutionOptions(input.loopPlan, {
              goalId: input.loopPlan.rootGoalId,
              subGoalId: input.loopPlan.subGoal.id,
              permittedActionClasses: input.loopPlan.permittedToolClasses,
              defaultActionClass: input.loopPlan.subGoal.actionClass,
              toolCallCount,
              ...(input.loopPlan.governancePolicy
                ? { governance: input.loopPlan.governancePolicy }
                : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            }),
          );
          toolCallCount += 1;
          toolEvents.push(...execution.events);
          emitLiveResearchEvents(input.eventSink, execution.events);
          context.messages.push(createToolResultContextMessage(toolCall, execution.result));
        }

        if (toolCallCount >= input.loopPlan.actionBudget.maxToolCalls) {
          delete context.tools;
        }
        message = await models.completeSimple(model, context, streamOptions);
        modelCalls.push(createModelCallMetadata(message));
      }

      const parsedOutput = parseLoopModelText(
        extractAssistantText(message.content),
        input.loopPlan,
      );

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(
          message.errorMessage ?? `Model stopped: ${message.stopReason}`,
        );
      }

      return {
        text: parsedOutput.text,
        artifacts: [...input.loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [
          "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
        ],
        nextPromptSuggestions: parsedOutput.nextPromptSuggestions,
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        ...(parsedOutput.researchTrace
          ? { researchTrace: parsedOutput.researchTrace }
          : {}),
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          stopReason: message.stopReason,
          responseId: message.responseId,
          usage: message.usage,
          toolCallCount,
          plannedToolCallCount: plannedExecutions.length,
          skippedCandidateToolActions: input.loopPlan.skippedToolActions,
          modelCalls,
        },
      };
    },
  };
}

export interface CreatePiAgentLoopExecutorOptions {
  provider: string;
  model: string;
  authFile?: string;
  maxTokens?: number;
  reasoning?: SimpleStreamOptions["reasoning"];
  models?: Pick<Models, "getModel" | "streamSimple">;
  toolRegistry?: ResearchToolRegistry;
  toolExecution?: ToolExecutionMode;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
}

export function createPiAgentLoopExecutor(
  options: CreatePiAgentLoopExecutorOptions,
): ResearchLoopExecutor {
  return {
    name: `pi:${options.provider}/${options.model}:agent`,
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

      const toolEvents: ResearchEvent[] = [];
      const agentEvents: Record<string, unknown>[] = [];
      let toolCallCount = 0;
      const plannedExecutions = await executeControllerPlannedToolActions({
        loopPlan: input.loopPlan,
        ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}),
        ...(input.eventSink ? { eventSink: input.eventSink } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      toolCallCount += plannedExecutions.length;
      toolEvents.push(...plannedExecutions.flatMap((record) => record.events));

      const toolExecutionRecords = new Map<string, ResearchToolExecutionRecord>();
      const capturedToolCallIds = new Set<string>();
      const toolCallReservations = new Map<string, number>();
      const agentTools = createPiAgentTools({
        loopPlan: input.loopPlan,
        toolRegistry: createFreeFormToolRegistry(
          options.toolRegistry,
          input.modelInput,
          input.loopPlan.actionBudget.maxToolCalls - toolCallCount,
        ),
        getReservedToolCallCount(toolCallId) {
          const reserved = toolCallReservations.get(toolCallId);
          if (typeof reserved === "number") {
            return reserved;
          }

          const fallback = toolCallCount;
          toolCallReservations.set(toolCallId, fallback);
          toolCallCount += 1;
          return fallback;
        },
        recordExecution(record) {
          toolExecutionRecords.set(record.action.id, record);
        },
      });
      const prompts = [
        createPiAgentUserMessage(input.modelInput),
        ...(plannedExecutions.length > 0
          ? [createPlannedToolResultContextMessage(plannedExecutions)]
          : []),
      ];
      const context: {
        systemPrompt: string;
        messages: AgentMessage[];
        tools?: AgentTool[];
      } = {
        systemPrompt: createPiSystemPrompt(agentTools.length > 0),
        messages: [],
        ...(agentTools.length > 0 ? { tools: agentTools } : {}),
      };
      const toolExecution = options.toolExecution ?? "sequential";

      const agentMessages = await runAgentLoop(
        prompts,
        context,
        {
          model,
          convertToLlm: convertAgentMessagesToLlm,
          ...(typeof options.maxTokens === "number"
            ? { maxTokens: options.maxTokens }
            : {}),
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          toolExecution,
          beforeToolCall: async (hookContext, signal) => {
            const toolCall = createToolCallFromAgentHook(hookContext);
            const preflight = options.toolRegistry?.preflightToolCall(
              toolCall,
              createLoopToolExecutionOptions(input.loopPlan, {
                goalId: input.loopPlan.rootGoalId,
                subGoalId: input.loopPlan.subGoal.id,
                permittedActionClasses: input.loopPlan.permittedToolClasses,
                defaultActionClass: input.loopPlan.subGoal.actionClass,
                toolCallCount,
                ...(input.loopPlan.governancePolicy
                  ? { governance: input.loopPlan.governancePolicy }
                  : {}),
                ...(signal ? { signal } : {}),
              }),
            );
            if (preflight) {
              toolCallReservations.set(toolCall.id, toolCallCount);
              toolCallCount += 1;
              toolExecutionRecords.set(toolCall.id, preflight);
              capturedToolCallIds.add(toolCall.id);
              toolEvents.push(...preflight.events);
              emitLiveResearchEvents(input.eventSink, preflight.events);
              return {
                block: true,
                reason: preflight.result.summary,
              };
            }

            toolCallReservations.set(toolCall.id, toolCallCount);
            toolCallCount += 1;
            return undefined;
          },
          afterToolCall: async (hookContext) => {
            const record = toolExecutionRecords.get(hookContext.toolCall.id);
            if (record && !capturedToolCallIds.has(hookContext.toolCall.id)) {
              capturedToolCallIds.add(hookContext.toolCall.id);
              toolEvents.push(...record.events);
              emitLiveResearchEvents(input.eventSink, record.events);
            }

            const result = record?.result;
            return result
              ? {
                  content: createPiAgentToolContent(result),
                  details: result,
                  isError: result.status !== "complete",
                }
              : undefined;
          },
          prepareNextTurn: ({ context: nextContext }) => {
            if (
              toolCallCount >= input.loopPlan.actionBudget.maxToolCalls &&
              nextContext.tools &&
              nextContext.tools.length > 0
            ) {
              return {
                context: {
                  ...nextContext,
                  tools: [],
                },
              };
            }

            return undefined;
          },
          getSteeringMessages: options.getSteeringMessages ?? (async () => []),
          getFollowUpMessages: async () => [],
        },
        async (event) => {
          agentEvents.push(captureAgentEvent(event));
          await emitAgentLiveEvent(input.eventSink, event);
        },
        input.signal,
        models.streamSimple.bind(models),
      );

      const assistantMessages = agentMessages.filter(isAssistantMessage);
      const finalAssistant = assistantMessages[assistantMessages.length - 1];
      const parsedOutput = parseLoopModelText(
        finalAssistant ? extractAssistantText(finalAssistant.content) : "",
        input.loopPlan,
      );

      if (
        finalAssistant &&
        (finalAssistant.stopReason === "error" ||
          finalAssistant.stopReason === "aborted")
      ) {
        throw new Error(
          finalAssistant.errorMessage ?? `Model stopped: ${finalAssistant.stopReason}`,
        );
      }

      return {
        text: parsedOutput.text,
        artifacts: [...input.loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [
          "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
        ],
        nextPromptSuggestions: parsedOutput.nextPromptSuggestions,
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        ...(parsedOutput.researchTrace
          ? { researchTrace: parsedOutput.researchTrace }
          : {}),
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          lifecycle: "pi-agent",
          toolExecutionMode: toolExecution,
          toolCallCount,
          plannedToolCallCount: plannedExecutions.length,
          skippedCandidateToolActions: input.loopPlan.skippedToolActions,
          modelCalls: assistantMessages.map(createModelCallMetadata),
          agentEvents,
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
  loopPlan: ResearchLoopPlan,
  storageLayout: ResearchStorageLayout,
): ResearchLoopContextSection[] {
  const packet = loopPlan.contextPacket;
  const repeatAvoidanceTargets = createRepeatAvoidanceTargets(packet);
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
      label: "workspace_context",
      required: true,
      content: packet.workspaceContext ?? null,
    },
    {
      label: "storage",
      required: true,
      content: storageLayout,
    },
    {
      label: "direct_evidence",
      required: false,
      content: packet.directEvidence,
    },
    {
      label: "avoid_repeated_targets",
      required: repeatAvoidanceTargets.length > 0,
      content: repeatAvoidanceTargets,
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
      label: "current_findings",
      required: false,
      content: packet.currentFindings,
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
      label: "selected_skills",
      required: false,
      content: packet.selectedSkills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        description: skill.description,
        domainTags: skill.domainTags,
        instructions: skill.instructions,
        recommendedToolNames: skill.recommendedToolNames,
        recommendedActionClasses: skill.recommendedActionClasses,
        governanceHints: skill.governanceHints,
        runbook: skill.runbook,
        selectionReasons: skill.selectionReasons,
      })),
    },
    {
      label: "tool_permissions",
      required: false,
      content: packet.toolPermissions,
    },
    {
      label: "candidate_tool_actions",
      required: false,
      content: loopPlan.candidateToolActions,
    },
    {
      label: "skipped_tool_actions",
      required: false,
      content: loopPlan.skippedToolActions,
    },
  ];
}

function createLoopToolExecutionOptions(
  loopPlan: ResearchLoopPlan,
  options: ExecuteToolCallOptions,
): ExecuteToolCallOptions {
  const excludedPaths = createRepeatAvoidanceTargets(loopPlan.contextPacket).map(
    (target) => target.path,
  );

  return {
    ...options,
    ...(excludedPaths.length > 0 ? { excludedPaths } : {}),
  };
}

function createFreeFormToolRegistry(
  toolRegistry: ResearchToolRegistry | undefined,
  modelInput: ResearchLoopModelInput,
  remainingToolCalls: number,
): ResearchToolRegistry | undefined {
  if (
    !toolRegistry ||
    toolRegistry.size === 0 ||
    modelInput.permittedToolClasses.length === 0 ||
    remainingToolCalls <= 0
  ) {
    return undefined;
  }

  return toolRegistry;
}

async function executeControllerPlannedToolActions(input: {
  loopPlan: ResearchLoopPlan;
  toolRegistry?: ResearchToolRegistry;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
}): Promise<ResearchToolExecutionRecord[]> {
  if (!input.toolRegistry || input.loopPlan.candidateToolActions.length === 0) {
    return [];
  }

  const records: ResearchToolExecutionRecord[] = [];
  for (const action of input.loopPlan.candidateToolActions) {
    if (records.length >= input.loopPlan.actionBudget.maxToolCalls) {
      break;
    }

    const record = await input.toolRegistry.execute(
      action,
      createLoopToolExecutionOptions(input.loopPlan, {
        goalId: input.loopPlan.rootGoalId,
        subGoalId: input.loopPlan.subGoal.id,
        permittedActionClasses: input.loopPlan.permittedToolClasses,
        defaultActionClass: input.loopPlan.subGoal.actionClass,
        toolCallCount: records.length,
        ...(input.loopPlan.governancePolicy
          ? { governance: input.loopPlan.governancePolicy }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    records.push(record);
    emitLiveResearchEvents(input.eventSink, record.events);
  }

  return records;
}

interface ParsedLoopModelText {
  text: string;
  researchTrace?: ResearchTrace;
  nextPromptSuggestions: readonly ResearchNextPromptSuggestion[];
}

function parseLoopModelText(
  rawText: string,
  loopPlan: ResearchLoopPlan,
): ParsedLoopModelText {
  const researchTrace = extractResearchTraceFromText(rawText);
  const nextPromptSuggestions = normalizeNextPromptSuggestions(
    extractNextPromptSuggestionsJson(rawText),
    loopPlan,
    rawText,
  );
  const text = stripReservedVisibleOutputSections(
    stripNextPromptSuggestionsFromText(stripResearchTraceFromText(rawText)),
  ).trim();

  return {
    text,
    ...(researchTrace ? { researchTrace } : {}),
    nextPromptSuggestions,
  };
}

function renderNextPromptSuggestionsContract(): string {
  return [
    `At the end, include one fenced JSON block named ${NEXT_PROMPTS_FENCE}.`,
    "This block drives clickable UI suggestions and replaces narrative Next Steps.",
    "Return exactly three suggestions. Each suggestion must be a complete prompt for a follow-up Honeycrisp research session.",
    "Use this exact object shape:",
    `\`\`\`${NEXT_PROMPTS_FENCE}`,
    JSON.stringify(
      [
        {
          title: "Verify current candidate",
          promptMarkdown:
            "Skeptically verify the current candidate with fresh evidence. Build or reject an end-to-end proof before confirming it.",
          rationale: "Continues the strongest current branch.",
        },
        {
          title: "Expand nearby surface",
          promptMarkdown:
            "Inspect adjacent code or evidence for related behavior, avoiding targets already exhausted in memory.",
          rationale: "Looks for nearby follow-up evidence.",
        },
        {
          title: "Summarize and persist",
          promptMarkdown:
            "Summarize the current evidence, uncertainty, and persisted artifacts, then recommend whether to continue or stop.",
          rationale: "Turns the run into reusable memory.",
        },
      ],
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function extractNextPromptSuggestionsJson(text: string): unknown {
  const json = extractTaggedJsonFence(text, NEXT_PROMPTS_FENCE);
  if (!json) {
    return undefined;
  }

  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function stripNextPromptSuggestionsFromText(text: string): string {
  return stripTaggedFence(text, NEXT_PROMPTS_FENCE);
}

function stripReservedVisibleOutputSections(text: string): string {
  const reservedSection = new RegExp(
    String.raw`(^|\n)#{1,6}\s*(?:next steps?|suggested next steps?|suggested next step|goal assessment|checkpoint|subgoals?)\b[\s\S]*?(?=\n#{1,6}\s+\S|$)`,
    "gi",
  );
  return text.replace(reservedSection, "\n").trim();
}

function extractTaggedJsonFence(text: string, tag: string): string | undefined {
  const completeFence = new RegExp(
    `\n?\`\`\`${escapeRegExp(tag)}\\s*([\\s\\S]*?)\`\`\``,
    "i",
  );
  const complete = text.match(completeFence);
  if (complete?.[1]) {
    return complete[1].trim();
  }

  const openFence = new RegExp(
    `\n?\`\`\`${escapeRegExp(tag)}\\s*([\\s\\S]*)$`,
    "i",
  );
  const open = text.match(openFence);
  return open?.[1] ? extractFirstJsonValue(open[1]) : undefined;
}

function stripTaggedFence(text: string, tag: string): string {
  const completeFence = new RegExp(
    `\n?\`\`\`${escapeRegExp(tag)}\\s*[\\s\\S]*?\`\`\``,
    "gi",
  );
  const withoutComplete = text.replace(completeFence, "");
  const openFence = new RegExp(
    `\n?\`\`\`${escapeRegExp(tag)}\\s*[\\s\\S]*$`,
    "i",
  );
  return withoutComplete.replace(openFence, "").trim();
}

function extractFirstJsonValue(text: string): string | undefined {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = Math.min(...starts);
  if (!Number.isFinite(start)) {
    return undefined;
  }

  const opening = text[start];
  const closing = opening === "{" ? "}" : "]";
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

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1).trim();
      }
    }
  }

  return undefined;
}

function normalizeNextPromptSuggestions(
  raw: unknown,
  loopPlan: ResearchLoopPlan,
  fallbackContext: string,
): readonly ResearchNextPromptSuggestion[] {
  const rawSuggestions = coerceNextPromptSuggestionArray(raw);
  const suggestions: ResearchNextPromptSuggestion[] = [];
  const seenPrompts = new Set<string>();

  for (const rawSuggestion of rawSuggestions) {
    const suggestion = normalizeNextPromptSuggestion(rawSuggestion);
    if (!suggestion) {
      continue;
    }
    const key = suggestion.promptMarkdown.trim().toLowerCase();
    if (seenPrompts.has(key)) {
      continue;
    }
    seenPrompts.add(key);
    suggestions.push(suggestion);
    if (suggestions.length >= NEXT_PROMPT_SUGGESTION_COUNT) {
      break;
    }
  }

  for (const fallback of createFallbackNextPromptSuggestions(
    loopPlan,
    fallbackContext,
  )) {
    if (suggestions.length >= NEXT_PROMPT_SUGGESTION_COUNT) {
      break;
    }
    const key = fallback.promptMarkdown.trim().toLowerCase();
    if (seenPrompts.has(key)) {
      continue;
    }
    seenPrompts.add(key);
    suggestions.push(fallback);
  }

  return suggestions;
}

function coerceNextPromptSuggestionArray(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isRecord(raw)) {
    return [];
  }

  const candidates = [
    raw.nextPromptSuggestions,
    raw.nextPrompts,
    raw.suggestions,
    raw.prompts,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function normalizeNextPromptSuggestion(
  raw: unknown,
): ResearchNextPromptSuggestion | undefined {
  if (typeof raw === "string") {
    const promptMarkdown = raw.trim();
    if (!promptMarkdown) {
      return undefined;
    }
    return {
      title: inferNextPromptTitle(promptMarkdown),
      promptMarkdown,
    };
  }

  if (!isRecord(raw)) {
    return undefined;
  }

  const promptMarkdown = firstStringValue(raw, [
    "promptMarkdown",
    "prompt",
    "text",
    "body",
  ])?.trim();
  if (!promptMarkdown) {
    return undefined;
  }

  const rationale = firstStringValue(raw, ["rationale", "reason"])?.trim();

  return {
    title:
      firstStringValue(raw, ["title", "label", "summary"])?.trim() ??
      inferNextPromptTitle(promptMarkdown),
    promptMarkdown,
    ...(rationale ? { rationale } : {}),
  };
}

function createFallbackNextPromptSuggestions(
  loopPlan: ResearchLoopPlan,
  context: string,
): readonly ResearchNextPromptSuggestion[] {
  const rootGoal = loopPlan.contextPacket.goalFrame.root.objective;
  const subGoal = loopPlan.subGoal.objective;
  const compactContext = summarizeForPrompt(context);

  return [
    {
      title: "Continue current branch",
      promptMarkdown: [
        `Continue the Honeycrisp research goal: ${rootGoal}`,
        "",
        `Current subgoal: ${subGoal}`,
        compactContext
          ? `Use the latest result as context: ${compactContext}`
          : "Use current memory as context and gather fresh evidence before marking the goal complete.",
      ].join("\n"),
      rationale: "Keeps momentum on the active branch.",
    },
    {
      title: "Skeptically verify evidence",
      promptMarkdown: [
        `Review the current Honeycrisp evidence skeptically for: ${rootGoal}`,
        "",
        "Identify the strongest unsupported assumptions, gather fresh evidence, and do not promote candidates without proof.",
      ].join("\n"),
      rationale: "Tests whether the current result deserves promotion.",
    },
    {
      title: "Explore a fresh branch",
      promptMarkdown: [
        `Start a fresh branch for the Honeycrisp research goal: ${rootGoal}`,
        "",
        "Avoid targets already exhausted in memory, select a distinct promising area, and persist any useful evidence or artifacts.",
      ].join("\n"),
      rationale: "Avoids repeating the same target.",
    },
  ];
}

function firstStringValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function inferNextPromptTitle(promptMarkdown: string): string {
  const firstLine = promptMarkdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!firstLine) {
    return "Continue research";
  }

  return firstLine.length > 64
    ? `${firstLine.slice(0, 61).trim()}...`
    : firstLine;
}

function summarizeForPrompt(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= 240) {
    return compact;
  }

  return `${compact.slice(0, 237).trim()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createPiContext(
  modelInput: ResearchLoopModelInput,
  toolRegistry: ResearchToolRegistry | undefined,
): Context {
  return {
    systemPrompt: createPiSystemPrompt(Boolean(toolRegistry && toolRegistry.size > 0)),
    messages: [createPiAgentUserMessage(modelInput)],
    ...(toolRegistry && toolRegistry.size > 0
      ? { tools: toolRegistry.toPiTools() }
      : {}),
  };
}

function createPiSystemPrompt(hasTools: boolean): string {
  return [
    "You are Honeycrisp, a goal-oriented research agent built on Pi.",
    "Execute only the current bounded loop. Preserve evidence, inference, hypotheses, uncertainty, and user commitments as distinct categories.",
    "Do not claim that files were inspected unless evidence is present in the supplied context.",
    "For fresh inspection, testing, or static-analysis goals, treat prior memory as context rather than completion proof; perform current-loop evidence work before declaring the goal complete.",
    "For fresh inspection goals, paths listed in avoid_repeated_targets are not valid fresh targets unless the user explicitly asks to revisit one.",
    "If prior memory says a file, function, or path was already exhausted, avoid repeating it unless the user explicitly asks to revisit it.",
    "Use memory for recallable facts, summaries, decisions, commitments, procedures, and paths to persisted files; use storage only for durable files, blobs, artifacts, binaries, raw logs, and other non-memory objects.",
    hasTools
      ? "Use available tool calls for permitted bounded actions. Do not print tool-call JSON when native tool calls are available."
      : "If a tool action is needed but unavailable, return a concise tool action JSON object before explaining the blocker.",
  ].join("\n");
}

function createPiAgentUserMessage(modelInput: ResearchLoopModelInput): Message {
  return {
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
      "Return concise markdown with: Result, Evidence Used, Assumptions, Open Questions.",
      "Do not include visible Next Steps, Goal Assessment, Checkpoint, or Subgoal sections.",
      "",
      "## Next Prompt Suggestions",
      renderNextPromptSuggestionsContract(),
      "",
      "## Visible Research Trace",
      renderResearchTraceContract(),
    ].join("\n"),
  };
}

function createPiAgentTools(input: {
  loopPlan: ResearchLoopPlan;
  toolRegistry: ResearchToolRegistry | undefined;
  getReservedToolCallCount(toolCallId: string): number;
  recordExecution(record: ResearchToolExecutionRecord): void;
}): AgentTool[] {
  if (!input.toolRegistry) {
    return [];
  }

  return input.toolRegistry
    .listTools()
    .filter((tool) => tool.parameters)
    .map((tool) => createPiAgentTool(tool, input));
}

function createPiAgentTool(
  tool: ResearchExecutableTool,
  input: {
    loopPlan: ResearchLoopPlan;
    toolRegistry: ResearchToolRegistry | undefined;
    getReservedToolCallCount(toolCallId: string): number;
    recordExecution(record: ResearchToolExecutionRecord): void;
  },
): AgentTool {
  const agentTool = {
    name: getToolTransportName(tool),
    label: tool.descriptor.name,
    description: tool.descriptor.description,
    parameters: tool.parameters!,
    prepareArguments(args: unknown) {
      return isRecord(args) ? args : {};
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<Record<string, unknown>>) => void,
    ) {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Executing ${tool.descriptor.name}.`,
          },
        ],
        details: {
          phase: "executing",
          toolName: tool.descriptor.name,
        },
      });
      const record = await input.toolRegistry!.executeToolCall(
        {
          id: toolCallId,
          name: getToolTransportName(tool),
          arguments: params,
        },
        createLoopToolExecutionOptions(input.loopPlan, {
          goalId: input.loopPlan.rootGoalId,
          subGoalId: input.loopPlan.subGoal.id,
          permittedActionClasses: input.loopPlan.permittedToolClasses,
          defaultActionClass: input.loopPlan.subGoal.actionClass,
          toolCallCount: input.getReservedToolCallCount(toolCallId),
          ...(input.loopPlan.governancePolicy
            ? { governance: input.loopPlan.governancePolicy }
            : {}),
          ...(signal ? { signal } : {}),
        }),
      );
      input.recordExecution(record);
      return {
        content: createPiAgentToolContent(record.result),
        details: record.result,
        terminate: false,
      };
    },
    ...(tool.descriptor.sideEffects === "write" ||
    tool.descriptor.sideEffects === "network" ||
    tool.descriptor.sideEffects === "process"
      ? { executionMode: "sequential" as const }
      : {}),
  };

  return agentTool as AgentTool;
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(isLlmMessage);
}

function isLlmMessage(message: AgentMessage): message is Message {
  return (
    isRecord(message) &&
    (message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult")
  );
}

function isAssistantMessage(
  message: AgentMessage,
): message is Extract<Message, { role: "assistant" }> {
  return isRecord(message) && message.role === "assistant";
}

function createToolCallFromAgentHook(
  hookContext: BeforeToolCallContext,
): Pick<ToolCall, "id" | "name" | "arguments"> {
  return {
    id: hookContext.toolCall.id,
    name: hookContext.toolCall.name,
    arguments: isRecord(hookContext.args) ? hookContext.args : {},
  };
}

function createPiAgentToolContent(
  result: ResearchToolExecutionResult,
): [{ type: "text"; text: string }] {
  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          status: result.status,
          summary: result.summary,
          output: result.output,
          error: result.error,
          followUpActions: result.followUpActions,
        },
        null,
        2,
      ),
    },
  ];
}

function captureAgentEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === "agent_start" || event.type === "agent_end") {
    return {
      type: event.type,
      ...(event.type === "agent_end" ? { messageCount: event.messages.length } : {}),
    };
  }

  if (event.type === "turn_start") {
    return {
      type: event.type,
    };
  }

  if (event.type === "turn_end") {
    return {
      type: event.type,
      messageRole: event.message.role,
      toolResultCount: event.toolResults.length,
    };
  }

  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    return {
      type: event.type,
      messageRole: event.message.role,
      ...(event.type === "message_update"
        ? { updateType: event.assistantMessageEvent.type }
        : {}),
    };
  }

  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "tool_execution_end"
        ? { isError: event.isError }
        : {}),
    };
  }

  return {
    type: "unknown",
  };
}

function emitLiveResearchEvents(
  sink: ResearchLiveEventSink | undefined,
  events: readonly ResearchEvent[],
): void {
  if (!sink || events.length === 0) {
    return;
  }

  for (const event of events) {
    emitLiveEvent(sink, {
      schemaVersion: 1,
      kind: "research.event",
      timestamp: nowIso(),
      payload: {
        event,
      },
    });
  }
}

async function emitAgentLiveEvent(
  sink: ResearchLiveEventSink | undefined,
  event: AgentEvent,
): Promise<void> {
  if (!sink) {
    return;
  }

  const liveEvent = createAgentLiveEvent(event);
  if (!liveEvent) {
    return;
  }

  await emitLiveEvent(sink, liveEvent);
}

function createAgentLiveEvent(
  event: AgentEvent,
): Parameters<ResearchLiveEventSink>[0] | undefined {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (
      update.type === "thinking_start" ||
      update.type === "thinking_delta" ||
      update.type === "thinking_end"
    ) {
      const text =
        update.type === "thinking_end"
          ? update.content
          : thinkingTextAtIndex(update.partial, update.contentIndex);
      const thinking = thinkingContentAtIndex(update.partial, update.contentIndex);
      return {
        schemaVersion: 1,
        kind: "model.thought",
        timestamp: nowIso(),
        payload: {
          eventType: update.type,
          phase:
            update.type === "thinking_start"
              ? "started"
              : update.type === "thinking_end"
                ? "completed"
                : "delta",
          contentIndex: update.contentIndex,
          itemId: `thinking:${update.contentIndex}`,
          responseId: update.partial.responseId ?? null,
          provider: update.partial.provider,
          model: update.partial.model,
          api: update.partial.api,
          text,
          ...(update.type === "thinking_delta" ? { delta: update.delta } : {}),
          ...(thinking?.redacted ? { redacted: true } : {}),
        },
      };
    }

    if (
      update.type === "text_start" ||
      update.type === "text_delta" ||
      update.type === "text_end"
    ) {
      const text =
        update.type === "text_end"
          ? update.content
          : textAtIndex(update.partial, update.contentIndex);
      return {
        schemaVersion: 1,
        kind: "model.output",
        timestamp: nowIso(),
        payload: {
          eventType: update.type,
          phase:
            update.type === "text_start"
              ? "started"
              : update.type === "text_end"
                ? "completed"
                : "delta",
          contentIndex: update.contentIndex,
          itemId: `text:${update.contentIndex}`,
          responseId: update.partial.responseId ?? null,
          provider: update.partial.provider,
          model: update.partial.model,
          api: update.partial.api,
          text,
          ...(update.type === "text_delta" ? { delta: update.delta } : {}),
        },
      };
    }
  }

  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    return {
      schemaVersion: 1,
      kind: "tool.progress",
      timestamp: nowIso(),
      payload: {
        eventType: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.type === "tool_execution_start" ||
        event.type === "tool_execution_update"
          ? { args: event.args }
          : {}),
        ...(event.type === "tool_execution_update"
          ? { partialResult: event.partialResult }
          : {}),
        ...(event.type === "tool_execution_end"
          ? { result: event.result, isError: event.isError }
          : {}),
      },
    };
  }

  if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "message_start" ||
    event.type === "message_end"
  ) {
    return {
      schemaVersion: 1,
      kind: "agent.event",
      timestamp: nowIso(),
      payload: captureAgentEvent(event),
    };
  }

  return undefined;
}

async function emitLiveEvent(
  sink: ResearchLiveEventSink,
  event: Parameters<ResearchLiveEventSink>[0],
): Promise<void> {
  try {
    await sink(event);
  } catch {
    // Live UI streaming must never affect the research loop outcome.
  }
}

function thinkingContentAtIndex(
  message: AgentMessage,
  contentIndex: number,
): Extract<
  Extract<AgentMessage, { role: "assistant" }>["content"][number],
  { type: "thinking" }
> | undefined {
  if (!isAssistantMessage(message)) {
    return undefined;
  }

  const item = message.content[contentIndex];
  return item?.type === "thinking" ? item : undefined;
}

function thinkingTextAtIndex(
  message: AgentMessage,
  contentIndex: number,
): string {
  return thinkingContentAtIndex(message, contentIndex)?.thinking ?? "";
}

function textAtIndex(message: AgentMessage, contentIndex: number): string {
  if (!isAssistantMessage(message)) {
    return "";
  }

  const item = message.content[contentIndex];
  return item?.type === "text" ? item.text : "";
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
  message: Pick<
    Awaited<ReturnType<Models["completeSimple"]>>,
    "content" | "responseId" | "stopReason" | "usage"
  >,
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

function createPlannedToolResultContextMessage(
  records: readonly ResearchToolExecutionRecord[],
): Message {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      "Controller-planned tool results were executed before the model call:",
      JSON.stringify(
        records.map((record) => ({
          toolActionId: record.action.id,
          toolName: record.action.toolName,
          actionClass: record.action.actionClass,
          input: record.action.input,
          status: record.result.status,
          summary: record.result.summary,
          output: record.result.output,
          error: record.result.error,
          followUpActions: record.result.followUpActions,
        })),
        null,
        2,
      ),
    ].join("\n"),
  };
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

function renderDeterministicLoopOutput(
  loopPlan: ResearchLoopPlan,
  plannedExecutions: readonly ResearchToolExecutionRecord[] = [],
): string {
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

  if (plannedExecutions.length > 0) {
    lines.push("", "Controller-planned tool results:");
    lines.push(
      ...plannedExecutions.map(
        (record) =>
          `- ${record.action.toolName} (${record.result.status}): ${record.result.summary}`,
      ),
    );
  }

  if (loopPlan.skippedToolActions.length > 0) {
    lines.push("", "Skipped candidate tool actions:");
    lines.push(
      ...loopPlan.skippedToolActions.map(
        (skipped) => `- ${skipped.code}: ${skipped.reason}`,
      ),
    );
  }

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
  plannedExecutions: readonly ResearchToolExecutionRecord[] = [],
): ResearchTrace {
  const plannedObservations = plannedExecutions.map((record) => ({
    text: `Controller-planned tool ${record.action.toolName} returned ${record.result.status}: ${record.result.summary}`,
    confidence: record.result.status === "complete" ? 1 : 0.6,
  }));

  return normalizeResearchTrace({
    observations:
      plannedObservations.length > 0
        ? plannedObservations
        : loopPlan.contextPacket.directEvidence.length > 0
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
