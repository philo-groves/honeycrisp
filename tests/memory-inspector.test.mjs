import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileContextPacketV2,
  createDeterministicMemoryWritePipeline,
  createMemoryDrivenController,
  createMemoryInspector,
  createResearchEventId,
  createResearchGoalFrame,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
  createSqliteProofStore,
} from "../packages/research-agent/dist/index.js";

test("memory inspector exposes event timeline, event lookup, and derived records", async () => {
  const fixture = await createInspectorFixture();
  const { eventLog, recordStore, proofStore, inspector, events } = fixture;

  assert.deepEqual(
    inspector.eventTimeline().map((event) => event.id),
    events.map((event) => event.id),
  );
  assert.equal(inspector.showEventById(events[1].id)?.kind, "model.claim");
  assert.ok(
    inspector
      .showDerivedRecordsForEvent(events[1].id)
      .some((record) => record.kind === "semantic_claim"),
  );

  eventLog.close();
  recordStore.close();
  proofStore.close();
});

test("memory inspector exposes proof obligations and attempts", async () => {
  const { eventLog, recordStore, proofStore, inspector } =
    await createInspectorFixture();
  const obligation = inspector.showProofObligations()[0];
  const attempt = inspector.showProofAttempts()[0];

  assert.ok(obligation);
  assert.ok(attempt);
  assert.equal(inspector.showProofState().obligations.length, 1);
  assert.equal(inspector.showProofObligationById(obligation.id)?.id, obligation.id);
  assert.equal(inspector.showProofAttemptById(attempt.id)?.result, "pass");

  eventLog.close();
  recordStore.close();
  proofStore.close();
});

test("memory inspector exposes hypotheses, claim graph, and prospective checks", async () => {
  const { eventLog, recordStore, proofStore, inspector } =
    await createInspectorFixture();

  assert.ok(inspector.showHypotheses().some((record) => record.kind === "semantic_claim"));
  assert.ok(
    inspector
      .showClaimGraph()
      .some((edge) => edge.relationship === "supports"),
  );
  assert.ok(
    inspector
      .showProspectiveChecks()
      .some((record) => record.kind === "prospective_check"),
  );
  const finding = inspector.showFindings()[0];
  assert.ok(finding);
  assert.equal(finding.findingStatus, "supported");
  assert.equal(
    inspector.showFindingById(finding.id)?.finding.id,
    finding.id,
  );
  assert.deepEqual(
    inspector.showFindingById(finding.id)?.proofAttemptIds,
    ["proof_attempt_parser"],
  );

  eventLog.close();
  recordStore.close();
  proofStore.close();
});

test("memory inspector exposes recall results, context selections, and controller explanations", async () => {
  const { eventLog, recordStore, proofStore, inspector } =
    await createInspectorFixture();
  const goalFrame = createResearchGoalFrame(
    "Goal: Inspect parser memory\nScope constraints: local only",
  );
  const retrieval = inspector.runRecallQuery({
    activeGoal: goalFrame.root,
    openQuestions: ["What parser memory is available?"],
  });
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });
  const contextPacket = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: decision.subGoal,
    retrieval,
    tools: [],
  });

  assert.ok(inspector.showPreconsciousPacket(retrieval).candidateCount > 0);
  assert.ok(
    inspector
      .showCompiledContextPacket(contextPacket)
      .sections.some((section) => section.selectionReasons.length > 0),
  );
  assert.equal(
    inspector.explainSelectedAction(decision).actionClass,
    decision.actionClass,
  );

  eventLog.close();
  recordStore.close();
  proofStore.close();
});

test("memory inspector debug capture includes accepted, rejected, candidate, committed, retrieval, context, and decision data", async () => {
  const { eventLog, recordStore, proofStore, inspector, records } =
    await createInspectorFixture();
  const goalFrame = createResearchGoalFrame(
    "Goal: Capture inspectability debug output\nScope constraints: local only",
  );
  const retrieval = inspector.runRecallQuery({
    activeGoal: goalFrame.root,
    openQuestions: ["What should the debug output show?"],
  });
  const decision = createMemoryDrivenController().decide({
    goalFrame,
    retrieval,
  });
  const contextPacket = compileContextPacketV2({
    goalFrame,
    activeGoal: goalFrame.root,
    activeSubGoal: decision.subGoal,
    retrieval,
    tools: [],
  });
  const capture = inspector.captureDebug({
    rejectedEvents: [
      {
        event: { kind: "model.private_thought" },
        reason: "private thought-like event rejected",
      },
    ],
    candidateWrites: records,
    retrieval,
    contextPacketV2: contextPacket,
    decision,
  });

  assert.ok(capture.acceptedEvents.length > 0);
  assert.equal(capture.rejectedEvents[0]?.reason, "private thought-like event rejected");
  assert.ok(capture.candidateWrites.length > 0);
  assert.ok(capture.committedWrites.length > 0);
  assert.ok(capture.retrievalResults?.candidateCount);
  assert.ok(capture.contextSelections?.sections.length);
  assert.equal(capture.controllerDecision?.actionClass, decision.actionClass);

  eventLog.close();
  recordStore.close();
  proofStore.close();
});

async function createInspectorFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-inspector-"));
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const recordStore = createSqliteMemoryRecordStore({ workspaceRoot });
  const proofStore = createSqliteProofStore({ workspaceRoot });
  const events = [
    createEvent("tool.observed", {
      summary: "Parser source was inspected.",
      confidence: 0.95,
    }),
    createEvent("model.claim", {
      claim: "Parser normalization happens before expansion.",
      evidenceRefIds: ["parser_source"],
    }),
    createEvent("finding.proposed", {
      finding: "Parser normalization before expansion is supported.",
      findingStatus: "supported",
      evidenceRefIds: ["parser_source"],
      linkedClaimRecordIds: ["mem_claim_parser"],
      proofAttemptIds: ["proof_attempt_parser"],
    }),
    createEvent("user.commitment", {
      commitment: "Keep parser inspection local.",
      trigger: "Before any search action.",
    }),
  ];
  const proofEvents = [
    createEvent("proof.requested", {
      obligationId: "proof_obl_inspector",
      question: "Can the parser finding be reproduced?",
      subject: {
        kind: "memory_record",
        id: "mem_claim_parser",
      },
      findingRecordIds: ["mem_claim_parser"],
      evidenceRefIds: ["parser_source"],
      acceptableMethods: [
        {
          kind: "empirical_reproduction",
          name: "Run parser fixture",
        },
      ],
    }),
    createEvent("proof.observed", {
      attemptId: "proof_attempt_inspector",
      obligationId: "proof_obl_inspector",
      status: "completed",
      result: "pass",
      summary: "Parser fixture reproduced the claim.",
      method: {
        kind: "empirical_reproduction",
        name: "Run parser fixture",
      },
      evidenceRefIds: ["parser_source"],
    }),
  ];
  const acceptedEvents = eventLog.appendMany(events);
  const acceptedProofEvents = eventLog.appendMany(proofEvents);
  const records = createDeterministicMemoryWritePipeline().deriveMany(acceptedEvents);
  recordStore.writeMany(records);
  for (const event of acceptedProofEvents) {
    proofStore.applyEvent(event);
  }
  const inspector = createMemoryInspector({ eventLog, recordStore, proofStore });

  return {
    eventLog,
    recordStore,
    proofStore,
    inspector,
    events: [...acceptedEvents, ...acceptedProofEvents],
    records,
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
