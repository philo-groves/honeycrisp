import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FindingStore,
  MemoryGraphStore,
  ReportStore,
  RunbookStore,
  buildCampaignGraph,
  createResearchStorageLayout,
  ensureResearchStorageLayout,
} from "../packages/research-agent/dist/index.js";

const workspace = { workspaceId: "workspace_findings", workspaceName: "Findings", subjectId: "subject_findings", subjectName: "Findings" };

test("finding lifecycle is canonical, evidence-gated, independently verified, ordered, and revision-aware", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-findings-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const originGraph = new MemoryGraphStore({ workspaceRoot, context: { ...workspace, sessionId: "session_origin" } });
  const findings = new FindingStore(originGraph);
  const runbooks = new RunbookStore(originGraph.databasePath, layout, originGraph.getContext());
  let findingId;
  try {
    const memory = originGraph.save({
      type: "hypothesis",
      title: "Parser state crosses requests",
      summary: "A shared parser may retain attacker-controlled state.",
      assetIds: ["asset_parser"],
    });
    const created = findings.create({
      memoryNodeId: memory.id,
      sourceRevision: "source:one",
      environmentFingerprint: "environment:one",
    }, { provider: "openai", model: "gpt-5.6" }, "agent_origin");
    findingId = created.id;
    assert.deepEqual(created.authors, [{ provider: "openai", model: "gpt-5.6" }]);
    assert.equal(findings.create({ memoryNodeId: memory.id }).id, findingId);
    assert.throws(() => findings.transition(findingId, {
      expectedRevision: 1, toStatus: "observed", reason: "Claimed without a durable reference",
      evidence: [{ kind: "code", summary: "Parser assignment" }],
    }), /direct code, artifact, command, or URL evidence/);

    let finding = findings.transition(findingId, {
      expectedRevision: 1,
      toStatus: "observed",
      reason: "Directly observed in the parser implementation.",
      evidence: [{ kind: "code", referenceId: "src/parser.ts:42", contentHash: "sha256:code", summary: "State is retained on the error path." }],
    });
    const runbook = runbooks.create({
      title: "Reproduce parser state retention",
      purpose: "Replay the two-request sequence on a clean target.",
      cells: [{ kind: "code", language: "sh", source: "./reproduce.sh" }],
    }).runbook;
    const runId = "runbook_run_one";
    assert.throws(() => findings.transition(findingId, {
      expectedRevision: finding.revision, toStatus: "reproduced", reason: "Unbacked reproduction", reproductionRunbookId: runbook.id,
      evidence: [{ kind: "runbook_execution", referenceId: runId, summary: "Unverified claim", metadata: { status: "succeeded" } }],
    }), /successful runbook execution/);
    const startedAt = new Date().toISOString();
    runbooks.beginExecution(runbook.id, runId, runbooks.executionPlan(runbook.id).map((cell) => cell.id), "localhost");
    runbooks.completeExecution({
      id: runbook.id,
      runId,
      status: "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 1,
      proofTarget: "localhost",
    });
    finding = findings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "reproduced",
      reason: "The reusable runbook succeeded.",
      reproductionRunbookId: runbook.id,
      evidence: [{ kind: "runbook_execution", referenceId: runId, summary: "Clean-state execution succeeded." }],
    });
    assert.throws(() => findings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "verified",
      reason: "Origin agent self-verification",
      evidence: [{ kind: "independent_verification", referenceId: "review_origin", summary: "Same-session review.", independent: true }],
    }), /outside the originating session/);
  } finally {
    runbooks.close();
    findings.close();
    originGraph.close();
  }

  const verifierGraph = new MemoryGraphStore({ workspaceRoot, context: { ...workspace, sessionId: "session_verifier" } });
  const verifierFindings = new FindingStore(verifierGraph);
  const reports = new ReportStore(verifierGraph.databasePath, layout, verifierGraph.getContext());
  try {
    let finding = verifierFindings.get(findingId);
    finding = verifierFindings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "verified",
      reason: "A separate session reproduced the result and challenged the assumptions.",
      evidence: [{ kind: "independent_verification", referenceId: "verification_run_two", summary: "Independent replay held.", independent: true }],
    });
    const report = reports.create({ title: "Parser state retention", summary: "Verified cross-request state retention.", content: "# Parser state retention\n\nEvidence-backed report." }).report;
    assert.throws(() => verifierFindings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "report_ready",
      reason: "The evidence points at a different report.",
      reportId: report.id,
      evidence: [{ kind: "report", referenceId: "report_other", summary: "Mismatched report artifact." }],
    }), /report reference and report evidence/);
    finding = verifierFindings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "report_ready",
      reason: "A durable report now cites the accepted proof.",
      reportId: report.id,
      evidence: [{ kind: "report", referenceId: report.id, summary: "Complete report artifact." }],
    });
    finding = verifierFindings.transition(findingId, {
      expectedRevision: finding.revision,
      toStatus: "disclosed",
      reason: "Submitted to the authorized program.",
      disclosureReference: "program:submission:123",
      evidence: [{ kind: "disclosure", referenceId: "program:submission:123", summary: "Submission receipt." }],
    });
    assert.equal(finding.status, "disclosed");
    assert.deepEqual(finding.transitions.map((transition) => transition.revision), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(finding.transitions.map((transition) => transition.toStatus), ["hypothesis", "observed", "reproduced", "verified", "report_ready", "disclosed"]);
    const stale = verifierFindings.refreshStaleness("source:two", "environment:one")[0];
    assert.equal(stale.status, "stale");
    assert.equal(stale.staleFromStatus, "disclosed");
    assert.match(stale.staleReason, /differs from current revision/);
    assert.equal(stale.transitions.at(-1).revision, 7);
  } finally {
    reports.close();
    verifierFindings.close();
    verifierGraph.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("campaign graph exposes uncovered territory, lifecycle gates, contradictions, and typed momentum", () => {
  const now = new Date().toISOString();
  const nodes = [
    { id: "memory_hypothesis", sessionIds: [], workspaces: [{ id: "workspace_findings", name: "Findings" }], subjectId: "subject", subjectName: "Subject", type: "hypothesis", title: "Shared state", summary: "Candidate", body: "", status: "suspected", confidence: 0.5, assetIds: ["asset_one"], tags: [], attributes: {}, evidenceRefs: [], createdAt: now, updatedAt: now, revision: 1, authors: [] },
    { id: "memory_refutation", sessionIds: [], workspaces: [{ id: "workspace_findings", name: "Findings" }], subjectId: "subject", subjectName: "Subject", type: "invariant", title: "Cleanup always runs", summary: "Contradictory claim", body: "", status: "supported", confidence: 0.7, assetIds: ["asset_one"], tags: [], attributes: {}, evidenceRefs: [{ id: "evidence", kind: "code", pathBase: "repository", path: "src/parser.ts", locator: {}, summary: "finally block", createdAt: now }], createdAt: now, updatedAt: now, revision: 1, authors: [] },
  ];
  const campaign = buildCampaignGraph({
    nodes,
    edges: [{ fromId: "memory_hypothesis", toId: "memory_refutation", relation: "contradicts", note: null, createdAt: now, updatedAt: now }],
    findings: [], runbooks: [], reports: [], assetIds: ["asset_one", "asset_two"],
  });
  assert.ok(campaign.coverageGaps.some((gap) => gap.kind === "unexplored_asset"));
  assert.ok(campaign.coverageGaps.some((gap) => gap.kind === "unsupported_memory"));
  assert.ok(campaign.coverageGaps.some((gap) => gap.kind === "unobserved_hypothesis"));
  assert.equal(campaign.contradictions.length, 1);
  assert.equal(campaign.momentum.state, "blocked");
  assert.equal(campaign.nextActions[0].priority, "critical");

  const terminalFindingWithUnexploredAsset = buildCampaignGraph({
    nodes: [], edges: [], runbooks: [], reports: [], assetIds: ["asset_two"],
    findings: [{
      id: "finding_done", workspaceId: "workspace_findings", subjectId: "subject", memoryNodeId: "memory_done",
      originSessionId: "session", title: "Closed path", summary: "Rejected", impact: "", status: "rejected",
      staleFromStatus: null, confidence: 0.1, sourceRevision: null, environmentFingerprint: null,
      reproductionRunbookId: null, reportId: null, disclosureReference: null, staleReason: null,
      evidence: [], transitions: [], authors: [], createdAt: now, updatedAt: now, revision: 1,
    }],
  });
  assert.equal(terminalFindingWithUnexploredAsset.momentum.state, "exploring");
  assert.ok(terminalFindingWithUnexploredAsset.coverageGaps.some((gap) => gap.kind === "unexplored_asset"));
});
