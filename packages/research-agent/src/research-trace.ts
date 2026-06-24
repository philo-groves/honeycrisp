import { createId, nowIso } from "./ids.js";
import type {
  ResearchEvent,
  ResearchEvidenceLink,
  ResearchLoopProcessingResult,
  ResearchTrace,
  ResearchTraceItem,
} from "./types.js";

type TraceArrayKey =
  | "observations"
  | "inferences"
  | "hypotheses"
  | "assumptions"
  | "rejectedPaths"
  | "uncertainty"
  | "nextQuestions";

const traceArrayKeys = [
  "observations",
  "inferences",
  "hypotheses",
  "assumptions",
  "rejectedPaths",
  "uncertainty",
  "nextQuestions",
] as const satisfies readonly TraceArrayKey[];

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

export function normalizeResearchTrace(
  trace: Partial<ResearchTrace> | undefined,
): ResearchTrace {
  const empty = createEmptyResearchTrace();
  if (!trace) {
    return empty;
  }

  return {
    observations: normalizeTraceItems(trace.observations),
    inferences: normalizeTraceItems(trace.inferences),
    hypotheses: normalizeTraceItems(trace.hypotheses),
    assumptions: normalizeTraceItems(trace.assumptions),
    rejectedPaths: normalizeTraceItems(trace.rejectedPaths),
    uncertainty: normalizeTraceItems(trace.uncertainty),
    nextQuestions: normalizeTraceItems(trace.nextQuestions),
    evidenceLinks: normalizeEvidenceLinks(trace.evidenceLinks),
  };
}

export function extractResearchTraceFromText(
  text: string,
): ResearchTrace | undefined {
  const json = extractTraceJson(text);
  if (!json) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return undefined;
    }

    return normalizeResearchTrace(parsed);
  } catch {
    return undefined;
  }
}

export function createResearchTraceEventsFromLoopResult(
  loopResult: ResearchLoopProcessingResult,
  options: {
    goalId?: string;
    timestamp?: string;
  } = {},
): ResearchEvent[] {
  const trace = loopResult.output.researchTrace;
  if (!trace) {
    return [];
  }

  return createResearchTraceEvents(trace, {
    sourceLoopResultId: loopResult.id,
    sourceLoopPlanId: loopResult.loopPlanId,
    ...(options.goalId ? { goalId: options.goalId } : {}),
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
  });
}

export function createResearchTraceEvents(
  trace: ResearchTrace,
  options: {
    goalId?: string;
    timestamp?: string;
    sourceLoopResultId?: string;
    sourceLoopPlanId?: string;
  } = {},
): ResearchEvent[] {
  const timestamp = options.timestamp ?? nowIso();
  const events: ResearchEvent[] = [];

  for (const key of traceArrayKeys) {
    for (const item of trace[key]) {
      events.push(
        createTraceItemEvent({
          key,
          item,
          timestamp,
          ...options,
        }),
      );
    }
  }

  for (const link of trace.evidenceLinks) {
    events.push(
      createTraceLinkEvent({
        link,
        timestamp,
        ...options,
      }),
    );
  }

  return events;
}

export function renderResearchTraceContract(): string {
  return [
    "At the end, include one fenced JSON block named honeycrisp-research-trace-json.",
    "This block is for visible, auditable consequences of reasoning, not private reasoning.",
    "Use this exact object shape and omit private chain-of-thought:",
    "```honeycrisp-research-trace-json",
    JSON.stringify(createEmptyResearchTrace(), null, 2),
    "```",
  ].join("\n");
}

function createTraceItemEvent(input: {
  key: TraceArrayKey;
  item: ResearchTraceItem;
  timestamp: string;
  goalId?: string;
  sourceLoopResultId?: string;
  sourceLoopPlanId?: string;
}): ResearchEvent {
  const eventKind =
    input.key === "hypotheses"
      ? "model.hypothesis"
      : input.key === "inferences"
        ? "model.claim"
        : "model.visible_note";
  const payload = {
    traceKind: input.key,
    text: input.item.text,
    summary: `${labelTraceKey(input.key)}: ${input.item.text}`,
    ...(input.item.evidenceRefIds
      ? { evidenceRefIds: input.item.evidenceRefIds }
      : {}),
    ...(typeof input.item.confidence === "number"
      ? { confidence: input.item.confidence }
      : {}),
    ...(input.sourceLoopResultId
      ? { sourceLoopResultId: input.sourceLoopResultId }
      : {}),
    ...(input.sourceLoopPlanId
      ? { sourceLoopPlanId: input.sourceLoopPlanId }
      : {}),
  };

  return {
    id: createId("event"),
    kind: eventKind,
    timestamp: input.timestamp,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    payload,
  };
}

function createTraceLinkEvent(input: {
  link: ResearchEvidenceLink;
  timestamp: string;
  goalId?: string;
  sourceLoopResultId?: string;
  sourceLoopPlanId?: string;
}): ResearchEvent {
  const summary = createEvidenceLinkSummary(input.link);

  return {
    id: createId("event"),
    kind: "model.visible_note",
    timestamp: input.timestamp,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    payload: {
      traceKind: "evidenceLinks",
      evidenceRefId: input.link.evidenceRefId,
      summary,
      ...(input.link.supports ? { supports: input.link.supports } : {}),
      ...(input.link.weakens ? { weakens: input.link.weakens } : {}),
      ...(input.link.note ? { note: input.link.note } : {}),
      ...(input.sourceLoopResultId
        ? { sourceLoopResultId: input.sourceLoopResultId }
        : {}),
      ...(input.sourceLoopPlanId
        ? { sourceLoopPlanId: input.sourceLoopPlanId }
        : {}),
    },
  };
}

function normalizeTraceItems(
  items: readonly ResearchTraceItem[] | undefined,
): ResearchTraceItem[] {
  return (items ?? [])
    .map((item) => normalizeTraceItem(item))
    .filter((item): item is ResearchTraceItem => item !== undefined);
}

function normalizeTraceItem(
  item: ResearchTraceItem,
): ResearchTraceItem | undefined {
  if (!isRecord(item) || typeof item.text !== "string") {
    return undefined;
  }

  const text = item.text.trim();
  if (text.length === 0) {
    return undefined;
  }

  return {
    text,
    ...(Array.isArray(item.evidenceRefIds)
      ? { evidenceRefIds: item.evidenceRefIds.filter(isString) }
      : {}),
    ...(typeof item.confidence === "number"
      ? { confidence: item.confidence }
      : {}),
  };
}

function normalizeEvidenceLinks(
  links: readonly ResearchEvidenceLink[] | undefined,
): ResearchEvidenceLink[] {
  return (links ?? [])
    .map((link) => normalizeEvidenceLink(link))
    .filter((link): link is ResearchEvidenceLink => link !== undefined);
}

function normalizeEvidenceLink(
  link: ResearchEvidenceLink,
): ResearchEvidenceLink | undefined {
  if (!isRecord(link) || typeof link.evidenceRefId !== "string") {
    return undefined;
  }

  const evidenceRefId = link.evidenceRefId.trim();
  if (evidenceRefId.length === 0) {
    return undefined;
  }

  return {
    evidenceRefId,
    ...(Array.isArray(link.supports)
      ? { supports: link.supports.filter(isString) }
      : {}),
    ...(Array.isArray(link.weakens)
      ? { weakens: link.weakens.filter(isString) }
      : {}),
    ...(typeof link.note === "string" ? { note: link.note.trim() } : {}),
  };
}

function extractTraceJson(text: string): string | undefined {
  const tagged = text.match(
    /```honeycrisp-research-trace-json\s*([\s\S]*?)```/i,
  );
  if (tagged?.[1]) {
    return tagged[1].trim();
  }

  return undefined;
}

function labelTraceKey(key: TraceArrayKey): string {
  return key.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`);
}

function createEvidenceLinkSummary(link: ResearchEvidenceLink): string {
  const parts = [`Evidence link ${link.evidenceRefId}`];
  if (link.supports && link.supports.length > 0) {
    parts.push(`supports ${link.supports.join(", ")}`);
  }
  if (link.weakens && link.weakens.length > 0) {
    parts.push(`weakens ${link.weakens.join(", ")}`);
  }
  if (link.note) {
    parts.push(link.note);
  }

  return parts.join("; ");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
