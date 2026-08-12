import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  MemoryGraphStore,
  normalizeResearchProfile,
  researchProfileHash,
  resolveStoredResearchProfile,
  resolveStoredResearchWorkspaceBinding,
} from "../packages/research-agent/dist/index.js";
import * as workspaceTools from "../packages/research-agent/dist/workspace-tools.js";

test("stored workspace binding derives path-stable identity without exposing storage paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-binding-fallback-"));
  const databasePath = join(workspaceRoot, "missing", "memory.sqlite");
  try {
    const binding = resolveStoredResearchWorkspaceBinding({
      workspaceRoot,
      databasePath,
      externalSessionId: "  claude-session-one  ",
    });
    const workspaceId = `workspace_${createHash("sha256")
      .update(resolve(workspaceRoot))
      .digest("hex")
      .slice(0, 20)}`;

    assert.deepEqual(binding, {
      schemaVersion: 1,
      source: "deterministic",
      memoryContext: {
        sessionId: "claude-session-one",
        workspaceId,
        workspaceName: basename(workspaceRoot),
        subjectId: `subject_workspace:${workspaceId}`,
        subjectName: basename(workspaceRoot),
      },
    });
    const serialized = JSON.stringify(binding);
    assert.doesNotMatch(serialized, /memory\.sqlite/);
    assert.equal(serialized.includes(resolve(workspaceRoot)), false);
    assert.equal("databasePath" in binding, false);
    assert.equal("workspaceRoot" in binding, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stored workspace binding prefers the Beale research subject and redacts credential references", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-binding-beale-"));
  const databasePath = join(workspaceRoot, "state", "memory.sqlite");
  const profileSourcePath = join(workspaceRoot, "private", "profile.json");
  const storedProfile = normalizeResearchProfile({
    ...DEFAULT_SECURITY_RESEARCH_PROFILE,
    id: "beale-custom-security",
    version: "2.0.0",
    name: "Beale Custom Security",
  });
  const storedProfileHash = researchProfileHash(storedProfile);
  await mkdir(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const credentialReference = "secret://host-credential-reference";
  try {
    database.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE scope_versions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        scope_owner TEXT NOT NULL,
        description_markdown TEXT NOT NULL,
        network_policy_json TEXT NOT NULL,
        rules_markdown TEXT NOT NULL,
        active_from TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE scope_assets (
        id TEXT PRIMARY KEY,
        scope_version_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE workspace_research_subjects (
        workspace_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE research_profile_snapshots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        profile_version TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT,
        profile_json TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    database
      .prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)")
      .run("workspace_recorded", resolve(workspaceRoot), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    database
      .prepare("INSERT INTO scope_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "scope_recorded",
        "workspace_recorded",
        1,
        "active",
        "Recorded workspace",
        "Scope Owner",
        "Authorized local research.",
        JSON.stringify({
          defaultProfile: "scoped",
          inScope: ["example.test", credentialReference],
        }),
        "Respect the recorded boundary.",
        "2026-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    const insertAsset = database.prepare("INSERT INTO scope_assets VALUES (?, ?, ?, ?, ?, ?)");
    insertAsset.run("asset_domain", "scope_recorded", "in_scope", "domain", "example.test", "2026-01-01T00:00:01Z");
    insertAsset.run("asset_host", "scope_recorded", "in_scope", "host", "api.example.test", "2026-01-01T00:00:02Z");
    insertAsset.run("asset_credential", "scope_recorded", "in_scope", "credential_ref", credentialReference, "2026-01-01T00:00:03Z");
    insertAsset.run("asset_out", "scope_recorded", "out_of_scope", "domain", "excluded.example.test", "2026-01-01T00:00:04Z");
    database
      .prepare("INSERT INTO workspace_research_subjects VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "workspace_recorded",
        "subject_explicit",
        "Explicit research subject",
        "explicit",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
    database
      .prepare("INSERT INTO research_profile_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "profile_recorded",
        "workspace_recorded",
        storedProfile.id,
        storedProfile.version,
        storedProfileHash,
        "explicit",
        profileSourcePath,
        JSON.stringify(storedProfile),
        1,
        "2026-01-01T00:00:00Z",
      );
  } finally {
    database.close();
  }

  try {
    const binding = resolveStoredResearchWorkspaceBinding({
      workspaceRoot,
      databasePath,
      externalSessionId: "claude-session-two",
    });
    assert.equal(binding.source, "beale");
    assert.deepEqual(binding.memoryContext, {
      sessionId: "claude-session-two",
      workspaceId: "workspace_recorded",
      workspaceName: "Recorded workspace",
      subjectId: "subject_explicit",
      subjectName: "Explicit research subject",
    });
    assert.deepEqual(binding.authorization, {
      recorded: true,
      source: "beale",
      scopeId: "scope_recorded",
      scopeName: "Recorded workspace",
      scopeOwner: "Scope Owner",
      activeFrom: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    const serialized = JSON.stringify(binding);
    assert.equal(serialized.includes(credentialReference), false);
    assert.equal(serialized.includes(databasePath), false);
    assert.equal(serialized.includes(workspaceRoot), false);

    const profile = await resolveStoredResearchProfile({
      workspaceRoot,
      databasePath,
    });
    assert.equal(profile.profile.id, "beale-custom-security");
    assert.equal(profile.profile.version, "2.0.0");
    assert.equal(profile.hash, storedProfileHash);
    assert.equal(profile.source, "explicit");
    assert.equal("path" in profile, false);
    const serializedProfile = JSON.stringify(profile);
    assert.equal(serializedProfile.includes(databasePath), false);
    assert.equal(serializedProfile.includes(profileSourcePath), false);

    const store = new MemoryGraphStore({ workspaceRoot, databasePath });
    try {
      assert.equal(store.getContext().subjectId, "subject_explicit");
      assert.equal(store.getContext().subjectName, "Explicit research subject");
      const node = store.save({ type: "asset", title: "Recorded target" });
      assert.equal(node.subjectId, "subject_explicit");
      assert.deepEqual(node.workspaces, [{ id: "workspace_recorded", name: "Recorded workspace" }]);
    } finally {
      store.close();
    }

    const altered = new DatabaseSync(databasePath);
    try {
      altered
        .prepare("UPDATE research_profile_snapshots SET profile_hash = ? WHERE id = ?")
        .run("invalid-profile-hash", "profile_recorded");
    } finally {
      altered.close();
    }
    await assert.rejects(
      resolveStoredResearchProfile({ workspaceRoot, databasePath }),
      (error) => {
        assert.match(error.message, /failed validation/);
        assert.equal(error.message.includes(databasePath), false);
        assert.equal(error.message.includes(profileSourcePath), false);
        return true;
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("stored research profile falls back to a path-free workspace profile", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-fallback-"));
  const profileDirectory = join(workspaceRoot, ".honeycrisp");
  const profilePath = join(profileDirectory, "profile.json");
  const databasePath = join(workspaceRoot, "missing", "memory.sqlite");
  const workspaceProfile = {
    ...DEFAULT_SECURITY_RESEARCH_PROFILE,
    id: "workspace-custom-security",
    version: "3.0.0",
    name: "Workspace Custom Security",
  };
  try {
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(profilePath, JSON.stringify(workspaceProfile), "utf8");

    const resolvedProfile = await resolveStoredResearchProfile({
      workspaceRoot,
      databasePath,
    });
    assert.equal(resolvedProfile.profile.id, "workspace-custom-security");
    assert.equal(resolvedProfile.profile.version, "3.0.0");
    assert.equal(
      resolvedProfile.hash,
      researchProfileHash(normalizeResearchProfile(workspaceProfile)),
    );
    assert.equal(resolvedProfile.source, "workspace-default");
    assert.equal("path" in resolvedProfile, false);
    const serialized = JSON.stringify(resolvedProfile);
    assert.equal(serialized.includes(profilePath), false);
    assert.equal(serialized.includes(databasePath), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace-tools exposes the compatibility surface without generic global artifact access", () => {
  for (const exportName of [
    "MemoryGraphStore",
    "RunbookStore",
    "createMemoryGraphTools",
    "createRunbookTools",
    "createResearchToolRegistry",
    "resolveResearchProfile",
    "bundledResearchProfile",
    "researchProfileHash",
    "compileMemoryModelContext",
    "createModelWorkspaceContext",
    "resolveStoredResearchProfile",
    "resolveStoredResearchWorkspaceBinding",
  ]) {
    assert.equal(typeof workspaceTools[exportName], "function", exportName);
  }
  assert.deepEqual(workspaceTools.BUNDLED_RESEARCH_PROFILE_IDS, [
    "security-research",
    "mathematics",
  ]);
  assert.equal(
    workspaceTools.bundledResearchProfile("mathematics").id,
    "mathematics",
  );
  assert.equal("listResearchStorageArtifacts" in workspaceTools, false);
  assert.equal("resolveResearchStorageArtifact" in workspaceTools, false);
  assert.equal("getDefaultMemoryDatabasePath" in workspaceTools, false);
});
