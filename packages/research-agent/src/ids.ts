import { randomUUID } from "node:crypto";
import type {
  ResearchEventId,
  ResearchEventSequence,
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

export function nowIso(): string {
  return new Date().toISOString();
}
