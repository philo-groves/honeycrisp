import type { MemoryRetrievalCandidate } from "./memory-retriever.js";
import type {
  ResearchEvent,
  ResearchGoalNode,
  ResearchMemoryRef,
} from "./types.js";

export function goalObjectiveNeedsFreshEvidence(objective: string): boolean {
  const normalized = objective.toLowerCase();
  if (
    /\b(what did|summari[sz]e|recall|report|list|show|review previous|from memory|already|last time)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  return /\b(perform|scan|inspect|analysis|analy[sz]e|pick|read|search|walk|audit|triage|test|experiment|validate|verify|investigate|find a bug|run out of functions)\b/.test(
    normalized,
  );
}

export function candidateBelongsToGoal(
  candidate: MemoryRetrievalCandidate,
  activeGoal: ResearchGoalNode,
): boolean {
  return candidate.record.goalId === activeGoal.id;
}

export function memoryRefBelongsToGoal(
  ref: ResearchMemoryRef,
  activeGoal: ResearchGoalNode,
  events: readonly ResearchEvent[],
): boolean {
  if (!ref.sourceEventIds || ref.sourceEventIds.length === 0) {
    return false;
  }

  const sourceEventIds = new Set(ref.sourceEventIds);
  return events.some(
    (event) => event.goalId === activeGoal.id && sourceEventIds.has(event.id),
  );
}

export function isPriorGoalCandidate(
  candidate: MemoryRetrievalCandidate,
  activeGoal: ResearchGoalNode,
): boolean {
  return (
    typeof candidate.record.goalId === "string" &&
    candidate.record.goalId !== activeGoal.id
  );
}

export function addPriorGoalContextWarning(
  candidate: MemoryRetrievalCandidate,
): MemoryRetrievalCandidate {
  return {
    ...candidate,
    warnings: [
      ...new Set([
        ...candidate.warnings,
        "From a different goal; use as prior context only, not current completion proof.",
      ]),
    ],
  };
}
