import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createResearchStorageLayout,
  getHoneycrispMemorySummary,
  getKnowledgeReport,
  getKnowledgeRunbook,
  parseMemoryDreamingPlanOutput,
  prepareMemoryDreamingRequest,
  recordFailedMemoryDreaming,
  resolveKnowledgeArtifact,
  restoreMemoryDreamingChange,
  runMemoryDreaming,
  type MemoryDreamingPlan,
  type MemoryDreamingProfileInput,
  type MemoryDreamingRunContext,
  type ResearchProfileSnapshot,
} from "@honeycrisp/research-agent/knowledge";
import {
  honeycrispProtocolFailure,
  honeycrispProtocolSuccess,
  type HoneycrispProtocolOperation,
} from "./protocol.js";

interface SummaryInput {
  workspaceId: string;
  subjectId: string | null;
  sessionId?: string;
  researchProfile?: ResearchProfileSnapshot | null;
  includeForeignCatalogs?: boolean;
}

interface DreamingApplyInput {
  workspaceId: string;
  plan: MemoryDreamingPlan;
  context: MemoryDreamingRunContext;
  profileInput: MemoryDreamingProfileInput;
}

export async function runKnowledgeCommand(argv: readonly string[], requestId?: string): Promise<void> {
  const command = argv[0];
  const operation = operationForCommand(command);
  if (!operation) {
    emitFailure("memory.summary", "unknown_operation", `Unknown knowledge command: ${command ?? ""}`, requestId);
    return;
  }
  try {
    const layout = createResearchStorageLayout({
      ...(process.env.HONEYCRISP_DATABASE_PATH?.trim()
        ? { databasePath: process.env.HONEYCRISP_DATABASE_PATH.trim() }
        : {}),
      ...(process.env.HONEYCRISP_ARTIFACT_DIRECTORY?.trim()
        ? { artifactDirectoryPath: process.env.HONEYCRISP_ARTIFACT_DIRECTORY.trim() }
        : {}),
    });
    let result: unknown;
    switch (command) {
      case "summary": {
        const input = await readJsonOption<SummaryInput>(argv);
        result = getHoneycrispMemorySummary({
          databasePath: layout.databasePath,
          artifactDirectoryPath: layout.artifactDirectoryPath,
          workspaceId: requiredText(input.workspaceId, "workspaceId"),
          subjectId: input.subjectId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.researchProfile !== undefined ? { researchProfile: input.researchProfile } : {}),
          ...(input.includeForeignCatalogs === true ? { includeForeignCatalogs: true } : {}),
        });
        break;
      }
      case "dreaming-prepare": {
        const input = await readJsonOption<Parameters<typeof prepareMemoryDreamingRequest>[0]>(argv);
        result = prepareMemoryDreamingRequest(input);
        break;
      }
      case "dreaming-parse-plan": {
        const input = await readJsonOption<{ output: string; profileInput: MemoryDreamingProfileInput }>(argv);
        result = parseMemoryDreamingPlanOutput(input.output, input.profileInput);
        break;
      }
      case "dreaming-apply": {
        const input = await readJsonOption<DreamingApplyInput>(argv);
        result = runMemoryDreaming(layout.databasePath, requiredText(input.workspaceId, "workspaceId"), input.plan, input.context, input.profileInput);
        break;
      }
      case "dreaming-record-failure": {
        const input = await readJsonOption<{ workspaceId: string; context: MemoryDreamingRunContext; errorMessage: string; profileInput: MemoryDreamingProfileInput }>(argv);
        result = recordFailedMemoryDreaming(layout.databasePath, requiredText(input.workspaceId, "workspaceId"), input.context, input.errorMessage, input.profileInput);
        break;
      }
      case "dreaming-restore": {
        const input = await readJsonOption<{ workspaceId: string; changeId: string }>(argv);
        restoreMemoryDreamingChange(layout.databasePath, requiredText(input.workspaceId, "workspaceId"), requiredText(input.changeId, "changeId"));
        result = { restored: true };
        break;
      }
      case "runbook-get": {
        const input = await readJsonOption<{ workspaceId: string; runbookId: string }>(argv);
        result = getKnowledgeRunbook(layout.databasePath, layout.artifactDirectoryPath, requiredText(input.workspaceId, "workspaceId"), requiredText(input.runbookId, "runbookId"));
        break;
      }
      case "report-get": {
        const input = await readJsonOption<{ workspaceId: string; reportId: string }>(argv);
        result = getKnowledgeReport(layout.databasePath, layout.artifactDirectoryPath, requiredText(input.workspaceId, "workspaceId"), requiredText(input.reportId, "reportId"));
        break;
      }
      case "artifact-resolve": {
        const input = await readJsonOption<{ artifactId: string; expectedKind?: string }>(argv);
        result = resolveKnowledgeArtifact(requiredText(input.artifactId, "artifactId"), {
          databasePath: layout.databasePath,
          artifactDirectoryPath: layout.artifactDirectoryPath,
          ...(input.expectedKind ? { expectedKind: input.expectedKind } : {}),
        });
        break;
      }
      default:
        throw new Error(`Unsupported knowledge command: ${command}`);
    }
    console.log(JSON.stringify(honeycrispProtocolSuccess(operation, result, requestId)));
  } catch (error) {
    emitFailure(operation, "knowledge_operation_failed", errorMessage(error), requestId);
  }
}

function operationForCommand(command: string | undefined): HoneycrispProtocolOperation | null {
  switch (command) {
    case "summary": return "memory.summary";
    case "dreaming-prepare": return "dreaming.prepare";
    case "dreaming-parse-plan": return "dreaming.parse_plan";
    case "dreaming-apply": return "dreaming.apply";
    case "dreaming-record-failure": return "dreaming.record_failure";
    case "dreaming-restore": return "dreaming.restore";
    case "runbook-get": return "runbook.get";
    case "report-get": return "report.get";
    case "artifact-resolve": return "artifact.resolve";
    default: return null;
  }
}

async function readJsonOption<T>(argv: readonly string[]): Promise<T> {
  const index = argv.indexOf("--input");
  const path = index >= 0 ? argv[index + 1] : undefined;
  if (!path?.trim()) throw new Error("Missing required option --input.");
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function requiredText(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function emitFailure(operation: HoneycrispProtocolOperation, code: string, message: string, requestId?: string): void {
  console.log(JSON.stringify(honeycrispProtocolFailure(operation, code, message, false, requestId)));
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
