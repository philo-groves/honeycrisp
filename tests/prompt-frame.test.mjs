import assert from "node:assert/strict";
import test from "node:test";

import { createResearchGoalFrame } from "../packages/research-agent/dist/index.js";

test("converts a structured research prompt into a goal frame", () => {
  const frame = createResearchGoalFrame(
    [
      "Goal: Investigate whether parser X has a reachable memory safety issue",
      "Success gates:",
      "- Produce a concise evidence-backed triage summary",
      "- Identify remaining unknowns",
      "Stop gates:",
      "- Stop if no authorized target scope is available",
      "Scope constraints: local test corpus only",
      "Evidence: keep repro steps linked to observations",
      "Preferences: concise output",
      "Risk: security-sensitive",
    ].join("\n"),
    {
      scopeConstraints: ["do not run network probes"],
      evidenceRequirements: ["record uncertainty explicitly"],
    },
  );

  assert.equal(
    frame.root.objective,
    "Investigate whether parser X has a reachable memory safety issue",
  );
  assert.equal(frame.prompt.rootGoal, frame.root.objective);
  assert.deepEqual(frame.scopeConstraints, [
    "local test corpus only",
    "do not run network probes",
  ]);
  assert.deepEqual(frame.userPreferences, ["concise output"]);
  assert.ok(
    frame.evidenceRequirements.includes("keep repro steps linked to observations"),
  );
  assert.ok(
    frame.evidenceRequirements.includes("record uncertainty explicitly"),
  );
  assert.deepEqual(frame.riskFlags, ["security-sensitive"]);
  assert.equal(frame.root.completionGates[0]?.polarity, "success");
  assert.equal(frame.root.stopGates[0]?.polarity, "stop");
});

test("adds conservative defaults for unstructured prompts", () => {
  const frame = createResearchGoalFrame("Solve this puzzle carefully.");

  assert.equal(frame.root.objective, "Solve this puzzle carefully.");
  assert.ok(frame.root.completionGates.length >= 2);
  assert.ok(frame.root.stopGates.length >= 2);
  assert.ok(frame.evidenceRequirements.length >= 2);
});
