import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEMORY_TYPE_DESCRIPTIONS,
  MEMORY_CURATOR_AGENT_IDENTITY,
  MEMORY_CURATOR_TOOL_NAME,
  MemoryGraphStore,
  SerializedMemoryCurator,
  projectMemoryCuratorTurn,
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
  id: "small-model",
  name: "Small Model",
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
  maxTokens: 8_192,
};

const ROOT_SOURCE = {
  agentId: "root",
  agentPath: "/root",
  parentAgentId: "",
};

test("serialized memory curator is nonblocking FIFO and isolates failed jobs", async () => {
  const store = createStore("fifo");
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const callbacks = [];
  const researchEvents = [];
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model", reasoningEffort: "low" }),
    models: fixtureModels(async (_model, context, options) => {
      const index = calls.length;
      calls.push({ context, options });
      if (index === 0) {
        await firstGate;
        return assistantResponse("not json");
      }
      return assistantResponse(JSON.stringify({
        version: 1,
        operations: [{
          op: "save",
          type: "invariant",
          title: "Serialized curator survived",
          summary: "The second job runs after the failed first job.",
        }],
      }));
    }),
    onJobCompleted(result) {
      callbacks.push({ id: result.id, status: result.status });
      if (result.status === "error") throw new Error("observational callback failure");
    },
    onResearchEvent(event) {
      researchEvents.push(event);
    },
  });

  try {
    const first = curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Review the malformed first result.",
    });
    const second = curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Remember that the serialized curator survives failures.",
    });

    assert.equal(first.position, 1);
    assert.equal(second.position, 2);
    assert.equal(curator.pendingCount, 2);
    assert.equal(calls.length, 0, "enqueue must not synchronously call the provider");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    releaseFirst();

    const results = await curator.drain();
    assert.deepEqual(results.map((result) => result.status), ["error", "complete"]);
    assert.deepEqual(callbacks, [
      { id: first.id, status: "error" },
      { id: second.id, status: "complete" },
    ]);
    assert.equal(curator.pendingCount, 0);
    assert.equal(store.search({ query: "Serialized curator survived", scope: "subject" }).length, 1);
    assert.equal(calls[1].options.reasoning, "low");
    assert.equal(calls[1].options.maxTokens, 4_096);
    assert.equal(researchEvents.length, 4);
    assert.ok(researchEvents.every((event) =>
      event.agentId === MEMORY_CURATOR_AGENT_IDENTITY.agentId
      && event.agentPath === MEMORY_CURATOR_AGENT_IDENTITY.agentPath
      && event.parentAgentId === MEMORY_CURATOR_AGENT_IDENTITY.parentAgentId
    ));
    assert.equal(researchEvents[0].payload.toolName, MEMORY_CURATOR_TOOL_NAME);
    assert.equal(researchEvents[0].payload.normalizedInputs.agentId, "root");
  } finally {
    store.close();
  }
});

test("stopping a session cancels the active curator job and drops queued work without failure spam", async () => {
  const store = createStore("cancelled");
  const controller = new AbortController();
  let releaseModel;
  const modelGate = new Promise((resolve) => { releaseModel = resolve; });
  const calls = [];
  const callbacks = [];
  const researchEvents = [];
  const curator = new SerializedMemoryCurator({
    store,
    signal: controller.signal,
    getModelSelection: () => ({ provider: "faux", model: "small-model", reasoningEffort: "low" }),
    models: fixtureModels(async () => {
      calls.push("started");
      await modelGate;
      return assistantResponse(JSON.stringify({ version: 1, operations: [] }));
    }),
    onJobCompleted(result) {
      callbacks.push({ id: result.id, status: result.status });
    },
    onResearchEvent(event) {
      researchEvents.push(event);
    },
  });

  try {
    const first = curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Review the active item.",
    });
    curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Drop this queued item when the session stops.",
    });
    curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Drop this queued item too.",
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(curator.pendingCount, 3);

    controller.abort();
    const results = await curator.drain();

    assert.deepEqual(results.map((result) => result.status), ["cancelled"]);
    assert.deepEqual(callbacks, [{ id: first.id, status: "cancelled" }]);
    assert.equal(calls.length, 1, "queued jobs must not call the provider after stop");
    assert.equal(curator.pendingCount, 0);
    assert.deepEqual(researchEvents.map((event) => [event.kind, event.payload.status]), [
      ["tool.requested", undefined],
      ["tool.observed", "blocked"],
    ]);
    assert.equal(researchEvents[1].payload.error, undefined);
    assert.match(researchEvents[1].payload.summary, /stopped with the research session/i);
  } finally {
    releaseModel();
    store.close();
  }
});

test("memory curator snapshots provider selection at enqueue and isolates selection lookup errors", async () => {
  const store = createStore("selection");
  let activeModel = "small-a";
  let failSelection = false;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const modelCalls = [];
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection() {
      if (failSelection) throw new Error("selection unavailable");
      return { provider: "faux", model: activeModel };
    },
    models: {
      getModel(provider, model) {
        assert.equal(provider, "faux");
        return { ...FAUX_MODEL, id: model, name: model };
      },
      async completeSimple(model) {
        modelCalls.push(model.id);
        if (modelCalls.length === 1) await firstGate;
        return assistantResponse('{"version":1,"operations":[]}');
      },
    },
  });

  try {
    const first = curator.enqueueRequest({ ...ROOT_SOURCE, request: "First provider snapshot." });
    activeModel = "small-b";
    const second = curator.enqueueRequest({ ...ROOT_SOURCE, request: "Second provider snapshot." });
    failSelection = true;
    assert.doesNotThrow(() => curator.enqueueRequest({ ...ROOT_SOURCE, request: "Selection failure fixture." }));
    failSelection = false;
    activeModel = "small-c";
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Fourth provider snapshot." });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(modelCalls, ["small-a"]);
    releaseFirst();
    const results = await curator.drain();
    assert.deepEqual(results.map((result) => result.status), ["complete", "complete", "error", "complete"]);
    assert.deepEqual(modelCalls, ["small-a", "small-b", "small-c"]);
    assert.equal(results[0].id, first.id);
    assert.equal(results[1].id, second.id);
    assert.equal(results[0].selection.model, "small-a");
    assert.equal(results[1].selection.model, "small-b");
    assert.match(results[2].error.message, /selection failed: selection unavailable/);
  } finally {
    store.close();
  }
});

test("memory curator supplies semantic duplicate candidates and bounds turn data without thinking", async () => {
  const store = createStore("candidates");
  const existing = store.save({
    type: "primitive",
    title: "Parser length wrap",
    summary: "A parser length addition wraps before a bounds check.",
    status: "confirmed",
    evidence: [{
      kind: "code",
      pathBase: "repository",
      path: "src/parser.c",
      locator: { line: 41 },
      summary: "The addition precedes the bounds check.",
    }],
  });
  const prompts = [];
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async (_model, context) => {
      prompts.push(context.messages[0].content);
      return assistantResponse('{"version":1,"operations":[]}');
    }),
  });

  try {
    curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "A memory may be missing for the parser length wrap bounds check.",
    });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    assert.match(prompts[0], new RegExp(existing.id));
    assert.match(prompts[0], /Parser length wrap/);

    const projection = projectMemoryCuratorTurn({
      kind: "turn",
      ...ROOT_SOURCE,
      turn: 2,
      inputMessages: [{ role: "user", content: "Inspect parser.c", timestamp: Date.now() }],
      message: assistantMessage([
        { type: "thinking", thinking: `PRIVATE_${"x".repeat(10_000)}` },
        { type: "text", text: `VISIBLE_${"y".repeat(10_000)}` },
      ]),
      toolResults: [{
        role: "toolResult",
        toolCallId: "read_1",
        toolName: "file_read",
        content: [{ type: "text", text: "z".repeat(20_000) }],
        details: {},
        isError: false,
        timestamp: Date.now(),
      }],
    }, { maxCharacters: 1_000 });
    assert.equal(projection.truncated, true);
    assert.ok(projection.serialized.length <= 1_000);
    assert.doesNotMatch(projection.serialized, /PRIVATE_/);
  } finally {
    store.close();
  }
});

test("memory curator uses the authoritative taxonomy and consolidates title-different root-cause duplicates", async () => {
  const store = createStore("root-cause-dedup");
  const existing = store.save({
    type: "primitive",
    title: "Parser length wrap",
    summary: "An unsigned parser length wraps before bounds validation.",
    status: "confirmed",
    attributes: {
      rootCause: "Unsigned parser length addition wraps before bounds validation.",
      rootCauseKey: "parser-length-wrap-before-bounds-validation",
    },
    evidence: [{
      kind: "code",
      pathBase: "repository",
      path: "src/parser.c",
      locator: { line: 41 },
      summary: "The unchecked addition precedes the bounds check.",
    }],
  });
  const customDescriptions = {
    ...DEFAULT_MEMORY_TYPE_DESCRIPTIONS,
    primitive: "CUSTOM_PRIMITIVE_DESCRIPTION: one proven root-cause mechanism.",
  };
  const prompts = [];
  const curator = new SerializedMemoryCurator({
    store,
    memoryTypeDescriptions: customDescriptions,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async (_model, context) => {
      prompts.push(context.systemPrompt);
      return assistantResponse(JSON.stringify({
        version: 1,
        operations: [{
          op: "save",
          type: "primitive",
          title: "Allocation can use a wrapped request size",
          summary: "The attacker-controlled parser length wraps before allocation validation.",
          status: "confirmed",
          attributes: {
            rootCause: "Bounds validation follows an unsigned parser-length wrap.",
            rootCauseKey: "unsigned-parser-length-wrap",
          },
          evidence: [{
            kind: "artifact",
            pathBase: "workspace",
            path: ".honeycrisp/artifacts/wrap-proof.txt",
            locator: {},
            summary: "The proof observes the wrapped allocation size.",
          }],
        }],
      }));
    }),
  });

  try {
    curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Record the wrapped allocation primitive without duplicating its root cause.",
    });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0].kind, "updated");
    assert.equal(result.notifications[0].memory.id, existing.id);

    const primitives = store.search({ scope: "subject", types: ["primitive"], limit: 100 });
    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].id, existing.id);
    assert.equal(primitives[0].title, "Parser length wrap", "the existing canonical identity should survive consolidation");
    assert.match(primitives[0].summary, /attacker-controlled parser length/);
    assert.equal(
      primitives[0].attributes.rootCauseKey,
      "parser-length-wrap-before-bounds-validation",
      "semantic consolidation must retain the existing stable root-cause identity",
    );
    assert.equal(primitives[0].evidence.length, 2);
    assert.match(prompts[0], /CUSTOM_PRIMITIVE_DESCRIPTION/);
    assert.match(prompts[0], /Deduplicate by underlying root cause/);
    assert.match(prompts[0], /attributes\.rootCauseKey/);
    assert.match(prompts[0], /lowercase-hyphenated attributes\.rootCauseKey/);
    assert.match(prompts[0], /Never automatically merge memories across types/);
  } finally {
    store.close();
  }
});

test("memory curator normalizes equivalent root-cause key separators before validation", async () => {
  const store = createStore("root-cause-key-normalization");
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(JSON.stringify({
      version: 1,
      operations: [{
        op: "save",
        type: "primitive",
        title: "Validated fd is rebound through a path",
        status: "confirmed",
        attributes: {
          rootCause: "Validation holds a file descriptor while use resolves a mutable pathname.",
          rootCauseKey: "fd_validation_then_pathname_rebinding",
        },
        evidence: [{
          kind: "code",
          pathBase: "repository",
          path: "src/mount.c",
          locator: { line: 41 },
          summary: "Mount setup performs a fresh pathname lookup.",
        }],
      }],
    }))),
  });

  try {
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Record the proven fd-to-path rebinding primitive." });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    const [primitive] = store.search({ scope: "subject", types: ["primitive"], limit: 10 });
    assert.equal(primitive.attributes.rootCauseKey, "fd-validation-then-pathname-rebinding");
  } finally {
    store.close();
  }
});

test("confirmed chains require a primitive relationship but not source, sink, or asset relationships", async () => {
  const store = createStore("minimal-confirmed-chain");
  const primitive = store.save({
    type: "primitive",
    title: "Validated fd is rebound through a path",
    status: "confirmed",
    attributes: {
      rootCause: "Validation holds a file descriptor while use resolves a mutable pathname.",
      rootCauseKey: "fd-validation-then-pathname-rebinding",
    },
    evidence: [{
      kind: "code",
      pathBase: "repository",
      path: "src/mount.c",
      locator: { line: 41 },
      summary: "Mount setup performs a fresh pathname lookup.",
    }],
  });
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(JSON.stringify({
      version: 1,
      operations: [{
        op: "save",
        ref: "chain",
        type: "chain",
        title: "Path rebinding reaches rejected code execution",
        status: "confirmed",
        attributes: {
          rootCause: "Path rebinding substitutes the object before execution.",
          rootCauseKey: "path-rebinding-to-rejected-code-execution",
          impact: "Rejected code executes.",
          reachability: "A pathname race occurs during a normal launch.",
        },
        evidence: [{
          kind: "artifact",
          pathBase: "workspace",
          path: "proof.json",
          locator: {},
          summary: "The proof records replacement-code execution.",
        }],
      }, {
        op: "link",
        from: "@chain",
        to: primitive.id,
        relation: "uses",
        note: "The chain depends on the proven rebinding primitive.",
      }],
    }))),
  });

  try {
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Record the independently reviewed chain." });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    const [chain] = store.search({ scope: "subject", types: ["chain"], limit: 10 });
    assert.equal(chain.status, "confirmed");
    assert.deepEqual(store.listEdges(chain.id).map((edge) => edge.toId), [primitive.id]);
  } finally {
    store.close();
  }
});

test("memory curator coalesces same-plan root-cause saves and resolves every duplicate ref", async () => {
  const store = createStore("same-plan-root-cause-dedup");
  const source = store.save({ type: "source", title: "Attacker length field", status: "confirmed" });
  const sink = store.save({ type: "sink", title: "Allocation size", status: "confirmed" });
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(JSON.stringify({
      version: 1,
      operations: [
        {
          op: "save",
          ref: "canonical_wrap",
          type: "primitive",
          title: "Parser length wraps before bounds validation",
          summary: "An unsigned parser length addition wraps before bounds validation.",
          body: "The unchecked addition is performed before the allocation bound is validated.",
          status: "confirmed",
          assetIds: ["asset_parser"],
          tags: ["parser"],
          attributes: {
            rootCause: "Unsigned parser length addition wraps before bounds validation.",
            rootCauseKey: "parser-length-wrap-before-bounds-validation",
            firstDetail: true,
          },
          evidence: [{
            kind: "code",
            pathBase: "repository",
            path: "src/parser.c",
            locator: { line: 41 },
            summary: "The unchecked addition precedes the bounds check.",
          }],
        },
        {
          op: "save",
          ref: "paraphrased_wrap",
          type: "primitive",
          title: "Wrapped allocation request",
          summary: "Bounds validation follows an unsigned parser-length wrap.",
          status: "confirmed",
          assetIds: ["asset_allocator"],
          tags: ["allocation"],
          attributes: {
            rootCause: "Bounds validation follows an unsigned parser-length wrap.",
            rootCauseKey: "unsigned-parser-length-wrap",
            secondDetail: true,
          },
          evidence: [{
            kind: "artifact",
            pathBase: "workspace",
            path: ".honeycrisp/artifacts/wrap-proof.txt",
            locator: {},
            summary: "The proof observes the wrapped allocation request.",
          }],
        },
        {
          op: "save",
          ref: "exact_key_wrap",
          type: "primitive",
          title: "Unchecked length arithmetic",
          summary: "The parser accepts a wrapped length.",
          status: "confirmed",
          attributes: {
            rootCause: "Unchecked unsigned addition wraps the parser length before its bound check.",
            rootCauseKey: "parser-length-wrap-before-bounds-validation",
            thirdDetail: true,
          },
          evidence: [{
            kind: "command",
            pathBase: "workspace",
            locator: { command: "parser-proof" },
            summary: "The proof command reproduces the wrapped length.",
          }],
        },
        { op: "link", from: "@canonical_wrap", to: source.id, relation: "controlled_by" },
        { op: "link", from: "@paraphrased_wrap", to: sink.id, relation: "reaches" },
      ],
    }))),
  });

  try {
    curator.enqueueRequest({
      ...ROOT_SOURCE,
      request: "Record each observation of the parser length wrap without duplicating the mechanism.",
    });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    assert.deepEqual(result.notifications.map((notification) => notification.kind), [
      "created",
      "linked",
      "linked",
    ]);

    const primitives = store.search({ scope: "subject", types: ["primitive"], limit: 100 });
    assert.equal(primitives.length, 1);
    assert.equal(primitives[0].title, "Parser length wraps before bounds validation");
    assert.equal(
      primitives[0].attributes.rootCauseKey,
      "parser-length-wrap-before-bounds-validation",
    );
    assert.equal(primitives[0].attributes.firstDetail, true);
    assert.equal(primitives[0].attributes.secondDetail, true);
    assert.equal(primitives[0].attributes.thirdDetail, true);
    assert.deepEqual(primitives[0].assetIds, ["asset_allocator", "asset_parser"]);
    assert.deepEqual(primitives[0].tags, ["allocation", "parser"]);
    assert.equal(primitives[0].evidence.length, 3);
    assert.deepEqual(
      store.listEdges(primitives[0].id).map((edge) => [edge.toId, edge.relation]).sort(),
      [[source.id, "controlled_by"], [sink.id, "reaches"]].sort(),
    );
  } finally {
    store.close();
  }
});

test("memory curator rejects a self-edge exposed only after same-plan save coalescing", async () => {
  const store = createStore("same-plan-alias-self-edge");
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(JSON.stringify({
      version: 1,
      operations: [
        {
          op: "save",
          ref: "first_wrap",
          type: "primitive",
          title: "Parser length wrap",
          status: "confirmed",
          attributes: {
            rootCause: "Unsigned parser length addition wraps before bounds validation.",
            rootCauseKey: "parser-length-wrap-before-bounds-validation",
          },
        },
        {
          op: "save",
          ref: "second_wrap",
          type: "primitive",
          title: "Wrapped allocation length",
          status: "confirmed",
          attributes: {
            rootCause: "Bounds validation follows an unsigned parser-length wrap.",
            rootCauseKey: "unsigned-parser-length-wrap",
          },
        },
        { op: "link", from: "@first_wrap", to: "@second_wrap", relation: "duplicates" },
      ],
    }))),
  });

  try {
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Reject duplicate aliases as a self-edge." });
    const [result] = await curator.drain();
    assert.equal(result.status, "error");
    assert.match(result.error.message, /cannot link a node to itself/i);
    assert.equal(store.search({ scope: "subject", types: ["primitive"], limit: 100 }).length, 0);
  } finally {
    store.close();
  }
});

test("semantic consolidation preserves richer canonical summary and body", async () => {
  const store = createStore("canonical-prose");
  const canonicalSummary = "An unsigned parser length addition wraps to a small allocation size before the independent upper-bound and remaining-buffer checks execute.";
  const canonicalBody = "The unchecked addition wraps before allocation validation, while the later remaining-buffer comparison evaluates the already-truncated result.";
  const existing = store.save({
    type: "primitive",
    title: "Canonical parser length wrap",
    summary: canonicalSummary,
    body: canonicalBody,
    status: "confirmed",
    assetIds: ["asset_parser"],
    tags: ["canonical"],
    attributes: {
      rootCause: "Unsigned parser length addition wraps before bounds validation.",
      rootCauseKey: "parser-length-wrap-before-bounds-validation",
      canonicalDetail: "retained",
    },
    evidence: [{
      kind: "code",
      pathBase: "repository",
      path: "src/parser.c",
      locator: { line: 41 },
      summary: "The unchecked addition precedes validation.",
    }],
  });
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(JSON.stringify({
      version: 1,
      operations: [{
        op: "save",
        type: "primitive",
        title: "Short wrapped-length observation",
        summary: "The unsigned length wraps.",
        body: "The unchecked addition wraps.",
        status: "confirmed",
        assetIds: ["asset_allocator"],
        tags: ["new-proof"],
        attributes: {
          rootCause: "Bounds validation follows an unsigned parser-length wrap.",
          rootCauseKey: "unsigned-parser-length-wrap",
          incomingDetail: "merged",
        },
        evidence: [{
          kind: "artifact",
          pathBase: "workspace",
          path: ".honeycrisp/artifacts/new-proof.txt",
          locator: {},
          summary: "The new proof confirms the same mechanism.",
        }],
      }],
    }))),
  });

  try {
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Add the new proof to the canonical wrap memory." });
    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    assert.equal(result.notifications[0].kind, "updated");
    assert.equal(result.notifications[0].memory.id, existing.id);
    const updated = store.get(existing.id);
    assert.equal(updated.title, "Canonical parser length wrap");
    assert.equal(updated.summary, canonicalSummary);
    assert.equal(updated.body, canonicalBody);
    assert.equal(updated.attributes.rootCauseKey, "parser-length-wrap-before-bounds-validation");
    assert.equal(updated.attributes.canonicalDetail, "retained");
    assert.equal(updated.attributes.incomingDetail, "merged");
    assert.deepEqual(updated.assetIds, ["asset_allocator", "asset_parser"]);
    assert.deepEqual(updated.tags, ["canonical", "new_proof"]);
    assert.equal(updated.evidence.length, 2);
  } finally {
    store.close();
  }
});

test("memory curator snapshots turn arrays without cloning ignored tool details", async () => {
  const store = createStore("shallow-snapshot");
  const prompts = [];
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async (_model, context) => {
      prompts.push(context.messages[0].content);
      return assistantResponse('{"version":1,"operations":[]}');
    }),
  });
  const assistantContent = [{ type: "text", text: "ORIGINAL_ASSISTANT_TEXT" }];
  const toolContent = [{ type: "text", text: "ORIGINAL_TOOL_TEXT" }];
  const toolResults = [{
    role: "toolResult",
    toolCallId: "read_snapshot",
    toolName: "file_read",
    content: toolContent,
    details: {
      ignoredMarker: "IGNORED_TOOL_DETAILS",
      nonCloneable: () => "structuredClone would reject this function",
    },
    isError: false,
    timestamp: Date.now(),
  }];

  try {
    assert.doesNotThrow(() => curator.enqueueTurn({
      ...ROOT_SOURCE,
      turn: 3,
      message: assistantMessage(assistantContent),
      toolResults,
    }));
    assistantContent.push({ type: "text", text: "LATE_ASSISTANT_MUTATION" });
    toolContent.push({ type: "text", text: "LATE_TOOL_MUTATION" });
    toolResults.length = 0;

    const [result] = await curator.drain();
    assert.equal(result.status, "complete");
    assert.match(prompts[0], /ORIGINAL_ASSISTANT_TEXT/);
    assert.match(prompts[0], /ORIGINAL_TOOL_TEXT/);
    assert.doesNotMatch(prompts[0], /IGNORED_TOOL_DETAILS/);
    assert.doesNotMatch(prompts[0], /LATE_ASSISTANT_MUTATION/);
    assert.doesNotMatch(prompts[0], /LATE_TOOL_MUTATION/);
  } finally {
    store.close();
  }
});

test("memory curator applies trusted node mutations and resolves relationship temp refs", async () => {
  const store = createStore("mutations");
  const source = store.save({ type: "source", title: "Untrusted request body", status: "confirmed" });
  const sink = store.save({ type: "sink", title: "Unchecked allocation", status: "confirmed" });
  const asset = store.save({ type: "asset", title: "Parser library", status: "confirmed" });
  let callIndex = 0;
  const curator = new SerializedMemoryCurator({
    store,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => {
      if (callIndex++ === 0) {
        return assistantResponse(JSON.stringify({
          version: 1,
          operations: [
            {
              op: "save",
              ref: "primitive",
              type: "primitive",
              title: "Length wrap primitive",
              summary: "An attacker-controlled length wraps before allocation.",
              status: "confirmed",
              attributes: {
                rootCause: "An attacker-controlled length addition wraps before allocation validation.",
                rootCauseKey: "parser-length-wrap-before-allocation-validation",
              },
              evidence: [{
                kind: "code",
                pathBase: "repository",
                path: "src/parser.c",
                locator: { line: 41 },
                summary: "The unchecked addition can wrap.",
              }],
            },
            {
              op: "save",
              ref: "chain",
              type: "chain",
              title: "Request length reaches allocation",
              summary: "The request length reaches an undersized allocation.",
              status: "confirmed",
              attributes: {
                impact: "Heap memory corruption.",
                reachability: "A remote request controls the parsed length.",
              },
              evidence: [{
                kind: "artifact",
                pathBase: "workspace",
                path: ".honeycrisp/artifacts/parser-proof.txt",
                locator: {},
                summary: "The bounded proof reaches the allocation with a wrapped size.",
              }],
            },
            { op: "link", from: "@chain", to: source.id, relation: "starts_at" },
            { op: "link", from: "@chain", to: "@primitive", relation: "uses" },
            { op: "link", from: "@chain", to: sink.id, relation: "reaches" },
            { op: "link", from: "@chain", to: asset.id, relation: "affects" },
          ],
        }));
      }
      const primitive = store.search({ query: "Length wrap primitive", scope: "subject" })[0];
      return assistantResponse(JSON.stringify({
        version: 1,
        operations: [{
          op: "correct",
          id: primitive.id,
          expectedRevision: primitive.revision,
          patch: { summary: "The confirmed wrap occurs before the allocation size is validated." },
        }],
      }));
    }),
  });

  try {
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Record the confirmed parser chain." });
    curator.enqueueRequest({ ...ROOT_SOURCE, request: "Refine the primitive summary." });
    const results = await curator.drain();
    assert.deepEqual(results.map((result) => result.status), ["complete", "complete"]);
    assert.deepEqual(
      results.flatMap((result) => result.notifications).map((notification) => notification.kind),
      ["created", "created", "linked", "linked", "linked", "linked", "updated"],
    );

    const primitive = store.search({ query: "Length wrap primitive", scope: "subject" })[0];
    const chain = store.search({ query: "Request length reaches allocation", scope: "subject" })[0];
    assert.equal(primitive.revision, 2);
    assert.match(primitive.summary, /before the allocation size/);
    assert.equal(chain.status, "confirmed");
    assert.deepEqual(
      store.listEdges(chain.id).map((edge) => edge.toId).sort(),
      [source.id, primitive.id, sink.id, asset.id].sort(),
    );
    const notifications = curator.takeNotifications();
    assert.equal(notifications.length, 7);
    assert.equal("body" in notifications[0].memory, false);
    assert.equal("evidence" in notifications[0].memory, false);
    const events = curator.takeResearchEvents();
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.agentId === "memory_curator"));
  } finally {
    store.close();
  }
});

test("memory curator rejects unsupported plans, stale revisions, missing endpoints, and incomplete confirmed chains", async () => {
  const store = createStore("validation");
  const hypothesis = store.save({ type: "hypothesis", title: "Candidate parser issue", status: "suspected" });
  const responses = [
    "```json\n{\"version\":1,\"operations\":[]}\n```",
    JSON.stringify({ version: 1, operations: [
      { op: "save", type: "asset", title: "One" },
      { op: "save", type: "asset", title: "Two" },
    ] }),
    JSON.stringify({ version: 1, operations: [{
      op: "correct",
      id: hypothesis.id,
      expectedRevision: hypothesis.revision + 1,
      patch: { summary: "Stale update" },
    }] }),
    JSON.stringify({ version: 1, operations: [{
      op: "link",
      from: hypothesis.id,
      to: "primitive_missing",
      relation: "supports",
    }] }),
    JSON.stringify({ version: 1, operations: [{
      op: "save",
      ref: "chain",
      type: "chain",
      title: "Incomplete confirmed chain",
      status: "confirmed",
      attributes: { impact: "Corruption", reachability: "Remote request" },
      evidence: [{ kind: "human_note", locator: {}, summary: "Claimed evidence" }],
    }] }),
    JSON.stringify({ version: 1, operations: [{
      op: "save",
      type: "chain",
      title: "Chain without attributes",
      status: "confirmed",
      evidence: [{ kind: "human_note", locator: {}, summary: "Claimed evidence" }],
    }] }),
    JSON.stringify({ version: 1, operations: [{
      op: "save",
      type: "chain",
      title: "Chain without evidence",
      status: "confirmed",
      attributes: { impact: "Corruption", reachability: "Remote request" },
    }] }),
    JSON.stringify({ version: 1, operations: [{
      op: "save",
      type: "primitive",
      title: "Primitive without root cause metadata",
      status: "confirmed",
      evidence: [{ kind: "code", pathBase: "repository", path: "src/parser.c", locator: { line: 41 }, summary: "A proven flaw." }],
    }] }),
    '{"version":1,"operations":[]}',
  ];
  let callIndex = 0;
  const curator = new SerializedMemoryCurator({
    store,
    maxOperations: 1,
    getModelSelection: () => ({ provider: "faux", model: "small-model" }),
    models: fixtureModels(async () => assistantResponse(responses[callIndex++])),
  });

  try {
    for (let index = 0; index < responses.length; index += 1) {
      curator.enqueueRequest({ ...ROOT_SOURCE, request: `Validation fixture ${index}` });
    }
    const results = await curator.drain();
    assert.deepEqual(results.map((result) => result.status), [
      "error", "error", "error", "error", "error", "error", "error", "error", "complete",
    ]);
    assert.match(results[0].error.message, /one JSON object/);
    assert.match(results[1].error.message, /operation limit/);
    assert.match(results[2].error.message, /revision conflict/);
    assert.match(results[3].error.message, /endpoint does not exist/);
    assert.match(results[4].error.message, /relationships to/);
    assert.match(results[5].error.message, /impact and reachability/);
    assert.match(results[6].error.message, /evidence reference/);
    assert.match(results[7].error.message, /attributes\.rootCause/);
    assert.equal(store.search({ query: "Incomplete confirmed chain", scope: "subject" }).length, 0);
    assert.equal(store.search({ query: "One", scope: "subject" }).length, 0);
    assert.equal(store.get(hypothesis.id).revision, 1);
  } finally {
    store.close();
  }
});

function createStore(name) {
  return new MemoryGraphStore({
    databasePath: ":memory:",
    workspaceRoot: `/private/tmp/honeycrisp-curator-${name}`,
    context: {
      sessionId: `session_${name}`,
      workspaceId: `workspace_${name}`,
      workspaceName: `Workspace ${name}`,
      subjectId: "subject_fixture",
      subjectName: "Fixture Subject",
    },
  });
}

function fixtureModels(completeSimple) {
  return {
    getModel(provider, model) {
      assert.equal(provider, "faux");
      assert.equal(model, "small-model");
      return FAUX_MODEL;
    },
    completeSimple,
  };
}

function assistantResponse(text) {
  return assistantMessage([{ type: "text", text }]);
}

function assistantMessage(content) {
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "small-model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
