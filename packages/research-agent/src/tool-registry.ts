import type {
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { createResearchEventId, nowIso } from "./ids.js";
import type {
  ResearchActionClass,
  ResearchArtifactRef,
  ResearchEvent,
  ResearchToolAction,
  ResearchToolDescriptor,
} from "./types.js";

export type ResearchToolExecutionStatus = "complete" | "error" | "blocked";

export interface ResearchToolExecutionContext {
  goalId?: string;
  subGoalId?: string;
  signal?: AbortSignal;
}

export interface ResearchToolExecutionResult {
  action: ResearchToolAction;
  status: ResearchToolExecutionStatus;
  startedAt: string;
  completedAt: string;
  summary: string;
  output?: unknown;
  rawOutputRef?: string;
  artifactRefs?: readonly ResearchArtifactRef[];
  evidence?: readonly unknown[];
  claims?: readonly unknown[];
  followUpActions: readonly string[];
  error?: {
    message: string;
  };
}

export interface ResearchExecutableTool {
  descriptor: ResearchToolDescriptor;
  parameters?: Tool["parameters"];
  execute(
    action: ResearchToolAction,
    context?: ResearchToolExecutionContext,
  ): Promise<ResearchToolExecutionResult>;
}

export interface ResearchToolExecutionRecord {
  action: ResearchToolAction;
  result: ResearchToolExecutionResult;
  events: readonly ResearchEvent[];
}

export interface ExecuteToolCallOptions extends ResearchToolExecutionContext {
  permittedActionClasses?: readonly ResearchActionClass[];
  defaultActionClass?: ResearchActionClass;
  toolCallId?: string;
}

export class ResearchToolRegistry {
  readonly #toolsByName = new Map<string, ResearchExecutableTool>();
  readonly #toolsByTransportName = new Map<string, ResearchExecutableTool>();

  constructor(tools: readonly ResearchExecutableTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: ResearchExecutableTool): void {
    this.#toolsByName.set(tool.descriptor.name, tool);
    this.#toolsByTransportName.set(getToolTransportName(tool), tool);
  }

  listDescriptors(): ResearchToolDescriptor[] {
    return [...this.#toolsByName.values()].map((tool) => tool.descriptor);
  }

  toPiTools(): Tool[] {
    return [...this.#toolsByName.values()]
      .filter((tool) => tool.parameters)
      .map((tool) => ({
        name: getToolTransportName(tool),
        description: tool.descriptor.description,
        parameters: tool.parameters!,
      }));
  }

  get size(): number {
    return this.#toolsByName.size;
  }

  find(name: string): ResearchExecutableTool | undefined {
    return this.#toolsByName.get(name) ?? this.#toolsByTransportName.get(name);
  }

  async execute(
    action: ResearchToolAction,
    options: ExecuteToolCallOptions = {},
  ): Promise<ResearchToolExecutionRecord> {
    const tool = this.find(action.toolName);
    if (!tool) {
      const result = createBlockedToolResult(
        action,
        `Unknown tool: ${action.toolName}`,
      );
      return createExecutionRecord(result, options);
    }

    const validationError = validateToolAction(tool, action, options);
    if (validationError) {
      const result = createBlockedToolResult(action, validationError);
      return createExecutionRecord(result, options);
    }

    const result = await tool.execute(
      {
        ...action,
        toolName: tool.descriptor.name,
      },
      options,
    );
    return createExecutionRecord(result, options);
  }

  async executeToolCall(
    toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
    options: ExecuteToolCallOptions = {},
  ): Promise<ResearchToolExecutionRecord> {
    const tool = this.find(toolCall.name);
    const action = createToolActionFromCall(toolCall, tool, options);
    return this.execute(action, {
      ...options,
      toolCallId: toolCall.id,
    });
  }
}

export function createResearchToolRegistry(
  tools: readonly ResearchExecutableTool[] = [],
): ResearchToolRegistry {
  return new ResearchToolRegistry(tools);
}

export function createToolRequestedEvent(
  action: ResearchToolAction,
  options: ResearchToolExecutionContext = {},
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "tool.requested",
    timestamp: nowIso(),
    ...(options.goalId ? { goalId: options.goalId } : {}),
    ...(options.subGoalId ? { subGoalId: options.subGoalId } : {}),
    payload: {
      toolActionId: action.id,
      toolName: action.toolName,
      actionClass: action.actionClass,
      subGoalId: options.subGoalId,
      normalizedInputs: action.input,
      expectedOutputs: action.expectedOutputs ?? [],
      budgetLimits: action.budget ?? {},
      memoryWritebackTarget: action.memoryWritebackTargets ?? [],
      summary: `Requested ${action.toolName} for ${action.actionClass}.`,
    },
  };
}

export function createToolObservedEvent(
  result: ResearchToolExecutionResult,
  options: ResearchToolExecutionContext = {},
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "tool.observed",
    timestamp: nowIso(),
    ...(options.goalId ? { goalId: options.goalId } : {}),
    ...(options.subGoalId ? { subGoalId: options.subGoalId } : {}),
    payload: {
      toolActionId: result.action.id,
      toolName: result.action.toolName,
      actionClass: result.action.actionClass,
      subGoalId: options.subGoalId,
      normalizedInputs: result.action.input,
      rawOutputRef: result.rawOutputRef,
      generatedArtifactRefs: result.artifactRefs ?? [],
      status: result.status,
      error: result.error,
      evidenceExtracted: result.evidence ?? [],
      claimsProposed: result.claims ?? [],
      followUpActionsProposed: result.followUpActions,
      summary: result.summary,
      result: result.output,
    },
  };
}

export function createToolResultMessage(
  result: ResearchToolExecutionResult,
  toolCallId: string,
  toolName: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    isError: result.status !== "complete",
    timestamp: Date.now(),
    details: result,
    content: [
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
    ],
  };
}

export function getToolTransportName(tool: ResearchExecutableTool): string {
  return tool.descriptor.transportName ?? tool.descriptor.name;
}

function createToolActionFromCall(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
  tool: ResearchExecutableTool | undefined,
  options: ExecuteToolCallOptions,
): ResearchToolAction {
  const input = isRecord(toolCall.arguments) ? toolCall.arguments : {};
  const requestedClass =
    typeof input.actionClass === "string" ? input.actionClass : input.action;
  const actionClass = normalizeActionClass(
    requestedClass,
    tool,
    options.defaultActionClass,
    options.permittedActionClasses,
  );

  return {
    id: toolCall.id,
    actionClass,
    toolName: tool?.descriptor.name ?? toolCall.name,
    input,
    ...(tool?.descriptor.memoryWritebackDefaults
      ? { memoryWritebackTargets: tool.descriptor.memoryWritebackDefaults }
      : {}),
  };
}

function normalizeActionClass(
  value: unknown,
  tool: ResearchExecutableTool | undefined,
  defaultActionClass: ResearchActionClass | undefined,
  permittedActionClasses: readonly ResearchActionClass[] | undefined,
): ResearchActionClass {
  if (isResearchActionClass(value)) {
    return value;
  }

  const firstPermitted = tool?.descriptor.actionClasses.find(
    (actionClass) =>
      !permittedActionClasses || permittedActionClasses.includes(actionClass),
  );
  return firstPermitted ?? defaultActionClass ?? tool?.descriptor.actionClasses[0] ?? "synthesize";
}

function validateToolAction(
  tool: ResearchExecutableTool,
  action: ResearchToolAction,
  options: ExecuteToolCallOptions,
): string | undefined {
  if (!tool.descriptor.actionClasses.includes(action.actionClass)) {
    return `${tool.descriptor.name} does not support action class ${action.actionClass}.`;
  }

  if (
    options.permittedActionClasses &&
    !options.permittedActionClasses.includes(action.actionClass)
  ) {
    return `Action class ${action.actionClass} is not permitted for this loop.`;
  }

  return undefined;
}

function createBlockedToolResult(
  action: ResearchToolAction,
  reason: string,
): ResearchToolExecutionResult {
  const timestamp = nowIso();
  return {
    action,
    status: "blocked",
    startedAt: timestamp,
    completedAt: timestamp,
    summary: reason,
    followUpActions: ["Report the blocked tool action before continuing."],
    error: {
      message: reason,
    },
  };
}

function createExecutionRecord(
  result: ResearchToolExecutionResult,
  options: ResearchToolExecutionContext,
): ResearchToolExecutionRecord {
  return {
    action: result.action,
    result,
    events: [
      createToolRequestedEvent(result.action, options),
      createToolObservedEvent(result, options),
    ],
  };
}

function isResearchActionClass(value: unknown): value is ResearchActionClass {
  return (
    value === "recall" ||
    value === "search" ||
    value === "inspect" ||
    value === "analyze" ||
    value === "experiment" ||
    value === "synthesize" ||
    value === "ask_user" ||
    value === "respond" ||
    value === "stop"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
