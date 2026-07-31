import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_GOAL_TOOL_DESCRIPTORS,
  ResearchDispositionRecorder,
  ResearchGoalRuntime,
} from "../packages/research-agent/dist/index.js";

test("research goal runtime exposes one flat objective through get_goal and defers terminal updates", async () => {
  const recorder = new ResearchDispositionRecorder();
  const runtime = createRuntime("  Investigate the authorization boundary.  ", recorder);
  const tools = toolsByName(runtime);

  assert.deepEqual(Object.keys(tools).sort(), ["get_goal", "update_goal"]);
  assert.deepEqual(
    RESEARCH_GOAL_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name),
    ["get_goal", "update_goal"],
  );

  const read = await tools.get_goal.execute("get_goal_1", {});
  assert.equal(read.details.objective, "Investigate the authorization boundary.");
  assert.equal(read.details.status, "active");
  assert.equal(read.details.turnsUsed, 0);
  assert.equal("plan" in read.details, false);
  assert.equal("candidates" in read.details, false);

  const requested = await tools.update_goal.execute("update_goal_1", { status: "complete" });
  assert.equal(requested.details.goal.status, "active");
  assert.equal(requested.details.goal.requestedStatus, "complete");

  const followUp = runtime.continueAfterRootResponse();
  assert.equal(followUp.length, 1);
  assert.match(followUp[0].content, /Investigate the authorization boundary\./);
  assert.match(followUp[0].content, /did not record a valid session disposition/);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.turnsUsed, 1);
  assert.equal(snapshot.requestedStatus, null);
  assert.equal(snapshot.lastDisposition, null);
});

test("research goal completion requires an objective_achieved disposition", async () => {
  const recorder = new ResearchDispositionRecorder();
  const runtime = createRuntime("Verify the complete exploit chain.", recorder);
  const tools = toolsByName(runtime);

  recorder.record(disposition({
    outcome: "objective_partially_achieved",
    summary: "The source was reached, but the sink remains unverified.",
  }));
  await tools.update_goal.execute("partial_complete", { status: "complete" });

  const partialFollowUp = runtime.continueAfterRootResponse();
  assert.equal(partialFollowUp.length, 1);
  assert.equal(runtime.snapshot().status, "active");
  assert.equal(runtime.snapshot().turnsUsed, 1);
  assert.equal(recorder.get(), null);

  recorder.record(disposition({
    outcome: "objective_achieved",
    summary: "The complete source-to-sink chain was reproduced and verified.",
  }));
  await tools.update_goal.execute("verified_complete", { status: "complete" });

  assert.deepEqual(runtime.continueAfterRootResponse(), []);
  assert.equal(runtime.snapshot().status, "complete");
  assert.equal(runtime.snapshot().turnsUsed, 2);
  assert.equal(runtime.snapshot().requestedStatus, null);
  assert.equal(runtime.snapshot().lastDisposition.outcome, "objective_achieved");
});

test("research goal blocking requires the same external dependency for three goal turns", async () => {
  const recorder = new ResearchDispositionRecorder();
  const runtime = createRuntime("Validate behavior against the authorized live target.", recorder);
  const tools = toolsByName(runtime);
  const targetBlocker = disposition({
    outcome: "blocked",
    summary: "The authorized target is offline.",
    blockerDependencies: [{
      kind: "target_state",
      description: "The authorized target is offline.",
      requiredState: "Restore the authorized target to a reachable state.",
      external: true,
    }],
    externalStateRequired: true,
  });
  const credentialBlocker = disposition({
    outcome: "blocked",
    summary: "The authorized credential is unavailable.",
    blockerDependencies: [{
      kind: "credentials",
      description: "The authorized test credential is unavailable.",
      requiredState: "Provide an authorized test credential reference.",
      external: true,
    }],
    externalStateRequired: true,
  });

  const attempts = [
    [targetBlocker, 1],
    [credentialBlocker, 1],
    [targetBlocker, 1],
    [targetBlocker, 2],
    [targetBlocker, 3],
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    const [blocker, expectedStreak] = attempts[index];
    recorder.record(blocker);
    await tools.update_goal.execute(`blocked_${index + 1}`, { status: "blocked" });
    const followUp = runtime.continueAfterRootResponse();

    if (index < attempts.length - 1) {
      assert.equal(followUp.length, 1);
      assert.equal(runtime.snapshot().status, "active");
      assert.equal(runtime.snapshot().consecutiveBlockedTurns, expectedStreak);
      assert.equal(recorder.get(), null);
    } else {
      assert.deepEqual(followUp, []);
      assert.equal(runtime.snapshot().status, "blocked");
      assert.equal(runtime.snapshot().consecutiveBlockedTurns, 3);
      assert.equal(recorder.get().outcome, "blocked");
    }
  }

  assert.equal(runtime.snapshot().turnsUsed, 5);
});

test("missing, partial, and inconclusive dispositions continue the goal and reset turn state", () => {
  const recorder = new ResearchDispositionRecorder();
  const runtime = createRuntime("Keep gathering evidence.", recorder);

  const missingFollowUp = runtime.continueAfterRootResponse();
  assert.equal(missingFollowUp.length, 1);
  assert.match(missingFollowUp[0].content, /did not record a valid session disposition/);
  assert.equal(recorder.get(), null);

  for (const [outcome, summary] of [
    ["objective_partially_achieved", "One boundary is verified."],
    ["inconclusive", "Available evidence does not resolve the candidate."],
  ]) {
    recorder.record(disposition({ outcome, summary }));
    const followUp = runtime.continueAfterRootResponse();
    assert.equal(followUp.length, 1);
    assert.match(followUp[0].content, new RegExp(`Outcome: ${outcome}`));
    assert.equal(runtime.snapshot().status, "active");
    assert.equal(recorder.get(), null);
  }

  assert.equal(runtime.snapshot().turnsUsed, 3);
  assert.equal(runtime.snapshot().consecutiveBlockedTurns, 0);
});

function createRuntime(objective, recorder) {
  return new ResearchGoalRuntime({
    objective,
    getDisposition: () => recorder.get(),
    resetDisposition: () => recorder.resetForGoalContinuation(),
  });
}

function toolsByName(runtime) {
  return Object.fromEntries(runtime.createTools().map((tool) => [tool.name, tool]));
}

function disposition(overrides = {}) {
  return {
    outcome: "inconclusive",
    summary: "The goal remains unresolved.",
    blockerDependencies: [],
    externalStateRequired: false,
    ...overrides,
  };
}
