import { DEFAULT_SECURITY_RESEARCH_PROFILE } from "./research-profile.js";
import type { MemoryNodeType } from "./memory-graph.js";
import type { ResearchProfileMemory } from "./research-profile.js";

export type MemoryTypeDescriptions = Readonly<Record<string, string>>;
export type MemoryTypeDescriptionsInput = Partial<Record<MemoryNodeType, string>>;

const MAX_MEMORY_TYPE_DESCRIPTION_CHARACTERS = 4_000;

export const DEFAULT_MEMORY_TYPE_DESCRIPTIONS: MemoryTypeDescriptions = Object.freeze(
  Object.fromEntries(
    DEFAULT_SECURITY_RESEARCH_PROFILE.memory.types.map((type) => [type.id, type.description]),
  ),
);

export function resolveMemoryTypeDescriptions(
  input: MemoryTypeDescriptionsInput = {},
): MemoryTypeDescriptions {
  if (!isRecord(input)) {
    throw new Error("Memory type descriptions must be an object.");
  }
  const memoryTypes = DEFAULT_SECURITY_RESEARCH_PROFILE.memory.types;
  const supported = new Set(memoryTypes.map((type) => type.id));
  for (const [type, value] of Object.entries(input)) {
    if (!supported.has(type)) {
      throw new Error(`Unsupported memory type description: ${type}`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Memory type description for ${type} must be a non-empty string.`);
    }
    if (value.trim().length > MAX_MEMORY_TYPE_DESCRIPTION_CHARACTERS) {
      throw new Error(
        `Memory type description for ${type} exceeds ${MAX_MEMORY_TYPE_DESCRIPTION_CHARACTERS} characters.`,
      );
    }
  }
  const resolved = Object.fromEntries(memoryTypes.map((type) => [
    type.id,
    normalizeDescription(input[type.id] ?? type.description),
  ])) as Record<MemoryNodeType, string>;
  return Object.freeze(resolved);
}

export function formatMemoryTypeDescriptions(
  input: MemoryTypeDescriptionsInput = {},
): string[] {
  const descriptions = resolveMemoryTypeDescriptions(input);
  return DEFAULT_SECURITY_RESEARCH_PROFILE.memory.types
    .filter((type) => type.lifecycle === "active")
    .map((type) => `- ${type.id}: ${descriptions[type.id]}`);
}

export function formatResearchProfileMemoryTypes(
  memory: ResearchProfileMemory,
  options: { creatableOnly?: boolean } = {},
): string[] {
  return memory.types
    .filter((type) => !options.creatableOnly || (type.lifecycle === "active" && type.creatable))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((type) => {
      const aliases = type.aliases?.length ? ` Aliases: ${type.aliases.join(", ")}.` : "";
      return `- ${type.id} (${type.name}): ${normalizeDescription(type.description)}${aliases}`;
    });
}

function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
