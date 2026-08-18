import { createHash } from "node:crypto";
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
import type { ToolActionAuthorizer } from "./tool-approval.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_MCP_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MCP_CONTENT_ITEMS = 64;
const MAX_MCP_MODEL_IMAGES = 4;
const MAX_MCP_MODEL_TEXT_CHARS = 100_000;
const MAX_MCP_AUDIT_DEPTH = 12;
const MAX_MCP_AUDIT_COLLECTION_ITEMS = 256;
const MAX_MCP_AUDIT_STRING_CHARS = 1_000_000;
const SUPPORTED_MCP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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
  authorizeToolAction?: ToolActionAuthorizer;
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

  const [mcpTools, resources, templates] = await Promise.all([
    options.client.listTools(),
    options.client.listResources?.() ?? Promise.resolve([]),
    options.client.listResourceTemplates?.() ?? Promise.resolve([]),
  ]);
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

    executableTools.push(createMcpExecutableTool(
      applyBealeToolAnnotations(mcpTool),
      options.client,
      timeoutMs,
      options.authorizeToolAction,
    ));
  }

  if (options.client.readResource) {
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
  authorizeToolAction: ToolActionAuthorizer | undefined,
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
    requiredPermissions: [...new Set([
      `mcp:${mcpTool.serverName}:tool:${mcpTool.name}`,
      ...(mcpTool.requiredPermissions ?? []),
    ])],
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
        if (requiresToolApproval(mcpTool)) {
          if (!authorizeToolAction) {
            return createMcpBlockedResult(
              action,
              startedAt,
              "Computer-use action denied because the host approval channel is unavailable.",
            );
          }
          const approval = await authorizeToolAction({
            actionId: action.id,
            serverName: mcpTool.serverName,
            toolName: mcpTool.name,
            description: descriptor.description,
            arguments: action.input,
          }, context?.signal);
          if (approval.decision !== "approved") {
            return createMcpBlockedResult(action, startedAt, approval.reason);
          }
        }
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
          output: normalized.output,
          ...(normalized.modelContent?.length ? { modelContent: normalized.modelContent } : {}),
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
          output: normalized.output,
          ...(normalized.modelContent?.length ? { modelContent: normalized.modelContent } : {}),
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

function createMcpBlockedResult(
  action: ResearchToolAction,
  startedAt: string,
  reason: string,
): ResearchToolExecutionResult {
  return {
    action,
    status: "blocked",
    startedAt,
    completedAt: nowIso(),
    summary: reason,
    followUpActions: ["Report that the host denied the computer-use action before continuing."],
    error: { message: reason },
  };
}

function normalizeMcpOutput(input: {
  serverName: string;
  capabilityName: string;
  kind: "tool" | "resource";
  output: unknown;
}): { output: Record<string, unknown>; modelContent?: ResearchToolExecutionResult["modelContent"] } {
  const content = extractMcpModelContent(input.output);
  return {
    output: {
      provider: "mcp",
      serverName: input.serverName,
      capabilityName: input.capabilityName,
      kind: input.kind,
      untrusted: true,
      summary: `Untrusted MCP ${input.kind} output from ${input.serverName}/${input.capabilityName}.`,
      output: sanitizeMcpAuditOutput(input.output),
    },
    ...(content.length ? { modelContent: content } : {}),
  };
}

function extractMcpModelContent(output: unknown): NonNullable<ResearchToolExecutionResult["modelContent"]> {
  if (!isRecord(output) || !Array.isArray(output.content)) return [];
  const content: NonNullable<ResearchToolExecutionResult["modelContent"]> = [];
  let remainingTextChars = MAX_MCP_MODEL_TEXT_CHARS;
  let imageCount = 0;
  for (const item of output.content.slice(0, MAX_MCP_CONTENT_ITEMS)) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string" && remainingTextChars > 0) {
      const text = item.text.slice(0, remainingTextChars);
      remainingTextChars -= text.length;
      if (text) content.push({ type: "text", text });
      continue;
    }
    if (
      item.type === "image"
      && imageCount < MAX_MCP_MODEL_IMAGES
      && typeof item.data === "string"
      && typeof item.mimeType === "string"
      && SUPPORTED_MCP_IMAGE_TYPES.has(item.mimeType)
    ) {
      const bytes = decodeBoundedBase64(item.data);
      if (bytes) {
        imageCount += 1;
        content.push({ type: "image", data: item.data, mimeType: item.mimeType });
      }
    }
  }
  return content;
}

function sanitizeMcpAuditOutput(output: unknown, depth = 0): unknown {
  if (depth > MAX_MCP_AUDIT_DEPTH) return "[depth limit]";
  if (typeof output === "string") {
    return output.length <= MAX_MCP_AUDIT_STRING_CHARS
      ? output
      : `${output.slice(0, MAX_MCP_AUDIT_STRING_CHARS)}\n[truncated]`;
  }
  if (Array.isArray(output)) {
    return output
      .slice(0, MAX_MCP_AUDIT_COLLECTION_ITEMS)
      .map((item) => sanitizeMcpAuditOutput(item, depth + 1));
  }
  if (!isRecord(output)) return output;
  if (output.type === "image" && typeof output.data === "string") {
    const bytes = decodeBoundedBase64(output.data);
    return {
      type: "image",
      mimeType: typeof output.mimeType === "string" ? output.mimeType : "application/octet-stream",
      byteLength: bytes?.byteLength ?? null,
      sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
      dataOmitted: true,
    };
  }
  return Object.fromEntries(
    Object.entries(output)
      .slice(0, MAX_MCP_AUDIT_COLLECTION_ITEMS)
      .map(([key, value]) => [key, sanitizeMcpAuditOutput(value, depth + 1)]),
  );
}

function decodeBoundedBase64(value: string): Buffer | null {
  if (!value || value.length > Math.ceil(MAX_MCP_IMAGE_BYTES * 4 / 3) + 8) return null;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength <= MAX_MCP_IMAGE_BYTES && bytes.toString("base64") === value ? bytes : null;
}

function applyBealeToolAnnotations(tool: ResearchMcpToolDescription): ResearchMcpToolDescription {
  const annotation = isRecord(tool.annotations?.["beale.io/tool"])
    ? tool.annotations["beale.io/tool"]
    : undefined;
  if (!annotation) return tool;
  const actionClasses = Array.isArray(annotation.actionClasses)
    ? annotation.actionClasses.filter(isResearchActionClass)
    : [];
  const requiredPermissions = Array.isArray(annotation.requiredPermissions)
    ? annotation.requiredPermissions.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  return {
    ...tool,
    ...(actionClasses.length ? { actionClasses } : {}),
    ...(isResearchToolSideEffect(annotation.sideEffects)
      ? { sideEffects: conservativeAnnotatedSideEffect(tool, annotation.sideEffects) }
      : {}),
    ...(requiredPermissions.length ? { requiredPermissions } : {}),
  };
}

function conservativeAnnotatedSideEffect(
  tool: ResearchMcpToolDescription,
  annotated: ResearchToolSideEffect,
): ResearchToolSideEffect {
  const inferred = inferMcpSideEffects(tool);
  if (inferred === "none") return annotated;
  if (inferred === "read" && annotated !== "none") return annotated;
  return inferred;
}

function requiresToolApproval(tool: ResearchMcpToolDescription): boolean {
  const annotation = tool.annotations?.["beale.io/tool"];
  return isRecord(annotation) && annotation.confirmation === "always";
}

function isResearchActionClass(value: unknown): value is ResearchActionClass {
  return value === "recall" || value === "search" || value === "inspect" || value === "analyze"
    || value === "experiment" || value === "synthesize" || value === "ask_user"
    || value === "respond" || value === "stop";
}

function isResearchToolSideEffect(value: unknown): value is ResearchToolSideEffect {
  return value === "none" || value === "read" || value === "write" || value === "network" || value === "process";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (/write|edit|delete|create|mutate|click|type|press|key|scroll/i.test(text)) {
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
