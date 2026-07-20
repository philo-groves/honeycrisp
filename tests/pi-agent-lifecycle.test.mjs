import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiAgentExecutor,
  createResearchToolRegistry,
  runResearchAgent,
} from "../packages/research-agent/dist/index.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};
const FAUX_MODEL = {
  id: "faux-model",
  name: "Faux Model",
  api: "faux",
  provider: "faux",
  baseUrl: "http://localhost",
  reasoning: false,
  input: [],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 100_000,
  maxTokens: 4096,
};

test("direct Pi Agent executor runs Honeycrisp tools through lifecycle hooks", async () => {
  const calls = [];
  const contexts = [];
  const tool = createFixtureInspectTool(calls);
  const models = createScriptedModels(
    [
      assistant(toolCall("fixture_inspect", { path: "parse.c" }, "tool_1"), "toolUse"),
      assistant("## Result\nInspected parse.c through the Agent lifecycle."),
    ],
    contexts,
  );
  const result = await runResearchAgent({
    prompt: "Inspect parse.c with the fixture tool.",
    tools: [tool.descriptor],
    governance: {
      allowedActionClasses: ["inspect"],
      allowedSideEffects: ["read"],
      allowedPermissions: ["filesystem:read"],
      maxToolCalls: 1,
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models,
      toolRegistry: createResearchToolRegistry([tool]),
      toolExecution: "sequential",
    }),
  });
  const raw = result.agentRun.output.raw;
  const observed = result.agentRun.output.toolEvents.find(
    (event) => event.kind === "tool.observed",
  );

  assert.equal(result.agentRun.executorName, "pi:faux/faux-model:agent");
  assert.equal(raw.lifecycle, "pi-agent");
  assert.equal(raw.toolExecutionMode, "sequential");
  assert.equal(raw.toolCallCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(observed.payload.toolName, "fixture.inspect");
  assert.equal(observed.payload.status, "complete");
  assert.ok(raw.agentEvents.some((event) => event.type === "tool_execution_update"));
  assert.deepEqual(contexts[0].toolNames, ["fixture_inspect"]);
  assert.deepEqual(contexts[1].toolNames, []);
});

test("Pi Agent keeps tools available without an explicit governance call limit", async () => {
  const calls = [];
  const contexts = [];
  const tool = createFixtureInspectTool(calls);
  const result = await runResearchAgent({
    prompt: "Inspect four fixture paths before reporting.",
    tools: [tool.descriptor],
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels(
        [
          assistant(toolCall("fixture_inspect", { path: "one.c" }, "tool_1"), "toolUse"),
          assistant(toolCall("fixture_inspect", { path: "two.c" }, "tool_2"), "toolUse"),
          assistant(toolCall("fixture_inspect", { path: "three.c" }, "tool_3"), "toolUse"),
          assistant(toolCall("fixture_inspect", { path: "four.c" }, "tool_4"), "toolUse"),
          assistant("## Result\nInspected all four paths."),
        ],
        contexts,
      ),
      toolRegistry: createResearchToolRegistry([tool]),
    }),
  });

  assert.equal(result.agentRun.output.raw.toolCallCount, 4);
  assert.deepEqual(calls.map((call) => call.path), ["one.c", "two.c", "three.c", "four.c"]);
  assert.ok(contexts.slice(0, 5).every((context) => context.toolNames.includes("fixture_inspect")));
});

test("Pi Agent beforeToolCall preflight preserves blocked tool events", async () => {
  const calls = [];
  const contexts = [];
  const tool = createFixtureInspectTool(calls);
  const deniedGovernance = {
    allowedActionClasses: ["inspect"],
    allowedSideEffects: ["none"],
    allowedPermissions: ["filesystem:read"],
    maxToolCalls: 1,
  };
  const result = await runResearchAgent({
    prompt: "Inspect parse.c with a denied tool.",
    tools: [tool.descriptor],
    governance: deniedGovernance,
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels(
        [
          assistant(toolCall("fixture_inspect", { path: "parse.c" }, "tool_blocked"), "toolUse"),
          assistant("## Result\nThe tool was blocked by governance and no inspection ran."),
        ],
        contexts,
      ),
      toolRegistry: createResearchToolRegistry([tool]),
    }),
  });
  const observed = result.agentRun.output.toolEvents.find(
    (event) => event.kind === "tool.observed",
  );

  assert.equal(calls.length, 0);
  assert.equal(result.agentRun.output.raw.toolCallCount, 1);
  assert.equal(observed.payload.status, "blocked");
  assert.match(observed.payload.summary, /side effect read is not allowed/);
  assert.ok(
    result.agentRun.output.raw.agentEvents.some(
      (event) => event.type === "tool_execution_end" && event.isError === true,
    ),
  );
  assert.deepEqual(contexts[1].toolNames, []);
});

test("Pi Agent executor streams live thought events", async () => {
  const liveEvents = [];
  const result = await runResearchAgent({
    prompt: "Prepare a concise parser inspection plan.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createThoughtStreamingModels(),
    }),
  });
  const thoughtEvents = liveEvents.filter((event) => event.kind === "model.thought");
  const agentEvents = liveEvents.filter((event) => event.kind === "agent.event");

  assert.equal(result.agentRun.status, "complete");
  assert.ok(thoughtEvents.length >= 2);
  assert.equal(thoughtEvents.at(-1).payload.phase, "completed");
  assert.equal(thoughtEvents.at(-1).payload.text, "Inspect parser entrypoints first.");
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0].payload.type, "turn_completed");
  assert.equal(agentEvents[0].payload.turn, 1);
  assert.deepEqual(agentEvents[0].payload.usage, ZERO_USAGE);
});

test("Pi Agent executor injects live steering into the next model turn", async () => {
  const contexts = [];
  let steeringPoll = 0;
  const result = await runResearchAgent({
    prompt: "Inspect the parser boundary.",
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels(
        [
          assistant("## Result\nInitial parser orientation."),
          assistant("## Result\nApplied the authorization-boundary steering."),
        ],
        contexts,
      ),
      async getSteeringMessages() {
        steeringPoll += 1;
        return steeringPoll === 2
          ? [
              {
                role: "user",
                content: "User steering: inspect the authorization boundary next.",
                timestamp: Date.now(),
              },
            ]
          : [];
      },
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.equal(contexts.length, 2);
  assert.ok(
    contexts[1].messageContents.some((content) =>
      content.includes("inspect the authorization boundary next"),
    ),
  );
});

test("Pi Agent executor supports parallel same-turn tool execution", async () => {
  const calls = [];
  const tool = createFixtureInspectTool(calls);
  const result = await runResearchAgent({
    prompt: "Inspect two fixture paths.",
    tools: [tool.descriptor],
    governance: {
      allowedActionClasses: ["inspect"],
      allowedSideEffects: ["read"],
      allowedPermissions: ["filesystem:read"],
      maxToolCalls: 2,
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistant(
          [
            toolCall("fixture_inspect", { path: "parse.c" }, "tool_a"),
            toolCall("fixture_inspect", { path: "context.c" }, "tool_b"),
          ],
          "toolUse",
        ),
        assistant("## Result\nBoth fixture paths were inspected."),
      ]),
      toolRegistry: createResearchToolRegistry([tool]),
      toolExecution: "parallel",
    }),
  });
  const observedEvents = result.agentRun.output.toolEvents.filter(
    (event) => event.kind === "tool.observed",
  );

  assert.equal(result.agentRun.output.raw.toolExecutionMode, "parallel");
  assert.equal(result.agentRun.output.raw.toolCallCount, 2);
  assert.deepEqual(calls.map((call) => call.path).sort(), ["context.c", "parse.c"]);
  assert.equal(observedEvents.length, 2);
});

function createFixtureInspectTool(calls) {
  const parameters = {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
      },
    },
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
      memoryWritebackDefaults: ["event", "working", "episodic"],
    },
    parameters,
    async execute(action) {
      const timestamp = new Date().toISOString();
      calls.push(action.input);
      return {
        action,
        status: "complete",
        startedAt: timestamp,
        completedAt: timestamp,
        summary: `Fixture inspected ${action.input.path}.`,
        output: {
          path: action.input.path,
        },
        evidence: [`Fixture inspected ${action.input.path}.`],
        claims: [],
        artifactRefs: [],
        followUpActions: [],
      };
    },
  };
}

function createThoughtStreamingModels() {
  return {
    getModel() {
      return FAUX_MODEL;
    },
    streamSimple() {
      const started = assistant([], "stop");
      const thinking = {
        ...started,
        content: [
          {
            type: "thinking",
            thinking: "Inspect parser entrypoints first.",
          },
        ],
        responseId: "thought-response",
      };
      const finalMessage = {
        ...thinking,
        content: [
          ...thinking.content,
          {
            type: "text",
            text: "## Result\nPrepared parser inspection plan.",
          },
        ],
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: started };
          yield {
            type: "thinking_start",
            contentIndex: 0,
            partial: {
              ...thinking,
              content: [{ type: "thinking", thinking: "" }],
            },
          };
          yield {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Inspect parser entrypoints first.",
            partial: thinking,
          };
          yield {
            type: "thinking_end",
            contentIndex: 0,
            content: "Inspect parser entrypoints first.",
            partial: thinking,
          };
          yield {
            type: "text_end",
            contentIndex: 1,
            content: "## Result\nPrepared parser inspection plan.",
            partial: finalMessage,
          };
          yield { type: "done", reason: "stop", message: finalMessage };
        },
        async result() {
          return finalMessage;
        },
      };
    },
  };
}

function createScriptedModels(messages, contexts = []) {
  let index = 0;
  return {
    getModel() {
      return FAUX_MODEL;
    },
    streamSimple(_model, context) {
      contexts.push({
        toolNames: context.tools?.map((tool) => tool.name) ?? [],
        messageRoles: context.messages.map((message) => message.role),
        messageContents: context.messages.map((message) => JSON.stringify(message.content)),
      });
      const message = messages[index] ?? assistant("## Result\nNo scripted response.");
      index += 1;
      return streamFrom(message);
    },
  };
}

function streamFrom(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: message.stopReason === "error" ? "error" : "done",
        ...(message.stopReason === "error" ? { error: message } : { message }),
      };
    },
    async result() {
      return message;
    },
  };
}

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant",
    content:
      typeof content === "string"
        ? [
            {
              type: "text",
              text: content,
            },
          ]
        : Array.isArray(content)
          ? content
          : [content],
    api: "faux",
    provider: "faux",
    model: "faux-model",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCall(name, args, id) {
  return {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
}
