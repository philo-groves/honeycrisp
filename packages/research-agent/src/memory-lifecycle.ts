import type {
  DeleteMemoryRecordForPolicyInput,
  MemoryRecordStore,
} from "./memory-record-store.js";
import type { ResearchDerivedMemoryRecord } from "./types.js";

export interface MemoryLifecycleInput {
  store: MemoryRecordStore;
  recordId: string;
  timestamp: string;
  summary?: string;
}

export interface SupersedeMemoryRecordInput extends MemoryLifecycleInput {
  supersededByRecordId: string;
}

export interface DeleteMemoryRecordUnderPolicyInput
  extends Omit<DeleteMemoryRecordForPolicyInput, "summary"> {
  store: MemoryRecordStore;
  summary?: string;
}

export function tombstoneMemoryRecord(
  input: MemoryLifecycleInput,
): ResearchDerivedMemoryRecord {
  return input.store.updateStatus({
    recordId: input.recordId,
    status: "tombstoned",
    updatedAt: input.timestamp,
    ...(input.summary ? { summary: input.summary } : {}),
  });
}

export function supersedeMemoryRecord(
  input: SupersedeMemoryRecordInput,
): ResearchDerivedMemoryRecord {
  return input.store.updateStatus({
    recordId: input.recordId,
    status: "superseded",
    updatedAt: input.timestamp,
    ...(input.summary ? { summary: input.summary } : {}),
    supersededByRecordId: input.supersededByRecordId,
  });
}

export function expireMemoryRecord(
  input: MemoryLifecycleInput,
): ResearchDerivedMemoryRecord {
  return input.store.updateStatus({
    recordId: input.recordId,
    status: "stale",
    updatedAt: input.timestamp,
    ...(input.summary ? { summary: input.summary } : {}),
  });
}

export function deleteMemoryRecordUnderPolicy(
  input: DeleteMemoryRecordUnderPolicyInput,
): void {
  input.store.deleteRecordForPolicy({
    recordId: input.recordId,
    policy: input.policy,
    timestamp: input.timestamp,
    summary:
      input.summary ??
      `Deleted memory record ${input.recordId} under policy ${input.policy}.`,
  });
}
