import {
  MEMORY_NODE_TYPES,
  type MemoryNodeType,
} from "./memory-graph.js";

export type MemoryTypeDescriptions = Readonly<Record<MemoryNodeType, string>>;
export type MemoryTypeDescriptionsInput = Partial<Record<MemoryNodeType, string>>;

const MAX_MEMORY_TYPE_DESCRIPTION_CHARACTERS = 4_000;

export const DEFAULT_MEMORY_TYPE_DESCRIPTIONS = Object.freeze({
  asset: "A security-relevant component, service, data object, credential, interface, or execution boundary whose compromise or protection matters. Use it to anchor affected ownership and impact; do not use it for arbitrary files with no security role.",
  bug: "A confirmed historical flaw precedent that predates the current research, backed by a fixed advisory, patch, prior incident, or equivalent evidence. It must identify affected assets and set attributes.historicalPrecedent=true; a flaw established during the current research is a primitive, not a bug.",
  invariant: "A security property that must remain true across relevant states or transitions. State it as a falsifiable rule whose violation would create security impact, not as a one-off observation.",
  mitigation: "A concrete product, platform, hardware, policy, or deployment control that prevents or materially constrains exploitation. Record what it blocks and its assumptions; an ordinary validation step is not automatically a mitigation.",
  source: "An attacker-controlled or lower-trust ingress from which data, control, identity, or state enters the investigated system. Name the trust boundary and reachable input, not merely a function that reads bytes.",
  sink: "A security-sensitive operation or state transition whose unsafe reachability can produce impact, such as memory access, code execution, authorization, disclosure, or persistence. Name the dangerous effect and required conditions.",
  hypothesis: "A specific, testable, currently unproven security proposition. Keep it draft or suspected while active, reject it when disproven, and reclassify it as a primitive or chain when evidence proves that role; never confirm a hypothesis in place. For a flaw hypothesis, record the suspected mechanism in attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
  primitive: "One independently proven security flaw or exploitation capability established during the current research, with direct code, artifact, command, or verifier evidence. Store the underlying root-cause mechanism, not each symptom, experiment, call site, or copy path, as the unit of identity; record attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
  chain: "An end-to-end attacker path linking one or more primitives to demonstrated security impact. Record reachability and affected context; source, sink, and asset relationships are ideal when supported but are not required. A confirmed chain requires proof-of-vulnerability evidence and independent review approval; do not use chain for an isolated flaw or an unlinked list of observations. Record its mechanism in attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
  procedure: "A concise, reusable operational method for performing a bounded research task or verification. Store essential prerequisites and decision points; use a runbook for an executable multi-step command sequence or environment setup.",
  trajectory: "A reusable sequence of significant research choices and results that explains how an investigation advanced or why a path failed. Omit routine narration and transcripts; preserve the discriminating steps and outcome.",
} satisfies Record<MemoryNodeType, string>);

export function resolveMemoryTypeDescriptions(
  input: MemoryTypeDescriptionsInput = {},
): MemoryTypeDescriptions {
  if (!isRecord(input)) {
    throw new Error("Memory type descriptions must be an object.");
  }
  const supported = new Set<string>(MEMORY_NODE_TYPES);
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
  const resolved = Object.fromEntries(MEMORY_NODE_TYPES.map((type) => [
    type,
    normalizeDescription(input[type] ?? DEFAULT_MEMORY_TYPE_DESCRIPTIONS[type]),
  ])) as Record<MemoryNodeType, string>;
  return Object.freeze(resolved);
}

export function formatMemoryTypeDescriptions(
  input: MemoryTypeDescriptionsInput = {},
): string[] {
  const descriptions = resolveMemoryTypeDescriptions(input);
  return MEMORY_NODE_TYPES.map((type) => `- ${type}: ${descriptions[type]}`);
}

function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
