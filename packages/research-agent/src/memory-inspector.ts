import type { ResearchContextPacketV2 } from "./context-packet-v2.js";
import type {
  MemoryDrivenControllerDecision,
} from "./memory-controller-v2.js";
import {
  createDeterministicMemoryRetriever,
  type MemoryRetrievalInput,
  type MemoryRetrievalResult,
} from "./memory-retriever.js";
import type { MemoryEventLog } from "./memory-event-log.js";
import type { MemoryRecordStore } from "./memory-record-store.js";
import type { ProofStore } from "./proof-store.js";
import type {
  ResearchClaimGraphEdge,
  ResearchDerivedMemoryRecord,
  ResearchEvent,
  ResearchFindingMemoryRecord,
  ResearchProofStateReadModel,
} from "./types.js";

export interface RejectedMemoryEventInspection {
  event?: unknown;
  reason: string;
}

export interface MemoryEventTimelineEntry {
  id: string;
  sequence?: number;
  kind: ResearchEvent["kind"];
  timestamp: string;
  goalId?: string;
  summary: string;
}

export interface MemoryDebugCaptureInput {
  rejectedEvents?: readonly RejectedMemoryEventInspection[];
  candidateWrites?: readonly ResearchDerivedMemoryRecord[];
  retrieval?: MemoryRetrievalResult;
  contextPacketV2?: ResearchContextPacketV2;
  decision?: MemoryDrivenControllerDecision;
}

export interface MemoryDebugCapture {
  acceptedEvents: readonly MemoryEventTimelineEntry[];
  rejectedEvents: readonly RejectedMemoryEventInspection[];
  candidateWrites: readonly {
    recordId: string;
    kind: ResearchDerivedMemoryRecord["kind"];
    status: ResearchDerivedMemoryRecord["status"];
    summary: string;
  }[];
  committedWrites: readonly {
    recordId: string;
    kind: ResearchDerivedMemoryRecord["kind"];
    status: ResearchDerivedMemoryRecord["status"];
    summary: string;
  }[];
  retrievalResults?: ReturnType<MemoryInspector["showPreconsciousPacket"]>;
  contextSelections?: ReturnType<MemoryInspector["showCompiledContextPacket"]>;
  controllerDecision?: ReturnType<MemoryInspector["explainSelectedAction"]>;
}

export interface MemoryInspectorOptions {
  eventLog?: MemoryEventLog;
  recordStore?: MemoryRecordStore;
  proofStore?: ProofStore;
}

export class MemoryInspector {
  private readonly eventLog: MemoryEventLog | undefined;
  private readonly recordStore: MemoryRecordStore | undefined;
  private readonly proofStore: ProofStore | undefined;

  constructor(options: MemoryInspectorOptions = {}) {
    this.eventLog = options.eventLog;
    this.recordStore = options.recordStore;
    this.proofStore = options.proofStore;
  }

  eventTimeline(): readonly MemoryEventTimelineEntry[] {
    return this.requireEventLog().listAll().map(captureEvent);
  }

  showEventById(eventId: string): ResearchEvent | undefined {
    return this.requireEventLog().getById(eventId);
  }

  showDerivedRecordsForEvent(
    sourceEventId: string,
  ): readonly ResearchDerivedMemoryRecord[] {
    return this.requireRecordStore().list({
      sourceEventId,
      includeAudited: true,
    });
  }

  runRecallQuery(input: Omit<MemoryRetrievalInput, "recordStore">): MemoryRetrievalResult {
    return createDeterministicMemoryRetriever().retrieve({
      ...input,
      recordStore: this.requireRecordStore(),
    });
  }

  showPreconsciousPacket(retrieval: MemoryRetrievalResult) {
    return {
      candidateCount: retrieval.candidates.length,
      candidates: retrieval.candidates.map((candidate) => ({
        recordId: candidate.record.id,
        kind: candidate.record.kind,
        status: candidate.record.status,
        score: candidate.score,
        summary: candidate.record.summary,
        reasons: candidate.reasons,
        warnings: candidate.warnings,
      })),
      findings: retrieval.findings.map((candidate) => candidate.record.id),
      contradictions: retrieval.contradictions.map((candidate) => candidate.record.id),
      procedures: retrieval.procedures.map((candidate) => candidate.record.id),
      prospectiveChecks: retrieval.prospectiveChecks.map(
        (candidate) => candidate.record.id,
      ),
    };
  }

  showCompiledContextPacket(contextPacket: ResearchContextPacketV2) {
    return {
      schemaVersion: contextPacket.schemaVersion,
      preconsciousCandidateCount: contextPacket.preconsciousCandidateCount,
      tokenBudget: contextPacket.tokenBudget,
      estimatedTokens: contextPacket.estimatedTokens,
      compaction: contextPacket.compaction,
      sections: contextPacket.sections.map((section) => ({
        label: section.label,
        itemCount: section.items.length,
        tokenBudget: section.tokenBudget,
        estimatedTokens: section.estimatedTokens,
        selectedRecordIds: section.items.map((item) => item.recordId),
        droppedRecordIds: section.droppedRecordIds,
        selectionReasons: section.items.map((item) => ({
          recordId: item.recordId,
          reasons: item.selectionReasons,
          warnings: item.warnings,
        })),
      })),
    };
  }

  explainSelectedAction(decision: MemoryDrivenControllerDecision) {
    return {
      actionClass: decision.actionClass,
      subGoalId: decision.subGoal.id,
      subGoalObjective: decision.subGoal.objective,
      rationale: decision.rationale,
      supportingRecordIds: decision.supportingRecordIds,
      warnings: decision.warnings,
      usedFirstRunFallback: decision.usedFirstRunFallback,
      actionScores: decision.actionScores,
    };
  }

  showHypotheses(): readonly ResearchDerivedMemoryRecord[] {
    const store = this.requireRecordStore();

    return [
      ...store.list({ kind: "semantic_claim" }),
      ...store.list({ kind: "hypothesis" }),
    ];
  }

  showFindings(): readonly ResearchFindingMemoryRecord[] {
    return this.requireRecordStore().list({ kind: "finding" })
      .filter((record): record is ResearchFindingMemoryRecord =>
        record.kind === "finding",
      );
  }

  showFindingById(recordId: string):
    | {
        finding: ResearchFindingMemoryRecord;
        evidenceFor: ResearchFindingMemoryRecord["provenance"]["evidenceFor"];
        evidenceAgainst: ResearchFindingMemoryRecord["provenance"]["evidenceAgainst"];
        linkedHypothesisRecordIds: readonly string[];
        linkedClaimRecordIds: readonly string[];
        proofAttemptIds: readonly string[];
        artifactRefs: ResearchFindingMemoryRecord["provenance"]["artifactRefs"];
      }
    | undefined {
    const record = this.requireRecordStore().getById(recordId);
    if (!record || record.kind !== "finding") {
      return undefined;
    }

    return {
      finding: record,
      evidenceFor: record.provenance.evidenceFor,
      evidenceAgainst: record.provenance.evidenceAgainst,
      linkedHypothesisRecordIds: record.linkedHypothesisRecordIds,
      linkedClaimRecordIds: record.linkedClaimRecordIds,
      proofAttemptIds: record.proofAttemptIds,
      artifactRefs: record.provenance.artifactRefs,
    };
  }

  showClaimGraph(): readonly ResearchClaimGraphEdge[] {
    return this.requireRecordStore().listClaimGraphEdges({
      includeEvidenceEdges: true,
    });
  }

  showProspectiveChecks(): readonly ResearchDerivedMemoryRecord[] {
    return this.requireRecordStore().list({ kind: "prospective_check" });
  }

  showProofState(): ResearchProofStateReadModel {
    return this.requireProofStore().readState();
  }

  showProofObligations(): ResearchProofStateReadModel["obligations"] {
    return this.requireProofStore().listObligations();
  }

  showProofAttempts(): ResearchProofStateReadModel["attempts"] {
    return this.requireProofStore().listAttempts();
  }

  showProofObligationById(
    obligationId: string,
  ): ResearchProofStateReadModel["obligations"][number] | undefined {
    return this.requireProofStore().getObligationById(obligationId);
  }

  showProofAttemptById(
    attemptId: string,
  ): ResearchProofStateReadModel["attempts"][number] | undefined {
    return this.requireProofStore().getAttemptById(attemptId);
  }

  captureDebug(input: MemoryDebugCaptureInput = {}): MemoryDebugCapture {
    const committedWrites = this.recordStore
      ? this.recordStore.list({ includeAudited: true }).map((record) => ({
          recordId: record.id,
          kind: record.kind,
          status: record.status,
          summary: record.summary,
        }))
      : [];

    return {
      acceptedEvents: this.eventLog ? this.eventTimeline() : [],
      rejectedEvents: input.rejectedEvents ?? [],
      candidateWrites: (input.candidateWrites ?? []).map((record) => ({
        recordId: record.id,
        kind: record.kind,
        status: record.status,
        summary: record.summary,
      })),
      committedWrites,
      ...(input.retrieval
        ? { retrievalResults: this.showPreconsciousPacket(input.retrieval) }
        : {}),
      ...(input.contextPacketV2
        ? {
            contextSelections: this.showCompiledContextPacket(
              input.contextPacketV2,
            ),
          }
        : {}),
      ...(input.decision
        ? { controllerDecision: this.explainSelectedAction(input.decision) }
        : {}),
    };
  }

  private requireEventLog(): MemoryEventLog {
    if (!this.eventLog) {
      throw new Error("MemoryInspector requires an event log for this operation.");
    }

    return this.eventLog;
  }

  private requireRecordStore(): MemoryRecordStore {
    if (!this.recordStore) {
      throw new Error("MemoryInspector requires a record store for this operation.");
    }

    return this.recordStore;
  }

  private requireProofStore(): ProofStore {
    if (!this.proofStore) {
      throw new Error("MemoryInspector requires a proof store for this operation.");
    }

    return this.proofStore;
  }
}

export function createMemoryInspector(
  options: MemoryInspectorOptions = {},
): MemoryInspector {
  return new MemoryInspector(options);
}

function captureEvent(event: ResearchEvent): MemoryEventTimelineEntry {
  return {
    id: event.id,
    ...(event.sequence ? { sequence: event.sequence } : {}),
    kind: event.kind,
    timestamp: event.timestamp,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    summary: summarizeEvent(event),
  };
}

function summarizeEvent(event: ResearchEvent): string {
  const payload = event.payload;
  if (isRecord(payload)) {
    for (const key of ["summary", "text", "objective", "claim", "hypothesis"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return event.kind;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
