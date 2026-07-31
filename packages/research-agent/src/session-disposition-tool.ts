import { nowIso } from "./ids.js";
import type { ResearchExecutableTool, ResearchToolExecutionResult } from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

export const RESEARCH_DISPOSITION_OUTCOMES = [
  "objective_achieved",
  "objective_partially_achieved",
  "blocked",
  "inconclusive",
  "failed",
  "stopped",
] as const;

export const RESEARCH_BLOCKER_DEPENDENCY_KINDS = [
  "user_input",
  "credentials",
  "authorization",
  "source_material",
  "environment",
  "network_access",
  "external_service",
  "target_state",
  "other",
] as const;

export type ResearchDispositionOutcome = (typeof RESEARCH_DISPOSITION_OUTCOMES)[number];
export type ResearchBlockerDependencyKind = (typeof RESEARCH_BLOCKER_DEPENDENCY_KINDS)[number];

export interface ResearchBlockerDependency {
  kind: ResearchBlockerDependencyKind;
  description: string;
  requiredState: string;
  external: boolean;
}

export interface ResearchFinalDisposition {
  outcome: ResearchDispositionOutcome;
  summary: string;
  blockerDependencies: readonly ResearchBlockerDependency[];
  externalStateRequired: boolean;
  recordedAt: string;
}

const PARAMETERS = {
  type: "object",
  required: ["outcome", "summary", "blockerDependencies", "externalStateRequired"],
  properties: {
    outcome: {
      type: "string",
      enum: ["objective_achieved", "objective_partially_achieved", "blocked", "inconclusive"],
      description: "Whether the requested objective was achieved, partially achieved, blocked, or remained inconclusive.",
    },
    summary: { type: "string", description: "Concise evidence-grounded final state of the session." },
    blockerDependencies: {
      type: "array",
      description: "Unresolved dependencies that prevented stronger completion. Use an empty array when none remain.",
      items: {
        type: "object",
        required: ["kind", "description", "requiredState", "external"],
        properties: {
          kind: { type: "string", enum: [...RESEARCH_BLOCKER_DEPENDENCY_KINDS] },
          description: { type: "string" },
          requiredState: { type: "string", description: "The concrete state or input that would unblock further research." },
          external: { type: "boolean", description: "True when the dependency cannot be resolved by more work inside this session." },
        },
      },
    },
    externalStateRequired: {
      type: "boolean",
      description: "True only when meaningful progress requires user input or a change outside the current session and tools.",
    },
  },
};

export class ResearchDispositionRecorder {
  private disposition: ResearchFinalDisposition | null = null;

  public record(input: unknown): ResearchFinalDisposition {
    if (this.disposition) throw new Error("The session final disposition has already been recorded.");
    const disposition = parseDisposition(input);
    this.disposition = disposition;
    return disposition;
  }

  public get(): ResearchFinalDisposition | null {
    return this.disposition ? cloneDisposition(this.disposition) : null;
  }
}

export function createSessionDispositionTool(recorder: ResearchDispositionRecorder): ResearchExecutableTool {
  return {
    descriptor: {
      name: "session.disposition",
      transportName: "session_disposition",
      description: "Record the root session's structured final disposition exactly once before the final response. List concrete unresolved dependencies and mark externalStateRequired only when more in-session work cannot resolve them.",
      actionClasses: ["synthesize", "respond"],
      sideEffects: "write",
      requiredPermissions: [],
      inputSchema: PARAMETERS,
      metadata: { provider: "honeycrisp.session", requiredBeforeFinalResponse: true },
    },
    parameters: PARAMETERS,
    async execute(action): Promise<ResearchToolExecutionResult> {
      const startedAt = nowIso();
      try {
        const disposition = recorder.record(action.input);
        return complete(action, startedAt, disposition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          action,
          status: "error",
          startedAt,
          completedAt: nowIso(),
          summary: message,
          error: { message },
          artifactRefs: [],
          followUpActions: ["Correct and record the final disposition before responding."],
        };
      }
    },
  };
}

export function fallbackResearchFinalDisposition(status: "complete" | "error", text: string): ResearchFinalDisposition {
  return {
    outcome: status === "error" ? "failed" : "inconclusive",
    summary: text.trim() || (status === "error" ? "The research session failed without a final response." : "The research session ended without a structured final disposition."),
    blockerDependencies: [],
    externalStateRequired: false,
    recordedAt: nowIso(),
  };
}

function parseDisposition(value: unknown): ResearchFinalDisposition {
  const input = record(value, "session disposition");
  const outcome = requiredString(input.outcome, "outcome") as ResearchDispositionOutcome;
  if (!RESEARCH_DISPOSITION_OUTCOMES.slice(0, 4).includes(outcome as (typeof RESEARCH_DISPOSITION_OUTCOMES)[number])) {
    throw new Error(`Unsupported model-recorded session outcome: ${outcome}`);
  }
  const summary = requiredString(input.summary, "summary");
  if (!Array.isArray(input.blockerDependencies)) throw new Error("blockerDependencies must be an array.");
  const blockerDependencies = input.blockerDependencies.map(parseDependency);
  const externalStateRequired = requiredBoolean(input.externalStateRequired, "externalStateRequired");
  if (externalStateRequired && !blockerDependencies.some((dependency) => dependency.external)) {
    throw new Error("externalStateRequired requires at least one external blocker dependency.");
  }
  if (!externalStateRequired && blockerDependencies.some((dependency) => dependency.external)) {
    throw new Error("An external blocker dependency requires externalStateRequired=true.");
  }
  if (outcome === "blocked" && blockerDependencies.length === 0) {
    throw new Error("A blocked disposition requires at least one blocker dependency.");
  }
  if (outcome === "objective_achieved" && blockerDependencies.length > 0) {
    throw new Error("An achieved objective cannot retain blocker dependencies.");
  }
  return { outcome, summary, blockerDependencies, externalStateRequired, recordedAt: nowIso() };
}

function parseDependency(value: unknown): ResearchBlockerDependency {
  const input = record(value, "blocker dependency");
  const kind = requiredString(input.kind, "dependency kind") as ResearchBlockerDependencyKind;
  if (!RESEARCH_BLOCKER_DEPENDENCY_KINDS.includes(kind)) throw new Error(`Unsupported blocker dependency kind: ${kind}`);
  return {
    kind,
    description: requiredString(input.description, "dependency description"),
    requiredState: requiredString(input.requiredState, "dependency requiredState"),
    external: requiredBoolean(input.external, "dependency external"),
  };
}

function complete(action: ResearchToolAction, startedAt: string, disposition: ResearchFinalDisposition): ResearchToolExecutionResult {
  return {
    action,
    status: "complete",
    startedAt,
    completedAt: nowIso(),
    summary: "Session final disposition recorded.",
    output: disposition,
    artifactRefs: [],
    followUpActions: [],
  };
}

function cloneDisposition(disposition: ResearchFinalDisposition): ResearchFinalDisposition {
  return { ...disposition, blockerDependencies: disposition.blockerDependencies.map((dependency) => ({ ...dependency })) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}
