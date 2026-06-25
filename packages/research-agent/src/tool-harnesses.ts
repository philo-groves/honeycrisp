import { bootstrapResearchRun, type BootstrapResearchRunResult } from "./bootstrap.js";
import {
  createAnalysisTool,
  createExperimentTool,
  createMemoryRecallTool,
  createRepositorySearchTool,
  createSynthesisTool,
} from "./built-in-tools.js";
import type {
  ResearchArtifactRef,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchLoopExecutor,
  ResearchMemorySnapshot,
  ResearchSelectedSkill,
  ResearchSkillDescriptor,
} from "./types.js";
import type { ResearchExecutableTool } from "./tool-registry.js";
import type { ResearchMcpClient } from "./mcp-tools.js";

export interface ResearchToolEvaluationHarness {
  id: string;
  domain: string;
  prompt: string;
  tools: readonly ResearchExecutableTool[];
  skills: readonly ResearchSkillDescriptor[];
  selectedSkillIds?: readonly string[];
  governance?: ResearchGovernancePolicy;
  expectedToolNames: readonly string[];
}

export interface ResearchToolHarnessRunResult {
  harnessId: string;
  domain: string;
  result: BootstrapResearchRunResult;
  toolEvents: readonly ResearchEvent[];
  observedToolNames: readonly string[];
  blockedToolEvents: readonly ResearchEvent[];
  generatedArtifactRefs: readonly ResearchArtifactRef[];
  selectedSkills: readonly ResearchSelectedSkill[];
  memoryCounts: {
    eventLog: number;
    directEvidence: number;
    priorEpisodes: number;
    candidateProcedures: number;
    currentHypotheses: number;
    contradictions: number;
    prospectiveCommitments: number;
    userCommitments: number;
  };
}

export function createLocalVulnerabilityResearchHarness(options: {
  root: string;
  maxFileBytes?: number;
}): ResearchToolEvaluationHarness {
  const repositorySearch = createRepositorySearchTool({
    root: options.root,
    maxFileBytes: options.maxFileBytes ?? 200_000,
  });

  return {
    id: "local-vulnerability-research",
    domain: "vulnerability-research",
    prompt:
      "Use local tools to search for parser-sensitive symbols before making a vulnerability-research claim.",
    tools: [repositorySearch],
    skills: [createHarnessSkill("harness-vulnerability", "vulnerability", "Prefer local evidence and preserve exploitability uncertainty.")],
    selectedSkillIds: ["harness-vulnerability"],
    governance: {
      allowedActionClasses: ["search", "inspect", "analyze", "synthesize"],
      allowedSideEffects: ["none", "read"],
      allowedPermissions: ["filesystem:read"],
      maxToolCalls: 3,
      maxBytes: options.maxFileBytes ?? 200_000,
    },
    expectedToolNames: ["repository.search"],
  };
}

export function createMathematicsPuzzleHarness(): ResearchToolEvaluationHarness {
  const experiment = createExperimentTool({
    experiments: {
      solve_arithmetic_puzzle(input) {
        const values = Array.isArray(input.values)
          ? input.values.map(Number).filter(Number.isFinite)
          : [];
        return {
          operation: "sum",
          values,
          result: values.reduce((sum, value) => sum + value, 0),
        };
      },
    },
  });
  const analysis = createAnalysisTool();

  return {
    id: "mathematics-puzzle",
    domain: "mathematics",
    prompt:
      "Use the allowlisted arithmetic experiment and deterministic analysis before giving the puzzle answer.",
    tools: [experiment, analysis],
    skills: [createHarnessSkill("harness-math", "mathematics", "Separate computation results from explanation.")],
    selectedSkillIds: ["harness-math"],
    governance: {
      allowedActionClasses: ["experiment", "analyze", "synthesize"],
      allowedSideEffects: ["none", "process"],
      allowedPermissions: ["experiment:run"],
      maxToolCalls: 3,
    },
    expectedToolNames: ["experiment.run", "analysis.transform"],
  };
}

export function createInvestigationSynthesisHarness(): ResearchToolEvaluationHarness {
  const recall = createMemoryRecallTool({
    recall(input) {
      return [
        {
          store: "evidence",
          id: "mem_investigation_source_a",
          recordKind: "evidence",
          summary: `Prior source mentioning ${input.query}`,
          confidence: 0.8,
        },
      ];
    },
  });
  const synthesis = createSynthesisTool();

  return {
    id: "investigation-synthesis",
    domain: "investigation",
    prompt:
      "Recall prior evidence, then synthesize a short provenance-preserving investigation note.",
    tools: [recall, synthesis],
    skills: [createHarnessSkill("harness-investigation", "investigation", "Keep source provenance visible in every conclusion.")],
    selectedSkillIds: ["harness-investigation"],
    governance: {
      allowedActionClasses: ["recall", "synthesize"],
      allowedSideEffects: ["none"],
      maxToolCalls: 3,
    },
    expectedToolNames: ["memory.recall"],
  };
}

export async function runResearchToolHarness(
  harness: ResearchToolEvaluationHarness,
  executor: ResearchLoopExecutor,
): Promise<ResearchToolHarnessRunResult> {
  const result = await bootstrapResearchRun({
    prompt: harness.prompt,
    tools: harness.tools.map((tool) => tool.descriptor),
    skills: harness.skills,
    ...(harness.selectedSkillIds
      ? { selectedSkillIds: harness.selectedSkillIds }
      : {}),
    ...(harness.governance ? { governance: harness.governance } : {}),
    loopExecutor: executor,
    goalRun: {
      maxLoops: 1,
    },
  });
  const toolEvents = result.events.filter(
    (event) => event.kind === "tool.requested" || event.kind === "tool.observed",
  );
  const observedEvents = toolEvents.filter((event) => event.kind === "tool.observed");

  return {
    harnessId: harness.id,
    domain: harness.domain,
    result,
    toolEvents,
    observedToolNames: observedEvents
      .map((event) => readPayloadString(event, "toolName"))
      .filter((name): name is string => Boolean(name)),
    blockedToolEvents: observedEvents.filter(
      (event) => readPayloadString(event, "status") === "blocked",
    ),
    generatedArtifactRefs: observedEvents.flatMap(readGeneratedArtifactRefs),
    selectedSkills: result.decision.selectedSkills,
    memoryCounts: createMemoryCounts(result.memory),
  };
}

export function createToolEvaluationMcpFixture(): {
  client: ResearchMcpClient;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      async listTools() {
        return [
          {
            serverName: "harness",
            name: "search_notes",
            description: "Search harness notes",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string" },
              },
            },
          },
        ];
      },
      async callTool(input) {
        calls.push(input);
        return {
          items: [{ title: "Harness note", query: input.arguments.query }],
        };
      },
      async listResources() {
        return [
          {
            serverName: "harness",
            uri: "mcp://harness/source-a",
            name: "Harness source A",
          },
        ];
      },
      async readResource(input) {
        calls.push(input);
        return {
          text: "Harness resource body",
        };
      },
      async listResourceTemplates() {
        return [
          {
            serverName: "harness",
            uriTemplate: "mcp://harness/{id}",
            name: "Harness resource template",
          },
        ];
      },
    },
  };
}

export function createToolEvaluationSkillFixtures(): ResearchSkillDescriptor[] {
  return [
    createHarnessSkill("harness-vulnerability", "vulnerability", "Prefer local evidence and preserve exploitability uncertainty."),
    createHarnessSkill("harness-math", "mathematics", "Separate computation results from explanation."),
    createHarnessSkill("harness-investigation", "investigation", "Keep source provenance visible in every conclusion."),
  ];
}

function createHarnessSkill(
  id: string,
  domain: string,
  instructions: string,
): ResearchSkillDescriptor {
  return {
    id,
    version: "0.1",
    description: `${domain} harness skill`,
    domainTags: [domain],
    instructions,
    recommendedActionClasses: ["search", "inspect", "analyze", "experiment", "synthesize"],
    source: {
      kind: "inline",
    },
  };
}

function readPayloadString(
  event: ResearchEvent,
  key: string,
): string | undefined {
  return isRecord(event.payload) && typeof event.payload[key] === "string"
    ? event.payload[key]
    : undefined;
}

function readGeneratedArtifactRefs(event: ResearchEvent): ResearchArtifactRef[] {
  if (!isRecord(event.payload) || !Array.isArray(event.payload.generatedArtifactRefs)) {
    return [];
  }

  return event.payload.generatedArtifactRefs.filter(isArtifactRef);
}

function createMemoryCounts(memory: ResearchMemorySnapshot) {
  return {
    eventLog: memory.eventLog.length,
    directEvidence: memory.directEvidence.length,
    priorEpisodes: memory.priorEpisodes.length,
    candidateProcedures: memory.candidateProcedures.length,
    currentHypotheses: memory.currentHypotheses.length,
    contradictions: memory.contradictions.length,
    prospectiveCommitments: memory.prospectiveCommitments.length,
    userCommitments: memory.userCommitments.length,
  };
}

function isArtifactRef(value: unknown): value is ResearchArtifactRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
