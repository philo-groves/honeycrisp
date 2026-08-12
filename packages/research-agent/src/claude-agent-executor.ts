import {
  createSdkMcpServer,
  query,
  tool,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodType } from "zod";
import { createId, nowIso } from "./ids.js";
import { researchProfileHash, researchProfileWorkflow, type ResearchProfile } from "./research-profile.js";
import { createResearchSystemPrompt } from "./system-prompt.js";
import {
  getToolTransportName,
  modelToolResultDetails,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import type {
  ResearchAgentExecutor,
  ResearchAgentExecutionInput,
  ResearchAgentModelInput,
  ResearchEvent,
  ResearchLiveEventSink,
} from "./types.js";

export interface ClaudeAgentResumableState {
  schemaVersion: 1;
  provider: "anthropic";
  model: string;
  providerSessionId: string;
  researchProfileHash: string;
  workflowId: string;
}

export interface CreateClaudeAgentExecutorOptions {
  model: string;
  workspaceRoot: string;
  reasoning?: string;
  maxTokens?: number;
  toolRegistry?: ResearchToolRegistry;
  researchProfile: ResearchProfile;
  workflowId?: string;
  resumableState?: ClaudeAgentResumableState;
  waitForSteeringMessages?: (signal?: AbortSignal) => Promise<readonly string[]>;
}

export interface CompleteClaudeAgentTextOptions {
  model: string;
  prompt: string;
  systemPrompt: string;
  reasoning?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ClaudeAgentTextCompletion {
  text: string;
  usage: Record<string, unknown>;
}

/**
 * Runs small Anthropic support tasks through the same official Claude Agent
 * SDK and bundled Claude Code process as primary research turns. This keeps
 * subscription authentication inside Anthropic's supported CLI boundary.
 */
export async function completeClaudeAgentText(
  options: CompleteClaudeAgentTextOptions,
): Promise<ClaudeAgentTextCompletion> {
  const abortController = new AbortController();
  const abort = () => abortController.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  let result: SDKResultMessage | undefined;
  try {
    const effort = claudeEffort(options.reasoning);
    const stream = query({
      prompt: options.prompt,
      options: {
        abortController,
        cwd: options.cwd ?? process.cwd(),
        model: options.model,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: options.systemPrompt,
        },
        ...(effort ? { effort } : {}),
        ...(options.reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "honeycrisp/0.1.0" },
      },
    });
    for await (const message of stream) {
      if (message.type === "result") result = message;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }

  if (!result) throw new Error("Claude Agent SDK ended without a result message.");
  if (result.subtype !== "success") {
    throw new Error(result.errors.join("\n") || `Claude Agent SDK stopped with ${result.subtype}.`);
  }
  return {
    text: result.result,
    usage: {
      ...result.usage,
      modelUsage: result.modelUsage,
      totalCostUsd: result.total_cost_usd,
    },
  };
}

export function extractCompatibleClaudeAgentResumableState(
  raw: unknown,
  model: string,
  expected: { researchProfileHash: string; workflowId: string },
): ClaudeAgentResumableState | undefined {
  if (!isRecord(raw) || !isRecord(raw.resumableState)) return undefined;
  const state = raw.resumableState;
  if (
    state.schemaVersion !== 1
    || state.provider !== "anthropic"
    || state.model !== model
    || typeof state.providerSessionId !== "string"
    || !state.providerSessionId.trim()
    || state.researchProfileHash !== expected.researchProfileHash
    || state.workflowId !== expected.workflowId
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    provider: "anthropic",
    model,
    providerSessionId: state.providerSessionId,
    researchProfileHash: expected.researchProfileHash,
    workflowId: expected.workflowId,
  };
}

export function createClaudeAgentExecutor(options: CreateClaudeAgentExecutorOptions): ResearchAgentExecutor {
  const workflow = researchProfileWorkflow(options.researchProfile, options.workflowId);
  const profileHash = researchProfileHash(options.researchProfile);
  if (options.resumableState?.researchProfileHash !== undefined
    && options.resumableState.researchProfileHash !== profileHash) {
    throw new Error("Claude resumable state research profile hash does not match this run.");
  }
  if (options.resumableState?.workflowId !== undefined
    && options.resumableState.workflowId !== workflow.id) {
    throw new Error("Claude resumable state research workflow does not match this run.");
  }

  return {
    name: `claude-agent-sdk:anthropic/${options.model}`,
    async execute(input) {
      const toolEvents: ResearchEvent[] = [];
      let toolCallCount = 0;
      const mcpTools = (options.toolRegistry?.listTools() ?? [])
        .filter((candidate) => candidate.parameters)
        .map((candidate) => tool(
          getToolTransportName(candidate),
          candidate.descriptor.description,
          jsonObjectShape(candidate.parameters),
          async (args) => {
            const toolCallId = createId("claude_tool");
            toolCallCount += 1;
            const record = await options.toolRegistry!.executeToolCall({
              id: toolCallId,
              name: getToolTransportName(candidate),
              arguments: isRecord(args) ? args : {},
            }, {
              toolCallCount,
              defaultActionClass: candidate.descriptor.actionClasses[0] ?? "analyze",
              ...(input.governance ? { governance: input.governance } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
            toolEvents.push(...record.events);
            await emitResearchEvents(input.eventSink, record.events);
            const details = modelToolResultDetails(record.result);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(details) }],
              isError: record.result.status === "error",
            };
          },
        ));
      const mcpServer = createSdkMcpServer({
        name: "honeycrisp",
        version: "1.0.0",
        instructions: "These are Honeycrisp's governed research tools. Use them for all durable memory, runbook, report, shell, repository, and workspace operations.",
        tools: mcpTools,
        alwaysLoad: true,
      });
      const mcpToolNames = mcpTools.map((candidate) => `mcp__honeycrisp__${candidate.name}`);
      const abortController = new AbortController();
      const abort = () => abortController.abort(input.signal?.reason);
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });

      let sessionId = options.resumableState?.providerSessionId;
      let result: SDKResultMessage | undefined;
      const assistantText: string[] = [];
      const effort = claudeEffort(options.reasoning);
      let finishInput!: () => void;
      const inputFinished = new Promise<void>((resolvePromise) => {
        finishInput = resolvePromise;
      });
      try {
        const stream = query({
          prompt: options.waitForSteeringMessages
            ? streamUserMessages(
                formatModelInput(input.modelInput),
                options.waitForSteeringMessages,
                inputFinished,
                abortController.signal,
              )
            : formatModelInput(input.modelInput),
          options: {
            abortController,
            cwd: options.workspaceRoot,
            model: options.model,
            ...(options.resumableState ? { resume: options.resumableState.providerSessionId } : {}),
            mcpServers: { honeycrisp: mcpServer },
            agents: {
              researcher: {
                description: "Investigate a concrete independent research subtask inside the recorded workspace boundary and return evidence-grounded results to the parent agent.",
                prompt: createResearchSystemPrompt({
                  hasTools: mcpTools.length > 0,
                  hasMemoryTools: hasTool(options.toolRegistry, "memory_search"),
                  hasRunbookTools: hasTool(options.toolRegistry, "runbook_list"),
                  hasReportTools: hasTool(options.toolRegistry, "report_list"),
                  agentPath: "/root/researcher",
                  hasCollaborationTools: false,
                  goalEnabled: false,
                  researchProfile: options.researchProfile,
                  workflowId: workflow.id,
                  ...(input.modelInput.agentInstructions ? { agentInstructions: input.modelInput.agentInstructions } : {}),
                }),
                tools: mcpToolNames,
                model: "inherit",
                permissionMode: "dontAsk",
              },
            },
            tools: ["Agent"],
            allowedTools: ["Agent", ...mcpToolNames],
            permissionMode: "dontAsk",
            settingSources: [],
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: createResearchSystemPrompt({
                hasTools: mcpTools.length > 0,
                hasMemoryTools: hasTool(options.toolRegistry, "memory_search"),
                hasRunbookTools: hasTool(options.toolRegistry, "runbook_list"),
                hasReportTools: hasTool(options.toolRegistry, "report_list"),
                hasSessionDispositionTool: hasTool(options.toolRegistry, "session_disposition"),
                hasCollaborationTools: true,
                goalEnabled: false,
                researchProfile: options.researchProfile,
                workflowId: workflow.id,
                ...(input.modelInput.agentInstructions ? { agentInstructions: input.modelInput.agentInstructions } : {}),
              }),
            },
            includePartialMessages: true,
            forwardSubagentText: true,
            ...(effort ? { effort } : {}),
            ...(options.reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
            ...(options.maxTokens ? { taskBudget: { total: options.maxTokens } } : {}),
            env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "honeycrisp/0.1.0" },
          },
        });
        for await (const message of stream) {
          sessionId = message.session_id || sessionId;
          if (message.type === "assistant") {
            const text = assistantMessageText(message);
            if (text) assistantText.push(text);
            await emitAssistantMessage(input.eventSink, message, text);
          } else if (message.type === "result") {
            result = message;
            finishInput();
          }
        }
      } finally {
        finishInput();
        input.signal?.removeEventListener("abort", abort);
      }

      if (!result) throw new Error("Claude Agent SDK ended without a result message.");
      if (result.subtype !== "success") {
        throw new Error(result.errors.join("\n") || `Claude Agent SDK stopped with ${result.subtype}.`);
      }
      sessionId = result.session_id || sessionId;
      if (!sessionId) throw new Error("Claude Agent SDK did not return a resumable session ID.");
      return {
        text: result.result || assistantText.at(-1) || "",
        ...(toolEvents.length > 0 ? { toolEvents } : {}),
        raw: {
          provider: "anthropic",
          model: options.model,
          api: "claude-agent-sdk",
          lifecycle: "claude-agent-sdk",
          toolCallCount,
          result,
          resumableState: {
            schemaVersion: 1,
            provider: "anthropic",
            model: options.model,
            providerSessionId: sessionId,
            researchProfileHash: profileHash,
            workflowId: workflow.id,
          } satisfies ClaudeAgentResumableState,
        },
      };
    },
  };
}

async function* streamUserMessages(
  initialPrompt: string,
  waitForSteeringMessages: (signal?: AbortSignal) => Promise<readonly string[]>,
  inputFinished: Promise<void>,
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  yield sdkUserMessage(initialPrompt);
  while (!signal.aborted) {
    const waitController = new AbortController();
    const abortWait = () => waitController.abort(signal.reason);
    signal.addEventListener("abort", abortWait, { once: true });
    const outcome = await Promise.race([
      waitForSteeringMessages(waitController.signal).then(
        (messages) => ({ type: "messages" as const, messages }),
        (error: unknown) => {
          if (waitController.signal.aborted) return { type: "finished" as const };
          throw error;
        },
      ),
      inputFinished.then(() => ({ type: "finished" as const })),
    ]).finally(() => {
      signal.removeEventListener("abort", abortWait);
    });
    if (outcome.type === "finished") {
      waitController.abort();
      return;
    }
    for (const message of outcome.messages) {
      const content = message.trim();
      if (content) yield sdkUserMessage(`User steering for the active research run:\n\n${content}`);
    }
  }
}

function sdkUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

function formatModelInput(modelInput: ResearchAgentModelInput): string {
  const context = modelInput.contextSections
    .filter((section) => section.content !== undefined && section.content !== null && section.content !== "")
    .map((section) => `### ${section.label}\n${typeof section.content === "string" ? section.content : JSON.stringify(section.content, null, 2)}`);
  return [modelInput.prompt, ...(context.length > 0 ? ["", "## Research Context", ...context] : [])].join("\n");
}

function hasTool(registry: ResearchToolRegistry | undefined, transportName: string): boolean {
  return Boolean(registry?.find(transportName));
}

function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  if (value === "minimal") return "low";
  return undefined;
}

function assistantMessageText(message: SDKAssistantMessage): string {
  return message.message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("");
}

async function emitAssistantMessage(
  sink: ResearchLiveEventSink | undefined,
  message: SDKAssistantMessage,
  text: string,
): Promise<void> {
  if (!sink || !text) return;
  await safeEmit(sink, {
    schemaVersion: 1,
    kind: "model.output",
    timestamp: nowIso(),
    payload: {
      agentId: message.parent_tool_use_id ? message.parent_tool_use_id : "root",
      agentPath: message.parent_tool_use_id ? `/root/${message.parent_tool_use_id}` : "/root",
      parentAgentId: message.parent_tool_use_id ? "root" : "",
      phase: "completed",
      eventType: "text_end",
      text,
    },
  });
}

async function emitResearchEvents(sink: ResearchLiveEventSink | undefined, events: readonly ResearchEvent[]): Promise<void> {
  if (!sink) return;
  for (const event of events) {
    await safeEmit(sink, {
      schemaVersion: 1,
      kind: "research.event",
      timestamp: nowIso(),
      payload: { event, agentId: "root", agentPath: "/root", parentAgentId: "" },
    });
  }
}

async function safeEmit(sink: ResearchLiveEventSink, event: Parameters<ResearchLiveEventSink>[0]): Promise<void> {
  try {
    await sink(event);
  } catch {
    // Live UI streaming must not affect the research session.
  }
}

function jsonObjectShape(schema: unknown): Record<string, ZodType> {
  const root = isRecord(schema) ? schema : {};
  const properties = isRecord(root.properties) ? root.properties : {};
  const required = new Set(Array.isArray(root.required) ? root.required.filter((item): item is string => typeof item === "string") : []);
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    const field = jsonSchemaToZod(value);
    return [name, required.has(name) ? field : field.optional()];
  }));
}

function jsonSchemaToZod(schema: unknown): ZodType {
  if (!isRecord(schema)) return z.unknown();
  let result: ZodType;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((value) => z.literal(value as string | number | boolean | null));
    result = literals.length === 1 ? literals[0]! : z.union([literals[0]!, literals[1]!, ...literals.slice(2)]);
  } else if (schema.type === "string") {
    result = z.string();
  } else if (schema.type === "integer") {
    result = z.number().int();
  } else if (schema.type === "number") {
    result = z.number();
  } else if (schema.type === "boolean") {
    result = z.boolean();
  } else if (schema.type === "array") {
    result = z.array(jsonSchemaToZod(schema.items));
  } else if (schema.type === "object" || isRecord(schema.properties)) {
    result = z.object(jsonObjectShape(schema)).passthrough();
  } else {
    result = z.unknown();
  }
  return typeof schema.description === "string" ? result.describe(schema.description) : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
