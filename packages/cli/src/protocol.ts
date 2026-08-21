import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HONEYCRISP_PROTOCOL_NAME = "honeycrisp" as const;
export const HONEYCRISP_PROTOCOL_VERSION = 1 as const;
export const HONEYCRISP_CONTRACT_VERSION = 3 as const;
export const HONEYCRISP_RUNTIME_VERSION = "0.1.0" as const;
export const HONEYCRISP_PROTOCOL_WEBSOCKET_PATH = "/v1/session" as const;
export const HONEYCRISP_PROTOCOL_BOOTSTRAP_PREFIX = "HONEYCRISP_TRANSPORT " as const;
export const HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES = ["session.events", "session.controls"] as const;
export const HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH = 200 as const;
export const HONEYCRISP_PROTOCOL_CAPABILITIES = [
  "knowledge.findings",
  "knowledge.finding_staleness",
  "knowledge.campaign_graph",
  "knowledge.evidence_gates",
  "session.append_only",
  "session.controls",
] as const;

/** @deprecated Import the protocol-named constants from `honeycrisp/protocol`. */
export const HONEYCRISP_TRANSPORT_PROTOCOL_VERSION = HONEYCRISP_PROTOCOL_VERSION;
/** @deprecated Import the protocol-named constants from `honeycrisp/protocol`. */
export const HONEYCRISP_TRANSPORT_PREFIX = HONEYCRISP_PROTOCOL_BOOTSTRAP_PREFIX;
/** @deprecated Import the protocol-named constants from `honeycrisp/protocol`. */
export const HONEYCRISP_TRANSPORT_PATH = HONEYCRISP_PROTOCOL_WEBSOCKET_PATH;

export const HONEYCRISP_PROTOCOL_OPERATIONS = [
  "protocol.describe", "session.create", "session.begin_attempt", "session.append_event", "session.append_event_receipt",
  "session.transition", "session.recover_interrupted", "session.import_capture", "session.get", "session.get_update", "session.list", "session.list_summaries",
  "memory.summary", "dreaming.prepare", "dreaming.parse_plan", "dreaming.apply",
  "dreaming.record_failure", "dreaming.restore", "runbook.get", "report.get",
  "artifact.resolve", "provider.complete", "provider.describe", "model_job.resolve",
  "source.inspect", "source.materialize", "plugin.list", "plugin.add_filesystem",
  "plugin.add_repository", "plugin.set_enabled", "plugin.remove", "plugin.runtime",
  "maintenance.summary", "maintenance.run",
] as const;

export type HoneycrispProtocolOperation = (typeof HONEYCRISP_PROTOCOL_OPERATIONS)[number];

export interface HoneycrispProtocolErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
}

interface HoneycrispProtocolEnvelopeBase {
  protocol: typeof HONEYCRISP_PROTOCOL_NAME;
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  operation: HoneycrispProtocolOperation;
  requestId?: string;
}

export interface HoneycrispProtocolSuccess<T = unknown> extends HoneycrispProtocolEnvelopeBase {
  ok: true;
  result: T;
}

export interface HoneycrispProtocolFailure extends HoneycrispProtocolEnvelopeBase {
  ok: false;
  error: HoneycrispProtocolErrorDetail;
}

export type HoneycrispProtocolEnvelope<T = unknown> = HoneycrispProtocolSuccess<T> | HoneycrispProtocolFailure;

export interface HoneycrispProtocolDescriptor {
  protocol: typeof HONEYCRISP_PROTOCOL_NAME;
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  operations: readonly HoneycrispProtocolOperation[];
  contractVersion: typeof HONEYCRISP_CONTRACT_VERSION;
  runtime: {
    name: typeof HONEYCRISP_PROTOCOL_NAME;
    version: typeof HONEYCRISP_RUNTIME_VERSION;
    buildId: string;
    nodeVersion: string;
  };
  schemas: {
    protocol: 1;
    session: 1;
    memorySummary: 3;
    finding: 1;
    campaignGraph: 1;
  };
  capabilities: typeof HONEYCRISP_PROTOCOL_CAPABILITIES;
  transports: {
    cli: {
      framing: "single-json-envelope";
      errors: "envelope-and-nonzero-exit";
      correlation: "request-id";
    };
    websocket: {
      path: typeof HONEYCRISP_PROTOCOL_WEBSOCKET_PATH;
      authentication: "bearer";
      framing: "json-message";
      errors: "protocol-error-message";
      correlation: "request-id";
      capabilities: typeof HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES;
    };
  };
}

export interface HoneycrispTransportBootstrap {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  transport: "websocket";
  url: string;
  sessionId: string;
}

export interface HoneycrispClientHello {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "client.hello";
  sessionId: string;
  client: { name: string; version: string };
}

export interface HoneycrispServerHello {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "server.hello";
  sessionId: string;
  server: { name: typeof HONEYCRISP_PROTOCOL_NAME; version: string; buildId: string };
  contractVersion: typeof HONEYCRISP_CONTRACT_VERSION;
  schemas: HoneycrispProtocolDescriptor["schemas"];
  capabilities: typeof HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES;
}

export interface HoneycrispSessionControl<TControl extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "session.control";
  sessionId: string;
  requestId: string;
  control: TControl & { requestId: string };
}

export interface HoneycrispSessionEvent<TEvent extends Record<string, unknown> = Record<string, unknown>> {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "session.event";
  sessionId: string;
  event: TEvent;
}

export interface HoneycrispWebSocketProtocolError {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "protocol.error";
  sessionId: string;
  requestId?: string;
  error: HoneycrispProtocolErrorDetail;
  /** Retained in protocol v1 for clients that consumed the original WebSocket error shape. */
  message: string;
}

/** @deprecated Use HoneycrispWebSocketProtocolError for the complete current DTO. */
export interface HoneycrispProtocolError {
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  type: "protocol.error";
  sessionId: string;
  message: string;
}

export type HoneycrispClientMessage = HoneycrispClientHello | HoneycrispSessionControl;
export type HoneycrispServerMessage = HoneycrispServerHello | HoneycrispSessionEvent | HoneycrispWebSocketProtocolError;

export interface HoneycrispProtocolArguments {
  args: readonly string[];
  requestId?: string;
}

export function parseHoneycrispProtocolArguments(argv: readonly string[]): HoneycrispProtocolArguments {
  const args: string[] = [];
  let requestId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--request-id") {
      if (arg !== undefined) args.push(arg);
      continue;
    }
    if (requestId !== undefined) throw new Error("--request-id may only be provided once.");
    const value = argv[index + 1];
    if (!value?.trim()) throw new Error("--request-id requires a non-empty value.");
    if (value.length > HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH) {
      throw new Error(`--request-id must not exceed ${HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH} characters.`);
    }
    requestId = value;
    index += 1;
  }
  return { args, ...(requestId ? { requestId } : {}) };
}

export function honeycrispProtocolSuccess<T>(operation: HoneycrispProtocolOperation, result: T, requestId?: string): HoneycrispProtocolSuccess<T> {
  return {
    protocol: HONEYCRISP_PROTOCOL_NAME, protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operation, ok: true, result, ...(requestId ? { requestId } : {}),
  };
}

export function honeycrispProtocolFailure(
  operation: HoneycrispProtocolOperation,
  code: string,
  message: string,
  retryable = false,
  requestId?: string,
): HoneycrispProtocolFailure {
  return {
    protocol: HONEYCRISP_PROTOCOL_NAME, protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operation,
    ok: false,
    error: honeycrispProtocolErrorDetail(code, message, retryable),
    ...(requestId ? { requestId } : {}),
  };
}

export function honeycrispProtocolErrorDetail(
  code: string,
  message: string,
  retryable = false,
): HoneycrispProtocolErrorDetail {
  return { code, message, retryable };
}

export function honeycrispProtocolDescriptor(): HoneycrispProtocolDescriptor {
  return {
    protocol: HONEYCRISP_PROTOCOL_NAME,
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operations: HONEYCRISP_PROTOCOL_OPERATIONS,
    contractVersion: HONEYCRISP_CONTRACT_VERSION,
    runtime: {
      name: HONEYCRISP_PROTOCOL_NAME,
      version: HONEYCRISP_RUNTIME_VERSION,
      buildId: honeycrispRuntimeBuildId(),
      nodeVersion: process.version,
    },
    schemas: { protocol: 1, session: 1, memorySummary: 3, finding: 1, campaignGraph: 1 },
    capabilities: HONEYCRISP_PROTOCOL_CAPABILITIES,
    transports: {
      cli: { framing: "single-json-envelope", errors: "envelope-and-nonzero-exit", correlation: "request-id" },
      websocket: {
        path: HONEYCRISP_PROTOCOL_WEBSOCKET_PATH,
        authentication: "bearer",
        framing: "json-message",
        errors: "protocol-error-message",
        correlation: "request-id",
        capabilities: HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES,
      },
    },
  };
}

function honeycrispRuntimeBuildId(): string {
  const configured = process.env.HONEYCRISP_BUILD_ID?.trim();
  if (configured) return configured;
  try {
    return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 24);
  } catch {
    return `${HONEYCRISP_RUNTIME_VERSION}-unknown`;
  }
}

export function honeycrispTransportBootstrap(url: string, sessionId: string): HoneycrispTransportBootstrap {
  return { protocolVersion: HONEYCRISP_PROTOCOL_VERSION, transport: "websocket", url, sessionId };
}

export function honeycrispServerHello(sessionId: string, serverVersion: string): HoneycrispServerHello {
  return {
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    type: "server.hello",
    sessionId,
    server: { name: HONEYCRISP_PROTOCOL_NAME, version: serverVersion, buildId: honeycrispRuntimeBuildId() },
    contractVersion: HONEYCRISP_CONTRACT_VERSION,
    schemas: { protocol: 1, session: 1, memorySummary: 3, finding: 1, campaignGraph: 1 },
    capabilities: HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES,
  };
}

export function honeycrispSessionEvent<TEvent extends Record<string, unknown>>(
  sessionId: string,
  event: TEvent,
): HoneycrispSessionEvent<TEvent> {
  return { protocolVersion: HONEYCRISP_PROTOCOL_VERSION, type: "session.event", sessionId, event };
}

export function honeycrispWebSocketProtocolError(
  sessionId: string,
  code: string,
  message: string,
  requestId?: string,
): HoneycrispWebSocketProtocolError {
  return {
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    type: "protocol.error",
    sessionId,
    ...(requestId ? { requestId } : {}),
    error: honeycrispProtocolErrorDetail(code, message),
    message,
  };
}

export function decodeHoneycrispProtocolEnvelope(value: unknown): HoneycrispProtocolEnvelope {
  if (!isRecord(value) || value.protocol !== HONEYCRISP_PROTOCOL_NAME
    || value.protocolVersion !== HONEYCRISP_PROTOCOL_VERSION
    || !isProtocolOperation(value.operation) || typeof value.ok !== "boolean") {
    throw new Error("Invalid or unsupported Honeycrisp protocol envelope.");
  }
  validateOptionalRequestId(value.requestId);
  if (value.ok === true) {
    if (!("result" in value)) throw new Error("Honeycrisp protocol success is missing result.");
    return value as unknown as HoneycrispProtocolSuccess;
  }
  validateError(value.error);
  return value as unknown as HoneycrispProtocolFailure;
}

export function decodeHoneycrispTransportBootstrap(value: unknown): HoneycrispTransportBootstrap {
  if (!isRecord(value) || value.protocolVersion !== HONEYCRISP_PROTOCOL_VERSION
    || value.transport !== "websocket" || !nonEmptyString(value.url) || !nonEmptyString(value.sessionId)) {
    throw new Error("Invalid or unsupported Honeycrisp transport bootstrap.");
  }
  return value as unknown as HoneycrispTransportBootstrap;
}

export function decodeHoneycrispClientMessage(value: unknown): HoneycrispClientMessage {
  validateMessageBase(value);
  if (value.type === "client.hello") {
    if (!isRecord(value.client) || !nonEmptyString(value.client.name) || !nonEmptyString(value.client.version)) {
      throw new Error("The client.hello message requires client name and version.");
    }
    return value as unknown as HoneycrispClientHello;
  }
  if (value.type === "session.control") {
    if (!validRequestId(value.requestId) || !isRecord(value.control)) {
      throw new Error("The session.control message requires requestId and control.");
    }
    if (value.control.requestId !== value.requestId) throw new Error("Control request IDs must match.");
    return value as unknown as HoneycrispSessionControl;
  }
  throw new Error("Unsupported Honeycrisp client message type.");
}

export function decodeHoneycrispServerMessage(value: unknown): HoneycrispServerMessage {
  validateMessageBase(value);
  if (value.type === "server.hello") {
    if (!isRecord(value.server) || value.server.name !== HONEYCRISP_PROTOCOL_NAME
      || !nonEmptyString(value.server.version) || !nonEmptyString(value.server.buildId)
      || value.contractVersion !== HONEYCRISP_CONTRACT_VERSION
      || !validSchemaDescriptor(value.schemas) || !sameCapabilities(value.capabilities)) {
      throw new Error("The server.hello message has invalid server metadata or capabilities.");
    }
    return value as unknown as HoneycrispServerHello;
  }
  if (value.type === "session.event") {
    if (!isRecord(value.event)) throw new Error("The session.event message requires an event.");
    return value as unknown as HoneycrispSessionEvent;
  }
  if (value.type === "protocol.error") {
    validateOptionalRequestId(value.requestId);
    const legacyMessage = nonEmptyString(value.message) ? value.message : undefined;
    const error = isValidError(value.error)
      ? value.error
      : legacyMessage ? { code: "protocol_error", message: legacyMessage, retryable: false } : undefined;
    if (!error) throw new Error("The protocol.error message requires a valid error.");
    return {
      protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
      type: "protocol.error",
      sessionId: value.sessionId,
      ...(nonEmptyString(value.requestId) ? { requestId: value.requestId } : {}),
      error,
      message: legacyMessage ?? error.message,
    };
  }
  throw new Error("Unsupported Honeycrisp server message type.");
}

function validSchemaDescriptor(value: unknown): value is HoneycrispProtocolDescriptor["schemas"] {
  return isRecord(value) && value.protocol === 1 && value.session === 1
    && value.memorySummary === 3 && value.finding === 1 && value.campaignGraph === 1;
}

function validateMessageBase(value: unknown): asserts value is Record<string, unknown> & { sessionId: string; type: string } {
  if (!isRecord(value) || value.protocolVersion !== HONEYCRISP_PROTOCOL_VERSION
    || !nonEmptyString(value.type) || !nonEmptyString(value.sessionId)) {
    throw new Error("Invalid Honeycrisp WebSocket message.");
  }
}

function validateOptionalRequestId(value: unknown): void {
  if (value !== undefined && !validRequestId(value)) {
    throw new Error(`Honeycrisp protocol requestId must be non-empty and at most ${HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH} characters.`);
  }
}

function validateError(value: unknown): asserts value is HoneycrispProtocolErrorDetail {
  if (!isValidError(value)) throw new Error("Honeycrisp protocol failure is missing a valid error.");
}

function isValidError(value: unknown): value is HoneycrispProtocolErrorDetail {
  return isRecord(value) && nonEmptyString(value.code)
    && typeof value.message === "string" && typeof value.retryable === "boolean";
}

function sameCapabilities(value: unknown): value is typeof HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES {
  return Array.isArray(value) && value.length === HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES.length
    && HONEYCRISP_PROTOCOL_WEBSOCKET_CAPABILITIES.every((capability, index) => value[index] === capability);
}

function isProtocolOperation(value: unknown): value is HoneycrispProtocolOperation {
  return typeof value === "string" && (HONEYCRISP_PROTOCOL_OPERATIONS as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function validRequestId(value: unknown): value is string {
  return nonEmptyString(value) && value.length <= HONEYCRISP_PROTOCOL_MAX_REQUEST_ID_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
