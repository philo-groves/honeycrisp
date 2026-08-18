import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createReportTools,
  createResearchStorageLayout,
  createResearchToolRegistry,
  ensureResearchStorageLayout,
  getDefaultMemoryDatabasePath,
  listResearchStorageArtifacts,
  MemoryGraphStore,
  ReportStore,
} from "../packages/research-agent/dist/index.js";

test("reports persist revisioned Markdown artifacts within one workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-report-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const databasePath = getDefaultMemoryDatabasePath(workspaceRoot);
  const store = new ReportStore(databasePath, layout, {
    sessionId: "run_one", workspaceId: "workspace_one", workspaceName: "One",
  });
  try {
    const created = store.create({ title: "A useful result", summary: "A short explanation.", content: "# A useful result\n\nHere is what changed." });
    assert.equal(created.report.status, "complete");
    assert.equal(created.report.revision, 1);
    assert.equal(created.artifactRef.kind, "report");
    const revised = store.revise({ id: created.report.id, expectedRevision: 1, content: "# A useful result\n\nA clearer explanation.", status: "stale" });
    assert.equal(revised.report.revision, 2);
    assert.equal(revised.report.status, "stale");
    assert.throws(() => store.revise({ id: created.report.id, expectedRevision: 1, content: "stale write" }), /revision conflict/);
    assert.match(store.get(created.report.id).content, /clearer explanation/);
    assert.equal(store.list({ statuses: ["stale"] }).length, 1);
    const artifacts = listResearchStorageArtifacts(layout, { kind: "report" });
    assert.equal(artifacts.length, 1);
    assert.match(await readFile(artifacts[0].path, "utf8"), /clearer explanation/);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        database.prepare(`SELECT artifact_kind, artifact_id, session_id, revision
          FROM honeycrisp_artifact_revisions
          WHERE artifact_id = ? ORDER BY revision`).all(created.report.id).map((row) => ({ ...row })),
        [
          { artifact_kind: "report", artifact_id: created.report.id, session_id: "run_one", revision: 1 },
          { artifact_kind: "report", artifact_id: created.report.id, session_id: "run_one", revision: 2 },
        ],
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("report tools expose list, read, create, and revise operations", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-report-tools-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const store = new ReportStore(getDefaultMemoryDatabasePath(workspaceRoot), layout, { workspaceId: "workspace_tools", workspaceName: "Tools" });
  const registry = createResearchToolRegistry(createReportTools(store));
  try {
    assert.deepEqual(registry.listDescriptors().map((tool) => tool.name), ["report.list", "report.get", "report.create", "report.revise"]);
    const created = await registry.execute({ id: "create_report", actionClass: "synthesize", toolName: "report.create", input: { title: "Result", summary: "Shareable result.", content: "# Result\n\nReadable prose." } });
    assert.equal(created.result.status, "complete");
    assert.equal(created.result.artifactRefs[0].kind, "report");
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("reports import and retain a bounded workspace submission packet", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-report-packet-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "honeycrisp-report-packet-outside-"));
  const packetPath = join(workspaceRoot, "candidate.zip");
  const outsidePacketPath = join(outsideRoot, "outside.zip");
  await writeFile(packetPath, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]));
  await writeFile(outsidePacketPath, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const store = new ReportStore(
    getDefaultMemoryDatabasePath(workspaceRoot),
    layout,
    { workspaceId: "workspace_packet", workspaceName: "Packet" },
    { packetCandidateRoots: [workspaceRoot] },
  );
  try {
    assert.throws(() => store.create({
      title: "Outside packet",
      summary: "Must stay bounded.",
      content: "# Outside packet",
      submissionPacketPath: outsidePacketPath,
    }), /inside the active workspace/);
    const created = store.create({
      title: "Packet report",
      summary: "Includes its proof packet.",
      content: "# Packet report",
      submissionPacketPath: packetPath,
    });
    assert.deepEqual(created.report.submissionPacket, {
      artifactId: `${created.report.id}_submission_packet`,
      filename: "submission.zip",
      sizeBytes: 8,
      contentHash: created.submissionPacketArtifactRef.contentHash,
    });
    assert.equal(created.submissionPacketArtifactRef.kind, "submission-packet");
    const packetArtifacts = listResearchStorageArtifacts(layout, { kind: "submission-packet" });
    assert.equal(packetArtifacts.length, 1);
    assert.match(packetArtifacts[0].relativePath, /report-packets\/workspace_packet\/report_.+\/submission\.zip/);
    assert.deepEqual(await readFile(packetArtifacts[0].path), await readFile(packetPath));

    const revised = store.revise({
      id: created.report.id,
      expectedRevision: 1,
      content: "# Packet report\n\nRevised without replacing the packet.",
    });
    assert.deepEqual(revised.report.submissionPacket, created.report.submissionPacket);
    assert.equal(revised.submissionPacketArtifactRef, undefined);
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("security report creation requires a confirmed reportable chain", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-security-report-tools-"));
  const layout = ensureResearchStorageLayout(createResearchStorageLayout({ workspaceRoot }));
  const memoryGraph = new MemoryGraphStore({ workspaceRoot, context: {
    sessionId: "run_security", workspaceId: "workspace_security", workspaceName: "Security",
    subjectId: "subject_security", subjectName: "Security Subject",
  } });
  const packetPath = join(workspaceRoot, "submission.zip");
  await writeFile(packetPath, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]));
  const store = new ReportStore(memoryGraph.databasePath, layout, memoryGraph.getContext(), { packetCandidateRoots: [workspaceRoot] });
  const registry = createResearchToolRegistry(createReportTools(store, {
    requireConfirmedChain: true,
    requireSubmissionPacket: true,
    memoryGraph,
  }));
  try {
    const primitive = memoryGraph.save({
      type: "primitive",
      title: "Attacker controls the redirect destination",
      status: "confirmed",
      attributes: { rootCause: "Unvalidated redirect destination", rootCauseKey: "unvalidated-redirect-destination" },
      evidence: [{ kind: "command", locator: { command: "redirect-verifier" }, summary: "The verifier demonstrated destination control." }],
    });
    const premature = await registry.execute({
      id: "premature_report",
      actionClass: "synthesize",
      toolName: "report.create",
      input: { title: "Premature", summary: "Primitive only.", content: "# Premature", sourceChainId: primitive.id, submissionPacketPath: packetPath },
    });
    assert.equal(premature.result.status, "error");
    assert.match(premature.result.error.message, /primitive upgraded to a chain/);

    const chain = memoryGraph.correct(primitive.id, primitive.revision, {
      type: "chain",
      status: "confirmed",
      attributes: {
        rootCause: "Unvalidated redirect destination reaches an authenticated callback",
        rootCauseKey: "unvalidated-redirect-authenticated-callback",
        reachability: "An attacker supplies the destination before authentication.",
        impact: "The callback discloses the victim authorization result.",
      },
    });
    const missingPacket = await registry.execute({
      id: "confirmed_chain_without_packet",
      actionClass: "synthesize",
      toolName: "report.create",
      input: { title: "Missing packet", summary: "Reportable chain.", content: "# Missing packet", sourceChainId: chain.id },
    });
    assert.equal(missingPacket.result.status, "blocked");
    assert.match(JSON.stringify(missingPacket.result), /submissionPacketPath/);
    const created = await registry.execute({
      id: "confirmed_chain_report",
      actionClass: "synthesize",
      toolName: "report.create",
      input: { title: "Confirmed chain", summary: "Reportable chain.", content: "# Confirmed chain", sourceChainId: chain.id, submissionPacketPath: packetPath },
    });
    assert.equal(created.result.status, "complete");
    assert.equal(created.result.artifactRefs[0].kind, "report");
    assert.equal(created.result.artifactRefs[1].kind, "submission-packet");
    assert.equal(created.result.output.submissionPacket.filename, "submission.zip");
  } finally {
    store.close();
    memoryGraph.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
