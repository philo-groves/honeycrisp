import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeterministicMemoryRetriever,
  createDeterministicMemoryWritePipeline,
  createFirstRunMemoryController,
  createMemoryDrivenController,
  createResearchEventId,
  createResearchGoalFrame,
} from "../packages/research-agent/dist/index.js";

test("memory-driven controller preserves first-run fallback behavior", () => {
  const goalFrame = createResearchGoalFrame(
    "Goal: Compare two puzzle-solving strategies\nScope constraints: no external search",
  );
  const fallback = createFirstRunMemoryController().decide({ goalFrame });
  const decision = createMemoryDrivenController().decide({ goalFrame });

  assert.equal(decision.usedFirstRunFallback, true);
  assert.equal(decision.actionClass, fallback.actionClass);
  assert.equal(decision.subGoal.objective, fallback.subGoal.objective);
  assert.equal(decision.contextPacketV2.preconsciousCandidateCount, 0);
});

test("memory-driven controller responds only when completion gates are supported by memory", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Finish parser proof",
      "Success gates: proof checked",
      "Scope constraints: local evidence only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent("tool.observed", {
      summary: "The parser proof checked successfully.",
      confidence: 0.95,
    }),
    createEvent("tool.observed", {
      summary: "The response or artifact directly addresses the root research goal.",
      confidence: 0.95,
    }),
    createEvent("tool.observed", {
      summary: "Key claims are separated from assumptions and uncertainty.",
      confidence: 0.95,
    }),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });

  assert.equal(decision.actionClass, "respond");
  assert.ok(decision.supportingRecordIds.length > 0);
  assert.match(decision.rationale, /Selected respond/);
});

test("memory-driven controller treats prior-goal analysis as context, not fresh goal completion", () => {
  const goalFrame = createResearchGoalFrame(
    "Pick a single source file of the ZSH repository and perform static analysis. Stop if you run out of functions to scan in that file or find a bug.",
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent(
      "tool.observed",
      {
        summary:
          "Read 3931 byte(s) from /Users/philogroves/maxtac-resources/zsh/zsh/Src/Modules/clone.c.",
        confidence: 0.95,
      },
      { goalId: "previous_goal" },
    ),
    createEvent(
      "loop.processed",
      {
        summary:
          "Selected and statically analyzed one source file zsh/Src/Modules/clone.c. Functions scanned: bin_clone, setup_, features_, enables_, boot_, cleanup_, finish_. No confirmed bug found.",
        confidence: 0.95,
      },
      { goalId: "previous_goal" },
    ),
    createEvent(
      "model.claim",
      {
        summary:
          "Success gates are satisfied: the response directly addresses the root goal by selecting one ZSH source file and statically scanning all functions, and key claims are separated from assumptions and uncertainty.",
        confidence: 0.95,
      },
      { goalId: "previous_goal" },
    ),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
    tools: [
      {
        name: "repository.search",
        transportName: "repository_search",
        description: "Search local repository files.",
        actionClasses: ["search", "inspect"],
        sideEffects: "read",
        requiredPermissions: ["filesystem:read"],
        artifactLocations: [],
        metadata: {},
      },
    ],
  });

  assert.equal(decision.actionClass, "inspect");
  assert.match(decision.subGoal.objective, /^Gather direct evidence/);
  assert.equal(decision.supportingRecordIds.length, 0);

  const directEvidenceSection = decision.contextPacketV2.sections.find(
    (section) => section.label === "direct_evidence",
  );
  const priorEpisodesSection = decision.contextPacketV2.sections.find(
    (section) => section.label === "prior_episodes",
  );

  assert.equal(directEvidenceSection?.items.length, 0);
  assert.ok(
    priorEpisodesSection?.items.some((item) =>
      item.warnings.includes(
        "From a different goal; use as prior context only, not current completion proof.",
      ),
    ),
  );
});

test("memory-driven controller stops when a stop gate is supported by memory", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Walk parser functions",
      "Success gates: summarize walked functions",
      "Stop gates: stop after walking a maximum of two functions",
      "Scope constraints: local fixture only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent("tool.observed", {
      summary: "Stop after walking a maximum of two functions reached.",
      confidence: 1,
    }),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });

  assert.equal(decision.actionClass, "stop");
  assert.match(decision.subGoal.objective, /^Stop work on:/);
  assert.equal(decision.completionGates[0]?.polarity, "stop");
});

test("memory-driven controller does not stop a new goal on prior recoverable tool blockers", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Continue local source triage",
      "Success gates: collect file-backed source evidence",
      "Stop gates: The goal is blocked by missing scope, unavailable evidence, or unsafe assumptions.",
      "Scope constraints: local fixture only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent(
      "tool.observed",
      {
        summary: "repository.search does not support action class inspect.",
        status: "blocked",
        confidence: 0.95,
      },
      { goalId: "previous_goal" },
    ),
    createEvent(
      "model.visible_note",
      {
        summary: "Further inspection requires a successful directory listing/search action before file reads.",
        confidence: 0.9,
      },
      { goalId: "previous_goal" },
    ),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
    tools: [
      {
        name: "repository.search",
        transportName: "repository_search",
        description: "Search local repository files.",
        actionClasses: ["search", "inspect"],
        sideEffects: "read",
        requiredPermissions: ["filesystem:read"],
        artifactLocations: [],
        metadata: {},
      },
    ],
  });

  assert.equal(decision.actionClass, "inspect");
  assert.match(decision.subGoal.objective, /^Gather direct evidence/);
});

test("memory-driven controller prefers inspect over response when retrieved gate evidence is only recoverable blockers", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Continue local source triage",
      "Success gates: collect file-backed source evidence",
      "Scope constraints: local fixture only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent("tool.observed", {
      summary:
        "Collect file backed source evidence is blocked by ENOENT for /fixture/Src/init.c.",
      status: "blocked",
      confidence: 0.95,
    }),
    createEvent("tool.observed", {
      summary:
        "The response or artifact directly addresses the root research goal, but no direct source evidence has been collected because repository.search inspect was blocked.",
      status: "blocked",
      confidence: 0.95,
    }),
    createEvent("tool.observed", {
      summary:
        "Key claims are separated from assumptions and uncertainty, but source evidence remains unavailable due to path layout.",
      status: "blocked",
      confidence: 0.95,
    }),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
    tools: [
      {
        name: "repository.search",
        transportName: "repository_search",
        description: "Search local repository files.",
        actionClasses: ["search", "inspect"],
        sideEffects: "read",
        requiredPermissions: ["filesystem:read"],
        artifactLocations: [],
        metadata: {},
      },
    ],
  });

  assert.equal(decision.actionClass, "inspect");
  assert.match(decision.subGoal.objective, /^Gather direct evidence/);
});

test("memory-driven controller creates a bounded function-walk subgoal from retrieved next steps", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Walk parser functions",
      "Success gates: summarize each function",
      "Scope constraints: local fixture only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent("model.visible_note", {
      summary: "Walk parseBeta next.",
      confidence: 0.9,
    }),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });

  assert.match(decision.subGoal.objective, /Walk parseBeta next/);
  assert.ok(decision.supportingRecordIds.length > 0);
});

test("memory-driven controller explains decisions from retrieved records and gates", () => {
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Analyze parser reachability",
      "Success gates: identify remaining unknowns",
      "Scope constraints: local fixture only",
    ].join("\n"),
  );
  const retrieval = createRetrieval(goalFrame, [
    createEvent("model.claim", {
      claim: "The parser branch is reachable.",
      evidenceRefIds: ["static_reference"],
      evidenceAgainstRefIds: ["negative_fixture_run"],
      confidence: 0.45,
    }),
  ]);
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });

  assert.equal(decision.actionClass, "analyze");
  assert.ok(decision.supportingRecordIds.length > 0);
  assert.ok(decision.warnings.includes("Record has evidence against it."));
  assert.match(decision.subGoal.rationale, /Supporting records:/);
  assert.ok(decision.contextPacketV2.sections.length > 0);
});

function createRetrieval(goalFrame, events) {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const records = pipeline.deriveMany(
    events.map((event) => ({
      ...event,
      goalId: event.goalId ?? goalFrame.root.id,
    })),
  );

  return retriever.retrieve({
    activeGoal: goalFrame.root,
    records,
    recentEvents: events,
    openQuestions: ["What memory supports the next bounded step?"],
  });
}

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: "2026-06-24T00:00:00.000Z",
    payload,
    ...options,
  };
}
