import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  MemoryGraphStore,
  ReportStore,
  RunbookStore,
  buildMemoryDreamingInstructions,
  createResearchStorageLayout,
  ensureResearchStorageLayout,
  getHoneycrispMemorySummary,
  getKnowledgeReport,
  getKnowledgeRunbook,
  normalizeResearchProfile,
  parseMemoryDreamingPlanOutput,
  researchProfileHash,
  resolveKnowledgeArtifact,
  restoreMemoryDreamingChange,
  runMemoryDreaming,
} from "../packages/research-agent/dist/index.js";

test("Honeycrisp owns memory summaries, documents, artifact resolution, and Dreaming state", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-knowledge-boundary-"));
  const databasePath = join(root, "memory.sqlite");
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({
    workspaceRoot: root,
    databasePath,
    artifactDirectoryPath: join(root, "artifacts"),
  }));
  const context = {
    sessionId: "session_one",
    workspaceId: "workspace_one",
    workspaceName: "One",
    subjectId: "subject_one",
    subjectName: "One subject",
  };
  const profile = normalizeResearchProfile(DEFAULT_SECURITY_RESEARCH_PROFILE);
  const profileHash = researchProfileHash(profile);
  const profileInput = {
    profileSnapshot: {
      id: "profile_snapshot_one",
      workspaceId: context.workspaceId,
      profileId: profile.id,
      profileVersion: profile.version,
      profileHash,
      source: "bundled-default",
      sourcePath: null,
      profile,
      active: true,
      createdAt: new Date().toISOString(),
    },
  };
  const memory = new MemoryGraphStore({ databasePath, context });
  const runbooks = new RunbookStore(databasePath, layout, context);
  const reports = new ReportStore(databasePath, layout, context);
  try {
    memory.save({ type: "hypothesis", title: "Shared parser state", summary: "State may cross requests." });
    const runbook = runbooks.create({
      title: "Parser proof",
      purpose: "Preserve the bounded reproduction.",
      cells: [{ kind: "code", language: "sh", source: "./proof.sh", stdout: "confirmed\n" }],
    }).runbook;
    const report = reports.create({
      title: "Parser result",
      summary: "The confirmed result.",
      content: "# Parser result\n\nConfirmed.",
    }).report;

    const summary = getHoneycrispMemorySummary({
      databasePath,
      artifactDirectoryPath: layout.artifactDirectoryPath,
      workspaceId: context.workspaceId,
      subjectId: context.subjectId,
      researchProfile: profileInput.profileSnapshot,
    });
    assert.equal(summary.nodeCount, 1);
    assert.equal(summary.runbookCount, 1);
    assert.equal(summary.reportCount, 1);
    assert.equal(getKnowledgeRunbook(databasePath, layout.artifactDirectoryPath, context.workspaceId, runbook.id).nbformat, 4);
    assert.match(getKnowledgeReport(databasePath, layout.artifactDirectoryPath, context.workspaceId, report.id).content, /Confirmed/);
    assert.equal(resolveKnowledgeArtifact(runbook.artifactId, {
      databasePath,
      artifactDirectoryPath: layout.artifactDirectoryPath,
      expectedKind: "runbook",
    }).kind, "runbook");

    const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));
    const runbookInputPath = join(root, "runbook-input.json");
    await writeFile(runbookInputPath, JSON.stringify({ workspaceId: context.workspaceId, runbookId: runbook.id }));
    const cliResult = spawnSync(process.execPath, [cliPath, "knowledge", "runbook-get", "--input", runbookInputPath, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HONEYCRISP_DATABASE_PATH: databasePath,
        HONEYCRISP_ARTIFACT_DIRECTORY: layout.artifactDirectoryPath,
      },
    });
    assert.equal(cliResult.status, 0, `${cliResult.stderr}\n${cliResult.stdout}`);
    const envelope = JSON.parse(cliResult.stdout);
    assert.equal(envelope.protocolVersion, 1);
    assert.equal(envelope.operation, "runbook.get");
    assert.equal(envelope.result.runbookId, runbook.id);

    const instructions = buildMemoryDreamingInstructions({}, profileInput);
    assert.match(instructions, /strict JSON/i);
    const plan = parseMemoryDreamingPlanOutput("```json\n{\"prune\":[],\"merge\":[],\"revise\":[],\"reclassify\":[]}\n```", profileInput);
    const dreamed = runMemoryDreaming(databasePath, context.workspaceId, plan, {
      provider: "openai",
      model: "test-model",
      reasoningEffort: "high",
      inputNodeCount: 1,
      inputSessionCount: 1,
    }, profileInput);
    assert.equal(dreamed.status, "completed");
    assert.equal(dreamed.editedNodeCount, 0);
    assert.throws(() => restoreMemoryDreamingChange(databasePath, context.workspaceId, "missing"), /not found/);
  } finally {
    reports.close();
    runbooks.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  }
});
