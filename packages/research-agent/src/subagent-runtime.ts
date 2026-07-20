import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ResearchEvent } from "./types.js";

export const SUBAGENT_COLLABORATION_TOOLS = [
  { name: "spawn_agent", description: "Spawn a bounded child session for independent work." },
  { name: "send_message", description: "Queue a message for an existing agent." },
  { name: "followup_task", description: "Extend or restart a non-root child session." },
  { name: "interrupt_agent", description: "Interrupt a child turn while preserving its session." },
  { name: "list_agents", description: "List agents in the current session tree." },
  { name: "wait_agent", description: "Wait for mailbox or agent lifecycle activity." },
] as const;

export type SubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "errored";

export interface SubagentRunRequest {
  id: string;
  path: string;
  parentId: string;
  depth: number;
  model: string;
  reasoning?: SimpleStreamOptions["reasoning"];
  prompt: string;
  inheritedMessages: AgentMessage[];
  signal: AbortSignal;
}

export interface SubagentRunResult {
  messages: AgentMessage[];
  text: string;
  turnCount: number;
  toolCallCount: number;
  modelCalls: readonly Record<string, unknown>[];
  toolEvents: readonly ResearchEvent[];
}

export interface CreateSubagentManagerOptions {
  rootModel: string;
  rootReasoning?: SimpleStreamOptions["reasoning"];
  maxThreads?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  run(request: SubagentRunRequest): Promise<SubagentRunResult>;
  onActivity?: (activity: SubagentActivity) => void | Promise<void>;
}

export interface SubagentActivity {
  type: "spawned" | "message" | "followup" | "interrupted" | "completed" | "errored";
  agentId: string;
  agentPath: string;
  parentId: string | null;
  status: SubagentStatus;
  message?: string;
}

interface SubagentSession {
  id: string;
  path: string;
  taskName: string;
  parentId: string | null;
  depth: number;
  model: string;
  reasoning?: SimpleStreamOptions["reasoning"];
  forkTurns: string;
  status: SubagentStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  messages: AgentMessage[];
  mailbox: AgentMessage[];
  controller?: AbortController;
  promise?: Promise<void>;
  turnCount: number;
  toolCallCount: number;
  modelCalls: readonly Record<string, unknown>[];
  toolEvents: readonly ResearchEvent[];
}

interface Waiter {
  resolve(changed: boolean): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_THREADS = 6;
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;
const TASK_NAME_PATTERN = /^[a-z0-9_]+$/;
const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class SubagentManager {
  private readonly sessions = new Map<string, SubagentSession>();
  private readonly contextSnapshots = new Map<string, AgentMessage[]>();
  private readonly waiters = new Set<Waiter>();
  private readonly maxThreads: number;
  private readonly maxDepth: number;
  private activityVersion = 0;

  public constructor(private readonly options: CreateSubagentManagerOptions) {
    this.maxThreads = positiveInteger(options.maxThreads) ?? DEFAULT_MAX_THREADS;
    this.maxDepth = nonNegativeInteger(options.maxDepth) ?? DEFAULT_MAX_DEPTH;
    this.sessions.set("root", {
      id: "root",
      path: "/root",
      taskName: "root",
      parentId: null,
      depth: 0,
      model: options.rootModel,
      ...(options.rootReasoning ? { reasoning: options.rootReasoning } : {}),
      forkTurns: "all",
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      messages: [],
      mailbox: [],
      turnCount: 0,
      toolCallCount: 0,
      modelCalls: [],
      toolEvents: [],
    });
    options.signal?.addEventListener("abort", () => this.interruptAll(), { once: true });
  }

  public captureContext(agentId: string, toolCallId: string, messages: readonly AgentMessage[]): void {
    this.ensureSession(agentId);
    this.contextSnapshots.set(toolCallId, cloneMessages(messages));
  }

  public createTools(agentId: string): AgentTool[] {
    const session = this.ensureSession(agentId);
    const tools = [
      ...(session.depth < this.maxDepth ? [this.createSpawnTool(agentId)] : []),
      this.createSendMessageTool(agentId),
      this.createFollowupTool(agentId),
      this.createInterruptTool(agentId),
      this.createListTool(agentId),
      this.createWaitTool(agentId),
    ];
    return tools;
  }

  public takeMailbox(agentId: string): AgentMessage[] {
    const session = this.ensureSession(agentId);
    return session.mailbox.splice(0, session.mailbox.length);
  }

  public allToolEvents(): ResearchEvent[] {
    return [...this.sessions.values()].flatMap((session) => session.id === "root" ? [] : session.toolEvents);
  }

  public snapshot(): Record<string, unknown> {
    const agents = [...this.sessions.values()]
      .filter((session) => session.id !== "root")
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((session) => ({
        id: session.id,
        path: session.path,
        taskName: session.taskName,
        parentId: session.parentId,
        depth: session.depth,
        status: session.status,
        model: session.model,
        reasoningEffort: session.reasoning ?? null,
        forkTurns: session.forkTurns,
        createdAt: session.createdAt,
        startedAt: session.startedAt ?? null,
        completedAt: session.completedAt ?? null,
        output: session.output ?? null,
        error: session.error ?? null,
        turnCount: session.turnCount,
        toolCallCount: session.toolCallCount,
        modelCalls: session.modelCalls,
      }));
    return {
      maxThreads: this.maxThreads,
      maxDepth: this.maxDepth,
      agents,
    };
  }

  public async settle(): Promise<void> {
    const pending = [...this.sessions.values()].flatMap((session) => session.promise ? [session.promise] : []);
    await Promise.allSettled(pending);
  }

  public interruptAll(): void {
    for (const session of this.sessions.values()) {
      if (session.id !== "root" && session.status === "running") {
        session.status = "interrupted";
        session.controller?.abort();
      }
    }
    this.notifyActivity();
  }

  private createSpawnTool(agentId: string): AgentTool {
    return agentTool(
      "spawn_agent",
      "Spawn agent",
      "Spawn a bounded subagent for an independent task. The child shares this authorized workspace and tool policy. fork_turns accepts none, all, or a positive integer string. Full-history children inherit the parent model and reasoning effort; partial or fresh children may override them.",
      {
        type: "object",
        required: ["task_name", "message"],
        additionalProperties: false,
        properties: {
          task_name: { type: "string", description: "Lowercase letters, digits, and underscores." },
          message: { type: "string", description: "Concrete bounded task for the child." },
          fork_turns: { type: "string", description: "none, all, or a positive integer string. Defaults to all." },
          model: { type: "string", description: "Optional model override for partial or fresh inheritance." },
          reasoning_effort: { type: "string", enum: [...REASONING_LEVELS] },
        },
      },
      async (toolCallId, input) => this.spawn(agentId, toolCallId, input),
    );
  }

  private createSendMessageTool(agentId: string): AgentTool {
    return agentTool(
      "send_message",
      "Send message",
      "Queue a message for an existing agent. It is delivered at the next message boundary and does not start an idle agent turn.",
      messageSchema("Message text to queue on the target agent."),
      async (_toolCallId, input) => this.sendMessage(agentId, input, false),
    );
  }

  private createFollowupTool(agentId: string): AgentTool {
    return agentTool(
      "followup_task",
      "Follow-up task",
      "Send a follow-up task to a non-root agent. Running agents receive it at a message boundary; idle completed or interrupted agents start another turn with their existing session context.",
      messageSchema("Follow-up task text."),
      async (_toolCallId, input) => this.sendMessage(agentId, input, true),
    );
  }

  private createInterruptTool(agentId: string): AgentTool {
    return agentTool(
      "interrupt_agent",
      "Interrupt agent",
      "Interrupt another agent's active turn without deleting its session, messages, or result history.",
      targetSchema(),
      async (_toolCallId, input) => this.interrupt(agentId, requiredString(input.target, "target")),
    );
  }

  private createListTool(agentId: string): AgentTool {
    return agentTool(
      "list_agents",
      "List agents",
      "List agents in the current root tree, including their canonical paths, status, model, reasoning effort, and inheritance mode.",
      {
        type: "object",
        additionalProperties: false,
        properties: { path_prefix: { type: "string" } },
      },
      async (_toolCallId, input) => this.list(agentId, optionalString(input.path_prefix)),
    );
  }

  private createWaitTool(agentId: string): AgentTool {
    return agentTool(
      "wait_agent",
      "Wait for agent activity",
      "Wait for a mailbox message or final-status notification from any agent. Updates are delivered separately into the caller's conversation.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          timeout_ms: { type: "number", minimum: MIN_WAIT_TIMEOUT_MS, maximum: MAX_WAIT_TIMEOUT_MS },
        },
      },
      async (_toolCallId, input) => this.wait(agentId, optionalNumber(input.timeout_ms)),
    );
  }

  private spawn(
    parentId: string,
    toolCallId: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const parent = this.ensureSession(parentId);
    if (parent.depth >= this.maxDepth) {
      throw new Error(`Subagent depth limit reached (${this.maxDepth}).`);
    }
    const taskName = requiredString(input.task_name, "task_name");
    if (!TASK_NAME_PATTERN.test(taskName)) {
      throw new Error("task_name must use lowercase letters, digits, and underscores.");
    }
    const path = `${parent.path}/${taskName}`;
    if ([...this.sessions.values()].some((session) => session.path === path)) {
      throw new Error(`Agent task path already exists: ${path}`);
    }
    const activeCount = [...this.sessions.values()].filter((session) => session.id !== "root" && session.status === "running").length;
    if (activeCount >= this.maxThreads) {
      throw new Error(`Subagent concurrency limit reached (${this.maxThreads}).`);
    }

    const message = requiredString(input.message, "message");
    const forkTurns = normalizeForkTurns(optionalString(input.fork_turns) ?? "all");
    const modelOverride = optionalString(input.model);
    const reasoningOverride = optionalReasoning(input.reasoning_effort);
    if (forkTurns === "all" && (modelOverride || reasoningOverride)) {
      throw new Error("Full-history children inherit the parent model and reasoning effort. Omit overrides or use partial/no inheritance.");
    }
    const parentMessages = this.contextSnapshots.get(toolCallId) ?? [];
    this.contextSnapshots.delete(toolCallId);
    const inheritedMessages = inheritMessages(parentMessages, toolCallId, forkTurns);
    const id = `agent_${randomUUID().replaceAll("-", "")}`;
    const child: SubagentSession = {
      id,
      path,
      taskName,
      parentId,
      depth: parent.depth + 1,
      model: modelOverride ?? parent.model,
      ...(reasoningOverride ?? parent.reasoning ? { reasoning: reasoningOverride ?? parent.reasoning } : {}),
      forkTurns,
      status: "pending",
      createdAt: new Date().toISOString(),
      messages: inheritedMessages,
      mailbox: [],
      turnCount: 0,
      toolCallCount: 0,
      modelCalls: [],
      toolEvents: [],
    };
    this.sessions.set(id, child);
    this.launch(child, message, inheritedMessages);
    void this.emitActivity({ type: "spawned", agentId: id, agentPath: path, parentId, status: child.status, message });
    return {
      agent_id: id,
      task_name: path,
      model: child.model,
      reasoning_effort: child.reasoning ?? null,
      fork_turns: forkTurns,
    };
  }

  private sendMessage(
    authorId: string,
    input: Record<string, unknown>,
    triggerTurn: boolean,
  ): Record<string, unknown> {
    const author = this.ensureSession(authorId);
    const target = this.resolveTarget(author, requiredString(input.target, "target"));
    if (triggerTurn && target.id === "root") {
      throw new Error("followup_task cannot target the root agent; use send_message instead.");
    }
    const message = requiredString(input.message, "message");
    const envelope = agentMessage(author.path, message);
    const wasIdle = target.status !== "running";
    if (triggerTurn && wasIdle) {
      this.launch(target, message, target.messages);
    } else {
      target.mailbox.push(envelope);
    }
    this.notifyActivity();
    void this.emitActivity({
      type: triggerTurn ? "followup" : "message",
      agentId: target.id,
      agentPath: target.path,
      parentId: target.parentId,
      status: target.status,
      message,
    });
    return { delivered: true, target: target.path, triggered_turn: triggerTurn && wasIdle };
  }

  private interrupt(authorId: string, targetValue: string): Record<string, unknown> {
    const author = this.ensureSession(authorId);
    const target = this.resolveTarget(author, targetValue);
    if (target.id === "root" || target.id === authorId) {
      throw new Error("An agent cannot interrupt the root agent or itself.");
    }
    const previousStatus = target.status;
    if (target.status === "running" || target.status === "pending") {
      target.status = "interrupted";
      target.completedAt = new Date().toISOString();
      target.controller?.abort();
      this.enqueueParentNotification(target, `Agent ${target.path} was interrupted.`);
      this.notifyActivity();
    }
    void this.emitActivity({ type: "interrupted", agentId: target.id, agentPath: target.path, parentId: target.parentId, status: target.status });
    return { target: target.path, previous_status: previousStatus };
  }

  private list(_authorId: string, pathPrefix?: string): Record<string, unknown> {
    const prefix = pathPrefix?.trim();
    return {
      agents: [...this.sessions.values()]
        .filter((session) => session.id !== "root" && (!prefix || session.path.startsWith(prefix)))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((session) => ({
          id: session.id,
          path: session.path,
          parent_id: session.parentId,
          status: session.status,
          model: session.model,
          reasoning_effort: session.reasoning ?? null,
          fork_turns: session.forkTurns,
          output: session.status === "completed" ? session.output ?? "" : null,
          error: session.error ?? null,
        })),
    };
  }

  private async wait(agentId: string, requestedTimeout?: number): Promise<Record<string, unknown>> {
    const session = this.ensureSession(agentId);
    if (session.mailbox.length > 0) {
      return { message: "Mailbox updates are ready.", timed_out: false };
    }
    const timeoutMs = requestedTimeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw new Error(`timeout_ms must be between ${MIN_WAIT_TIMEOUT_MS} and ${MAX_WAIT_TIMEOUT_MS}.`);
    }
    const startedVersion = this.activityVersion;
    const changed = await new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.waiters.add(waiter);
      if (this.activityVersion !== startedVersion || session.mailbox.length > 0) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        resolve(true);
      }
    });
    return { message: changed ? "Agent activity is ready." : "Wait timed out.", timed_out: !changed };
  }

  private launch(session: SubagentSession, prompt: string, inheritedMessages: AgentMessage[]): void {
    const controller = new AbortController();
    session.controller = controller;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    delete session.completedAt;
    delete session.error;
    const promise = this.options.run({
      id: session.id,
      path: session.path,
      parentId: session.parentId ?? "root",
      depth: session.depth,
      model: session.model,
      ...(session.reasoning ? { reasoning: session.reasoning } : {}),
      prompt,
      inheritedMessages: cloneMessages(inheritedMessages),
      signal: controller.signal,
    }).then((result) => {
      if (session.status === "interrupted") return;
      session.status = "completed";
      session.completedAt = new Date().toISOString();
      session.output = result.text;
      session.messages = cloneMessages(result.messages);
      session.turnCount += result.turnCount;
      session.toolCallCount += result.toolCallCount;
      session.modelCalls = [...session.modelCalls, ...result.modelCalls];
      session.toolEvents = [...session.toolEvents, ...result.toolEvents];
      this.enqueueParentNotification(session, `Agent ${session.path} completed.\n\n${result.text}`);
      void this.emitActivity({ type: "completed", agentId: session.id, agentPath: session.path, parentId: session.parentId, status: session.status, message: result.text });
    }).catch((error) => {
      if (session.status === "interrupted" || controller.signal.aborted) return;
      session.status = "errored";
      session.completedAt = new Date().toISOString();
      session.error = error instanceof Error ? error.message : String(error);
      this.enqueueParentNotification(session, `Agent ${session.path} failed: ${session.error}`);
      void this.emitActivity({ type: "errored", agentId: session.id, agentPath: session.path, parentId: session.parentId, status: session.status, message: session.error });
    }).finally(() => {
      delete session.promise;
      this.notifyActivity();
    });
    session.promise = promise;
    this.notifyActivity();
  }

  private enqueueParentNotification(session: SubagentSession, text: string): void {
    if (!session.parentId) return;
    const parent = this.sessions.get(session.parentId);
    if (!parent) return;
    parent.mailbox.push(agentMessage(session.path, text));
  }

  private resolveTarget(author: SubagentSession, value: string): SubagentSession {
    const byId = this.sessions.get(value);
    if (byId) return byId;
    const canonical = value.startsWith("/") ? value : `${author.path}/${value}`;
    const exact = [...this.sessions.values()].find((session) => session.path === canonical || session.path === value);
    if (exact) return exact;
    const byTaskName = [...this.sessions.values()].filter((session) => session.taskName === value);
    if (byTaskName.length === 1) return byTaskName[0]!;
    throw new Error(`Unknown or ambiguous agent target: ${value}`);
  }

  private ensureSession(id: string): SubagentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown agent: ${id}`);
    return session;
  }

  private notifyActivity(): void {
    this.activityVersion += 1;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.waiters.clear();
  }

  private async emitActivity(activity: SubagentActivity): Promise<void> {
    try {
      await this.options.onActivity?.(activity);
    } catch {
      // Activity streaming is observational and must not alter orchestration.
    }
  }
}

function agentTool(
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (toolCallId: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
): AgentTool {
  return {
    name,
    label,
    description,
    parameters: parameters as AgentTool["parameters"],
    prepareArguments: (input: unknown) => isRecord(input) ? input : {},
    async execute(toolCallId: string, input: Record<string, unknown>) {
      const result = await execute(toolCallId, input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: isRecord(result) ? result : { result },
      };
    },
  } as AgentTool;
}

function messageSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    required: ["target", "message"],
    additionalProperties: false,
    properties: {
      target: { type: "string", description: "Agent id, relative task name, or canonical task path." },
      message: { type: "string", description },
    },
  };
}

function targetSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["target"],
    additionalProperties: false,
    properties: { target: { type: "string" } },
  };
}

function normalizeForkTurns(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "all") return normalized;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("fork_turns must be none, all, or a positive integer string.");
  }
  return String(parsed);
}

function inheritMessages(messages: readonly AgentMessage[], toolCallId: string, forkTurns: string): AgentMessage[] {
  const sanitized = cloneMessages(messages);
  const last = sanitized.at(-1);
  if (isAssistantWithToolCall(last, toolCallId)) sanitized.pop();
  if (forkTurns === "none") return [];
  if (forkTurns === "all") return sanitized;
  const count = Number(forkTurns);
  const userIndexes = sanitized.flatMap((message, index) => message.role === "user" ? [index] : []);
  const start = userIndexes.at(-count) ?? 0;
  return sanitized.slice(start);
}

function isAssistantWithToolCall(message: AgentMessage | undefined, toolCallId: string): boolean {
  return Boolean(
    message &&
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((item) => isRecord(item) && item.type === "toolCall" && item.id === toolCallId),
  );
}

function agentMessage(authorPath: string, message: string): AgentMessage {
  return {
    role: "user",
    content: `<agent_message from="${authorPath}">\n${message}\n</agent_message>`,
    timestamp: Date.now(),
  };
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return structuredClone(messages) as AgentMessage[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalReasoning(value: unknown): SimpleStreamOptions["reasoning"] | undefined {
  return typeof value === "string" && REASONING_LEVELS.includes(value as (typeof REASONING_LEVELS)[number])
    ? value as SimpleStreamOptions["reasoning"]
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
