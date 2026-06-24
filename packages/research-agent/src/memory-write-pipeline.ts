import { createResearchMemoryRecordId } from "./ids.js";
import { createResearchMemoryProvenance } from "./memory-contracts.js";
import type {
  ResearchArtifactRef,
  ResearchBaseMemoryRecord,
  ResearchDerivedMemoryRecord,
  ResearchDerivedMemoryStatus,
  ResearchEpisodicMemoryRecord,
  ResearchEvent,
  ResearchEvidenceMemoryRecord,
  ResearchHypothesisMemoryRecord,
  ResearchMemoryDerivationKind,
  ResearchMemoryEvidenceRef,
  ResearchMemoryRecordKind,
  ResearchProcedureMemoryRecord,
  ResearchProspectiveMemoryRecord,
  ResearchSemanticClaimRecord,
  ResearchWorkingMemoryRecord,
} from "./types.js";

export interface MemoryWritePipeline {
  derive(event: ResearchEvent): readonly ResearchDerivedMemoryRecord[];
  deriveMany(events: readonly ResearchEvent[]): readonly ResearchDerivedMemoryRecord[];
}

export function createDeterministicMemoryWritePipeline(): MemoryWritePipeline {
  return new DeterministicMemoryWritePipeline();
}

export class DeterministicMemoryWritePipeline implements MemoryWritePipeline {
  derive(event: ResearchEvent): readonly ResearchDerivedMemoryRecord[] {
    switch (event.kind) {
      case "tool.observed":
        return [createToolObservationRecord(event)];
      case "goal.created":
      case "goal.updated":
        return [createGoalEpisodeRecord(event)];
      case "memory.decision":
        return [
          createEpisodeRecord(event, {
            episodeKind: "memory_decision",
            summary: summarizeMemoryEvent(event),
            status: "active",
            confidence: 0.8,
            tags: ["memory-decision"],
          }),
        ];
      case "memory.routed":
        return [
          createWorkingRecord(event, {
            summary: summarizeMemoryEvent(event),
            confidence: 0.75,
            tags: ["memory-routing"],
          }),
        ];
      case "context.compiled":
        return [
          createWorkingRecord(event, {
            summary: summarizeMemoryEvent(event),
            confidence: 0.7,
            tags: ["context-reference"],
          }),
        ];
      case "loop.planned":
        return [
          createEpisodeRecord(event, {
            episodeKind: "loop_plan",
            summary: summarizeMemoryEvent(event),
            status: "active",
            confidence: 0.75,
            tags: ["loop-plan"],
          }),
        ];
      case "loop.processed":
        return [
          createEpisodeRecord(event, {
            episodeKind: "loop_result",
            summary: summarizeMemoryEvent(event),
            status: isTerminalLoopResult(event) ? "confirmed" : "active",
            confidence: 0.85,
            tags: ["loop-result"],
          }),
        ];
      case "artifact.tombstoned":
        return [
          createEpisodeRecord(event, {
            episodeKind: "artifact_lifecycle",
            summary: summarizeMemoryEvent(event),
            status: "confirmed",
            confidence: 0.9,
            tags: ["artifact", "tombstone"],
          }),
        ];
      case "tool.requested":
        return [
          createEpisodeRecord(event, {
            episodeKind: "tool_request",
            summary: summarizeMemoryEvent(event),
            status: "active",
            confidence: 0.7,
            tags: ["tool-request"],
          }),
        ];
      case "model.visible_note":
        return createVisibleNoteRecords(event);
      case "model.claim":
        return [createSemanticClaimRecord(event)];
      case "model.hypothesis":
        return [createHypothesisRecord(event)];
      case "user.commitment":
        return [createProspectiveCommitmentRecord(event)];
      case "error.observed":
        return [
          createErrorEvidenceRecord(event),
          createEpisodeRecord(event, {
            episodeKind: "error",
            summary: summarizeMemoryEvent(event),
            status: "active",
            confidence: 0.85,
            tags: ["error", "uncertainty"],
          }),
        ];
    }
  }

  deriveMany(
    events: readonly ResearchEvent[],
  ): readonly ResearchDerivedMemoryRecord[] {
    return events.flatMap((event) => [...this.derive(event)]);
  }
}

export function summarizeMemoryEvent(event: ResearchEvent): string {
  const payload = event.payload;
  if (isRecord(payload)) {
    const summary = readFirstString(payload, [
      "summary",
      "claim",
      "hypothesis",
      "procedure",
      "check",
      "objective",
      "text",
      "rationale",
    ]);
    if (summary) {
      return truncate(summary, 700);
    }
  }

  return truncate(`${event.kind}: ${formatPayload(payload)}`, 700);
}

function createToolObservationRecord(
  event: ResearchEvent,
): ResearchEvidenceMemoryRecord {
  const summary = summarizeMemoryEvent(event);
  const evidenceFor = [
    createSourceEventEvidenceRef(event, "derived_from", summary, 1),
  ];

  return {
    ...createBaseRecord(event, {
      kind: "evidence",
      status: "confirmed",
      summary,
      derivation: "direct_evidence",
      confidence: readConfidence(event.payload, 0.95),
      tags: ["tool-observation"],
      evidenceFor,
    }),
    kind: "evidence",
    evidenceKind: "tool_observation",
    payloadRef: {
      sourceEventId: event.id,
      ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
    },
  };
}

function createGoalEpisodeRecord(
  event: ResearchEvent,
): ResearchEpisodicMemoryRecord {
  return createEpisodeRecord(event, {
    episodeKind: "goal_transition",
    summary: summarizeMemoryEvent(event),
    status: isTerminalGoalTransition(event) ? "confirmed" : "active",
    confidence: 0.85,
    tags: ["goal-transition"],
  });
}

function createEpisodeRecord(
  event: ResearchEvent,
  input: {
    episodeKind: ResearchEpisodicMemoryRecord["episodeKind"];
    summary: string;
    status: ResearchDerivedMemoryStatus;
    confidence: number;
    tags: readonly string[];
  },
): ResearchEpisodicMemoryRecord {
  return {
    ...createBaseRecord(event, {
      kind: "episodic",
      status: input.status,
      summary: input.summary,
      derivation: "runtime_consolidation",
      confidence: readConfidence(event.payload, input.confidence),
      tags: input.tags,
      evidenceFor: [
        createSourceEventEvidenceRef(event, "derived_from", input.summary, 0.9),
      ],
    }),
    kind: "episodic",
    episodeKind: input.episodeKind,
  };
}

function createVisibleNoteRecords(
  event: ResearchEvent,
): readonly ResearchDerivedMemoryRecord[] {
  const records: ResearchDerivedMemoryRecord[] = [
    createWorkingRecord(event, {
      summary: summarizeMemoryEvent(event),
      confidence: 0.7,
      tags: ["visible-note"],
    }),
  ];
  const procedure = isRecord(event.payload)
    ? readFirstString(event.payload, ["procedure"])
    : undefined;

  if (procedure) {
    records.push(createProcedureRecord(event, procedure));
  }

  return records;
}

function createWorkingRecord(
  event: ResearchEvent,
  input: {
    summary: string;
    confidence: number;
    tags: readonly string[];
  },
): ResearchWorkingMemoryRecord {
  return {
    ...createBaseRecord(event, {
      kind: "working",
      status: "active",
      summary: input.summary,
      derivation: "model_visible_inference",
      confidence: readConfidence(event.payload, input.confidence),
      tags: input.tags,
      evidenceFor: createPayloadEvidenceRefs(event, "supports"),
      evidenceAgainst: createPayloadEvidenceRefs(event, "weakens"),
    }),
    kind: "working",
    ...(event.loopId ? { expiresAfterLoopId: event.loopId } : {}),
  };
}

function createSemanticClaimRecord(
  event: ResearchEvent,
): ResearchSemanticClaimRecord {
  const claim = isRecord(event.payload)
    ? (readFirstString(event.payload, ["claim", "text", "summary"]) ??
      summarizeMemoryEvent(event))
    : summarizeMemoryEvent(event);

  return {
    ...createBaseRecord(event, {
      kind: "semantic_claim",
      status: "candidate",
      summary: truncate(claim, 700),
      derivation: "model_visible_inference",
      confidence: readConfidence(event.payload, 0.55),
      tags: ["model-claim"],
      evidenceFor: createPayloadEvidenceRefs(event, "supports"),
      evidenceAgainst: createPayloadEvidenceRefs(event, "weakens"),
    }),
    kind: "semantic_claim",
    claim,
  };
}

function createHypothesisRecord(
  event: ResearchEvent,
): ResearchHypothesisMemoryRecord {
  const hypothesis = isRecord(event.payload)
    ? (readFirstString(event.payload, ["hypothesis", "text", "summary"]) ??
      summarizeMemoryEvent(event))
    : summarizeMemoryEvent(event);

  return {
    ...createBaseRecord(event, {
      kind: "hypothesis",
      status: "candidate",
      summary: truncate(hypothesis, 700),
      derivation: "model_visible_hypothesis",
      confidence: readConfidence(event.payload, 0.65),
      tags: ["model-hypothesis"],
      evidenceFor: createPayloadEvidenceRefs(event, "supports"),
      evidenceAgainst: createPayloadEvidenceRefs(event, "weakens"),
    }),
    kind: "hypothesis",
    hypothesis,
  };
}

function createProcedureRecord(
  event: ResearchEvent,
  procedure: string,
): ResearchProcedureMemoryRecord {
  return {
    ...createBaseRecord(event, {
      kind: "procedure",
      status: "candidate",
      summary: truncate(procedure, 700),
      derivation: "model_visible_inference",
      confidence: readConfidence(event.payload, 0.45),
      tags: ["procedure-candidate"],
      evidenceFor: createPayloadEvidenceRefs(event, "supports"),
      evidenceAgainst: createPayloadEvidenceRefs(event, "weakens"),
      discriminator: "procedure",
    }),
    kind: "procedure",
    procedure,
    guidance: {
      durability: "candidate",
      promotionRequired: "repeated_usefulness_or_explicit_promotion",
    },
  };
}

function createProspectiveCommitmentRecord(
  event: ResearchEvent,
): ResearchProspectiveMemoryRecord {
  const payload = isRecord(event.payload) ? event.payload : {};
  const check =
    readFirstString(payload, ["check", "commitment", "text", "summary"]) ??
    summarizeMemoryEvent(event);
  const trigger =
    readFirstString(payload, ["trigger"]) ??
    "Carry forward whenever this user's constraints affect the active goal.";

  return {
    ...createBaseRecord(event, {
      kind: "prospective_check",
      status: "confirmed",
      summary: truncate(check, 700),
      derivation: "user_commitment",
      confidence: readConfidence(event.payload, 1),
      tags: ["user-commitment", "prospective-check"],
      evidenceFor: [
        createSourceEventEvidenceRef(event, "derived_from", check, 1),
      ],
      discriminator: "user-commitment",
    }),
    kind: "prospective_check",
    check,
    trigger,
  };
}

function createErrorEvidenceRecord(
  event: ResearchEvent,
): ResearchEvidenceMemoryRecord {
  const summary = summarizeMemoryEvent(event);

  return {
    ...createBaseRecord(event, {
      kind: "evidence",
      status: "active",
      summary,
      derivation: "direct_evidence",
      confidence: readConfidence(event.payload, 0.85),
      tags: ["error", "contradiction", "uncertainty"],
      evidenceFor: [
        createSourceEventEvidenceRef(event, "derived_from", summary, 0.9),
      ],
      evidenceAgainst: createPayloadEvidenceRefs(event, "weakens"),
      discriminator: "error",
    }),
    kind: "evidence",
    evidenceKind: "runtime",
    payloadRef: {
      sourceEventId: event.id,
      ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
    },
  };
}

function createBaseRecord(
  event: ResearchEvent,
  input: {
    kind: ResearchMemoryRecordKind;
    status: ResearchDerivedMemoryStatus;
    summary: string;
    derivation: ResearchMemoryDerivationKind;
    confidence: number;
    tags: readonly string[];
    evidenceFor?: readonly ResearchMemoryEvidenceRef[];
    evidenceAgainst?: readonly ResearchMemoryEvidenceRef[];
    artifactRefs?: readonly ResearchArtifactRef[];
    discriminator?: string;
  },
): ResearchBaseMemoryRecord {
  const evidenceFor = input.evidenceFor ?? [];
  const evidenceAgainst = input.evidenceAgainst ?? [];
  const sourceEventIds = [event.id];
  const evidenceRefIds = [
    ...evidenceFor.map((ref) => ref.id),
    ...evidenceAgainst.map((ref) => ref.id),
  ];
  const tags = createTags(event, input.kind, input.tags);

  return {
    id: createResearchMemoryRecordId({
      kind: input.kind,
      sourceEventIds,
      discriminator: input.discriminator ?? input.kind,
    }),
    kind: input.kind,
    status: input.status,
    summary: input.summary,
    sourceEventIds,
    evidenceRefIds,
    provenance: createResearchMemoryProvenance({
      sourceEventIds,
      derivation: input.derivation,
      evidenceFor,
      evidenceAgainst,
      artifactRefs: input.artifactRefs ?? event.artifactRefs ?? [],
    }),
    confidence: input.confidence,
    tags,
    entities: extractEntities(event.payload),
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.subGoalId ? { subGoalId: event.subGoalId } : {}),
  };
}

function createPayloadEvidenceRefs(
  event: ResearchEvent,
  direction: "supports" | "weakens",
): ResearchMemoryEvidenceRef[] {
  if (!isRecord(event.payload)) {
    return [];
  }

  const keys =
    direction === "supports"
      ? ["evidenceRefIds", "evidenceForRefIds", "supports"]
      : ["evidenceAgainstRefIds", "weakens", "contradicts"];
  const relationship = direction === "supports" ? "supports" : "weakens";

  return keys.flatMap((key) =>
    readStringArray(event.payload as Record<string, unknown>, key).map((id) => ({
      id,
      relationship,
      summary: `Payload ${key} reference from ${event.kind}`,
    })),
  );
}

function createSourceEventEvidenceRef(
  event: ResearchEvent,
  relationship: ResearchMemoryEvidenceRef["relationship"],
  summary: string,
  confidence: number,
): ResearchMemoryEvidenceRef {
  return {
    id: `${event.id}:payload`,
    relationship,
    sourceEventId: event.id,
    summary,
    confidence,
  };
}

function isTerminalGoalTransition(event: ResearchEvent): boolean {
  if (!isRecord(event.payload)) {
    return false;
  }

  const statusAfter = readFirstString(event.payload, ["statusAfter", "status"]);

  return statusAfter === "complete" || statusAfter === "stopped";
}

function isTerminalLoopResult(event: ResearchEvent): boolean {
  if (!isRecord(event.payload)) {
    return false;
  }

  const status = readFirstString(event.payload, ["status"]);

  return status === "complete" || status === "blocked" || status === "error";
}

function createTags(
  event: ResearchEvent,
  kind: ResearchMemoryRecordKind,
  tags: readonly string[],
): readonly string[] {
  const tagSet = new Set<string>([kind, event.kind, ...tags]);
  if (isRecord(event.payload)) {
    const traceKind = readFirstString(event.payload, ["traceKind"]);
    if (traceKind) {
      tagSet.add(`trace:${traceKind}`);
    }
  }

  return [...tagSet].sort();
}

function extractEntities(payload: unknown): readonly string[] {
  if (!isRecord(payload)) {
    return [];
  }

  return readStringArray(payload, "entities");
}

function readConfidence(payload: unknown, fallback: number): number {
  if (isRecord(payload)) {
    const confidence = payload.confidence;
    if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
      return confidence;
    }
  }

  return fallback;
}

function readFirstString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function readStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}...`;
}
