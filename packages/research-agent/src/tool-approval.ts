import { createHash } from "node:crypto";
import { createId } from "./ids.js";

export type ToolApprovalValue = "approved" | "denied";

export interface ToolApprovalRequest {
  actionId: string;
  serverName: string;
  toolName: string;
  description: string;
  arguments: Record<string, unknown>;
}

export interface PendingToolApprovalRequest extends ToolApprovalRequest {
  approvalRequestId: string;
  argumentsHash: string;
}

export interface ManualToolApprovalResult {
  decision: ToolApprovalValue;
  reason: string;
}

export interface ToolApprovalDecision extends PendingToolApprovalRequest {
  decision: ToolApprovalValue;
  source: "human" | "policy";
  reason: string;
}

export type ToolActionAuthorizer = (
  request: ToolApprovalRequest,
  signal?: AbortSignal,
) => Promise<ToolApprovalDecision>;

export interface CreateToolActionAuthorizerOptions {
  requestManualApproval(
    request: PendingToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ManualToolApprovalResult>;
  onRequested?(event: Record<string, unknown>): void | Promise<void>;
  onResolved?(event: Record<string, unknown>): void | Promise<void>;
}

export function createToolActionAuthorizer(
  options: CreateToolActionAuthorizerOptions,
): ToolActionAuthorizer {
  return async (request, signal) => {
    const approvalRequestId = createId("tool_approval");
    const auditArguments = sanitizeToolApprovalArguments(request.arguments);
    const serializedAuditArguments = JSON.stringify(auditArguments);
    const argumentsHash = createHash("sha256").update(serializedAuditArguments).digest("hex");
    const pending: PendingToolApprovalRequest = {
      actionId: bounded(request.actionId, 256),
      serverName: bounded(request.serverName, 256),
      toolName: bounded(request.toolName, 256),
      description: bounded(request.description, 1_000),
      arguments: auditArguments,
      approvalRequestId,
      argumentsHash,
    };

    if (serializedAuditArguments !== JSON.stringify(request.arguments)) {
      const decision: ToolApprovalDecision = {
        ...pending,
        decision: "denied",
        source: "policy",
        reason: "Tool arguments could not be represented exactly in the approval review.",
      };
      await options.onResolved?.({ type: "tool_authorization_resolved", ...decision });
      return decision;
    }

    let result: ManualToolApprovalResult;
    let source: ToolApprovalDecision["source"] = "human";
    try {
      const waiting = options.requestManualApproval(pending, signal);
      await options.onRequested?.({ type: "tool_authorization_requested", ...pending });
      result = await waiting;
    } catch (error) {
      source = "policy";
      result = {
        decision: "denied",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const decision: ToolApprovalDecision = {
      ...pending,
      decision: result.decision,
      source,
      reason: bounded(result.reason, 1_000),
    };
    await options.onResolved?.({ type: "tool_authorization_resolved", ...decision });
    return decision;
  };
}

export function sanitizeToolApprovalArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const projected = boundedJsonValue(value, 0);
  return isRecord(projected) ? projected : {};
}

function boundedJsonValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[depth limit]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length <= 16_384 ? value : value.slice(0, 16_384);
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => boundedJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return String(value).slice(0, 512);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 128)
      .map(([key, item]) => [bounded(key, 256), boundedJsonValue(item, depth + 1)]),
  );
}

function bounded(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
