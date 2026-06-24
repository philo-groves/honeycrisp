import { createResearchMemoryRecordId } from "./ids.js";
import { createResearchMemoryProvenance } from "./memory-contracts.js";
import type {
  MemoryRecordStore,
  UpdateMemoryRecordStatusInput,
} from "./memory-record-store.js";
import type {
  ResearchDerivedMemoryRecord,
  ResearchEpisodicMemoryRecord,
  ResearchGoalFrame,
  ResearchGoalNode,
  ResearchGoalStatus,
  ResearchMemoryEvidenceRef,
  ResearchProcedureMemoryRecord,
  ResearchProspectiveMemoryRecord,
  ResearchLoopProcessingResult,
} from "./types.js";

export interface MemoryReflectionInput {
  goalFrame: ResearchGoalFrame;
  loopResult: ResearchLoopProcessingResult;
  records?: readonly ResearchDerivedMemoryRecord[];
  reflectedAt?: string;
  procedurePromotionThreshold?: number;
}

export interface MemoryReflectionResult {
  shouldReflect: boolean;
  updatedGoalFrame: ResearchGoalFrame;
  episodicRecord?: ResearchEpisodicMemoryRecord;
  statusUpdates: readonly UpdateMemoryRecordStatusInput[];
  promotedProcedures: readonly ResearchProcedureMemoryRecord[];
  prospectiveChecks: readonly ResearchProspectiveMemoryRecord[];
  recordWrites: readonly ResearchDerivedMemoryRecord[];
}

export function shouldReflectOnLoop(
  loopResult: ResearchLoopProcessingResult,
): boolean {
  return (
    loopResult.status !== "complete" ||
    loopResult.output.text.trim().length > 0 ||
    loopResult.output.followUpActions.length > 0 ||
    loopResult.output.researchTrace !== undefined
  );
}

export function reflectOnLoopBoundary(
  input: MemoryReflectionInput,
): MemoryReflectionResult {
  const reflectedAt = input.reflectedAt ?? input.loopResult.completedAt;
  const shouldReflect = shouldReflectOnLoop(input.loopResult);
  const updatedGoalFrame = updateGoalFrameFromReflection(
    input.goalFrame,
    input.loopResult,
    reflectedAt,
  );

  if (!shouldReflect) {
    return {
      shouldReflect,
      updatedGoalFrame,
      statusUpdates: [],
      promotedProcedures: [],
      prospectiveChecks: [],
      recordWrites: [],
    };
  }

  const episodicRecord = createLoopEpisodeRecord(
    input.goalFrame,
    input.loopResult,
    reflectedAt,
  );
  const statusUpdates = createStatusUpdates(
    input.records ?? [],
    input.loopResult,
    reflectedAt,
  );
  const promotedProcedures = promoteProcedures(
    input.records ?? [],
    reflectedAt,
    input.procedurePromotionThreshold ?? 2,
  );
  const prospectiveChecks = createProspectiveChecks(
    input.goalFrame,
    input.loopResult,
    reflectedAt,
  );

  return {
    shouldReflect,
    updatedGoalFrame,
    episodicRecord,
    statusUpdates,
    promotedProcedures,
    prospectiveChecks,
    recordWrites: [episodicRecord, ...promotedProcedures, ...prospectiveChecks],
  };
}

export function applyMemoryReflection(
  store: MemoryRecordStore,
  reflection: MemoryReflectionResult,
): void {
  if (reflection.recordWrites.length > 0) {
    store.writeMany(reflection.recordWrites);
  }
  for (const update of reflection.statusUpdates) {
    store.updateStatus(update);
  }
}

function updateGoalFrameFromReflection(
  goalFrame: ResearchGoalFrame,
  loopResult: ResearchLoopProcessingResult,
  reflectedAt: string,
): ResearchGoalFrame {
  const assessment = loopResult.output.researchTrace?.goalAssessment;
  const status = mapAssessmentStatus(assessment?.status) ?? goalFrame.root.status;
  const resultSummary =
    assessment?.rationale ??
    `Reflected loop ${loopResult.id}: ${loopResult.output.text}`;
  const root: ResearchGoalNode = {
    ...goalFrame.root,
    status,
    resultSummary,
    updatedAt: reflectedAt,
  };

  return {
    ...goalFrame,
    root,
    nodes: [root, ...goalFrame.nodes.filter((node) => node.id !== root.id)],
  };
}

function createLoopEpisodeRecord(
  goalFrame: ResearchGoalFrame,
  loopResult: ResearchLoopProcessingResult,
  reflectedAt: string,
): ResearchEpisodicMemoryRecord {
  const sourceEventIds = [loopResult.id];
  const evidenceFor = loopResult.output.evidenceRefs.map(
    (ref): ResearchMemoryEvidenceRef => ({
      id: ref.id,
      relationship: "supports",
      ...(ref.summary ? { summary: ref.summary } : {}),
      ...(typeof ref.confidence === "number"
        ? { confidence: ref.confidence }
        : {}),
    }),
  );

  return {
    id: createResearchMemoryRecordId({
      kind: "episodic",
      sourceEventIds,
      discriminator: "reflection-loop-episode",
    }),
    kind: "episodic",
    status: loopResult.status === "complete" ? "confirmed" : "active",
    summary: loopResult.output.text,
    sourceEventIds,
    evidenceRefIds: evidenceFor.map((ref) => ref.id),
    provenance: createResearchMemoryProvenance({
      sourceEventIds,
      derivation: "runtime_consolidation",
      evidenceFor,
    }),
    goalId: goalFrame.root.id,
    subGoalId: loopResult.subGoalId,
    confidence: loopResult.status === "complete" ? 0.9 : 0.65,
    tags: ["reflection", "loop-result", loopResult.status],
    entities: [],
    createdAt: reflectedAt,
    updatedAt: reflectedAt,
    episodeKind: "loop_result",
  };
}

function createStatusUpdates(
  records: readonly ResearchDerivedMemoryRecord[],
  loopResult: ResearchLoopProcessingResult,
  reflectedAt: string,
): UpdateMemoryRecordStatusInput[] {
  const traceLinks = loopResult.output.researchTrace?.evidenceLinks ?? [];
  const updates: UpdateMemoryRecordStatusInput[] = [];

  for (const record of records) {
    const evidenceFor = traceLinks
      .filter((link) => link.supports?.includes(record.id))
      .map(
        (link): ResearchMemoryEvidenceRef => ({
          id: link.evidenceRefId,
          relationship: "supports",
          ...(link.note ? { summary: link.note } : {}),
        }),
      );
    const evidenceAgainst = traceLinks
      .filter((link) => link.weakens?.includes(record.id))
      .map(
        (link): ResearchMemoryEvidenceRef => ({
          id: link.evidenceRefId,
          relationship: "weakens",
          ...(link.note ? { summary: link.note } : {}),
        }),
      );
    const supersededBy = record.tags
      .find((tag) => tag.startsWith("superseded-by:"))
      ?.slice("superseded-by:".length);

    if (supersededBy) {
      updates.push({
        recordId: record.id,
        status: "superseded",
        updatedAt: reflectedAt,
        supersededByRecordId: supersededBy,
      });
      continue;
    }

    if (record.validUntil && Date.parse(record.validUntil) < Date.parse(reflectedAt)) {
      updates.push({
        recordId: record.id,
        status: "stale",
        updatedAt: reflectedAt,
      });
      continue;
    }

    if (evidenceAgainst.length > 0) {
      updates.push({
        recordId: record.id,
        status: "contradicted",
        updatedAt: reflectedAt,
        confidence: Math.max(0, (record.confidence ?? 0.5) - 0.25),
        evidenceFor,
        evidenceAgainst,
      });
      continue;
    }

    if (evidenceFor.length > 0) {
      updates.push({
        recordId: record.id,
        status: record.status === "candidate" ? "active" : record.status,
        updatedAt: reflectedAt,
        confidence: Math.min(1, (record.confidence ?? 0.5) + 0.15),
        evidenceFor,
      });
    }
  }

  return updates;
}

function promoteProcedures(
  records: readonly ResearchDerivedMemoryRecord[],
  reflectedAt: string,
  threshold: number,
): ResearchProcedureMemoryRecord[] {
  const groups = new Map<string, ResearchProcedureMemoryRecord[]>();

  for (const record of records) {
    if (
      record.kind === "procedure" &&
      record.guidance.durability === "candidate"
    ) {
      const key = normalizeProcedure(record.procedure);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
  }

  return [...groups.values()]
    .filter((group) => group.length >= threshold)
    .map((group) => {
      const first = group[0] as ResearchProcedureMemoryRecord;
      const sourceEventIds = [
        ...new Set(group.flatMap((record) => record.sourceEventIds)),
      ];
      const evidenceFor = group.flatMap(
        (record) => record.provenance.evidenceFor,
      );

      return {
        id: createResearchMemoryRecordId({
          kind: "procedure",
          sourceEventIds,
          discriminator: `promoted:${normalizeProcedure(first.procedure)}`,
        }),
        kind: "procedure",
        status: "confirmed",
        summary: first.summary,
        sourceEventIds,
        evidenceRefIds: [...new Set(evidenceFor.map((ref) => ref.id))],
        provenance: createResearchMemoryProvenance({
          sourceEventIds,
          derivation: "runtime_consolidation",
          evidenceFor,
          derivedFromRecordIds: group.map((record) => record.id),
        }),
        confidence: Math.min(1, 0.55 + group.length * 0.15),
        tags: ["procedure-promoted", "reflection"],
        entities: [...new Set(group.flatMap((record) => record.entities))],
        createdAt: reflectedAt,
        updatedAt: reflectedAt,
        procedure: first.procedure,
        guidance: {
          durability: "durable",
          promotionReason: "repeated_usefulness",
          usefulCount: group.length,
          supportingEventIds: sourceEventIds,
        },
      };
    });
}

function createProspectiveChecks(
  goalFrame: ResearchGoalFrame,
  loopResult: ResearchLoopProcessingResult,
  reflectedAt: string,
): ResearchProspectiveMemoryRecord[] {
  return loopResult.output.followUpActions.map((action, index) => {
    const sourceEventIds = [loopResult.id];
    const evidenceFor: ResearchMemoryEvidenceRef[] = [
      {
        id: `${loopResult.id}:follow-up:${index}`,
        relationship: "derived_from",
        summary: action,
      },
    ];

    return {
      id: createResearchMemoryRecordId({
        kind: "prospective_check",
        sourceEventIds,
        discriminator: `follow-up:${index}:${action}`,
      }),
      kind: "prospective_check",
      status: "active",
      summary: action,
      sourceEventIds,
      evidenceRefIds: evidenceFor.map((ref) => ref.id),
      provenance: createResearchMemoryProvenance({
        sourceEventIds,
        derivation: "runtime_consolidation",
        evidenceFor,
      }),
      goalId: goalFrame.root.id,
      subGoalId: loopResult.subGoalId,
      confidence: 0.75,
      tags: ["prospective-check", "reflection", "follow-up"],
      entities: [],
      createdAt: reflectedAt,
      updatedAt: reflectedAt,
      check: action,
      trigger: "Before the next memory-driven controller decision.",
    };
  });
}

function mapAssessmentStatus(
  status: string | undefined,
): ResearchGoalStatus | undefined {
  switch (status) {
    case "complete":
      return "complete";
    case "blocked":
      return "blocked";
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

function normalizeProcedure(procedure: string): string {
  return procedure.replace(/\s+/g, " ").trim().toLowerCase();
}
