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
  Message,
  Models,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAuthenticatedModels } from "./auth.js";
import { nowIso } from "./ids.js";
import {
  getToolTransportName,
  type ResearchToolExecutionRecord,
  type ResearchToolExecutionResult,
  type ResearchToolRegistry,
} from "./tool-registry.js";
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
}

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
      const tools = createAgentTools({
        toolRegistry: options.toolRegistry,
        governance: input.governance,
        reserveToolCall,
        recordExecution(record) {
          executionRecords.set(record.action.id, record);
        },
      });
      const toolExecution = options.toolExecution ?? "sequential";
      const agentMessages = await runAgentLoop(
        [createUserMessage(input.modelInput)],
        {
          systemPrompt: createSystemPrompt(tools.length > 0),
          messages: [],
          ...(tools.length > 0 ? { tools } : {}),
        },
        {
          model,
          convertToLlm: convertAgentMessagesToLlm,
          ...(options.maxTokens !== undefined
            ? { maxTokens: options.maxTokens }
            : {}),
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          toolExecution,
          beforeToolCall: async (hookContext, signal) => {
            const toolCall = createToolCallFromHook(hookContext);
            const preflight = options.toolRegistry?.preflightToolCall(toolCall, {
              ...(input.governance ? { governance: input.governance } : {}),
              toolCallCount,
              ...(signal ? { signal } : {}),
            });
            if (!preflight) {
              reserveToolCall(toolCall.id);
              return undefined;
            }
            reserveToolCall(toolCall.id);
            executionRecords.set(toolCall.id, preflight);
            capturedToolCalls.add(toolCall.id);
            toolEvents.push(...preflight.events);
            emitResearchEvents(input.eventSink, preflight.events);
            return { block: true, reason: preflight.result.summary };
          },
          afterToolCall: async (hookContext) => {
            const record = executionRecords.get(hookContext.toolCall.id);
            if (record && !capturedToolCalls.has(hookContext.toolCall.id)) {
              capturedToolCalls.add(hookContext.toolCall.id);
              toolEvents.push(...record.events);
              emitResearchEvents(input.eventSink, record.events);
            }
            return record
              ? {
                  content: toolResultContent(record.result),
                  details: record.result,
                  isError: record.result.status !== "complete",
                }
              : undefined;
          },
          prepareNextTurn: ({ context }) =>
            typeof input.modelInput.toolBudget.maxToolCalls === "number" &&
            toolCallCount >= input.modelInput.toolBudget.maxToolCalls &&
            context.tools?.length
              ? { context: { ...context, tools: [] } }
              : undefined,
          getSteeringMessages: options.getSteeringMessages ?? (async () => []),
          getFollowUpMessages: async () => [],
        },
        async (event) => {
          if (event.type === "turn_start") currentTurn += 1;
          agentEvents.push(captureAgentEvent(event, currentTurn));
          await emitAgentEvent(input.eventSink, event, currentTurn);
        },
        input.signal,
        models.streamSimple.bind(models),
      );

      const assistantMessages = agentMessages.filter(isAssistantMessage);
      const finalAssistant = assistantMessages.at(-1);
      if (
        finalAssistant &&
        (finalAssistant.stopReason === "error" ||
          finalAssistant.stopReason === "aborted")
      ) {
        throw new Error(
          finalAssistant.errorMessage ??
            `Model stopped: ${finalAssistant.stopReason}`,
        );
      }

      return {
        text: finalAssistant ? assistantText(finalAssistant.content) : "",
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          lifecycle: "pi-agent",
          toolExecutionMode: toolExecution,
          toolCallCount,
          modelCalls: assistantMessages.map(modelCallMetadata),
          agentEvents,
        },
      };
    },
  };
}

function createSystemPrompt(hasTools: boolean): string {
  return [
    "You are Honeycrisp, an autonomous research agent built on Pi.",
    "Work directly on the user's request and decide how to investigate it and when the work is complete.",
    "Treat the supplied workspace context as the authorized research scope. Do not claim evidence you did not inspect.",
    hasTools ? "Use the available tools as needed." : "No tools are available in this session.",
  ].join("\n");
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
    usage: message.usage,
    contentTypes: message.content.map((item) => item.type),
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
): void {
  if (!sink) return;
  for (const event of events) {
    void emitLiveEvent(sink, {
      schemaVersion: 1,
      kind: "research.event",
      timestamp: nowIso(),
      payload: { event },
    });
  }
}

async function emitAgentEvent(
  sink: ResearchLiveEventSink | undefined,
  event: AgentEvent,
  turn: number,
): Promise<void> {
  if (!sink) return;
  const liveEvent = agentLiveEvent(event, turn);
  if (liveEvent) await emitLiveEvent(sink, liveEvent);
}

function agentLiveEvent(
  event: AgentEvent,
  turn: number,
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
        type: "turn_completed",
        turn,
        responseId: event.message.responseId,
        stopReason: event.message.stopReason,
        usage: event.message.usage,
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
