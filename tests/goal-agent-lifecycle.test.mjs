import assert from "node:assert/strict";
import test from "node:test";

import {
  ResearchDispositionRecorder,
  createPiAgentExecutor,
  createResearchAgentFlowCapture,
  createResearchToolRegistry,
  createSessionDispositionTool,
  runResearchAgent,
} from "../packages/research-agent/dist/index.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FAUX_MODEL = {
  id: "faux-model",
  name: "Faux Model",
  api: "faux",
  provider: "faux",
  baseUrl: "http://localhost",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

test("goal mode continues one Pi session and keeps session disposition after research budget exhaustion", async () => {
  const objective = "Verify the authorization boundary.";
  const researchPrompt = "Review every relevant entry point and verify the complete authorization-boundary exploit chain with reproducible evidence.";
  const recorder = new ResearchDispositionRecorder();
  const dispositionTool = createSessionDispositionTool(recorder);
  const inspectCalls = [];
  const inspectTool = fixtureInspectTool(inspectCalls);
  const contexts = [];
  const messages = [
    assistant(toolCall("fixture_inspect", { path: "auth.c" }, "inspect_1"), "toolUse"),
    assistant(toolCall("session_disposition", {
      outcome: "objective_partially_achieved",
      summary: "The entry point is verified; the final sink still needs proof.",
      blockerDependencies: [],
      externalStateRequired: false,
    }, "disposition_1"), "toolUse"),
    assistant("The entry point is verified, and I will continue to the sink."),
    assistant([
      toolCall("session_disposition", {
        outcome: "objective_achieved",
        summary: "The complete source-to-sink exploit chain is reproduced and verified.",
        blockerDependencies: [],
        externalStateRequired: false,
      }, "disposition_2"),
    ], "toolUse"),
    assistant("The complete authorization-boundary exploit chain is verified."),
  ];

  const result = await runResearchAgent({
    prompt: researchPrompt,
    tools: [inspectTool.descriptor, dispositionTool.descriptor],
    governance: {
      allowedActionClasses: ["inspect"],
      allowedSideEffects: ["read"],
      allowedPermissions: ["filesystem:read"],
      maxToolCalls: 1,
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      sessionId: "goal_session_fixture",
      models: scriptedModels(messages, contexts),
      toolRegistry: createResearchToolRegistry([inspectTool, dispositionTool]),
      goal: {
        objective,
        getDisposition: () => recorder.get(),
        resetDisposition: () => recorder.resetForGoalContinuation(),
      },
    }),
    finalDispositionProvider: () => recorder.get(),
  });

  assert.deepEqual(inspectCalls, [{ path: "auth.c" }]);
  assert.equal(result.agentRun.output.raw.toolCallCount, 1);
  assert.equal(result.agentRun.output.goal.status, "complete");
  assert.equal(result.agentRun.output.goal.turnsUsed, 2);
  assert.deepEqual(
    result.agentRun.output.raw.agentEvents
      .filter((event) => event.type === "goal_lifecycle")
      .map((event) => ({ status: event.status, continued: event.continued, outcome: event.dispositionOutcome })),
    [
      { status: "active", continued: true, outcome: "objective_partially_achieved" },
      { status: "complete", continued: false, outcome: "objective_achieved" },
    ],
  );
  assert.equal(result.finalDisposition.outcome, "objective_achieved");
  assert.ok(contexts.every((context) => context.sessionId === "goal_session_fixture"));
  assert.ok(contexts[0].toolNames.includes("fixture_inspect"));
  assert.ok(contexts[1].toolNames.includes("session_disposition"));
  assert.ok(!contexts[1].toolNames.includes("fixture_inspect"));
  assert.ok(contexts.every((context) => !context.toolNames.includes("get_goal")));
  assert.ok(contexts.every((context) => !context.toolNames.includes("update_goal")));
  assert.match(contexts[0].systemPrompt, /goal persistence and terminal state are handled by the host/);
  assert.match(
    contexts.flatMap((context) => context.messageContents).join("\n"),
    /Continue research toward: Verify the authorization boundary\./,
  );
  assert.doesNotMatch(
    contexts.flatMap((context) => context.messageContents).join("\n"),
    /Continue research toward: Review every relevant entry point/,
  );

  const capture = createResearchAgentFlowCapture(result);
  assert.equal(capture.schemaVersion, 5);
  assert.equal(capture.agent.goal.status, "complete");
  assert.equal(capture.agent.goal.turnsUsed, 2);
});

function fixtureInspectTool(calls) {
  const parameters = {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  };
  return {
    descriptor: {
      name: "fixture.inspect",
      transportName: "fixture_inspect",
      description: "Inspect a fixture path.",
      actionClasses: ["inspect"],
      sideEffects: "read",
      requiredPermissions: ["filesystem:read"],
      inputSchema: parameters,
    },
    parameters,
    async execute(action) {
      calls.push(action.input);
      const timestamp = new Date().toISOString();
      return {
        action,
        status: "complete",
        startedAt: timestamp,
        completedAt: timestamp,
        summary: `Inspected ${action.input.path}.`,
        artifactRefs: [],
        followUpActions: [],
      };
    },
  };
}

function scriptedModels(messages, contexts) {
  let index = 0;
  return {
    getModel() {
      return FAUX_MODEL;
    },
    streamSimple(_model, context, options = {}) {
      contexts.push({
        systemPrompt: context.systemPrompt,
        sessionId: options.sessionId,
        toolNames: context.tools?.map((tool) => tool.name) ?? [],
        messageContents: context.messages.map((message) => JSON.stringify(message.content)),
      });
      return streamFrom(messages[index++] ?? assistant("No scripted response."));
    },
  };
}

function streamFrom(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "done", message };
    },
    async result() {
      return message;
    },
  };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant",
    content: typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content) ? content : [content],
    api: "faux",
    provider: "faux",
    model: "faux-model",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCall(name, args, id) {
  return { type: "toolCall", id, name, arguments: args };
}
