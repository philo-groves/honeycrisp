import {
  createResearchStorageLayout,
  ensureResearchStorageLayout,
} from "./storage.js";
import { createResearchWorkspaceContext } from "./workspace-context.js";
import { createToolBudget } from "./tool-policy.js";
import { selectResearchSkills } from "./skills.js";
import { createResearchTraceEvents } from "./research-trace.js";
import { discoverResearchAgentInstructions } from "./agent-instructions.js";
import {
  createAvailableToolContext,
  createModelSkillContext,
  createModelWorkspaceContext,
  type ResearchAvailableToolContext,
  type ResearchModelMemoryContextNode,
  type ResearchModelSkillContext,
  type ResearchModelWorkspaceContext,
} from "./model-context.js";
import { createId, createResearchEventId, nowIso } from "./ids.js";
import { fallbackResearchFinalDisposition, type ResearchFinalDisposition } from "./session-disposition-tool.js";
import {
  normalizeResearchProfile,
  resolveResearchProfile,
  researchProfileHash,
  researchProfileWorkflow,
  type ResolvedResearchProfile,
  type ResearchProfileWorkflow,
} from "./research-profile.js";
import type {
  ResearchAgentExecutor,
  ResearchAgentRunResult,
  ResearchAgentInstructions,
  ResearchCollaborationToolDescriptor,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchLiveEventSink,
  ResearchSelectedSkill,
  ResearchSkillDescriptor,
  ResearchStorageLayout,
  ResearchToolDescriptor,
  ResearchWorkspaceContext,
} from "./types.js";

export interface RunResearchAgentInput {
  prompt: string;
  workspaceRoot?: string;
  storageLayout?: ResearchStorageLayout;
  workspaceContext?: ResearchWorkspaceContext;
  agentInstructions?: ResearchAgentInstructions;
  memoryContext?: readonly ResearchModelMemoryContextNode[];
  events?: readonly ResearchEvent[];
  tools?: readonly ResearchToolDescriptor[];
  skills?: readonly ResearchSkillDescriptor[];
  selectedSkillIds?: readonly string[];
  resolvedResearchProfile?: ResolvedResearchProfile;
  workflowId?: string;
  researchIntent?: ResearchRunIntent;
  governance?: ResearchGovernancePolicy;
  executor: ResearchAgentExecutor;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
  finalDispositionProvider?: () => ResearchFinalDisposition | null;
}

export interface ResearchRunIntent {
  successGates?: readonly string[];
  failureOrStopGates?: readonly string[];
  scopeConstraints?: readonly string[];
  evidenceRequirements?: readonly string[];
  initialRiskFlags?: readonly string[];
  userPreferences?: readonly string[];
}

export interface RunResearchAgentResult {
  prompt: string;
  agentRun: ResearchAgentRunResult;
  events: readonly ResearchEvent[];
  storageLayout: ResearchStorageLayout;
  workspaceContext: ResearchWorkspaceContext;
  modelWorkspaceContext: ResearchModelWorkspaceContext;
  memoryContext: readonly ResearchModelMemoryContextNode[];
  modelSelectedSkills: readonly ResearchModelSkillContext[];
  availableTools: readonly ResearchAvailableToolContext[];
  selectedSkills: readonly ResearchSelectedSkill[];
  collaborationTools: readonly ResearchCollaborationToolDescriptor[];
  agentInstructions: ResearchAgentInstructions;
  resolvedResearchProfile: ResolvedResearchProfile;
  researchWorkflow: ResearchProfileWorkflow;
  piBase: {
    agentCorePackage: "@earendil-works/pi-agent-core";
    aiPackage: "@earendil-works/pi-ai";
  };
  response: string;
  finalDisposition: ResearchFinalDisposition;
}

export async function runResearchAgent(
  input: RunResearchAgentInput,
): Promise<RunResearchAgentResult> {
  const suppliedResearchProfile = input.resolvedResearchProfile ?? await resolveResearchProfile({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
  });
  const normalizedProfile = normalizeResearchProfile(suppliedResearchProfile.profile);
  const computedProfileHash = researchProfileHash(normalizedProfile);
  if (suppliedResearchProfile.hash !== computedProfileHash) {
    throw new Error(
      `Resolved research profile hash mismatch: expected ${suppliedResearchProfile.hash}, computed ${computedProfileHash}.`,
    );
  }
  const resolvedResearchProfile: ResolvedResearchProfile = {
    ...suppliedResearchProfile,
    profile: normalizedProfile,
  };
  const researchWorkflow = researchProfileWorkflow(resolvedResearchProfile.profile, input.workflowId);
  const storageLayout = ensureResearchStorageLayout(
    input.storageLayout ??
      createResearchStorageLayout({
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      }),
  );
  const workspaceContext =
    input.workspaceContext ??
    createResearchWorkspaceContext({
      workspaceRoot: input.workspaceRoot ?? process.cwd(),
    });
  const events: ResearchEvent[] = [...(input.events ?? [])];
  const tools = input.tools ?? [];
  const selectedSkills = selectResearchSkills({
    prompt: input.prompt,
    skills: input.skills ?? [],
    ...(input.selectedSkillIds ? { requestedSkillIds: input.selectedSkillIds } : {}),
  });
  const toolBudget = createToolBudget(input.governance, tools);
  const collaborationTools = input.executor.collaborationTools ?? [];
  const agentInstructions = input.agentInstructions ?? discoverResearchAgentInstructions({
    workingDirectory: workspaceContext.workspaceRoot,
  });
  const modelWorkspaceContext = createModelWorkspaceContext(workspaceContext);
  const memoryContext = input.memoryContext ?? [];
  const availableTools = createAvailableToolContext(tools);
  const modelSelectedSkills = createModelSkillContext(selectedSkills);
  const modelInput = {
    prompt: input.prompt,
    contextSections: [
      { label: "workspace", content: modelWorkspaceContext },
      { label: "memory", content: memoryContext },
      {
        label: "selected_skills",
        content: modelSelectedSkills,
      },
      {
        label: "research_profile",
        content: {
          id: resolvedResearchProfile.profile.id,
          version: resolvedResearchProfile.profile.version,
          hash: resolvedResearchProfile.hash,
          name: resolvedResearchProfile.profile.name,
          workflow: {
            id: researchWorkflow.id,
            name: researchWorkflow.name,
            description: researchWorkflow.description,
            outputRequirements: researchWorkflow.outputRequirements,
          },
          workspaceVocabulary: resolvedResearchProfile.profile.workspace,
        },
      },
      ...(hasResearchIntent(input.researchIntent)
        ? [{ label: "research_intent", content: input.researchIntent }]
        : []),
    ],
    toolBudget,
    ...(agentInstructions.content ? { agentInstructions } : {}),
  };
  const contextEvent: ResearchEvent = {
    id: createResearchEventId(),
    kind: "context.compiled",
    timestamp: nowIso(),
    payload: {
      request: { prompt: input.prompt },
      workspaceContext: modelWorkspaceContext,
      memoryContext,
      selectedSkills: modelSelectedSkills,
      availableTools,
      collaborationTools,
      agentInstructions: agentInstructionsMetadata(agentInstructions),
      researchProfile: {
        id: resolvedResearchProfile.profile.id,
        version: resolvedResearchProfile.profile.version,
        hash: resolvedResearchProfile.hash,
        source: resolvedResearchProfile.source,
        workflowId: researchWorkflow.id,
      },
      summary: "Compiled model context for the research session.",
    },
  };
  emitLiveResearchEvents(input.eventSink, [contextEvent]);
  events.push(contextEvent);

  const startedAt = nowIso();
  let agentRun: ResearchAgentRunResult;
  try {
    const output = await input.executor.execute({
      modelInput,
      ...(workspaceContext.authorization ? { authorization: workspaceContext.authorization } : {}),
      ...(input.governance ? { governance: input.governance } : {}),
      ...(input.eventSink ? { eventSink: input.eventSink } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    agentRun = {
      id: createId("agent"),
      status: "complete",
      executorName: input.executor.name,
      startedAt,
      completedAt: nowIso(),
      modelInput,
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentRun = {
      id: createId("agent"),
      status: "error",
      executorName: input.executor.name,
      startedAt,
      completedAt: nowIso(),
      modelInput,
      output: { text: message },
    };
  }

  const terminalEvents: ResearchEvent[] = [
    ...(agentRun.output.researchTrace
      ? createResearchTraceEvents(agentRun.output.researchTrace)
      : []),
    {
      id: createResearchEventId(),
      kind:
        agentRun.status === "complete"
          ? "model.visible_note"
          : "error.observed",
      timestamp: agentRun.completedAt,
      payload: {
        summary:
          agentRun.status === "complete"
            ? "Research agent completed the user request."
            : `Research agent failed: ${agentRun.output.text}`,
        agentRunId: agentRun.id,
      },
    },
  ];
  const finalDisposition = input.finalDispositionProvider?.()
    ?? fallbackResearchFinalDisposition(agentRun.status, agentRun.output.text);
  emitLiveResearchEvents(input.eventSink, terminalEvents);
  events.push(...(agentRun.output.toolEvents ?? []), ...terminalEvents);

  return {
    prompt: input.prompt,
    agentRun,
    events,
    storageLayout,
    workspaceContext,
    modelWorkspaceContext,
    memoryContext,
    availableTools,
    modelSelectedSkills,
    selectedSkills,
    collaborationTools,
    agentInstructions,
    resolvedResearchProfile,
    researchWorkflow,
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    response: agentRun.output.text,
    finalDisposition,
  };
}

function hasResearchIntent(intent: ResearchRunIntent | undefined): intent is ResearchRunIntent {
  return Boolean(intent && Object.values(intent).some((values) => Array.isArray(values) && values.length > 0));
}

function agentInstructionsMetadata(instructions: ResearchAgentInstructions): Record<string, unknown> {
  return {
    schemaVersion: instructions.schemaVersion,
    sources: instructions.sources,
    truncated: instructions.truncated,
    projectDocMaxBytes: instructions.projectDocMaxBytes,
  };
}

function emitLiveResearchEvents(
  sink: ResearchLiveEventSink | undefined,
  events: readonly ResearchEvent[],
): void {
  if (!sink) return;
  for (const event of events) {
    try {
      const pending = sink({
        schemaVersion: 1,
        kind: "research.event",
        timestamp: nowIso(),
        payload: { event },
      });
      if (pending && typeof pending === "object" && "then" in pending) {
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch {
      // Live UI streaming must not affect the research session.
    }
  }
}
