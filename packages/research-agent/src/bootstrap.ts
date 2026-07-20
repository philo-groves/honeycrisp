import {
  createResearchStorageLayout,
  ensureResearchStorageLayout,
  registerResearchStorageArtifactRef,
} from "./storage.js";
import { createResearchWorkspaceContext } from "./workspace-context.js";
import {
  compileContextPacketV2,
  type ResearchContextPacketV2,
} from "./context-packet-v2.js";
import {
  createDeterministicMemoryRetriever,
  type MemoryRetrievalResult,
  type MemoryRetriever,
} from "./memory-retriever.js";
import { createToolBudget, createToolPermissions } from "./context-packet.js";
import { selectResearchSkills } from "./skills.js";
import {
  createMemorySnapshotFromRecordStore,
  createSqliteMemoryRecordStore,
  type MemoryRecordStore,
} from "./memory-record-store.js";
import { routeEventsToMemorySnapshot } from "./memory-routing.js";
import {
  createSqliteMemoryEventLog,
  type MemoryEventLog,
} from "./memory-event-log.js";
import { createSqliteProofStore, type ProofStore } from "./proof-store.js";
import {
  createDeterministicMemoryWritePipeline,
  type MemoryWritePipeline,
} from "./memory-write-pipeline.js";
import { createResearchTraceEvents } from "./research-trace.js";
import { createId, createResearchEventId, nowIso } from "./ids.js";
import type {
  ResearchAgentExecutor,
  ResearchAgentRunResult,
  ResearchEvent,
  ResearchGovernancePolicy,
  ResearchLiveEventSink,
  ResearchMemorySnapshot,
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
  durableMemory?: boolean | ResearchDurableMemoryIntegrationOptions;
  events?: readonly ResearchEvent[];
  memory?: Partial<ResearchMemorySnapshot>;
  tools?: readonly ResearchToolDescriptor[];
  skills?: readonly ResearchSkillDescriptor[];
  selectedSkillIds?: readonly string[];
  governance?: ResearchGovernancePolicy;
  executor: ResearchAgentExecutor;
  eventSink?: ResearchLiveEventSink;
  signal?: AbortSignal;
}

export interface RunResearchAgentResult {
  prompt: string;
  agentRun: ResearchAgentRunResult;
  events: readonly ResearchEvent[];
  memory: ResearchMemorySnapshot;
  storageLayout: ResearchStorageLayout;
  workspaceContext: ResearchWorkspaceContext;
  selectedSkills: readonly ResearchSelectedSkill[];
  toolPermissions: ReturnType<typeof createToolPermissions>;
  durableMemory?: ResearchDurableMemoryRunSummary;
  piBase: {
    agentCorePackage: "@earendil-works/pi-agent-core";
    aiPackage: "@earendil-works/pi-ai";
  };
  response: string;
}

export interface ResearchDurableMemoryIntegrationOptions {
  eventLog?: MemoryEventLog;
  recordStore?: MemoryRecordStore;
  proofStore?: ProofStore;
  writePipeline?: MemoryWritePipeline;
  retriever?: MemoryRetriever;
  closeStores?: boolean;
}

export interface ResearchDurableMemoryRunSummary {
  enabled: true;
  databasePath?: string;
  eventLogCount: number;
  recordCount: number;
  proofObligationCount: number;
  proofAttemptCount: number;
  eventsAppended: number;
  recordsWritten: number;
  latestRetrievalCandidateCount: number;
  latestContextPacketV2?: ResearchContextPacketV2;
}

interface DurableMemoryRuntime {
  storageLayout: ResearchStorageLayout;
  eventLog: MemoryEventLog;
  recordStore: MemoryRecordStore;
  proofStore: ProofStore;
  writePipeline: MemoryWritePipeline;
  retriever: MemoryRetriever;
  close(): void;
}

interface DurableMemoryStats {
  eventsAppended: number;
  recordsWritten: number;
  latestRetrievalCandidateCount: number;
  latestContextPacketV2?: ResearchContextPacketV2;
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
      storageLayout,
    });
  const durableMemory = createDurableMemoryRuntime({
    option: input.durableMemory,
    storageLayout,
    workspaceRoot: input.workspaceRoot,
  });
  const stats: DurableMemoryStats = {
    eventsAppended: 0,
    recordsWritten: 0,
    latestRetrievalCandidateCount: 0,
  };
  const events: ResearchEvent[] = [];
  let memory = routeEventsToMemorySnapshot([], input.memory);

  try {
    if (input.events?.length) {
      const accepted = durableMemory
        ? appendAndConsolidateDurableEvents(durableMemory, input.events, stats)
        : [...input.events];
      events.push(...accepted);
      memory = refreshMemorySnapshot(durableMemory, events, input.memory);
    }

    const tools = input.tools ?? [];
    const retrieval = durableMemory
      ? durableMemory.retriever.retrieve({
          query: input.prompt,
          recentEvents: events.slice(-20),
          tools,
          ...(input.governance ? { governance: input.governance } : {}),
          recordStore: durableMemory.recordStore,
        })
      : emptyRetrieval();
    stats.latestRetrievalCandidateCount = retrieval.candidates.length;
    const selectedSkills = selectResearchSkills({
      prompt: input.prompt,
      memory,
      skills: input.skills ?? [],
      ...(input.selectedSkillIds
        ? { requestedSkillIds: input.selectedSkillIds }
        : {}),
    });
    const contextPacketV2 = compileContextPacketV2({
      prompt: input.prompt,
      workspaceContext,
      retrieval,
      ...(durableMemory
        ? {
            proofState: {
              obligations: durableMemory.proofStore.listObligations(),
              attempts: durableMemory.proofStore.listAttempts(),
            },
          }
        : {}),
      tools,
      ...(input.governance ? { governance: input.governance } : {}),
      userCommitments: memory.userCommitments,
    });
    stats.latestContextPacketV2 = contextPacketV2;
    const toolBudget = createToolBudget(input.governance, tools);
    const toolPermissions = createToolPermissions(tools, input.governance);
    const modelInput = {
      prompt: input.prompt,
      contextSections: [
        { label: "workspace", content: workspaceContext },
        {
          label: "relevant_memory",
          content: contextPacketV2.sections.flatMap((section) =>
            section.items.map((item) => ({
              kind: item.recordKind,
              status: item.status,
              summary: item.summary,
              confidence: item.confidence,
              warnings: item.warnings,
            })),
          ),
        },
        {
          label: "selected_skills",
          content: selectedSkills.map((skill) => ({
            id: skill.id,
            description: skill.description,
            instructions: skill.instructions,
            runbook: skill.runbook,
          })),
        },
        { label: "storage", content: storageLayout },
        { label: "tool_policy", content: toolPermissions },
      ],
      toolBudget,
      storageLayout,
    };
    const contextEvent: ResearchEvent = {
      id: createResearchEventId(),
      kind: "context.compiled",
      timestamp: nowIso(),
      payload: {
        request: { prompt: input.prompt },
        workspaceContext,
        selectedSkills,
        toolPermissions,
        storage: storageLayout,
        relevantMemory: contextPacketV2.sections.flatMap((section) =>
          section.items.map((item) => item.recordId),
        ),
        summary: "Compiled model context for the research session.",
      },
    };
    emitLiveResearchEvents(input.eventSink, [contextEvent]);
    events.push(
      ...(durableMemory
        ? appendAndConsolidateDurableEvents(durableMemory, [contextEvent], stats)
        : [contextEvent]),
    );

    const startedAt = nowIso();
    let agentRun: ResearchAgentRunResult;
    try {
      const output = await input.executor.execute({
        modelInput,
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

    const completionEvents: ResearchEvent[] = [
      ...(agentRun.output.toolEvents ?? []),
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
    emitLiveResearchEvents(input.eventSink, completionEvents);
    events.push(
      ...(durableMemory
        ? appendAndConsolidateDurableEvents(
            durableMemory,
            completionEvents,
            stats,
          )
        : completionEvents),
    );
    memory = refreshMemorySnapshot(durableMemory, events, memory);

    return {
      prompt: input.prompt,
      agentRun,
      events,
      memory,
      storageLayout,
      workspaceContext,
      selectedSkills,
      toolPermissions,
      ...(durableMemory
        ? { durableMemory: durableMemorySummary(durableMemory, stats) }
        : {}),
      piBase: {
        agentCorePackage: "@earendil-works/pi-agent-core",
        aiPackage: "@earendil-works/pi-ai",
      },
      response: agentRun.output.text,
    };
  } finally {
    durableMemory?.close();
  }
}

function createDurableMemoryRuntime(input: {
  option: RunResearchAgentInput["durableMemory"];
  storageLayout: ResearchStorageLayout;
  workspaceRoot: string | undefined;
}): DurableMemoryRuntime | undefined {
  if (!input.option) return undefined;
  const options = typeof input.option === "object" ? input.option : {};
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const eventLog =
    options.eventLog ??
    createSqliteMemoryEventLog({
      workspaceRoot,
      databasePath: input.storageLayout.databasePath,
      artifactDirectoryPath: input.storageLayout.artifactDirectoryPath,
    });
  const recordStore =
    options.recordStore ??
    createSqliteMemoryRecordStore({
      workspaceRoot,
      databasePath: input.storageLayout.databasePath,
    });
  const proofStore =
    options.proofStore ??
    createSqliteProofStore({
      workspaceRoot,
      databasePath: input.storageLayout.databasePath,
    });
  const closeStores =
    options.closeStores ??
    (!options.eventLog && !options.recordStore && !options.proofStore);

  return {
    storageLayout: input.storageLayout,
    eventLog,
    recordStore,
    proofStore,
    writePipeline:
      options.writePipeline ?? createDeterministicMemoryWritePipeline(),
    retriever: options.retriever ?? createDeterministicMemoryRetriever(),
    close() {
      if (!closeStores) return;
      eventLog.close();
      recordStore.close();
      proofStore.close();
    },
  };
}

function appendAndConsolidateDurableEvents(
  runtime: DurableMemoryRuntime,
  events: readonly ResearchEvent[],
  stats: DurableMemoryStats,
): readonly ResearchEvent[] {
  if (events.length === 0) return [];
  const appended = runtime.eventLog.appendMany(events);
  stats.eventsAppended += appended.length;
  const candidateRecords = runtime.writePipeline.deriveMany(appended);
  for (const event of appended) {
    runtime.proofStore.applyEvent(event);
    for (const artifactRef of event.artifactRefs ?? []) {
      registerResearchStorageArtifactRef(runtime.storageLayout, artifactRef, [
        event.id,
      ]);
    }
  }
  const newRecords = candidateRecords.filter(
    (record) => !runtime.recordStore.getById(record.id),
  );
  if (newRecords.length > 0) {
    runtime.recordStore.writeMany(newRecords);
    stats.recordsWritten += newRecords.length;
  }
  return appended;
}

function refreshMemorySnapshot(
  runtime: DurableMemoryRuntime | undefined,
  events: readonly ResearchEvent[],
  base?: Partial<ResearchMemorySnapshot>,
): ResearchMemorySnapshot {
  if (!runtime) return routeEventsToMemorySnapshot(events, base);
  return createMemorySnapshotFromRecordStore(
    runtime.recordStore,
    runtime.eventLog.listAll(),
  );
}

function durableMemorySummary(
  runtime: DurableMemoryRuntime,
  stats: DurableMemoryStats,
): ResearchDurableMemoryRunSummary {
  const databasePath =
    "databasePath" in runtime.eventLog
      ? String(runtime.eventLog.databasePath)
      : undefined;
  return {
    enabled: true,
    ...(databasePath ? { databasePath } : {}),
    eventLogCount: runtime.eventLog.listAll().length,
    recordCount: runtime.recordStore.list().length,
    proofObligationCount: runtime.proofStore.listObligations().length,
    proofAttemptCount: runtime.proofStore.listAttempts().length,
    eventsAppended: stats.eventsAppended,
    recordsWritten: stats.recordsWritten,
    latestRetrievalCandidateCount: stats.latestRetrievalCandidateCount,
    ...(stats.latestContextPacketV2
      ? { latestContextPacketV2: stats.latestContextPacketV2 }
      : {}),
  };
}

function emptyRetrieval(): MemoryRetrievalResult {
  return {
    candidates: [],
    directEvidence: [],
    findings: [],
    contradictions: [],
    procedures: [],
    prospectiveChecks: [],
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
