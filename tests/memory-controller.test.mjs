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
  createResearchGoalFrame,
  isAcceptedRawEventKind,
  planResearchLoop,
  processResearchLoop,
  routeEventsToMemorySnapshot,
} from "../packages/research-agent/dist/index.js";

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
  assert.equal(result.events.length, 5);
  assert.deepEqual(
    result.events.map((event) => event.kind),
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
});

test("raw event acceptance excludes private thought traces", () => {
  assert.equal(isAcceptedRawEventKind("model.visible_note"), true);
  assert.equal(isAcceptedRawEventKind("model.hypothesis"), true);
  assert.equal(isAcceptedRawEventKind("model.private_thought"), false);
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
