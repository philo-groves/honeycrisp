import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MATHEMATICS_RESEARCH_PROFILE,
  DEFAULT_SECURITY_RESEARCH_PROFILE,
  createDeterministicAgentExecutor,
  createResearchSystemPrompt,
  normalizeResearchProfile,
  researchProfileHash,
  resolveResearchProfile,
  resolveResearchProfileMemoryType,
  runResearchAgent,
} from "../packages/research-agent/dist/index.js";

test("research profiles normalize to immutable, deterministic snapshots", () => {
  const profile = normalizeResearchProfile(DEFAULT_SECURITY_RESEARCH_PROFILE);
  const reordered = Object.fromEntries(Object.entries(structuredClone(profile)).reverse());

  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.memory.types));
  assert.equal(researchProfileHash(profile), researchProfileHash(normalizeResearchProfile(reordered)));

  const changed = structuredClone(profile);
  changed.name = "Security Research Renamed";
  assert.notEqual(researchProfileHash(profile), researchProfileHash(normalizeResearchProfile(changed)));
});

test("bundled profiles own their session heat palettes and memory-status defaults", () => {
  const security = normalizeResearchProfile(DEFAULT_SECURITY_RESEARCH_PROFILE);
  const mathematics = normalizeResearchProfile(DEFAULT_MATHEMATICS_RESEARCH_PROFILE);

  assert.deepEqual(security.presentation.sessionHeatPalette, {
    low: "#cdaa32",
    medium: "#e8842c",
    high: "#ff4a54",
    critical: "#b4121c",
  });
  assert.equal(security.memory.types.find((type) => type.id === "chain")?.sessionHeat.confirmed, "critical");
  assert.deepEqual(mathematics.presentation.sessionHeatPalette, {
    low: "#45b8d8",
    medium: "#4f87e8",
    high: "#7768e8",
    critical: "#b14ee8",
  });
  assert.equal(mathematics.memory.types.find((type) => type.id === "theorem")?.sessionHeat.verified, "critical");
  assert.equal(mathematics.memory.types.find((type) => type.id === "formalization")?.sessionHeat.verified, "medium");
});

test("research profile validation rejects silent schema drift", () => {
  const unknownRootField = { ...structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE), typoedWorkflows: [] };
  assert.throws(() => normalizeResearchProfile(unknownRootField), /unknown field: typoedWorkflows/);

  const unknownTypeField = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  unknownTypeField.memory.types[0].descripton = "misspelled";
  assert.throws(() => normalizeResearchProfile(unknownTypeField), /unknown field: descripton/);

  const invalidEnum = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  invalidEnum.memory.types[0].attributes = {
    score: { type: "number", description: "A bounded score.", enum: [Number.NaN] },
  };
  assert.throws(() => normalizeResearchProfile(invalidEnum), /enum does not match/);

  const invalidHeatStatus = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  invalidHeatStatus.memory.types[0].sessionHeat = { unrecorded: "high" };
  assert.throws(() => normalizeResearchProfile(invalidHeatStatus), /sessionHeat uses disallowed status unrecorded/);

  const invalidHeatColor = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  invalidHeatColor.presentation.sessionHeatPalette.low = "red";
  assert.throws(() => normalizeResearchProfile(invalidHeatColor), /must be a six-digit hex color/);

  const emptyEnabledMemory = structuredClone(DEFAULT_SECURITY_RESEARCH_PROFILE);
  emptyEnabledMemory.memory.types = [];
  assert.throws(
    () => normalizeResearchProfile(emptyEnabledMemory),
    /requires at least one active, creatable memory type/,
  );

  emptyEnabledMemory.capabilities.memoryEnabled = false;
  assert.doesNotThrow(() => normalizeResearchProfile(emptyEnabledMemory));
});

test("memory type IDs stay stable across names, aliases, and retirement", () => {
  const input = generalResearchProfile();
  input.memory.types[0].aliases = ["question"];
  input.memory.types[0].lifecycle = "retired";
  input.memory.types[0].creatable = false;
  input.memory.types[0].replacedBy = "result";
  const profile = normalizeResearchProfile(input);

  assert.deepEqual(resolveResearchProfileMemoryType(profile, "question"), {
    state: "retired",
    canonicalId: "claim",
    type: profile.memory.types[0],
  });
  assert.deepEqual(resolveResearchProfileMemoryType(profile, "unrecorded"), {
    state: "unknown",
    canonicalId: "unrecorded",
  });
});

test("workspace profiles override the bundled security default", async () => {
  const workspaceRoot = join(tmpdir(), `honeycrisp-profile-${process.pid}-${Date.now()}`);
  const profilePath = join(workspaceRoot, ".honeycrisp", "profile.json");
  try {
    await mkdir(join(workspaceRoot, ".honeycrisp"), { recursive: true });
    await writeFile(profilePath, JSON.stringify(generalResearchProfile()), "utf8");
    const resolved = await resolveResearchProfile({ workspaceRoot });
    assert.equal(resolved.source, "workspace-default");
    assert.equal(resolved.path, profilePath);
    assert.equal(resolved.profile.id, "general-research");
    assert.equal(resolved.hash, researchProfileHash(resolved.profile));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("the direct run boundary rejects a stale resolved profile hash before compiling context", async () => {
  const profile = normalizeResearchProfile(generalResearchProfile());
  const staleHash = researchProfileHash(profile);
  const changedProfile = structuredClone(profile);
  changedProfile.name = "Changed after resolution";
  let executorCalled = false;
  const liveEvents = [];

  await assert.rejects(
    runResearchAgent({
      prompt: "This run must not start.",
      resolvedResearchProfile: {
        profile: changedProfile,
        hash: staleHash,
        source: "explicit",
      },
      eventSink(event) {
        liveEvents.push(event);
      },
      executor: {
        name: "must-not-run",
        async execute() {
          executorCalled = true;
          return { text: "unexpected" };
        },
      },
    }),
    /Resolved research profile hash mismatch/,
  );
  assert.equal(executorCalled, false);
  assert.deepEqual(liveEvents, []);
});

test("custom profiles replace domain language without weakening host invariants", () => {
  const profile = normalizeResearchProfile(generalResearchProfile());
  const prompt = createResearchSystemPrompt({
    hasTools: true,
    hasMemoryTools: true,
    hasRunbookTools: true,
    researchProfile: profile,
    workflowId: "explore",
  });

  assert.match(prompt, /^You are a rigorous interdisciplinary researcher/);
  assert.match(prompt, /Active research workflow: Explore \(explore\)/);
  assert.match(prompt, /claim \(Question\): A question that can be tested/);
  assert.doesNotMatch(prompt, /world-class security researcher|vulnerabilit|historic bugs/i);
  assert.match(prompt, /Never expand that boundary/);
  assert.match(prompt, /Profile vocabulary: Research workspace; Research subject; Research boundary/);
  assert.match(prompt, /Profile-recognized material kinds: path, documentation, dataset/);
  assert.match(prompt, /it cannot authorize targets, side effects, or network access/);
  assert.match(prompt, /Stay within the recorded materials and systems/);
  assert.match(prompt, /Never expose host credentials/);
  assert.match(prompt, /Never use the \$HOME environment variable/);
});

test("the general-research example is a valid non-security profile", async () => {
  const source = await readFile(new URL("../examples/general-research.profile.json", import.meta.url), "utf8");
  const profile = normalizeResearchProfile(JSON.parse(source));

  assert.equal(profile.id, "general-research");
  assert.deepEqual(profile.memory.types.map((type) => [type.id, type.name]), [
    ["claim", "Question"],
    ["result", "Result"],
  ]);
  assert.equal(resolveResearchProfileMemoryType(profile, "question").canonicalId, "claim");
  assert.equal(profile.workspace.authorizationMode, "optional");
});

test("profile-selected skills remain inert until the host explicitly selects them", async () => {
  const workspaceRoot = join(tmpdir(), `honeycrisp-profile-skill-${process.pid}-${Date.now()}`);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const input = generalResearchProfile();
    input.capabilities.selectedSkillIds = ["profile-only"];
    const profile = normalizeResearchProfile(input);
    const resolvedResearchProfile = {
      profile,
      hash: researchProfileHash(profile),
      source: "explicit",
    };
    const skill = {
      id: "profile-only",
      description: "ZXQ esoteric specialist",
      domainTags: ["zxq"],
      instructions: "Instructions supplied by a host-loaded skill.",
    };

    const profileOnly = await runResearchAgent({
      prompt: "Read the supplied corpus.",
      workspaceRoot,
      skills: [skill],
      resolvedResearchProfile,
      executor: createDeterministicAgentExecutor(),
    });
    assert.deepEqual(profileOnly.selectedSkills, []);

    const hostSelected = await runResearchAgent({
      prompt: "Read the supplied corpus.",
      workspaceRoot,
      skills: [skill],
      selectedSkillIds: ["profile-only"],
      resolvedResearchProfile,
      executor: createDeterministicAgentExecutor(),
    });
    assert.equal(hostSelected.selectedSkills[0]?.id, "profile-only");
    assert.ok(hostSelected.selectedSkills[0]?.selectionReasons.includes("explicitly requested"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function generalResearchProfile() {
  return {
    schemaVersion: 1,
    id: "general-research",
    version: "1.0.0",
    name: "General Research",
    description: "Open-ended evidence-driven research across domains.",
    agent: {
      role: "You are a rigorous interdisciplinary researcher operating inside the Pi agent harness.",
      posture: ["Explore competing explanations and design discriminating tests."],
      style: ["Write concise, evidence-calibrated prose."],
      memoryInstructions: ["Search prior questions and results before repeating work."],
      runbookInstructions: ["Record reusable methods with exact prerequisites and steps."],
    },
    memory: {
      types: [
        {
          id: "claim",
          name: "Question",
          pluralName: "Questions",
          description: "A question that can be tested against observations.",
          lifecycle: "active",
          creatable: true,
          order: 10,
          defaultStatus: "open",
          allowedStatuses: ["open", "supported", "rejected"],
          contextWeight: 4,
        },
        {
          id: "result",
          name: "Result",
          pluralName: "Results",
          description: "A durable result supported by evidence.",
          lifecycle: "active",
          creatable: true,
          order: 20,
          defaultStatus: "supported",
          allowedStatuses: ["supported", "rejected"],
        },
      ],
      statuses: [
        { id: "open", name: "Open", description: "Not yet resolved.", order: 10, polarity: "neutral" },
        { id: "supported", name: "Supported", description: "Supported by available evidence.", order: 20, polarity: "positive" },
        { id: "rejected", name: "Rejected", description: "Rejected by available evidence.", order: 30, terminal: true, polarity: "negative" },
      ],
      evidenceKinds: [{ id: "observation", name: "Observation", description: "A recorded observation.", allowsPath: true }],
      evidencePathBases: [{ id: "workspace", name: "Workspace", description: "Relative to this workspace." }],
      relations: [{ id: "supports", name: "Supports", description: "Supports another memory." }],
      defaultNodeLimit: 8,
      defaultCharacterBudget: 12_000,
    },
    workflows: [{
      id: "explore",
      name: "Explore",
      description: "Explore a bounded question without assuming an answer.",
      goalSuggestionCount: 3,
      goalSuggestionInstructions: ["Suggest distinct bounded questions."],
      promptInstructions: ["Compare at least two plausible explanations."],
      outputRequirements: ["State observations separately from inference."],
      default: true,
    }],
    capabilities: {
      defaultToolFamilies: ["repository-search", "file-read"],
      disabledToolFamilies: [],
      allowedSideEffects: ["none", "read"],
      selectedSkillIds: [],
      disabledSkillIds: [],
      allowedMcpServerIds: [],
      memoryEnabled: true,
      runbooksEnabled: true,
      collaborationEnabled: true,
    },
    workspace: {
      workspaceNoun: "Research workspace",
      subjectNoun: "Research subject",
      boundaryNoun: "Research boundary",
      authorizationMode: "optional",
      boundaryInstructions: ["Stay within the recorded materials and systems."],
      materialKinds: ["path", "documentation", "dataset"],
    },
    modelJobs: {},
    presentation: {
      newResearchLabel: "New Study",
      memoryLabel: "Memory",
      runbookLabel: "Runbooks",
      sessionLabel: "Study Session",
    },
  };
}
