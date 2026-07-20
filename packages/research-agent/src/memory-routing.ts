import { normalizeMemorySnapshot } from "./context-packet.js";
import {
  createDeterministicMemoryWritePipeline,
  summarizeMemoryEvent,
} from "./memory-write-pipeline.js";
import type {
  ResearchAcceptedRawEventKind,
  ResearchDerivedMemoryRecord,
  ResearchEvent,
  ResearchMemoryRef,
  ResearchMemoryRoute,
  ResearchMemoryRouteTarget,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
} from "./types.js";

export const ACCEPTED_RAW_EVENT_KINDS = [
  "memory.routed",
  "memory.reviewed",
  "context.compiled",
  "artifact.updated",
  "artifact.tombstoned",
  "tool.requested",
  "tool.observed",
  "model.visible_note",
  "model.observation",
  "model.claim",
  "model.hypothesis",
  "finding.proposed",
  "finding.updated",
  "finding.reviewed",
  "proof.requested",
  "proof.attempted",
  "proof.observed",
  "proof.reviewed",
  "user.commitment",
  "error.observed",
] as const satisfies readonly ResearchAcceptedRawEventKind[];

const acceptedRawEventKindSet = new Set<string>(ACCEPTED_RAW_EVENT_KINDS);
const memoryWritePipeline = createDeterministicMemoryWritePipeline();

export function isAcceptedRawEventKind(
  kind: string,
): kind is ResearchAcceptedRawEventKind {
  return acceptedRawEventKindSet.has(kind);
}

export function routeEventToMemory(
  event: ResearchEvent,
): ResearchMemoryRoute[] {
  return memoryWritePipeline
    .derive(event)
    .flatMap((record) => createRoutesForRecord(event, record));
}

export function routeEventsToMemorySnapshot(
  events: readonly ResearchEvent[],
  base?: Partial<ResearchMemorySnapshot>,
): ResearchMemorySnapshot {
  const eventLog = appendUniqueEvents(base?.eventLog ?? [], events);
  const memory = normalizeMemorySnapshot({ ...base, eventLog }, eventLog);

  const next = {
    eventLog,
    directEvidence: [...memory.directEvidence],
    priorEpisodes: [...memory.priorEpisodes],
    candidateProcedures: [...memory.candidateProcedures],
    currentHypotheses: [...memory.currentHypotheses],
    currentFindings: [...memory.currentFindings],
    contradictions: [...memory.contradictions],
    prospectiveCommitments: [...memory.prospectiveCommitments],
    userCommitments: [...memory.userCommitments],
  };

  for (const event of events) {
    for (const route of routeEventToMemory(event)) {
      applyRoute(next, route);
    }
  }

  return next;
}

function createRoutesForRecord(
  event: ResearchEvent,
  record: ResearchDerivedMemoryRecord,
): ResearchMemoryRoute[] {
  if (record.kind === "prospective_check") {
    return [
      createStringRoute({
        event,
        record,
        target:
          record.tags.includes("user-commitment")
            ? "userCommitments"
            : "prospectiveCommitments",
        reason: "Prospective checks and user commitments are carried forward as context constraints.",
      }),
    ];
  }

  const target = selectRouteTarget(event, record);
  const store = selectStore(record);
  const memoryRef: ResearchMemoryRef = {
    store,
    id: record.id,
    recordKind: record.kind,
    status: record.status,
    sourceEventIds: record.sourceEventIds,
    summary: record.summary,
    ...(typeof record.confidence === "number"
      ? { confidence: record.confidence }
      : {}),
  };

  return [
    {
      id: `${record.id}:${target}`,
      sourceEventId: event.id,
      target,
      reason: createRouteReason(event, record),
      confidence: record.confidence ?? 0.5,
      memoryRef,
    },
  ];
}

function selectRouteTarget(
  event: ResearchEvent,
  record: ResearchDerivedMemoryRecord,
): Exclude<
  ResearchMemoryRouteTarget,
  "prospectiveCommitments" | "userCommitments"
> {
  if (record.kind === "evidence") {
    return event.kind === "error.observed" ||
      record.tags.includes("contradiction")
      ? "contradictions"
      : "directEvidence";
  }
  if (record.kind === "semantic_claim" || record.kind === "hypothesis") {
    return "currentHypotheses";
  }
  if (record.kind === "finding") {
    return "currentFindings";
  }
  if (record.kind === "procedure") {
    return "candidateProcedures";
  }

  return "priorEpisodes";
}

function selectStore(
  record: ResearchDerivedMemoryRecord,
): ResearchMemoryStoreKind {
  switch (record.kind) {
    case "semantic_claim":
    case "belief":
      return "semantic";
    case "procedure":
      return "procedural";
    case "prospective_check":
      return "prospective";
    default:
      return record.kind;
  }
}

function createRouteReason(
  event: ResearchEvent,
  record: ResearchDerivedMemoryRecord,
): string {
  if (record.kind === "evidence" && event.kind === "tool.observed") {
    return "Tool observations are direct evidence for later loops.";
  }
  if (record.kind === "evidence" && event.kind === "error.observed") {
    return "Observed errors may contradict assumptions or block planned paths.";
  }
  if (record.kind === "semantic_claim") {
    return "Model-visible claims are preserved as candidate semantic claims until validated.";
  }
  if (record.kind === "hypothesis") {
    return "Model-visible hypotheses are available to later loops with separated evidence links.";
  }
  if (record.kind === "finding") {
    return "Evidence-backed findings are carried forward separately from hypotheses.";
  }
  if (record.kind === "procedure") {
    return "Procedures remain candidates until repeated usefulness or explicit promotion.";
  }

  return "Accepted events are converted into typed memory records for later context.";
}

function createStringRoute(input: {
  event: ResearchEvent;
  record?: ResearchDerivedMemoryRecord;
  target: "prospectiveCommitments" | "userCommitments";
  reason: string;
}): ResearchMemoryRoute {
  const value = input.record?.summary ?? summarizeMemoryEvent(input.event);

  return {
    id: `${input.record?.id ?? input.event.id}:${input.target}`,
    sourceEventId: input.event.id,
    target: input.target,
    reason: input.reason,
    confidence: input.record?.confidence ?? 1,
    value,
  };
}

function applyRoute(
  memory: MutableResearchMemorySnapshot,
  route: ResearchMemoryRoute,
) {
  if (route.memoryRef) {
    appendUniqueRef(
      memory[route.target] as ResearchMemoryRef[],
      route.memoryRef,
    );
    return;
  }

  if (route.value && isStringMemoryTarget(route.target)) {
    appendUniqueString(memory[route.target], route.value);
  }
}

function appendUniqueEvents(
  existing: readonly ResearchEvent[],
  incoming: readonly ResearchEvent[],
): ResearchEvent[] {
  const seen = new Set(existing.map((event) => event.id));
  const next = [...existing];

  for (const event of incoming) {
    if (!seen.has(event.id)) {
      next.push(event);
      seen.add(event.id);
    }
  }

  return next;
}

function appendUniqueRef(
  refs: ResearchMemoryRef[],
  ref: ResearchMemoryRef,
) {
  if (!refs.some((existing) => existing.id === ref.id)) {
    refs.push(ref);
  }
}

function appendUniqueString(values: string[], value: string) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function isStringMemoryTarget(
  target: ResearchMemoryRouteTarget,
): target is "prospectiveCommitments" | "userCommitments" {
  return target === "prospectiveCommitments" || target === "userCommitments";
}

type MutableResearchMemorySnapshot = {
  eventLog: ResearchEvent[];
  directEvidence: ResearchMemoryRef[];
  priorEpisodes: ResearchMemoryRef[];
  candidateProcedures: ResearchMemoryRef[];
  currentHypotheses: ResearchMemoryRef[];
  currentFindings: ResearchMemoryRef[];
  contradictions: ResearchMemoryRef[];
  prospectiveCommitments: string[];
  userCommitments: string[];
};
