import type { ResearchCollaborationConfig } from "./types.js";

const MODES = new Set(["solo", "adaptive", "always"]);
const INTENSITIES = new Set(["focused", "balanced", "deep"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function decodeResearchCollaborationConfig(value: unknown): ResearchCollaborationConfig {
  if (!isRecord(value)) throw new Error("Collaboration config must be a JSON object.");
  const mode = requiredEnum(value.mode, MODES, "mode") as ResearchCollaborationConfig["mode"];
  const intensity = requiredEnum(value.intensity, INTENSITIES, "intensity") as ResearchCollaborationConfig["intensity"];
  if (!Array.isArray(value.providers)) throw new Error("Collaboration config providers must be an array.");
  const seen = new Set<string>();
  const providers = value.providers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Collaboration provider ${index + 1} must be an object.`);
    const provider = requiredString(entry.provider, `providers[${index}].provider`);
    const model = requiredString(entry.model, `providers[${index}].model`);
    const key = providerModelKey(provider, model);
    if (seen.has(key)) throw new Error(`Collaboration provider/model ${provider}/${model} is configured more than once.`);
    seen.add(key);
    const reasoningEffort = requiredEnum(entry.reasoningEffort, EFFORTS, `providers[${index}].reasoningEffort`);
    return { provider, model, reasoningEffort, enabled: entry.enabled !== false };
  });
  return {
    mode,
    intensity,
    providers,
    independentFirstPass: value.independentFirstPass !== false,
    peerChallengeRounds: boundedInteger(value.peerChallengeRounds, 0, 3, "peerChallengeRounds"),
    maxConcurrentRooms: boundedInteger(value.maxConcurrentRooms, 1, 5, "maxConcurrentRooms"),
    maxMembersPerRoom: boundedInteger(value.maxMembersPerRoom, 2, 5, "maxMembersPerRoom"),
    maxTotalInvocations: boundedInteger(value.maxTotalInvocations, 2, 24, "maxTotalInvocations"),
  };
}

function providerModelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Collaboration config ${field} must be a non-empty string.`);
  return value.trim();
}

function requiredEnum(value: unknown, values: ReadonlySet<string>, field: string): string {
  const normalized = requiredString(value, field);
  if (!values.has(normalized)) throw new Error(`Unsupported collaboration config ${field}: ${normalized}.`);
  return normalized;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Collaboration config ${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
