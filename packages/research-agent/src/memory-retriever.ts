import type { MemoryRecordStore } from "./memory-record-store.js";
import type {
  ResearchActionClass,
  ResearchClaimGraphEdge,
  ResearchCompletionGate,
  ResearchDerivedMemoryRecord,
  ResearchEvent,
  ResearchFindingStatus,
  ResearchGoalNode,
  ResearchGovernancePolicy,
  ResearchSubGoal,
  ResearchToolDescriptor,
} from "./types.js";

export interface MemoryRetrievalInput {
  activeGoal: ResearchGoalNode;
  activeSubGoal?: ResearchSubGoal;
  completionGates?: readonly ResearchCompletionGate[];
  stopGates?: readonly ResearchCompletionGate[];
  recentEvents?: readonly ResearchEvent[];
  openQuestions?: readonly string[];
  actionClass?: ResearchActionClass;
  tools?: readonly ResearchToolDescriptor[];
  governance?: ResearchGovernancePolicy;
  records?: readonly ResearchDerivedMemoryRecord[];
  recordStore?: MemoryRecordStore;
  claimGraphEdges?: readonly ResearchClaimGraphEdge[];
  limit?: number;
}

export interface MemoryRetrievalCandidate {
  record: ResearchDerivedMemoryRecord;
  score: number;
  reasons: readonly string[];
  warnings: readonly string[];
}

export interface MemoryRetrievalResult {
  candidates: readonly MemoryRetrievalCandidate[];
  directEvidence: readonly MemoryRetrievalCandidate[];
  findings: readonly MemoryRetrievalCandidate[];
  contradictions: readonly MemoryRetrievalCandidate[];
  procedures: readonly MemoryRetrievalCandidate[];
  prospectiveChecks: readonly MemoryRetrievalCandidate[];
}

export interface MemoryRetriever {
  retrieve(input: MemoryRetrievalInput): MemoryRetrievalResult;
}

export function createDeterministicMemoryRetriever(): MemoryRetriever {
  return new DeterministicMemoryRetriever();
}

export class DeterministicMemoryRetriever implements MemoryRetriever {
  retrieve(input: MemoryRetrievalInput): MemoryRetrievalResult {
    const records = loadRecords(input).filter(isOrdinaryRecord);
    const graphEdges = loadGraphEdges(input);
    const graphCentrality = createGraphCentrality(graphEdges);
    const recentEventIds = new Set((input.recentEvents ?? []).map((event) => event.id));
    const queryTokens = createQueryTokens(input);
    const scored = records
      .filter((record) => isApplicableRecord(record, input.actionClass))
      .map((record) =>
        scoreRecord({
          record,
          input,
          queryTokens,
          recentEventIds,
          graphCentrality,
        }),
      )
      .filter((candidate) => candidate.score > 0 || candidate.warnings.length > 0)
      .sort(sortCandidates)
      .slice(0, input.limit ?? 50);

    return {
      candidates: scored,
      directEvidence: scored.filter(
        (candidate) =>
          candidate.record.kind === "evidence" &&
          !isContradictionRecord(candidate.record),
      ),
      findings: scored.filter((candidate) => candidate.record.kind === "finding"),
      contradictions: scored.filter((candidate) =>
        isContradictionCandidate(candidate),
      ),
      procedures: scored.filter((candidate) => candidate.record.kind === "procedure"),
      prospectiveChecks: scored.filter(
        (candidate) => candidate.record.kind === "prospective_check",
      ),
    };
  }
}

function scoreRecord(input: {
  record: ResearchDerivedMemoryRecord;
  input: MemoryRetrievalInput;
  queryTokens: ReadonlySet<string>;
  recentEventIds: ReadonlySet<string>;
  graphCentrality: ReadonlyMap<string, number>;
}): MemoryRetrievalCandidate {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  const relevance = scoreTextRelevance(input.record, input.queryTokens);
  if (relevance > 0) {
    score += relevance;
    reasons.push(`Relevant to active query tokens (+${relevance}).`);
  }

  if (input.record.goalId && input.record.goalId === input.input.activeGoal.id) {
    score += 15;
    reasons.push("Matches the active goal id (+15).");
  } else if (input.record.goalId) {
    warnings.push(
      "From a different goal; use as prior context only, not current completion proof.",
    );
  }
  if (
    input.input.activeSubGoal?.id &&
    input.record.subGoalId === input.input.activeSubGoal.id
  ) {
    score += 10;
    reasons.push("Matches the active subgoal id (+10).");
  }

  const recentOverlap = input.record.sourceEventIds.some((eventId) =>
    input.recentEventIds.has(eventId),
  );
  if (recentOverlap) {
    score += 12;
    reasons.push("Backed by a recent event (+12).");
  }

  const confidence = input.record.confidence ?? 0.5;
  const confidenceScore = Math.round(confidence * 20);
  score += confidenceScore;
  reasons.push(`Confidence contributes +${confidenceScore}.`);

  const evidenceQuality = scoreEvidenceQuality(input.record);
  if (evidenceQuality > 0) {
    score += evidenceQuality;
    reasons.push(`Evidence quality contributes +${evidenceQuality}.`);
  }

  if (input.record.kind === "evidence") {
    score += input.record.status === "confirmed" ? 25 : 15;
    reasons.push("Direct evidence is prioritized.");
  }
  if (input.record.kind === "procedure") {
    score += 12;
    reasons.push("Applicable procedure for this action class (+12).");
  }
  if (input.record.kind === "finding") {
    const findingScore = scoreFindingStatus(input.record.findingStatus);
    score += findingScore;
    reasons.push(`Finding status contributes +${findingScore}.`);
    if (input.record.findingStatus === "needs_evidence") {
      warnings.push("Finding still needs evidence.");
    }
  }
  if (input.record.kind === "prospective_check") {
    const triggerScore = scoreProspectiveTrigger(input.record, input.input);
    score += triggerScore;
    reasons.push(`Prospective trigger contributes +${triggerScore}.`);
  }

  const centrality = input.graphCentrality.get(input.record.id) ?? 0;
  if (centrality > 0) {
    const centralityScore = Math.min(10, centrality * 2);
    score += centralityScore;
    reasons.push(`Claim graph centrality contributes +${centralityScore}.`);
  }

  const recencyScore = scoreRecency(input.record.updatedAt);
  score += recencyScore;
  if (recencyScore > 0) {
    reasons.push(`Updated-time recency contributes +${recencyScore}.`);
  }

  const tokenCostPenalty = Math.min(10, Math.floor(input.record.summary.length / 120));
  if (tokenCostPenalty > 0) {
    score -= tokenCostPenalty;
    reasons.push(`Summary length cost subtracts ${tokenCostPenalty}.`);
  }

  if (input.record.status === "contradicted") {
    warnings.push("Record is contradicted and should be handled with care.");
    score += 10;
  }
  if (input.record.status === "stale") {
    warnings.push("Record is stale.");
    score -= 15;
  }
  if (input.record.provenance.evidenceAgainst.length > 0) {
    warnings.push("Record has evidence against it.");
    score += 8;
  }
  if (confidence < 0.5) {
    warnings.push("Record has weak confidence.");
    score -= 5;
  }
  if (isContradictionRecord(input.record)) {
    warnings.push("Record represents contradiction or uncertainty.");
    score += 8;
  }

  return {
    record: input.record,
    score: Math.round(score),
    reasons,
    warnings,
  };
}

function loadRecords(input: MemoryRetrievalInput): readonly ResearchDerivedMemoryRecord[] {
  if (input.records) {
    return input.records;
  }
  if (input.recordStore) {
    return input.recordStore.list();
  }

  return [];
}

function loadGraphEdges(input: MemoryRetrievalInput): readonly ResearchClaimGraphEdge[] {
  if (input.claimGraphEdges) {
    return input.claimGraphEdges;
  }
  if (input.recordStore) {
    return input.recordStore.listClaimGraphEdges({ includeEvidenceEdges: true });
  }

  return [];
}

function isOrdinaryRecord(record: ResearchDerivedMemoryRecord): boolean {
  if (record.status === "tombstoned" || record.status === "superseded") {
    return false;
  }
  if (record.kind === "finding") {
    return (
      record.findingStatus !== "rejected" &&
      record.findingStatus !== "out_of_scope" &&
      record.findingStatus !== "superseded" &&
      record.findingStatus !== "tombstoned"
    );
  }

  return true;
}

function isApplicableRecord(
  record: ResearchDerivedMemoryRecord,
  actionClass: ResearchActionClass | undefined,
): boolean {
  if (record.kind !== "procedure") {
    return true;
  }

  const actionTags = record.tags
    .filter((tag) => tag.startsWith("action:"))
    .map((tag) => tag.slice("action:".length));

  return actionTags.length === 0 || actionTags.includes(actionClass ?? "");
}

function createQueryTokens(input: MemoryRetrievalInput): ReadonlySet<string> {
  const parts = [
    input.activeGoal.objective,
    input.activeSubGoal?.objective,
    ...(input.completionGates ?? []).map((gate) => gate.description),
    ...(input.stopGates ?? []).map((gate) => gate.description),
    ...(input.openQuestions ?? []),
    input.actionClass,
  ].filter((part): part is string => typeof part === "string");

  return new Set(parts.flatMap(tokenize));
}

function scoreTextRelevance(
  record: ResearchDerivedMemoryRecord,
  queryTokens: ReadonlySet<string>,
): number {
  const recordTokens = new Set(
    [
      record.summary,
      ...record.tags,
      ...record.entities,
      ...record.evidenceRefIds,
    ].flatMap(tokenize),
  );
  let overlap = 0;

  for (const token of recordTokens) {
    if (queryTokens.has(token)) {
      overlap += 1;
    }
  }

  return Math.min(30, overlap * 5);
}

function scoreEvidenceQuality(record: ResearchDerivedMemoryRecord): number {
  let score = 0;
  score += Math.min(15, record.provenance.evidenceFor.length * 5);
  if (record.provenance.derivation === "direct_evidence") {
    score += 10;
  }
  if (record.provenance.artifactRefs.length > 0) {
    score += 5;
  }

  return score;
}

function scoreProspectiveTrigger(
  record: ResearchDerivedMemoryRecord,
  input: MemoryRetrievalInput,
): number {
  if (record.kind !== "prospective_check") {
    return 0;
  }

  const triggerTokens = new Set(tokenize(record.trigger));
  const activeTokens = createQueryTokens(input);
  const matched = [...triggerTokens].some((token) => activeTokens.has(token));

  return matched || record.tags.includes("user-commitment") ? 20 : 5;
}

function scoreFindingStatus(status: ResearchFindingStatus): number {
  switch (status) {
    case "verified":
      return 35;
    case "supported":
      return 28;
    case "candidate":
      return 12;
    case "needs_evidence":
      return 4;
    case "superseded":
    case "rejected":
    case "out_of_scope":
    case "tombstoned":
      return -30;
  }
}

function scoreRecency(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return 0;
  }

  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays <= 1) {
    return 10;
  }
  if (ageDays <= 7) {
    return 6;
  }
  if (ageDays <= 30) {
    return 3;
  }

  return 0;
}

function createGraphCentrality(
  graphEdges: readonly ResearchClaimGraphEdge[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const edge of graphEdges) {
    counts.set(edge.sourceRecordId, (counts.get(edge.sourceRecordId) ?? 0) + 1);
    if (edge.targetRecordId) {
      counts.set(edge.targetRecordId, (counts.get(edge.targetRecordId) ?? 0) + 1);
    }
  }

  return counts;
}

function isContradictionCandidate(candidate: MemoryRetrievalCandidate): boolean {
  return (
    isContradictionRecord(candidate.record) ||
    candidate.record.status === "contradicted" ||
    candidate.record.provenance.evidenceAgainst.length > 0
  );
}

function isContradictionRecord(record: ResearchDerivedMemoryRecord): boolean {
  return (
    record.tags.includes("contradiction") ||
    record.tags.includes("uncertainty") ||
    record.status === "contradicted"
  );
}

function sortCandidates(
  left: MemoryRetrievalCandidate,
  right: MemoryRetrievalCandidate,
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.record.id.localeCompare(right.record.id);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}
