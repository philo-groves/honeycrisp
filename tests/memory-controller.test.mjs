import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapResearchRun,
  createFirstRunMemoryController,
  createLocalInspectionObservationEvent,
  createLocalInspectionTool,
  createPiLoopExecutor,
  createResearchToolRegistry,
  createResearchEventId,
  createResearchFlowCapture,
  createResearchTraceEvents,
  createResearchGoalFrame,
  createResearchMemoryProvenance,
  createResearchMemoryRecordId,
  extractResearchTraceFromText,
  formatResearchEventSequence,
  inferResearchLoopExecutionMode,
  isAcceptedRawEventKind,
  isResearchDerivedMemoryStatus,
  isResearchEventId,
  isResearchMemoryRecordKind,
  normalizeResearchEventSequence,
  planResearchLoop,
  processResearchLoop,
  RESEARCH_DERIVED_MEMORY_STATUSES,
  RESEARCH_MEMORY_RECORD_KINDS,
  routeEventsToMemorySnapshot,
  routeEventToMemory,
} from "../packages/research-agent/dist/index.js";

test("phase 1 memory contracts define canonical ids, sequences, statuses, and provenance", () => {
  const eventId = createResearchEventId();
  const stableRecordId = createResearchMemoryRecordId({
    kind: "semantic_claim",
    sourceEventIds: ["evt_source"],
    discriminator: "claim:parser-reachability",
  });
  const repeatedRecordId = createResearchMemoryRecordId({
    kind: "semantic_claim",
    sourceEventIds: ["evt_source"],
    discriminator: "claim:parser-reachability",
  });
  const provenance = createResearchMemoryProvenance({
    sourceEventIds: ["evt_source"],
    derivation: "model_visible_inference",
    evidenceFor: [
      {
        id: "evidence_source",
        relationship: "supports",
        sourceEventId: "evt_source",
      },
    ],
    evidenceAgainst: [
      {
        id: "evidence_gap",
        relationship: "weakens",
        summary: "Reachability not yet proven.",
      },
    ],
  });

  assert.equal(isResearchEventId(eventId), true);
  assert.equal(formatResearchEventSequence(normalizeResearchEventSequence(7)), "000000000007");
  assert.equal(stableRecordId, repeatedRecordId);
  assert.match(stableRecordId, /^mem_semantic_claim_[0-9a-f]{24}$/);
  assert.deepEqual(RESEARCH_DERIVED_MEMORY_STATUSES, [
    "candidate",
    "active",
    "confirmed",
    "contradicted",
    "superseded",
    "stale",
    "tombstoned",
  ]);
  assert.equal(isResearchDerivedMemoryStatus("superseded"), true);
  assert.equal(isResearchMemoryRecordKind("procedure"), true);
  assert.ok(RESEARCH_MEMORY_RECORD_KINDS.includes("prospective_check"));
  assert.deepEqual(provenance.sourceEventIds, ["evt_source"]);
  assert.equal(provenance.evidenceFor[0]?.relationship, "supports");
  assert.equal(provenance.evidenceAgainst[0]?.relationship, "weakens");
  assert.throws(() => normalizeResearchEventSequence(0), /positive safe integer/);
});

test("first-run controller compiles a typed context packet without recalled memory", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Compare two puzzle-solving strategies",
      "Success gates: explain tradeoffs; recommend next step",
      "Scope constraints: no external search",
      "Evidence: preserve assumptions",
    ].join("\n"),
  );

  const decision = createFirstRunMemoryController().decide({ goalFrame });

  assert.equal(decision.actionClass, "synthesize");
  assert.equal(decision.toolBudget.maxToolCalls, 0);
  assert.equal(decision.contextPacket.goalFrame.root.id, goalFrame.root.id);
  assert.equal(
    decision.contextPacket.activeSubGoal.id,
    decision.subGoal.id,
  );
  assert.deepEqual(decision.contextPacket.directEvidence, []);
  assert.deepEqual(decision.contextPacket.toolPermissions, []);
  assert.ok(
    decision.contextPacket.openQuestions.includes(
      "What evidence is available to satisfy the root goal?",
    ),
  );
  assert.deepEqual(decision.writeback, ["event", "working", "episodic"]);
});

test("memory routes expose stable typed derived-record references", () => {
  const claimEvent = {
    id: "evt_claim_fixture",
    kind: "model.claim",
    timestamp: "2026-06-24T00:00:00.000Z",
    payload: {
      summary: "The parser may normalize nested substitution syntax.",
    },
  };

  const routes = routeEventToMemory(claimEvent);
  const memory = routeEventsToMemorySnapshot([claimEvent]);
  const ref = memory.currentHypotheses[0];

  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.sourceEventId, claimEvent.id);
  assert.equal(ref?.store, "semantic");
  assert.equal(ref?.recordKind, "semantic_claim");
  assert.equal(ref?.status, "candidate");
  assert.deepEqual(ref?.sourceEventIds, [claimEvent.id]);
  assert.match(ref?.id ?? "", /^mem_semantic_claim_[0-9a-f]{24}$/);
});

test("tool observations route as confirmed evidence records", () => {
  const observationEvent = {
    id: "evt_observation_fixture",
    kind: "tool.observed",
    timestamp: "2026-06-24T00:00:00.000Z",
    payload: {
      summary: "Read parser fixture with substitution grammar examples.",
    },
  };
  const memory = routeEventsToMemorySnapshot([observationEvent]);
  const ref = memory.directEvidence[0];

  assert.equal(ref?.store, "evidence");
  assert.equal(ref?.recordKind, "evidence");
  assert.equal(ref?.status, "confirmed");
  assert.deepEqual(ref?.sourceEventIds, [observationEvent.id]);
});

test("first-run controller asks for scope before security-sensitive work", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Triage a suspected parser vulnerability",
      "Risk: security-sensitive authorized vulnerability research",
    ].join("\n"),
  );

  const decision = createFirstRunMemoryController().decide({ goalFrame });

  assert.equal(decision.actionClass, "ask_user");
  assert.match(decision.subGoal.objective, /Confirm missing scope/);
});

test("bootstrap output includes memory decision and context event records", async () => {
  const result = await bootstrapResearchRun({
    prompt: "Goal: Investigate a math puzzle\nScope constraints: no external search",
  });

  assert.equal(result.decision.actionClass, "synthesize");
  assert.equal(result.loopResult.status, "complete");
  assert.equal(result.loopResult.executorName, "deterministic-first-run");
  assert.ok(result.events.length > 5);
  assert.deepEqual(
    result.events.slice(0, 5).map((event) => event.kind),
    [
      "goal.created",
      "memory.decision",
      "context.compiled",
      "loop.planned",
      "loop.processed",
    ],
  );
  assert.equal(
    result.decision.contextPacket.activeGoal.id,
    result.goalFrame.root.id,
  );
  assert.equal(result.loopPlan.subGoal.id, result.decision.subGoal.id);
  assert.equal(result.memory.eventLog.length, result.events.length);
  assert.ok(
    result.events.some((event) => event.kind === "model.visible_note"),
  );
  assert.ok(result.events.some((event) => event.kind === "model.claim"));
  assert.ok(result.loopResult.output.researchTrace);
});

test("flow capture exposes event memory context and trace snapshots", async () => {
  const result = await bootstrapResearchRun({
    prompt: "Goal: Capture a local flow\nScope constraints: no external search",
  });
  const capture = createResearchFlowCapture(result, {
    capturedAt: "2026-06-24T00:00:00.000Z",
  });

  assert.equal(capture.schemaVersion, 1);
  assert.equal(capture.capturedAt, "2026-06-24T00:00:00.000Z");
  assert.equal(capture.goal.objective, "Capture a local flow");
  assert.equal(capture.memory.counts.eventLog, capture.eventTimeline.length);
  assert.equal(capture.context.openQuestions.length > 0, true);
  assert.equal(capture.loop.executionMode, "deterministic");
  assert.equal(capture.loop.raw?.mode, "deterministic");
  assert.ok(capture.loop.researchTrace);
  assert.ok(
    capture.eventTimeline.some((event) => event.kind === "model.visible_note"),
  );
});

test("Pi loop executor makes model calls and exposes execution metadata", async () => {
  let capturedContext;
  let capturedOptions;
  const executor = createPiLoopExecutor({
    provider: "mock-provider",
    model: "mock-model",
    maxTokens: 321,
    reasoning: "low",
    models: {
      getModel(provider, model) {
        assert.equal(provider, "mock-provider");
        assert.equal(model, "mock-model");
        return {
          provider,
          id: model,
          api: "responses",
        };
      },
      async completeSimple(model, context, options) {
        capturedContext = context;
        capturedOptions = options;
        assert.equal(model.provider, "mock-provider");
        assert.equal(model.id, "mock-model");

        return {
          content: [
            {
              type: "text",
              text: [
                "## Result",
                "Mock model call completed.",
                "",
                "```honeycrisp-research-trace-json",
                JSON.stringify({
                  observations: [
                    {
                      text: "The mocked model path executed with the compiled context.",
                      confidence: 0.9,
                    },
                  ],
                  goalAssessment: {
                    status: "ready_to_respond",
                    rationale: "The mocked model call produced a visible trace.",
                  },
                }),
                "```",
              ].join("\n"),
            },
          ],
          stopReason: "stop",
          responseId: "resp_mock_model",
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            totalTokens: 46,
          },
        };
      },
    },
  });

  const result = await bootstrapResearchRun({
    prompt: "Goal: Exercise a Pi-backed model executor\nScope constraints: test only",
    loopExecutor: executor,
    goalRun: {
      maxLoops: 1,
    },
  });

  assert.equal(result.loopResult.status, "complete");
  assert.equal(result.loopResult.executorName, "pi:mock-provider/mock-model");
  assert.equal(inferResearchLoopExecutionMode(result.loopResult), "model");
  assert.equal(capturedOptions.maxTokens, 321);
  assert.equal(capturedOptions.reasoning, "low");
  assert.match(capturedContext.systemPrompt, /Honeycrisp/);
  assert.match(capturedContext.messages[0]?.content, /Visible Research Trace/);
  assert.equal(
    result.loopResult.output.researchTrace?.observations[0]?.text,
    "The mocked model path executed with the compiled context.",
  );

  const raw = result.loopResult.output.raw;
  assert.equal(raw.provider, "mock-provider");
  assert.equal(raw.model, "mock-model");
  assert.equal(raw.api, "responses");
  assert.equal(raw.responseId, "resp_mock_model");
  assert.deepEqual(raw.usage, {
    inputTokens: 12,
    outputTokens: 34,
    totalTokens: 46,
  });

  const capture = createResearchFlowCapture(result);
  assert.equal(capture.loop.executionMode, "model");
  assert.equal(capture.loop.raw.responseId, "resp_mock_model");
  assert.ok(
    capture.eventTimeline.some(
      (event) =>
        event.kind === "loop.processed" &&
        event.payload.executionMode === "model",
    ),
  );
});

test("Pi loop executor executes native tool calls before final response", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tool-native-"));
  const fixtureFile = join(fixtureRoot, "sample.txt");
  await writeFile(fixtureFile, "alpha parser note\nbeta branch note\n");
  const inspectionTool = createLocalInspectionTool({
    allowedRoots: [fixtureRoot],
    maxBytes: 128,
  });
  const toolRegistry = createResearchToolRegistry([inspectionTool.executable]);
  let callCount = 0;
  let finalContext;
  const executor = createPiLoopExecutor({
    provider: "mock-provider",
    model: "mock-model",
    toolRegistry,
    models: {
      getModel(provider, model) {
        return {
          provider,
          id: model,
          api: "responses",
        };
      },
      async completeSimple(model, context) {
        callCount += 1;
        if (callCount === 1) {
          assert.ok(
            context.tools.some((tool) => tool.name === "local_inspection"),
          );
          return {
            content: [
              {
                type: "toolCall",
                id: "call_local_inspection",
                name: "local_inspection",
                arguments: {
                  action: "read_text",
                  path: fixtureFile,
                  maxBytes: 64,
                },
              },
            ],
            stopReason: "toolUse",
            responseId: "resp_tool_request",
            usage: createMockUsage(),
          };
        }

        finalContext = context;
        return {
          content: [
            {
              type: "text",
              text: [
                "## Result",
                "Tool evidence received.",
                "```honeycrisp-research-trace-json",
                JSON.stringify({
                  observations: [
                    {
                      text: "The local inspection tool returned parser notes.",
                    },
                  ],
                  goalAssessment: {
                    status: "continue",
                    rationale: "Tool evidence should now route through memory.",
                  },
                }),
                "```",
              ].join("\n"),
            },
          ],
          stopReason: "stop",
          responseId: "resp_final",
          usage: createMockUsage(),
        };
      },
    },
  });

  const result = await bootstrapResearchRun({
    prompt: "Goal: Inspect local parser evidence\nScope constraints: fixture only",
    tools: [inspectionTool.descriptor],
    loopExecutor: executor,
    goalRun: {
      maxLoops: 1,
    },
  });

  assert.equal(callCount, 2);
  assert.equal(result.loopResult.output.raw.toolCallCount, 1);
  assert.equal(result.loopResult.output.raw.modelCalls.length, 2);
  assert.equal(result.loopResult.output.toolEvents?.length, 2);
  assert.ok(
    finalContext.messages.some((message) => message.role === "toolResult"),
  );
  assert.ok(result.events.some((event) => event.kind === "tool.requested"));
  assert.ok(
    result.memory.directEvidence.some((ref) =>
      ref.summary?.includes("alpha parser note"),
    ),
  );
});

test("Pi loop executor recovers textual tool-call JSON", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tool-text-"));
  const fixtureFile = join(fixtureRoot, "sample.txt");
  await writeFile(fixtureFile, "gamma parser note\n");
  const inspectionTool = createLocalInspectionTool({
    allowedRoots: [fixtureRoot],
    maxBytes: 128,
  });
  const toolRegistry = createResearchToolRegistry([inspectionTool.executable]);
  let callCount = 0;
  const executor = createPiLoopExecutor({
    provider: "mock-provider",
    model: "mock-model",
    toolRegistry,
    models: {
      getModel(provider, model) {
        return {
          provider,
          id: model,
          api: "responses",
        };
      },
      async completeSimple() {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  toolName: "local.inspection",
                  action: "inspect",
                  path: fixtureFile,
                  maxBytes: 64,
                }),
              },
            ],
            stopReason: "stop",
            responseId: "resp_text_tool_request",
            usage: createMockUsage(),
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "## Result\nRecovered textual tool call and inspected local evidence.",
            },
          ],
          stopReason: "stop",
          responseId: "resp_text_final",
          usage: createMockUsage(),
        };
      },
    },
  });

  const result = await bootstrapResearchRun({
    prompt: "Goal: Recover textual tool call\nScope constraints: fixture only",
    tools: [inspectionTool.descriptor],
    loopExecutor: executor,
    goalRun: {
      maxLoops: 1,
    },
  });

  assert.equal(callCount, 2);
  assert.equal(result.loopResult.output.raw.toolCallCount, 1);
  assert.equal(result.loopResult.output.raw.modelCalls.length, 2);
  assert.ok(
    result.memory.directEvidence.some((ref) =>
      ref.summary?.includes("gamma parser note"),
    ),
  );
});

test("goal runtime continues active goals until loop budget when incomplete", async () => {
  const result = await bootstrapResearchRun({
    prompt: [
      "Goal: Build a multi-loop research outline",
      "Success gates: provide final evidence-backed answer",
      "Scope constraints: no external search",
    ].join("\n"),
    goalRun: {
      maxLoops: 2,
    },
  });

  assert.equal(result.loopResults.length, 2);
  assert.equal(result.goalRun.state.status, "active");
  assert.equal(result.goalRun.state.terminalReason, "loop_limit");
  assert.equal(result.goalRun.state.loopsUsed, 2);
  assert.equal(
    result.events.filter((event) => event.kind === "goal.updated").length,
    2,
  );
  assert.ok(
    result.loopPlan.loopPrompt.includes("Goal continuation contract:"),
  );
});

test("goal runtime marks complete only when all root gates are visibly satisfied", async () => {
  const completeExecutor = {
    name: "complete-goal-test",
    async execute(input) {
      const gateIds =
        input.loopPlan.contextPacket.goalFrame.root.completionGates.map(
          (gate) => gate.id,
        );

      return {
        text: "All gates satisfied.",
        artifacts: [],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [],
        researchTrace: {
          observations: [{ text: "Completion evidence was checked." }],
          inferences: [],
          hypotheses: [],
          assumptions: [],
          rejectedPaths: [],
          uncertainty: [],
          nextQuestions: [],
          evidenceLinks: [],
          goalAssessment: {
            status: "complete",
            rationale: "All root gates have explicit satisfied ids.",
            satisfiedGateIds: gateIds,
          },
        },
      };
    },
  };
  const result = await bootstrapResearchRun({
    prompt: "Goal: Finish the proof\nSuccess gates: proof checked",
    loopExecutor: completeExecutor,
    goalRun: {
      maxLoops: 3,
    },
  });

  assert.equal(result.loopResults.length, 1);
  assert.equal(result.goalRun.state.status, "complete");
  assert.equal(result.goalRun.state.terminalReason, "complete");
});

test("goal runtime blocks only after repeated identical blockers", async () => {
  const blockingExecutor = {
    name: "blocking-goal-test",
    async execute() {
      throw new Error("waiting on missing fixture");
    },
  };
  const result = await bootstrapResearchRun({
    prompt: "Goal: Inspect a missing fixture\nScope constraints: local only",
    loopExecutor: blockingExecutor,
    goalRun: {
      maxLoops: 3,
      blockedThreshold: 3,
    },
  });

  assert.equal(result.loopResults.length, 3);
  assert.equal(result.goalRun.state.status, "blocked");
  assert.equal(result.goalRun.state.terminalReason, "blocked");
  assert.equal(result.goalRun.state.consecutiveBlockedCount, 3);
});

test("goal runtime can complete an unbounded bounded function walk", async () => {
  const sourceText = [
    "export function parseAlpha(input: string) { return input.trim(); }",
    "export function parseBeta(input: string) { return input.toUpperCase(); }",
    "export function parseGamma(input: string) { return input.length; }",
  ].join("\n");
  const functionNames = [...sourceText.matchAll(/function\s+([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter(Boolean);
  let index = 0;
  const walkedFunctions = [];
  const functionWalkExecutor = {
    name: "function-walk-test",
    async execute(input) {
      const functionName = functionNames[index];
      assert.ok(functionName, "expected one function per dynamic loop");
      index += 1;
      walkedFunctions.push(functionName);
      const complete = walkedFunctions.length === functionNames.length;
      const gateIds =
        input.loopPlan.contextPacket.goalFrame.root.completionGates.map(
          (gate) => gate.id,
        );

      return {
        text: `Walked ${functionName}: identified inputs, output, and local behavior.`,
        artifacts: [`function note: ${functionName}`],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: complete
          ? []
          : [`Walk next function: ${functionNames[index]}`],
        researchTrace: {
          observations: [
            {
              text: `Walked function ${functionName}.`,
              confidence: 1,
            },
          ],
          inferences: [
            {
              text: `${functionName} has a simple single-return behavior in the fixture.`,
              confidence: 0.8,
            },
          ],
          hypotheses: [],
          assumptions: [],
          rejectedPaths: [],
          uncertainty: complete
            ? []
            : [
                {
                  text: `Remaining functions: ${functionNames
                    .slice(index)
                    .join(", ")}`,
                  confidence: 1,
                },
              ],
          nextQuestions: complete
            ? []
            : [
                {
                  text: `Walk ${functionNames[index]} next.`,
                  confidence: 1,
                },
              ],
          evidenceLinks: [],
          goalAssessment: complete
            ? {
                status: "complete",
                rationale: `Walked all functions: ${walkedFunctions.join(", ")}.`,
                satisfiedGateIds: gateIds,
              }
            : {
                status: "continue",
                rationale: `Walked ${functionName}; more functions remain.`,
                unsatisfiedGateIds: gateIds,
              },
        },
      };
    },
  };

  const result = await bootstrapResearchRun({
    prompt: [
      "Goal: Walk each function in the tiny fixture source file",
      "Success gates: every function has an individual walk note; final assessment lists all walked functions",
      "Scope constraints: fixture source only",
      "Evidence: one loop per function",
    ].join("\n"),
    loopExecutor: functionWalkExecutor,
    goalRun: {
      maxLoops: null,
      safetyMaxLoops: 10,
    },
  });

  assert.deepEqual(walkedFunctions, functionNames);
  assert.equal(result.loopResults.length, functionNames.length);
  assert.equal(result.goalRun.state.maxLoops, null);
  assert.equal(result.goalRun.state.terminalReason, "complete");
  assert.equal(result.goalRun.state.status, "complete");
  assert.equal(result.goalRun.state.loopsUsed, functionNames.length);
  assert.deepEqual(
    result.loopResults.map((loop) => loop.output.researchTrace?.observations[0]?.text),
    functionNames.map((name) => `Walked function ${name}.`),
  );
  assert.equal(
    result.events.filter((event) => event.kind === "goal.updated").length,
    functionNames.length,
  );
});

test("goal runtime stops a function walk when a stop gate is reached", async () => {
  const functionNames = ["parseAlpha", "parseBeta", "parseGamma"];
  const walkedFunctions = [];
  let index = 0;
  const stopAfterTwoExecutor = {
    name: "function-walk-stop-test",
    async execute(input) {
      const functionName = functionNames[index];
      assert.ok(functionName, "expected a function to walk");
      index += 1;
      walkedFunctions.push(functionName);
      const shouldStop = walkedFunctions.length >= 2;
      const stopGateIds =
        input.loopPlan.contextPacket.goalFrame.root.stopGates.map(
          (gate) => gate.id,
        );
      const successGateIds =
        input.loopPlan.contextPacket.goalFrame.root.completionGates.map(
          (gate) => gate.id,
        );

      return {
        text: `Walked ${functionName}.`,
        artifacts: [`function note: ${functionName}`],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: shouldStop ? [] : [`Walk next function: ${functionNames[index]}`],
        researchTrace: {
          observations: [{ text: `Walked function ${functionName}.`, confidence: 1 }],
          inferences: [],
          hypotheses: [],
          assumptions: [],
          rejectedPaths: shouldStop
            ? [
                {
                  text: "Skipping remaining functions because the max-two stop gate was reached.",
                  confidence: 1,
                },
              ]
            : [],
          uncertainty: shouldStop
            ? []
            : [
                {
                  text: `Remaining functions: ${functionNames.slice(index).join(", ")}`,
                  confidence: 1,
                },
              ],
          nextQuestions: shouldStop
            ? []
            : [{ text: `Walk ${functionNames[index]} next.`, confidence: 1 }],
          evidenceLinks: [],
          goalAssessment: shouldStop
            ? {
                status: "stopped",
                rationale: "Stop condition reached after walking two functions.",
                triggeredStopGateIds: stopGateIds,
                unsatisfiedGateIds: successGateIds,
              }
            : {
                status: "continue",
                rationale: `Walked ${functionName}; stop condition is not reached yet.`,
                unsatisfiedGateIds: successGateIds,
              },
        },
      };
    },
  };

  const result = await bootstrapResearchRun({
    prompt: [
      "Goal: Walk each function in the tiny fixture source file",
      "Success gates: every function has an individual walk note; final assessment lists all walked functions",
      "Stop gates: stop after walking a maximum of two functions",
      "Scope constraints: fixture source only",
    ].join("\n"),
    loopExecutor: stopAfterTwoExecutor,
    goalRun: {
      maxLoops: null,
      safetyMaxLoops: 10,
    },
  });

  assert.deepEqual(walkedFunctions, ["parseAlpha", "parseBeta"]);
  assert.equal(result.loopResults.length, 2);
  assert.equal(result.goalRun.state.status, "stopped");
  assert.equal(result.goalRun.state.terminalReason, "stop_gate");
  assert.equal(result.goalRun.state.maxLoops, null);
  assert.ok(!walkedFunctions.includes("parseGamma"));
});

test("raw event acceptance excludes private thought traces", () => {
  assert.equal(isAcceptedRawEventKind("model.visible_note"), true);
  assert.equal(isAcceptedRawEventKind("model.hypothesis"), true);
  assert.equal(isAcceptedRawEventKind("model.private_thought"), false);
});

test("visible research trace consequences route through memory", () => {
  const trace = {
    observations: [
      {
        text: "The parser source was inspected.",
        evidenceRefIds: ["evidence_parse"],
        confidence: 0.9,
      },
    ],
    inferences: [
      {
        text: "Parser entrypoints are the next useful review area.",
        evidenceRefIds: ["evidence_parse"],
        confidence: 0.7,
      },
    ],
    hypotheses: [
      {
        text: "Nested substitutions may expose a state-machine edge case.",
        evidenceRefIds: ["evidence_parse"],
        confidence: 0.45,
      },
    ],
    assumptions: [],
    rejectedPaths: [
      {
        text: "Network probing is out of scope.",
        confidence: 1,
      },
    ],
    uncertainty: [
      {
        text: "Reachability is not yet established.",
        confidence: 0.8,
      },
    ],
    nextQuestions: [
      {
        text: "Which parser states consume attacker-controlled text?",
        confidence: 0.8,
      },
    ],
    evidenceLinks: [
      {
        evidenceRefId: "evidence_parse",
        supports: ["hypothesis_parser_state"],
        note: "Initial source evidence.",
      },
    ],
  };
  const events = createResearchTraceEvents(trace, {
    timestamp: "2026-06-24T00:00:00.000Z",
  });
  const memory = routeEventsToMemorySnapshot(events);

  assert.ok(events.some((event) => event.kind === "model.hypothesis"));
  assert.ok(events.some((event) => event.kind === "model.claim"));
  assert.ok(events.some((event) => event.kind === "model.visible_note"));
  assert.ok(
    memory.currentHypotheses.some((ref) =>
      ref.summary?.includes("Nested substitutions"),
    ),
  );
  assert.ok(
    memory.priorEpisodes.some((ref) =>
      ref.summary?.includes("Reachability is not yet established"),
    ),
  );
});

test("model trace extraction reads only visible trace JSON", () => {
  const trace = extractResearchTraceFromText(
    [
      "Result text.",
      "```honeycrisp-research-trace-json",
      JSON.stringify({
        observations: [{ text: "Visible observation", confidence: 0.9 }],
        hypotheses: [{ text: "Visible hypothesis" }],
      }),
      "```",
    ].join("\n"),
  );

  assert.equal(trace?.observations[0]?.text, "Visible observation");
  assert.equal(trace?.hypotheses[0]?.text, "Visible hypothesis");
  assert.deepEqual(trace?.inferences, []);
});

test("model trace extraction accepts compact string trace items", () => {
  const trace = extractResearchTraceFromText(
    [
      "Result text.",
      "```honeycrisp-research-trace-json",
      JSON.stringify({
        observations: ["Visible compact observation"],
        inferences: ["Visible compact inference"],
        evidenceLinks: ["evidence_parse"],
      }),
      "```",
    ].join("\n"),
  );

  assert.equal(trace?.observations[0]?.text, "Visible compact observation");
  assert.equal(trace?.inferences[0]?.text, "Visible compact inference");
  assert.equal(trace?.evidenceLinks[0]?.evidenceRefId, "evidence_parse");
});

test("model trace extraction recovers complete JSON from an unterminated fence", () => {
  const trace = extractResearchTraceFromText(
    [
      "Result text.",
      "```honeycrisp-research-trace-json",
      JSON.stringify({
        observations: [
          {
            text: "Visible observation with source shorthand",
            source: "mem_evidence_parse",
          },
        ],
        nextQuestions: ["Which parser entrypoint handles nested quotes?"],
        evidenceLinks: ["mem_evidence_parse"],
      }),
    ].join("\n"),
  );

  assert.equal(
    trace?.observations[0]?.text,
    "Visible observation with source shorthand",
  );
  assert.deepEqual(trace?.observations[0]?.evidenceRefIds, [
    "mem_evidence_parse",
  ]);
  assert.equal(
    trace?.nextQuestions[0]?.text,
    "Which parser entrypoint handles nested quotes?",
  );
  assert.equal(trace?.evidenceLinks[0]?.evidenceRefId, "mem_evidence_parse");
});

test("local inspection observations route into direct evidence context", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-inspect-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "honeycrisp-outside-"));
  const fixtureFile = join(fixtureRoot, "sample.txt");
  const outsideFile = join(outsideRoot, "sample.txt");
  await writeFile(fixtureFile, "alpha parser note\nbeta branch note\n");
  await writeFile(outsideFile, "outside scope\n");

  const inspectionTool = createLocalInspectionTool({
    allowedRoots: [fixtureRoot],
    maxBytes: 128,
  });
  const inspection = await inspectionTool.inspect({
    action: "read_text",
    path: fixtureFile,
  });
  const event = createLocalInspectionObservationEvent(inspection, {
    id: "event_fixture_inspected",
    timestamp: "2026-06-24T00:00:00.000Z",
  });
  const memory = routeEventsToMemorySnapshot([event]);

  assert.equal(inspection.type, "file");
  assert.equal(event.kind, "tool.observed");
  assert.equal(memory.directEvidence.length, 1);
  assert.match(memory.directEvidence[0]?.summary ?? "", /alpha parser note/);

  const goalFrame = createResearchGoalFrame(
    "Goal: Inspect local evidence\nScope constraints: local fixture only",
  );
  const decision = createFirstRunMemoryController().decide({
    goalFrame,
    memory,
    events: [event],
    tools: [inspectionTool.descriptor],
  });

  assert.equal(decision.actionClass, "inspect");
  assert.equal(decision.contextPacket.directEvidence.length, 1);
  assert.equal(
    decision.contextPacket.openQuestions.includes(
      "What evidence is available to satisfy the root goal?",
    ),
    false,
  );
  await assert.rejects(
    () => inspectionTool.inspect({ action: "read_text", path: outsideFile }),
    /outside allowed inspection roots/,
  );
});

test("loop planner turns a memory decision into an executable bounded plan", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Compare two puzzle-solving strategies",
      "Success gates: explain tradeoffs; recommend next step",
      "Scope constraints: no external search",
      "Evidence: preserve assumptions",
    ].join("\n"),
  );
  const decision = createFirstRunMemoryController().decide({ goalFrame });
  const loopPlan = planResearchLoop({ decision });

  assert.equal(loopPlan.subGoal.id, decision.subGoal.id);
  assert.equal(loopPlan.reason, decision.subGoal.rationale);
  assert.deepEqual(loopPlan.actionBudget, decision.toolBudget);
  assert.deepEqual(loopPlan.writebackRequirements, decision.writeback);
  assert.ok(
    loopPlan.requiredContext.some(
      (section) => section.label === "goal_frame" && section.required,
    ),
  );
  assert.ok(loopPlan.loopPrompt.includes("Loop sub-goal:"));
  assert.ok(loopPlan.loopPrompt.includes("Required context manifest:"));
});

test("loop processor executes a planned loop and preserves isolated model input", async () => {
  const goalFrame = createResearchGoalFrame(
    "Goal: Investigate a math puzzle\nScope constraints: no external search",
  );
  const decision = createFirstRunMemoryController().decide({ goalFrame });
  const loopPlan = planResearchLoop({ decision });
  const result = await processResearchLoop({ loopPlan });

  assert.equal(result.status, "complete");
  assert.equal(result.loopPlanId, loopPlan.id);
  assert.equal(result.executorName, "deterministic-first-run");
  assert.equal(result.modelInput.loopPrompt, loopPlan.loopPrompt);
  assert.ok(
    result.modelInput.contextSections.some(
      (section) => section.label === "goal_frame" && section.required,
    ),
  );
  assert.ok(result.output.text.includes("Initial loop result:"));
  assert.deepEqual(result.output.artifacts, loopPlan.expectedArtifacts);
});

function createMockUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
