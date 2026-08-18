import type { ResearchProfile } from "./research-profile.js";

export interface ResearchProfileSnapshot {
  id: string;
  workspaceId: string;
  profileId: string;
  profileVersion: string;
  profileHash: string;
  source: "bundled-default" | "workspace-default" | "explicit";
  sourcePath: string | null;
  profile: ResearchProfile;
  active: boolean;
  createdAt: string;
}

export interface MemoryDirectorySummary {
  name: "artifacts";
  path: string;
  purpose: string;
  exists: boolean;
  entryCount: number;
}

export interface MemoryEvidenceRefSummary {
  id: string;
  kind: string;
  pathBase: string | null;
  path: string | null;
  locator: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

export type MemoryNodeValidationKind = "full" | "scoped" | "inherited";

export interface MemoryNodeCatalogValidationSummary {
  nodeRevision: number;
  catalogHash: string;
  contentHash: string;
  kind: MemoryNodeValidationKind;
  validatedAt: string;
  researchProfile?: { hash: string; id: string; version: string };
}

export type MemoryNodeProvenanceSummary =
  | { state: "legacy_unrecorded"; catalogHash: null; activeCatalog: false; validation: null }
  | { state: "catalog_unvalidated"; catalogHash: string; activeCatalog: boolean; validation: null }
  | { state: "active_validated"; catalogHash: string; activeCatalog: true; validation: MemoryNodeCatalogValidationSummary }
  | { state: "foreign_validated"; catalogHash: string; activeCatalog: false; validation: MemoryNodeCatalogValidationSummary };

export interface MemoryNodeSummary {
  id: string;
  sessionIds: string[];
  workspaces: Array<{ id: string; name: string }>;
  subjectId: string;
  subjectName: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  status: string;
  confidence: number;
  assetIds: string[];
  tags: string[];
  attributes: Record<string, unknown>;
  evidenceRefs: MemoryEvidenceRefSummary[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  provenance?: MemoryNodeProvenanceSummary;
}

export interface MemoryEdgeSummary {
  fromId: string;
  toId: string;
  relation: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRevisionSummary {
  revision: number;
  sessionId: string | null;
  createdAt: string;
}

export interface RunbookSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string | null;
  subjectName: string | null;
  sessionId: string | null;
  title: string;
  purpose: string;
  status: "draft" | "active" | "completed" | "archived";
  artifactId: string;
  revision: number;
  revisions: ArtifactRevisionSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface ReportSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  subjectId: string | null;
  subjectName: string | null;
  sessionId: string | null;
  title: string;
  summary: string;
  status: "complete" | "stale";
  artifactId: string;
  submissionPacket: ReportSubmissionPacketSummary | null;
  revision: number;
  revisions: ArtifactRevisionSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface ReportSubmissionPacketSummary {
  artifactId: string;
  filename: string;
  sizeBytes: number;
  contentHash: string;
}

export type MemoryDreamingAction = "prune" | "merge_duplicates" | "revise" | "reclassify";

export interface MemoryDreamingChangeSummary {
  id: string;
  runId: string;
  action: MemoryDreamingAction;
  title: string;
  nodeType: string;
  hiddenNodeIds: string[];
  survivorNodeId: string | null;
  reason: string;
  createdAt: string;
  restoredAt: string | null;
  canRestore: boolean;
}

export interface MemoryDreamingRunSummary {
  id: string;
  status: "completed" | "restored" | "failed";
  model: string;
  reasoningEffort: string;
  inputNodeCount: number;
  inputSessionCount: number;
  prunedNodeCount: number;
  duplicateHiddenCount: number;
  duplicateGroupCount: number;
  reclassifiedNodeCount: number;
  editedNodeCount: number;
  createdAt: string;
  completedAt: string;
  restoredAt: string | null;
  errorMessage: string | null;
}

export interface MemoryDreamingSummary {
  available: boolean;
  scope: "workspace";
  hiddenNodeCount: number;
  restorableChangeCount: number;
  lastRun: MemoryDreamingRunSummary | null;
  changes: MemoryDreamingChangeSummary[];
}

export interface MemorySummary {
  status: "missing" | "empty" | "ready" | "error";
  source: "none" | "honeycrisp_sqlite";
  contextWorkspaceId: string;
  contextSubjectId: string;
  activeCatalogHash?: string | null;
  databasePath: string;
  storageRoot: string;
  artifactDirectoryPath: string;
  databaseSizeBytes: number;
  nodeCount: number;
  edgeCount: number;
  evidenceRefCount: number;
  storageArtifactCount: number;
  runbookCount: number;
  reportCount: number;
  latestNodeUpdatedAt: string | null;
  nodeTypeCounts: Record<string, number>;
  nodeStatusCounts: Record<string, number>;
  nodeProvenanceCounts?: Partial<Record<MemoryNodeProvenanceSummary["state"], number>>;
  nodes: MemoryNodeSummary[];
  edges: MemoryEdgeSummary[];
  runbooks: RunbookSummary[];
  reports: ReportSummary[];
  dreaming: MemoryDreamingSummary;
  directories: MemoryDirectorySummary[];
  lastError: string | null;
}

export interface RunbookOutput {
  kind: "stream" | "display" | "error";
  text: string;
  streamName: "stdout" | "stderr" | null;
  mimeType: string | null;
}

export interface RunbookExecutionSummary {
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "blocked" | "skipped";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  proofTarget: "localhost" | "device" | "vm" | "web" | "other";
  deviceOs: string | null;
}

export interface RunbookCell {
  id: string;
  type: "markdown" | "code" | "raw";
  source: string;
  language: string | null;
  executionCount: number | null;
  outputs: RunbookOutput[];
  latestRun: RunbookExecutionSummary | null;
}

export interface RunbookDocument {
  runbookId: string;
  nbformat: 4;
  nbformatMinor: number;
  language: string | null;
  revision: number | null;
  latestRun: RunbookExecutionSummary | null;
  cells: RunbookCell[];
}

export interface ReportDocument {
  reportId: string;
  content: string;
}
