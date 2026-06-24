import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createResearchEventId } from "./ids.js";
import type { MemoryEventLog } from "./memory-event-log.js";
import type {
  DeleteMemoryRecordForPolicyInput,
  MemoryRecordStore,
} from "./memory-record-store.js";
import type {
  ResearchArtifactRef,
  ResearchDerivedMemoryRecord,
  ResearchEvent,
} from "./types.js";

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

export interface TombstoneMemoryArtifactInput {
  eventLog: MemoryEventLog;
  artifactRef: ResearchArtifactRef;
  timestamp: string;
  policy: string;
  summary?: string;
  deleteFile?: boolean;
  goalId?: string;
  loopId?: string;
  subGoalId?: string;
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

export function tombstoneMemoryArtifact(
  input: TombstoneMemoryArtifactInput,
): ResearchEvent {
  const deletedFile = input.deleteFile
    ? deleteArtifactFileIfLocal(input.artifactRef)
    : false;
  const summary =
    input.summary ??
    `Tombstoned artifact ${input.artifactRef.id} under policy ${input.policy}.`;

  return input.eventLog.append({
    id: createResearchEventId(),
    kind: "artifact.tombstoned",
    timestamp: input.timestamp,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.loopId ? { loopId: input.loopId } : {}),
    ...(input.subGoalId ? { subGoalId: input.subGoalId } : {}),
    payload: {
      artifactRef: input.artifactRef,
      artifactRefId: input.artifactRef.id,
      policy: input.policy,
      deletedFile,
      summary,
    },
    artifactRefs: [input.artifactRef],
  });
}

function deleteArtifactFileIfLocal(artifactRef: ResearchArtifactRef): boolean {
  if (!artifactRef.uri?.startsWith("file://")) {
    return false;
  }

  rmSync(fileURLToPath(artifactRef.uri), { force: true });
  return true;
}
