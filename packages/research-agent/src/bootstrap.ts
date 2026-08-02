import {
  createResearchStorageLayout,
  ensureResearchStorageLayout,
} from "./storage.js";
import { createResearchWorkspaceContext } from "./workspace-context.js";
import { createToolBudget } from "./tool-policy.js";
import { selectResearchSkills } from "./skills.js";
import { createResearchTraceEvents } from "./research-trace.js";
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
import type {
  ResearchAgentExecutor,
  ResearchAgentRunResult,
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
  memoryContext?: readonly ResearchModelMemoryContextNode[];
  events?: readonly ResearchEvent[];
  tools?: readonly ResearchToolDescriptor[];
  skills?: readonly ResearchSkillDescriptor[];
  selectedSkillIds?: readonly string[];
  governance?: ResearchGovernancePolicy;
  executor: ResearchAgentExecutor;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
  finalDispositionProvider?: () => ResearchFinalDisposition | null;
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
    ...(input.selectedSkillIds
      ? { requestedSkillIds: input.selectedSkillIds }
      : {}),
  });
  const toolBudget = createToolBudget(input.governance, tools);
  const collaborationTools = input.executor.collaborationTools ?? [];
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
    ],
    toolBudget,
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
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    response: agentRun.output.text,
    finalDisposition,
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
