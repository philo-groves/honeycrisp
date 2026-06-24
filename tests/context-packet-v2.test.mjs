import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapResearchRun,
  compileContextPacketV2,
  createDeterministicMemoryRetriever,
  createDeterministicMemoryWritePipeline,
  createFirstRunMemoryController,
  createResearchEventId,
  createResearchFlowCapture,
  createResearchGoalFrame,
} from "../packages/research-agent/dist/index.js";

test("context packet v2 respects section token budgets", () => {
  const { goalFrame, subGoal, retrieval } = createRetrievalFixture([
    createEvent("tool.observed", {
      summary: [
        "Parser normalization source evidence.",
        "This deliberately long summary should be clipped to fit the direct evidence budget.",
        "The compiler should keep a reference and bounded summary instead of dumping the record.",
      ].join(" "),
      confidence: 0.95,
    }),
  ]);

  const packet = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: subGoal,
    retrieval,
    tools: [],
    sectionTokenBudgets: {
      direct_evidence: 20,
    },
  });
  const directEvidence = packet.sections.find(
    (section) => section.label === "direct_evidence",
  );

  assert.ok(directEvidence);
  assert.ok(directEvidence.estimatedTokens <= 20);
  assert.equal(directEvidence.items.length, 1);
  assert.ok(directEvidence.items[0]?.summary.endsWith("..."));
});

test("context packet v2 keeps evidence and inference labels separate", () => {
  const { goalFrame, subGoal, retrieval } = createRetrievalFixture([
    createEvent("tool.observed", {
      summary: "Parser normalization source was inspected.",
    }),
    createEvent("model.claim", {
      claim: "Normalization happens before expansion.",
      evidenceRefIds: ["source_inspection"],
    }),
    createEvent("model.hypothesis", {
      hypothesis: "Expansion may still affect nested state.",
      evidenceRefIds: ["source_inspection"],
    }),
  ]);

  const packet = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: subGoal,
    retrieval,
    tools: [],
  });
  const directEvidence = packet.sections.find(
    (section) => section.label === "direct_evidence",
  );
  const currentHypotheses = packet.sections.find(
    (section) => section.label === "current_hypotheses",
  );

  assert.equal(directEvidence?.items[0]?.label, "direct_evidence");
  assert.ok(
    currentHypotheses?.items.some((item) => item.label === "inference"),
  );
  assert.ok(
    currentHypotheses?.items.some((item) => item.label === "hypothesis"),
  );
});

test("context packet v2 keeps relevant contradictions within bounded context", () => {
  const { goalFrame, subGoal, retrieval } = createRetrievalFixture([
    createEvent("model.claim", {
      claim: "The parser branch is reachable.",
      evidenceRefIds: ["static_reference"],
      evidenceAgainstRefIds: ["negative_fixture_run"],
      confidence: 0.4,
    }),
  ]);

  const packet = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: subGoal,
    retrieval,
    tools: [],
    sectionTokenBudgets: {
      contradictions_uncertainty: 12,
    },
  });
  const contradictions = packet.sections.find(
    (section) => section.label === "contradictions_uncertainty",
  );

  assert.equal(contradictions?.items.length, 1);
  assert.ok(contradictions?.estimatedTokens <= 12);
  assert.ok(
    contradictions?.items[0]?.warnings.includes(
      "Record has evidence against it.",
    ),
  );
});

test("flow capture exposes context packet v2 selection reasons", async () => {
  const result = await bootstrapResearchRun({
    prompt: "Goal: Capture v2 context reasons\nScope constraints: no external search",
  });
  const { goalFrame, subGoal, retrieval } = createRetrievalFixture([
    createEvent("tool.observed", {
      summary: "Direct evidence for flow capture.",
      confidence: 0.9,
    }, {
      goalId: result.goalFrame.root.id,
    }),
  ], result.goalFrame);
  const packet = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: subGoal,
    retrieval,
    tools: [],
  });
  const capture = createResearchFlowCapture(result, {
    capturedAt: "2026-06-24T00:00:00.000Z",
    contextPacketV2: packet,
  });

  assert.ok(capture.contextV2);
  assert.ok(capture.contextV2.preconsciousCandidateCount > 0);
  assert.ok(
    capture.contextV2.sections.some((section) =>
      section.selectionReasons.some((selection) => selection.reasons.length > 0),
    ),
  );
});

function createRetrievalFixture(events, existingGoalFrame) {
  const goalFrame =
    existingGoalFrame ??
    createResearchGoalFrame("Goal: Review parser normalization behavior");
  const decision = createFirstRunMemoryController().decide({ goalFrame });
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const records = pipeline.deriveMany(
    events.map((event) => ({
      ...event,
      goalId: event.goalId ?? goalFrame.root.id,
    })),
  );
  const retrieval = retriever.retrieve({
    activeGoal: goalFrame.root,
    activeSubGoal: decision.subGoal,
    records,
    openQuestions: ["What evidence explains parser normalization behavior?"],
    recentEvents: events,
  });

  return {
    goalFrame,
    subGoal: decision.subGoal,
    retrieval,
  };
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
