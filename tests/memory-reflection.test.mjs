import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyMemoryReflection,
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
  createResearchGoalFrame,
  createSqliteMemoryRecordStore,
  reflectOnLoopBoundary,
  shouldReflectOnLoop,
} from "../packages/research-agent/dist/index.js";

test("memory reflection summarizes loops and updates the active goal frame", () => {
  const goalFrame = createResearchGoalFrame("Goal: Reflect loop output");
  const loopResult = createLoopResult({
    text: "Loop inspected parser behavior.",
    researchTrace: {
      observations: [],
      inferences: [],
      hypotheses: [],
      assumptions: [],
      rejectedPaths: [],
      uncertainty: [],
      nextQuestions: [],
      evidenceLinks: [],
      goalAssessment: {
        status: "complete",
        rationale: "All reflected gates are satisfied.",
      },
    },
  });

  const reflection = reflectOnLoopBoundary({
    goalFrame,
    loopResult,
    reflectedAt: "2026-06-24T00:00:01.000Z",
  });

  assert.equal(shouldReflectOnLoop(loopResult), true);
  assert.equal(reflection.shouldReflect, true);
  assert.equal(reflection.updatedGoalFrame.root.status, "complete");
  assert.equal(
    reflection.updatedGoalFrame.root.resultSummary,
    "All reflected gates are satisfied.",
  );
  assert.equal(reflection.episodicRecord?.kind, "episodic");
  assert.equal(reflection.episodicRecord?.episodeKind, "loop_result");
  assert.equal(reflection.episodicRecord?.summary, "Loop inspected parser behavior.");
});

test("memory reflection updates hypothesis state and preserves evidence history", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const goalFrame = createResearchGoalFrame("Goal: Reflect hypothesis evidence");
  const pipeline = createDeterministicMemoryWritePipeline();
  const [hypothesis] = pipeline.derive(
    createEvent("model.hypothesis", {
      hypothesis: "The parser branch is reachable.",
      evidenceRefIds: ["initial_support"],
      confidence: 0.6,
    }),
  );
  store.write(hypothesis);
  const loopResult = createLoopResult({
    researchTrace: {
      observations: [],
      inferences: [],
      hypotheses: [],
      assumptions: [],
      rejectedPaths: [],
      uncertainty: [],
      nextQuestions: [],
      evidenceLinks: [
        {
          evidenceRefId: "negative_fixture_run",
          weakens: [hypothesis.id],
          note: "Fixture did not reach the branch.",
        },
      ],
      goalAssessment: {
        status: "continue",
        rationale: "Hypothesis needs revision.",
      },
    },
  });
  const reflection = reflectOnLoopBoundary({
    goalFrame,
    loopResult,
    records: [hypothesis],
    reflectedAt: "2026-06-24T00:00:01.000Z",
  });

  applyMemoryReflection(store, reflection);
  const updated = store.getById(hypothesis.id);

  assert.equal(updated?.status, "contradicted");
  assert.ok((updated?.confidence ?? 1) < 0.6);
  assert.deepEqual(
    updated?.provenance.evidenceFor.map((ref) => ref.id),
    ["initial_support"],
  );
  assert.deepEqual(
    updated?.provenance.evidenceAgainst.map((ref) => ref.id),
    ["negative_fixture_run"],
  );

  store.close();
});

test("memory reflection promotes repeated useful procedure candidates", () => {
  const goalFrame = createResearchGoalFrame("Goal: Promote procedure");
  const pipeline = createDeterministicMemoryWritePipeline();
  const firstProcedure = pipeline
    .derive(
      createEvent("model.visible_note", {
        summary: "Procedure observed.",
        procedure: "Map parser normalization before expansion.",
      }),
    )
    .find((record) => record.kind === "procedure");
  const secondProcedure = pipeline
    .derive(
      createEvent("model.visible_note", {
        summary: "Procedure observed again.",
        procedure: "Map parser normalization before expansion.",
      }),
    )
    .find((record) => record.kind === "procedure");
  assert.ok(firstProcedure);
  assert.ok(secondProcedure);

  const reflection = reflectOnLoopBoundary({
    goalFrame,
    loopResult: createLoopResult(),
    records: [firstProcedure, secondProcedure],
    reflectedAt: "2026-06-24T00:00:01.000Z",
    procedurePromotionThreshold: 2,
  });
  const promoted = reflection.promotedProcedures[0];

  assert.equal(promoted?.kind, "procedure");
  assert.deepEqual(promoted?.guidance, {
    durability: "durable",
    promotionReason: "repeated_usefulness",
    usefulCount: 2,
    supportingEventIds: promoted.sourceEventIds,
  });
});

test("memory reflection marks stale and superseded records", () => {
  const goalFrame = createResearchGoalFrame("Goal: Mark lifecycle states");
  const pipeline = createDeterministicMemoryWritePipeline();
  const [staleClaim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "Old claim.",
    }),
  );
  const [replacement] = pipeline.derive(
    createEvent("model.claim", {
      claim: "Replacement claim.",
    }),
  );
  const supersededClaim = {
    ...staleClaim,
    id: `${staleClaim.id}_superseded_fixture`,
    tags: [...staleClaim.tags, `superseded-by:${replacement.id}`],
  };
  const expiredClaim = {
    ...staleClaim,
    id: `${staleClaim.id}_stale_fixture`,
    validUntil: "2020-01-01T00:00:00.000Z",
  };

  const reflection = reflectOnLoopBoundary({
    goalFrame,
    loopResult: createLoopResult(),
    records: [supersededClaim, expiredClaim],
    reflectedAt: "2026-06-24T00:00:01.000Z",
  });

  assert.ok(
    reflection.statusUpdates.some(
      (update) =>
        update.recordId === supersededClaim.id &&
        update.status === "superseded" &&
        update.supersededByRecordId === replacement.id,
    ),
  );
  assert.ok(
    reflection.statusUpdates.some(
      (update) => update.recordId === expiredClaim.id && update.status === "stale",
    ),
  );
});

test("memory reflection schedules prospective checks from unresolved follow-up actions", () => {
  const goalFrame = createResearchGoalFrame("Goal: Schedule follow-up");
  const loopResult = createLoopResult({
    followUpActions: ["Inspect parseGamma next."],
  });
  const reflection = reflectOnLoopBoundary({
    goalFrame,
    loopResult,
    reflectedAt: "2026-06-24T00:00:01.000Z",
  });

  assert.equal(reflection.prospectiveChecks.length, 1);
  assert.equal(reflection.prospectiveChecks[0]?.check, "Inspect parseGamma next.");
  assert.equal(
    reflection.prospectiveChecks[0]?.trigger,
    "Before the next memory-driven controller decision.",
  );
});

async function createTempWorkspace() {
  return mkdtemp(join(tmpdir(), "honeycrisp-reflection-"));
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

function createLoopResult(options = {}) {
  return {
    id: options.id ?? "loopresult_reflection_fixture",
    loopPlanId: options.loopPlanId ?? "loop_reflection_fixture",
    subGoalId: options.subGoalId ?? "subgoal_reflection_fixture",
    status: options.status ?? "complete",
    executorName: "reflection-test",
    startedAt: "2026-06-24T00:00:00.000Z",
    completedAt: "2026-06-24T00:00:01.000Z",
    modelInput: {
      loopPrompt: "test",
      contextSections: [],
      permittedToolClasses: [],
      toolBudget: {
        maxToolCalls: 0,
      },
    },
    output: {
      text: options.text ?? "Loop reflected.",
      artifacts: [],
      evidenceRefs: [],
      claimRefs: [],
      followUpActions: options.followUpActions ?? [],
      ...(options.researchTrace ? { researchTrace: options.researchTrace } : {}),
    },
    completionGateResults: [],
    followUpRecommendation: "continue_branch",
    followUpRationale: "reflection test",
  };
}
