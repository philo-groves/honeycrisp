import { createHash } from "node:crypto";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  RESEARCH_BLOCKER_DEPENDENCY_KINDS,
  RESEARCH_DISPOSITION_OUTCOMES,
  type ResearchBlockerDependency,
  type ResearchFinalDisposition,
} from "./session-disposition-tool.js";

export type ResearchGoalStatus = "active" | "complete" | "blocked";

export interface ResearchGoalSnapshot {
  objective: string;
  status: ResearchGoalStatus;
  turnsUsed: number;
  consecutiveBlockedTurns: number;
  lastDisposition: ResearchFinalDisposition | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchGoalPersistedState {
  schemaVersion: 1;
  objective: string;
  status: ResearchGoalStatus;
  turnsUsed: number;
  consecutiveBlockedTurns: number;
  blockerFingerprint: string | null;
  lastDisposition: ResearchFinalDisposition | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResearchGoalRuntimeOptions {
  objective: string;
  initialState?: unknown;
  reactivateTerminalInitialState?: boolean;
  getDisposition(): ResearchFinalDisposition | null;
  resetDisposition(): void;
}

export const RESEARCH_GOAL_TOOL_DESCRIPTORS = [] as const;

const GOAL_OBJECTIVE_MAX_CHARS = 500;

export function selectResearchGoalObjective(input: {
  explicitObjective?: string;
  resumedGoal?: ResearchGoalPersistedState;
  prompt: string;
}): string {
  return input.explicitObjective ?? input.resumedGoal?.objective ?? input.prompt;
}

export class ResearchGoalRuntime {
  private status: ResearchGoalStatus;
  private turnsUsed: number;
  private consecutiveBlockedTurns: number;
  private blockerFingerprint: string | null;
  private lastDisposition: ResearchFinalDisposition | null;
  private readonly createdAt: string;
  private updatedAt: string;
  private readonly objective: string;

  public constructor(private readonly options: CreateResearchGoalRuntimeOptions) {
    const objective = normalizeGoalObjective(options.objective);
    if (!objective) throw new Error("A research goal requires a non-empty objective.");
    this.objective = objective;
    const initialState = parseResearchGoalPersistedState(options.initialState);
    const now = new Date().toISOString();
    const matchingState = initialState?.objective === objective ? initialState : undefined;
    const restored = matchingState
      && options.reactivateTerminalInitialState
      && matchingState.status !== "active"
      ? {
          ...matchingState,
          status: "active" as const,
          consecutiveBlockedTurns: 0,
          blockerFingerprint: null,
          lastDisposition: null,
          updatedAt: now,
        }
      : matchingState;
    this.status = restored?.status ?? "active";
    this.turnsUsed = restored?.turnsUsed ?? 0;
    this.consecutiveBlockedTurns = restored?.consecutiveBlockedTurns ?? 0;
    this.blockerFingerprint = restored?.blockerFingerprint ?? null;
    this.lastDisposition = restored?.lastDisposition
      ? structuredClone(restored.lastDisposition)
      : null;
    this.createdAt = restored?.createdAt ?? now;
    this.updatedAt = restored?.updatedAt ?? now;
  }

  public createTools(): AgentTool[] {
    return [];
  }

  public snapshot(): ResearchGoalSnapshot {
    return {
      objective: this.objective,
      status: this.status,
      turnsUsed: this.turnsUsed,
      consecutiveBlockedTurns: this.consecutiveBlockedTurns,
      lastDisposition: this.lastDisposition ? structuredClone(this.lastDisposition) : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  public exportState(): ResearchGoalPersistedState {
    return {
      schemaVersion: 1,
      objective: this.objective,
      status: this.status,
      turnsUsed: this.turnsUsed,
      consecutiveBlockedTurns: this.consecutiveBlockedTurns,
      blockerFingerprint: this.blockerFingerprint,
      lastDisposition: this.lastDisposition ? structuredClone(this.lastDisposition) : null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  public continueAfterRootResponse(): AgentMessage[] {
    if (this.status !== "active") return [];

    this.turnsUsed += 1;
    const disposition = this.options.getDisposition();
    this.lastDisposition = disposition ? structuredClone(disposition) : null;
    this.updateBlockerAudit(disposition);
    this.applyTerminalDisposition(disposition);
    this.updatedAt = new Date().toISOString();

    if (this.status !== "active") return [];

    const prompt = this.continuationPrompt(disposition);
    this.options.resetDisposition();
    return [{ role: "user", content: prompt, timestamp: Date.now() }];
  }

  private applyTerminalDisposition(disposition: ResearchFinalDisposition | null): void {
    if (
      disposition?.outcome === "objective_achieved"
      && disposition.blockerDependencies.length === 0
      && !disposition.externalStateRequired
    ) {
      this.status = "complete";
      return;
    }

    if (
      disposition?.outcome === "blocked"
      && disposition.externalStateRequired
      && disposition.blockerDependencies.some((dependency) => dependency.external)
    ) {
      this.status = "blocked";
    }
  }

  private updateBlockerAudit(disposition: ResearchFinalDisposition | null): void {
    const fingerprint = blockerFingerprint(disposition);
    if (!fingerprint) {
      this.blockerFingerprint = null;
      this.consecutiveBlockedTurns = 0;
      return;
    }
    if (fingerprint === this.blockerFingerprint) {
      this.consecutiveBlockedTurns += 1;
      return;
    }
    this.blockerFingerprint = fingerprint;
    this.consecutiveBlockedTurns = 1;
  }

  private continuationPrompt(disposition: ResearchFinalDisposition | null): string {
    const previousState = disposition
      ? `Last structured disposition outcome: ${disposition.outcome}.`
      : "No valid structured disposition was recorded before the previous response.";

    return [
      `Continue research toward: ${this.objective}`,
      previousState,
      "Resume with the next concrete evidence-gathering or synthesis action. Keep reasoning on the target research; lifecycle state is managed by the host.",
      "Before the next final response, record session.disposition exactly once. The host will continue, complete, or block the goal from that disposition.",
    ].join("\n");
  }
}

export function parseResearchGoalPersistedState(value: unknown): ResearchGoalPersistedState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (typeof value.objective !== "string") return undefined;
  const objective = normalizeGoalObjective(value.objective);
  if (!objective || !isResearchGoalStatus(value.status)) return undefined;
  const turnsUsed = nonNegativeInteger(value.turnsUsed);
  const consecutiveBlockedTurns = nonNegativeInteger(value.consecutiveBlockedTurns);
  if (turnsUsed === undefined || consecutiveBlockedTurns === undefined) return undefined;
  const persistedFingerprint = value.blockerFingerprint;
  if (
    persistedFingerprint !== null
    && (typeof persistedFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(persistedFingerprint))
  ) {
    return undefined;
  }
  let lastDisposition: ResearchFinalDisposition | null;
  if (value.lastDisposition === null) {
    lastDisposition = null;
  } else {
    const parsedDisposition = parsePersistedDisposition(value.lastDisposition);
    if (!parsedDisposition) return undefined;
    lastDisposition = parsedDisposition;
  }
  const createdAt = isoTimestamp(value.createdAt);
  const updatedAt = isoTimestamp(value.updatedAt);
  if (!createdAt || !updatedAt || Date.parse(updatedAt) < Date.parse(createdAt)) return undefined;
  if (turnsUsed === 0 && lastDisposition) return undefined;

  const expectedFingerprint = blockerFingerprint(lastDisposition);
  if (persistedFingerprint !== expectedFingerprint) return undefined;
  if (
    (persistedFingerprint === null && consecutiveBlockedTurns !== 0)
    || (persistedFingerprint !== null && consecutiveBlockedTurns < 1)
  ) {
    return undefined;
  }
  const achieved = isAchievedDisposition(lastDisposition);
  const blocked = isBlockedDisposition(lastDisposition);
  if (
    (value.status === "complete" && !achieved)
    || (value.status === "blocked" && !blocked)
    || (value.status === "active" && (achieved || blocked))
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    objective,
    status: value.status,
    turnsUsed,
    consecutiveBlockedTurns,
    blockerFingerprint: persistedFingerprint,
    lastDisposition: lastDisposition ? structuredClone(lastDisposition) : null,
    createdAt,
    updatedAt,
  };
}

function blockerFingerprint(disposition: ResearchFinalDisposition | null): string | null {
  if (disposition?.outcome !== "blocked" || !disposition.externalStateRequired) return null;
  const dependencies = disposition.blockerDependencies
    .filter((dependency) => dependency.external)
    .map((dependency) => [
      dependency.kind,
      normalizeFingerprintText(dependency.description),
      normalizeFingerprintText(dependency.requiredState),
    ].join(":"))
    .sort();
  if (dependencies.length === 0) return null;
  return createHash("sha256").update(dependencies.join("\n")).digest("hex");
}

function normalizeFingerprintText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parsePersistedDisposition(value: unknown): ResearchFinalDisposition | undefined {
  if (!isRecord(value) || !RESEARCH_DISPOSITION_OUTCOMES.includes(value.outcome as never)) return undefined;
  if (typeof value.summary !== "string" || !value.summary.trim()) return undefined;
  if (!Array.isArray(value.blockerDependencies)) return undefined;
  const blockerDependencies: ResearchBlockerDependency[] = [];
  for (const dependency of value.blockerDependencies) {
    const parsed = parsePersistedBlockerDependency(dependency);
    if (!parsed) return undefined;
    blockerDependencies.push(parsed);
  }
  if (typeof value.externalStateRequired !== "boolean") return undefined;
  const recordedAt = isoTimestamp(value.recordedAt);
  if (!recordedAt) return undefined;
  const hasExternalDependency = blockerDependencies.some((dependency) => dependency.external);
  if (value.externalStateRequired !== hasExternalDependency) return undefined;
  if (value.outcome === "blocked" && blockerDependencies.length === 0) return undefined;
  if (value.outcome === "objective_achieved" && blockerDependencies.length > 0) return undefined;
  return {
    outcome: value.outcome as ResearchFinalDisposition["outcome"],
    summary: value.summary.trim(),
    blockerDependencies,
    externalStateRequired: value.externalStateRequired,
    recordedAt,
  };
}

function parsePersistedBlockerDependency(value: unknown): ResearchBlockerDependency | undefined {
  if (!isRecord(value) || !RESEARCH_BLOCKER_DEPENDENCY_KINDS.includes(value.kind as never)) return undefined;
  if (
    typeof value.description !== "string"
    || !value.description.trim()
    || typeof value.requiredState !== "string"
    || !value.requiredState.trim()
    || typeof value.external !== "boolean"
  ) {
    return undefined;
  }
  return {
    kind: value.kind as ResearchBlockerDependency["kind"],
    description: value.description.trim(),
    requiredState: value.requiredState.trim(),
    external: value.external,
  };
}

function isResearchGoalStatus(value: unknown): value is ResearchGoalStatus {
  return value === "active" || value === "complete" || value === "blocked";
}

function isAchievedDisposition(disposition: ResearchFinalDisposition | null): boolean {
  return disposition?.outcome === "objective_achieved"
    && disposition.blockerDependencies.length === 0
    && !disposition.externalStateRequired;
}

function isBlockedDisposition(disposition: ResearchFinalDisposition | null): boolean {
  return disposition?.outcome === "blocked"
    && disposition.externalStateRequired
    && disposition.blockerDependencies.some((dependency) => dependency.external);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGoalObjective(value: string): string {
  return compactText(value, GOAL_OBJECTIVE_MAX_CHARS);
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}
