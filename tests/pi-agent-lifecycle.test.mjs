import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiAgentExecutor,
  createResearchPiAgent,
  createResearchSystemPrompt,
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
const COLLABORATION_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "wait_agent",
];

test("direct Pi Agent and executor use the shared research system prompt", async () => {
  const directAgent = createResearchPiAgent({
    model: FAUX_MODEL,
    models: {
      streamSimple() {
        throw new Error("streamSimple should not run while inspecting initial state");
      },
    },
  });

  assert.equal(
    directAgent.state.systemPrompt,
    createResearchSystemPrompt({ hasTools: false }),
  );

  const contexts = [];
  await runResearchAgent({
    prompt: "Orient to the target.",
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistant("## Result\nTarget orientation complete."),
      ], contexts),
      toolRegistry: createResearchToolRegistry(),
    }),
  });

  assert.equal(
    contexts[0].systemPrompt,
    createResearchSystemPrompt({
      hasTools: true,
      hasMemoryTools: false,
      hasCollaborationTools: true,
    }),
  );
  assert.match(contexts[0].systemPrompt, /expert cyber research assistant/);
  assert.doesNotMatch(contexts[0].systemPrompt, /decide how to investigate it and when the work is complete/);
});

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
    workspaceContext: {
      schemaVersion: 1,
      workspaceRoot: "/private/workspaces/fixture",
      memoryTierContext: {
        sessionId: "run_fixture",
        workspaceId: "workspace_fixture",
        workspaceName: "Fixture",
        subjectId: "subject_fixture",
        subjectName: "Fixture Owner",
        peers: [{
          databasePath: "/private/peer/memory.sqlite",
          workspaceId: "workspace_peer",
          workspaceName: "Peer Fixture",
          subjectId: "subject_fixture",
          subjectName: "Fixture Owner",
        }],
      },
      knownRepositories: [],
      materializedSourcePaths: [],
      projectNotes: [],
    },
    memoryContext: [{
      id: "mem_fixture_parser",
      tier: "workspace",
      scope: {
        sessionId: "run_fixture",
        workspace: { id: "workspace_fixture", name: "Fixture" },
      },
      type: "hypothesis",
      title: "Parser boundary",
      summary: "parse.c contains the current boundary candidate.",
      status: "suspected",
      confidence: 0.7,
      assetIds: ["parse.c"],
      tags: ["parser"],
      evidence: [{
        id: "evidence_fixture_parser",
        kind: "code",
        pathBase: "repository",
        path: "parse.c",
        locator: { line: 12 },
        summary: "Candidate boundary.",
        createdAt: "2026-07-20T12:00:00.000Z",
      }],
      relationships: [],
      updatedAt: "2026-07-20T12:00:00.000Z",
      revision: 1,
    }],
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
  assert.deepEqual(result.collaborationTools.map((tool) => tool.name), COLLABORATION_TOOL_NAMES);
  assert.equal(calls.length, 1);
  assert.equal(observed.payload.toolName, "fixture.inspect");
  assert.equal(observed.payload.status, "complete");
  assert.equal("evidenceExtracted" in observed.payload, false);
  assert.equal("claimsProposed" in observed.payload, false);
  assert.ok(raw.agentEvents.some((event) => event.type === "tool_execution_update"));
  assert.deepEqual(contexts[0].toolNames, ["fixture_inspect", ...COLLABORATION_TOOL_NAMES]);
  assert.deepEqual(contexts[1].toolNames, COLLABORATION_TOOL_NAMES);
  assert.doesNotMatch(contexts[0].systemPrompt, /Use durable memory as a concise research graph/);
  assert.match(contexts[0].systemPrompt, /Never use the \$HOME environment variable/);
  const initialMessage = contexts[0].messageContents.join("\n");
  assert.match(initialMessage, /### memory/);
  assert.match(initialMessage, /mem_fixture_parser/);
  assert.match(initialMessage, /evidence_fixture_parser/);
  assert.doesNotMatch(initialMessage, /### storage|### tool_policy|memory\.sqlite/);
});

test("Pi Agent adds research guidance when durable memory tools are available", async () => {
  const contexts = [];
  const memoryTool = createFixtureInspectTool([]);
  memoryTool.descriptor = {
    ...memoryTool.descriptor,
    name: "memory.save",
    transportName: "memory_save",
  };
  const searchTool = createFixtureInspectTool([]);
  searchTool.descriptor = {
    ...searchTool.descriptor,
    name: "memory.search",
    transportName: "memory_search",
  };
  const linkTool = createFixtureInspectTool([]);
  linkTool.descriptor = {
    ...linkTool.descriptor,
    name: "memory.link",
    transportName: "memory_link",
  };

  await runResearchAgent({
    prompt: "Orient to the target.",
    tools: [memoryTool.descriptor, searchTool.descriptor, linkTool.descriptor],
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistant("## Result\nTarget orientation complete."),
      ], contexts),
      toolRegistry: createResearchToolRegistry([memoryTool, searchTool, linkTool]),
    }),
  });

  const systemPrompt = contexts[0].systemPrompt;
  assert.match(systemPrompt, /Never use the \$HOME environment variable/);
  assert.match(systemPrompt, /Use durable memory as a concise research graph/);
  assert.match(systemPrompt, /Save user-controlled ingress as sources/);
  assert.match(systemPrompt, /static analysis/);
  assert.match(systemPrompt, /realistic proof-of-vulnerability/);
  assert.match(systemPrompt, /review subagent independently approve it/);
  assert.match(systemPrompt, /leave it suspected/);
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

test("Pi Agent retries a transient provider failure before emitting a terminal error", async () => {
  const contexts = [];
  const liveEvents = [];
  const result = await runResearchAgent({
    prompt: "Continue after a transient provider failure.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistantError("Codex error: An error occurred while processing your request. You can retry your request."),
        assistant("## Result\nRecovered without losing the active turn."),
      ], contexts),
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.match(result.agentRun.output.text, /Recovered without losing/);
  assert.equal(contexts.length, 2);
  assert.ok(result.agentRun.output.raw.agentEvents.some((event) => event.type === "model_retry" && event.retry === 1));
  assert.ok(liveEvents.some((event) => event.kind === "agent.event" && event.payload.type === "model_retry"));
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
  assert.deepEqual(contexts[1].toolNames, COLLABORATION_TOOL_NAMES);
});

test("Pi Agent coordinates a partial-context subagent with a model and effort override", async () => {
  const contexts = [];
  const liveEvents = [];
  const calls = [];
  const tool = createFixtureInspectTool(calls);
  const result = await runResearchAgent({
    prompt: "Delegate a bounded parser review, then incorporate the result.",
    tools: [tool.descriptor],
    governance: {
      allowedActionClasses: ["inspect"],
      allowedSideEffects: ["read"],
      allowedPermissions: ["filesystem:read"],
      maxToolCalls: 2,
    },
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      reasoning: "high",
      models: createSubagentModels(contexts),
      toolRegistry: createResearchToolRegistry([tool]),
    }),
  });

  const child = result.agentRun.output.raw.subagents.agents[0];
  const childContext = contexts.find((context) => context.model === "child-model");
  const rootContexts = contexts.filter((context) => context.model === "faux-model");
  const activity = liveEvents
    .filter((event) => event.kind === "agent.event" && event.payload.type === "subagent.activity")
    .map((event) => event.payload.action);

  assert.match(result.agentRun.output.text, /incorporated child result/i);
  assert.equal(child.path, "/root/parser_review");
  assert.equal(child.status, "completed");
  assert.equal(child.model, "child-model");
  assert.equal(child.reasoningEffort, "low");
  assert.equal(child.forkTurns, "1");
  assert.equal(child.output, "CHILD_RESULT: parser boundary inspected.");
  assert.equal(child.toolCallCount, 1);
  assert.deepEqual(calls, [{ path: "parse.c" }]);
  assert.ok(childContext);
  assert.equal(childContext.reasoning, "low");
  assert.ok(childContext.messageContents.some((content) => content.includes("Delegate a bounded parser review")));
  assert.ok(childContext.messageContents.some((content) => content.includes("Inspect the parser boundary independently")));
  assert.ok(rootContexts.at(-1).messageContents.some((content) => content.includes("CHILD_RESULT")));
  assert.deepEqual(activity, ["spawned", "completed"]);
  assert.ok(liveEvents.some((event) => event.payload.agentPath === "/root/parser_review"));
  assert.ok(liveEvents.some((event) =>
    event.kind === "research.event" &&
    event.payload.agentPath === "/root/parser_review" &&
    event.payload.event.kind === "tool.observed"
  ));
  const liveToolEvents = liveEvents.filter((event) => event.kind === "research.event" && event.payload.event.kind.startsWith("tool."));
  assert.equal(new Set(liveToolEvents.map((event) => event.payload.event.id)).size, liveToolEvents.length);
  const capturedChildTool = result.agentRun.output.toolEvents.find((event) => event.agentPath === "/root/parser_review");
  assert.equal(capturedChildTool.agentId, child.id);
  assert.equal(capturedChildTool.parentAgentId, "root");
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
        systemPrompt: context.systemPrompt,
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

function createSubagentModels(contexts) {
  return {
    getModel(_provider, id) {
      return { ...FAUX_MODEL, id, name: id };
    },
    streamSimple(model, context, options = {}) {
      const captured = {
        model: model.id,
        reasoning: options.reasoning,
        toolNames: context.tools?.map((tool) => tool.name) ?? [],
        messageContents: context.messages.map((message) => JSON.stringify(message.content)),
      };
      contexts.push(captured);
      if (model.id === "child-model") {
        const joined = captured.messageContents.join("\n");
        if (!joined.includes('"name":"fixture_inspect"')) {
          return streamFrom({
            ...assistant(toolCall("fixture_inspect", { path: "parse.c" }, "child_tool_1"), "toolUse"),
            model: model.id,
          });
        }
        return streamFrom({
          ...assistant("CHILD_RESULT: parser boundary inspected."),
          model: model.id,
        });
      }
      const joined = captured.messageContents.join("\n");
      if (!joined.includes('"name":"spawn_agent"')) {
        return streamFrom({
          ...assistant(toolCall("spawn_agent", {
            task_name: "parser_review",
            message: "Inspect the parser boundary independently.",
            fork_turns: "1",
            model: "child-model",
            reasoning_effort: "low",
          }, "spawn_1"), "toolUse"),
          model: model.id,
        });
      }
      if (!joined.includes("CHILD_RESULT")) {
        return streamFrom({
          ...assistant(toolCall("wait_agent", { timeout_ms: 1000 }, "wait_1"), "toolUse"),
          model: model.id,
        });
      }
      return streamFrom({
        ...assistant("## Result\nIncorporated child result into the root analysis."),
        model: model.id,
      });
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

function assistantError(errorMessage) {
  return {
    ...assistant([], "error"),
    errorMessage,
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
