import assert from "node:assert/strict";
import test from "node:test";

import { createResearchGoalFrame } from "../packages/research-agent/dist/index.js";
import { createRepeatAvoidanceTargets } from "../packages/research-agent/dist/repeat-targets.js";

test("repeat avoidance extracts prior scanned source paths for fresh inspect goals", () => {
  const goalFrame = createResearchGoalFrame(
    "Pick a single source file of the ZSH repository and perform static analysis. Stop if you run out of functions to scan in that file or find a bug.",
  );
  const packet = createPacket(goalFrame, {
    actionClass: "inspect",
    priorObservations: [
      {
        store: "episodic",
        id: "mem_previous_clone_scan",
        summary:
          "Prior-goal direct evidence (context only; do not count as current completion proof): Selected and fully read /Users/philogroves/maxtac-resources/zsh/zsh/Src/Modules/clone.c via file.read (3,931 bytes).",
      },
      {
        store: "episodic",
        id: "mem_previous_regex_scan",
        summary:
          "Selected and fully read zsh/Src/Modules/regex.c via file.read (6,519 bytes).",
      },
    ],
  });

  const targets = createRepeatAvoidanceTargets(packet);

  assert.deepEqual(
    targets.map((target) => target.path),
    [
      "/Users/philogroves/maxtac-resources/zsh/zsh/Src/Modules/clone.c",
      "zsh/Src/Modules/regex.c",
    ],
  );
  assert.ok(targets.every((target) => target.reason.includes("already selected")));
});

test("repeat avoidance stays empty for recall-style goals", () => {
  const goalFrame = createResearchGoalFrame("Report what we already scanned last time.");
  const packet = createPacket(goalFrame, {
    actionClass: "respond",
    priorObservations: [
      {
        store: "episodic",
        id: "mem_previous_clone_scan",
        summary:
          "Selected and fully read /Users/philogroves/maxtac-resources/zsh/zsh/Src/Modules/clone.c via file.read.",
      },
    ],
  });

  assert.deepEqual(createRepeatAvoidanceTargets(packet), []);
});

function createPacket(goalFrame, options) {
  const activeSubGoal = {
    id: "subgoal_test",
    parentGoalId: goalFrame.root.id,
    objective: goalFrame.root.objective,
    rationale: "test",
    actionClass: options.actionClass,
    completionGates: [],
    expectedArtifacts: [],
  };

  return {
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal,
    directEvidence: [],
    priorObservations: options.priorObservations,
    candidateProcedures: [],
    currentHypotheses: [],
    currentFindings: [],
    contradictions: [],
    openQuestions: [],
    userCommitments: [],
    toolPermissions: [],
    toolBudget: {
      maxToolCalls: 1,
    },
    selectedSkills: [],
    candidateToolActions: [],
    skippedToolActions: [],
    writebackExpectations: ["event"],
  };
}
