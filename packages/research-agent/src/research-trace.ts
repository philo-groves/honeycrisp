import { createResearchEventId, nowIso } from "./ids.js";
import type { ResearchEvent, ResearchTrace, ResearchTraceItem } from "./types.js";

const traceKinds = [
  "observations",
  "inferences",
  "hypotheses",
  "assumptions",
  "rejectedPaths",
  "uncertainty",
  "nextQuestions",
] as const;

export function createEmptyResearchTrace(): ResearchTrace {
  return {
    observations: [],
    inferences: [],
    hypotheses: [],
    assumptions: [],
    rejectedPaths: [],
    uncertainty: [],
    nextQuestions: [],
    evidenceLinks: [],
  };
}

export function createResearchTraceEvents(
  trace: ResearchTrace,
): readonly ResearchEvent[] {
  return traceKinds.flatMap((kind) =>
    trace[kind].map((item) => traceEvent(kind, item)),
  );
}

function traceEvent(
  kind: (typeof traceKinds)[number],
  item: ResearchTraceItem,
): ResearchEvent {
  const eventKind =
    kind === "observations"
      ? "model.observation"
      : kind === "hypotheses"
        ? "model.hypothesis"
        : kind === "inferences"
          ? "model.claim"
          : "model.visible_note";
  return {
    id: createResearchEventId(),
    kind: eventKind,
    timestamp: nowIso(),
    payload: {
      traceKind: kind,
      summary: item.text,
      text: item.text,
      ...(item.confidence !== undefined
        ? { confidence: item.confidence }
        : {}),
      ...(item.evidenceRefIds
        ? { evidenceRefIds: item.evidenceRefIds }
        : {}),
    },
  };
}
