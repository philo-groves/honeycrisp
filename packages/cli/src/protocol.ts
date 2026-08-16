export const HONEYCRISP_PROTOCOL_NAME = "honeycrisp" as const;
export const HONEYCRISP_PROTOCOL_VERSION = 1 as const;

export const HONEYCRISP_PROTOCOL_OPERATIONS = [
  "protocol.describe",
  "session.create",
  "session.begin_attempt",
  "session.append_event",
  "session.transition",
  "session.import_capture",
  "session.get",
  "session.list",
  "memory.summary",
  "dreaming.prepare",
  "dreaming.parse_plan",
  "dreaming.apply",
  "dreaming.record_failure",
  "dreaming.restore",
  "runbook.get",
  "report.get",
  "artifact.resolve",
] as const;

export type HoneycrispProtocolOperation = (typeof HONEYCRISP_PROTOCOL_OPERATIONS)[number];

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
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type HoneycrispProtocolEnvelope<T = unknown> =
  | HoneycrispProtocolSuccess<T>
  | HoneycrispProtocolFailure;

export interface HoneycrispProtocolDescriptor {
  protocol: typeof HONEYCRISP_PROTOCOL_NAME;
  protocolVersion: typeof HONEYCRISP_PROTOCOL_VERSION;
  operations: readonly HoneycrispProtocolOperation[];
  transports: {
    cli: {
      framing: "single-json-envelope";
      errors: "envelope-and-nonzero-exit";
    };
    websocket: {
      path: "/v1/session";
      authentication: "bearer";
      capabilities: readonly ["session.events", "session.controls"];
    };
  };
}

export function honeycrispProtocolSuccess<T>(
  operation: HoneycrispProtocolOperation,
  result: T,
  requestId?: string,
): HoneycrispProtocolSuccess<T> {
  return {
    protocol: HONEYCRISP_PROTOCOL_NAME,
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operation,
    ok: true,
    result,
    ...(requestId ? { requestId } : {}),
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
    protocol: HONEYCRISP_PROTOCOL_NAME,
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operation,
    ok: false,
    error: { code, message, retryable },
    ...(requestId ? { requestId } : {}),
  };
}

export function honeycrispProtocolDescriptor(): HoneycrispProtocolDescriptor {
  return {
    protocol: HONEYCRISP_PROTOCOL_NAME,
    protocolVersion: HONEYCRISP_PROTOCOL_VERSION,
    operations: HONEYCRISP_PROTOCOL_OPERATIONS,
    transports: {
      cli: {
        framing: "single-json-envelope",
        errors: "envelope-and-nonzero-exit",
      },
      websocket: {
        path: "/v1/session",
        authentication: "bearer",
        capabilities: ["session.events", "session.controls"],
      },
    },
  };
}

export function decodeHoneycrispProtocolEnvelope(value: unknown): HoneycrispProtocolEnvelope {
  if (!isRecord(value)
    || value.protocol !== HONEYCRISP_PROTOCOL_NAME
    || value.protocolVersion !== HONEYCRISP_PROTOCOL_VERSION
    || !isProtocolOperation(value.operation)
    || typeof value.ok !== "boolean") {
    throw new Error("Invalid or unsupported Honeycrisp protocol envelope.");
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId.trim())) {
    throw new Error("Honeycrisp protocol requestId must be a non-empty string.");
  }
  if (value.ok === true) {
    if (!("result" in value)) throw new Error("Honeycrisp protocol success is missing result.");
    return value as unknown as HoneycrispProtocolSuccess;
  }
  if (!isRecord(value.error)
    || typeof value.error.code !== "string"
    || typeof value.error.message !== "string"
    || typeof value.error.retryable !== "boolean") {
    throw new Error("Honeycrisp protocol failure is missing a valid error.");
  }
  return value as unknown as HoneycrispProtocolFailure;
}

function isProtocolOperation(value: unknown): value is HoneycrispProtocolOperation {
  return typeof value === "string"
    && (HONEYCRISP_PROTOCOL_OPERATIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
