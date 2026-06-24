import type {
  ResearchArtifactRef,
  ResearchDerivedMemoryStatus,
  ResearchMemoryDerivationKind,
  ResearchMemoryEvidenceRef,
  ResearchMemoryProvenance,
  ResearchMemoryRecordKind,
} from "./types.js";

export const RESEARCH_DERIVED_MEMORY_STATUSES = [
  "candidate",
  "active",
  "confirmed",
  "contradicted",
  "superseded",
  "stale",
  "tombstoned",
] as const satisfies readonly ResearchDerivedMemoryStatus[];

export const RESEARCH_MEMORY_RECORD_KINDS = [
  "evidence",
  "episodic",
  "semantic_claim",
  "hypothesis",
  "belief",
  "procedure",
  "prospective_check",
  "working",
] as const satisfies readonly ResearchMemoryRecordKind[];

const derivedMemoryStatusSet = new Set<string>(
  RESEARCH_DERIVED_MEMORY_STATUSES,
);
const memoryRecordKindSet = new Set<string>(RESEARCH_MEMORY_RECORD_KINDS);

export function isResearchDerivedMemoryStatus(
  value: string,
): value is ResearchDerivedMemoryStatus {
  return derivedMemoryStatusSet.has(value);
}

export function isResearchMemoryRecordKind(
  value: string,
): value is ResearchMemoryRecordKind {
  return memoryRecordKindSet.has(value);
}

export function createResearchMemoryProvenance(input: {
  sourceEventIds: readonly string[];
  derivation: ResearchMemoryDerivationKind;
  evidenceFor?: readonly ResearchMemoryEvidenceRef[];
  evidenceAgainst?: readonly ResearchMemoryEvidenceRef[];
  artifactRefs?: readonly ResearchArtifactRef[];
  derivedFromRecordIds?: readonly string[];
  note?: string;
}): ResearchMemoryProvenance {
  if (input.sourceEventIds.length === 0) {
    throw new Error("Memory provenance requires at least one source event id.");
  }

  return {
    sourceEventIds: [...input.sourceEventIds],
    evidenceFor: [...(input.evidenceFor ?? [])],
    evidenceAgainst: [...(input.evidenceAgainst ?? [])],
    artifactRefs: [...(input.artifactRefs ?? [])],
    derivedFromRecordIds: [...(input.derivedFromRecordIds ?? [])],
    derivation: input.derivation,
    ...(input.note ? { note: input.note } : {}),
  };
}
