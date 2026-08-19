import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createResearchAgentFlowCapture } from "../packages/research-agent/dist/index.js";

test("flow captures preserve host research-control events in the event timeline", () => {
  const timestamp = "2026-08-01T20:00:00.000Z";
  const result = captureFixtureResult(timestamp, [
    {
      eventId: "evt_goal_lifecycle",
      type: "goal_lifecycle",
      status: "complete",
      goalTurn: 2,
      agentId: "root",
      agentPath: "/root",
      parentAgentId: "",
    },
    {
      eventId: "evt_research_checkpoint",
      type: "research_checkpoint",
      reason: "native",
      turn: 7,
      agentId: "root",
      agentPath: "/root",
    },
    {
      type: "research_loop_guard",
      action: "blocked_duplicate",
      turn: 8,
      toolName: "memory_get",
      agentId: "root",
      agentPath: "/root",
    },
    {
      eventId: "evt_ordinary_agent_event",
      type: "turn_completed",
      turn: 8,
    },
  ]);
  const nextPromptSuggestions = [
    { title: "Inspect the next boundary", promptMarkdown: "Inspect the next concrete trust boundary." },
    { title: "Challenge the result", promptMarkdown: "Challenge the result with a distinct construction." },
    { title: "Build a regression proof", promptMarkdown: "Build a bounded regression proof from the result." },
  ];
  result.finalDisposition.nextPromptSuggestions = nextPromptSuggestions;

  const capture = createResearchAgentFlowCapture(result, { capturedAt: timestamp });
  const controlEvents = capture.eventTimeline.filter((event) => event.kind === "agent.control");

  assert.deepEqual(controlEvents.map((event) => event.id), [
    "evt_goal_lifecycle",
    "evt_research_checkpoint",
    "agent_control_agent_control_fixture_2",
  ]);
  assert.deepEqual(controlEvents.map((event) => event.payload.type), [
    "goal_lifecycle",
    "research_checkpoint",
    "research_loop_guard",
  ]);
  assert.ok(controlEvents.every((event) => event.timestamp === timestamp));
  assert.ok(controlEvents.every((event) => event.agentId === "root" && event.agentPath === "/root"));
  assert.deepEqual(capture.agent.nextPromptSuggestions, nextPromptSuggestions);
});

function captureFixtureResult(timestamp, agentEvents) {
  const storageRoot = join(tmpdir(), "honeycrisp-flow-capture-control-events");
  return {
    prompt: "Preserve host control telemetry.",
    agentRun: {
      id: "agent_control_fixture",
      status: "complete",
      executorName: "control-fixture",
      startedAt: timestamp,
      completedAt: timestamp,
      output: {
        text: "Control telemetry preserved.",
        raw: { agentEvents },
      },
    },
    events: [],
    storageLayout: {
      schemaVersion: 1,
      rootPath: storageRoot,
      databasePath: ":memory:",
      artifactDirectoryPath: storageRoot,
      directories: [],
      rules: [],
    },
    workspaceContext: {},
    modelWorkspaceContext: {},
    memoryContext: [],
    modelSelectedSkills: [],
    availableTools: [],
    selectedSkills: [],
    collaborationTools: [],
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    response: "Control telemetry preserved.",
    finalDisposition: {},
  };
}
