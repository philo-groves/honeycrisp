import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
  routeEventsToMemorySnapshot,
} from "../packages/research-agent/dist/index.js";

test("memory write pipeline converts tool observations into evidence-backed records", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const event = createEvent("tool.observed", {
    summary: "Read parser fixture with substitution examples.",
    toolName: "local.inspection",
  }, {
    goalId: "goal_pipeline",
    payloadHash: "hash_fixture",
  });

  const records = pipeline.derive(event);
  const record = records[0];

  assert.equal(records.length, 1);
  assert.equal(record.kind, "evidence");
  assert.equal(record.status, "confirmed");
  assert.equal(record.evidenceKind, "tool_observation");
  assert.equal(record.payloadRef.sourceEventId, event.id);
  assert.equal(record.payloadRef.payloadHash, "hash_fixture");
  assert.deepEqual(record.sourceEventIds, [event.id]);
  assert.deepEqual(record.evidenceRefIds, [`${event.id}:payload`]);
  assert.equal(record.provenance.derivation, "direct_evidence");
  assert.equal(record.provenance.evidenceFor[0]?.sourceEventId, event.id);
});

test("memory write pipeline stores model claims as candidate semantic claims", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const event = createEvent("model.claim", {
    claim: "The parser normalizes nested substitutions before expansion.",
    evidenceRefIds: ["evidence_parser_read"],
    evidenceAgainstRefIds: ["evidence_reachability_gap"],
    confidence: 0.42,
  });

  const records = pipeline.derive(event);
  const record = records[0];

  assert.equal(records.length, 1);
  assert.equal(record.kind, "semantic_claim");
  assert.equal(record.status, "candidate");
  assert.equal(record.claim, event.payload.claim);
  assert.equal(record.confidence, 0.42);
  assert.equal(record.provenance.derivation, "model_visible_inference");
  assert.deepEqual(
    record.provenance.evidenceFor.map((ref) => ref.id),
    ["evidence_parser_read"],
  );
  assert.deepEqual(
    record.provenance.evidenceAgainst.map((ref) => ref.id),
    ["evidence_reachability_gap"],
  );
});

test("memory write pipeline keeps hypothesis evidence-for and evidence-against separate", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const event = createEvent("model.hypothesis", {
    hypothesis: "Nested substitutions may expose a state-machine edge case.",
    evidenceRefIds: ["supporting_fixture"],
    weakens: ["negative_reachability_probe"],
    confidence: 0.35,
  });

  const [record] = pipeline.derive(event);

  assert.equal(record.kind, "hypothesis");
  assert.equal(record.status, "candidate");
  assert.equal(record.hypothesis, event.payload.hypothesis);
  assert.deepEqual(
    record.provenance.evidenceFor.map((ref) => ref.id),
    ["supporting_fixture"],
  );
  assert.deepEqual(
    record.provenance.evidenceAgainst.map((ref) => ref.id),
    ["negative_reachability_probe"],
  );
});

test("memory write pipeline creates episodic summaries for terminal goal transitions", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const completeEvent = createEvent("goal.updated", {
    statusBefore: "active",
    statusAfter: "complete",
    summary: "Goal active -> complete: all root gates were satisfied.",
  }, {
    goalId: "goal_complete",
  });
  const stoppedEvent = createEvent("goal.updated", {
    statusBefore: "active",
    statusAfter: "stopped",
    summary: "Goal active -> stopped: stop gate reached.",
  }, {
    goalId: "goal_stopped",
  });

  const [completeRecord] = pipeline.derive(completeEvent);
  const [stoppedRecord] = pipeline.derive(stoppedEvent);

  assert.equal(completeRecord.kind, "episodic");
  assert.equal(completeRecord.episodeKind, "goal_transition");
  assert.equal(completeRecord.status, "confirmed");
  assert.match(completeRecord.summary, /all root gates/);
  assert.equal(stoppedRecord.kind, "episodic");
  assert.equal(stoppedRecord.episodeKind, "goal_transition");
  assert.equal(stoppedRecord.status, "confirmed");
  assert.match(stoppedRecord.summary, /stop gate/);
});

test("memory write pipeline keeps procedures as candidates until promotion", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const event = createEvent("model.visible_note", {
    summary: "A useful review pattern was observed.",
    procedure: "When inspecting parser code, map normalization before expansion.",
    evidenceRefIds: ["evidence_review_loop"],
  });

  const records = pipeline.derive(event);
  const procedure = records.find((record) => record.kind === "procedure");
  const memory = routeEventsToMemorySnapshot([event]);

  assert.ok(procedure);
  assert.equal(procedure.status, "candidate");
  assert.deepEqual(procedure.guidance, {
    durability: "candidate",
    promotionRequired: "repeated_usefulness_or_explicit_promotion",
  });
  assert.equal(memory.candidateProcedures.length, 1);
  assert.equal(memory.candidateProcedures[0]?.recordKind, "procedure");
});

test("memory write pipeline converts user commitments into prospective checks", () => {
  const pipeline = createDeterministicMemoryWritePipeline();
  const event = createEvent("user.commitment", {
    commitment: "Do not use external search for this run.",
    trigger: "Before choosing any search action.",
  });

  const [record] = pipeline.derive(event);
  const memory = routeEventsToMemorySnapshot([event]);

  assert.equal(record.kind, "prospective_check");
  assert.equal(record.status, "confirmed");
  assert.equal(record.check, event.payload.commitment);
  assert.equal(record.trigger, event.payload.trigger);
  assert.deepEqual(memory.userCommitments, [event.payload.commitment]);
});

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: "2026-06-24T00:00:00.000Z",
    payload,
    ...options,
  };
}
