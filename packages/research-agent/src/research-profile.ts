import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const RESEARCH_PROFILE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RESEARCH_PROFILE_RELATIVE_PATH = ".honeycrisp/profile.json";

export type ResearchProfileAuthorizationMode =
  | "required_for_live_network"
  | "optional";

export type ResearchProfileAttributeType =
  | "string"
  | "number"
  | "boolean";

export interface ResearchProfileAttributeDefinition {
  type: ResearchProfileAttributeType;
  description: string;
  pattern?: string;
  enum?: readonly (string | number | boolean)[];
}

export interface ResearchProfileMemoryRequirement {
  statuses?: readonly string[];
  requiredAttributes?: readonly string[];
  requireEvidence?: boolean;
  requireAssetLinks?: boolean;
  requiredNeighborTypes?: readonly string[];
}

export interface ResearchProfileMemoryType {
  id: string;
  name: string;
  pluralName: string;
  description: string;
  lifecycle: "active" | "retired";
  creatable: boolean;
  replacedBy?: string;
  requiresExplicitStatus?: boolean;
  aliases?: readonly string[];
  group?: string;
  icon?: string;
  color?: string;
  order: number;
  defaultStatus: string;
  allowedStatuses: readonly string[];
  contextWeight?: number;
  attributes?: Readonly<Record<string, ResearchProfileAttributeDefinition>>;
  requirements?: readonly ResearchProfileMemoryRequirement[];
}

export interface ResearchProfileMemoryStatus {
  id: string;
  name: string;
  description: string;
  order: number;
  terminal?: boolean;
  polarity?: "positive" | "neutral" | "negative";
}

export interface ResearchProfileEvidenceKind {
  id: string;
  name: string;
  description: string;
  allowsPath?: boolean;
}

export interface ResearchProfileEvidencePathBase {
  id: string;
  name: string;
  description: string;
  pathFormat?: "relative" | "url" | "either";
}

export interface ResearchProfileMemoryRelation {
  id: string;
  name: string;
  description: string;
}

export interface ResearchProfileMemory {
  types: readonly ResearchProfileMemoryType[];
  statuses: readonly ResearchProfileMemoryStatus[];
  evidenceKinds: readonly ResearchProfileEvidenceKind[];
  evidencePathBases: readonly ResearchProfileEvidencePathBase[];
  relations?: readonly ResearchProfileMemoryRelation[];
  defaultNodeLimit?: number;
  defaultCharacterBudget?: number;
}

export interface ResearchProfileAgentPrompt {
  role: string;
  posture: readonly string[];
  style: readonly string[];
  memoryInstructions: readonly string[];
  runbookInstructions: readonly string[];
}

export interface ResearchProfileWorkflow {
  id: string;
  name: string;
  description: string;
  goalSuggestionCount: number;
  goalSuggestionInstructions: readonly string[];
  promptInstructions: readonly string[];
  outputRequirements: readonly string[];
  default?: boolean;
}

export interface ResearchProfileCapabilities {
  defaultToolFamilies: readonly string[];
  disabledToolFamilies: readonly string[];
  allowedSideEffects: readonly ("none" | "read" | "write" | "network" | "process")[];
  selectedSkillIds: readonly string[];
  disabledSkillIds: readonly string[];
  allowedMcpServerIds: readonly string[];
  memoryEnabled: boolean;
  runbooksEnabled: boolean;
  collaborationEnabled: boolean;
}

export interface ResearchProfileWorkspace {
  workspaceNoun: string;
  subjectNoun: string;
  boundaryNoun: string;
  authorizationMode: ResearchProfileAuthorizationMode;
  boundaryInstructions: readonly string[];
  materialKinds: readonly string[];
}

export interface ResearchProfileModelJob {
  provider?: string;
  model?: string;
  effort?: string;
}

export interface ResearchProfileModelJobs {
  sessionTitle?: ResearchProfileModelJob;
  promptGeneration?: ResearchProfileModelJob;
  goalSuggestions?: ResearchProfileModelJob;
  memoryCuration?: ResearchProfileModelJob;
  shellReview?: ResearchProfileModelJob;
}

export interface ResearchProfilePresentation {
  newResearchLabel: string;
  memoryLabel: string;
  runbookLabel: string;
  sessionLabel: string;
}

export interface ResearchProfile {
  schemaVersion: typeof RESEARCH_PROFILE_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  description: string;
  agent: ResearchProfileAgentPrompt;
  memory: ResearchProfileMemory;
  workflows: readonly ResearchProfileWorkflow[];
  capabilities: ResearchProfileCapabilities;
  workspace: ResearchProfileWorkspace;
  modelJobs: ResearchProfileModelJobs;
  presentation: ResearchProfilePresentation;
}

export interface ResolvedResearchProfile {
  profile: ResearchProfile;
  hash: string;
  source: "bundled-default" | "workspace-default" | "explicit";
  path?: string;
}

export type ResearchProfileMemoryTypeResolution =
  | { state: "active" | "retired"; canonicalId: string; type: ResearchProfileMemoryType }
  | { state: "unknown"; canonicalId: string };

const SECURITY_MEMORY_TYPE_DEFINITIONS: readonly Omit<ResearchProfileMemoryType, "lifecycle" | "creatable">[] = [
  {
    id: "asset",
    name: "Asset",
    pluralName: "Assets",
    description: "A security-relevant component, service, data object, credential, interface, or execution boundary whose compromise or protection matters. Use it to anchor affected ownership and impact; do not use it for arbitrary files with no security role.",
    group: "Assets and boundaries",
    icon: "box",
    color: "slate",
    order: 10,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "bug",
    name: "Historical Bug",
    pluralName: "Historical Bugs",
    description: "A confirmed historical flaw precedent that predates the current research, backed by a fixed advisory, patch, prior incident, or equivalent evidence. It must identify affected assets and set attributes.historicalPrecedent=true; a flaw established during the current research is a primitive, not a bug.",
    group: "Historical precedent",
    icon: "bug",
    color: "orange",
    order: 20,
    defaultStatus: "confirmed",
    requiresExplicitStatus: true,
    allowedStatuses: ["confirmed"],
    attributes: {
      historicalPrecedent: {
        type: "boolean",
        description: "True only for a flaw established before the current research.",
        enum: [true],
      },
    },
    requirements: [{
      requiredAttributes: ["historicalPrecedent"],
      requireEvidence: true,
      requireAssetLinks: true,
    }],
  },
  {
    id: "invariant",
    name: "Invariant",
    pluralName: "Invariants",
    description: "A security property that must remain true across relevant states or transitions. State it as a falsifiable rule whose violation would create security impact, not as a one-off observation.",
    group: "Properties and controls",
    icon: "shield-check",
    color: "blue",
    order: 30,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "mitigation",
    name: "Mitigation",
    pluralName: "Mitigations",
    description: "A concrete product, platform, hardware, policy, or deployment control that prevents or materially constrains exploitation. Record what it blocks and its assumptions; an ordinary validation step is not automatically a mitigation.",
    group: "Properties and controls",
    icon: "shield",
    color: "cyan",
    order: 40,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "source",
    name: "Source",
    pluralName: "Sources",
    description: "An attacker-controlled or lower-trust ingress from which data, control, identity, or state enters the investigated system. Name the trust boundary and reachable input, not merely a function that reads bytes.",
    group: "Assets and boundaries",
    icon: "log-in",
    color: "green",
    order: 50,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "sink",
    name: "Sink",
    pluralName: "Sinks",
    description: "A security-sensitive operation or state transition whose unsafe reachability can produce impact, such as memory access, code execution, authorization, disclosure, or persistence. Name the dangerous effect and required conditions.",
    group: "Assets and boundaries",
    icon: "log-out",
    color: "red",
    order: 60,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "hypothesis",
    name: "Hypothesis",
    pluralName: "Hypotheses",
    description: "A specific, testable, currently unproven security proposition. Keep it draft or suspected while active, reject it when disproven, and reclassify it as a primitive or chain when evidence proves that role; never confirm a hypothesis in place. For a flaw hypothesis, record the suspected mechanism in attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
    group: "Investigation state",
    icon: "flask-conical",
    color: "purple",
    order: 70,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "rejected", "stale"],
    contextWeight: 8,
    attributes: {
      rootCause: { type: "string", description: "Concise suspected underlying mechanism." },
      rootCauseKey: {
        type: "string",
        description: "Stable lowercase-hyphenated identity for the suspected root cause.",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      },
    },
  },
  {
    id: "primitive",
    name: "Primitive",
    pluralName: "Primitives",
    description: "One independently proven security flaw or exploitation capability established during the current research, with direct code, artifact, command, or verifier evidence. Store the underlying root-cause mechanism, not each symptom, experiment, call site, or copy path, as the unit of identity; record attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
    group: "Established results",
    icon: "git-branch",
    color: "amber",
    order: 80,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
    attributes: {
      rootCause: { type: "string", description: "Concise underlying security mechanism." },
      rootCauseKey: {
        type: "string",
        description: "Stable lowercase-hyphenated identity for the underlying root cause.",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      },
    },
    requirements: [{ statuses: ["confirmed"], requireEvidence: true }],
  },
  {
    id: "chain",
    name: "Chain",
    pluralName: "Chains",
    description: "An end-to-end attacker path linking one or more primitives to demonstrated security impact. Record reachability and affected context; source, sink, and asset relationships are ideal when supported but are not required. A confirmed chain requires proof-of-vulnerability evidence and independent review approval; do not use chain for an isolated flaw or an unlinked list of observations. Record its mechanism in attributes.rootCause and a stable lowercase-hyphenated attributes.rootCauseKey.",
    group: "Established results",
    icon: "link",
    color: "rose",
    order: 90,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
    attributes: {
      rootCause: { type: "string", description: "Concise underlying security mechanism." },
      rootCauseKey: {
        type: "string",
        description: "Stable lowercase-hyphenated identity for the underlying root cause.",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      },
      impact: { type: "string", description: "Security consequence if the chain succeeds." },
      reachability: { type: "string", description: "Conditions and path by which the chain can be reached." },
    },
    requirements: [
      { requiredAttributes: ["impact", "reachability"] },
      { statuses: ["confirmed"], requireEvidence: true },
    ],
  },
  {
    id: "procedure",
    name: "Procedure",
    pluralName: "Procedures",
    description: "A concise, reusable operational method for performing a bounded research task or verification. Store essential prerequisites and decision points; use a runbook for an executable multi-step command sequence or environment setup.",
    group: "Reusable methods",
    icon: "list-checks",
    color: "teal",
    order: 100,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
  {
    id: "trajectory",
    name: "Trajectory",
    pluralName: "Trajectories",
    description: "A reusable sequence of significant research choices and results that explains how an investigation advanced or why a path failed. Omit routine narration and transcripts; preserve the discriminating steps and outcome.",
    group: "Reusable methods",
    icon: "route",
    color: "indigo",
    order: 110,
    defaultStatus: "draft",
    allowedStatuses: ["draft", "suspected", "confirmed", "rejected", "stale"],
  },
];

const SECURITY_MEMORY_TYPES: readonly ResearchProfileMemoryType[] = SECURITY_MEMORY_TYPE_DEFINITIONS.map((type) => ({
  ...type,
  lifecycle: "active",
  creatable: true,
}));

export const DEFAULT_SECURITY_RESEARCH_PROFILE: ResearchProfile = {
  schemaVersion: RESEARCH_PROFILE_SCHEMA_VERSION,
  id: "security-research",
  version: "1.0.0",
  name: "Security Research",
  description: "Authorized open-ended vulnerability discovery, chaining, verification, and reporting.",
  agent: {
    role: "You are a world-class security researcher with exceptional judgment, creativity, and persistence in finding novel, high-impact vulnerabilities in complex systems, operating inside the Pi agent harness.",
    posture: [
      "Assume you can perform deep source analysis, design discriminating experiments, use the available tools effectively, and pursue non-obvious attack paths; do not prematurely narrow broad research to confirming or rejecting the first plausible hypothesis.",
      "Use security invariants, mitigations, trajectories, sources, sinks, historic bugs, hypotheses, primitives, and chains as working research representations rather than a fixed scan workflow. A refuted path should redirect exploration within the relevant subsystem, not end it.",
    ],
    style: [
      "Write as a sharp, curious research collaborator using concise, technically precise, cohesive prose.",
      "Do not narrate routine memory updates unless they materially affect the conclusion.",
    ],
    memoryInstructions: [
      "Search memory early and as research crosses system boundaries. Favor security-sensitive code near dangerous sinks, established primitives, historical bugs, and relevant successful trajectories.",
      "Before saving, search for an existing memory with the same underlying fact or root cause and refine it instead of creating a differently worded duplicate.",
      "Evidence is attached to graph nodes as supporting references, not stored as its own memory type. Do not create finding memories; represent suspected flaws as hypotheses and proven flaws as primitives or chains.",
    ],
    runbookInstructions: [
      "List existing workspace runbooks before creating one.",
      "Create or extend a runbook when a proof sequence, environment setup, diagnostic procedure, or repeated investigation path will be useful again.",
      "Keep runbooks operational and reproducible: record exact commands or code, required context, decisive bounded outputs, and interpretation.",
      "Use shell.run for execution; a runbook never executes itself.",
    ],
  },
  memory: {
    types: SECURITY_MEMORY_TYPES,
    statuses: [
      { id: "draft", name: "Draft", description: "Recorded but not yet assessed.", order: 10, polarity: "neutral" },
      { id: "suspected", name: "Suspected", description: "Plausible and under active investigation.", order: 20, polarity: "neutral" },
      { id: "confirmed", name: "Confirmed", description: "Supported by the evidence required for its type.", order: 30, polarity: "positive" },
      { id: "rejected", name: "Rejected", description: "Disproved or invalidated by evidence.", order: 40, terminal: true, polarity: "negative" },
      { id: "stale", name: "Stale", description: "Superseded or no longer current.", order: 50, terminal: true, polarity: "negative" },
    ],
    evidenceKinds: [
      { id: "code", name: "Code", description: "A source or binary code location.", allowsPath: true },
      { id: "artifact", name: "Artifact", description: "A durable generated or captured artifact.", allowsPath: true },
      { id: "command", name: "Command", description: "A bounded command or experiment result.", allowsPath: true },
      { id: "url", name: "URL", description: "An external web reference.", allowsPath: true },
      { id: "human_note", name: "Human Note", description: "An explicit operator-provided note.", allowsPath: false },
    ],
    evidencePathBases: [
      { id: "workspace", name: "Workspace", description: "Relative to the active workspace.", pathFormat: "relative" },
      { id: "repository", name: "Repository", description: "Relative to a recorded repository root.", pathFormat: "relative" },
      { id: "asset_root", name: "Asset Root", description: "Relative to a recorded asset root.", pathFormat: "relative" },
      { id: "external", name: "External", description: "Outside local workspace storage.", pathFormat: "either" },
    ],
    relations: [
      { id: "affects", name: "Affects", description: "The source node materially affects the target." },
      { id: "supports", name: "Supports", description: "The source node supports the target conclusion." },
      { id: "weakens", name: "Weakens", description: "The source node weakens the target conclusion." },
      { id: "reaches", name: "Reaches", description: "The source can reach the target operation or state." },
      { id: "mitigates", name: "Mitigates", description: "The source constrains or prevents the target." },
    ],
    defaultNodeLimit: 12,
    defaultCharacterBudget: 24_000,
  },
  workflows: [
    {
      id: "discovery",
      name: "Discovery",
      description: "Find new security primitives without presuming reachability or impact.",
      goalSuggestionCount: 4,
      default: true,
      goalSuggestionInstructions: [
        "Pair a bounded subsystem, component, or attack surface with a plausible bug class or vulnerability family without assuming a flaw exists.",
        "Keep goals broad and do not make a named hypothesis, verifier, reproduction, impact determination, or source-to-sink path the goal.",
      ],
      promptInstructions: [
        "Center the prompt on open-ended vulnerability research in a bounded subsystem or attack surface.",
        "Do not frame the work as proof or disproof of a predetermined claim.",
      ],
      outputRequirements: ["Evidence-backed observations and the most useful next discriminating actions."],
    },
    {
      id: "chaining",
      name: "Chaining",
      description: "Upgrade recorded primitives toward a reportable exploit chain.",
      goalSuggestionCount: 4,
      goalSuggestionInstructions: [
        "Upgrade existing recorded primitives toward strong reportable exploit chains with triage-ready proofs of concept.",
        "Permit bounded discovery needed to fill reachability, exploitability, or impact gaps.",
      ],
      promptInstructions: ["Center confirmed existing primitives and investigate missing reachability, exploitability, or impact links."],
      outputRequirements: ["A strong evidence-supported chain with a triage-ready proof of concept."],
    },
    {
      id: "reporting",
      name: "Reporting",
      description: "Package an evidence-supported exploit chain for responsible reporting.",
      goalSuggestionCount: 4,
      goalSuggestionInstructions: ["Document evidence-supported exploit chains, their constituent bugs, and their security impact without overstating the evidence."],
      promptInstructions: ["Preserve material limitations and do not invent reachability, impact, or unsupported conclusions."],
      outputRequirements: ["A triage-ready proof of concept and submission.zip containing the proof and necessary evidence."],
    },
  ],
  capabilities: {
    defaultToolFamilies: ["shell"],
    disabledToolFamilies: [],
    allowedSideEffects: ["none", "read", "write", "process"],
    selectedSkillIds: [],
    disabledSkillIds: [],
    allowedMcpServerIds: [],
    memoryEnabled: true,
    runbooksEnabled: true,
    collaborationEnabled: true,
  },
  workspace: {
    workspaceNoun: "Research workspace",
    subjectNoun: "Scope owner or subject",
    boundaryNoun: "Authorized scope",
    authorizationMode: "required_for_live_network",
    boundaryInstructions: [
      "Treat only explicitly in-scope assets as authorized.",
      "Exclusions and constraints override research objectives.",
    ],
    materialKinds: ["repo", "path", "binary", "documentation", "service", "domain", "host", "ip_range"],
  },
  modelJobs: {},
  presentation: {
    newResearchLabel: "New Research",
    memoryLabel: "Memory",
    runbookLabel: "Runbooks",
    sessionLabel: "Research Session",
  },
};

export function getDefaultResearchProfilePath(workspaceRoot: string = process.cwd()): string {
  return resolve(workspaceRoot, DEFAULT_RESEARCH_PROFILE_RELATIVE_PATH);
}

export async function loadResearchProfile(path: string): Promise<ResearchProfile> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  if (Buffer.byteLength(source, "utf8") > 1_000_000) {
    throw new Error("Research profile exceeds the 1000000-byte limit.");
  }
  const parsed = JSON.parse(source) as unknown;
  return normalizeResearchProfile(parsed);
}

export async function resolveResearchProfile(options: {
  workspaceRoot?: string;
  profilePath?: string;
  profile?: unknown;
} = {}): Promise<ResolvedResearchProfile> {
  if (options.profile !== undefined) {
    const profile = normalizeResearchProfile(options.profile);
    return { profile, hash: researchProfileHash(profile), source: "explicit" };
  }
  if (options.profilePath) {
    const path = resolve(options.profilePath);
    const profile = await loadResearchProfile(path);
    return { profile, hash: researchProfileHash(profile), source: "explicit", path };
  }
  const path = getDefaultResearchProfilePath(options.workspaceRoot);
  if (await pathExists(path)) {
    const profile = await loadResearchProfile(path);
    return { profile, hash: researchProfileHash(profile), source: "workspace-default", path };
  }
  const profile = normalizeResearchProfile(DEFAULT_SECURITY_RESEARCH_PROFILE);
  return { profile, hash: researchProfileHash(profile), source: "bundled-default" };
}

export function normalizeResearchProfile(value: unknown): ResearchProfile {
  const input = record(value, "Research profile");
  assertKnownKeys(input, [
    "schemaVersion", "id", "version", "name", "description", "agent", "memory", "workflows",
    "capabilities", "workspace", "modelJobs", "presentation",
  ], "Research profile");
  if (input.schemaVersion !== RESEARCH_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported research profile schemaVersion: ${String(input.schemaVersion)}`);
  }
  const profile: ResearchProfile = {
    schemaVersion: RESEARCH_PROFILE_SCHEMA_VERSION,
    id: identifier(input.id, "profile id"),
    version: nonEmptyString(input.version, "profile version"),
    name: nonEmptyString(input.name, "profile name"),
    description: nonEmptyString(input.description, "profile description"),
    agent: normalizeAgentPrompt(input.agent),
    memory: normalizeMemory(input.memory),
    workflows: normalizeWorkflows(input.workflows),
    capabilities: normalizeCapabilities(input.capabilities),
    workspace: normalizeWorkspace(input.workspace),
    modelJobs: normalizeModelJobs(input.modelJobs),
    presentation: normalizePresentation(input.presentation),
  };
  if (
    profile.capabilities.memoryEnabled
    && !profile.memory.types.some((type) => type.lifecycle === "active" && type.creatable)
  ) {
    throw new Error("A memory-enabled research profile requires at least one active, creatable memory type.");
  }
  return deepFreeze(profile);
}

export function researchProfileHash(profile: ResearchProfile): string {
  return createHash("sha256")
    .update("honeycrisp:research-profile:v1\0")
    .update(stableJson(profile))
    .digest("hex");
}

export function researchProfileMemoryType(
  profile: Pick<ResearchProfile, "memory">,
  typeOrAlias: string,
): ResearchProfileMemoryType | undefined {
  return profile.memory.types.find((type) =>
    type.id === typeOrAlias || type.aliases?.includes(typeOrAlias));
}

export function resolveResearchProfileMemoryType(
  profile: Pick<ResearchProfile, "memory">,
  typeOrAlias: string,
): ResearchProfileMemoryTypeResolution {
  const type = researchProfileMemoryType(profile, typeOrAlias);
  if (!type) return { state: "unknown", canonicalId: typeOrAlias };
  return {
    state: type.lifecycle,
    canonicalId: type.id,
    type,
  };
}

export function researchProfileWorkflow(
  profile: Pick<ResearchProfile, "workflows">,
  workflowId: string | undefined,
): ResearchProfileWorkflow {
  const selected = workflowId
    ? profile.workflows.find((workflow) => workflow.id === workflowId)
    : profile.workflows.find((workflow) => workflow.default) ?? profile.workflows[0];
  if (!selected) throw new Error(`Unknown research workflow: ${workflowId ?? "default"}`);
  return selected;
}

export function overrideResearchProfileMemoryDescriptions(
  profile: ResearchProfile,
  descriptions: Readonly<Record<string, string>>,
): ResearchProfile {
  const supported = new Set(profile.memory.types.map((type) => type.id));
  for (const [id, description] of Object.entries(descriptions)) {
    if (!supported.has(id)) throw new Error(`Unsupported memory type description: ${id}`);
    if (!description.trim()) throw new Error(`Memory type description for ${id} must be non-empty.`);
  }
  return normalizeResearchProfile({
    ...profile,
    memory: {
      ...profile.memory,
      types: profile.memory.types.map((type) => ({
        ...type,
        description: descriptions[type.id]?.trim() || type.description,
      })),
    },
  });
}

function normalizeAgentPrompt(value: unknown): ResearchProfileAgentPrompt {
  const input = record(value, "Research profile agent");
  assertKnownKeys(input, ["role", "posture", "style", "memoryInstructions", "runbookInstructions"], "Research profile agent");
  return {
    role: nonEmptyString(input.role, "agent role"),
    posture: stringArray(input.posture, "agent posture"),
    style: stringArray(input.style, "agent style"),
    memoryInstructions: stringArray(input.memoryInstructions, "memory instructions"),
    runbookInstructions: stringArray(input.runbookInstructions, "runbook instructions"),
  };
}

function normalizeMemory(value: unknown): ResearchProfileMemory {
  const input = record(value, "Research profile memory");
  assertKnownKeys(input, [
    "types", "statuses", "evidenceKinds", "evidencePathBases", "relations", "defaultNodeLimit", "defaultCharacterBudget",
  ], "Research profile memory");
  const statuses = array(input.statuses, "memory statuses").map((status, index) => {
    const item = record(status, `memory status ${index}`);
    assertKnownKeys(item, ["id", "name", "description", "order", "terminal", "polarity"], `memory status ${index}`);
    const polarity = item.polarity;
    if (polarity !== undefined && polarity !== "positive" && polarity !== "neutral" && polarity !== "negative") {
      throw new Error(`Memory status ${index} has invalid polarity.`);
    }
    return {
      id: identifier(item.id, `memory status ${index} id`),
      name: nonEmptyString(item.name, `memory status ${index} name`),
      description: nonEmptyString(item.description, `memory status ${index} description`),
      order: finiteNumber(item.order, `memory status ${index} order`),
      ...(item.terminal === true ? { terminal: true } : {}),
      ...(polarity ? { polarity } : {}),
    } satisfies ResearchProfileMemoryStatus;
  });
  uniqueIds(statuses, "memory status");
  const statusIds = new Set(statuses.map((status) => status.id));
  const types = array(input.types, "memory types").map((type, index) =>
    normalizeMemoryType(type, index, statusIds));
  uniqueIds(types, "memory type");
  const aliases = new Set<string>();
  for (const type of types) {
    for (const alias of type.aliases ?? []) {
      if (statusIds.has(alias) || types.some((candidate) => candidate.id === alias) || aliases.has(alias)) {
        throw new Error(`Duplicate or conflicting memory type alias: ${alias}`);
      }
      aliases.add(alias);
    }
  }
  const typeIds = new Set(types.map((type) => type.id));
  for (const type of types) {
    if (type.replacedBy && !typeIds.has(type.replacedBy)) {
      throw new Error(`Memory type ${type.id} is replaced by unknown memory type ${type.replacedBy}.`);
    }
    if (type.replacedBy === type.id) throw new Error(`Memory type ${type.id} cannot replace itself.`);
    for (const requirement of type.requirements ?? []) {
      for (const neighbor of requirement.requiredNeighborTypes ?? []) {
        if (!typeIds.has(neighbor)) throw new Error(`Memory type ${type.id} requires unknown neighbor type ${neighbor}.`);
      }
    }
  }
  const evidenceKinds = normalizeCatalog<ResearchProfileEvidenceKind>(input.evidenceKinds, "evidence kind", "evidence-kind");
  const evidencePathBases = normalizeCatalog<ResearchProfileEvidencePathBase>(input.evidencePathBases, "evidence path base", "path-base");
  const relations = input.relations === undefined
    ? undefined
    : normalizeCatalog<ResearchProfileMemoryRelation>(input.relations, "memory relation", "plain");
  return {
    types,
    statuses,
    evidenceKinds,
    evidencePathBases,
    ...(relations ? { relations } : {}),
    ...(input.defaultNodeLimit === undefined ? {} : { defaultNodeLimit: positiveInteger(input.defaultNodeLimit, "default memory node limit") }),
    ...(input.defaultCharacterBudget === undefined ? {} : { defaultCharacterBudget: positiveInteger(input.defaultCharacterBudget, "default memory character budget") }),
  };
}

function normalizeMemoryType(
  value: unknown,
  index: number,
  statusIds: ReadonlySet<string>,
): ResearchProfileMemoryType {
  const input = record(value, `memory type ${index}`);
  const id = identifier(input.id, `memory type ${index} id`);
  assertKnownKeys(input, [
    "id", "name", "pluralName", "description", "lifecycle", "creatable", "replacedBy", "requiresExplicitStatus", "aliases",
    "group", "icon", "color", "order", "defaultStatus", "allowedStatuses", "contextWeight", "attributes", "requirements",
  ], `memory type ${id}`);
  const allowedStatuses = stringArray(input.allowedStatuses, `memory type ${id} allowedStatuses`).map((status) => identifier(status, `memory type ${id} status`));
  if (allowedStatuses.length === 0) throw new Error(`Memory type ${id} must allow at least one status.`);
  for (const status of allowedStatuses) {
    if (!statusIds.has(status)) throw new Error(`Memory type ${id} allows unknown status ${status}.`);
  }
  const defaultStatus = identifier(input.defaultStatus, `memory type ${id} defaultStatus`);
  if (!allowedStatuses.includes(defaultStatus)) throw new Error(`Memory type ${id} defaultStatus must be allowed.`);
  const lifecycle = input.lifecycle === undefined ? "active" : input.lifecycle;
  if (lifecycle !== "active" && lifecycle !== "retired") {
    throw new Error(`Memory type ${id} has invalid lifecycle.`);
  }
  const creatable = input.creatable === undefined ? lifecycle === "active" : input.creatable;
  if (typeof creatable !== "boolean") throw new Error(`Memory type ${id} creatable must be a boolean.`);
  if (lifecycle === "retired" && creatable) throw new Error(`Retired memory type ${id} cannot be creatable.`);
  const attributes = input.attributes === undefined
    ? undefined
    : normalizeAttributes(input.attributes, id);
  const requirements = input.requirements === undefined
    ? undefined
    : array(input.requirements, `memory type ${id} requirements`).map((requirement, requirementIndex) => {
        const item = record(requirement, `memory type ${id} requirement ${requirementIndex}`);
        assertKnownKeys(item, [
          "statuses", "requiredAttributes", "requireEvidence", "requireAssetLinks", "requiredNeighborTypes",
        ], `memory type ${id} requirement ${requirementIndex}`);
        const statuses = item.statuses === undefined
          ? undefined
          : stringArray(item.statuses, `memory type ${id} requirement statuses`);
        for (const status of statuses ?? []) {
          if (!allowedStatuses.includes(status)) throw new Error(`Memory type ${id} requirement uses disallowed status ${status}.`);
        }
        const requiredAttributes = item.requiredAttributes === undefined
          ? undefined
          : stringArray(item.requiredAttributes, `memory type ${id} requiredAttributes`);
        for (const attribute of requiredAttributes ?? []) {
          if (!attributes?.[attribute]) throw new Error(`Memory type ${id} requires unknown attribute ${attribute}.`);
        }
        const requiredNeighborTypes = item.requiredNeighborTypes === undefined
          ? undefined
          : stringArray(item.requiredNeighborTypes, `memory type ${id} requiredNeighborTypes`);
        if (requiredNeighborTypes?.length && !statuses?.length) {
          throw new Error(`Memory type ${id} neighbor requirements must be limited to one or more statuses.`);
        }
        return {
          ...(statuses ? { statuses } : {}),
          ...(requiredAttributes ? { requiredAttributes } : {}),
          ...(item.requireEvidence === true ? { requireEvidence: true } : {}),
          ...(item.requireAssetLinks === true ? { requireAssetLinks: true } : {}),
          ...(requiredNeighborTypes ? { requiredNeighborTypes } : {}),
        } satisfies ResearchProfileMemoryRequirement;
      });
  return {
    id,
    name: nonEmptyString(input.name, `memory type ${id} name`),
    pluralName: nonEmptyString(input.pluralName, `memory type ${id} pluralName`),
    description: nonEmptyString(input.description, `memory type ${id} description`),
    lifecycle,
    creatable,
    ...(input.replacedBy === undefined ? {} : { replacedBy: identifier(input.replacedBy, `memory type ${id} replacedBy`) }),
    ...(input.requiresExplicitStatus === true ? { requiresExplicitStatus: true } : {}),
    ...(input.aliases === undefined ? {} : { aliases: stringArray(input.aliases, `memory type ${id} aliases`).map((alias) => identifier(alias, `memory type ${id} alias`)) }),
    ...(optionalString(input.group) ? { group: optionalString(input.group)! } : {}),
    ...(optionalString(input.icon) ? { icon: optionalString(input.icon)! } : {}),
    ...(optionalString(input.color) ? { color: optionalString(input.color)! } : {}),
    order: finiteNumber(input.order, `memory type ${id} order`),
    defaultStatus,
    allowedStatuses,
    ...(input.contextWeight === undefined ? {} : { contextWeight: finiteNumber(input.contextWeight, `memory type ${id} contextWeight`) }),
    ...(attributes ? { attributes } : {}),
    ...(requirements ? { requirements } : {}),
  };
}

function normalizeAttributes(value: unknown, typeId: string): Record<string, ResearchProfileAttributeDefinition> {
  const input = record(value, `memory type ${typeId} attributes`);
  return Object.fromEntries(Object.entries(input).map(([name, raw]) => {
    const item = record(raw, `memory type ${typeId} attribute ${name}`);
    assertKnownKeys(item, ["type", "description", "pattern", "enum"], `memory type ${typeId} attribute ${name}`);
    if (item.type !== "string" && item.type !== "number" && item.type !== "boolean") {
      throw new Error(`Memory type ${typeId} attribute ${name} has invalid type.`);
    }
    const enumValues = item.enum === undefined ? undefined : array(item.enum, `memory type ${typeId} attribute ${name} enum`);
    if (enumValues?.some((entry) => typeof entry !== item.type || (typeof entry === "number" && !Number.isFinite(entry)))) {
      throw new Error(`Memory type ${typeId} attribute ${name} enum does not match its type.`);
    }
    if (item.pattern !== undefined) {
      if (item.type !== "string") throw new Error(`Memory type ${typeId} attribute ${name} pattern requires string type.`);
      try { new RegExp(nonEmptyString(item.pattern, `memory type ${typeId} attribute ${name} pattern`), "u"); }
      catch { throw new Error(`Memory type ${typeId} attribute ${name} has invalid pattern.`); }
    }
    return [name, {
      type: item.type,
      description: nonEmptyString(item.description, `memory type ${typeId} attribute ${name} description`),
      ...(item.pattern === undefined ? {} : { pattern: nonEmptyString(item.pattern, `memory type ${typeId} attribute ${name} pattern`) }),
      ...(enumValues ? { enum: enumValues as (string | number | boolean)[] } : {}),
    } satisfies ResearchProfileAttributeDefinition];
  }));
}

function normalizeCatalog<T extends { id: string; name: string; description: string }>(
  value: unknown,
  label: string,
  mode: "evidence-kind" | "path-base" | "plain",
): T[] {
  const catalog = array(value, `${label}s`).map((entry, index) => {
    const item = record(entry, `${label} ${index}`);
    assertKnownKeys(item, mode === "evidence-kind"
      ? ["id", "name", "description", "allowsPath"]
      : mode === "path-base"
        ? ["id", "name", "description", "pathFormat"]
        : ["id", "name", "description"], `${label} ${index}`);
    const pathFormat = item.pathFormat;
    if (mode === "path-base" && pathFormat !== undefined && pathFormat !== "relative" && pathFormat !== "url" && pathFormat !== "either") {
      throw new Error(`${label} ${index} has invalid pathFormat.`);
    }
    return {
      id: identifier(item.id, `${label} ${index} id`),
      name: nonEmptyString(item.name, `${label} ${index} name`),
      description: nonEmptyString(item.description, `${label} ${index} description`),
      ...(mode === "evidence-kind" && item.allowsPath === true ? { allowsPath: true } : {}),
      ...(mode === "path-base" && pathFormat ? { pathFormat } : {}),
    };
  });
  uniqueIds(catalog, label);
  return catalog as T[];
}

function normalizeWorkflows(value: unknown): ResearchProfileWorkflow[] {
  const workflows = array(value, "research workflows").map((workflow, index) => {
    const item = record(workflow, `research workflow ${index}`);
    const id = identifier(item.id, `research workflow ${index} id`);
    assertKnownKeys(item, [
      "id", "name", "description", "goalSuggestionCount", "goalSuggestionInstructions", "promptInstructions", "outputRequirements", "default",
    ], `research workflow ${id}`);
    return {
      id,
      name: nonEmptyString(item.name, `research workflow ${id} name`),
      description: nonEmptyString(item.description, `research workflow ${id} description`),
      goalSuggestionCount: positiveInteger(item.goalSuggestionCount, `research workflow ${id} goalSuggestionCount`),
      goalSuggestionInstructions: stringArray(item.goalSuggestionInstructions, `research workflow ${id} goalSuggestionInstructions`),
      promptInstructions: stringArray(item.promptInstructions, `research workflow ${id} promptInstructions`),
      outputRequirements: stringArray(item.outputRequirements, `research workflow ${id} outputRequirements`),
      ...(item.default === true ? { default: true } : {}),
    } satisfies ResearchProfileWorkflow;
  });
  if (workflows.length === 0) throw new Error("Research profile requires at least one workflow.");
  uniqueIds(workflows, "research workflow");
  if (workflows.filter((workflow) => workflow.default).length > 1) throw new Error("Research profile may define only one default workflow.");
  return workflows;
}

function normalizeCapabilities(value: unknown): ResearchProfileCapabilities {
  const input = record(value, "Research profile capabilities");
  assertKnownKeys(input, [
    "defaultToolFamilies", "disabledToolFamilies", "allowedSideEffects", "selectedSkillIds",
    "disabledSkillIds", "allowedMcpServerIds", "memoryEnabled", "runbooksEnabled", "collaborationEnabled",
  ], "Research profile capabilities");
  const allowedSideEffects = stringArray(input.allowedSideEffects, "allowed side effects");
  if (allowedSideEffects.some((effect) => !["none", "read", "write", "network", "process"].includes(effect))) {
    throw new Error("Research profile contains an unsupported side effect.");
  }
  return {
    defaultToolFamilies: stringArray(input.defaultToolFamilies, "default tool families"),
    disabledToolFamilies: stringArray(input.disabledToolFamilies, "disabled tool families"),
    allowedSideEffects: allowedSideEffects as ResearchProfileCapabilities["allowedSideEffects"],
    selectedSkillIds: stringArray(input.selectedSkillIds, "selected skill ids"),
    disabledSkillIds: input.disabledSkillIds === undefined ? [] : stringArray(input.disabledSkillIds, "disabled skill ids"),
    allowedMcpServerIds: input.allowedMcpServerIds === undefined ? [] : stringArray(input.allowedMcpServerIds, "allowed MCP server ids"),
    memoryEnabled: optionalBoolean(input.memoryEnabled, true, "memoryEnabled"),
    runbooksEnabled: optionalBoolean(input.runbooksEnabled, true, "runbooksEnabled"),
    collaborationEnabled: optionalBoolean(input.collaborationEnabled, true, "collaborationEnabled"),
  };
}

function normalizeWorkspace(value: unknown): ResearchProfileWorkspace {
  const input = record(value, "Research profile workspace");
  assertKnownKeys(input, [
    "workspaceNoun", "subjectNoun", "boundaryNoun", "authorizationMode", "boundaryInstructions", "materialKinds",
  ], "Research profile workspace");
  if (input.authorizationMode !== "required_for_live_network" && input.authorizationMode !== "optional") {
    throw new Error("Research profile workspace has invalid authorizationMode.");
  }
  return {
    workspaceNoun: nonEmptyString(input.workspaceNoun, "workspace noun"),
    subjectNoun: nonEmptyString(input.subjectNoun, "subject noun"),
    boundaryNoun: nonEmptyString(input.boundaryNoun, "boundary noun"),
    authorizationMode: input.authorizationMode,
    boundaryInstructions: stringArray(input.boundaryInstructions, "boundary instructions"),
    materialKinds: stringArray(input.materialKinds, "material kinds"),
  };
}

function normalizeModelJobs(value: unknown): ResearchProfileModelJobs {
  if (value === undefined) return {};
  const input = record(value, "Research profile modelJobs");
  assertKnownKeys(input, ["sessionTitle", "promptGeneration", "goalSuggestions", "memoryCuration", "shellReview"], "Research profile modelJobs");
  const result: ResearchProfileModelJobs = {};
  for (const key of ["sessionTitle", "promptGeneration", "goalSuggestions", "memoryCuration", "shellReview"] as const) {
    if (input[key] === undefined) continue;
    const job = record(input[key], `model job ${key}`);
    assertKnownKeys(job, ["provider", "model", "effort"], `model job ${key}`);
    result[key] = {
      ...(optionalString(job.provider) ? { provider: optionalString(job.provider)! } : {}),
      ...(optionalString(job.model) ? { model: optionalString(job.model)! } : {}),
      ...(optionalString(job.effort) ? { effort: optionalString(job.effort)! } : {}),
    };
  }
  return result;
}

function normalizePresentation(value: unknown): ResearchProfilePresentation {
  const input = record(value, "Research profile presentation");
  assertKnownKeys(input, ["newResearchLabel", "memoryLabel", "runbookLabel", "sessionLabel"], "Research profile presentation");
  return {
    newResearchLabel: nonEmptyString(input.newResearchLabel, "new research label"),
    memoryLabel: nonEmptyString(input.memoryLabel, "memory label"),
    runbookLabel: nonEmptyString(input.runbookLabel, "runbook label"),
    sessionLabel: nonEmptyString(input.sessionLabel, "session label"),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > 512) throw new Error(`${label} exceeds the 512-item limit.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > 64_000) throw new Error(`${label} exceeds the 64000-character limit.`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = nonEmptyString(value, label);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(id)) {
    throw new Error(`${label} must use lowercase letters, numbers, dots, underscores, or hyphens.`);
  }
  return id;
}

function stringArray(value: unknown, label: string): string[] {
  const values = array(value, label).map((entry) => nonEmptyString(entry, label));
  return [...new Set(values)];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function uniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}
