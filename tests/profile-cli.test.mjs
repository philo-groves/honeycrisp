import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  DEFAULT_MATHEMATICS_RESEARCH_PROFILE,
  researchProfileHash,
} from "../packages/research-agent/dist/index.js";

const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("profile resolve returns the versioned bundled-default catalog envelope", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-default-"));
  try {
    const result = runCli([
      "profile",
      "resolve",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);

    assert.equal(envelope.catalogProtocolVersion, 1);
    assert.deepEqual(envelope.supportedResearchProfileSchemaVersions, [1]);
    assert.equal(envelope.source, "bundled-default");
    assert.equal(envelope.profile.id, "security-research");
    assert.equal(envelope.hash, researchProfileHash(envelope.profile));
    assert.equal("path" in envelope, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("profile resolve selects the bundled mathematics research catalog", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-mathematics-"));
  try {
    const result = runCli([
      "profile",
      "resolve",
      "--workspace-root",
      workspaceRoot,
      "--profile-id",
      "mathematics",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);

    assert.equal(envelope.source, "bundled-default");
    assert.equal(envelope.profile.id, "mathematics");
    assert.equal(envelope.hash, researchProfileHash(envelope.profile));
    assert.deepEqual(
      envelope.profile.memory.types.map((type) => type.id),
      DEFAULT_MATHEMATICS_RESEARCH_PROFILE.memory.types.map((type) => type.id),
    );
    assert.deepEqual(
      envelope.profile.memory.types.map((type) => type.id),
      ["problem", "definition", "conjecture", "theorem", "counterexample", "technique", "reference", "trajectory"],
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("profile resolve gives an explicit profile precedence over the workspace default", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-precedence-"));
  const workspaceProfilePath = join(workspaceRoot, ".honeycrisp", "profile.json");
  const explicitProfilePath = join(workspaceRoot, "explicit-profile.json");
  try {
    await mkdir(join(workspaceRoot, ".honeycrisp"), { recursive: true });
    await writeProfile(workspaceProfilePath, createCustomProfile("workspace-profile", "Workspace"));
    await writeProfile(explicitProfilePath, createCustomProfile("explicit-profile", "Explicit"));

    const workspaceResult = runCli([
      "profile",
      "resolve",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    assert.equal(workspaceResult.status, 0, workspaceResult.stderr);
    const workspaceEnvelope = JSON.parse(workspaceResult.stdout);
    assert.equal(workspaceEnvelope.source, "workspace-default");
    assert.equal(workspaceEnvelope.path, workspaceProfilePath);
    assert.equal(workspaceEnvelope.profile.id, "workspace-profile");

    const explicitResult = runCli([
      "profile",
      "resolve",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      explicitProfilePath,
      "--json",
    ]);
    assert.equal(explicitResult.status, 0, explicitResult.stderr);
    const explicitEnvelope = JSON.parse(explicitResult.stdout);
    assert.equal(explicitEnvelope.source, "explicit");
    assert.equal(explicitEnvelope.path, explicitProfilePath);
    assert.equal(explicitEnvelope.profile.id, "explicit-profile");
    assert.equal(explicitEnvelope.hash, researchProfileHash(explicitEnvelope.profile));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("run wires an exact custom profile and workflow through tools, context, and capture", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-run-"));
  const profilePath = join(workspaceRoot, "custom-profile.json");
  const capturePath = join(workspaceRoot, "capture.json");
  try {
    await writeProfile(profilePath, createCustomProfile("general-research", "General"));
    const resolved = resolveProfile(workspaceRoot, profilePath);

    const result = runCli([
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--resolved-research-profile",
      profilePath,
      "--research-profile-hash",
      resolved.hash,
      "--workflow",
      "survey",
      "--capture",
      capturePath,
      "--json",
      "--success",
      "Produce a cited synthesis.",
      "--stop",
      "The corpus is unavailable.",
      "--scope",
      "Local fixture only.",
      "--evidence",
      "Cite each retained insight.",
      "--risk",
      "Sources may conflict.",
      "--preference",
      "Prefer primary evidence.",
      "-p",
      "Survey the local fixture.",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const run = JSON.parse(result.stdout);
    const profileContext = run.agentRun.modelInput.contextSections.find(
      (section) => section.label === "research_profile",
    );
    const intentContext = run.agentRun.modelInput.contextSections.find(
      (section) => section.label === "research_intent",
    );
    assert.equal(profileContext.content.id, "general-research");
    assert.equal(profileContext.content.hash, resolved.hash);
    assert.equal(profileContext.content.workflow.id, "survey");
    assert.deepEqual(intentContext.content, {
      successGates: ["Produce a cited synthesis."],
      failureOrStopGates: ["The corpus is unavailable."],
      scopeConstraints: ["Local fixture only."],
      evidenceRequirements: ["Cite each retained insight."],
      initialRiskFlags: ["Sources may conflict."],
      userPreferences: ["Prefer primary evidence."],
    });

    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.researchProfile.id, "general-research");
    assert.equal(capture.researchProfile.hash, resolved.hash);
    assert.equal(capture.researchProfile.workflowId, "survey");
    assert.equal(capture.researchProfile.source, "explicit");
    assert.equal(capture.researchProfile.path, profilePath);
    assert.deepEqual(
      capture.researchProfile.snapshot.memory.types.map((type) => type.id),
      ["insight"],
    );
    assert.match(
      capture.context.availableTools.find((tool) => tool.name === "memory.save").description,
      /insight \(Insight\)/,
    );
    assert.equal(
      capture.context.availableTools.some((tool) => tool.name.startsWith("runbook.")),
      false,
    );
    assert.deepEqual(capture.context.collaborationTools, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("run accepts a memory-disabled profile with an empty catalog", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-memory-disabled-"));
  const profilePath = join(workspaceRoot, "memory-disabled-profile.json");
  const capturePath = join(workspaceRoot, "capture.json");
  try {
    const profile = createCustomProfile("memory-disabled", "Memory Disabled");
    profile.capabilities.memoryEnabled = false;
    profile.memory = {
      types: [],
      statuses: [],
      evidenceKinds: [],
      evidencePathBases: [],
      relations: [],
    };
    await writeProfile(profilePath, profile);
    const resolved = resolveProfile(workspaceRoot, profilePath);
    const result = runCli([
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--resolved-research-profile",
      profilePath,
      "--research-profile-hash",
      resolved.hash,
      "--capture",
      capturePath,
      "--json",
      "-p",
      "Run without durable memory.",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(
      capture.context.availableTools.some((tool) => tool.name.startsWith("memory.")),
      false,
    );
    assert.deepEqual(capture.context.memory, []);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("run rejects a supplied profile hash mismatch before creating a capture", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-mismatch-"));
  const profilePath = join(workspaceRoot, "custom-profile.json");
  const capturePath = join(workspaceRoot, "should-not-exist.json");
  try {
    await writeProfile(profilePath, createCustomProfile("hash-mismatch", "Mismatch"));
    const result = runCli([
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      profilePath,
      "--research-profile-hash",
      "0".repeat(64),
      "--workflow",
      "survey",
      "--capture",
      capturePath,
      "-p",
      "This run must not start.",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Research profile hash mismatch/);
    await assert.rejects(readFile(capturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace profiles cannot grant executable capabilities outside explicit host authority", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-capabilities-"));
  const profilePath = join(workspaceRoot, ".honeycrisp", "profile.json");
  const experimentConfigPath = join(workspaceRoot, "experiments.json");
  const explicitCapturePath = join(workspaceRoot, "explicit-profile-capture.json");
  try {
    const profile = createCustomProfile("capability-defaults", "Capability");
    profile.capabilities.defaultToolFamilies = ["shell", "code", "experiment"];
    profile.capabilities.disabledToolFamilies = ["code"];
    profile.capabilities.allowedSideEffects = ["write", "process", "network"];
    profile.capabilities.allowedMcpServerIds = ["profile-owned-network"];
    profile.capabilities.selectedSkillIds = ["profile-only-skill"];
    await mkdir(join(workspaceRoot, ".honeycrisp"), { recursive: true });
    await writeProfile(profilePath, profile);
    await writeFile(
      experimentConfigPath,
      JSON.stringify({
        experiments: {
          host_granted: {
            command: process.execPath,
            args: ["--version"],
            sideEffects: "process",
            requiredPermissions: ["fixture:run"],
          },
        },
      }),
      "utf8",
    );

    const result = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.deepEqual(payload.toolFamilies.requested, []);
    assert.deepEqual(payload.toolFamilies.disabled, ["code"]);
    assert.deepEqual(payload.toolFamilies.enabled, []);
    assert.equal(payload.tools.some((tool) => tool.name === "shell.run"), false);
    assert.equal(payload.tools.some((tool) => tool.name.startsWith("code.")), false);
    assert.equal(payload.tools.some((tool) => tool.name === "experiment.run"), false);
    assert.deepEqual(payload.governance.allowedSideEffects, ["none"]);
    assert.equal("shellNetworkAuthorization" in payload, false);
    assert.deepEqual(payload.mcp.allowedServers, []);
    assert.deepEqual(payload.skills.selectedIds, []);

    const profileRestrictedMcp = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--allow-mcp-server",
      "host-authorized-only",
      "--json",
    ]);
    assert.equal(profileRestrictedMcp.status, 0, profileRestrictedMcp.stderr);
    const restrictedMcpPayload = JSON.parse(profileRestrictedMcp.stdout);
    assert.deepEqual(restrictedMcpPayload.mcp.hostAuthorizedServers, ["host-authorized-only"]);
    assert.deepEqual(restrictedMcpPayload.mcp.profileRestriction, ["profile-owned-network"]);
    assert.deepEqual(restrictedMcpPayload.mcp.allowedServers, []);

    const explicitRun = runCli([
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--profile",
      profilePath,
      "--no-default-tool-config",
      "--capture",
      explicitCapturePath,
      "--json",
      "-p",
      "Exercise the explicit profile without host capability grants.",
    ]);
    assert.equal(explicitRun.status, 0, explicitRun.stderr);
    const explicitCapture = JSON.parse(await readFile(explicitCapturePath, "utf8"));
    assert.equal(explicitCapture.researchProfile.source, "explicit");
    assert.deepEqual(explicitCapture.runtimeConfig.toolFamilies.enabled, []);
    assert.deepEqual(explicitCapture.runtimeConfig.governance.allowedSideEffects, ["none"]);
    assert.equal(
      explicitCapture.runtimeConfig.tools.some((tool) => tool.name === "shell.run"),
      false,
    );

    const hostDelegated = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--profile-tool-family-ceiling",
      "shell",
      "--profile-tool-family-ceiling",
      "experiment",
      "--experiment-config",
      experimentConfigPath,
      "--profile-side-effect-ceiling",
      "write",
      "--profile-side-effect-ceiling",
      "process",
      "--json",
    ]);
    assert.equal(hostDelegated.status, 0, hostDelegated.stderr);
    const delegatedPayload = JSON.parse(hostDelegated.stdout);
    assert.deepEqual(delegatedPayload.toolFamilies.profileCeiling, ["shell", "experiment"]);
    assert.deepEqual(delegatedPayload.toolFamilies.enabled, ["shell", "experiment"]);
    assert.equal(delegatedPayload.tools.some((tool) => tool.name.startsWith("code.")), false);
    assert.deepEqual(delegatedPayload.governance.allowedSideEffects, ["write", "process"]);

    const rejectedNetworkDelegation = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--profile-side-effect-ceiling",
      "network",
    ]);
    assert.equal(rejectedNetworkDelegation.status, 1);
    assert.match(rejectedNetworkDelegation.stderr, /cannot delegate network authority/);

    const hostAuthorized = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--tool-family",
      "shell",
      "--tool-family",
      "code",
      "--tool-family",
      "experiment",
      "--experiment-config",
      experimentConfigPath,
      "--allowed-side-effect",
      "write",
      "--allowed-side-effect",
      "process",
      "--allowed-side-effect",
      "network",
      "--json",
    ]);
    assert.equal(hostAuthorized.status, 0, hostAuthorized.stderr);
    const hostPayload = JSON.parse(hostAuthorized.stdout);
    assert.deepEqual(hostPayload.toolFamilies.enabled, ["shell", "code", "experiment"]);
    assert.equal(hostPayload.tools.some((tool) => tool.name === "shell.run"), true);
    assert.equal(hostPayload.tools.some((tool) => tool.name.startsWith("code.")), true);
    assert.equal(hostPayload.tools.some((tool) => tool.name === "experiment.run"), true);
    assert.deepEqual(hostPayload.governance.allowedSideEffects, ["write", "process", "network"]);
    assert.equal("shellNetworkAuthorization" in hostPayload, false);

    const hostDisabled = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--tool-family",
      "code",
      "--disable-tool-family",
      "code",
      "--json",
    ]);
    assert.equal(hostDisabled.status, 0, hostDisabled.stderr);
    const disabledPayload = JSON.parse(hostDisabled.stdout);
    assert.deepEqual(disabledPayload.toolFamilies.requested, ["code"]);
    assert.deepEqual(disabledPayload.toolFamilies.disabled, ["code"]);
    assert.deepEqual(disabledPayload.toolFamilies.enabled, []);
    assert.equal(disabledPayload.tools.some((tool) => tool.name.startsWith("code.")), false);

    profile.capabilities.allowedMcpServerIds = [];
    await writeProfile(profilePath, profile);
    const unrestrictedMcp = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--allow-mcp-server",
      "host-authorized-only",
      "--json",
    ]);
    assert.equal(unrestrictedMcp.status, 0, unrestrictedMcp.stderr);
    const unrestrictedMcpPayload = JSON.parse(unrestrictedMcp.stdout);
    assert.deepEqual(unrestrictedMcpPayload.mcp.hostAuthorizedServers, ["host-authorized-only"]);
    assert.deepEqual(unrestrictedMcpPayload.mcp.profileRestriction, []);
    assert.deepEqual(unrestrictedMcpPayload.mcp.allowedServers, ["host-authorized-only"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the code-owned bundled security profile enables local research reads by default", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-bundled-capabilities-"));
  try {
    const result = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--no-default-tool-config",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.deepEqual(payload.toolFamilies.requested, ["shell", "repository-search", "file-read"]);
    assert.deepEqual(payload.toolFamilies.enabled, ["shell", "repository-search", "file-read"]);
    assert.equal(payload.tools.some((tool) => tool.name === "shell.run"), true);
    assert.equal(payload.tools.some((tool) => tool.name === "repository.search"), true);
    assert.equal(payload.tools.some((tool) => tool.name === "file.read"), true);
    assert.deepEqual(payload.governance.allowedSideEffects, ["none", "read", "write", "process"]);
    assert.equal(payload.governance.allowedSideEffects.includes("network"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("explicit network effects compile without application-level network authorization", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-shell-network-context-"));
  const contextPath = join(workspaceRoot, "host-context.json");
  try {
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceRoot,
        authorization: {
          recorded: true,
          source: "beale",
          scopeId: "scope_network",
          scopeName: "Network fixture",
          activeFrom: "2000-01-01T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );
    const result = runCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "--allowed-side-effect",
      "process",
      "--allowed-side-effect",
      "network",
      "--no-default-tool-config",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal("shellNetworkAuthorization" in payload, false);
    assert.deepEqual(payload.governance.allowedSideEffects, ["process", "network"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("run rejects unavailable profile model-job routes before execution", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-model-job-"));
  const profilePath = join(workspaceRoot, "invalid-model-profile.json");
  const capturePath = join(workspaceRoot, "should-not-exist.json");
  try {
    const profile = createCustomProfile("invalid-model-job", "Invalid Model");
    profile.modelJobs.sessionTitle = {
      provider: "unavailable-provider",
      model: "unavailable-model",
      effort: "medium",
    };
    await writeProfile(profilePath, profile);

    const result = runCli([
      "--mock",
      "--profile",
      profilePath,
      "--workspace-root",
      workspaceRoot,
      "--capture",
      capturePath,
      "-p",
      "This run must not start.",
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Research profile sessionTitle model is unavailable: unavailable-provider\/unavailable-model/,
    );
    await assert.rejects(readFile(capturePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("legacy memory description overlays are included in the run profile hash", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-overlay-"));
  const capturePath = join(workspaceRoot, "capture.json");
  try {
    const base = resolveProfile(workspaceRoot);
    const description = "A deliberately overridden proven research primitive.";
    const result = runCli([
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--memory-type-descriptions",
      JSON.stringify({ primitive: description }),
      "--capture",
      capturePath,
      "-p",
      "Exercise the legacy taxonomy overlay.",
    ]);
    assert.equal(result.status, 0, result.stderr);

    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    const primitive = capture.researchProfile.snapshot.memory.types.find(
      (type) => type.id === "primitive",
    );
    assert.equal(primitive.description, description);
    assert.notEqual(capture.researchProfile.hash, base.hash);
    assert.equal(
      capture.researchProfile.hash,
      researchProfileHash(capture.researchProfile.snapshot),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("standalone memory commands use the workspace research profile", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-profile-memory-"));
  const profileDirectory = join(workspaceRoot, ".honeycrisp");
  try {
    await mkdir(profileDirectory, { recursive: true });
    const profile = createCustomProfile("memory-catalog", "Memory Catalog");
    profile.memory.types[0].attributes = {
      topic: {
        type: "string",
        description: "The durable subject of the insight.",
      },
    };
    profile.memory.types[0].requirements = [{
      requiredAttributes: ["topic"],
      requireEvidence: true,
    }];
    await writeProfile(
      join(profileDirectory, "profile.json"),
      profile,
    );

    const incomplete = runCli([
      "memory",
      "save",
      "finding",
      "Incomplete profile-backed insight",
      "--workspace-root",
      workspaceRoot,
    ]);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /requires non-empty attributes: topic/);

    const saved = runCli([
      "memory",
      "save",
      "finding",
      "Profile-backed insight",
      "--workspace-root",
      workspaceRoot,
      "--attributes-json",
      JSON.stringify({ topic: "bounded schemas" }),
      "--evidence-json",
      JSON.stringify({
        kind: "human_note",
        locator: { source: "operator" },
        summary: "Profile-backed fixture evidence.",
      }),
      "--evidence-json",
      JSON.stringify({
        kind: "human_note",
        locator: { source: "reviewer" },
        summary: "Second repeatable fixture evidence.",
      }),
      "--json",
    ]);
    assert.equal(saved.status, 0, saved.stderr);
    const node = JSON.parse(saved.stdout);
    assert.equal(node.type, "insight");
    assert.equal(node.status, "draft");
    assert.deepEqual(node.attributes, { topic: "bounded schemas" });
    assert.equal(node.evidence.length, 2);
    assert.ok(node.evidence.every((item) => item.kind === "human_note"));
    assert.deepEqual(
      node.evidence.map((item) => item.locator.source).sort(),
      ["operator", "reviewer"],
    );

    const corrected = runCli([
      "memory",
      "correct",
      node.id,
      "--workspace-root",
      workspaceRoot,
      "--expected-revision",
      String(node.revision),
      "--attributes-json",
      JSON.stringify({ topic: "corrected schemas" }),
      "--evidence-json",
      JSON.stringify([{
        kind: "human_note",
        locator: { source: "reviewer" },
        summary: "Corrected profile-backed fixture evidence.",
      }]),
      "--json",
    ]);
    assert.equal(corrected.status, 0, corrected.stderr);
    const correctedNode = JSON.parse(corrected.stdout);
    assert.equal(correctedNode.revision, node.revision + 1);
    assert.deepEqual(correctedNode.attributes, { topic: "corrected schemas" });
    assert.equal(correctedNode.evidence.length, 1);
    assert.deepEqual(correctedNode.evidence[0].locator, { source: "reviewer" });

    const tooMuchEvidence = runCli([
      "memory",
      "save",
      "finding",
      "Too much evidence",
      "--workspace-root",
      workspaceRoot,
      "--attributes-json",
      JSON.stringify({ topic: "bounded schemas" }),
      "--evidence-json",
      JSON.stringify(Array.from({ length: 65 }, (_, index) => ({
        kind: "human_note",
        locator: { index },
        summary: `Evidence ${index}`,
      }))),
    ]);
    assert.equal(tooMuchEvidence.status, 1);
    assert.match(tooMuchEvidence.stderr, /at most 64 evidence items/);

    const rejected = runCli([
      "memory",
      "save",
      "primitive",
      "Security-only type",
      "--workspace-root",
      workspaceRoot,
    ]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Unsupported memory node type: primitive/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function resolveProfile(workspaceRoot, profilePath) {
  const result = runCli([
    "profile",
    "resolve",
    "--workspace-root",
    workspaceRoot,
    ...(profilePath ? ["--profile", profilePath] : []),
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HONEYCRISP_TEST_WORKSPACE_STORAGE: "1",
    },
  });
}

async function writeProfile(path, profile) {
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function createCustomProfile(id, name) {
  const profile = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  profile.id = id;
  profile.version = "2.0.0";
  profile.name = `${name} Research`;
  profile.description = `A ${name.toLowerCase()} non-security research fixture.`;
  profile.agent.role = "You are a careful general research agent.";
  profile.memory.types = [
    {
      id: "insight",
      aliases: ["finding"],
      name: "Insight",
      pluralName: "Insights",
      description: "A reusable, evidence-supported research insight.",
      lifecycle: "active",
      creatable: true,
      order: 10,
      defaultStatus: "draft",
      allowedStatuses: ["draft", "confirmed", "rejected"],
    },
  ];
  profile.workflows = [
    {
      id: "survey",
      name: "Survey",
      description: "Survey a bounded body of material.",
      goalSuggestionCount: 3,
      goalSuggestionInstructions: ["Propose bounded survey questions."],
      promptInstructions: ["Synthesize the material without assuming a conclusion."],
      outputRequirements: ["Cite the evidence supporting each retained insight."],
      default: true,
    },
  ];
  profile.collaboration = { protocolInstructions: [], recipes: [] };
  profile.capabilities = {
    ...profile.capabilities,
    defaultToolFamilies: [],
    disabledToolFamilies: [],
    allowedSideEffects: ["none", "read"],
    selectedSkillIds: [],
    disabledSkillIds: [],
    allowedMcpServerIds: [],
    runbooksEnabled: false,
    collaborationEnabled: false,
  };
  return profile;
}
