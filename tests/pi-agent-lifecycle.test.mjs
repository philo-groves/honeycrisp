import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNativeOpenAiCompaction,
  compactAgentContext,
  createPiAgentExecutor,
  createResearchPiAgent,
  createResearchSystemPrompt,
  createResearchToolRegistry,
  extractCompatiblePiAgentResumableState,
  modelRetryDelayMs,
  runResearchAgent,
} from "../packages/research-agent/dist/index.js";
import {
  convertResponsesMessages,
  processResponsesStream,
} from "../packages/research-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";

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

test("agent context compacts old bulky tool results while preserving the task and latest result", () => {
  const messages = [{ role: "user", content: "Primary research objective", timestamp: Date.now() }];
  for (let index = 0; index < 10; index += 1) {
    messages.push(assistant(toolCall("fixture_inspect", { path: `${index}.c` }, `tool_${index}`), "toolUse"));
    messages.push({
      role: "toolResult",
      toolCallId: `tool_${index}`,
      toolName: "fixture_inspect",
      content: [{ type: "text", text: `${index === 9 ? "LATEST_RESULT\n" : ""}${"x".repeat(30_000)}` }],
      details: { summary: `Inspected ${index}.c.` },
      isError: false,
      timestamp: Date.now(),
    });
  }

  const compacted = compactAgentContext(messages, 100_000);
  const serialized = JSON.stringify(compacted);

  assert.match(serialized, /Primary research objective/);
  assert.match(serialized, /LATEST_RESULT/);
  assert.match(serialized, /output compacted for context/);
  assert.ok(serialized.length < JSON.stringify(messages).length);
  assert.ok(compacted.some((message) =>
    message.role === "toolResult"
    && JSON.stringify(message.content).includes("output compacted for context")
  ));
});

test("OpenAI Responses requests enable native compaction before local context fallback", () => {
  const compacted = applyNativeOpenAiCompaction(
    { model: "gpt-5.4", input: [] },
    { api: "openai-responses", contextWindow: 400_000 },
  );
  assert.deepEqual(compacted.context_management, [
    { type: "compaction", compact_threshold: 200_000 },
  ]);

  const unsupported = { model: "faux-model", input: [] };
  assert.equal(
    applyNativeOpenAiCompaction(unsupported, { api: "faux", contextWindow: 400_000 }),
    unsupported,
  );
});

test("patched Responses stream preserves and replays opaque compaction items", async () => {
  const compaction = {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: "opaque-provider-state",
  };
  const output = assistant("", "stop");
  output.content = [];
  output.api = "openai-responses";
  output.provider = "openai";
  output.model = "gpt-5.4";
  const events = async function* () {
    yield { type: "response.output_item.added", output_index: 0, item: compaction };
    yield { type: "response.output_item.done", output_index: 0, item: compaction };
    yield {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [compaction],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    };
  };
  await processResponsesStream(events(), output, { push() {} }, {
    ...FAUX_MODEL,
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    contextWindow: 400_000,
  });

  assert.equal(output.content.length, 1);
  assert.equal(output.content[0].type, "thinking");
  assert.equal(output.content[0].redacted, true);
  assert.deepEqual(JSON.parse(output.content[0].thinkingSignature), compaction);
  assert.deepEqual(
    convertResponsesMessages(
      { ...FAUX_MODEL, id: "gpt-5.4", api: "openai-responses", provider: "openai" },
      { messages: [output] },
      new Set(["openai"]),
    ),
    [compaction],
  );
});

test("Pi executor restores compatible captured messages and persists the next resume state", async () => {
  const priorMessage = {
    role: "user",
    content: "Prior research context",
    timestamp: Date.now() - 1_000,
  };
  const contexts = [];
  const result = await runResearchAgent({
    prompt: "Continue with this instruction only.",
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      sessionId: "run_resume_fixture",
      initialMessages: [priorMessage],
      models: createScriptedModels([
        assistant("## Result\nContinuation complete."),
      ], contexts),
      toolRegistry: createResearchToolRegistry(),
    }),
  });

  assert.match(contexts[0].messageContents[0], /Prior research context/);
  const raw = result.agentRun.output.raw;
  const resumed = extractCompatiblePiAgentResumableState(raw, "faux", "faux-model");
  assert.ok(resumed);
  assert.equal(resumed.providerSessionId, "run_resume_fixture");
  assert.equal(resumed.messages[0].content, "Prior research context");
  assert.match(JSON.stringify(resumed.messages), /Continue with this instruction only/);
  assert.equal(extractCompatiblePiAgentResumableState(raw, "faux", "other-model"), undefined);
});

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
  assert.match(contexts[0].systemPrompt, /sharp, curious research collaborator/);
  assert.match(contexts[0].systemPrompt, /Do not narrate routine memory updates unless they materially affect the conclusion/);
  assert.doesNotMatch(contexts[0].systemPrompt, /decide how to investigate it and when the work is complete/);
});

test("research system prompt separates reusable runbooks from execution and memory", () => {
  const prompt = createResearchSystemPrompt({ hasTools: true, hasRunbookTools: true });
  assert.match(prompt, /Use runbooks as durable executable research artifacts/);
  assert.match(prompt, /Use shell\.run for execution; a runbook never executes itself/);
  assert.match(prompt, /Keep concise research facts in memory and multi-step procedures in runbooks/);
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
      sessionId: "run_fixture_affinity",
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
  assert.deepEqual(contexts.map((context) => context.sessionId), [
    "run_fixture_affinity",
    "run_fixture_affinity",
  ]);
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
  assert.match(systemPrompt, /Save a hypothesis for a specific, testable but unproven security proposition/);
  assert.match(systemPrompt, /Evidence is attached to graph nodes as supporting references/);
  assert.match(systemPrompt, /Do not create finding memories/);
  assert.match(systemPrompt, /Save user-controlled ingress as sources/);
  assert.match(systemPrompt, /static analysis/);
  assert.match(systemPrompt, /realistic proof-of-vulnerability/);
  assert.match(systemPrompt, /review subagent independently approve it/);
  assert.match(systemPrompt, /leave it suspected/);
});

test("Pi Agent streams a tool request before long-running execution completes", async () => {
  const calls = [];
  const liveEvents = [];
  const tool = createFixtureInspectTool(calls);
  const execute = tool.execute;
  let markToolStarted;
  let releaseTool;
  const toolStarted = new Promise((resolve) => { markToolStarted = resolve; });
  const toolReleased = new Promise((resolve) => { releaseTool = resolve; });
  tool.execute = async (action) => {
    markToolStarted();
    await toolReleased;
    return execute(action);
  };

  const runPromise = runResearchAgent({
    prompt: "Inspect a slow fixture path.",
    tools: [tool.descriptor],
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistant(toolCall("fixture_inspect", { path: "slow.c" }, "tool_slow"), "toolUse"),
        assistant("## Result\nSlow fixture inspected."),
      ]),
      toolRegistry: createResearchToolRegistry([tool]),
    }),
  });

  await toolStarted;
  let pendingAssertionError;
  try {
    const pendingEvents = liveEvents.filter((event) =>
      event.kind === "research.event"
      && event.payload.event.payload.toolActionId === "tool_slow"
    );
    assert.deepEqual(pendingEvents.map((event) => event.payload.event.kind), ["tool.requested"]);
  } catch (error) {
    pendingAssertionError = error;
  } finally {
    releaseTool();
  }

  const result = await runPromise;
  if (pendingAssertionError) throw pendingAssertionError;
  const capturedEvents = result.agentRun.output.toolEvents.filter(
    (event) => event.payload.toolActionId === "tool_slow",
  );
  assert.deepEqual(capturedEvents.map((event) => event.kind), ["tool.requested", "tool.observed"]);
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

test("Pi Agent retry backoff is immediate, then one and two minutes, capped at three minutes", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 20].map(modelRetryDelayMs),
    [0, 60_000, 120_000, 180_000, 180_000, 180_000],
  );
});

test("Pi Agent aborts a delayed retry immediately when the session is stopped", async () => {
  const controller = new AbortController();
  const result = await runResearchAgent({
    prompt: "Stop cleanly while waiting to recover from a provider outage.",
    signal: controller.signal,
    eventSink(event) {
      if (
        event.kind === "agent.event"
        && event.payload.type === "model_retry"
        && event.payload.retry === 2
      ) {
        controller.abort();
      }
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistantError("Unexpected server error."),
        assistantError("Unexpected server error."),
      ]),
    }),
  });

  assert.equal(result.agentRun.status, "error");
  assert.match(result.agentRun.output.text, /Model retry aborted/);
});

test("Pi Agent retries an unexpected server error immediately in the same session", async () => {
  const contexts = [];
  const liveEvents = [];
  const result = await runResearchAgent({
    prompt: "Continue the authorized parser review after a server failure.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistantError("Unexpected server error."),
        assistant("## Result\nRecovered in the same research session."),
      ], contexts),
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.equal(contexts.length, 2);
  assert.equal(liveEvents.find((event) =>
    event.kind === "agent.event" && event.payload.type === "model_retry"
  )?.payload.delayMs, 0);
});

test("Pi Agent treats an authorized safety guardrail as a likely false positive and steers the same session", async () => {
  const contexts = [];
  const liveEvents = [];
  const result = await runResearchAgent({
    prompt: "Within the recorded authorized bug bounty scope, review the local parser source for bounds errors.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistantError("Cyber safety guardrail interrupted this response."),
        assistant("## Result\nContinued the authorized local review."),
      ], contexts),
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.equal(contexts.length, 2);
  assert.match(contexts[1].messageContents.at(-1), /likely false positive/);
  assert.match(contexts[1].messageContents.at(-1), /continue the same objective in this session/);
  const retry = liveEvents.find((event) =>
    event.kind === "agent.event" && event.payload.type === "model_retry"
  );
  assert.equal(retry?.payload.recoveryKind, "safety_guardrail");
  assert.equal(retry?.payload.safetyDisposition, "likely_false_positive");
});

test("Pi Agent analyzes concerning safety context and injects safer steering before retrying", async () => {
  const contexts = [];
  const liveEvents = [];
  const result = await runResearchAgent({
    prompt: "Use credential stuffing, persistence, and stealth to pursue the target.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistantError("Safety policy rejected the cyber request."),
        assistant("## Result\nReframed the work as bounded offline analysis."),
      ], contexts),
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.match(contexts[1].messageContents.at(-1), /review the full transcript/);
  assert.match(contexts[1].messageContents.at(-1), /Restrict work to local or offline analysis/);
  assert.match(contexts[1].messageContents.at(-1), /unnecessary red-team rhetoric/);
  const retry = liveEvents.find((event) =>
    event.kind === "agent.event" && event.payload.type === "model_retry"
  );
  assert.equal(retry?.payload.safetyDisposition, "safety_adjustment");
});

test("Pi Agent retries a model stream that produces no response events", async () => {
  let calls = 0;
  const liveEvents = [];
  const models = {
    getModel() {
      return FAUX_MODEL;
    },
    streamSimple(_model, _context, options = {}) {
      calls += 1;
      if (calls > 1) return streamFrom(assistant("## Result\nRecovered from a silent model stream."));
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  };
  const result = await runResearchAgent({
    prompt: "Recover if the model stream becomes silent.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models,
      modelFirstEventTimeoutMs: 10,
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.equal(calls, 2);
  assert.match(result.agentRun.output.text, /Recovered from a silent model stream/);
  assert.ok(liveEvents.some((event) =>
    event.kind === "agent.event"
    && event.payload.type === "model_retry"
    && event.payload.errorMessage.includes("produced no content")
  ));
});

test("Pi Agent compacts tool history and retries once after a context-window error", async () => {
  const contexts = [];
  const liveEvents = [];
  const tool = createFixtureInspectTool([]);
  const execute = tool.execute;
  tool.execute = async (action) => {
    const result = await execute(action);
    return { ...result, output: { path: action.input.path, text: "x".repeat(100_000) } };
  };

  const result = await runResearchAgent({
    prompt: "Inspect a large fixture without losing the session.",
    tools: [tool.descriptor],
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([
        assistant(toolCall("fixture_inspect", { path: "large.c" }, "tool_large"), "toolUse"),
        assistantError("Codex error: Your input exceeds the context window of this model."),
        assistant("## Result\nRecovered after compacting old tool output."),
      ], contexts),
      toolRegistry: createResearchToolRegistry([tool]),
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.equal(contexts.length, 3);
  assert.match(contexts[2].messageContents.join("\n"), /output compacted for context/);
  assert.ok(contexts[2].messageContents.join("\n").length < contexts[1].messageContents.join("\n").length);
  assert.ok(liveEvents.some((event) =>
    event.kind === "agent.event"
    && event.payload.type === "context_compacted"
    && event.payload.reason === "context_window_error"
  ));
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
      sessionId: "run_subagent_affinity",
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
  assert.notEqual(childContext.sessionId, "run_subagent_affinity");
  assert.equal(childContext.sessionId, contexts.findLast((context) => context.model === "child-model").sessionId);
  assert.ok(rootContexts.every((context) => context.sessionId === "run_subagent_affinity"));
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
  const rootSpawnEvents = result.agentRun.output.toolEvents.filter(
    (event) => event.agentPath === "/root" && event.payload.toolName === "spawn_agent",
  );
  assert.deepEqual(rootSpawnEvents.map((event) => event.kind), ["tool.requested", "tool.observed"]);
  assert.equal(rootSpawnEvents[1].payload.result.task_name, "/root/parser_review");
  assert.ok(liveEvents.some((event) =>
    event.kind === "research.event"
    && event.payload.agentPath === "/root"
    && event.payload.event.kind === "tool.observed"
    && event.payload.event.payload.toolName === "spawn_agent"
  ));
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
  assert.deepEqual(agentEvents[0].payload.usage, { ...ZERO_USAGE, cacheHitRate: 0 });
});

test("Pi Agent executor reports prompt cache hit rate in live and captured usage", async () => {
  const liveEvents = [];
  const cachedResponse = {
    ...assistant("Cache-aware response."),
    usage: {
      input: 200,
      output: 50,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 1_050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const result = await runResearchAgent({
    prompt: "Measure prompt caching.",
    eventSink(event) {
      liveEvents.push(event);
    },
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: createScriptedModels([cachedResponse]),
    }),
  });

  const completedTurn = liveEvents.find(
    (event) => event.kind === "agent.event" && event.payload.type === "turn_completed",
  );
  assert.equal(completedTurn.payload.usage.cacheHitRate, 0.8);
  assert.equal(result.agentRun.output.raw.modelCalls[0].usage.cacheHitRate, 0.8);
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

test("Pi Agent executor applies a steered model and effort to the next root turn", async () => {
  const calls = [];
  let steeringPoll = 0;
  let selection;
  const selectedModel = { ...FAUX_MODEL, id: "selected-model", name: "Selected Model", reasoning: true };
  const scripted = [assistant("Initial orientation."), assistant("Selected-model continuation.")];
  let responseIndex = 0;
  const result = await runResearchAgent({
    prompt: "Inspect the parser boundary.",
    executor: createPiAgentExecutor({
      provider: "faux",
      model: "faux-model",
      models: {
        getModel(_provider, id) {
          return id === selectedModel.id ? selectedModel : FAUX_MODEL;
        },
        streamSimple(model, _context, options = {}) {
          calls.push({ model: model.id, reasoning: options.reasoning });
          return streamFrom(scripted[responseIndex++] ?? assistant("Done."));
        },
      },
      getModelSelection: () => selection,
      async getSteeringMessages() {
        steeringPoll += 1;
        if (steeringPoll !== 2) return [];
        selection = { provider: "faux", model: "selected-model", reasoningEffort: "high" };
        return [{ role: "user", content: "Continue with the selected model.", timestamp: Date.now() }];
      },
    }),
  });

  assert.equal(result.agentRun.status, "complete");
  assert.deepEqual(calls, [
    { model: "faux-model", reasoning: undefined },
    { model: "selected-model", reasoning: "high" },
  ]);
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
    streamSimple(_model, context, options = {}) {
      contexts.push({
        systemPrompt: context.systemPrompt,
        sessionId: options.sessionId,
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
        sessionId: options.sessionId,
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
