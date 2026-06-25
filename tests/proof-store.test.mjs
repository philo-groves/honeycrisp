import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchEventId,
  createSqliteMemoryEventLog,
  createSqliteProofStore,
} from "../packages/research-agent/dist/index.js";

test("sqlite proof store derives obligations and attempts from proof events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-proof-store-"));
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const proofStore = createSqliteProofStore({ workspaceRoot });
  const artifactRef = {
    id: "artifact_proof_log",
    kind: "log",
    uri: "file:///tmp/proof.log",
    summary: "Proof command output.",
  };
  const requested = eventLog.append(createEvent("proof.requested", {
    obligationId: "proof_obl_parser_order",
    question: "Does the parser normalize before expansion?",
    subject: {
      kind: "memory_record",
      id: "mem_finding_parser_order",
      summary: "Parser ordering finding.",
    },
    findingRecordIds: ["mem_finding_parser_order"],
    evidenceRefIds: ["parser_source"],
    acceptableMethods: [
      {
        kind: "artifact_validation",
        name: "Check parser proof artifact",
      },
    ],
  }));
  const observed = eventLog.append(createEvent("proof.observed", {
    attemptId: "proof_attempt_parser_order",
    obligationId: "proof_obl_parser_order",
    status: "completed",
    result: "pass",
    summary: "The proof artifact shows normalization before expansion.",
    method: {
      kind: "artifact_validation",
      name: "Inspect proof log",
      toolNames: ["file.read"],
    },
    evidenceRefIds: ["parser_source"],
    verifier: "fixture",
  }, {
    artifactRefs: [artifactRef],
  }));

  const [obligation] = proofStore.applyEvent(requested);
  const [attempt] = proofStore.applyEvent(observed);

  assert.equal(obligation.id, "proof_obl_parser_order");
  assert.equal(obligation.subject.kind, "memory_record");
  assert.deepEqual(obligation.findingRecordIds, ["mem_finding_parser_order"]);
  assert.equal(attempt.id, "proof_attempt_parser_order");
  assert.equal(attempt.result, "pass");
  assert.deepEqual(attempt.artifactRefs, [artifactRef]);
  assert.deepEqual(
    proofStore.listObligations({ findingRecordId: "mem_finding_parser_order" })
      .map((item) => item.id),
    ["proof_obl_parser_order"],
  );
  assert.deepEqual(
    proofStore.listAttempts({ obligationId: "proof_obl_parser_order" })
      .map((item) => item.id),
    ["proof_attempt_parser_order"],
  );
  assert.deepEqual(
    proofStore.listAttempts({ sourceEventId: observed.id }).map((item) => item.id),
    ["proof_attempt_parser_order"],
  );

  proofStore.close();
  const reloaded = createSqliteProofStore({ workspaceRoot });
  assert.equal(reloaded.readState().obligations.length, 1);
  assert.equal(reloaded.readState().attempts.length, 1);

  eventLog.close();
  reloaded.close();
});

test("sqlite proof store validates neutral proof vocabularies", async () => {
  const proofStore = createSqliteProofStore({
    workspaceRoot: await mkdtemp(join(tmpdir(), "honeycrisp-proof-validation-")),
  });

  assert.throws(
    () =>
      proofStore.writeAttempt({
        id: "proof_attempt_invalid_result",
        obligationId: "proof_obl_invalid_result",
        status: "completed",
        method: {
          kind: "human_review",
          name: "Human review",
        },
        summary: "Invalid result fixture.",
        result: "pwned",
        sourceEventIds: ["evt_invalid"],
        evidenceRefIds: [],
        artifactRefs: [],
        createdAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
      }),
    /Unsupported proof result/,
  );

  proofStore.close();
});

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: "2026-06-25T00:00:00.000Z",
    payload,
    ...options,
  };
}
