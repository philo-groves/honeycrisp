import {
  createHash,
  randomUUID,
} from "node:crypto";
import type {
  ResearchEventId,
  ResearchEventSequence,
  ResearchMemoryRecordId,
  ResearchMemoryRecordKind,
} from "./types.js";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createResearchEventId(): ResearchEventId {
  return createId("evt") as ResearchEventId;
}

export function isResearchEventId(value: string): value is ResearchEventId {
  return /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function normalizeResearchEventSequence(
  sequence: number,
): ResearchEventSequence {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Research event sequence must be a positive safe integer.");
  }

  return sequence;
}

export function formatResearchEventSequence(
  sequence: ResearchEventSequence,
): string {
  return normalizeResearchEventSequence(sequence).toString().padStart(12, "0");
}

export function createResearchMemoryRecordId(input: {
  kind: ResearchMemoryRecordKind;
  sourceEventIds: readonly string[];
  discriminator?: string;
}): ResearchMemoryRecordId {
  if (input.sourceEventIds.length === 0) {
    throw new Error("Memory record ids require at least one source event id.");
  }

  const hash = createHash("sha256")
    .update(input.kind)
    .update("\0")
    .update([...input.sourceEventIds].sort().join("\0"))
    .update("\0")
    .update(input.discriminator ?? "")
    .digest("hex")
    .slice(0, 24);

  return `mem_${input.kind}_${hash}` as ResearchMemoryRecordId;
}

export function nowIso(): string {
  return new Date().toISOString();
}
