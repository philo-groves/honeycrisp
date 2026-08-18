import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ResearchMcpClient,
  ResearchMcpResourceDescription,
  ResearchMcpResourceTemplateDescription,
  ResearchMcpToolDescription,
} from "./mcp-tools.js";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MCP_DIAGNOSTIC_CHARACTERS = 64_000;

export interface ResearchMcpServerConfig {
  name: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ResearchMcpClientConfig {
  servers: readonly ResearchMcpServerConfig[];
  allowedServers: readonly string[];
  timeoutMs?: number;
}

export interface ConfiguredResearchMcpClient extends ResearchMcpClient {
  close(): Promise<void>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export function loadResearchMcpClientConfig(
  configPath: string,
): ResearchMcpClientConfig {
  const absolutePath = resolve(configPath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`MCP config must be a JSON object: ${absolutePath}`);
  }

  const servers = parseMcpServers(parsed.servers, absolutePath);
  const allowedServers = readOptionalStringArray(parsed, "allowedServers");
  const timeoutMs = readOptionalPositiveNumber(parsed.timeoutMs, "timeoutMs");

  return {
    servers,
    allowedServers,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

export function createConfiguredResearchMcpClient(
  config: ResearchMcpClientConfig,
): ConfiguredResearchMcpClient {
  return new StdioResearchMcpClient(config);
}

class StdioResearchMcpClient implements ConfiguredResearchMcpClient {
  private readonly servers = new Map<string, StdioMcpServerConnection>();
  private readonly timeoutMs: number;

  constructor(config: ResearchMcpClientConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
    for (const server of config.servers) {
      if (this.servers.has(server.name)) {
        throw new Error(`Duplicate MCP server config: ${server.name}`);
      }
      this.servers.set(server.name, new StdioMcpServerConnection(server, this.timeoutMs));
    }
  }

  async listTools(): Promise<readonly ResearchMcpToolDescription[]> {
    const discovered = await Promise.all([...this.servers].map(async ([serverName, server]) => {
      const result = await server.request("tools/list", {});
      return readResultArray(result, "tools").flatMap((tool) => {
        if (!isRecord(tool) || typeof tool.name !== "string") return [];
        return [{
          serverName,
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(isRecord(tool.annotations) ? { annotations: tool.annotations } : {}),
        }];
      });
    }));
    return discovered.flat();
  }
  async callTool(input: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return this.requireServer(input.serverName).request(
      "tools/call",
      {
        name: input.toolName,
        arguments: input.arguments,
      },
      input.signal,
    );
  }

  async listResources(): Promise<readonly ResearchMcpResourceDescription[]> {
    const discovered = await Promise.all([...this.servers].map(async ([serverName, server]) => {
      const result = await server.requestOptional("resources/list", {});
      if (!result) return [];
      return readResultArray(result, "resources").flatMap((resource) => {
        if (!isRecord(resource) || typeof resource.uri !== "string") return [];
        return [{
          serverName,
          uri: resource.uri,
          ...(typeof resource.name === "string" ? { name: resource.name } : {}),
          ...(typeof resource.description === "string" ? { description: resource.description } : {}),
          ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
        }];
      });
    }));
    return discovered.flat();
  }
  async readResource(input: {
    serverName: string;
    uri: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    return this.requireServer(input.serverName).request(
      "resources/read",
      { uri: input.uri },
      input.signal,
    );
  }

  async listResourceTemplates(): Promise<readonly ResearchMcpResourceTemplateDescription[]> {
    const discovered = await Promise.all([...this.servers].map(async ([serverName, server]) => {
      const result = await server.requestOptional("resources/templates/list", {});
      if (!result) return [];
      return readResultArray(result, "resourceTemplates").flatMap((template) => {
        if (!isRecord(template) || typeof template.uriTemplate !== "string") return [];
        return [{
          serverName,
          uriTemplate: template.uriTemplate,
          ...(typeof template.name === "string" ? { name: template.name } : {}),
          ...(typeof template.description === "string" ? { description: template.description } : {}),
          ...(typeof template.mimeType === "string" ? { mimeType: template.mimeType } : {}),
        }];
      });
    }));
    return discovered.flat();
  }
  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => server.close()));
  }

  private requireServer(serverName: string): StdioMcpServerConnection {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server is not configured: ${serverName}`);
    }

    return server;
  }
}

class StdioMcpServerConnection {
  private readonly config: ResearchMcpServerConfig;
  private readonly timeoutMs: number;
  private nextId = 1;
  private process: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private initialized: Promise<void> | undefined;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(config: ResearchMcpServerConfig, timeoutMs: number) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.ensureInitialized();

    return this.sendRequest(method, params, signal);
  }

  async requestOptional(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown | undefined> {
    try {
      return await this.request(method, params, signal);
    } catch (error) {
      if (isMcpMethodUnavailable(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 500).unref();
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.startAndInitialize();
    }

    return this.initialized;
  }

  private async startAndInitialize(): Promise<void> {
    const child = spawn(this.config.command, [...this.config.args], {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.appendDiagnostic(chunk);
    });
    child.once("exit", (code, signal) => {
      const message = `MCP server ${this.config.name} exited with code ${code ?? "none"} signal ${signal ?? "none"}.`;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(message));
      }
      this.pending.clear();
    });

    await this.sendRequest("initialize", {
      protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "honeycrisp",
        version: "0.1.0",
      },
    });
    this.sendNotification("notifications/initialized", {});
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.process;
    if (!child) {
      throw new Error(`MCP server is not started: ${this.config.name}`);
    }
    if (signal?.aborted) {
      throw new Error(`MCP request aborted before send: ${method}`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} exceeded timeout ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error(`MCP request aborted: ${method}`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve(value) {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject(error) {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timeout,
      });
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const child = this.process;
    if (!child) {
      return;
    }

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      })}\n`,
      "utf8",
    );
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleMessage(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      // Stdio MCP servers must reserve stdout for JSON-RPC, but native
      // dependencies sometimes emit diagnostics there. Retain a bounded copy
      // and continue reading so one bad line cannot escape this stream handler
      // and terminate the entire research host.
      this.appendDiagnostic(`[stdout] ${line}\n`);
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    if (typeof message.method === "string" && typeof message.id === "number") {
      this.sendUnsupportedRequestResponse(message.id, message.method);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);

    if ("error" in response) {
      pending.reject(
        new Error(
          `MCP server ${this.config.name} error ${response.error.code}: ${response.error.message}`,
        ),
      );
      return;
    }

    pending.resolve(response.result);
  }

  private appendDiagnostic(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_MCP_DIAGNOSTIC_CHARACTERS);
  }

  private sendUnsupportedRequestResponse(id: number, method: string): void {
    const child = this.process;
    if (!child) {
      return;
    }

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Honeycrisp MCP client does not implement server request: ${method}`,
        },
      })}\n`,
      "utf8",
    );
  }
}

function parseMcpServers(
  value: unknown,
  configPath: string,
): readonly ResearchMcpServerConfig[] {
  if (Array.isArray(value)) {
    return value.map((server, index) =>
      normalizeServerConfig(server, configPath, String(index)),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, server]) =>
      normalizeServerConfig(
        isRecord(server) ? { name, ...server } : server,
        configPath,
        name,
      ),
    );
  }

  throw new Error(`MCP config requires a servers object or array: ${configPath}`);
}

function normalizeServerConfig(
  value: unknown,
  configPath: string,
  label: string,
): ResearchMcpServerConfig {
  if (!isRecord(value)) {
    throw new Error(`MCP server ${label} must be an object: ${configPath}`);
  }
  const name = readRequiredString(value, "name", `MCP server ${label}`);
  const command = readRequiredString(value, "command", `MCP server ${name}`);
  const args = readOptionalStringArray(value, "args");
  const cwd =
    typeof value.cwd === "string" && value.cwd.trim().length > 0
      ? resolve(value.cwd)
      : undefined;
  const env = readOptionalStringRecord(value.env, `MCP server ${name}.env`);

  return {
    name,
    command,
    args,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
  };
}

function readResultArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const item = value[key];

  return Array.isArray(item) ? item : [];
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }

  return item.trim();
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const item = value[key];
  if (item === undefined) {
    return [];
  }
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new Error(`MCP config ${key} must be a string array.`);
  }

  return item;
}

function readOptionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    output[key] = item;
  }

  return output;
}

function readOptionalPositiveNumber(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`MCP config ${label} must be a positive number.`);
  }

  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpMethodUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /error -32601|method not found|not implement/i.test(message);
}
