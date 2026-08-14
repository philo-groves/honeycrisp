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
  maxTotalInvocations: 8,
};

test("adaptive collaboration guidance promotes delegation throughout discovery", () => {
  const guidance = createCollaborationSystemGuidance(BASE_CONFIG, "discovery");

  assert.match(guidance, /remains available throughout the session/);
  assert.match(guidance, /do not treat initial decomposition as the only delegation point/);
  assert.match(guidance, /whenever evidence changes the plan/);
  assert.match(guidance, /Prefer followup_task when an existing agent's context matches/);
  assert.match(guidance, /During discovery, actively use ordinary subagents beyond the opening phase/);
  assert.match(guidance, /newly exposed primitive is a reason to reconsider delegation/);
  assert.match(guidance, /do not spawn merely to satisfy the mode/);
});

test("discovery-specific collaboration guidance does not leak into other workflows", () => {
  const guidance = createCollaborationSystemGuidance(BASE_CONFIG, "verification");

  assert.match(guidance, /remains available throughout the session/);
  assert.doesNotMatch(guidance, /During discovery/);
});

test("solo and always collaboration guidance retain their distinct postures", () => {
  const always = createCollaborationSystemGuidance({ ...BASE_CONFIG, mode: "always" }, "discovery");
  const solo = createCollaborationSystemGuidance({ ...BASE_CONFIG, mode: "solo" }, "discovery");

  assert.match(always, /throughout every materially separable research stage/);
  assert.doesNotMatch(always, /do not treat initial decomposition/);
  assert.match(solo, /Do not initiate collaboration unless the user explicitly requests it/);
});
