import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createDeterministicMemoryRetriever,
  createDeterministicMemoryWritePipeline,
  createMemorySnapshotFromRecordStore,
  createResearchEventId,
  createSqliteMemoryEventLog,
  createResearchGoalFrame,
  createSqliteMemoryRecordStore,
  deleteFindingUnderPolicy,
  deleteMemoryRecordUnderPolicy,
  expireMemoryRecord,
  promoteFinding,
  rejectFinding,
  supersedeMemoryRecord,
  supersedeFinding,
  tombstoneFinding,
  tombstoneMemoryArtifact,
  tombstoneMemoryRecord,
} from "../packages/research-agent/dist/index.js";

test("memory lifecycle tombstones records and audits the operation", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const [evidence] = createRecords([
    createEvent("tool.observed", {
      summary: "Evidence to tombstone.",
    }),
  ]);
  store.write(evidence);

  tombstoneMemoryRecord({
    store,
    recordId: evidence.id,
    timestamp: "2026-06-24T00:00:01.000Z",
    summary: "Tombstoned by lifecycle test.",
  });

  assert.equal(createMemorySnapshotFromRecordStore(store).directEvidence.length, 0);
  assert.equal(store.getById(evidence.id)?.status, "tombstoned");
  assert.ok(
    store
      .listAuditRecords({ recordId: evidence.id, operation: "tombstone" })
      .some((audit) => audit.summary.includes("tombstoned")),
  );

  store.close();
});

test("memory lifecycle keeps superseded records reachable through audit views", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const [oldClaim, newClaim] = createRecords([
    createEvent("model.claim", {
      claim: "Old claim.",
    }),
    createEvent("model.claim", {
      claim: "New claim.",
    }),
  ]);
  store.writeMany([oldClaim, newClaim]);

  supersedeMemoryRecord({
    store,
    recordId: oldClaim.id,
    supersededByRecordId: newClaim.id,
    timestamp: "2026-06-24T00:00:01.000Z",
  });

  assert.equal(store.list().some((record) => record.id === oldClaim.id), false);
  assert.equal(
    store.list({ includeAudited: true }).some((record) => record.id === oldClaim.id),
    true,
  );
  assert.equal(store.getById(oldClaim.id)?.status, "superseded");
  assert.ok(
    store
      .listAuditRecords({ recordId: oldClaim.id, operation: "supersede" })
      .some((audit) => audit.relatedRecordId === newClaim.id),
  );

  store.close();
});

test("memory lifecycle expires records out of ordinary retrieval", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const goalFrame = createResearchGoalFrame("Goal: Retrieve fresh records");
  const [evidence] = createRecords([
    createEvent("tool.observed", {
      summary: "Fresh evidence before expiration.",
    }, {
      goalId: goalFrame.root.id,
    }),
  ]);
  store.write(evidence);

  expireMemoryRecord({
    store,
    recordId: evidence.id,
    timestamp: "2026-06-24T00:00:01.000Z",
  });

  const retrieval = createDeterministicMemoryRetriever().retrieve({
    activeGoal: goalFrame.root,
    recordStore: store,
  });

  assert.equal(retrieval.candidates.some((candidate) => candidate.record.id === evidence.id), false);
  assert.equal(store.getById(evidence.id)?.status, "stale");
  assert.ok(store.listAuditRecords({ recordId: evidence.id, operation: "expire" }).length > 0);

  store.close();
});

test("memory lifecycle policy deletion removes records but preserves audit facts", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const [claim] = createRecords([
    createEvent("model.claim", {
      claim: "Delete me under policy.",
    }),
  ]);
  store.write(claim);

  deleteMemoryRecordUnderPolicy({
    store,
    recordId: claim.id,
    policy: "test-policy",
    timestamp: "2026-06-24T00:00:01.000Z",
  });

  assert.equal(store.getById(claim.id), undefined);
  assert.deepEqual(
    store.listAuditRecords({ recordId: claim.id, operation: "deletion" }).map(
      (audit) => audit.policy,
    ),
    ["test-policy"],
  );

  store.close();
});

test("memory lifecycle tombstones artifact refs and can clean up local files", async () => {
  const workspaceRoot = await createTempWorkspace();
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const artifactPath = join(workspaceRoot, "artifact.json");
  await writeFile(artifactPath, "{\"raw\":true}\n", "utf8");
  const artifactRef = {
    id: "artifact_lifecycle_fixture",
    kind: "tool_raw_output",
    uri: pathToFileURL(artifactPath).href,
    summary: "Lifecycle fixture artifact.",
    contentHash: "sha256:fixture",
  };

  const event = tombstoneMemoryArtifact({
    eventLog,
    artifactRef,
    timestamp: "2026-06-24T00:00:01.000Z",
    policy: "test-artifact-retention",
    deleteFile: true,
  });

  assert.equal(existsSync(artifactPath), false);
  assert.equal(event.kind, "artifact.tombstoned");
  assert.equal(event.payload.artifactRefId, artifactRef.id);
  assert.equal(event.payload.deletedFile, true);
  assert.deepEqual(event.artifactRefs, [artifactRef]);
  assert.equal(eventLog.listByKind("artifact.tombstoned").length, 1);

  eventLog.close();
});

test("memory lifecycle audits writes, promotions, and contradictions", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const records = createRecords([
    createEvent("model.visible_note", {
      summary: "Procedure candidate.",
      procedure: "Inspect parser normalization first.",
    }),
    createEvent("model.claim", {
      claim: "Contradictable claim.",
      evidenceRefIds: ["support"],
    }),
  ]);
  const procedure = records.find((record) => record.kind === "procedure");
  const claim = records.find((record) => record.kind === "semantic_claim");
  assert.ok(procedure);
  assert.ok(claim);
  const promotedProcedure = {
    ...procedure,
    status: "confirmed",
    guidance: {
      durability: "durable",
      promotionReason: "explicit_promotion",
      promotedByEventId: procedure.sourceEventIds[0],
    },
  };

  store.writeMany([promotedProcedure, claim]);
  store.updateStatus({
    recordId: claim.id,
    status: "contradicted",
    updatedAt: "2026-06-24T00:00:01.000Z",
    evidenceAgainst: [
      {
        id: "against",
        relationship: "contradicts",
      },
    ],
  });

  assert.ok(store.listAuditRecords({ recordId: claim.id, operation: "write" }).length > 0);
  assert.ok(
    store.listAuditRecords({ recordId: promotedProcedure.id, operation: "promotion" }).length > 0,
  );
  assert.ok(
    store.listAuditRecords({ recordId: claim.id, operation: "contradiction" }).length > 0,
  );

  store.close();
});

test("memory lifecycle promotes, rejects, supersedes, tombstones, and deletes findings", async () => {
  const store = createSqliteMemoryRecordStore({
    workspaceRoot: await createTempWorkspace(),
  });
  const [candidateFinding, replacementFinding, rejectedFinding, deletedFinding] =
    createRecords([
      createEvent("finding.proposed", {
        finding: "Candidate parser finding.",
        findingStatus: "candidate",
        evidenceRefIds: ["candidate_support"],
      }),
      createEvent("finding.proposed", {
        finding: "Replacement parser finding.",
        findingStatus: "supported",
        evidenceRefIds: ["replacement_support"],
      }),
      createEvent("finding.proposed", {
        finding: "Rejectable parser finding.",
        findingStatus: "candidate",
        evidenceRefIds: ["reject_support"],
      }),
      createEvent("finding.proposed", {
        finding: "Deletable parser finding.",
        findingStatus: "candidate",
      }),
    ]);
  store.writeMany([
    candidateFinding,
    replacementFinding,
    rejectedFinding,
    deletedFinding,
  ]);

  const promoted = promoteFinding({
    store,
    recordId: candidateFinding.id,
    findingStatus: "verified",
    timestamp: "2026-06-24T00:00:01.000Z",
    evidenceFor: [
      {
        id: "verification_support",
        relationship: "supports",
      },
    ],
  });
  const rejected = rejectFinding({
    store,
    recordId: rejectedFinding.id,
    timestamp: "2026-06-24T00:00:02.000Z",
    evidenceAgainst: [
      {
        id: "negative_review",
        relationship: "contradicts",
      },
    ],
  });
  const superseded = supersedeFinding({
    store,
    recordId: promoted.id,
    supersededByRecordId: replacementFinding.id,
    timestamp: "2026-06-24T00:00:03.000Z",
  });
  const tombstoned = tombstoneFinding({
    store,
    recordId: replacementFinding.id,
    timestamp: "2026-06-24T00:00:04.000Z",
  });
  deleteFindingUnderPolicy({
    store,
    recordId: deletedFinding.id,
    policy: "finding-retention-test",
    timestamp: "2026-06-24T00:00:05.000Z",
  });

  assert.equal(promoted.findingStatus, "verified");
  assert.equal(promoted.status, "confirmed");
  assert.ok(
    promoted.provenance.evidenceFor.some(
      (ref) => ref.id === "verification_support",
    ),
  );
  assert.equal(rejected.findingStatus, "rejected");
  assert.equal(rejected.status, "contradicted");
  assert.equal(superseded.findingStatus, "superseded");
  assert.equal(superseded.status, "superseded");
  assert.equal(tombstoned.findingStatus, "tombstoned");
  assert.equal(tombstoned.status, "tombstoned");
  assert.equal(store.getById(deletedFinding.id), undefined);
  assert.equal(
    store.list({ includeAudited: true }).some((record) => record.id === promoted.id),
    true,
  );
  assert.equal(
    createMemorySnapshotFromRecordStore(store).currentFindings.length,
    0,
  );
  assert.ok(
    store
      .listAuditRecords({ recordId: deletedFinding.id, operation: "deletion" })
      .some((audit) => audit.policy === "finding-retention-test"),
  );

  store.close();
});

async function createTempWorkspace() {
  return mkdtemp(join(tmpdir(), "honeycrisp-lifecycle-"));
}

function createRecords(events) {
  return createDeterministicMemoryWritePipeline().deriveMany(events);
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
