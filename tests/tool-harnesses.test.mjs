import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createLocalVulnerabilityResearchHarness,
  createMathematicsPuzzleHarness,
  createInvestigationSynthesisHarness,
  createMcpResearchTools,
  createPiAgentLoopExecutor,
  createResearchToolRegistry,
  createSqliteMemoryEventLog,
  createSynthesisTool,
  createToolEvaluationMcpFixture,
  createToolEvaluationSkillFixtures,
  runResearchToolHarness,
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

test("local vulnerability harness supports repeated repository search and memory writeback", async () => {
  const root = await createRepositoryFixture();
  const harness = createLocalVulnerabilityResearchHarness({
    root,
    maxFileBytes: 200_000,
  });
  const result = await runResearchToolHarness(
    harness,
    createAgentExecutor(harness, [
      assistant(
        [
          toolCall("repository_search", {
            query: "parse_context_save",
            maxResults: 5,
          }, "tool_save"),
          toolCall("repository_search", {
            query: "parse_context_restore",
            maxResults: 5,
          }, "tool_restore"),
        ],
        "toolUse",
      ),
      assistant("## Result\nBoth parser context symbols were found in local evidence."),
    ]),
  );

  assert.equal(result.result.decision.actionClass, "search");
  assert.deepEqual(result.observedToolNames, [
    "repository.search",
    "repository.search",
  ]);
  assert.equal(result.blockedToolEvents.length, 0);
  assert.ok(result.memoryCounts.eventLog >= 4);
  assert.ok(result.memoryCounts.directEvidence >= 2);
  assert.deepEqual(
    result.selectedSkills.map((skill) => skill.id),
    ["harness-vulnerability"],
  );
  assertToolEvidenceIncludes(result, "context.c");
  assertToolEvidenceIncludes(result, "parse.c");
});

test("mathematics harness runs an allowlisted computation experiment", async () => {
  const harness = createMathematicsPuzzleHarness();
  const result = await runResearchToolHarness(
    harness,
    createAgentExecutor(harness, [
      assistant(
        toolCall("experiment_run", {
          name: "solve_arithmetic_puzzle",
          input: {
            values: [2, 3, 5],
          },
        }, "tool_sum"),
        "toolUse",
      ),
      assistant("## Result\nThe deterministic sum is 10."),
    ]),
  );
  const observed = result.toolEvents.find(
    (event) => event.kind === "tool.observed" && event.payload.toolName === "experiment.run",
  );

  assert.equal(result.result.decision.actionClass, "experiment");
  assert.deepEqual(result.observedToolNames, ["experiment.run"]);
  assert.equal(observed?.payload.status, "complete");
  assert.equal(observed?.payload.result.output.result, 10);
  assert.ok(result.memoryCounts.directEvidence >= 1);
});

test("investigation harness recalls prior evidence under selected skills", async () => {
  const harness = createInvestigationSynthesisHarness();
  const result = await runResearchToolHarness(
    harness,
    createAgentExecutor(harness, [
      assistant(
        toolCall("memory_recall", {
          query: "source provenance",
          limit: 1,
        }, "tool_recall"),
        "toolUse",
      ),
      assistant("## Result\nA provenance-preserving note can now be drafted."),
    ]),
  );
  const observed = result.toolEvents.find(
    (event) => event.kind === "tool.observed",
  );

  assert.equal(result.result.decision.actionClass, "recall");
  assert.deepEqual(result.observedToolNames, ["memory.recall"]);
  assert.equal(observed?.payload.result.refs[0].id, "mem_investigation_source_a");
  assert.deepEqual(
    result.selectedSkills.map((skill) => skill.id),
    ["harness-investigation"],
  );
  assert.ok(result.memoryCounts.directEvidence >= 1);
});

test("tool evaluation MCP fixture exposes discovery and executable outputs", async () => {
  const { client, calls } = createToolEvaluationMcpFixture();
  const discovery = await createMcpResearchTools({
    client,
    allowedServers: ["harness"],
  });
  const registry = createResearchToolRegistry(discovery.tools);
  const result = await registry.execute({
    id: "mcp_harness_search",
    actionClass: "search",
    toolName: "mcp.harness.search_notes",
    input: {
      query: "parser",
    },
  });

  assert.equal(discovery.tools.length, 2);
  assert.equal(discovery.resourceTemplates.length, 1);
  assert.equal(result.result.status, "complete");
  assert.equal(result.result.output.untrusted, true);
  assert.equal(result.result.output.output.items[0].title, "Harness note");
  assert.deepEqual(calls[0], {
    serverName: "harness",
    toolName: "search_notes",
    arguments: {
      query: "parser",
    },
  });
});

test("tool evaluation skill fixtures describe reusable domain alignment", () => {
  const skills = createToolEvaluationSkillFixtures();

  assert.deepEqual(
    skills.map((skill) => skill.id),
    ["harness-vulnerability", "harness-math", "harness-investigation"],
  );
  assert.ok(
    skills.every((skill) =>
      skill.recommendedActionClasses.includes("analyze") &&
      skill.source.kind === "inline",
    ),
  );
});

test("harness runs preserve denied tool calls as blocked observations", async () => {
  const root = await createRepositoryFixture();
  const baseHarness = createLocalVulnerabilityResearchHarness({
    root,
    maxFileBytes: 200_000,
  });
  const deniedHarness = {
    ...baseHarness,
    governance: {
      ...baseHarness.governance,
      allowedActionClasses: ["search"],
      allowedSideEffects: ["none"],
    },
  };
  const result = await runResearchToolHarness(
    deniedHarness,
    createAgentExecutor(deniedHarness, [
      assistant(
        toolCall("repository_search", {
          query: "parse_context_save",
        }, "tool_denied"),
        "toolUse",
      ),
      assistant("## Result\nThe requested search was blocked by policy."),
    ]),
  );

  assert.deepEqual(result.observedToolNames, ["repository.search"]);
  assert.equal(result.blockedToolEvents.length, 1);
  assert.match(
    result.blockedToolEvents[0].payload.summary,
    /side effect read is not allowed/,
  );
});

test("artifact-heavy tool outputs spill into event-log artifact storage", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tool-harness-"));
  const registry = createResearchToolRegistry([createSynthesisTool()]);
  const record = await registry.execute({
    id: "large_synthesis",
    actionClass: "synthesize",
    toolName: "synthesis.compose",
    input: {
      title: "Large Harness Report",
      sections: ["parser evidence ".repeat(200)],
      artifactKind: "report",
    },
  });
  const log = createSqliteMemoryEventLog({
    workspaceRoot,
    largePayloadThresholdBytes: 128,
  });
  const appended = log.appendMany(record.events);
  const observed = appended.find((event) => event.kind === "tool.observed");

  assert.ok(observed);
  assert.equal(observed.payload.result, undefined);
  assert.match(observed.payload.rawOutputHash, /^sha256:/);
  assert.ok(observed.payload.rawOutputRef);
  assert.ok(
    observed.artifactRefs.some((ref) => ref.kind === "tool_raw_output"),
  );
  assert.ok(
    observed.payload.generatedArtifactRefs.some(
      (ref) => ref.id === "artifact_large_synthesis_synthesis",
    ),
  );

  log.close();
});

function createAgentExecutor(harness, messages) {
  return createPiAgentLoopExecutor({
    provider: "faux",
    model: "faux-model",
    models: createScriptedModels(messages),
    toolRegistry: createResearchToolRegistry(harness.tools),
    toolExecution: "parallel",
  });
}

async function createRepositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-tool-repo-"));
  await mkdir(join(root, "Src"));
  await writeFile(
    join(root, "Src", "parse.c"),
    [
      "void parse_context_save(void) {",
      "  /* parser state save fixture */",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(root, "Src", "context.c"),
    [
      "void parse_context_restore(void) {",
      "  /* parser state restore fixture */",
      "}",
    ].join("\n"),
  );
  return root;
}

function assertToolEvidenceIncludes(result, text) {
  assert.ok(
    result.toolEvents.some((event) =>
      event.kind === "tool.observed" &&
      JSON.stringify(event.payload.evidenceExtracted).includes(text),
    ),
    `expected tool evidence to include ${text}`,
  );
}

function createScriptedModels(messages) {
  let index = 0;
  return {
    getModel() {
      return FAUX_MODEL;
    },
    streamSimple() {
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
