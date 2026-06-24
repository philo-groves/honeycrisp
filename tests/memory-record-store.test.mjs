import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeterministicMemoryWritePipeline,
  createMemorySnapshotFromRecordStore,
  createResearchEventId,
  createSqliteMemoryRecordStore,
} from "../packages/research-agent/dist/index.js";

test("sqlite memory record store writes, reads, lists, and indexes derived records", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const observationEvent = createEvent("tool.observed", {
    summary: "Read parser source.",
    entities: ["Parser"],
  }, {
    goalId: "goal_records",
    subGoalId: "subgoal_records",
  });
  const claimEvent = createEvent("model.claim", {
    claim: "Parser normalization happens before expansion.",
    evidenceRefIds: ["evidence_parser_source"],
    entities: ["Parser"],
  }, {
    goalId: "goal_records",
  });
  const records = pipeline.deriveMany([observationEvent, claimEvent]);

  store.writeMany(records);

  const evidence = records.find((record) => record.kind === "evidence");
  const claim = records.find((record) => record.kind === "semantic_claim");
  assert.ok(evidence);
  assert.ok(claim);
  assert.deepEqual(store.getById(evidence.id), evidence);
  assert.deepEqual(
    store.list({ kind: "semantic_claim" }).map((record) => record.id),
    [claim.id],
  );
  assert.deepEqual(
    store.list({ goalId: "goal_records" }).map((record) => record.id).sort(),
    [claim.id, evidence.id].sort(),
  );
  assert.deepEqual(
    store.list({ subGoalId: "subgoal_records" }).map((record) => record.id),
    [evidence.id],
  );
  assert.deepEqual(
    store.list({ sourceEventId: observationEvent.id }).map((record) => record.id),
    [evidence.id],
  );
  assert.ok(store.list({ tag: "model-claim" }).some((record) => record.id === claim.id));
  assert.ok(store.list({ entity: "Parser" }).length >= 2);

  store.close();
});

test("sqlite memory record store stores claim graph evidence edges and explicit relationships", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const claimRecord = pipeline.derive(
    createEvent("model.claim", {
      claim: "A normalization claim.",
      evidenceRefIds: ["supporting_evidence"],
      evidenceAgainstRefIds: ["contradicting_evidence"],
    }),
  )[0];
  const hypothesisRecord = pipeline.derive(
    createEvent("model.hypothesis", {
      hypothesis: "A related hypothesis.",
      evidenceRefIds: ["supporting_hypothesis_evidence"],
    }),
  )[0];

  store.writeMany([claimRecord, hypothesisRecord]);
  const explicitEdge = store.addClaimGraphEdge({
    sourceRecordId: hypothesisRecord.id,
    targetRecordId: claimRecord.id,
    relationship: "depends_on",
    summary: "The hypothesis depends on the normalization claim.",
    createdAt: "2026-06-24T00:00:01.000Z",
  });
  const evidenceEdges = store.listClaimGraphEdges({
    sourceRecordId: claimRecord.id,
    includeEvidenceEdges: true,
  });

  assert.ok(
    evidenceEdges.some(
      (edge) =>
        edge.relationship === "supports" &&
        edge.evidenceRefId === "supporting_evidence",
    ),
  );
  assert.ok(
    evidenceEdges.some(
      (edge) =>
        edge.relationship === "contradicts" &&
        edge.evidenceRefId === "contradicting_evidence",
    ),
  );
  assert.deepEqual(
    store.listClaimGraphEdges({
      sourceRecordId: hypothesisRecord.id,
      relationship: "depends_on",
    }),
    [explicitEdge],
  );

  store.close();
});

test("sqlite memory record store contradiction updates preserve earlier evidence", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const [claim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "The parser branch is reachable.",
      evidenceRefIds: ["initial_support"],
    }),
  );

  store.write(claim);
  const updated = store.updateStatus({
    recordId: claim.id,
    status: "contradicted",
    updatedAt: "2026-06-24T00:00:01.000Z",
    evidenceAgainst: [
      {
        id: "negative_reachability_probe",
        relationship: "contradicts",
        summary: "The branch was not reached by the fixture.",
      },
    ],
  });

  assert.equal(updated.status, "contradicted");
  assert.deepEqual(
    updated.provenance.evidenceFor.map((ref) => ref.id),
    ["initial_support"],
  );
  assert.deepEqual(
    updated.provenance.evidenceAgainst.map((ref) => ref.id),
    ["negative_reachability_probe"],
  );
  assert.deepEqual(store.getById(claim.id), updated);

  store.close();
});

test("sqlite memory record store keeps superseded records auditable but out of ordinary lists", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const [oldClaim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "Old parser claim.",
      evidenceRefIds: ["old_support"],
    }),
  );
  const [newClaim] = pipeline.derive(
    createEvent("model.claim", {
      claim: "Refined parser claim.",
      evidenceRefIds: ["new_support"],
    }),
  );

  store.writeMany([oldClaim, newClaim]);
  const superseded = store.updateStatus({
    recordId: oldClaim.id,
    status: "superseded",
    updatedAt: "2026-06-24T00:00:01.000Z",
    supersededByRecordId: newClaim.id,
  });

  assert.equal(superseded.status, "superseded");
  assert.equal(store.list().some((record) => record.id === oldClaim.id), false);
  assert.equal(
    store.list({ includeAudited: true }).some((record) => record.id === oldClaim.id),
    true,
  );
  assert.equal(store.getById(oldClaim.id)?.status, "superseded");
  assert.ok(
    store
      .listClaimGraphEdges({
        sourceRecordId: newClaim.id,
        relationship: "supersedes",
      })
      .some((edge) => edge.targetRecordId === oldClaim.id),
  );

  store.close();
});

test("sqlite memory record store omits tombstoned records from context snapshots", async () => {
  const workspaceRoot = await createTempWorkspace();
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const pipeline = createDeterministicMemoryWritePipeline();
  const [evidence] = pipeline.derive(
    createEvent("tool.observed", {
      summary: "Evidence that should later be tombstoned.",
    }),
  );

  store.write(evidence);
  assert.equal(createMemorySnapshotFromRecordStore(store).directEvidence.length, 1);

  store.updateStatus({
    recordId: evidence.id,
    status: "tombstoned",
    updatedAt: "2026-06-24T00:00:01.000Z",
  });

  const memory = createMemorySnapshotFromRecordStore(store);

  assert.equal(memory.directEvidence.length, 0);
  assert.equal(store.getById(evidence.id)?.status, "tombstoned");

  store.close();
});

async function createTempWorkspace() {
  return mkdtemp(join(tmpdir(), "honeycrisp-memory-records-"));
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
