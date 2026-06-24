import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapResearchRun,
  createFirstRunMemoryController,
  createResearchGoalFrame,
  planResearchLoop,
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

test("bootstrap output includes memory decision and context event records", () => {
  const result = bootstrapResearchRun({
    prompt: "Goal: Investigate a math puzzle\nScope constraints: no external search",
  });

  assert.equal(result.decision.actionClass, "synthesize");
  assert.equal(result.events.length, 4);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["goal.created", "memory.decision", "context.compiled", "loop.planned"],
  );
  assert.equal(
    result.decision.contextPacket.activeGoal.id,
    result.goalFrame.root.id,
  );
  assert.equal(result.loopPlan.subGoal.id, result.decision.subGoal.id);
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
