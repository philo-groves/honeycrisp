import { createResearchEventId } from "./ids.js";
import {
  createDeterministicMemoryWritePipeline,
} from "./memory-write-pipeline.js";
import {
  isResearchDerivedMemoryStatus,
  isResearchFindingStatus,
  isResearchProofAttemptStatus,
  isResearchProofMethodKind,
  isResearchProofObligationStatus,
  isResearchProofResultStatus,
  isResearchProofSubjectKind,
} from "./memory-contracts.js";
import type { MemoryEventLog } from "./memory-event-log.js";
import type { MemoryRecordStore } from "./memory-record-store.js";
import type { ProofStore } from "./proof-store.js";
import type {
  ResearchAcceptedRawEventKind,
  ResearchArtifactRef,
  ResearchDerivedMemoryRecord,
  ResearchDerivedMemoryStatus,
  ResearchEvent,
  ResearchFindingMemoryRecord,
  ResearchFindingStatus,
  ResearchProofAttempt,
  ResearchProofAttemptStatus,
  ResearchProofMethodDescriptor,
  ResearchProofMethodKind,
  ResearchProofObligation,
  ResearchProofObligationStatus,
  ResearchProofResultStatus,
  ResearchProofSubjectKind,
  ResearchProofSubjectRef,
} from "./types.js";

const writePipeline = createDeterministicMemoryWritePipeline();

export type ResearchArtifactMark = "important" | "sensitive" | "tombstoned";

export interface MemorySteeringControllerOptions {
  eventLog: MemoryEventLog;
  recordStore: MemoryRecordStore;
  proofStore: ProofStore;
  now?: () => string;
}

export interface MemorySteeringResult {
  action: string;
  event: ResearchEvent;
  records: readonly ResearchDerivedMemoryRecord[];
  record?: ResearchDerivedMemoryRecord;
  obligation?: ResearchProofObligation;
  attempt?: ResearchProofAttempt;
}

export interface PromoteHypothesisToFindingInput extends SteeringEventContext {
  hypothesisRecordId: string;
  summary?: string;
  findingStatus?: Extract<ResearchFindingStatus, "candidate" | "needs_evidence" | "supported" | "verified">;
  confidence?: number;
  domainLabels?: readonly string[];
  domainMetadata?: Record<string, unknown>;
}

export interface ReviewMemoryRecordInput extends SteeringEventContext {
  recordId: string;
  status: ResearchDerivedMemoryStatus;
  summary?: string;
  findingStatus?: ResearchFindingStatus;
  supersededByRecordId?: string;
}

export interface RequestProofInput extends SteeringEventContext {
  subject: ResearchProofSubjectRef;
  question: string;
  acceptableMethods?: readonly ResearchProofMethodDescriptor[];
  requiredResult?: ResearchProofResultStatus;
  status?: ResearchProofObligationStatus;
  findingRecordIds?: readonly string[];
  hypothesisRecordIds?: readonly string[];
  claimRecordIds?: readonly string[];
  evidenceRefIds?: readonly string[];
  artifactRefs?: readonly ResearchArtifactRef[];
  domainMetadata?: Record<string, unknown>;
}

export interface AttachProofAttemptInput extends SteeringEventContext {
  obligationId: string;
  summary: string;
  method?: ResearchProofMethodDescriptor;
  status?: ResearchProofAttemptStatus;
  result?: ResearchProofResultStatus;
  verifier?: string;
  evidenceRefIds?: readonly string[];
  artifactRefs?: readonly ResearchArtifactRef[];
  domainMetadata?: Record<string, unknown>;
}

export interface ReviewProofAttemptInput extends SteeringEventContext {
  attemptId: string;
  summary?: string;
  status?: ResearchProofAttemptStatus;
  result?: ResearchProofResultStatus;
  verifier?: string;
  obligationStatus?: ResearchProofObligationStatus;
}

export interface MarkArtifactInput extends SteeringEventContext {
  artifact: ResearchArtifactRef;
  mark: ResearchArtifactMark;
  policy?: string;
  summary?: string;
}

export interface SteeringEventContext {
  goalId?: string;
  loopId?: string;
  subGoalId?: string;
  note?: string;
}

export function createMemorySteeringController(
  options: MemorySteeringControllerOptions,
): MemorySteeringController {
  return new MemorySteeringController(options);
}

export class MemorySteeringController {
  private readonly now: () => string;

  constructor(private readonly options: MemorySteeringControllerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  promoteHypothesisToFinding(
    input: PromoteHypothesisToFindingInput,
  ): MemorySteeringResult {
    const hypothesis = this.requireRecord(input.hypothesisRecordId, "hypothesis");
    const findingStatus = input.findingStatus ?? "supported";
    const event = this.appendEvent("finding.updated", {
      ...eventContext(input),
      payload: {
        operation: "hypothesis.promoted_to_finding",
        hypothesisRecordId: hypothesis.id,
        linkedHypothesisRecordIds: [hypothesis.id],
        derivedFromRecordIds: [hypothesis.id],
        finding: input.summary ?? hypothesis.summary,
        summary: input.summary ?? `Promoted hypothesis to finding: ${hypothesis.summary}`,
        findingStatus,
        ...(typeof input.confidence === "number"
          ? { confidence: input.confidence }
          : {}),
        ...(input.domainLabels && input.domainLabels.length > 0
          ? { domainLabels: input.domainLabels }
          : {}),
        ...(input.domainMetadata ? { domainMetadata: input.domainMetadata } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    const records = this.writeDerivedRecords(event);
    const finding = records.find(
      (record): record is ResearchFindingMemoryRecord => record.kind === "finding",
    );
    const updatedHypothesis = this.options.recordStore.updateStatus({
      recordId: hypothesis.id,
      status: "confirmed",
      updatedAt: event.timestamp,
      summary: input.summary ?? hypothesis.summary,
    });

    return {
      action: "promote-hypothesis",
      event,
      records,
      record: finding ?? updatedHypothesis,
    };
  }

  reviewRecord(input: ReviewMemoryRecordInput): MemorySteeringResult {
    const existing = this.requireRecord(input.recordId);
    if (existing.kind === "finding" && input.findingStatus) {
      requireFindingStatus(input.findingStatus);
    }
    const event = this.appendEvent(
      existing.kind === "finding" ? "finding.reviewed" : "memory.reviewed",
      {
        ...eventContext(input),
        payload: {
          operation: "memory.record.reviewed",
          recordId: existing.id,
          recordKind: existing.kind,
          previousStatus: existing.status,
          status: input.status,
          ...(input.findingStatus ? { findingStatus: input.findingStatus } : {}),
          ...(input.supersededByRecordId
            ? { supersededByRecordId: input.supersededByRecordId }
            : {}),
          summary:
            input.summary ??
            `Reviewed ${existing.kind} record ${existing.id}: ${existing.status} -> ${input.status}.`,
          ...(input.note ? { note: input.note } : {}),
        },
      },
    );
    const records = this.writeDerivedRecords(event);
    const updated = this.options.recordStore.updateStatus({
      recordId: existing.id,
      status: input.status,
      updatedAt: event.timestamp,
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.findingStatus ? { findingStatus: input.findingStatus } : {}),
      ...(input.supersededByRecordId
        ? { supersededByRecordId: input.supersededByRecordId }
        : {}),
    });

    return {
      action: "review-record",
      event,
      records,
      record: updated,
    };
  }

  rejectRecord(
    input: Omit<ReviewMemoryRecordInput, "status" | "findingStatus"> & {
      findingStatus?: Extract<ResearchFindingStatus, "rejected" | "out_of_scope">;
    },
  ): MemorySteeringResult {
    const existing = this.requireRecord(input.recordId);
    return this.reviewRecord({
      ...input,
      status: "contradicted",
      ...(existing.kind === "finding"
        ? { findingStatus: input.findingStatus ?? "rejected" }
        : {}),
      summary:
        input.summary ??
        `Rejected ${existing.kind} record ${existing.id}.`,
    });
  }

  supersedeRecord(
    input: Omit<ReviewMemoryRecordInput, "status" | "findingStatus">,
  ): MemorySteeringResult {
    const existing = this.requireRecord(input.recordId);
    if (!input.supersededByRecordId) {
      throw new Error("supersede-record requires a replacement record id.");
    }
    return this.reviewRecord({
      ...input,
      status: "superseded",
      ...(existing.kind === "finding" ? { findingStatus: "superseded" } : {}),
      summary:
        input.summary ??
        `Superseded ${existing.kind} record ${existing.id} by ${input.supersededByRecordId}.`,
    });
  }

  tombstoneRecord(
    input: Omit<ReviewMemoryRecordInput, "status" | "findingStatus">,
  ): MemorySteeringResult {
    const existing = this.requireRecord(input.recordId);
    return this.reviewRecord({
      ...input,
      status: "tombstoned",
      ...(existing.kind === "finding" ? { findingStatus: "tombstoned" } : {}),
      summary:
        input.summary ??
        `Tombstoned ${existing.kind} record ${existing.id}.`,
    });
  }

  requestProof(input: RequestProofInput): MemorySteeringResult {
    const event = this.appendEvent("proof.requested", {
      ...eventContext(input),
      ...(input.artifactRefs && input.artifactRefs.length > 0
        ? { artifactRefs: input.artifactRefs }
        : {}),
      payload: {
        operation: "proof.requested",
        subject: input.subject,
        question: input.question,
        summary: input.question,
        status: input.status ?? "open",
        acceptableMethods: input.acceptableMethods ?? [defaultProofMethod()],
        ...(input.requiredResult ? { requiredResult: input.requiredResult } : {}),
        findingRecordIds: input.findingRecordIds ?? [],
        hypothesisRecordIds: input.hypothesisRecordIds ?? [],
        claimRecordIds: input.claimRecordIds ?? [],
        evidenceRefIds: input.evidenceRefIds ?? [],
        artifactRefs: input.artifactRefs ?? [],
        ...(input.domainMetadata ? { domainMetadata: input.domainMetadata } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    const records = this.writeDerivedRecords(event);
    const applied = this.options.proofStore.applyEvent(event);
    const obligation = applied.find(isProofObligation);

    return {
      action: "request-proof",
      event,
      records,
      ...(obligation ? { obligation } : {}),
    };
  }

  attachProofAttempt(input: AttachProofAttemptInput): MemorySteeringResult {
    const obligation = this.options.proofStore.getObligationById(input.obligationId);
    if (!obligation) {
      throw new Error(`Proof obligation not found: ${input.obligationId}`);
    }
    const status = input.status ?? (input.result ? "completed" : "planned");
    const eventKind: ResearchAcceptedRawEventKind =
      status === "planned" || status === "running"
        ? "proof.attempted"
        : "proof.observed";
    const event = this.appendEvent(eventKind, {
      ...eventContext(input),
      ...(input.artifactRefs && input.artifactRefs.length > 0
        ? { artifactRefs: input.artifactRefs }
        : {}),
      payload: {
        operation: "proof.attempt.attached",
        obligationId: input.obligationId,
        status,
        summary: input.summary,
        method: input.method ?? defaultProofMethod(),
        ...(input.result ? { result: input.result } : {}),
        ...(input.verifier ? { verifier: input.verifier } : {}),
        evidenceRefIds: input.evidenceRefIds ?? [],
        artifactRefs: input.artifactRefs ?? [],
        ...(input.domainMetadata ? { domainMetadata: input.domainMetadata } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    const records = this.writeDerivedRecords(event);
    const applied = this.options.proofStore.applyEvent(event);
    const attempt = applied.find(isProofAttempt);
    this.maybeUpdateObligationFromAttempt(obligation, attempt, event.timestamp);

    return {
      action: "attach-proof-attempt",
      event,
      records,
      ...(attempt ? { attempt } : {}),
    };
  }

  reviewProofAttempt(input: ReviewProofAttemptInput): MemorySteeringResult {
    const existing = this.options.proofStore.getAttemptById(input.attemptId);
    if (!existing) {
      throw new Error(`Proof attempt not found: ${input.attemptId}`);
    }
    const obligation = this.options.proofStore.getObligationById(existing.obligationId);
    if (!obligation) {
      throw new Error(`Proof obligation not found: ${existing.obligationId}`);
    }
    const event = this.appendEvent("proof.reviewed", {
      ...eventContext(input),
      artifactRefs: existing.artifactRefs,
      payload: {
        operation: "proof.attempt.reviewed",
        attemptId: existing.id,
        obligationId: existing.obligationId,
        status: input.status ?? existing.status,
        summary: input.summary ?? existing.summary,
        method: existing.method,
        ...(input.result ?? existing.result
          ? { result: input.result ?? existing.result }
          : {}),
        ...(input.verifier ?? existing.verifier
          ? { verifier: input.verifier ?? existing.verifier }
          : {}),
        evidenceRefIds: existing.evidenceRefIds,
        artifactRefs: existing.artifactRefs,
        ...(input.obligationStatus
          ? { obligationStatus: input.obligationStatus }
          : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    const records = this.writeDerivedRecords(event);
    const applied = this.options.proofStore.applyEvent(event);
    const attempt = applied.find(isProofAttempt);
    const obligationStatus =
      input.obligationStatus ?? obligationStatusForAttempt(attempt);
    if (obligationStatus) {
      this.options.proofStore.writeObligation({
        ...obligation,
        status: obligationStatus,
        updatedAt: event.timestamp,
      });
    }

    return {
      action: "review-proof-attempt",
      event,
      records,
      ...(attempt ? { attempt } : {}),
    };
  }

  markArtifact(input: MarkArtifactInput): MemorySteeringResult {
    const event = this.appendEvent(
      input.mark === "tombstoned" ? "artifact.tombstoned" : "artifact.updated",
      {
        ...eventContext(input),
        artifactRefs: [input.artifact],
        payload: {
          operation: "artifact.marked",
          mark: input.mark,
          artifactRef: input.artifact,
          artifactRefId: input.artifact.id,
          policy: input.policy ?? "user_request",
          summary:
            input.summary ??
            `Marked artifact ${input.artifact.id} as ${input.mark}.`,
          ...(input.note ? { note: input.note } : {}),
        },
      },
    );
    const records = this.writeDerivedRecords(event);

    return {
      action: "mark-artifact",
      event,
      records,
    };
  }

  private appendEvent(
    kind: ResearchAcceptedRawEventKind,
    input: {
      payload: unknown;
      goalId?: string;
      loopId?: string;
      subGoalId?: string;
      artifactRefs?: readonly ResearchArtifactRef[];
    },
  ): ResearchEvent {
    return this.options.eventLog.append({
      id: createResearchEventId(),
      kind,
      timestamp: this.now(),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.loopId ? { loopId: input.loopId } : {}),
      ...(input.subGoalId ? { subGoalId: input.subGoalId } : {}),
      payload: input.payload,
      ...(input.artifactRefs && input.artifactRefs.length > 0
        ? { artifactRefs: input.artifactRefs }
        : {}),
    });
  }

  private writeDerivedRecords(
    event: ResearchEvent,
  ): readonly ResearchDerivedMemoryRecord[] {
    const records = writePipeline.derive(event);
    this.options.recordStore.writeMany(records);
    return records;
  }

  private requireRecord(
    recordId: string,
    kind?: ResearchDerivedMemoryRecord["kind"],
  ): ResearchDerivedMemoryRecord {
    const record = this.options.recordStore.getById(recordId);
    if (!record) {
      throw new Error(`Memory record not found: ${recordId}`);
    }
    if (kind && record.kind !== kind) {
      throw new Error(`Expected ${kind} memory record: ${recordId}`);
    }
    return record;
  }

  private maybeUpdateObligationFromAttempt(
    obligation: ResearchProofObligation,
    attempt: ResearchProofAttempt | undefined,
    updatedAt: string,
  ): void {
    const status = obligationStatusForAttempt(attempt);
    if (!status) {
      return;
    }
    this.options.proofStore.writeObligation({
      ...obligation,
      status,
      updatedAt,
    });
  }
}

export function parseResearchDerivedMemoryStatus(
  value: string,
): ResearchDerivedMemoryStatus {
  if (!isResearchDerivedMemoryStatus(value)) {
    throw new Error(`Unsupported memory record status: ${value}`);
  }
  return value;
}

export function parseResearchFindingStatus(value: string): ResearchFindingStatus {
  requireFindingStatus(value);
  return value;
}

export function parseResearchProofSubjectKind(
  value: string,
): ResearchProofSubjectKind {
  if (!isResearchProofSubjectKind(value)) {
    throw new Error(`Unsupported proof subject kind: ${value}`);
  }
  return value;
}

export function parseResearchProofMethodKind(
  value: string,
): ResearchProofMethodKind {
  if (!isResearchProofMethodKind(value)) {
    throw new Error(`Unsupported proof method kind: ${value}`);
  }
  return value;
}

export function parseResearchProofObligationStatus(
  value: string,
): ResearchProofObligationStatus {
  if (!isResearchProofObligationStatus(value)) {
    throw new Error(`Unsupported proof obligation status: ${value}`);
  }
  return value;
}

export function parseResearchProofAttemptStatus(
  value: string,
): ResearchProofAttemptStatus {
  if (!isResearchProofAttemptStatus(value)) {
    throw new Error(`Unsupported proof attempt status: ${value}`);
  }
  return value;
}

export function parseResearchProofResultStatus(
  value: string,
): ResearchProofResultStatus {
  if (!isResearchProofResultStatus(value)) {
    throw new Error(`Unsupported proof result: ${value}`);
  }
  return value;
}

function eventContext(input: SteeringEventContext): {
  goalId?: string;
  loopId?: string;
  subGoalId?: string;
} {
  return {
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.loopId ? { loopId: input.loopId } : {}),
    ...(input.subGoalId ? { subGoalId: input.subGoalId } : {}),
  };
}

function defaultProofMethod(): ResearchProofMethodDescriptor {
  return {
    kind: "human_review",
    name: "human review",
  };
}

function requireFindingStatus(value: string): asserts value is ResearchFindingStatus {
  if (!isResearchFindingStatus(value)) {
    throw new Error(`Unsupported finding status: ${value}`);
  }
}

function isProofObligation(
  value: ResearchProofObligation | ResearchProofAttempt,
): value is ResearchProofObligation {
  return "question" in value;
}

function isProofAttempt(
  value: ResearchProofObligation | ResearchProofAttempt,
): value is ResearchProofAttempt {
  return "obligationId" in value;
}

function obligationStatusForAttempt(
  attempt: ResearchProofAttempt | undefined,
): ResearchProofObligationStatus | undefined {
  if (!attempt?.result) {
    return undefined;
  }
  switch (attempt.result) {
    case "pass":
      return "satisfied";
    case "fail":
      return "failed";
    case "blocked":
      return "blocked";
    case "superseded":
      return "superseded";
    case "inconclusive":
      return "in_progress";
  }
}
