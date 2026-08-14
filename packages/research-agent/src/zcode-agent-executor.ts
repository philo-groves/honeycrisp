import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createId, nowIso } from "./ids.js";
import { createCollaborationSystemGuidance } from "./collaboration-guidance.js";
import { researchProfileHash, researchProfileWorkflow, type ResearchProfile } from "./research-profile.js";
import { SubagentManager, type SubagentRunRequest, type SubagentRunResult } from "./subagent-runtime.js";
import { createResearchSystemPrompt } from "./system-prompt.js";
import {
  getToolTransportName,
  projectModelToolResult,
  type ResearchToolRegistry,
} from "./tool-registry.js";
import type {
  ResearchAgentExecutionInput,
  ResearchAgentExecutor,
  ResearchCollaborationConfig,
  ResearchEvent,
  ResearchLiveEventSink,
} from "./types.js";

export interface ZCodeAgentResumableState {
  schemaVersion: 1;
  provider: "zai";
  model: string;
  providerSessionId: string;
  researchProfileHash: string;
  workflowId: string;
}

export interface CreateZCodeAgentExecutorOptions {
  model: string;
  workspaceRoot: string;
  reasoning?: string;
  toolRegistry?: ResearchToolRegistry;
  researchProfile: ResearchProfile;
  workflowId?: string;
  resumableState?: ZCodeAgentResumableState;
  waitForSteeringMessages?: (signal?: AbortSignal) => Promise<readonly string[]>;
  subagents?: false;
  collaboration?: ResearchCollaborationConfig;
  collaborationTools?: readonly AgentTool[];
  runAlternateSubagent?: (
    request: SubagentRunRequest,
    rootInput: ResearchAgentExecutionInput,
  ) => Promise<SubagentRunResult>;
  agentIdentity?: { id: string; path: string; parentId: string };
}

interface ZCodeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: unknown[]; isError?: boolean }>;
}

interface ZCodeSessionRunResult {
  text: string;
  sessionId: string;
  raw: unknown;
}

export function extractCompatibleZCodeAgentResumableState(
  raw: unknown,
  model: string,
  expected: { researchProfileHash: string; workflowId: string },
): ZCodeAgentResumableState | undefined {
  if (!isRecord(raw) || !isRecord(raw.resumableState)) return undefined;
  const state = raw.resumableState;
  if (
    state.schemaVersion !== 1
    || state.provider !== "zai"
    || state.model !== model
    || typeof state.providerSessionId !== "string"
    || !state.providerSessionId.trim()
    || state.researchProfileHash !== expected.researchProfileHash
    || state.workflowId !== expected.workflowId
  ) return undefined;
  return {
    schemaVersion: 1,
    provider: "zai",
    model,
    providerSessionId: state.providerSessionId,
    researchProfileHash: expected.researchProfileHash,
    workflowId: expected.workflowId,
  };
}

export function createZCodeAgentExecutor(options: CreateZCodeAgentExecutorOptions): ResearchAgentExecutor {
  const workflow = researchProfileWorkflow(options.researchProfile, options.workflowId);
  const profileHash = researchProfileHash(options.researchProfile);
  return {
    name: `zcode-agent:zai/${options.model}`,
    async execute(input) {
      const abortController = new AbortController();
      const abort = () => abortController.abort(input.signal?.reason);
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });

      const toolEvents: ResearchEvent[] = [];
      let toolCallCount = 0;
      const registryTools: ZCodeTool[] = (options.toolRegistry?.listTools() ?? [])
        .filter((candidate) => candidate.parameters)
        .map((candidate) => ({
          name: getToolTransportName(candidate),
          description: candidate.descriptor.description,
          inputSchema: candidate.parameters as Record<string, unknown>,
          execute: async (args, signal) => {
            const record = await options.toolRegistry!.executeToolCall({
              id: createId("zcode_tool"),
              name: getToolTransportName(candidate),
              arguments: args,
            }, {
              toolCallCount: toolCallCount += 1,
              defaultActionClass: candidate.descriptor.actionClasses[0] ?? "analyze",
              ...(input.governance ? { governance: input.governance } : {}),
              signal,
            });
            toolEvents.push(...record.events);
            await emitResearchEvents(input.eventSink, record.events, options.agentIdentity);
            const projection = projectModelToolResult(record.result);
            return { content: projection.content as unknown[], isError: projection.isError };
          },
        }));

      const collaboration = options.collaboration;
      const collaborationManager = options.subagents === false || collaboration?.mode === "solo"
        ? null
        : new SubagentManager({
            rootProvider: "zai",
            rootModel: options.model,
            ...(options.reasoning ? { rootReasoning: options.reasoning as never } : {}),
            ...(collaboration ? {
              maxThreads: collaboration.maxMembersPerRoom * collaboration.maxConcurrentRooms,
              peerChallengeRounds: collaboration.peerChallengeRounds,
              requireRoomBeforeFinal: collaboration.mode === "always",
              maxConcurrentRooms: collaboration.maxConcurrentRooms,
              maxMembersPerRoom: collaboration.maxMembersPerRoom,
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
              await input.eventSink({
                schemaVersion: 1,
                kind: "agent.event",
                timestamp: nowIso(),
                payload: { type: "subagent.activity", action, ...details },
              });
            },
            onToolEvent: (event) => emitResearchEvents(input.eventSink, [event], options.agentIdentity),
          });
      const agentTools = [
        ...(collaborationManager?.createTools("root") ?? []),
        ...(options.collaborationTools ?? []),
      ].map((candidate): ZCodeTool => ({
        name: candidate.name,
        description: candidate.description,
        inputSchema: candidate.parameters as Record<string, unknown>,
        execute: async (args, signal) => {
          const result = await candidate.execute(createId("zcode_collaboration"), args, signal, () => undefined);
          return { content: result.content as unknown[] };
        },
      }));
      const tools = [...registryTools, ...agentTools];
      const systemPrompt = createResearchSystemPrompt({
        hasTools: registryTools.length > 0,
        hasMemoryTools: hasTool(options.toolRegistry, "memory_search"),
        hasRunbookTools: hasTool(options.toolRegistry, "runbook_list"),
        hasReportTools: hasTool(options.toolRegistry, "report_list"),
        hasSessionDispositionTool: !options.agentIdentity && hasTool(options.toolRegistry, "session_disposition"),
        hasCollaborationTools: agentTools.length > 0,
        ...(collaboration ? { collaborationGuidance: createCollaborationSystemGuidance(collaboration, workflow.id) } : {}),
        goalEnabled: false,
        ...(options.agentIdentity ? { agentPath: options.agentIdentity.path } : {}),
        researchProfile: options.researchProfile,
        workflowId: workflow.id,
        ...(input.modelInput.agentInstructions ? { agentInstructions: input.modelInput.agentInstructions } : {}),
      });
      const prompt = formatZCodePrompt(systemPrompt, input.modelInput);

      try {
        const result = await runZCodeSession({
          workspaceRoot: options.workspaceRoot,
          model: options.model,
          prompt,
          tools,
          signal: abortController.signal,
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          ...(input.eventSink ? { eventSink: input.eventSink } : {}),
          ...(options.agentIdentity ? { identity: options.agentIdentity } : {}),
          ...(options.resumableState?.providerSessionId
            ? { resumeSessionId: options.resumableState.providerSessionId }
            : {}),
          ...(options.waitForSteeringMessages
            ? { waitForSteeringMessages: options.waitForSteeringMessages }
            : {}),
        });
        await collaborationManager?.settle();
        return {
          text: result.text,
          ...(toolEvents.length > 0 ? { toolEvents } : {}),
          raw: {
            transport: "official-zcode-app-server",
            result: result.raw,
            resumableState: {
              schemaVersion: 1,
              provider: "zai",
              model: options.model,
              providerSessionId: result.sessionId,
              researchProfileHash: profileHash,
              workflowId: workflow.id,
            } satisfies ZCodeAgentResumableState,
          },
        };
      } finally {
        await collaborationManager?.settle();
        input.signal?.removeEventListener("abort", abort);
      }
    },
  };
}

async function runZCodeSession(input: {
  workspaceRoot: string;
  model: string;
  reasoning?: string;
  prompt: string;
  tools: readonly ZCodeTool[];
  signal: AbortSignal;
  eventSink?: ResearchLiveEventSink;
  identity?: { id: string; path: string; parentId: string };
  resumeSessionId?: string;
  waitForSteeringMessages?: (signal?: AbortSignal) => Promise<readonly string[]>;
}): Promise<ZCodeSessionRunResult> {
  const invocation = resolveZCodeCliInvocation(["app-server", "--stdio"]);
  if (!invocation) throw new Error("The official ZCode CLI was not found. Install ZCode and sign in before using a Z.ai subscription.");
  const mcp = await startZCodeMcpServer(input.tools, input.signal);
  const client = new ZCodeProtocolClient(invocation, input.signal, new Set(zcodeToolAllowlist(input.tools)));
  let turnResolve!: () => void;
  let turnReject!: (error: Error) => void;
  let completedText = "";
  const turnFinished = new Promise<void>((resolvePromise, rejectPromise) => {
    turnResolve = resolvePromise;
    turnReject = rejectPromise;
  });
  client.onNotification = (method, params) => {
    if (method !== "session/event") return;
    const event = isRecord(params?.event) ? params.event : params;
    const type = stringValue(event?.type);
    if (type === "turn.completed") {
      completedText = recursiveString(event, ["response"]) ?? "";
      turnResolve();
    }
    if (type === "turn.failed") turnReject(new Error(zcodeEventError(event) ?? "ZCode turn failed."));
    void emitZCodeEvent(input.eventSink, event, input.model, input.identity);
  };
  try {
    await client.start();
    const session = input.resumeSessionId
      ? await client.request("session/resume", {
          sessionId: input.resumeSessionId,
          workspace: workspaceDescriptor(input.workspaceRoot),
          mcpServers: [mcp.descriptor],
          toolAllowlist: zcodeToolAllowlist(input.tools),
        })
      : await client.request("session/create", {
          workspace: workspaceDescriptor(input.workspaceRoot),
          mode: "yolo",
          mcpServers: [mcp.descriptor],
          toolAllowlist: zcodeToolAllowlist(input.tools),
        });
    const sessionId = zcodeSessionId(session);
    if (!sessionId) throw new Error("ZCode did not return a session ID.");
    const selectedModel = findZCodeModel(session, input.model) ?? {
      providerId: "builtin:zai-coding-plan",
      modelId: input.model,
    };
    await client.request("session/setModel", { sessionId, model: selectedModel });
    const thoughtLevel = zcodeThoughtLevel(input.reasoning);
    if (thoughtLevel) await client.request("session/setThoughtLevel", { sessionId, thoughtLevel });
    await client.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });

    const stop = () => void client.request("session/stop", { sessionId }).catch(() => undefined);
    input.signal.addEventListener("abort", stop, { once: true });
    const steering = input.waitForSteeringMessages
      ? forwardZCodeSteering(client, sessionId, input.waitForSteeringMessages, input.signal)
      : Promise.resolve();
    try {
      await client.request("session/send", { sessionId, content: input.prompt });
      await turnFinished;
      const snapshot = await client.request("session/read", { sessionId });
      const text = completedText.trim() || finalZCodeAssistantText(snapshot);
      if (!text) throw new Error("ZCode completed without an assistant response.");
      await emitCompletedZCodeText(input.eventSink, text, input.model, input.identity);
      return { text, sessionId, raw: snapshot };
    } finally {
      input.signal.removeEventListener("abort", stop);
      void steering.catch(() => undefined);
    }
  } finally {
    client.close();
    await mcp.close();
  }
}

class ZCodeProtocolClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private buffer = "";
  private readonly allowedToolNames: ReadonlySet<string>;
  public onNotification: ((method: string, params: Record<string, unknown>) => void) | undefined;

  constructor(
    invocation: { command: string; args: string[]; cwd: string },
    signal: AbortSignal,
    allowedToolNames: ReadonlySet<string>,
  ) {
    this.allowedToolNames = allowedToolNames;
    this.child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, exitSignal) => {
      if (this.pending.size > 0) this.failAll(new Error(`ZCode app server exited (${exitSignal ?? code ?? "unknown"}).`));
    });
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  async start(): Promise<void> {
    if (this.child.exitCode !== null) throw new Error("ZCode app server failed to start.");
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    if (!this.child.killed) this.child.kill();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handle(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line) as unknown; } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")) {
      this.respondToServer(message.id, message.method, isRecord(message.params) ? message.params : {});
      return;
    }
    if (typeof message.method === "string") {
      this.onNotification?.(message.method, isRecord(message.params) ? message.params : {});
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (isRecord(message.error)) pending.reject(new Error(stringValue(message.error.message) ?? "ZCode protocol request failed."));
    else pending.resolve(message.result);
  }

  private respondToServer(id: string | number, method: string, params: Record<string, unknown>): void {
    if (method === "session/requestRuntimePreferences") {
      this.child.stdin.write(`${JSON.stringify({ id, result: { nativeSearchEnhancementsEnabled: false } })}\n`);
      return;
    }
    if (method === "interaction/requestPermission") {
      const toolName = stringValue(params.toolName);
      const allowed = Boolean(toolName && this.allowedToolNames.has(toolName));
      this.child.stdin.write(`${JSON.stringify({
        id,
        result: {
          decision: allowed ? "allow" : "deny",
          reason: allowed
            ? "Honeycrisp exposes this governed tool through its session-scoped MCP bridge."
            : "This tool is outside Honeycrisp's governed ZCode allowlist.",
        },
      })}\n`);
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } })}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function startZCodeMcpServer(tools: readonly ZCodeTool[], signal: AbortSignal): Promise<{
  descriptor: Record<string, unknown>;
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void handleMcpRequest(request, response, token, tools, signal);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Honeycrisp could not bind its ZCode MCP bridge.");
  return {
    descriptor: {
      name: "honeycrisp",
      type: "http",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      isolation: "session",
      protocolVersion: "auto",
      timeoutMs: 120_000,
    },
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  tools: readonly ZCodeTool[],
  signal: AbortSignal,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  try {
    const body = await readRequestBody(request);
    const parsed = JSON.parse(body) as unknown;
    const message = isRecord(parsed) ? parsed : null;
    if (!message) throw new Error("Invalid MCP request.");
    const method = stringValue(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: Record<string, unknown>;
    if (method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "honeycrisp", version: "0.1.0" },
      };
    } else if (method === "tools/list") {
      result = { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
    } else if (method === "tools/call") {
      const params = isRecord(message.params) ? message.params : {};
      const name = stringValue(params.name);
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown Honeycrisp MCP tool: ${name ?? "missing"}`);
      const executed = await tool.execute(isRecord(params.arguments) ? params.arguments : {}, signal);
      result = { content: executed.content, ...(executed.isError ? { isError: true } : {}) };
    } else {
      writeMcpResponse(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${method ?? "missing"}` } });
      return;
    }
    writeMcpResponse(response, { jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeMcpResponse(response, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function writeMcpResponse(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function resolveZCodeCliInvocation(args: readonly string[]): { command: string; args: string[]; cwd: string } | null {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    const bundle = localAppData ? join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs") : "";
    return bundle && existsSync(bundle) ? { command: process.execPath, args: [bundle, ...args], cwd: process.cwd() } : null;
  }
  const macBundle = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
  if (process.platform === "darwin" && existsSync(macBundle)) {
    return { command: process.execPath, args: [macBundle, ...args], cwd: process.cwd() };
  }
  return homedir() ? { command: "zcode", args: [...args], cwd: process.cwd() } : null;
}

function workspaceDescriptor(workspaceRoot: string): Record<string, unknown> {
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24);
  return { workspacePath: workspaceRoot, workspaceKey: `honeycrisp-${workspaceKey}` };
}

function zcodeToolAllowlist(tools: readonly ZCodeTool[]): string[] {
  return tools.flatMap((tool) => [tool.name, `mcp__honeycrisp__${tool.name}`]);
}

function zcodeSessionId(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  return stringValue(record?.sessionId) ?? stringValue(isRecord(record?.session) ? record.session.sessionId : null);
}

function findZCodeModel(snapshot: unknown, requestedModel: string): Record<string, unknown> | null {
  const root = isRecord(snapshot) ? snapshot : null;
  const settings = isRecord(root?.settings) ? root.settings : null;
  const model = isRecord(settings?.model) ? settings.model : null;
  const available = Array.isArray(model?.available) ? model.available : [];
  const normalized = requestedModel.toLowerCase();
  for (const candidate of available) {
    const entry = isRecord(candidate) ? candidate : null;
    const ref = isRecord(entry?.ref) ? entry.ref : null;
    const modelId = stringValue(ref?.modelId);
    const label = stringValue(entry?.label);
    if (modelId?.toLowerCase() === normalized || label?.toLowerCase() === normalized) return ref;
  }
  return null;
}

function zcodeThoughtLevel(reasoning: string | undefined): string | null {
  if (!reasoning) return null;
  if (reasoning === "off" || reasoning === "minimal") return "nothink";
  if (reasoning === "xhigh" || reasoning === "max") return "max";
  return "high";
}

function finalZCodeAssistantText(snapshot: unknown): string {
  const root = isRecord(snapshot) ? snapshot : null;
  const messages = Array.isArray(root?.messages) ? root.messages : [];
  for (const candidate of [...messages].reverse()) {
    const message = isRecord(candidate) ? candidate : null;
    const info = isRecord(message?.info) ? message.info : null;
    if (info?.role !== "assistant") continue;
    const text = (Array.isArray(message?.parts) ? message.parts : [])
      .flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])
      .join("");
    if (text.trim()) return text.trim();
  }
  return "";
}

function formatZCodePrompt(systemPrompt: string, input: ResearchAgentExecutionInput["modelInput"]): string {
  const context = input.contextSections.map((section) => `## ${section.label}\n${serializeContext(section.content)}`).join("\n\n");
  return [
    "Follow this Honeycrisp host contract for the entire turn:",
    systemPrompt,
    context ? `Research context:\n\n${context}` : "",
    `User research request:\n\n${input.prompt}`,
  ].filter(Boolean).join("\n\n");
}

function serializeContext(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function forwardZCodeSteering(
  client: ZCodeProtocolClient,
  sessionId: string,
  wait: (signal?: AbortSignal) => Promise<readonly string[]>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const messages = await wait(signal);
    for (const content of messages) {
      if (signal.aborted) return;
      await client.request("session/send", { sessionId, content: `User steering for the active research run:\n\n${content}` });
    }
  }
}

async function emitZCodeEvent(
  sink: ResearchLiveEventSink | undefined,
  event: Record<string, unknown> | null,
  model: string,
  identity?: { id: string; path: string; parentId: string },
): Promise<void> {
  if (!sink || !event || event.type !== "part.delta") return;
  const delta = recursiveString(event, ["delta", "text"]);
  if (!delta) return;
  const reasoning = recursiveString(event, ["field"]) === "reasoning";
  await sink({
    schemaVersion: 1,
    kind: reasoning ? "model.thought" : "model.output",
    timestamp: nowIso(),
    payload: {
      agentId: identity?.id ?? "root",
      agentPath: identity?.path ?? "/root",
      parentAgentId: identity?.parentId ?? "",
      phase: "delta",
      eventType: reasoning ? "thinking_delta" : "text_delta",
      provider: "zai",
      model,
      api: "official-zcode-app-server",
      delta,
    },
  });
}

async function emitCompletedZCodeText(
  sink: ResearchLiveEventSink | undefined,
  text: string,
  model: string,
  identity?: { id: string; path: string; parentId: string },
): Promise<void> {
  if (!sink) return;
  await sink({
    schemaVersion: 1,
    kind: "model.output",
    timestamp: nowIso(),
    payload: {
      agentId: identity?.id ?? "root",
      agentPath: identity?.path ?? "/root",
      parentAgentId: identity?.parentId ?? "",
      phase: "completed",
      eventType: "text_end",
      messagePhase: "final_answer",
      provider: "zai",
      model,
      api: "official-zcode-app-server",
      text,
    },
  });
}

async function emitResearchEvents(
  sink: ResearchLiveEventSink | undefined,
  events: readonly ResearchEvent[],
  identity?: { id: string; path: string; parentId: string },
): Promise<void> {
  if (!sink) return;
  for (const event of events) {
    await sink({
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

function hasTool(registry: ResearchToolRegistry | undefined, name: string): boolean {
  return Boolean(registry?.find(name));
}

function recursiveString(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  for (const child of Object.values(value)) {
    const found = recursiveString(child, keys);
    if (found) return found;
  }
  return null;
}

function zcodeEventError(event: Record<string, unknown>): string | null {
  return recursiveString(event, ["message", "error", "detail"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
