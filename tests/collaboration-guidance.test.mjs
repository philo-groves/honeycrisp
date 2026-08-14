import assert from "node:assert/strict";
import test from "node:test";

import { createCollaborationSystemGuidance } from "../packages/research-agent/dist/collaboration-guidance.js";

const BASE_CONFIG = {
  mode: "adaptive",
  intensity: "balanced",
  providers: [
    { provider: "openai", model: "gpt-5.6", reasoningEffort: "high", enabled: true },
    { provider: "anthropic", model: "claude-opus-5", reasoningEffort: "high", enabled: true },
  ],
  independentFirstPass: true,
  peerChallengeRounds: 1,
  maxConcurrentRooms: 2,
  maxMembersPerRoom: 3,
};

test("adaptive collaboration guidance makes delegation evidence-driven", () => {
  const guidance = createCollaborationSystemGuidance(BASE_CONFIG, "discovery");

  assert.match(guidance, /makes collaboration available, not required/);
  assert.match(guidance, /materially better evidence than continuing in the lead/);
  assert.match(guidance, /coordination cost outweighs the expected gain/);
  assert.match(guidance, /Prefer followup_task when an existing agent's context matches/);
  assert.match(guidance, /these are opportunities, not a delegation requirement/);
  assert.match(guidance, /Do not spawn merely to satisfy the mode/);
  assert.match(guidance, /Concurrency limits: 6 active subagent turns/);
  assert.doesNotMatch(guidance, /actively use ordinary subagents/);
  assert.doesNotMatch(guidance, /no lifetime collaborator-invocation budget/i);
});

test("discovery-specific collaboration guidance does not leak into other workflows", () => {
  const guidance = createCollaborationSystemGuidance(BASE_CONFIG, "verification");

  assert.match(guidance, /makes collaboration available, not required/);
  assert.doesNotMatch(guidance, /Discovery may benefit/);
});

test("solo and always collaboration guidance retain their distinct postures", () => {
  const always = createCollaborationSystemGuidance({ ...BASE_CONFIG, mode: "always" }, "discovery");
  const solo = createCollaborationSystemGuidance({ ...BASE_CONFIG, mode: "solo" }, "discovery");

  assert.match(always, /throughout every materially separable research stage/);
  assert.doesNotMatch(always, /makes collaboration available, not required/);
  assert.match(solo, /Do not initiate collaboration unless the user explicitly requests it/);
});
