import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeterministicMemoryRetriever,
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
  createResearchGoalFrame,
  createSqliteMemoryRecordStore,
} from "../packages/research-agent/dist/index.js";

test("memory retriever ranks relevant direct evidence above stale weak evidence", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame(
    "Goal: Determine parser normalization order",
  );
  const staleEvent = createEvent("tool.observed", {
    summary: "Parser normalization order might involve expansion first.",
    confidence: 0.1,
  }, {
    timestamp: "2020-01-01T00:00:00.000Z",
    goalId: goalFrame.root.id,
  });
  const recentEvent = createEvent("tool.observed", {
    summary: "Parser normalization source confirms normalization before expansion.",
    confidence: 0.95,
  }, {
    timestamp: "2026-06-24T00:00:00.000Z",
    goalId: goalFrame.root.id,
  });
  const records = pipeline.deriveMany([staleEvent, recentEvent]);

  const result = retriever.retrieve({
    activeGoal: goalFrame.root,
    records,
    recentEvents: [recentEvent],
    openQuestions: ["What is the parser normalization order?"],
  });

  assert.equal(result.directEvidence[0]?.record.sourceEventIds[0], recentEvent.id);
  assert.ok(
    (result.directEvidence[0]?.score ?? 0) >
      (result.directEvidence[1]?.score ?? 0),
  );
  assert.ok(result.directEvidence[0]?.reasons.length);
});

test("memory retriever includes contradictions that affect active claims", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame(
    "Goal: Check parser branch reachability",
  );
  const [claim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "The parser branch is reachable.",
      evidenceRefIds: ["static_branch_reference"],
      evidenceAgainstRefIds: ["negative_fixture_run"],
      confidence: 0.45,
    }, {
      goalId: goalFrame.root.id,
    }),
  );

  const result = retriever.retrieve({
    activeGoal: goalFrame.root,
    records: [claim],
    openQuestions: ["Is the parser branch reachable?"],
  });

  assert.equal(result.contradictions.length, 1);
  assert.equal(result.contradictions[0]?.record.id, claim.id);
  assert.ok(
    result.contradictions[0]?.warnings.includes(
      "Record has evidence against it.",
    ),
  );
});

test("memory retriever ranks supported findings above weak hypotheses and omits rejected findings", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame("Goal: Review parser finding state");
  const [weakHypothesis] = pipeline.derive(
    createEvent("model.hypothesis", {
      hypothesis: "Parser normalization may happen before expansion.",
      confidence: 0.25,
      evidenceRefIds: ["parser_source"],
    }, {
      goalId: goalFrame.root.id,
    }),
  );
  const [supportedFinding] = pipeline.derive(
    createEvent("finding.proposed", {
      finding: "Parser normalization happens before expansion.",
      findingStatus: "supported",
      confidence: 0.8,
      evidenceRefIds: ["parser_source"],
    }, {
      goalId: goalFrame.root.id,
    }),
  );
  const [rejectedFinding] = pipeline.derive(
    createEvent("finding.proposed", {
      finding: "Rejected parser finding should stay out of recall.",
      findingStatus: "rejected",
      confidence: 0.8,
      evidenceRefIds: ["parser_source"],
    }, {
      goalId: goalFrame.root.id,
    }),
  );

  const result = retriever.retrieve({
    activeGoal: goalFrame.root,
    records: [weakHypothesis, supportedFinding, rejectedFinding],
    openQuestions: ["What parser finding state is supported?"],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.record.id, supportedFinding.id);
  assert.equal(result.candidates[0]?.record.id, supportedFinding.id);
  assert.ok(!result.candidates.some((candidate) => candidate.record.id === rejectedFinding.id));
  assert.ok(
    result.findings[0]?.reasons.some((reason) =>
      reason.includes("Finding status"),
    ),
  );
});

test("memory retriever returns procedures only for applicable action classes", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame("Goal: Inspect parser code");
  const records = pipeline.derive(
    createEvent("model.visible_note", {
      summary: "Parser inspection pattern.",
      procedure: "Map normalization before expansion.",
    }),
  );
  const procedure = records.find((record) => record.kind === "procedure");
  assert.ok(procedure);
  const inspectProcedure = {
    ...procedure,
    tags: [...procedure.tags, "action:inspect"],
  };

  const inspectResult = retriever.retrieve({
    activeGoal: goalFrame.root,
    actionClass: "inspect",
    records: [inspectProcedure],
  });
  const searchResult = retriever.retrieve({
    activeGoal: goalFrame.root,
    actionClass: "search",
    records: [inspectProcedure],
  });

  assert.equal(inspectResult.procedures.length, 1);
  assert.equal(searchResult.procedures.length, 0);
});

test("memory retriever surfaces prospective checks when trigger conditions are met", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame(
    "Goal: Decide whether search is allowed",
  );
  const [prospective] = pipeline.derive(
    createEvent("user.commitment", {
      commitment: "Do not use external search for this run.",
      trigger: "Before choosing any search action.",
    }),
  );

  const result = retriever.retrieve({
    activeGoal: goalFrame.root,
    actionClass: "search",
    records: [prospective],
    openQuestions: ["Can search be used?"],
  });

  assert.equal(result.prospectiveChecks.length, 1);
  assert.equal(result.prospectiveChecks[0]?.record.id, prospective.id);
  assert.ok(
    result.prospectiveChecks[0]?.reasons.some((reason) =>
      reason.includes("Prospective trigger"),
    ),
  );
});

test("memory retriever can score records from the sqlite record store with graph centrality", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-retriever-"));
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const goalFrame = createResearchGoalFrame("Goal: Analyze parser claims");
  const [claim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "Parser claim with graph links.",
      evidenceRefIds: ["supporting_evidence"],
    }, {
      goalId: goalFrame.root.id,
    }),
  );
  const [hypothesis] = pipeline.derive(
    createEvent("model.hypothesis", {
      hypothesis: "Parser hypothesis depending on claim.",
    }, {
      goalId: goalFrame.root.id,
    }),
  );

  store.writeMany([claim, hypothesis]);
  store.addClaimGraphEdge({
    sourceRecordId: hypothesis.id,
    targetRecordId: claim.id,
    relationship: "depends_on",
    createdAt: "2026-06-24T00:00:01.000Z",
  });

  const result = retriever.retrieve({
    activeGoal: goalFrame.root,
    recordStore: store,
  });

  assert.ok(result.candidates.some((candidate) => candidate.record.id === claim.id));
  assert.ok(
    result.candidates
      .find((candidate) => candidate.record.id === claim.id)
      ?.reasons.some((reason) => reason.includes("Claim graph centrality")),
  );

  store.close();
});

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: options.timestamp ?? "2026-06-24T00:00:00.000Z",
    payload,
    ...options,
  };
}
