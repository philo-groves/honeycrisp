import { createHash } from "node:crypto";
import type {
  CampaignContradictionSummary,
  CampaignCoverageGapSummary,
  CampaignGraphEdgeSummary,
  CampaignGraphNodeSummary,
  CampaignGraphSummary,
  FindingSummary,
  MemoryEdgeSummary,
  MemoryNodeSummary,
  ReportSummary,
  RunbookSummary,
} from "./knowledge-types.js";

const CONTRADICTION_RELATIONS = new Set(["contradicts", "refutes", "conflicts_with", "invalidates"]);
const SECURITY_RESEARCH_TYPES = new Set(["source", "sink", "flow-endpoint", "hypothesis", "primitive", "chain", "invariant", "trajectory"]);

export interface BuildCampaignGraphInput {
  nodes: readonly MemoryNodeSummary[];
  edges: readonly MemoryEdgeSummary[];
  findings: readonly FindingSummary[];
  runbooks: readonly RunbookSummary[];
  reports: readonly ReportSummary[];
  assetIds?: readonly string[];
}

export function buildCampaignGraph(input: BuildCampaignGraphInput): CampaignGraphSummary {
  const graphNodes: CampaignGraphNodeSummary[] = [];
  const graphEdges: CampaignGraphEdgeSummary[] = [];
  const memoryById = new Map(input.nodes.map((node) => [node.id, node]));
  const findingByMemory = new Map(input.findings.map((finding) => [finding.memoryNodeId, finding]));
  const runbookById = new Map(input.runbooks.map((runbook) => [runbook.id, runbook]));
  const reportById = new Map(input.reports.map((report) => [report.id, report]));
  const knownAssetIds = new Set([...(input.assetIds ?? []), ...input.nodes.flatMap((node) => node.assetIds)]);

  for (const assetId of [...knownAssetIds].sort()) {
    graphNodes.push({
      id: campaignNodeId("asset", assetId),
      kind: "asset",
      label: assetId,
      status: input.nodes.some((node) => node.assetIds.includes(assetId)) ? "covered" : "unexplored",
      memoryNodeId: null,
      findingId: null,
      assetId,
      evidenceCount: 0,
      updatedAt: latestTimestamp(input.nodes.filter((node) => node.assetIds.includes(assetId)).map((node) => node.updatedAt)),
    });
  }
  for (const node of input.nodes) {
    graphNodes.push({
      id: campaignNodeId("memory", node.id),
      kind: "memory",
      label: node.title,
      status: node.status,
      memoryNodeId: node.id,
      findingId: null,
      assetId: null,
      evidenceCount: node.evidenceRefs.length,
      updatedAt: node.updatedAt,
    });
    for (const assetId of node.assetIds) {
      graphEdges.push({
        fromId: campaignNodeId("asset", assetId),
        toId: campaignNodeId("memory", node.id),
        relation: "covered_by",
        contradictory: false,
      });
    }
  }
  for (const edge of input.edges) {
    graphEdges.push({
      fromId: campaignNodeId("memory", edge.fromId),
      toId: campaignNodeId("memory", edge.toId),
      relation: edge.relation,
      contradictory: contradictionRelation(edge.relation),
    });
  }
  for (const finding of input.findings) {
    graphNodes.push({
      id: campaignNodeId("finding", finding.id),
      kind: "finding",
      label: finding.title,
      status: finding.status,
      memoryNodeId: finding.memoryNodeId,
      findingId: finding.id,
      assetId: null,
      evidenceCount: finding.evidence.length,
      updatedAt: finding.updatedAt,
    });
    graphEdges.push({
      fromId: campaignNodeId("memory", finding.memoryNodeId),
      toId: campaignNodeId("finding", finding.id),
      relation: "candidate_finding",
      contradictory: false,
    });
    if (finding.reproductionRunbookId && runbookById.has(finding.reproductionRunbookId)) {
      graphEdges.push({
        fromId: campaignNodeId("finding", finding.id),
        toId: campaignNodeId("runbook", finding.reproductionRunbookId),
        relation: "reproduced_by",
        contradictory: false,
      });
    }
    if (finding.reportId && reportById.has(finding.reportId)) {
      graphEdges.push({
        fromId: campaignNodeId("finding", finding.id),
        toId: campaignNodeId("report", finding.reportId),
        relation: "reported_by",
        contradictory: false,
      });
    }
  }
  for (const runbook of input.runbooks) {
    graphNodes.push({
      id: campaignNodeId("runbook", runbook.id),
      kind: "runbook",
      label: runbook.title,
      status: runbook.status,
      memoryNodeId: null,
      findingId: null,
      assetId: null,
      evidenceCount: runbook.contentRevision + runbook.execution.completedRunCount,
      updatedAt: runbook.updatedAt,
    });
  }
  for (const report of input.reports) {
    graphNodes.push({
      id: campaignNodeId("report", report.id),
      kind: "report",
      label: report.title,
      status: report.status,
      memoryNodeId: null,
      findingId: null,
      assetId: null,
      evidenceCount: report.revisions.length + (report.submissionPacket ? 1 : 0),
      updatedAt: report.updatedAt,
    });
  }

  const contradictions = campaignContradictions(input.edges, memoryById);
  const coverageGaps = campaignCoverageGaps({ ...input, assetIds: [...knownAssetIds] }, findingByMemory, contradictions);
  const nextActions = [...coverageGaps]
    .sort((left, right) => gapRank(left.priority) - gapRank(right.priority) || left.title.localeCompare(right.title))
    .slice(0, 8);
  const momentum = campaignMomentum(input.findings, input.nodes, coverageGaps, contradictions);
  return {
    nodes: graphNodes.sort((left, right) => campaignKindRank(left.kind) - campaignKindRank(right.kind) || left.label.localeCompare(right.label)),
    edges: dedupeEdges(graphEdges),
    coverageGaps,
    contradictions,
    momentum,
    nextActions,
    counts: {
      findings: input.findings.length,
      verifiedFindings: input.findings.filter((finding) => ["verified", "report_ready", "disclosed"].includes(finding.status)).length,
      disclosedFindings: input.findings.filter((finding) => finding.status === "disclosed").length,
      coverageGaps: coverageGaps.length,
      contradictions: contradictions.length,
    },
  };
}

export function emptyCampaignGraph(): CampaignGraphSummary {
  return buildCampaignGraph({ nodes: [], edges: [], findings: [], runbooks: [], reports: [], assetIds: [] });
}

function campaignCoverageGaps(
  input: BuildCampaignGraphInput & { assetIds: readonly string[] },
  findingByMemory: ReadonlyMap<string, FindingSummary>,
  contradictions: readonly CampaignContradictionSummary[],
): CampaignCoverageGapSummary[] {
  const gaps: CampaignCoverageGapSummary[] = [];
  for (const assetId of input.assetIds) {
    if (input.nodes.some((node) => node.assetIds.includes(assetId))) continue;
    gaps.push(gap("unexplored_asset", "high", `Unexplored asset: ${assetId}`,
      "No durable research memory is associated with this authorized asset.",
      [campaignNodeId("asset", assetId)],
      `Map the attack surface of authorized asset ${assetId}. Search existing memory first, avoid repeating covered territory, and record evidence-backed boundaries, sources, sinks, or hypotheses.`));
  }
  for (const node of input.nodes) {
    if (SECURITY_RESEARCH_TYPES.has(node.type) && node.evidenceRefs.length === 0) {
      gaps.push(gap("unsupported_memory", node.type === "primitive" || node.type === "chain" ? "critical" : "medium",
        `Unsupported ${node.type}: ${node.title}`,
        "The durable claim has no direct evidence reference.",
        [campaignNodeId("memory", node.id)],
        `Validate or refute ${node.title}. Reuse existing research, collect direct evidence, and correct the durable memory rather than creating a duplicate.`));
    }
    if (node.type === "hypothesis" && !findingByMemory.has(node.id)) {
      gaps.push(gap("unobserved_hypothesis", "high", `Unobserved hypothesis: ${node.title}`,
        "This hypothesis has not entered the finding lifecycle.",
        [campaignNodeId("memory", node.id)],
        `Test the existing hypothesis ${node.title} with a discriminating experiment. If directly observed, create a finding linked to memory ${node.id}; otherwise record the refutation.`));
    }
  }
  for (const finding of input.findings) {
    const related = [campaignNodeId("finding", finding.id), campaignNodeId("memory", finding.memoryNodeId)];
    if (finding.status === "hypothesis") {
      gaps.push(gap("unobserved_hypothesis", "high", `Observe or refute: ${finding.title}`,
        "The candidate has not crossed the direct-observation evidence gate.", related,
        `Pursue finding ${finding.id} only far enough to collect direct observation evidence or reject it. Do not repeat already recorded orientation.`));
    } else if (finding.status === "observed") {
      gaps.push(gap("missing_reproduction", "critical", `Reproduce: ${finding.title}`,
        "The behavior was observed but has no successful reusable runbook proof.", related,
        `Create or complete a bounded runbook that reproduces finding ${finding.id} on a clean target state, execute it, and attach the successful run as evidence.`));
    } else if (finding.status === "reproduced") {
      gaps.push(gap("missing_independent_verification", "critical", `Independently verify: ${finding.title}`,
        "The reproduction has not been independently challenged outside its originating session.", related,
        `Independently verify finding ${finding.id} from its runbook and evidence. Challenge assumptions, preserve dissent, and attach independent verification evidence only if the result holds.`));
    } else if (finding.status === "verified") {
      gaps.push(gap("missing_report", "high", `Report: ${finding.title}`,
        "The verified finding has not been bound to a complete report artifact.", related,
        `Create a standalone report for verified finding ${finding.id}, cite its accepted evidence and reproduction runbook, then advance it to report-ready.`));
    } else if (finding.status === "stale") {
      gaps.push(gap("stale_finding", "critical", `Revalidate stale finding: ${finding.title}`,
        finding.staleReason ?? "The source revision or execution environment changed.", related,
        `Revalidate stale finding ${finding.id} against the current source revision and environment. Start from its prior evidence and runbook; do not repeat unrelated discovery.`));
    }
  }
  for (const contradiction of contradictions) {
    gaps.push(gap("contradiction", "critical", "Resolve contradictory research claims", contradiction.summary,
      [contradiction.fromNodeId, contradiction.toNodeId],
      `Resolve campaign contradiction ${contradiction.id} with a discriminating experiment. Preserve both claims until evidence identifies which is valid or whether their conditions differ.`));
  }
  return dedupeGaps(gaps).sort((left, right) => gapRank(left.priority) - gapRank(right.priority) || left.title.localeCompare(right.title));
}

function campaignContradictions(
  edges: readonly MemoryEdgeSummary[],
  memoryById: ReadonlyMap<string, MemoryNodeSummary>,
): CampaignContradictionSummary[] {
  return edges.filter((edge) => contradictionRelation(edge.relation)).map((edge) => {
    const from = memoryById.get(edge.fromId);
    const to = memoryById.get(edge.toId);
    return {
      id: `contradiction_${hash(`${edge.fromId}\0${edge.toId}\0${edge.relation}`)}`,
      fromNodeId: campaignNodeId("memory", edge.fromId),
      toNodeId: campaignNodeId("memory", edge.toId),
      relation: edge.relation,
      summary: edge.note || `${from?.title ?? edge.fromId} ${edge.relation} ${to?.title ?? edge.toId}.`,
    };
  });
}

function campaignMomentum(
  findings: readonly FindingSummary[],
  nodes: readonly MemoryNodeSummary[],
  gaps: readonly CampaignCoverageGapSummary[],
  contradictions: readonly CampaignContradictionSummary[],
): CampaignGraphSummary["momentum"] {
  if (nodes.length === 0 && findings.length === 0) return { state: "empty", reason: "No durable campaign state has been recorded.", supportingNodeIds: [] };
  if (contradictions.length > 0 || findings.some((finding) => finding.status === "stale")) {
    const supportingNodeIds = [
      ...contradictions.flatMap((item) => [item.fromNodeId, item.toNodeId]),
      ...findings.filter((finding) => finding.status === "stale").map((finding) => campaignNodeId("finding", finding.id)),
    ];
    return { state: "blocked", reason: "Contradictory or stale conclusions require resolution before advancing the campaign.", supportingNodeIds };
  }
  if (findings.length > 0 && gaps.length === 0
    && findings.every((finding) => finding.status === "disclosed" || finding.status === "rejected")) {
    return { state: "complete", reason: "Every recorded finding is disclosed or rejected.", supportingNodeIds: findings.map((finding) => campaignNodeId("finding", finding.id)) };
  }
  const active = findings.find((finding) => !["disclosed", "rejected"].includes(finding.status));
  if (active?.status === "report_ready" || active?.status === "verified") return { state: "reporting", reason: "A verified finding is moving through reporting and disclosure.", supportingNodeIds: [campaignNodeId("finding", active.id)] };
  if (active?.status === "reproduced") return { state: "verifying", reason: "A reproducible finding is awaiting independent verification.", supportingNodeIds: [campaignNodeId("finding", active.id)] };
  if (active?.status === "observed") return { state: "reproducing", reason: "An observed behavior needs a reusable clean-state reproduction.", supportingNodeIds: [campaignNodeId("finding", active.id)] };
  if (active?.status === "hypothesis") return { state: "observed", reason: "A candidate finding is awaiting direct observation or refutation.", supportingNodeIds: [campaignNodeId("finding", active.id)] };
  if (gaps.some((item) => item.kind === "unobserved_hypothesis")) return { state: "building", reason: "Existing hypotheses should be tested before opening overlapping exploration.", supportingNodeIds: gaps.flatMap((item) => item.relatedNodeIds).slice(0, 8) };
  return { state: "exploring", reason: "The campaign is expanding evidence-backed attack-surface coverage.", supportingNodeIds: nodes.slice(0, 8).map((node) => campaignNodeId("memory", node.id)) };
}

function gap(kind: CampaignCoverageGapSummary["kind"], priority: CampaignCoverageGapSummary["priority"], title: string, rationale: string, relatedNodeIds: string[], suggestedPrompt: string): CampaignCoverageGapSummary {
  return { id: `gap_${hash(`${kind}\0${relatedNodeIds.join("\0")}`)}`, kind, priority, title, rationale, relatedNodeIds, suggestedPrompt };
}
function dedupeEdges(edges: readonly CampaignGraphEdgeSummary[]): CampaignGraphEdgeSummary[] { const seen = new Set<string>(); return edges.filter((edge) => { const key = `${edge.fromId}\0${edge.toId}\0${edge.relation}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupeGaps(gaps: readonly CampaignCoverageGapSummary[]): CampaignCoverageGapSummary[] { return [...new Map(gaps.map((item) => [item.id, item])).values()]; }
function contradictionRelation(value: string): boolean { return CONTRADICTION_RELATIONS.has(value.trim().toLowerCase().replace(/[ -]+/gu, "_")); }
function campaignNodeId(kind: CampaignGraphNodeSummary["kind"], id: string): string { return `${kind}:${id}`; }
function campaignKindRank(kind: CampaignGraphNodeSummary["kind"]): number { return { asset: 0, memory: 1, finding: 2, runbook: 3, report: 4 }[kind]; }
function gapRank(priority: CampaignCoverageGapSummary["priority"]): number { return { critical: 0, high: 1, medium: 2, low: 3 }[priority]; }
function latestTimestamp(values: readonly string[]): string { return [...values].sort().at(-1) ?? new Date(0).toISOString(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 20); }
