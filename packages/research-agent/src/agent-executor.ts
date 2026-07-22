import { estimateTokens, runAgentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  StreamFn,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Models,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { createAuthenticatedModels } from "./auth.js";
import { nowIso } from "./ids.js";
import {
  getToolTransportName,
  type ResearchToolExecutionRecord,
  type ResearchToolExecutionResult,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import {
  SubagentManager,
  SUBAGENT_COLLABORATION_TOOLS,
  type SubagentRunRequest,
  type SubagentRunResult,
} from "./subagent-runtime.js";
import { createResearchSystemPrompt } from "./system-prompt.js";
import type {
  ResearchAgentExecutionInput,
  ResearchAgentExecutor,
  ResearchAgentModelInput,
  ResearchEvent,
  ResearchLiveEventSink,
} from "./types.js";

export interface CreatePiAgentExecutorOptions {
  provider: string;
  model: string;
  authFile?: string;
  maxTokens?: number;
  reasoning?: SimpleStreamOptions["reasoning"];
  models?: Pick<Models, "getModel" | "streamSimple">;
  toolRegistry?: ResearchToolRegistry;
  toolExecution?: ToolExecutionMode;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  modelFirstEventTimeoutMs?: number;
  subagents?: false | {
    maxThreads?: number;
    maxDepth?: number;
  };
}

const MODEL_CONTEXT_RESERVE_TOKENS = 32_768;
const MIN_ACTIVE_CONTEXT_TOKENS = 32_000;
const RECENT_TOOL_RESULTS_TO_KEEP = 8;
const MODEL_TOOL_RESULT_MAX_CHARS = 48_000;
const COMPACTED_TOOL_RESULT_MAX_CHARS = 1_200;
const DEFAULT_MODEL_FIRST_EVENT_TIMEOUT_MS = 180_000;

export function createDeterministicAgentExecutor(): ResearchAgentExecutor {
  return {
    name: "deterministic-agent",
    async execute(input) {
      return {
        text: `Deterministic agent fixture received: ${input.modelInput.prompt}`,
        raw: {
          mode: "deterministic",
          note: "No model call was made.",
          toolCallCount: 0,
        },
      };
    },
  };
}

export function createPiAgentExecutor(
  options: CreatePiAgentExecutorOptions,
): ResearchAgentExecutor {
  return {
    name: `pi:${options.provider}/${options.model}:agent`,
    ...(options.subagents === false ? {} : { collaborationTools: SUBAGENT_COLLABORATION_TOOLS }),
    async execute(input) {
      const models =
        options.models ??
        createAuthenticatedModels(
          options.authFile ? { authFile: options.authFile } : {},
        );
      const model = models.getModel(options.provider, options.model);
      if (!model) {
        throw new Error(`Unknown model ${options.provider}/${options.model}`);
      }

      const toolExecution = options.toolExecution ?? "sequential";
      let runSession!: (request: SubagentRunRequest & { root?: boolean }) => Promise<SubagentRunResult & { agentEvents: Record<string, unknown>[] }>;
      const subagents = options.subagents === false
        ? null
        : new SubagentManager({
            rootModel: model.id,
            ...(options.reasoning ? { rootReasoning: options.reasoning } : {}),
            ...(options.subagents?.maxThreads ? { maxThreads: options.subagents.maxThreads } : {}),
            ...(options.subagents?.maxDepth !== undefined ? { maxDepth: options.subagents.maxDepth } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            run: (request) => runSession(request),
            onActivity: async (activity) => {
              if (!input.eventSink) return;
              const { type: action, ...details } = activity;
              await emitLiveEvent(input.eventSink, {
                schemaVersion: 1,
                kind: "agent.event",
                timestamp: nowIso(),
                payload: { type: "subagent.activity", action, ...details },
              });
            },
            onToolEvent: (event) => {
              emitResearchEvents(input.eventSink, [event], {
                agentId: event.agentId ?? "root",
                agentPath: event.agentPath ?? "/root",
                parentAgentId: event.parentAgentId ?? "",
              });
            },
          });
      const researchToolNames = new Set(
        options.toolRegistry?.listTools().map((tool) => getToolTransportName(tool)) ?? [],
      );
      const hasMemoryTools = researchToolNames.has("memory_search")
        && researchToolNames.has("memory_save")
        && researchToolNames.has("memory_link");
      const hasRunbookTools = researchToolNames.has("runbook_list")
        && researchToolNames.has("runbook_create")
        && researchToolNames.has("runbook_append");

      runSession = async (request) => {
        const sessionModel = request.root ? model : models.getModel(options.provider, request.model);
        if (!sessionModel) throw new Error(`Unknown subagent model ${options.provider}/${request.model}`);
        const toolEvents: ResearchEvent[] = [];
        const agentEvents: Record<string, unknown>[] = [];
        const executionRecords = new Map<string, ResearchToolExecutionRecord>();
        const capturedToolCalls = new Set<string>();
        const reservations = new Map<string, number>();
        let toolCallCount = 0;
        let currentTurn = 0;
        const reserveToolCall = (toolCallId: string): number => {
          const reserved = reservations.get(toolCallId);
          if (reserved !== undefined) return reserved;
          const next = toolCallCount;
          reservations.set(toolCallId, next);
          toolCallCount += 1;
          return next;
        };
        const researchTools = createAgentTools({
          toolRegistry: options.toolRegistry,
          governance: input.governance,
          reserveToolCall,
          recordExecution(record) {
            executionRecords.set(record.action.id, record);
          },
        });
        const collaborationTools = subagents?.createTools(request.id) ?? [];
        const tools = [...researchTools, ...collaborationTools];
        const streamFn = createRetryingStreamFn(models.streamSimple.bind(models), {
          signal: request.signal,
          firstEventTimeoutMs: options.modelFirstEventTimeoutMs ?? DEFAULT_MODEL_FIRST_EVENT_TIMEOUT_MS,
          onRetry: async ({ retry, maxRetries, errorMessage }) => {
            const retryEvent = {
              type: "model_retry",
              turn: currentTurn,
              retry,
              maxRetries,
              errorMessage,
            };
            agentEvents.push({
              ...retryEvent,
              agentId: request.id,
              agentPath: request.path,
            });
            if (!input.eventSink) return;
            await emitLiveEvent(input.eventSink, {
              schemaVersion: 1,
              kind: "agent.event",
              timestamp: nowIso(),
              payload: {
                ...retryEvent,
                agentId: request.id,
                agentPath: request.path,
                parentAgentId: request.parentId,
              },
            });
          },
          compactContext: (context) => ({
            ...context,
            messages: compactAgentContext(
              context.messages as AgentMessage[],
              sessionModel.contextWindow,
              true,
            ) as Message[],
          }),
          onContextRetry: async ({ tokensBefore, tokensAfter, errorMessage }) => {
            const retryEvent = {
              type: "context_compacted",
              reason: "context_window_error",
              retry: true,
              tokensBefore,
              tokensAfter,
              errorMessage,
            };
            agentEvents.push({
              ...retryEvent,
              agentId: request.id,
              agentPath: request.path,
            });
            if (!input.eventSink) return;
            await emitLiveEvent(input.eventSink, {
              schemaVersion: 1,
              kind: "agent.event",
              timestamp: nowIso(),
              payload: {
                ...retryEvent,
                agentId: request.id,
                agentPath: request.path,
                parentAgentId: request.parentId,
              },
            });
          },
        });
        const initialMessages = compactAgentContext(request.inheritedMessages, sessionModel.contextWindow);
        const agentMessages = await runAgentLoop(
          [request.root ? createUserMessage(input.modelInput) : createTaskMessage(request.prompt)],
          {
            systemPrompt: createResearchSystemPrompt({
              hasTools: tools.length > 0,
              hasMemoryTools,
              hasRunbookTools,
              ...(request.root ? {} : { agentPath: request.path }),
              hasCollaborationTools: collaborationTools.some((tool) => tool.name === "spawn_agent"),
            }),
            messages: initialMessages,
            ...(tools.length > 0 ? { tools } : {}),
          },
          {
            model: sessionModel,
            convertToLlm: convertAgentMessagesToLlm,
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(request.reasoning ? { reasoning: request.reasoning } : options.reasoning ? { reasoning: options.reasoning } : {}),
            toolExecution,
            beforeToolCall: async (hookContext, signal) => {
              const toolCall = createToolCallFromHook(hookContext);
              subagents?.captureContext(request.id, toolCall.id, hookContext.context.messages);
              const researchTool = options.toolRegistry?.find(toolCall.name);
              const preflight = researchTool
                ? options.toolRegistry?.preflightToolCall(toolCall, {
                    ...(input.governance ? { governance: input.governance } : {}),
                    toolCallCount,
                    ...(signal ? { signal } : {}),
                  })
                : undefined;
              if (!preflight) {
                reserveToolCall(toolCall.id);
                return undefined;
              }
              reserveToolCall(toolCall.id);
              executionRecords.set(toolCall.id, preflight);
              capturedToolCalls.add(toolCall.id);
              const attributedEvents = attributeResearchEvents(preflight.events, {
                agentId: request.id,
                agentPath: request.path,
                parentAgentId: request.parentId,
              });
              toolEvents.push(...attributedEvents);
              emitResearchEvents(input.eventSink, attributedEvents, {
                agentId: request.id,
                agentPath: request.path,
                parentAgentId: request.parentId,
              });
              return { block: true, reason: preflight.result.summary };
            },
            afterToolCall: async (hookContext) => {
              const record = executionRecords.get(hookContext.toolCall.id);
              if (record && !capturedToolCalls.has(hookContext.toolCall.id)) {
                capturedToolCalls.add(hookContext.toolCall.id);
                const attributedEvents = attributeResearchEvents(record.events, {
                  agentId: request.id,
                  agentPath: request.path,
                  parentAgentId: request.parentId,
                });
                toolEvents.push(...attributedEvents);
                emitResearchEvents(input.eventSink, attributedEvents, {
                  agentId: request.id,
                  agentPath: request.path,
                  parentAgentId: request.parentId,
                });
              }
              return record
                ? {
                    content: toolResultContent(record.result),
                    details: record.result,
                    isError: record.result.status !== "complete",
                  }
                : undefined;
            },
            prepareNextTurn: async ({ context }) => {
              const compactedMessages = compactAgentContext(context.messages, sessionModel.contextWindow);
              const contextCompacted = compactedMessages !== context.messages;
              const removeResearchTools =
                typeof input.modelInput.toolBudget.maxToolCalls === "number"
                && toolCallCount >= input.modelInput.toolBudget.maxToolCalls
                && context.tools?.some((tool) => researchToolNames.has(tool.name));
              if (!contextCompacted && !removeResearchTools) return undefined;
              if (contextCompacted && input.eventSink) {
                await emitLiveEvent(input.eventSink, {
                  schemaVersion: 1,
                  kind: "agent.event",
                  timestamp: nowIso(),
                  payload: {
                    type: "context_compacted",
                    agentId: request.id,
                    agentPath: request.path,
                    parentAgentId: request.parentId,
                    tokensBefore: estimatedMessageTokens(context.messages),
                    tokensAfter: estimatedMessageTokens(compactedMessages),
                  },
                });
              }
              return {
                context: {
                  ...context,
                  messages: compactedMessages,
                  ...(removeResearchTools
                    ? { tools: (context.tools ?? []).filter((tool) => !researchToolNames.has(tool.name)) }
                    : {}),
                },
              };
            },
            getSteeringMessages: async () => [
              ...(request.root && options.getSteeringMessages ? await options.getSteeringMessages() : []),
              ...(subagents?.takeMailbox(request.id) ?? []),
            ],
            getFollowUpMessages: async () => subagents?.takeMailbox(request.id) ?? [],
          },
          async (event) => {
            if (event.type === "turn_start") currentTurn += 1;
            agentEvents.push({
              ...captureAgentEvent(event, currentTurn),
              agentId: request.id,
              agentPath: request.path,
            });
            await emitAgentEvent(input.eventSink, event, currentTurn, {
              agentId: request.id,
              agentPath: request.path,
              parentAgentId: request.parentId,
            });
          },
          request.signal,
          streamFn,
        );
        const assistantMessages = agentMessages.filter(isAssistantMessage);
        const finalAssistant = assistantMessages.at(-1);
        if (finalAssistant && (finalAssistant.stopReason === "error" || finalAssistant.stopReason === "aborted")) {
          throw new Error(finalAssistant.errorMessage ?? `Model stopped: ${finalAssistant.stopReason}`);
        }
        return {
          messages: agentMessages,
          text: finalAssistant ? assistantText(finalAssistant.content) : "",
          turnCount: currentTurn,
          toolCallCount,
          modelCalls: assistantMessages.map(modelCallMetadata),
          toolEvents,
          agentEvents,
        };
      };

      const rootResult = await runSession({
        id: "root",
        path: "/root",
        parentId: "",
        depth: 0,
        model: model.id,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        prompt: input.modelInput.prompt,
        inheritedMessages: [],
        signal: input.signal ?? new AbortController().signal,
        root: true,
      });
      await subagents?.settle();
      const childToolEvents = subagents?.allToolEvents() ?? [];
      const allToolEvents = [...rootResult.toolEvents, ...childToolEvents];

      return {
        text: rootResult.text,
        ...(allToolEvents.length > 0 ? { toolEvents: allToolEvents } : {}),
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          lifecycle: "pi-agent",
          toolExecutionMode: toolExecution,
          toolCallCount: rootResult.toolCallCount,
          modelCalls: rootResult.modelCalls,
          agentEvents: rootResult.agentEvents,
          ...(subagents ? { subagents: subagents.snapshot() } : {}),
        },
      };
    },
  };
}

const MODEL_RETRY_DELAYS_MS = [250, 1_000] as const;

function createRetryingStreamFn(
  streamFn: StreamFn,
  options: {
    signal?: AbortSignal;
    onRetry?: (event: { retry: number; maxRetries: number; errorMessage: string }) => Promise<void> | void;
    compactContext?: (context: Parameters<StreamFn>[1]) => Parameters<StreamFn>[1];
    onContextRetry?: (event: { tokensBefore: number; tokensAfter: number; errorMessage: string }) => Promise<void> | void;
    firstEventTimeoutMs?: number;
  } = {},
): StreamFn {
  return (model, context, streamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let activeContext = context;
      let transientRetries = 0;
      let contextRetryAttempted = false;
      for (;;) {
        let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | null = null;
        let emittedContent = false;
        let retryError: AssistantMessage | null = null;
        let firstEventTimedOut = false;
        const attemptController = new AbortController();
        const linkedSignals = [options.signal, streamOptions?.signal].filter(
          (signal): signal is AbortSignal => Boolean(signal),
        );
        const abortAttempt = (): void => attemptController.abort();
        for (const signal of linkedSignals) {
          if (signal.aborted) abortAttempt();
          else signal.addEventListener("abort", abortAttempt, { once: true });
        }
        try {
          const upstream = await streamFn(model, activeContext, {
            ...streamOptions,
            signal: attemptController.signal,
          });
          const iterator = upstream[Symbol.asyncIterator]();
          for (;;) {
            const next = emittedContent || !options.firstEventTimeoutMs
              ? await iterator.next()
              : await nextModelEvent(iterator, options.firstEventTimeoutMs, () => {
                  firstEventTimedOut = true;
                  attemptController.abort();
                });
            if (next.done) break;
            const event = next.value;
            if (event.type === "start" && !emittedContent) {
              pendingStart = event;
              continue;
            }
            if (
              event.type === "error"
              && !emittedContent
              && !contextRetryAttempted
              && isContextWindowAssistantError(event.error)
              && options.compactContext
            ) {
              const tokensBefore = estimatedMessageTokens(activeContext.messages as AgentMessage[]);
              activeContext = options.compactContext(activeContext);
              const tokensAfter = estimatedMessageTokens(activeContext.messages as AgentMessage[]);
              contextRetryAttempted = true;
              await options.onContextRetry?.({
                tokensBefore,
                tokensAfter,
                errorMessage: event.error.errorMessage ?? "Model context window exceeded.",
              });
              retryError = event.error;
              break;
            }
            if (
              event.type === "error"
              && !emittedContent
              && transientRetries < MODEL_RETRY_DELAYS_MS.length
              && isRetryableAssistantError(event.error)
            ) {
              retryError = event.error;
              break;
            }
            if (pendingStart) {
              output.push(pendingStart);
              pendingStart = null;
            }
            output.push(event);
            if (event.type === "done" || event.type === "error") return;
            emittedContent = true;
          }
        } catch (error) {
          const message = assistantErrorMessage(
            model,
            firstEventTimedOut
              ? `Model stream produced no content for ${options.firstEventTimeoutMs}ms.`
              : error,
          );
          if (
            !emittedContent
            && !contextRetryAttempted
            && isContextWindowAssistantError(message)
            && options.compactContext
          ) {
            const tokensBefore = estimatedMessageTokens(activeContext.messages as AgentMessage[]);
            activeContext = options.compactContext(activeContext);
            const tokensAfter = estimatedMessageTokens(activeContext.messages as AgentMessage[]);
            contextRetryAttempted = true;
            await options.onContextRetry?.({ tokensBefore, tokensAfter, errorMessage: message.errorMessage ?? "Model context window exceeded." });
            retryError = message;
          } else if (
            !emittedContent
            && transientRetries < MODEL_RETRY_DELAYS_MS.length
            && (firstEventTimedOut || isRetryableAssistantError(message))
          ) {
            retryError = message;
          } else {
            if (pendingStart) output.push(pendingStart);
            output.push({ type: "error", reason: "error", error: message });
            return;
          }
        } finally {
          for (const signal of linkedSignals) {
            signal.removeEventListener("abort", abortAttempt);
          }
        }

        if (!retryError) {
          const message = assistantErrorMessage(model, "Model stream ended before a terminal event.");
          if (pendingStart) output.push(pendingStart);
          output.push({ type: "error", reason: "error", error: message });
          return;
        }

        if (contextRetryAttempted && isContextWindowAssistantError(retryError)) {
          continue;
        }

        const retry = transientRetries + 1;
        await options.onRetry?.({
          retry,
          maxRetries: MODEL_RETRY_DELAYS_MS.length,
          errorMessage: retryError.errorMessage ?? "Transient model error.",
        });
        if (!await retryDelay(MODEL_RETRY_DELAYS_MS[transientRetries]!, options.signal)) {
          output.push({
            type: "error",
            reason: "aborted",
            error: { ...retryError, stopReason: "aborted", errorMessage: "Model retry aborted." },
          });
          return;
        }
        transientRetries += 1;
      }
    })();
    return output;
  };
}

function nextModelEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<IteratorResult<AssistantMessageEvent>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Model stream produced no content for ${timeoutMs}ms.`));
    }, Math.max(1, timeoutMs));
    iterator.next().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isContextWindowAssistantError(message: AssistantMessage): boolean {
  const normalized = message.errorMessage?.toLowerCase() ?? "";
  return normalized.includes("context window")
    || normalized.includes("maximum context length")
    || normalized.includes("input exceeds the context");
}

function retryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveDelay(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      resolveDelay(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assistantErrorMessage(model: Parameters<StreamFn>[0], error: unknown): AssistantMessage {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

function createTaskMessage(prompt: string): Message {
  return { role: "user", timestamp: Date.now(), content: prompt };
}

function createUserMessage(modelInput: ResearchAgentModelInput): Message {
  const context = modelInput.contextSections
    .filter((section) => hasContent(section.content))
    .map(
      (section) =>
        `### ${section.label}\n${formatContent(section.content)}`,
    );
  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      modelInput.prompt,
      ...(context.length > 0 ? ["", "## Research Context", ...context] : []),
    ].join("\n"),
  };
}

function createAgentTools(input: {
  toolRegistry: ResearchToolRegistry | undefined;
  governance: ResearchAgentExecutionInput["governance"];
  reserveToolCall(toolCallId: string): number;
  recordExecution(record: ResearchToolExecutionRecord): void;
}): AgentTool[] {
  if (!input.toolRegistry) return [];
  return input.toolRegistry
    .listTools()
    .filter((tool) => tool.parameters)
    .map((tool) => {
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
          onUpdate?: (
            partialResult: AgentToolResult<Record<string, unknown>>,
          ) => void,
        ) {
          onUpdate?.({
            content: [
              { type: "text", text: `Executing ${tool.descriptor.name}.` },
            ],
            details: { phase: "executing", toolName: tool.descriptor.name },
          });
          const record = await input.toolRegistry!.executeToolCall(
            {
              id: toolCallId,
              name: getToolTransportName(tool),
              arguments: params,
            },
            {
              ...(input.governance ? { governance: input.governance } : {}),
              toolCallCount: input.reserveToolCall(toolCallId),
              ...(signal ? { signal } : {}),
            },
          );
          input.recordExecution(record);
          return {
            content: toolResultContent(record.result),
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
    });
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      isRecord(message) &&
      (message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"),
  );
}

function isAssistantMessage(
  message: AgentMessage,
): message is Extract<Message, { role: "assistant" }> {
  return isRecord(message) && message.role === "assistant";
}

function createToolCallFromHook(
  context: BeforeToolCallContext,
): Pick<ToolCall, "id" | "name" | "arguments"> {
  return {
    id: context.toolCall.id,
    name: context.toolCall.name,
    arguments: isRecord(context.args) ? context.args : {},
  };
}

function toolResultContent(
  result: ResearchToolExecutionResult,
): [{ type: "text"; text: string }] {
  const serialized = JSON.stringify(
    {
      status: result.status,
      summary: result.summary,
      output: result.output,
      error: result.error,
      followUpActions: result.followUpActions,
    },
    null,
    2,
  );
  return [
    {
      type: "text",
      text: truncateModelToolResult(serialized),
    },
  ];
}

export function compactAgentContext(
  messages: AgentMessage[],
  contextWindow = 128_000,
  force = false,
): AgentMessage[] {
  const configuredTokens = Math.max(
    MIN_ACTIVE_CONTEXT_TOKENS,
    (Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128_000)
      - MODEL_CONTEXT_RESERVE_TOKENS,
  );
  const usableTokens = force
    ? Math.max(MIN_ACTIVE_CONTEXT_TOKENS, Math.floor(configuredTokens * 0.7))
    : configuredTokens;
  if (!force && estimatedMessageTokens(messages) <= usableTokens) return messages;

  const compacted = structuredClone(messages) as AgentMessage[];
  const toolResultIndexes = compacted.flatMap((message, index) =>
    isRecord(message) && message.role === "toolResult" ? [index] : []
  );
  const replaceThrough = Math.max(0, toolResultIndexes.length - RECENT_TOOL_RESULTS_TO_KEEP);
  for (const index of toolResultIndexes.slice(0, replaceThrough)) {
    compacted[index] = compactToolResultMessage(compacted[index]!);
    if (estimatedMessageTokens(compacted) <= usableTokens) return compacted;
  }

  for (const index of toolResultIndexes.slice(replaceThrough)) {
    compacted[index] = compactToolResultMessage(compacted[index]!);
    if (estimatedMessageTokens(compacted) <= usableTokens) return compacted;
  }

  const firstUserIndex = compacted.findIndex((message) => isRecord(message) && message.role === "user");
  const firstMessage = firstUserIndex >= 0 ? compacted[firstUserIndex] : undefined;
  const notice: Message = {
    role: "user",
    timestamp: Date.now(),
    content: "Earlier turns were removed to keep this research session within the model context window. Durable memory remains available; search it before repeating prior work.",
  };
  const fixedTokens = estimatedMessageTokens([...(firstMessage ? [firstMessage] : []), notice]);
  const recentBudget = Math.max(8_000, usableTokens - fixedTokens);
  let recentTokens = 0;
  let start = compacted.length;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    if (index === firstUserIndex) continue;
    const nextTokens = estimateTokens(compacted[index]!);
    if (recentTokens + nextTokens > recentBudget && start < compacted.length) break;
    recentTokens += nextTokens;
    start = index;
  }
  while (start > 0 && isRecord(compacted[start]) && compacted[start]!.role === "toolResult") {
    start -= 1;
  }
  return [
    ...(firstMessage ? [firstMessage] : []),
    notice,
    ...compacted.slice(start).filter((_message, index) => start + index !== firstUserIndex),
  ];
}

function compactToolResultMessage(message: AgentMessage): AgentMessage {
  if (!isRecord(message) || message.role !== "toolResult") return message;
  const details = isRecord(message.details) ? message.details : {};
  const summary = typeof details.summary === "string" ? details.summary.trim() : "";
  const originalText = Array.isArray(message.content)
    ? message.content
        .filter((item): item is { type: "text"; text: string } =>
          isRecord(item) && item.type === "text" && typeof item.text === "string"
        )
        .map((item) => item.text)
        .join("\n")
    : "";
  const preview = originalText.length > COMPACTED_TOOL_RESULT_MAX_CHARS
    ? `${originalText.slice(0, COMPACTED_TOOL_RESULT_MAX_CHARS)}\n…`
    : originalText;
  return {
    ...message,
    content: [{
      type: "text",
      text: [
        `[Earlier ${String(message.toolName ?? "tool")} output compacted for context.]`,
        ...(summary ? [`Summary: ${summary}`] : []),
        ...(preview ? [preview] : []),
      ].join("\n"),
    }],
  } as AgentMessage;
}

function estimatedMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function truncateModelToolResult(text: string): string {
  if (text.length <= MODEL_TOOL_RESULT_MAX_CHARS) return text;
  const half = Math.floor(MODEL_TOOL_RESULT_MAX_CHARS / 2);
  return [
    text.slice(0, half),
    `\n\n[Tool result truncated for model context: ${text.length - MODEL_TOOL_RESULT_MAX_CHARS} characters omitted. Re-run a narrower command if the omitted section is needed.]\n\n`,
    text.slice(-half),
  ].join("");
}

function assistantText(
  content: Extract<Message, { role: "assistant" }>["content"],
): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function modelCallMetadata(
  message: Extract<Message, { role: "assistant" }>,
): Record<string, unknown> {
  return {
    stopReason: message.stopReason,
    responseId: message.responseId,
    usage: usageWithCacheHitRate(message.usage),
    contentTypes: message.content.map((item) => item.type),
  };
}

function usageWithCacheHitRate(usage: Usage): Record<string, unknown> {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    ...usage,
    cacheHitRate: promptTokens > 0 ? usage.cacheRead / promptTokens : 0,
  };
}

function captureAgentEvent(
  event: AgentEvent,
  turn: number,
): Record<string, unknown> {
  if (event.type === "agent_start" || event.type === "agent_end") {
    return {
      type: event.type,
      ...(event.type === "agent_end"
        ? { messageCount: event.messages.length }
        : {}),
    };
  }
  if (event.type === "turn_start") return { type: event.type, turn };
  if (event.type === "turn_end") {
    return {
      type: event.type,
      turn,
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
      turn,
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
      turn,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
    };
  }
  return { type: "unknown" };
}

function emitResearchEvents(
  sink: ResearchLiveEventSink | undefined,
  events: readonly ResearchEvent[],
  agent: { agentId: string; agentPath: string; parentAgentId: string },
): void {
  if (!sink) return;
  for (const event of events) {
    void emitLiveEvent(sink, {
      schemaVersion: 1,
      kind: "research.event",
      timestamp: nowIso(),
      payload: { event, ...agent },
    });
  }
}

function attributeResearchEvents(
  events: readonly ResearchEvent[],
  agent: { agentId: string; agentPath: string; parentAgentId: string },
): ResearchEvent[] {
  return events.map((event) => ({ ...event, ...agent }));
}

async function emitAgentEvent(
  sink: ResearchLiveEventSink | undefined,
  event: AgentEvent,
  turn: number,
  agent: { agentId: string; agentPath: string; parentAgentId: string },
): Promise<void> {
  if (!sink) return;
  const liveEvent = agentLiveEvent(event, turn, agent);
  if (liveEvent) await emitLiveEvent(sink, liveEvent);
}

function agentLiveEvent(
  event: AgentEvent,
  turn: number,
  agent: { agentId: string; agentPath: string; parentAgentId: string },
): Parameters<ResearchLiveEventSink>[0] | undefined {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (
      update.type === "thinking_start" ||
      update.type === "thinking_delta" ||
      update.type === "thinking_end"
    ) {
      const thinking = thinkingAt(update.partial, update.contentIndex);
      return {
        schemaVersion: 1,
        kind: "model.thought",
        timestamp: nowIso(),
        payload: {
          ...agent,
          turn,
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
          text:
            update.type === "thinking_end"
              ? update.content
              : thinking?.thinking ?? "",
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
      const item = isAssistantMessage(update.partial)
        ? update.partial.content[update.contentIndex]
        : undefined;
      return {
        schemaVersion: 1,
        kind: "model.output",
        timestamp: nowIso(),
        payload: {
          ...agent,
          turn,
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
          text:
            update.type === "text_end"
              ? update.content
              : item?.type === "text"
                ? item.text
                : "",
          ...(update.type === "text_delta" ? { delta: update.delta } : {}),
        },
      };
    }
  }
  if (event.type === "message_end" && isAssistantMessage(event.message)) {
    return {
      schemaVersion: 1,
      kind: "agent.event",
      timestamp: nowIso(),
      payload: {
        ...agent,
        type: "turn_completed",
        turn,
        responseId: event.message.responseId,
        stopReason: event.message.stopReason,
        usage: usageWithCacheHitRate(event.message.usage),
        contentTypes: event.message.content.map((item) => item.type),
      },
    };
  }
  return undefined;
}

function thinkingAt(message: AgentMessage, index: number) {
  if (!isAssistantMessage(message)) return undefined;
  const item = message.content[index];
  return item?.type === "thinking" ? item : undefined;
}

async function emitLiveEvent(
  sink: ResearchLiveEventSink,
  event: Parameters<ResearchLiveEventSink>[0],
): Promise<void> {
  try {
    await sink(event);
  } catch {
    // Live UI streaming must not affect the research session.
  }
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function formatContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
