import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ResearchActionClass,
  ResearchSelectedSkill,
  ResearchSkillDescriptor,
} from "./types.js";

export interface SelectResearchSkillsInput {
  prompt?: string;
  requestedSkillIds?: readonly string[];
  limit?: number;
}

export interface McpSkillMetadata {
  id: string;
  version?: string;
  description: string;
  domainTags?: readonly string[];
  instructions: string;
  recommendedToolNames?: readonly string[];
  recommendedActionClasses?: readonly ResearchActionClass[];
  runbook?: string;
  uri?: string;
}

export class ResearchSkillRegistry {
  readonly #skillsById = new Map<string, ResearchSkillDescriptor>();

  constructor(skills: readonly ResearchSkillDescriptor[] = []) {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  register(skill: ResearchSkillDescriptor): void {
    this.#skillsById.set(skill.id, normalizeSkillDescriptor(skill));
  }

  list(): ResearchSkillDescriptor[] {
    return [...this.#skillsById.values()];
  }

  get(id: string): ResearchSkillDescriptor | undefined {
    return this.#skillsById.get(id);
  }

  select(input: SelectResearchSkillsInput): ResearchSelectedSkill[] {
    return selectResearchSkills({
      ...input,
      skills: this.list(),
    });
  }
}

export function createResearchSkillRegistry(
  skills: readonly ResearchSkillDescriptor[] = [],
): ResearchSkillRegistry {
  return new ResearchSkillRegistry(skills);
}

export function selectResearchSkills(input: SelectResearchSkillsInput & {
  skills: readonly ResearchSkillDescriptor[];
}): ResearchSelectedSkill[] {
  const requested = new Set(input.requestedSkillIds ?? []);
  const goalText = (input.prompt ?? "").toLowerCase();

  return input.skills
    .map((skill) => scoreSkill(skill, goalText, requested))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, input.limit ?? 3)
    .map(({ skill, reasons }) => createSelectedSkill(skill, reasons));
}

export function loadResearchSkillsFromDirectory(
  directoryPath: string,
): ResearchSkillDescriptor[] {
  return readdirSync(directoryPath)
    .map((entry) => join(directoryPath, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((entryPath) => loadResearchSkillFromDirectory(entryPath));
}

export function loadResearchSkillFromDirectory(
  directoryPath: string,
): ResearchSkillDescriptor {
  const skillPath = join(directoryPath, "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const metadata = parseSkillMarkdownMetadata(text);
  const id = metadata.id ?? basename(directoryPath);
  const description =
    metadata.description ?? readFirstMarkdownHeading(text) ?? id;

  return normalizeSkillDescriptor({
    id,
    ...(metadata.version ? { version: metadata.version } : {}),
    description,
    domainTags: metadata.domainTags ?? [],
    instructions: metadata.instructions,
    ...(metadata.recommendedToolNames
      ? { recommendedToolNames: metadata.recommendedToolNames }
      : {}),
    ...(metadata.recommendedActionClasses
      ? { recommendedActionClasses: metadata.recommendedActionClasses }
      : {}),
    ...(metadata.runbook ? { runbook: metadata.runbook } : {}),
    source: {
      kind: "local",
      uri: skillPath,
    },
  });
}

export function createResearchSkillsFromMcpMetadata(
  skills: readonly McpSkillMetadata[],
): ResearchSkillDescriptor[] {
  return skills.map((skill) =>
    normalizeSkillDescriptor({
      id: skill.id,
      ...(skill.version ? { version: skill.version } : {}),
      description: skill.description,
      domainTags: skill.domainTags ?? [],
      instructions: skill.instructions,
      ...(skill.recommendedToolNames
        ? { recommendedToolNames: skill.recommendedToolNames }
        : {}),
      ...(skill.recommendedActionClasses
        ? { recommendedActionClasses: skill.recommendedActionClasses }
        : {}),
      ...(skill.runbook ? { runbook: skill.runbook } : {}),
      source: {
        kind: "mcp",
        ...(skill.uri ? { uri: skill.uri } : {}),
      },
    }),
  );
}

interface ParsedSkillMarkdownMetadata {
  id?: string;
  version?: string;
  description?: string;
  domainTags?: string[];
  recommendedToolNames?: string[];
  recommendedActionClasses?: ResearchActionClass[];
  runbook?: string;
  instructions: string;
}

function scoreSkill(
  skill: ResearchSkillDescriptor,
  goalText: string,
  requested: ReadonlySet<string>,
): {
  skill: ResearchSkillDescriptor;
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  if (requested.has(skill.id)) {
    score += 100;
    reasons.push("explicitly requested");
  }

  for (const tag of skill.domainTags) {
    if (tag && goalText.includes(tag.toLowerCase())) {
      score += 20;
      reasons.push(`matched domain tag ${tag}`);
    }
  }

  for (const token of tokenizeSkillText(`${skill.id} ${skill.description}`)) {
    if (goalText.includes(token)) {
      score += 5;
      reasons.push(`matched skill token ${token}`);
    }
  }

  return { skill, score, reasons: [...new Set(reasons)] };
}

function createSelectedSkill(
  skill: ResearchSkillDescriptor,
  reasons: readonly string[],
): ResearchSelectedSkill {
  return {
    id: skill.id,
    ...(skill.version ? { version: skill.version } : {}),
    description: skill.description,
    domainTags: skill.domainTags,
    instructions: skill.instructions,
    recommendedToolNames: skill.recommendedToolNames ?? [],
    recommendedActionClasses: skill.recommendedActionClasses ?? [],
    ...(skill.governanceHints
      ? { governanceHints: skill.governanceHints }
      : {}),
    ...(skill.runbook ? { runbook: skill.runbook } : {}),
    ...(skill.source ? { source: skill.source } : {}),
    selectionReasons: reasons,
  };
}

function normalizeSkillDescriptor(
  skill: ResearchSkillDescriptor,
): ResearchSkillDescriptor {
  return {
    id: skill.id.trim(),
    ...(skill.version ? { version: skill.version.trim() } : {}),
    description: skill.description.trim(),
    domainTags: [...new Set(skill.domainTags.map((tag) => tag.trim()).filter(Boolean))],
    instructions: skill.instructions.trim(),
    ...(skill.recommendedToolNames
      ? {
          recommendedToolNames: [
            ...new Set(skill.recommendedToolNames.map((name) => name.trim()).filter(Boolean)),
          ],
        }
      : {}),
    ...(skill.recommendedActionClasses
      ? { recommendedActionClasses: [...new Set(skill.recommendedActionClasses)] }
      : {}),
    ...(skill.governanceHints ? { governanceHints: skill.governanceHints } : {}),
    ...(skill.runbook ? { runbook: skill.runbook.trim() } : {}),
    ...(skill.source ? { source: skill.source } : {}),
  };
}

function parseSkillMarkdownMetadata(text: string): ParsedSkillMarkdownMetadata {
  const lines = text.split(/\r?\n/);
  const metadata: ParsedSkillMarkdownMetadata = {
    instructions: text.trim(),
  };
  const instructionStart = lines.findIndex((line) => line.trim() === "---");
  const metadataLines =
    instructionStart >= 0 ? lines.slice(0, instructionStart) : lines.slice(0, 12);
  metadata.instructions =
    instructionStart >= 0
      ? lines.slice(instructionStart + 1).join("\n").trim()
      : text.trim();

  for (const line of metadataLines) {
    const match = line.match(/^([A-Za-z][A-Za-z -]+):\s*(.+)$/);
    if (!match) {
      continue;
    }

    const rawKey = match[1];
    const rawValue = match[2];
    if (!rawKey || !rawValue) {
      continue;
    }

    const key = rawKey.toLowerCase().replace(/\s+/g, "-");
    const value = rawValue.trim();
    if (key === "id") {
      metadata.id = value;
    } else if (key === "version") {
      metadata.version = value;
    } else if (key === "description") {
      metadata.description = value;
    } else if (key === "domain-tags" || key === "tags") {
      metadata.domainTags = parseCsv(value);
    } else if (key === "recommended-tools") {
      metadata.recommendedToolNames = parseCsv(value);
    } else if (key === "recommended-action-classes") {
      metadata.recommendedActionClasses = parseCsv(value).filter(
        isResearchActionClass,
      );
    } else if (key === "runbook") {
      metadata.runbook = value;
    }
  }

  return metadata;
}

function readFirstMarkdownHeading(text: string): string | undefined {
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenizeSkillText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 4);
}

function isResearchActionClass(value: string): value is ResearchActionClass {
  return (
    value === "recall" ||
    value === "search" ||
    value === "inspect" ||
    value === "analyze" ||
    value === "experiment" ||
    value === "synthesize" ||
    value === "ask_user" ||
    value === "respond" ||
    value === "stop"
  );
}
