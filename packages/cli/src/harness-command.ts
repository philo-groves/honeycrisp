import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentPluginRegistry,
  extractSourceRepositoryUrls,
  getWorkspaceDejunkSummary,
  materializeGitRepositoryAsync,
  normalizeSourceRepositoryUrl,
  providerSemanticsDescriptor,
  resolveAuxiliaryModelRoute,
  runWorkspaceDejunk,
  selectSourceRepository,
  sourceRepositoryCandidates,
  type AgentPluginRecord,
  type BuiltinAgentPluginDefinition,
  type SourceRepositoryCandidate,
} from "@honeycrisp/research-agent/harness";
import {
  honeycrispProtocolFailure,
  honeycrispProtocolSuccess,
  type HoneycrispProtocolOperation,
} from "./protocol.js";

export async function runHarnessCommand(argv: readonly string[], requestId?: string): Promise<void> {
  const command = argv[0];
  const operation = operationForCommand(command);
  if (!operation) {
    emitFailure("source.inspect", "unknown_operation", `Unknown harness command: ${command ?? ""}`, requestId);
    return;
  }
  try {
    const input = await readJsonOption<Record<string, unknown>>(argv);
    let result: unknown;
    switch (command) {
      case "model-job-resolve":
        result = resolveAuxiliaryModelRoute(input as unknown as Parameters<typeof resolveAuxiliaryModelRoute>[0]);
        break;
      case "provider-describe":
        result = providerSemanticsDescriptor();
        break;
      case "source-inspect": {
        const scope = input.scope as Parameters<typeof sourceRepositoryCandidates>[0] | undefined;
        const text = optionalText(input.text);
        const value = optionalText(input.value);
        const requested = optionalText(input.requested);
        result = {
          ...(text !== null ? { urls: extractSourceRepositoryUrls(text) } : {}),
          ...(value !== null ? { normalizedUrl: normalizeSourceRepositoryUrl(value) } : {}),
          ...(scope ? { candidates: sourceRepositoryCandidates(scope) } : {}),
          ...(scope && requested !== null ? { selection: selectSourceRepository(scope, requested) } : {}),
        };
        break;
      }
      case "source-materialize": {
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
          result = await materializeGitRepositoryAsync(
            input.candidate as SourceRepositoryCandidate,
            optionalText(input.ref) ?? "",
            {
              signal: controller.signal,
              ...(optionalText(input.repositoryStoreDirectory)
                ? { repositoryStoreDirectory: optionalText(input.repositoryStoreDirectory)! }
                : {}),
            },
          );
        } finally {
          process.removeListener("SIGINT", abort);
          process.removeListener("SIGTERM", abort);
        }
        break;
      }
      case "plugin-list":
        result = pluginRegistry(input).getState();
        break;
      case "plugin-add-filesystem":
        result = pluginRegistry(input).addFromFilesystem(requiredText(input.pluginRoot, "pluginRoot"));
        break;
      case "plugin-add-repository":
        result = await pluginRegistry(input).addFromRepository(requiredText(input.repositoryUrl, "repositoryUrl"));
        break;
      case "plugin-set-enabled":
        result = pluginRegistry(input).setEnabled(requiredText(input.pluginId, "pluginId"), input.enabled === true);
        break;
      case "plugin-remove":
        result = pluginRegistry(input).remove(requiredText(input.pluginId, "pluginId"));
        break;
      case "plugin-runtime":
        result = pluginRegistry(input).getHoneycrispRuntime();
        break;
      case "maintenance-summary":
        result = getWorkspaceDejunkSummary(requiredText(input.workspacePath, "workspacePath"));
        break;
      case "maintenance-run":
        result = runWorkspaceDejunk(requiredText(input.workspacePath, "workspacePath"));
        break;
      default:
        throw new Error(`Unsupported harness command: ${command}`);
    }
    console.log(JSON.stringify(honeycrispProtocolSuccess(operation, result, requestId)));
  } catch (error) {
    emitFailure(operation, "harness_operation_failed", errorMessage(error), requestId);
  }
}

function pluginRegistry(input: Record<string, unknown>): AgentPluginRegistry {
  const builtinPlugins = Array.isArray(input.builtinPlugins)
    ? input.builtinPlugins as BuiltinAgentPluginDefinition[]
    : [];
  const runtimeEnvironment = isRecord(input.runtimeEnvironment)
    ? input.runtimeEnvironment as Record<string, Record<string, string>>
    : {};
  return new AgentPluginRegistry(requiredText(input.registryDirectory, "registryDirectory"), {
    builtinPlugins,
    runtimeEnvironment: (plugin: AgentPluginRecord) => runtimeEnvironment[plugin.id] ?? {},
  });
}

function operationForCommand(command: string | undefined): HoneycrispProtocolOperation | null {
  switch (command) {
    case "model-job-resolve": return "model_job.resolve";
    case "provider-describe": return "provider.describe";
    case "source-inspect": return "source.inspect";
    case "source-materialize": return "source.materialize";
    case "plugin-list": return "plugin.list";
    case "plugin-add-filesystem": return "plugin.add_filesystem";
    case "plugin-add-repository": return "plugin.add_repository";
    case "plugin-set-enabled": return "plugin.set_enabled";
    case "plugin-remove": return "plugin.remove";
    case "plugin-runtime": return "plugin.runtime";
    case "maintenance-summary": return "maintenance.summary";
    case "maintenance-run": return "maintenance.run";
    default: return null;
  }
}

async function readJsonOption<T>(argv: readonly string[]): Promise<T> {
  const index = argv.indexOf("--input");
  const path = index >= 0 ? argv[index + 1] : undefined;
  if (!path?.trim()) throw new Error("Missing required option --input.");
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emitFailure(operation: HoneycrispProtocolOperation, code: string, message: string, requestId?: string): void {
  console.log(JSON.stringify(honeycrispProtocolFailure(operation, code, message, false, requestId)));
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
