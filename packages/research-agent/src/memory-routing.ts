import { normalizeMemorySnapshot } from "./context-packet.js";
import { createResearchMemoryRecordId } from "./ids.js";
import type {
  ResearchAcceptedRawEventKind,
  ResearchDerivedMemoryStatus,
  ResearchEvent,
  ResearchMemoryRef,
  ResearchMemoryRecordKind,
  ResearchMemoryRoute,
  ResearchMemoryRouteTarget,
  ResearchMemorySnapshot,
  ResearchMemoryStoreKind,
} from "./types.js";

export const ACCEPTED_RAW_EVENT_KINDS = [
  "goal.created",
  "goal.updated",
  "memory.decision",
  "memory.routed",
  "context.compiled",
  "loop.planned",
  "loop.processed",
  "tool.requested",
  "tool.observed",
  "model.visible_note",
  "model.claim",
  "model.hypothesis",
  "user.commitment",
  "error.observed",
] as const satisfies readonly ResearchAcceptedRawEventKind[];

const acceptedRawEventKindSet = new Set<string>(ACCEPTED_RAW_EVENT_KINDS);

export function isAcceptedRawEventKind(
  kind: string,
): kind is ResearchAcceptedRawEventKind {
  return acceptedRawEventKindSet.has(kind);
}

export function routeEventToMemory(
  event: ResearchEvent,
): ResearchMemoryRoute[] {
  switch (event.kind) {
    case "tool.observed":
      return [
        createRefRoute({
          event,
          target: "directEvidence",
          store: "evidence",
          recordKind: "evidence",
          status: "confirmed",
          reason: "Tool observations are direct evidence for later loops.",
          confidence: 0.95,
        }),
      ];
    case "loop.processed":
    case "goal.updated":
      return [
        createRefRoute({
          event,
          target: "priorEpisodes",
          store: "episodic",
          recordKind: "episodic",
          status: "active",
          reason:
            event.kind === "goal.updated"
              ? "Goal status transitions are part of the research trajectory."
              : "Completed loop output becomes an episodic trajectory.",
          confidence: 0.8,
        }),
      ];
    case "tool.requested":
    case "model.visible_note":
      return [
        createRefRoute({
          event,
          target: "priorEpisodes",
          store: "working",
          recordKind: "working",
          status: "active",
          reason:
            "Visible notes and tool requests are model-visible process observations.",
          confidence: 0.7,
        }),
      ];
    case "model.claim":
      return [
        createRefRoute({
          event,
          target: "currentHypotheses",
          store: "semantic",
          recordKind: "semantic_claim",
          status: "candidate",
          reason:
            "Model-visible claims should be preserved as candidates until validated.",
          confidence: 0.55,
        }),
      ];
    case "model.hypothesis":
      return [
        createRefRoute({
          event,
          target: "currentHypotheses",
          store: "hypothesis",
          recordKind: "hypothesis",
          status: "candidate",
          reason: "Hypotheses should be available to the next loop.",
          confidence: 0.65,
        }),
      ];
    case "user.commitment":
      return [
        createStringRoute({
          event,
          target: "userCommitments",
          reason: "User commitments are carried forward as context constraints.",
          confidence: 1,
        }),
      ];
    case "error.observed":
      return [
        createRefRoute({
          event,
          target: "contradictions",
          store: "event",
          recordKind: "evidence",
          status: "active",
          reason:
            "Observed errors may contradict assumptions or block planned paths.",
          confidence: 0.85,
        }),
      ];
    default:
      return [];
  }
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

function createRefRoute(input: {
  event: ResearchEvent;
  target: ResearchMemoryRouteTarget;
  store: ResearchMemoryStoreKind;
  recordKind: ResearchMemoryRecordKind;
  status: ResearchDerivedMemoryStatus;
  reason: string;
  confidence: number;
}): ResearchMemoryRoute {
  const summary = summarizeEvent(input.event);
  const recordId = createResearchMemoryRecordId({
    kind: input.recordKind,
    sourceEventIds: [input.event.id],
    discriminator: input.target,
  });
  const memoryRef: ResearchMemoryRef = {
    store: input.store,
    id: recordId,
    recordKind: input.recordKind,
    status: input.status,
    sourceEventIds: [input.event.id],
    summary,
    confidence: input.confidence,
  };

  return {
    id: `${recordId}:${input.target}`,
    sourceEventId: input.event.id,
    target: input.target,
    reason: input.reason,
    confidence: input.confidence,
    memoryRef,
  };
}

function createStringRoute(input: {
  event: ResearchEvent;
  target: "prospectiveCommitments" | "userCommitments";
  reason: string;
  confidence: number;
}): ResearchMemoryRoute {
  return {
    id: `${input.event.id}:${input.target}`,
    sourceEventId: input.event.id,
    target: input.target,
    reason: input.reason,
    confidence: input.confidence,
    value: summarizeEvent(input.event),
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

function summarizeEvent(event: ResearchEvent): string {
  const payload = event.payload;
  if (isRecord(payload)) {
    const summary = readString(payload, "summary");
    if (summary) {
      return truncate(summary, 700);
    }

    const objective = readString(payload, "objective");
    if (objective) {
      return truncate(objective, 700);
    }

    const text = readString(payload, "text");
    if (text) {
      return truncate(text, 700);
    }
  }

  return truncate(`${event.kind}: ${formatPayload(payload)}`, 700);
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

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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

type MutableResearchMemorySnapshot = {
  eventLog: ResearchEvent[];
  directEvidence: ResearchMemoryRef[];
  priorEpisodes: ResearchMemoryRef[];
  candidateProcedures: ResearchMemoryRef[];
  currentHypotheses: ResearchMemoryRef[];
  contradictions: ResearchMemoryRef[];
  prospectiveCommitments: string[];
  userCommitments: string[];
};
