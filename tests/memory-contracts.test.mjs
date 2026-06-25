import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchMemoryProvenance,
  createSqliteMemoryRecordStore,
  isResearchFindingStatus,
  isResearchMemoryRecordKind,
  isResearchProofAttemptStatus,
  isResearchProofMethodKind,
  isResearchProofObligationStatus,
  isResearchProofResultStatus,
  isResearchProofSubjectKind,
  RESEARCH_FINDING_STATUSES,
  RESEARCH_MEMORY_RECORD_KINDS,
  RESEARCH_PROOF_ATTEMPT_STATUSES,
  RESEARCH_PROOF_METHOD_KINDS,
  RESEARCH_PROOF_OBLIGATION_STATUSES,
  RESEARCH_PROOF_RESULT_STATUSES,
  RESEARCH_PROOF_SUBJECT_KINDS,
} from "../packages/research-agent/dist/index.js";

test("memory contract allowlists include first-class findings", () => {
  assert.ok(RESEARCH_MEMORY_RECORD_KINDS.includes("finding"));
  assert.ok(isResearchMemoryRecordKind("finding"));
  assert.deepEqual(RESEARCH_FINDING_STATUSES, [
    "candidate",
    "needs_evidence",
    "supported",
    "verified",
    "superseded",
    "rejected",
    "out_of_scope",
    "tombstoned",
  ]);

  for (const status of RESEARCH_FINDING_STATUSES) {
    assert.equal(isResearchFindingStatus(status), true);
  }
  assert.equal(isResearchFindingStatus("exploitable"), false);
});

test("proof contract allowlists stay domain neutral and extensible", () => {
  assert.deepEqual(RESEARCH_PROOF_SUBJECT_KINDS, [
    "goal",
    "sub_goal",
    "memory_record",
    "artifact",
    "external",
  ]);
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("mathematical_proof"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("empirical_reproduction"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("static_analysis"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("dynamic_execution"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("artifact_validation"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("investigation_corroboration"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("domain_skill"));
  assert.ok(RESEARCH_PROOF_METHOD_KINDS.includes("mcp_provider"));
  assert.deepEqual(RESEARCH_PROOF_RESULT_STATUSES, [
    "pass",
    "fail",
    "inconclusive",
    "blocked",
    "superseded",
  ]);

  for (const kind of RESEARCH_PROOF_SUBJECT_KINDS) {
    assert.equal(isResearchProofSubjectKind(kind), true);
  }
  for (const kind of RESEARCH_PROOF_METHOD_KINDS) {
    assert.equal(isResearchProofMethodKind(kind), true);
  }
  for (const status of RESEARCH_PROOF_OBLIGATION_STATUSES) {
    assert.equal(isResearchProofObligationStatus(status), true);
  }
  for (const status of RESEARCH_PROOF_ATTEMPT_STATUSES) {
    assert.equal(isResearchProofAttemptStatus(status), true);
  }
  for (const status of RESEARCH_PROOF_RESULT_STATUSES) {
    assert.equal(isResearchProofResultStatus(status), true);
  }
  assert.equal(isResearchProofMethodKind("security_bounty_only"), false);
  assert.equal(isResearchProofResultStatus("pwned"), false);
});

test("sqlite memory record store accepts finding records while preserving older record kinds", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-contracts-"));
  const store = createSqliteMemoryRecordStore({ workspaceRoot });
  const finding = createFindingRecord();
  const evidence = createEvidenceRecord();

  store.writeMany([finding, evidence]);

  assert.equal(store.getById(finding.id)?.kind, "finding");
  assert.deepEqual(
    store.list({ kind: "finding" }).map((record) => record.id),
    [finding.id],
  );
  assert.deepEqual(
    store.list({ kind: "evidence" }).map((record) => record.id),
    [evidence.id],
  );

  store.close();
});

function createFindingRecord() {
  const eventId = "evt_contract_finding";

  return {
    id: "mem_contract_finding",
    kind: "finding",
    status: "candidate",
    summary: "A general research conclusion is ready for evidence-backed review.",
    sourceEventIds: [eventId],
    evidenceRefIds: ["evidence_contract_source"],
    provenance: createResearchMemoryProvenance({
      sourceEventIds: [eventId],
      derivation: "model_visible_inference",
      evidenceFor: [
        {
          id: "evidence_contract_source",
          relationship: "supports",
          sourceEventId: eventId,
        },
      ],
    }),
    confidence: 0.66,
    tags: ["finding-candidate"],
    entities: ["Honeycrisp"],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    finding: "A general finding can be represented without domain-specific fields.",
    findingStatus: "supported",
    linkedHypothesisRecordIds: ["mem_contract_hypothesis"],
    linkedClaimRecordIds: ["mem_contract_claim"],
    proofAttemptIds: ["proof_attempt_contract"],
    domainLabels: ["demo"],
    domainMetadata: {
      source: "contract-test",
    },
  };
}

function createEvidenceRecord() {
  const eventId = "evt_contract_evidence";

  return {
    id: "mem_contract_evidence",
    kind: "evidence",
    status: "confirmed",
    summary: "Older evidence records still serialize through the same store.",
    sourceEventIds: [eventId],
    evidenceRefIds: [`${eventId}:payload`],
    provenance: createResearchMemoryProvenance({
      sourceEventIds: [eventId],
      derivation: "direct_evidence",
      evidenceFor: [
        {
          id: `${eventId}:payload`,
          relationship: "supports",
          sourceEventId: eventId,
        },
      ],
    }),
    tags: ["contract-evidence"],
    entities: [],
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    evidenceKind: "tool_observation",
    payloadRef: {
      sourceEventId: eventId,
    },
  };
}
