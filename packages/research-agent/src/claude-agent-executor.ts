import {
  createSdkMcpServer,
  query,
  tool,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodType } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createId, nowIso } from "./ids.js";
import {
  ProviderAuthenticationRouter,
  type ProviderAuthenticationPreferences,
} from "./auth-routing.js";
import { researchProfileHash, researchProfileWorkflow, type ResearchProfile } from "./research-profile.js";
import { createResearchSystemPrompt } from "./system-prompt.js";
import { SubagentManager, type SubagentRunRequest, type SubagentRunResult } from "./subagent-runtime.js";
import {
  getToolTransportName,
  projectModelToolResult,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import type {
  ResearchAgentExecutor,
  ResearchAgentExecutionInput,
  ResearchAgentModelInput,
  ResearchEvent,
  ResearchLiveEventSink,
  ResearchCollaborationConfig,
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
  subagents?: false;
  collaboration?: ResearchCollaborationConfig;
  collaborationTools?: readonly AgentTool[];
  runAlternateSubagent?: (
    request: SubagentRunRequest,
    rootInput: ResearchAgentExecutionInput,
  ) => Promise<SubagentRunResult>;
  agentIdentity?: { id: string; path: string; parentId: string };
  authenticationPreferences?: ProviderAuthenticationPreferences;
}

export interface CompleteClaudeAgentTextOptions {
  model: string;
  prompt: string;
  systemPrompt: string;
  reasoning?: string;
  cwd?: string;
  signal?: AbortSignal;
  authenticationPreferences?: ProviderAuthenticationPreferences;
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
  const authenticationRouter = new ProviderAuthenticationRouter(options.authenticationPreferences);
  try {
    const effort = claudeEffort(options.reasoning);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      result = undefined;
      try {
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
            env: authenticationRouter.claudeEnvironment(),
          },
        });
        for await (const message of stream) {
          if (message.type === "result") result = message;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (authenticationRouter.tryFallback("anthropic", message)) continue;
        throw error;
      }
      const errors = result?.subtype === "success" ? "" : result?.errors.join("\n") ?? "";
      if (!errors || !authenticationRouter.tryFallback("anthropic", errors)) break;
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
  const authenticationRouter = new ProviderAuthenticationRouter(options.authenticationPreferences);
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
            await emitResearchEvents(input.eventSink, record.events, options.agentIdentity);
            const projection = projectModelToolResult(record.result);
            return {
              content: projection.content,
              isError: projection.isError,
            };
          },
        ));
      const abortController = new AbortController();
      const abort = () => abortController.abort(input.signal?.reason);
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });

      const collaboration = options.collaboration;
      const collaborationManager = options.subagents === false || collaboration?.mode === "solo"
        ? null
        : new SubagentManager({
            rootProvider: "anthropic",
            rootModel: options.model,
            ...(options.reasoning ? { rootReasoning: options.reasoning as never } : {}),
            ...(collaboration ? {
              maxThreads: collaboration.maxMembersPerRoom * collaboration.maxConcurrentRooms,
              peerChallengeRounds: collaboration.peerChallengeRounds,
              requireRoomBeforeFinal: collaboration.mode === "always",
              maxConcurrentRooms: collaboration.maxConcurrentRooms,
              maxMembersPerRoom: collaboration.maxMembersPerRoom,
              maxTotalInvocations: collaboration.maxTotalInvocations,
              providerPreferences: collaboration.providers.map((preference) => ({
                provider: preference.provider,
                model: preference.model,
                ...(preference.reasoningEffort ? { reasoning: preference.reasoningEffort as never } : {}),
                enabled: preference.enabled,
              })),
            } : {}),
            signal: abortController.signal,
            run: (request) => {
              if (!options.runAlternateSubagent) throw new Error("No provider-neutral breakout worker is configured.");
              return options.runAlternateSubagent(request, input);
            },
            onActivity: async (activity) => {
              if (!input.eventSink) return;
              const { type: action, ...details } = activity;
              await safeEmit(input.eventSink, {
                schemaVersion: 1,
                kind: "agent.event",
                timestamp: nowIso(),
                payload: { type: "subagent.activity", action, ...details },
              });
            },
            onToolEvent: (event) => emitResearchEvents(input.eventSink, [event], options.agentIdentity),
          });
      const collaborationMcpTools = [
        ...(collaborationManager?.createTools("root") ?? []),
        ...(options.collaborationTools ?? []),
      ].map((candidate) => agentToolAsSdkTool(candidate, abortController.signal));
      const allMcpTools = [...mcpTools, ...collaborationMcpTools];
      const allMcpServer = createSdkMcpServer({
        name: "honeycrisp",
        version: "1.0.0",
        instructions: "These are Honeycrisp's governed research and breakout-room tools. Use them for durable research work and bounded collaboration.",
        tools: allMcpTools,
        alwaysLoad: true,
      });
      const allMcpToolNames = allMcpTools.map((candidate) => `mcp__honeycrisp__${candidate.name}`);

      let sessionId = options.resumableState?.providerSessionId;
      let result: SDKResultMessage | undefined;
      const assistantText: string[] = [];
      const effort = claudeEffort(options.reasoning);
      let finishInput!: () => void;
      const inputFinished = new Promise<void>((resolvePromise) => {
        finishInput = resolvePromise;
      });
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          result = undefined;
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
                mcpServers: { honeycrisp: allMcpServer },
                tools: [],
                allowedTools: allMcpToolNames,
                permissionMode: "dontAsk",
                settingSources: [],
                systemPrompt: {
                  type: "preset",
                  preset: "claude_code",
                  append: appendClaudeAgentProgressGuidance(
                    createResearchSystemPrompt({
                      hasTools: mcpTools.length > 0,
                      hasMemoryTools: hasTool(options.toolRegistry, "memory_search"),
                      hasRunbookTools: hasTool(options.toolRegistry, "runbook_list"),
                      hasReportTools: hasTool(options.toolRegistry, "report_list"),
                      hasSessionDispositionTool: !options.agentIdentity && hasTool(options.toolRegistry, "session_disposition"),
                      hasCollaborationTools: collaborationMcpTools.length > 0,
                      ...(collaboration ? { collaborationGuidance: collaborationSystemGuidance(collaboration) } : {}),
                      goalEnabled: false,
                      ...(options.agentIdentity ? { agentPath: options.agentIdentity.path } : {}),
                      researchProfile: options.researchProfile,
                      workflowId: workflow.id,
                      ...(input.modelInput.agentInstructions ? { agentInstructions: input.modelInput.agentInstructions } : {}),
                    }),
                  ),
                },
                includePartialMessages: true,
                forwardSubagentText: true,
                ...(effort ? { effort } : {}),
                ...(options.reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
                ...(options.maxTokens ? { taskBudget: { total: options.maxTokens } } : {}),
                env: authenticationRouter.claudeEnvironment(),
              },
            });
            for await (const message of stream) {
              sessionId = message.session_id || sessionId;
              if (message.type === "assistant") {
                const output = projectClaudeAgentAssistantOutput(message, options.model, options.agentIdentity);
                if (output) assistantText.push(output.text);
                await emitAssistantMessage(input.eventSink, output);
              } else if (message.type === "result") {
                result = message;
                finishInput();
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const canRetryWithAlternateAuthentication = toolCallCount === 0
              && assistantText.length === 0
              && authenticationRouter.tryFallback("anthropic", message);
            if (canRetryWithAlternateAuthentication) continue;
            throw error;
          }
          const errors = result?.subtype === "success" ? "" : result?.errors.join("\n") ?? "";
          const canRetryWithAlternateAuthentication = toolCallCount === 0
            && assistantText.length === 0
            && Boolean(errors)
            && authenticationRouter.tryFallback("anthropic", errors);
          if (!canRetryWithAlternateAuthentication) break;
        }
        assertSuccessfulClaudeResult(result);
        sessionId = result.session_id || sessionId;
        if (!sessionId) throw new Error("Claude Agent SDK did not return a resumable session ID.");

        await collaborationManager?.settle();
        let collaborationFollowUp = collaborationManager?.collaborationFollowUp("root") ?? [];
        const maxCollaborationContinuations = Math.max(2, (collaboration?.maxTotalInvocations ?? 0) + 2);
        let collaborationContinuationCount = 0;
        while (collaborationFollowUp.length > 0) {
          if (collaborationContinuationCount >= maxCollaborationContinuations) {
            throw new Error("Claude collaboration did not reach a synthesized room outcome within the continuation limit.");
          }
          collaborationContinuationCount += 1;
          const continuationPrompt = collaborationFollowUp
            .map((message) => isRecord(message) && typeof message.content === "string" ? message.content : JSON.stringify(message))
            .join("\n\n");
          result = undefined;
          const stream = query({
            prompt: continuationPrompt,
            options: {
              abortController,
              cwd: options.workspaceRoot,
              model: options.model,
              resume: sessionId,
              mcpServers: { honeycrisp: allMcpServer },
              tools: [],
              allowedTools: allMcpToolNames,
              permissionMode: "dontAsk",
              settingSources: [],
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: appendClaudeAgentProgressGuidance(
                  createResearchSystemPrompt({
                    hasTools: mcpTools.length > 0,
                    hasMemoryTools: hasTool(options.toolRegistry, "memory_search"),
                    hasRunbookTools: hasTool(options.toolRegistry, "runbook_list"),
                    hasReportTools: hasTool(options.toolRegistry, "report_list"),
                    hasSessionDispositionTool: !options.agentIdentity && hasTool(options.toolRegistry, "session_disposition"),
                    hasCollaborationTools: collaborationMcpTools.length > 0,
                    ...(collaboration ? { collaborationGuidance: collaborationSystemGuidance(collaboration) } : {}),
                    goalEnabled: false,
                    ...(options.agentIdentity ? { agentPath: options.agentIdentity.path } : {}),
                    researchProfile: options.researchProfile,
                    workflowId: workflow.id,
                    ...(input.modelInput.agentInstructions ? { agentInstructions: input.modelInput.agentInstructions } : {}),
                  }),
                ),
              },
              includePartialMessages: true,
              forwardSubagentText: true,
              ...(effort ? { effort } : {}),
              ...(options.reasoning === "off" ? { thinking: { type: "disabled" as const } } : {}),
              ...(options.maxTokens ? { taskBudget: { total: options.maxTokens } } : {}),
              env: authenticationRouter.claudeEnvironment(),
            },
          });
          for await (const message of stream) {
            sessionId = message.session_id || sessionId;
            if (message.type === "assistant") {
              const output = projectClaudeAgentAssistantOutput(message, options.model, options.agentIdentity);
              if (output) assistantText.push(output.text);
              await emitAssistantMessage(input.eventSink, output);
            } else if (message.type === "result") {
              result = message;
            }
          }
          assertSuccessfulClaudeResult(result);
          sessionId = result.session_id || sessionId;
          await collaborationManager?.settle();
          collaborationFollowUp = collaborationManager?.collaborationFollowUp("root") ?? [];
        }

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
      } finally {
        finishInput();
        await collaborationManager?.settle();
        input.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

function assertSuccessfulClaudeResult(result: SDKResultMessage | undefined): asserts result is SDKResultMessage & { subtype: "success" } {
  if (!result) throw new Error("Claude Agent SDK ended without a result message.");
  if (result.subtype !== "success") {
    throw new Error(result.errors.join("\n") || "Claude Agent SDK stopped with " + result.subtype + ".");
  }
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

function agentToolAsSdkTool(candidate: AgentTool, signal: AbortSignal) {
  return tool(
    candidate.name,
    candidate.description,
    jsonObjectShape(candidate.parameters),
    async (args) => {
      const result = await candidate.execute(
        createId("claude_collaboration"),
        isRecord(args) ? args : {},
        signal,
        () => undefined,
      );
      const text = result.content.flatMap((item) => {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return [];
        return [item.text];
      }).join("\n");
      return { content: [{ type: "text" as const, text: text || "{}" }] };
    },
  );
}

function collaborationSystemGuidance(config: ResearchCollaborationConfig): string {
  const enabled = config.providers.filter((provider) => provider.enabled);
  return [
    `Collaboration mode is ${config.mode} with ${config.intensity} intensity. Enabled collaborator routes: ${enabled.map((provider) => `${provider.provider}/${provider.model}`).join(", ") || "none"}.`,
    "For an explicit collaborator route, pass provider and model as separate fields with fork_turns set to none or a bounded number. With fork_turns=all, omit provider, model, and reasoning_effort.",
    `Use no more than ${config.maxConcurrentRooms} concurrent rooms, ${config.maxMembersPerRoom} members per room, and ${config.maxTotalInvocations} collaborator invocations.`,
    config.independentFirstPass
      ? "Require an independent evidence memo from each member before peer messaging."
      : "Independent first passes are optional.",
    `Use at most ${config.peerChallengeRounds} peer challenge round${config.peerChallengeRounds === 1 ? "" : "s"} per room; create rooms atomically with create_room and publish structured evidence packets.`,
    config.mode === "adaptive"
      ? "Create rooms only for decomposable coverage, meaningful disagreement, evidence review, or proving work."
      : "Use rooms for every materially separable research stage.",
  ].join(" ");
}

export function appendClaudeAgentProgressGuidance(systemPrompt: string): string {
  return [
    systemPrompt,
    "Claude Agent SDK does not expose an OpenAI-style commentary channel. Emit the required concise progress updates as ordinary assistant text before initial tool work and whenever evidence materially changes the plan. Do not leave all user-visible progress inside extended thinking, and do not reveal private chain-of-thought; summarize only the current action, rationale, and material result.",
  ].join("\n");
}

export interface ClaudeAgentAssistantOutput {
  text: string;
  payload: Record<string, unknown>;
}

export function projectClaudeAgentAssistantOutput(
  message: SDKAssistantMessage,
  model: string,
  identity?: { id: string; path: string; parentId: string },
): ClaudeAgentAssistantOutput | undefined {
  const text = message.message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("");
  if (!text) return undefined;
  const responseId = message.request_id ?? message.uuid;
  return {
    text,
    payload: {
      agentId: identity?.id ?? (message.parent_tool_use_id ? message.parent_tool_use_id : "root"),
      agentPath: identity?.path ?? (message.parent_tool_use_id ? `/root/${message.parent_tool_use_id}` : "/root"),
      parentAgentId: identity?.parentId ?? (message.parent_tool_use_id ? "root" : ""),
      phase: "completed",
      eventType: "text_end",
      messagePhase: message.message.stop_reason === "end_turn" ? "final_answer" : "commentary",
      responseId,
      itemId: `claude-text:${message.uuid}`,
      provider: "anthropic",
      model,
      api: "claude-agent-sdk",
      text,
    },
  };
}

async function emitAssistantMessage(
  sink: ResearchLiveEventSink | undefined,
  output: ClaudeAgentAssistantOutput | undefined,
): Promise<void> {
  if (!sink || !output) return;
  await safeEmit(sink, {
    schemaVersion: 1,
    kind: "model.output",
    timestamp: nowIso(),
    payload: output.payload,
  });
}

async function emitResearchEvents(
  sink: ResearchLiveEventSink | undefined,
  events: readonly ResearchEvent[],
  identity?: { id: string; path: string; parentId: string },
): Promise<void> {
  if (!sink) return;
  for (const event of events) {
    await safeEmit(sink, {
      schemaVersion: 1,
      kind: "research.event",
      timestamp: nowIso(),
      payload: {
        event,
        agentId: identity?.id ?? "root",
        agentPath: identity?.path ?? "/root",
        parentAgentId: identity?.parentId ?? "",
      },
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
