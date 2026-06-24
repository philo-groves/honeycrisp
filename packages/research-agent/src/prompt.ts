import type {
  ResearchGoalFrameOptions,
  ResearchPromptFrame,
} from "./types.js";

type PromptField =
  | "rootGoal"
  | "successGates"
  | "failureOrStopGates"
  | "scopeConstraints"
  | "userPreferences"
  | "evidenceRequirements"
  | "initialRiskFlags";

type PromptBuckets = Record<PromptField, string[]>;
type ParsedSection = { field: PromptField; value?: string };

const DEFAULT_SUCCESS_GATES = [
  "The response or artifact directly addresses the root research goal.",
  "Key claims are separated from assumptions and uncertainty.",
] as const;

const DEFAULT_FAILURE_OR_STOP_GATES = [
  "The goal is blocked by missing scope, unavailable evidence, or unsafe assumptions.",
  "The work would require action outside the user's stated scope.",
] as const;

const DEFAULT_EVIDENCE_REQUIREMENTS = [
  "Preserve provenance for evidence used to support conclusions.",
  "Distinguish sourced evidence from inference when that distinction matters.",
] as const;

const SECTION_ALIASES: readonly [PromptField, readonly string[]][] = [
  ["rootGoal", ["goal", "root goal", "objective", "research goal"]],
  [
    "successGates",
    [
      "success",
      "success gate",
      "success gates",
      "completion gate",
      "completion gates",
      "done when",
      "complete when",
    ],
  ],
  [
    "failureOrStopGates",
    [
      "failure",
      "failure gate",
      "failure gates",
      "stop",
      "stop gate",
      "stop gates",
      "failure or stop gates",
      "blockers",
    ],
  ],
  [
    "scopeConstraints",
    [
      "scope",
      "constraint",
      "constraints",
      "scope constraint",
      "scope constraints",
      "out of scope",
    ],
  ],
  [
    "userPreferences",
    ["preference", "preferences", "user preference", "user preferences"],
  ],
  [
    "evidenceRequirements",
    [
      "evidence",
      "evidence requirement",
      "evidence requirements",
      "sources",
      "source requirements",
    ],
  ],
  [
    "initialRiskFlags",
    ["risk", "risks", "risk flag", "risk flags", "initial risk flags"],
  ],
] as const;

export function parseResearchPrompt(
  prompt: string,
  options: ResearchGoalFrameOptions = {},
): ResearchPromptFrame {
  const normalizedPrompt = normalizePrompt(prompt);
  if (normalizedPrompt.length === 0) {
    throw new Error("A research prompt is required.");
  }

  const buckets = createBuckets();
  const objectiveLines: string[] = [];
  let currentField: PromptField | undefined;

  for (const rawLine of normalizedPrompt.split("\n")) {
    const line = stripListMarker(rawLine.trim());
    if (line.length === 0) {
      currentField = undefined;
      continue;
    }

    const section = parseSectionLine(line);
    if (section) {
      currentField = section.field;
      if (section.value) {
        buckets[section.field].push(...splitFieldValue(section.value));
      }
      continue;
    }

    if (currentField) {
      buckets[currentField].push(line);
      continue;
    }

    objectiveLines.push(line);
  }

  mergeOptions(buckets, options);

  const rootGoal = normalizeSentence(
    options.rootGoal ??
      firstDefined(buckets.rootGoal) ??
      objectiveLines.join(" ") ??
      normalizedPrompt,
  );

  return {
    rawPrompt: prompt,
    normalizedPrompt,
    rootGoal,
    successGates: withDefaults(
      buckets.successGates,
      DEFAULT_SUCCESS_GATES,
    ),
    failureOrStopGates: withDefaults(
      buckets.failureOrStopGates,
      DEFAULT_FAILURE_OR_STOP_GATES,
    ),
    scopeConstraints: uniqueNonEmpty(buckets.scopeConstraints),
    userPreferences: uniqueNonEmpty(buckets.userPreferences),
    evidenceRequirements: withDefaults(
      buckets.evidenceRequirements,
      DEFAULT_EVIDENCE_REQUIREMENTS,
    ),
    initialRiskFlags: mergeRiskFlags(
      buckets.initialRiskFlags,
      normalizedPrompt,
    ),
  };
}

function createBuckets(): PromptBuckets {
  return {
    rootGoal: [],
    successGates: [],
    failureOrStopGates: [],
    scopeConstraints: [],
    userPreferences: [],
    evidenceRequirements: [],
    initialRiskFlags: [],
  };
}

function mergeOptions(
  buckets: PromptBuckets,
  options: ResearchGoalFrameOptions,
): void {
  appendAll(buckets.successGates, options.successGates);
  appendAll(buckets.failureOrStopGates, options.failureOrStopGates);
  appendAll(buckets.scopeConstraints, options.scopeConstraints);
  appendAll(buckets.evidenceRequirements, options.evidenceRequirements);
  appendAll(buckets.initialRiskFlags, options.initialRiskFlags);
  appendAll(buckets.userPreferences, options.userPreferences);
}

function parseSectionLine(
  line: string,
): ParsedSection | undefined {
  const match = /^([^:]+):\s*(.*)$/.exec(line);
  if (!match) {
    const field = aliasToField(line);
    return field ? { field } : undefined;
  }

  const label = match[1] ?? "";
  const value = match[2] ?? "";
  const field = aliasToField(label.trim());
  if (!field) {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return { field };
  }

  return { field, value: trimmedValue };
}

function aliasToField(label: string): PromptField | undefined {
  const normalizedLabel = normalizeLabel(label);
  for (const [field, aliases] of SECTION_ALIASES) {
    if (aliases.some((alias) => normalizeLabel(alias) === normalizedLabel)) {
      return field;
    }
  }

  return undefined;
}

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeLabel(label: string): string {
  return label
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripListMarker(line: string): string {
  return line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
}

function splitFieldValue(value: string): string[] {
  return value
    .split(/[;|]/)
    .map((item) => normalizeSentence(item))
    .filter(Boolean);
}

function firstDefined(values: readonly string[]): string | undefined {
  return values.find((value) => value.trim().length > 0);
}

function appendAll(target: string[], values: readonly string[] | undefined): void {
  if (!values) {
    return;
  }

  target.push(...values);
}

function withDefaults(
  values: readonly string[],
  defaults: readonly string[],
): string[] {
  return uniqueNonEmpty([...values, ...defaults]);
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeSentence(value);
    const key = normalized.toLowerCase();
    if (normalized.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function inferRiskFlags(prompt: string): string[] {
  const lowerPrompt = prompt.toLowerCase();
  const flags: string[] = [];

  if (
    /\b(vulnerability|exploit|malware|rce|privilege escalation|sandbox escape|security)\b/.test(
      lowerPrompt,
    )
  ) {
    flags.push("security-sensitive research");
  }

  if (/\b(latest|current|today|recent|now)\b/.test(lowerPrompt)) {
    flags.push("time-sensitive claims may require fresh verification");
  }

  return flags;
}

function mergeRiskFlags(
  explicitFlags: readonly string[],
  prompt: string,
): string[] {
  const explicit = uniqueNonEmpty(explicitFlags);
  const inferred = inferRiskFlags(prompt).filter(
    (flag) => !isRiskAlreadyCovered(flag, explicit),
  );

  return uniqueNonEmpty([...explicit, ...inferred]);
}

function isRiskAlreadyCovered(
  inferredFlag: string,
  explicitFlags: readonly string[],
): boolean {
  const inferred = inferredFlag.toLowerCase();

  if (inferred.includes("security")) {
    return explicitFlags.some((flag) =>
      /\b(security|vulnerability|exploit|rce|malware|sandbox|privilege)\b/.test(
        flag.toLowerCase(),
      ),
    );
  }

  if (inferred.includes("time-sensitive")) {
    return explicitFlags.some((flag) =>
      /\b(time|fresh|current|latest|recent|today)\b/.test(flag.toLowerCase()),
    );
  }

  return explicitFlags.some((flag) => flag.toLowerCase() === inferred);
}
