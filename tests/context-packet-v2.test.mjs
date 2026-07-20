import assert from "node:assert/strict";
import test from "node:test";

import {
  compileContextPacketV2,
  createDeterministicMemoryRetriever,
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
} from "../packages/research-agent/dist/index.js";

test("context packet v2 respects section token budgets", () => {
  const { retrieval } = createRetrievalFixture([
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

test("context packet v2 prunes lowest-ranked items when the total packet exceeds budget", () => {
  const { retrieval } = createRetrievalFixture([
    createEvent("tool.observed", {
      summary: [
        "Parser normalization source evidence confirms parser normalization behavior.",
        "Normalization happens before expansion and is directly relevant to the active parser goal.",
        "This high-confidence observation should survive whole-packet context pruning.",
      ].join(" "),
      confidence: 0.99,
    }),
    createEvent("tool.observed", {
      summary: [
        "Parser normalization side note mentions parser setup but contains less direct evidence.",
        "It is useful only if the context packet has spare room after stronger evidence.",
      ].join(" "),
      confidence: 0.45,
    }),
    createEvent("tool.observed", {
      summary: [
        "Unrelated operational note with weak parser relevance and low confidence.",
        "This should be the first selected item removed when whole-packet budget is tight.",
      ].join(" "),
      confidence: 0.1,
    }),
  ]);
  const rankedEvidenceIds = retrieval.directEvidence.map(
    (candidate) => candidate.record.id,
  );

  assert.ok(rankedEvidenceIds.length >= 3);

  const packet = compileContextPacketV2({
    retrieval,
    tools: [],
    contextTokenBudget: 70,
    sectionTokenBudgets: {
      direct_evidence: 160,
    },
  });
  const selectedIds = packet.sections.flatMap((section) =>
    section.items.map((item) => item.recordId),
  );
  const lowestRankedEvidenceId = rankedEvidenceIds.at(-1);
  const highestRankedEvidenceId = rankedEvidenceIds[0];

  assert.equal(packet.compaction.reason, "context_token_budget_exceeded");
  assert.ok(packet.estimatedTokens <= packet.tokenBudget);
  assert.ok(highestRankedEvidenceId);
  assert.ok(lowestRankedEvidenceId);
  assert.ok(selectedIds.includes(highestRankedEvidenceId));
  assert.ok(!selectedIds.includes(lowestRankedEvidenceId));
  assert.ok(packet.compaction.removedRecordIds.includes(lowestRankedEvidenceId));
});

test("context packet v2 keeps evidence and inference labels separate", () => {
  const { retrieval } = createRetrievalFixture([
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
    createEvent("finding.proposed", {
      finding: "Normalization before expansion is supported.",
      findingStatus: "supported",
      evidenceRefIds: ["source_inspection"],
    }),
  ]);

  const packet = compileContextPacketV2({
    retrieval,
    tools: [],
  });
  const directEvidence = packet.sections.find(
    (section) => section.label === "direct_evidence",
  );
  const currentHypotheses = packet.sections.find(
    (section) => section.label === "current_hypotheses",
  );
  const currentFindings = packet.sections.find(
    (section) => section.label === "current_findings",
  );

  assert.equal(directEvidence?.items[0]?.label, "direct_evidence");
  assert.ok(
    currentHypotheses?.items.some((item) => item.label === "inference"),
  );
  assert.ok(
    currentHypotheses?.items.some((item) => item.label === "hypothesis"),
  );
  assert.ok(
    !currentHypotheses?.items.some((item) => item.label === "finding"),
  );
  assert.ok(
    currentFindings?.items.some((item) => item.label === "finding"),
  );
});

test("context packet v2 keeps relevant contradictions within bounded context", () => {
  const { retrieval } = createRetrievalFixture([
    createEvent("model.claim", {
      claim: "The parser branch is reachable.",
      evidenceRefIds: ["static_reference"],
      evidenceAgainstRefIds: ["negative_fixture_run"],
      confidence: 0.4,
    }),
  ]);

  const packet = compileContextPacketV2({
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

test("context packet v2 includes proof obligations and attempts separately", () => {
  const { retrieval } = createRetrievalFixture([
    createEvent("finding.proposed", {
      finding: "Parser ordering finding.",
      findingStatus: "supported",
      evidenceRefIds: ["parser_source"],
    }),
  ]);

  const packet = compileContextPacketV2({
    retrieval,
    proofState: {
      obligations: [
        {
          id: "proof_obl_context_fixture",
          status: "open",
          subject: {
            kind: "memory_record",
            id: "mem_finding_context_fixture",
          },
          question: "Is the parser ordering finding reproducible?",
          acceptableMethods: [
            {
              kind: "empirical_reproduction",
              name: "Run parser fixture",
            },
          ],
          findingRecordIds: ["mem_finding_context_fixture"],
          hypothesisRecordIds: [],
          claimRecordIds: [],
          evidenceRefIds: ["parser_source"],
          artifactRefs: [],
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
      ],
      attempts: [
        {
          id: "proof_attempt_context_fixture",
          obligationId: "proof_obl_context_fixture",
          status: "completed",
          result: "pass",
          method: {
            kind: "empirical_reproduction",
            name: "Run parser fixture",
          },
          summary: "Parser fixture reproduced the ordering finding.",
          sourceEventIds: ["evt_context_proof"],
          evidenceRefIds: ["parser_source"],
          artifactRefs: [],
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
      ],
    },
  tools: [],
  });
  const proofState = packet.sections.find(
    (section) => section.label === "proof_state",
  );

  assert.ok(proofState);
  assert.ok(
    proofState.items.some((item) => item.label === "proof_obligation"),
  );
  assert.ok(proofState.items.some((item) => item.label === "proof_attempt"));
});

function createRetrievalFixture(events) {
  const pipeline = createDeterministicMemoryWritePipeline();
  const retriever = createDeterministicMemoryRetriever();
  const records = pipeline.deriveMany(events);
  const retrieval = retriever.retrieve({
    query: "Review parser normalization behavior",
    records,
    openQuestions: ["What evidence explains parser normalization behavior?"],
    recentEvents: events,
  });

  return { retrieval };
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
