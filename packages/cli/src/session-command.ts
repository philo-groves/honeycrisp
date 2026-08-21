import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HoneycrispSessionStore,
  type BeginHoneycrispSessionAttemptInput,
  type CreateHoneycrispSessionInput,
  type HoneycrispSessionEvent,
  type HoneycrispSessionTransitionInput,
} from "@honeycrisp/research-agent";
import {
  honeycrispProtocolFailure,
  honeycrispProtocolSuccess,
  type HoneycrispProtocolOperation,
} from "./protocol.js";

export async function runSessionCommand(argv: readonly string[], requestId?: string): Promise<void> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log(sessionUsage());
    return;
  }
  const operation = operationForCommand(command);
  if (!operation) {
    emitFailure("session.get", "unknown_operation", `Unknown session command: ${command}`, requestId);
    return;
  }

  let store: HoneycrispSessionStore | undefined;
  try {
    store = new HoneycrispSessionStore({ readOnly: readOnlySessionCommand(command) });
    const sessionId = option(argv, "--session-id");
    let result: unknown;
    switch (command) {
      case "create":
        result = store.create(await readJsonOption<CreateHoneycrispSessionInput>(argv, "--input"));
        break;
      case "begin-attempt":
        result = store.beginAttempt(requiredOption(sessionId, "--session-id"), await readJsonOption<BeginHoneycrispSessionAttemptInput>(argv, "--input"));
        break;
      case "append-event":
        result = store.appendEventReceipt(requiredOption(sessionId, "--session-id"), await readJsonOption<HoneycrispSessionEvent>(argv, "--input"));
        break;
      case "append-event-receipt":
        result = store.appendEventReceipt(requiredOption(sessionId, "--session-id"), await readJsonOption<HoneycrispSessionEvent>(argv, "--input"));
        break;
      case "transition":
        result = store.transition(requiredOption(sessionId, "--session-id"), await readJsonOption<HoneycrispSessionTransitionInput>(argv, "--input"));
        break;
      case "recover-interrupted":
        result = store.recoverInterrupted(
          requiredOption(option(argv, "--workspace-id"), "--workspace-id"),
          await readOptionalJsonOption(argv, "--input"),
        );
        break;
      case "import-capture": {
        const attemptId = requiredOption(option(argv, "--attempt-id"), "--attempt-id");
        const capture = await readJsonFile(requiredOption(option(argv, "--capture"), "--capture"));
        const session = store.importCapture(requiredOption(sessionId, "--session-id"), { attemptId, capture });
        result = {
          sessionId: session.id,
          status: session.status,
          revision: session.revision,
          updatedAt: session.updatedAt,
        };
        break;
      }
      case "get":
        result = store.getSummary(requiredOption(sessionId, "--session-id"));
        if (!result) throw new Error(`Session not found: ${sessionId}`);
        break;
      case "get-update":
        result = store.getUpdate(
          requiredOption(sessionId, "--session-id"),
          option(argv, "--after-event-id"),
          {
            ...eventPageNumericOptions(argv),
            tail: argv.includes("--tail"),
          },
        );
        if (!result) throw new Error(`Session not found: ${sessionId}`);
        break;
      case "events":
        result = store.getEventPage(requiredOption(sessionId, "--session-id"), {
          ...(option(argv, "--after-event-id") ? { afterEventId: option(argv, "--after-event-id")! } : {}),
          stream: sessionEventStream(option(argv, "--stream")),
          ...eventPageNumericOptions(argv),
          tail: argv.includes("--tail"),
        });
        break;
      case "event-details":
        result = store.getEventDetails(
          requiredOption(sessionId, "--session-id"),
          requiredOptions(options(argv, "--event-id"), "--event-id"),
        );
        break;
      case "collaboration":
        result = store.getCollaborationState(
          requiredOption(sessionId, "--session-id"),
          positiveIntegerOption(argv, "--message-limit") ?? 200,
        );
        break;
      case "captures":
        result = store.listCaptureSummaries(requiredOption(sessionId, "--session-id"));
        break;
      case "capture":
        result = store.getCapture(
          requiredOption(sessionId, "--session-id"),
          requiredOption(option(argv, "--attempt-id"), "--attempt-id"),
        );
        if (!result) throw new Error(`Capture not found for session ${sessionId}.`);
        break;
      case "list":
        result = store.listSummariesForWorkspaces(
          requiredOptions(options(argv, "--workspace-id"), "--workspace-id"),
          positiveIntegerOption(argv, "--limit") ?? 100,
        );
        break;
      case "list-summaries":
        result = store.listSummariesForWorkspaces(
          requiredOptions(options(argv, "--workspace-id"), "--workspace-id"),
          positiveIntegerOption(argv, "--limit") ?? 100,
        );
        break;
      default:
        throw new Error(`Unsupported session command: ${command}`);
    }
    console.log(JSON.stringify(honeycrispProtocolSuccess(operation, result, requestId)));
  } catch (error) {
    const failure = sessionFailure(error);
    emitFailure(operation, failure.code, failure.message, requestId);
  } finally {
    store?.close();
  }
}

function operationForCommand(command: string): HoneycrispProtocolOperation | null {
  switch (command) {
    case "create": return "session.create";
    case "begin-attempt": return "session.begin_attempt";
    case "append-event": return "session.append_event";
    case "append-event-receipt": return "session.append_event_receipt";
    case "transition": return "session.transition";
    case "recover-interrupted": return "session.recover_interrupted";
    case "import-capture": return "session.import_capture";
    case "get": return "session.get";
    case "get-update": return "session.get_update";
    case "events": return "session.events";
    case "event-details": return "session.event_details";
    case "collaboration": return "session.collaboration";
    case "captures": return "session.captures";
    case "capture": return "session.capture";
    case "list": return "session.list";
    case "list-summaries": return "session.list_summaries";
    default: return null;
  }
}

function readOnlySessionCommand(command: string): boolean {
  return new Set([
    "get", "get-update", "events", "event-details", "collaboration", "captures", "capture", "list", "list-summaries",
  ]).has(command);
}

function sessionEventStream(value: string | undefined): "all" | "transcript" | "trace" {
  if (value === undefined || value === "all" || value === "transcript" || value === "trace") return value ?? "all";
  throw new Error("--stream must be all, transcript, or trace.");
}

function eventPageNumericOptions(argv: readonly string[]): { limit?: number; maxBytes?: number } {
  const limit = positiveIntegerOption(argv, "--limit");
  const maxBytes = positiveIntegerOption(argv, "--max-bytes");
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  };
}

function emitFailure(operation: HoneycrispProtocolOperation, code: string, message: string, requestId?: string): void {
  console.log(JSON.stringify(honeycrispProtocolFailure(operation, code, message, false, requestId)));
  process.exitCode = 1;
}

async function readJsonOption<T>(argv: readonly string[], name: string): Promise<T> {
  return await readJsonFile(requiredOption(option(argv, name), name)) as T;
}

async function readOptionalJsonOption<T>(argv: readonly string[], name: string): Promise<T | undefined> {
  const path = option(argv, name);
  return path ? await readJsonFile(path) as T : undefined;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

function option(argv: readonly string[], name: string): string | undefined {
  return options(argv, name)[0];
}

function options(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
  }
  return values;
}

function positiveIntegerOption(argv: readonly string[], name: string): number | undefined {
  const value = option(argv, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required option ${name}.`);
  return value.trim();
}

function requiredOptions(values: readonly string[], name: string): string[] {
  if (values.length === 0) throw new Error(`Missing required option ${name}.`);
  return values.map((value) => requiredOption(value, name));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionFailure(error: unknown): { code: string; message: string } {
  const message = errorMessage(error);
  if (/database disk image is malformed|file is not a database|database corruption|SQLITE_CORRUPT|SQLITE_NOTADB/iu.test(message)) {
    return {
      code: "database_corrupt",
      message: "Honeycrisp database integrity failed. Stop active writers and restore a verified backup or run SQLite recovery against the configured database before retrying. The original database must be preserved until recovery is validated.",
    };
  }
  if (/failed (?:its|the) integrity check/iu.test(message)) {
    return {
      code: "session_integrity_failed",
      message: "Honeycrisp session integrity validation failed. Stop active writers, preserve the database, and restore or repair the affected session data before retrying.",
    };
  }
  return { code: "session_operation_failed", message };
}

function sessionUsage(): string {
  return [
    "Usage:",
    "  honeycrisp session create --input <json> --json",
    "  honeycrisp session begin-attempt --session-id <id> --input <json> --json",
    "  honeycrisp session append-event --session-id <id> --input <json> --json",
    "  honeycrisp session transition --session-id <id> --input <json> --json",
    "  honeycrisp session recover-interrupted --workspace-id <id> [--input <json>] --json",
    "  honeycrisp session import-capture --session-id <id> --attempt-id <id> --capture <json> --json",
    "  honeycrisp session get --session-id <id> --json",
    "  honeycrisp session get-update --session-id <id> [--after-event-id <id>] [--tail] [--limit <n>] [--max-bytes <n>] --json",
    "  honeycrisp session events --session-id <id> [--stream all|transcript|trace] [--after-event-id <id>] [--tail] [--limit <n>] [--max-bytes <n>] --json",
    "  honeycrisp session event-details --session-id <id> --event-id <id> [--event-id <id> ...] --json",
    "  honeycrisp session collaboration --session-id <id> [--message-limit <n>] --json",
    "  honeycrisp session captures --session-id <id> --json",
    "  honeycrisp session capture --session-id <id> --attempt-id <id> --json",
    "  honeycrisp session list --workspace-id <id> [--workspace-id <id> ...] [--limit <n>] --json",
    "  honeycrisp session list-summaries --workspace-id <id> [--workspace-id <id> ...] [--limit <n>] --json",
  ].join("\n");
}
