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
  ResearchGovernancePolicy,
  ResearchToolAction,
  ResearchToolDescriptor,
  ResearchToolSideEffect,
} from "./types.js";

export type ResearchToolExecutionStatus = "complete" | "error" | "blocked";

export interface ResearchToolExecutionContext {
  signal?: AbortSignal;
}

export interface ResearchToolValidationHookInput {
  phase: "before" | "after";
  tool: ResearchExecutableTool;
  action: ResearchToolAction;
  context: ExecuteToolCallOptions;
  result?: ResearchToolExecutionResult;
}

export type ResearchToolValidationHook = (
  input: ResearchToolValidationHookInput,
) => string | void | Promise<string | void>;

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
  governance?: ResearchGovernancePolicy;
  toolCallCount?: number;
  excludedPaths?: readonly string[];
}

export interface ResearchToolRegistryOptions {
  validationHooks?: ReadonlyMap<string, ResearchToolValidationHook> | Record<string, ResearchToolValidationHook>;
}

export class ResearchToolRegistry {
  readonly #toolsByName = new Map<string, ResearchExecutableTool>();
  readonly #toolsByTransportName = new Map<string, ResearchExecutableTool>();
  readonly #validationHooks = new Map<string, ResearchToolValidationHook>();

  constructor(
    tools: readonly ResearchExecutableTool[] = [],
    options: ResearchToolRegistryOptions = {},
  ) {
    for (const [name, hook] of readValidationHookEntries(options.validationHooks)) {
      this.#validationHooks.set(name, hook);
    }
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

  listTools(): ResearchExecutableTool[] {
    return [...this.#toolsByName.values()];
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

    const normalizedAction = applyBudgetDefaults(action, options.governance);
    const validationError = validateToolAction(tool, normalizedAction, options);
    if (validationError) {
      const result = createBlockedToolResult(normalizedAction, validationError);
      return createExecutionRecord(result, options);
    }

    const beforeHookError = await runValidationHooks(
      tool,
      normalizedAction,
      options,
      this.#validationHooks,
      "before",
    );
    if (beforeHookError) {
      const result = createBlockedToolResult(normalizedAction, beforeHookError);
      return createExecutionRecord(result, options);
    }

    const result = await executeWithRuntimeBudget(
      () => tool.execute(
      {
        ...normalizedAction,
        toolName: tool.descriptor.name,
      },
      options,
      ),
      getRuntimeBudgetMs(normalizedAction, options.governance),
      normalizedAction,
    );
    const outputValidationError = validateToolOutput(tool, result);
    if (outputValidationError) {
      const blocked = createBlockedToolResult(
        result.action,
        outputValidationError,
      );
      return createExecutionRecord(blocked, options);
    }

    const afterHookError = await runValidationHooks(
      tool,
      result.action,
      options,
      this.#validationHooks,
      "after",
      result,
    );
    if (afterHookError) {
      const blocked = createBlockedToolResult(result.action, afterHookError);
      return createExecutionRecord(blocked, options);
    }

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

  preflight(
    action: ResearchToolAction,
    options: ExecuteToolCallOptions = {},
  ): ResearchToolExecutionRecord | undefined {
    const tool = this.find(action.toolName);
    if (!tool) {
      return createExecutionRecord(
        createBlockedToolResult(action, `Unknown tool: ${action.toolName}`),
        options,
      );
    }

    const normalizedAction = applyBudgetDefaults(action, options.governance);
    const validationError = validateToolAction(tool, normalizedAction, options);
    return validationError
      ? createExecutionRecord(
          createBlockedToolResult(normalizedAction, validationError),
          options,
        )
      : undefined;
  }

  preflightToolCall(
    toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
    options: ExecuteToolCallOptions = {},
  ): ResearchToolExecutionRecord | undefined {
    const tool = this.find(toolCall.name);
    const action = createToolActionFromCall(toolCall, tool, options);
    return this.preflight(action, {
      ...options,
      toolCallId: toolCall.id,
    });
  }
}

export function createResearchToolRegistry(
  tools: readonly ResearchExecutableTool[] = [],
  options: ResearchToolRegistryOptions = {},
): ResearchToolRegistry {
  return new ResearchToolRegistry(tools, options);
}

export function createToolRequestedEvent(
  action: ResearchToolAction,
  options: ResearchToolExecutionContext = {},
): ResearchEvent {
  return {
    id: createResearchEventId(),
    kind: "tool.requested",
    timestamp: nowIso(),
    payload: {
      toolActionId: action.id,
      toolName: action.toolName,
      actionClass: action.actionClass,
      normalizedInputs: action.input,
      expectedOutputs: action.expectedOutputs ?? [],
      budgetLimits: action.budget ?? {},
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
    ...(result.artifactRefs?.length ? { artifactRefs: result.artifactRefs } : {}),
    payload: {
      toolActionId: result.action.id,
      toolName: result.action.toolName,
      actionClass: result.action.actionClass,
      normalizedInputs: result.action.input,
      generatedArtifactRefs: result.artifactRefs ?? [],
      status: result.status,
      evidenceExtracted: result.evidence ?? [],
      claimsProposed: result.claims ?? [],
      followUpActionsProposed: result.followUpActions,
      summary: result.summary,
      ...(result.rawOutputRef ? { rawOutputRef: result.rawOutputRef } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.output !== undefined ? { result: result.output } : {}),
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

  if (options.governance?.deniedActionClasses?.includes(action.actionClass)) {
    return `Action class ${action.actionClass} is denied by governance policy.`;
  }

  if (
    options.governance?.allowedActionClasses &&
    !options.governance.allowedActionClasses.includes(action.actionClass)
  ) {
    return `Action class ${action.actionClass} is not allowed by governance policy.`;
  }

  const sideEffectError = validateSideEffects(
    tool.descriptor.sideEffects,
    options.governance,
  );
  if (sideEffectError) {
    return sideEffectError;
  }

  const permissionError = validatePermissions(
    tool.descriptor.requiredPermissions,
    options.governance,
  );
  if (permissionError) {
    return permissionError;
  }

  const callBudgetError = validateToolCallBudget(options);
  if (callBudgetError) {
    return callBudgetError;
  }

  const fileBudgetError = validateFileBudgets(action, options.governance);
  if (fileBudgetError) {
    return fileBudgetError;
  }

  const excludedPathError = validateExcludedPaths(action, options.excludedPaths);
  if (excludedPathError) {
    return excludedPathError;
  }

  const schemaErrors = validateJsonSchema(action.input, tool.descriptor.inputSchema);
  if (schemaErrors.length > 0) {
    return `Tool input failed schema validation: ${schemaErrors.join("; ")}`;
  }

  return undefined;
}

function validateToolOutput(
  tool: ResearchExecutableTool,
  result: ResearchToolExecutionResult,
): string | undefined {
  if (!tool.descriptor.outputSchema || result.status !== "complete") {
    return undefined;
  }

  const schemaErrors = validateJsonSchema(result.output, tool.descriptor.outputSchema);
  if (schemaErrors.length > 0) {
    return `Tool output failed schema validation: ${schemaErrors.join("; ")}`;
  }

  return undefined;
}

function validateSideEffects(
  sideEffect: ResearchToolSideEffect,
  governance: ResearchGovernancePolicy | undefined,
): string | undefined {
  if (governance?.deniedSideEffects?.includes(sideEffect)) {
    return `Tool side effect ${sideEffect} is denied by governance policy.`;
  }

  if (
    governance?.allowedSideEffects &&
    !governance.allowedSideEffects.includes(sideEffect)
  ) {
    return `Tool side effect ${sideEffect} is not allowed by governance policy.`;
  }

  return undefined;
}

function validatePermissions(
  requiredPermissions: readonly string[],
  governance: ResearchGovernancePolicy | undefined,
): string | undefined {
  const deniedPermission = requiredPermissions.find((permission) =>
    governance?.deniedPermissions?.includes(permission),
  );
  if (deniedPermission) {
    return `Tool permission ${deniedPermission} is denied by governance policy.`;
  }

  const missingAllowedPermission = requiredPermissions.find(
    (permission) =>
      governance?.allowedPermissions &&
      !governance.allowedPermissions.includes(permission),
  );
  if (missingAllowedPermission) {
    return `Tool permission ${missingAllowedPermission} is not allowed by governance policy.`;
  }

  return undefined;
}

function validateToolCallBudget(
  options: ExecuteToolCallOptions,
): string | undefined {
  const maxToolCalls = options.governance?.maxToolCalls;
  if (
    typeof maxToolCalls === "number" &&
    typeof options.toolCallCount === "number" &&
    options.toolCallCount >= maxToolCalls
  ) {
    return `Tool call budget exhausted: ${options.toolCallCount}/${maxToolCalls} call(s) already used.`;
  }

  return undefined;
}

function validateFileBudgets(
  action: ResearchToolAction,
  governance: ResearchGovernancePolicy | undefined,
): string | undefined {
  if (!governance) {
    return undefined;
  }

  const hasPathInput = typeof action.input.path === "string";
  if (
    hasPathInput &&
    typeof governance.maxFiles === "number" &&
    governance.maxFiles < 1
  ) {
    return `File budget exhausted: action requires 1 file but maxFiles is ${governance.maxFiles}.`;
  }

  const requestedBytes = readNumericInput(action.input, "maxBytes");
  if (
    typeof requestedBytes === "number" &&
    typeof governance.maxBytes === "number" &&
    requestedBytes > governance.maxBytes
  ) {
    return `Byte budget exceeded: requested ${requestedBytes} byte(s), maxBytes is ${governance.maxBytes}.`;
  }

  const requestedTokens = readNumericInput(action.input, "maxTokens");
  if (
    typeof requestedTokens === "number" &&
    typeof governance.maxTokens === "number" &&
    requestedTokens > governance.maxTokens
  ) {
    return `Token budget exceeded: requested ${requestedTokens} token(s), maxTokens is ${governance.maxTokens}.`;
  }

  return undefined;
}

function validateExcludedPaths(
  action: ResearchToolAction,
  excludedPaths: readonly string[] | undefined,
): string | undefined {
  if (!excludedPaths || excludedPaths.length === 0) {
    return undefined;
  }
  if (typeof action.input.path !== "string") {
    return undefined;
  }

  const requestedPath = normalizeComparablePath(action.input.path);
  const excludedPath = excludedPaths.find((path) =>
    pathsMatch(requestedPath, normalizeComparablePath(path)),
  );
  if (!excludedPath) {
    return undefined;
  }

  return `Path ${action.input.path} is listed in avoid_repeated_targets for this fresh loop; choose a different source path unless the user explicitly asks to revisit it.`;
}

function pathsMatch(left: string, right: string): boolean {
  return (
    left === right ||
    left.endsWith(`/${right}`) ||
    right.endsWith(`/${left}`)
  );
}

function normalizeComparablePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
}

function applyBudgetDefaults(
  action: ResearchToolAction,
  governance: ResearchGovernancePolicy | undefined,
): ResearchToolAction {
  if (
    !governance ||
    typeof governance.maxBytes !== "number" ||
    typeof action.input.path !== "string" ||
    typeof action.input.maxBytes === "number"
  ) {
    return action;
  }

  return {
    ...action,
    input: {
      ...action.input,
      maxBytes: governance.maxBytes,
    },
  };
}

function getRuntimeBudgetMs(
  action: ResearchToolAction,
  governance: ResearchGovernancePolicy | undefined,
): number | undefined {
  return action.budget?.maxRuntimeMs ?? governance?.maxRuntimeMs;
}

async function executeWithRuntimeBudget(
  execute: () => Promise<ResearchToolExecutionResult>,
  timeoutMs: number | undefined,
  action: ResearchToolAction,
): Promise<ResearchToolExecutionResult> {
  if (!timeoutMs || timeoutMs <= 0) {
    return execute();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<ResearchToolExecutionResult>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve(
              createBlockedToolResult(
                action,
                `Tool runtime budget exceeded after ${timeoutMs}ms.`,
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

async function runValidationHooks(
  tool: ResearchExecutableTool,
  action: ResearchToolAction,
  options: ExecuteToolCallOptions,
  hooks: ReadonlyMap<string, ResearchToolValidationHook>,
  phase: "before" | "after",
  result?: ResearchToolExecutionResult,
): Promise<string | undefined> {
  for (const hookName of tool.descriptor.validationHooks ?? []) {
    const hook = hooks.get(hookName);
    if (!hook) {
      return `Validation hook ${hookName} is not registered.`;
    }

    const message = await hook({
      phase,
      tool,
      action,
      context: options,
      ...(result ? { result } : {}),
    });
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return undefined;
}

function readValidationHookEntries(
  hooks: ResearchToolRegistryOptions["validationHooks"],
): [string, ResearchToolValidationHook][] {
  if (!hooks) {
    return [];
  }

  if (hooks instanceof Map) {
    return [...hooks.entries()];
  }

  return Object.entries(hooks);
}

function validateJsonSchema(value: unknown, schema: unknown): string[] {
  if (!schema || !isRecord(schema)) {
    return [];
  }

  return validateJsonSchemaAt(value, schema, "$");
}

function validateJsonSchemaAt(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  const errors: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((branch) =>
      isRecord(branch) ? validateJsonSchemaAt(value, branch, path) : [`${path} has invalid schema branch`],
    );
    if (branchErrors.some((branch) => branch.length === 0)) {
      return [];
    }

    return [
      `${path} did not match any allowed schema (${branchErrors
        .map((branch) => branch.join(", "))
        .join(" | ")})`,
    ];
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }

  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type) {
    const typeError = validateJsonSchemaType(value, type, path);
    if (typeError) {
      errors.push(typeError);
      return errors;
    }
  }

  if (type === "object" && isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    if (isRecord(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in value && isRecord(propertySchema)) {
          errors.push(
            ...validateJsonSchemaAt(value[key], propertySchema, `${path}.${key}`),
          );
        }
      }
    }
  }

  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchemaAt(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    });
  }

  return errors;
}

function validateJsonSchemaType(
  value: unknown,
  type: string,
  path: string,
): string | undefined {
  if (type === "string" && typeof value !== "string") {
    return `${path} must be a string`;
  }
  if (type === "number" && typeof value !== "number") {
    return `${path} must be a number`;
  }
  if (type === "integer" && !Number.isInteger(value)) {
    return `${path} must be an integer`;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    return `${path} must be a boolean`;
  }
  if (type === "object" && !isRecord(value)) {
    return `${path} must be an object`;
  }
  if (type === "array" && !Array.isArray(value)) {
    return `${path} must be an array`;
  }
  if (type === "null" && value !== null) {
    return `${path} must be null`;
  }

  return undefined;
}

function readNumericInput(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
