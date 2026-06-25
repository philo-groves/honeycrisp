import type {
  ResearchArtifactRef,
  ResearchDerivedMemoryStatus,
  ResearchFindingStatus,
  ResearchMemoryDerivationKind,
  ResearchMemoryEvidenceRef,
  ResearchMemoryProvenance,
  ResearchMemoryRecordKind,
  ResearchProofAttemptStatus,
  ResearchProofMethodKind,
  ResearchProofObligationStatus,
  ResearchProofResultStatus,
  ResearchProofSubjectKind,
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
  "finding",
  "belief",
  "procedure",
  "prospective_check",
  "working",
] as const satisfies readonly ResearchMemoryRecordKind[];

export const RESEARCH_FINDING_STATUSES = [
  "candidate",
  "needs_evidence",
  "supported",
  "verified",
  "superseded",
  "rejected",
  "out_of_scope",
  "tombstoned",
] as const satisfies readonly ResearchFindingStatus[];

export const RESEARCH_PROOF_SUBJECT_KINDS = [
  "goal",
  "sub_goal",
  "memory_record",
  "artifact",
  "external",
] as const satisfies readonly ResearchProofSubjectKind[];

export const RESEARCH_PROOF_METHOD_KINDS = [
  "mathematical_proof",
  "empirical_reproduction",
  "static_analysis",
  "dynamic_execution",
  "artifact_validation",
  "investigation_corroboration",
  "human_review",
  "domain_skill",
  "mcp_provider",
] as const satisfies readonly ResearchProofMethodKind[];

export const RESEARCH_PROOF_OBLIGATION_STATUSES = [
  "open",
  "in_progress",
  "satisfied",
  "failed",
  "blocked",
  "superseded",
  "tombstoned",
] as const satisfies readonly ResearchProofObligationStatus[];

export const RESEARCH_PROOF_ATTEMPT_STATUSES = [
  "planned",
  "running",
  "completed",
  "failed",
  "blocked",
  "superseded",
] as const satisfies readonly ResearchProofAttemptStatus[];

export const RESEARCH_PROOF_RESULT_STATUSES = [
  "pass",
  "fail",
  "inconclusive",
  "blocked",
  "superseded",
] as const satisfies readonly ResearchProofResultStatus[];

const derivedMemoryStatusSet = new Set<string>(
  RESEARCH_DERIVED_MEMORY_STATUSES,
);
const memoryRecordKindSet = new Set<string>(RESEARCH_MEMORY_RECORD_KINDS);
const findingStatusSet = new Set<string>(RESEARCH_FINDING_STATUSES);
const proofSubjectKindSet = new Set<string>(RESEARCH_PROOF_SUBJECT_KINDS);
const proofMethodKindSet = new Set<string>(RESEARCH_PROOF_METHOD_KINDS);
const proofObligationStatusSet = new Set<string>(
  RESEARCH_PROOF_OBLIGATION_STATUSES,
);
const proofAttemptStatusSet = new Set<string>(
  RESEARCH_PROOF_ATTEMPT_STATUSES,
);
const proofResultStatusSet = new Set<string>(RESEARCH_PROOF_RESULT_STATUSES);

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

export function isResearchFindingStatus(
  value: string,
): value is ResearchFindingStatus {
  return findingStatusSet.has(value);
}

export function isResearchProofSubjectKind(
  value: string,
): value is ResearchProofSubjectKind {
  return proofSubjectKindSet.has(value);
}

export function isResearchProofMethodKind(
  value: string,
): value is ResearchProofMethodKind {
  return proofMethodKindSet.has(value);
}

export function isResearchProofObligationStatus(
  value: string,
): value is ResearchProofObligationStatus {
  return proofObligationStatusSet.has(value);
}

export function isResearchProofAttemptStatus(
  value: string,
): value is ResearchProofAttemptStatus {
  return proofAttemptStatusSet.has(value);
}

export function isResearchProofResultStatus(
  value: string,
): value is ResearchProofResultStatus {
  return proofResultStatusSet.has(value);
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
