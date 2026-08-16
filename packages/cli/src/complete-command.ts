import {
  completeAuxiliaryText,
  type ResearchModelProviderId,
} from "@honeycrisp/research-agent";
import { honeycrispProtocolFailure, honeycrispProtocolSuccess } from "./protocol.js";

const PROVIDERS = new Set<ResearchModelProviderId>(["openai-codex", "anthropic", "xai", "zai"]);
type CompletionEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<CompletionEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_INPUT_CHARS = 8_000_000;

interface CompleteCommandRequest {
  schemaVersion: 1;
  provider: ResearchModelProviderId;
  model: string;
  effort?: CompletionEffort;
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
  cwd?: string;
}

export async function runCompleteCommand(argv: readonly string[]): Promise<void> {
  try {
    if (argv.length > 0 && !(argv.length === 1 && argv[0] === "--json")) {
      throw new Error("Usage: honeycrisp complete [--json] < request.json");
    }
    const raw = await readStandardInput();
    const request = decodeRequest(JSON.parse(raw) as unknown);
    const completion = await completeAuxiliaryText(request);
    process.stdout.write(`${JSON.stringify(honeycrispProtocolSuccess("provider.complete", completion))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(honeycrispProtocolFailure(
      "provider.complete",
      "provider_completion_failed",
      error instanceof Error ? error.message : String(error),
    ))}\n`);
    process.exitCode = 1;
  }
}

async function readStandardInput(): Promise<string> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > MAX_INPUT_CHARS) throw new Error("Completion request is too large.");
  }
  return raw;
}

function decodeRequest(value: unknown): CompleteCommandRequest {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Invalid completion request schema.");
  const provider = requiredString(value.provider, "provider") as ResearchModelProviderId;
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported completion provider: ${provider}`);
  const model = requiredString(value.model, "model");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) throw new Error("Invalid completion model id.");
  const systemPrompt = requiredString(value.systemPrompt, "systemPrompt");
  const prompt = requiredString(value.prompt, "prompt");
  const effort = value.effort === undefined ? undefined : requiredString(value.effort, "effort") as CompletionEffort;
  if (effort && !EFFORTS.has(effort)) throw new Error(`Unsupported completion effort: ${effort}`);
  const maxTokens = value.maxTokens === undefined ? undefined : positiveInteger(value.maxTokens, "maxTokens");
  const cwd = value.cwd === undefined ? undefined : requiredString(value.cwd, "cwd");
  return {
    schemaVersion: 1,
    provider,
    model,
    systemPrompt,
    prompt,
    ...(effort ? { effort } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Completion ${field} is required.`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Completion ${field} must be a positive integer.`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
