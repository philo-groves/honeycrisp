import { nowIso } from "./ids.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type {
  ResearchActionClass,
  ResearchToolAction,
  ResearchToolDescriptor,
  ResearchToolSideEffect,
} from "./types.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface ResearchMcpToolDescription {
  serverName: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  actionClasses?: readonly ResearchActionClass[];
  sideEffects?: ResearchToolSideEffect;
  requiredPermissions?: readonly string[];
  annotations?: Record<string, unknown>;
}

export interface ResearchMcpResourceDescription {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResearchMcpResourceTemplateDescription {
  serverName: string;
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResearchMcpClient {
  listTools(): Promise<readonly ResearchMcpToolDescription[]>;
  callTool(input: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
  listResources?(): Promise<readonly ResearchMcpResourceDescription[]>;
  readResource?(input: {
    serverName: string;
    uri: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  listResourceTemplates?(): Promise<
    readonly ResearchMcpResourceTemplateDescription[]
  >;
}

export interface CreateMcpResearchToolsOptions {
  client: ResearchMcpClient;
  allowedServers?: readonly string[];
  timeoutMs?: number;
}

export interface McpResearchToolDiscovery {
  tools: readonly ResearchExecutableTool[];
  descriptors: readonly ResearchToolDescriptor[];
  resourceTemplates: readonly ResearchMcpResourceTemplateDescription[];
  deniedCapabilities: readonly {
    serverName: string;
    name: string;
    kind: "tool" | "resource" | "resource_template";
    reason: string;
  }[];
}

type DeniedMcpCapability = McpResearchToolDiscovery["deniedCapabilities"][number];

export async function createMcpResearchTools(
  options: CreateMcpResearchToolsOptions,
): Promise<McpResearchToolDiscovery> {
  const allowedServers = new Set(options.allowedServers ?? []);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deniedCapabilities: DeniedMcpCapability[] = [];
  const executableTools: ResearchExecutableTool[] = [];
  const resourceTemplates: ResearchMcpResourceTemplateDescription[] = [];

  const mcpTools = await options.client.listTools();
  for (const mcpTool of mcpTools) {
    if (!allowedServers.has(mcpTool.serverName)) {
      deniedCapabilities.push({
        serverName: mcpTool.serverName,
        name: mcpTool.name,
        kind: "tool",
        reason: `MCP server ${mcpTool.serverName} is not allowlisted.`,
      });
      continue;
    }

    executableTools.push(createMcpExecutableTool(mcpTool, options.client, timeoutMs));
  }

  if (options.client.listResources && options.client.readResource) {
    const resources = await options.client.listResources();
    for (const resource of resources) {
      if (!allowedServers.has(resource.serverName)) {
        deniedCapabilities.push({
          serverName: resource.serverName,
          name: resource.uri,
          kind: "resource",
          reason: `MCP server ${resource.serverName} is not allowlisted.`,
        });
        continue;
      }

      executableTools.push(
        createMcpResourceReadTool(resource, options.client, timeoutMs),
      );
    }
  }

  if (options.client.listResourceTemplates) {
    const templates = await options.client.listResourceTemplates();
    for (const template of templates) {
      if (!allowedServers.has(template.serverName)) {
        deniedCapabilities.push({
          serverName: template.serverName,
          name: template.uriTemplate,
          kind: "resource_template",
          reason: `MCP server ${template.serverName} is not allowlisted.`,
        });
        continue;
      }

      resourceTemplates.push(template);
    }
  }

  return {
    tools: executableTools,
    descriptors: executableTools.map((tool) => tool.descriptor),
    resourceTemplates,
    deniedCapabilities,
  };
}

function createMcpExecutableTool(
  mcpTool: ResearchMcpToolDescription,
  client: ResearchMcpClient,
  timeoutMs: number,
): ResearchExecutableTool {
  const descriptor: ResearchToolDescriptor = {
    name: createMcpToolName(mcpTool.serverName, mcpTool.name),
    transportName: createMcpTransportName(mcpTool.serverName, mcpTool.name),
    description:
      mcpTool.description ??
      `Untrusted MCP tool ${mcpTool.name} from server ${mcpTool.serverName}.`,
    actionClasses:
      mcpTool.actionClasses ?? inferMcpActionClasses(mcpTool.name, mcpTool.description),
    sideEffects: mcpTool.sideEffects ?? inferMcpSideEffects(mcpTool),
    requiredPermissions: mcpTool.requiredPermissions ?? [
      `mcp:${mcpTool.serverName}:tool:${mcpTool.name}`,
    ],
    ...(mcpTool.inputSchema ? { inputSchema: mcpTool.inputSchema } : {}),
    ...(mcpTool.outputSchema
      ? { outputSchema: createWrappedMcpOutputSchema(mcpTool.outputSchema) }
      : {}),
    estimatedCost: "external MCP provider",
    metadata: {
      provider: "mcp",
      mcpKind: "tool",
      serverName: mcpTool.serverName,
      toolName: mcpTool.name,
      annotations: mcpTool.annotations ?? {},
      untrustedOutput: true,
    },
  };

  return {
    descriptor,
    ...(mcpTool.inputSchema
      ? {
          parameters:
            mcpTool.inputSchema as NonNullable<ResearchExecutableTool["parameters"]>,
        }
      : {}),
    async execute(action, context) {
      const startedAt = nowIso();
      try {
        const output = await withMcpTimeout(
          client.callTool({
            serverName: mcpTool.serverName,
            toolName: mcpTool.name,
            arguments: action.input,
            ...(context?.signal ? { signal: context.signal } : {}),
          }),
          timeoutMs,
          descriptor.name,
        );
        const normalized = normalizeMcpOutput({
          serverName: mcpTool.serverName,
          capabilityName: mcpTool.name,
          kind: "tool",
          output,
        });

        return {
          action,
          status: "complete",
          startedAt,
          completedAt: nowIso(),
          summary: `MCP tool ${mcpTool.serverName}/${mcpTool.name} returned untrusted output.`,
          output: normalized,
          evidence: [normalized.summary],
          claims: [],
          followUpActions: [],
        };
      } catch (error) {
        return createMcpErrorResult(action, startedAt, error);
      }
    },
  };
}

function createMcpResourceReadTool(
  resource: ResearchMcpResourceDescription,
  client: ResearchMcpClient,
  timeoutMs: number,
): ResearchExecutableTool {
  const inputSchema = {
    type: "object",
    required: ["uri"],
    properties: {
      uri: {
        type: "string",
        const: resource.uri,
      },
    },
  };
  const descriptor: ResearchToolDescriptor = {
    name: createMcpResourceToolName(resource.serverName, resource.uri),
    transportName: createMcpTransportName(resource.serverName, resource.uri),
    description:
      resource.description ??
      `Read untrusted MCP resource ${resource.uri} from server ${resource.serverName}.`,
    actionClasses: ["inspect"],
    sideEffects: "read",
    requiredPermissions: [
      `mcp:${resource.serverName}:resource:${resource.uri}`,
    ],
    inputSchema,
    estimatedCost: "external MCP provider",
    metadata: {
      provider: "mcp",
      mcpKind: "resource",
      serverName: resource.serverName,
      resourceUri: resource.uri,
      resourceName: resource.name,
      mimeType: resource.mimeType,
      untrustedOutput: true,
    },
  };

  return {
    descriptor,
    parameters: inputSchema as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action, context) {
      const startedAt = nowIso();
      try {
        const output = await withMcpTimeout(
          client.readResource!({
            serverName: resource.serverName,
            uri: resource.uri,
            ...(context?.signal ? { signal: context.signal } : {}),
          }),
          timeoutMs,
          descriptor.name,
        );
        const normalized = normalizeMcpOutput({
          serverName: resource.serverName,
          capabilityName: resource.uri,
          kind: "resource",
          output,
        });

        return {
          action,
          status: "complete",
          startedAt,
          completedAt: nowIso(),
          summary: `MCP resource ${resource.serverName}/${resource.uri} returned untrusted content.`,
          output: normalized,
          evidence: [normalized.summary],
          claims: [],
          followUpActions: [],
        };
      } catch (error) {
        return createMcpErrorResult(action, startedAt, error);
      }
    },
  };
}

function createMcpErrorResult(
  action: ResearchToolAction,
  startedAt: string,
  error: unknown,
): ResearchToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);

  return {
    action,
    status: "error",
    startedAt,
    completedAt: nowIso(),
    summary: `MCP execution failed: ${message}`,
    followUpActions: ["Report the MCP tool failure before continuing."],
    error: {
      message,
    },
  };
}

function normalizeMcpOutput(input: {
  serverName: string;
  capabilityName: string;
  kind: "tool" | "resource";
  output: unknown;
}) {
  return {
    provider: "mcp",
    serverName: input.serverName,
    capabilityName: input.capabilityName,
    kind: input.kind,
    untrusted: true,
    summary: `Untrusted MCP ${input.kind} output from ${input.serverName}/${input.capabilityName}.`,
    output: input.output,
  };
}

function createWrappedMcpOutputSchema(outputSchema: unknown): Record<string, unknown> {
  return {
    type: "object",
    required: ["provider", "serverName", "capabilityName", "kind", "untrusted", "summary", "output"],
    properties: {
      provider: {
        type: "string",
        const: "mcp",
      },
      serverName: {
        type: "string",
      },
      capabilityName: {
        type: "string",
      },
      kind: {
        anyOf: [
          {
            type: "string",
            const: "tool",
          },
          {
            type: "string",
            const: "resource",
          },
        ],
      },
      untrusted: {
        type: "boolean",
        const: true,
      },
      summary: {
        type: "string",
      },
      output: outputSchema,
    },
  };
}

async function withMcpTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  capabilityName: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `MCP capability ${capabilityName} exceeded timeout ${timeoutMs}ms.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function inferMcpActionClasses(
  name: string,
  description: string | undefined,
): readonly ResearchActionClass[] {
  const text = `${name} ${description ?? ""}`;
  if (/read|resource|inspect|file|fetch/i.test(text)) {
    return ["inspect"];
  }
  if (/search|query|find/i.test(text)) {
    return ["search"];
  }
  if (/test|run|execute|probe|fuzz|experiment/i.test(text)) {
    return ["experiment"];
  }
  if (/summarize|write|report|synth/i.test(text)) {
    return ["synthesize"];
  }
  if (/analy[sz]e|metric|graph|diff/i.test(text)) {
    return ["analyze"];
  }

  return ["analyze"];
}

function inferMcpSideEffects(
  tool: ResearchMcpToolDescription,
): ResearchToolSideEffect {
  const text = `${tool.name} ${tool.description ?? ""}`;
  if (/write|edit|delete|create|mutate/i.test(text)) {
    return "write";
  }
  if (/network|fetch|http|url|web/i.test(text)) {
    return "network";
  }
  if (/process|shell|execute|run/i.test(text)) {
    return "process";
  }
  if (/read|inspect|list|search|query|find/i.test(text)) {
    return "read";
  }

  return "none";
}

function createMcpToolName(serverName: string, toolName: string): string {
  return `mcp.${serverName}.${toolName}`;
}

function createMcpResourceToolName(serverName: string, uri: string): string {
  return `mcp.${serverName}.resource.${stableSafeName(uri)}`;
}

function createMcpTransportName(serverName: string, name: string): string {
  return `mcp_${stableSafeName(serverName)}_${stableSafeName(name)}`;
}

function stableSafeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "capability";
}
