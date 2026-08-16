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
    store = new HoneycrispSessionStore({ readOnly: command === "get" || command === "list" || command === "list-summaries" });
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
        result = store.appendEvent(requiredOption(sessionId, "--session-id"), await readJsonOption<HoneycrispSessionEvent>(argv, "--input"));
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
        result = store.importCapture(requiredOption(sessionId, "--session-id"), { attemptId, capture });
        break;
      }
      case "get":
        result = store.get(requiredOption(sessionId, "--session-id"));
        if (!result) throw new Error(`Session not found: ${sessionId}`);
        break;
      case "list":
        result = store.list(
          requiredOption(option(argv, "--workspace-id"), "--workspace-id"),
          positiveIntegerOption(argv, "--limit") ?? 100,
        );
        break;
      case "list-summaries":
        result = store.listSummaries(
          requiredOption(option(argv, "--workspace-id"), "--workspace-id"),
          positiveIntegerOption(argv, "--limit") ?? 100,
        );
        break;
      default:
        throw new Error(`Unsupported session command: ${command}`);
    }
    console.log(JSON.stringify(honeycrispProtocolSuccess(operation, result, requestId)));
  } catch (error) {
    emitFailure(operation, "session_operation_failed", errorMessage(error), requestId);
  } finally {
    store?.close();
  }
}

function operationForCommand(command: string): HoneycrispProtocolOperation | null {
  switch (command) {
    case "create": return "session.create";
    case "begin-attempt": return "session.begin_attempt";
    case "append-event": return "session.append_event";
    case "transition": return "session.transition";
    case "recover-interrupted": return "session.recover_interrupted";
    case "import-capture": return "session.import_capture";
    case "get": return "session.get";
    case "list": return "session.list";
    case "list-summaries": return "session.list_summaries";
    default: return null;
  }
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
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    "  honeycrisp session list --workspace-id <id> [--limit <n>] --json",
    "  honeycrisp session list-summaries --workspace-id <id> [--limit <n>] --json",
  ].join("\n");
}
