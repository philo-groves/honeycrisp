import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryGraphStore,
} from "../packages/research-agent/dist/index.js";

const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("models list exposes the installed Pi catalog as JSON", () => {
  const result = runTopCli(["models", "list", "xai", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.providers[0].providerId, "xai");
  assert.ok(output.providers[0].models.some((model) => model.id === "grok-4.3"));
  assert.deepEqual(
    output.providers[0].models.find((model) => model.id === "grok-4.5").effortLevels,
    ["low", "medium", "high"],
  );
});

test("top-level help uses the lightweight dispatcher", async () => {
  const source = await readFile(cliPath, "utf8");
  const result = runTopCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: honeycrisp/);
  assert.doesNotMatch(source, /@honeycrisp\/research-agent/);
  assert.match(source, /import\("\.\/runtime-cli\.js"\)/);
});
test("main CLI defaults to real mode and preflights auth", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(["-p", "Goal: Check real-mode preflight"], {
    HONEYCRISP_AUTH_FILE: authFile,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No authorized model provider found/);
  assert.match(result.stderr, /--config <path>/);
});

test("real cybersecurity runs require a recorded authorization boundary", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(["--provider", "anthropic", "-p", "Inspect the authorized target."], {
    HONEYCRISP_AUTH_FILE: authFile,
    ANTHROPIC_API_KEY: "test-only-key",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cybersecurity research requires a recorded authorization boundary/);
});

test("cybersecurity preflight rejects before MCP subprocess discovery", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-early-preflight-"));
  const mcpConfigPath = join(workspaceRoot, "mcp.json");
  try {
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        allowedServers: ["broken"],
        servers: {
          broken: { command: "definitely-not-a-real-honeycrisp-command" },
        },
      }),
      "utf8",
    );
    const result = runTopCli([
      "--provider",
      "anthropic",
      "--workspace-root",
      workspaceRoot,
      "--mcp-config",
      mcpConfigPath,
      "--allow-mcp-server",
      "broken",
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
      ANTHROPIC_API_KEY: "test-only-key",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cybersecurity research requires a recorded authorization boundary/);
    assert.doesNotMatch(result.stderr, /MCP discovery failed|ENOENT/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
test("Anthropic cybersecurity runs require the host-recorded CVP risk acknowledgement", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-anthropic-cvp-"));
  const contextPath = join(workspaceRoot, "workspace-context.json");
  try {
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceRoot,
        authorization: {
          recorded: true,
          source: "beale",
          scopeId: "scope_anthropic_cvp",
          scopeName: "Authorized Anthropic fixture",
        },
      }),
      "utf8",
    );
    const result = runTopCli([
      "--provider",
      "anthropic",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
      ANTHROPIC_API_KEY: "test-only-key",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires the Cyber Verification Program usage-risk acknowledgement/);
    assert.match(result.stderr, /Beale Settings > Providers/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("OpenAI cybersecurity runs require Trusted Access for Cyber and policy-use acknowledgement", async () => {
  const authFile = await createOpenAiAuthFilePath();
  const { workspaceRoot, contextPath } = await createAuthorizedWorkspaceContext("openai-policy");
  try {
    const result = runTopCli([
      "--provider",
      "openai-codex",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Trusted Access for Cyber membership and policy-use risk acknowledgement/);
    assert.match(result.stderr, /Beale Settings > Providers/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("xAI cybersecurity runs require policy-use risk acknowledgement", async () => {
  const authFile = await createEmptyAuthFilePath();
  const { workspaceRoot, contextPath } = await createAuthorizedWorkspaceContext("xai-policy");
  try {
    const result = runTopCli([
      "--provider",
      "xai",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
      XAI_API_KEY: "test-only-key",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /xAI cybersecurity research requires policy-use risk acknowledgement/);
    assert.match(result.stderr, /Beale Settings > Providers/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Z.ai cybersecurity runs require policy-use risk acknowledgement", async () => {
  const authFile = await createEmptyAuthFilePath();
  const { workspaceRoot, contextPath } = await createAuthorizedWorkspaceContext("zai-policy");
  try {
    const result = runTopCli([
      "--provider",
      "zai",
      "--model",
      "glm-5.3",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
      HONEYCRISP_PROVIDER_AUTH_PREFERENCES: JSON.stringify({ zai: "api_key" }),
      ZAI_API_KEY: "test-only-key",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Z.ai cybersecurity research requires policy-use risk acknowledgement/);
    assert.match(result.stderr, /Beale Settings > Providers/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("OpenRouter cybersecurity runs require routed-provider policy-use risk acknowledgement", async () => {
  const authFile = await createEmptyAuthFilePath();
  const { workspaceRoot, contextPath } = await createAuthorizedWorkspaceContext("openrouter-policy");
  try {
    const result = runTopCli([
      "--provider",
      "openrouter",
      "--model",
      "auto",
      "--workspace-root",
      workspaceRoot,
      "--workspace-context",
      contextPath,
      "-p",
      "Inspect the authorized target.",
    ], {
      HONEYCRISP_AUTH_FILE: authFile,
      OPENROUTER_API_KEY: "test-only-key",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OpenRouter cybersecurity research requires OpenRouter and routed-provider policy-use risk acknowledgement/);
    assert.match(result.stderr, /Beale Settings > Providers/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("main CLI supports deterministic mock mode without auth", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(
    [
      "--mock",
      "-p",
      "Goal: Exercise deterministic mock mode\nScope constraints: test only",
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deterministic agent fixture received:/);
  assert.match(result.stdout, /Exercise deterministic mock mode/);
});

test("main CLI documents goal mode and rejects it with the deterministic executor", async () => {
  const help = runTopCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--goal\s+Continue the same Pi session/);
  assert.match(help.stdout, /--goal-objective <text>\s+Concise persistent objective/);

  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(["--goal", "--mock", "-p", "Keep working."], {
    HONEYCRISP_AUTH_FILE: authFile,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--goal requires the Pi agent executor/);

  const impliedGoal = runTopCli([
    "--goal-objective",
    "Investigate authorization boundaries.",
    "--mock",
    "-p",
    "Expanded research prompt.",
  ], { HONEYCRISP_AUTH_FILE: authFile });
  assert.equal(impliedGoal.status, 1);
  assert.match(impliedGoal.stderr, /--goal requires the Pi agent executor/);
});

test("main CLI accepts and documents shell safety and memory taxonomy configuration", async () => {
  const help = runTopCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--shell-safety-mode <m>/);
  assert.match(help.stdout, /--shell-review-models <json>/);
  assert.match(help.stdout, /--shell-review-effort <level>/);
  assert.match(help.stdout, /--memory-type-descriptions <json>/);
  assert.match(help.stdout, /openai-codex=gpt-5\.6-luna/);
  assert.match(help.stdout, /anthropic=claude-haiku-4-5/);
  assert.match(help.stdout, /xai=grok-4\.3/);

  const authFile = await createEmptyAuthFilePath();
  const reviewModels = JSON.stringify({
    "openai-codex": "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
    xai: "grok-4.3",
  });
  for (const mode of ["manual_approval", "auto_review", "danger"]) {
    const result = runTopCli([
      "--mock",
      "--shell-safety-mode",
      mode,
      "--shell-review-models",
      reviewModels,
      "--shell-review-effort",
      "medium",
      "--memory-type-descriptions",
      JSON.stringify({ primitive: "A custom proven root-cause memory." }),
      "-p",
      "Exercise shell safety parsing.",
    ], { HONEYCRISP_AUTH_FILE: authFile });
    assert.equal(result.status, 0, result.stderr);
  }

  const invalidMode = runTopCli([
    "--mock",
    "--shell-safety-mode",
    "unreviewed",
    "-p",
    "Reject invalid mode.",
  ], { HONEYCRISP_AUTH_FILE: authFile });
  assert.equal(invalidMode.status, 1);
  assert.match(invalidMode.stderr, /--shell-safety-mode must be/);

  const invalidModels = runTopCli([
    "--mock",
    "--shell-review-models",
    "[]",
    "-p",
    "Reject invalid reviewer mapping.",
  ], { HONEYCRISP_AUTH_FILE: authFile });
  assert.equal(invalidModels.status, 1);
  assert.match(invalidModels.stderr, /must be a JSON object/);

  const invalidEffort = runTopCli([
    "--mock",
    "--shell-review-effort",
    "extreme",
    "-p",
    "Reject invalid reviewer effort.",
  ], { HONEYCRISP_AUTH_FILE: authFile });
  assert.equal(invalidEffort.status, 1);
  assert.match(invalidEffort.stderr, /--shell-review-effort must be/);

  const invalidMemoryDescriptions = runTopCli([
    "--mock",
    "--memory-type-descriptions",
    JSON.stringify({ finding: "Unsupported legacy type." }),
    "-p",
    "Reject invalid memory descriptions.",
  ], { HONEYCRISP_AUTH_FILE: authFile });
  assert.equal(invalidMemoryDescriptions.status, 1);
  assert.match(invalidMemoryDescriptions.stderr, /Unsupported memory type description: finding/);
});

test("main CLI uses reconstructed context when a resume capture is unavailable", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-resume-fallback-"));
  const capturePath = join(workspaceRoot, "continued.json");
  const fallbackPromptPath = join(workspaceRoot, "resume-fallback.md");
  const fallbackPrompt = `Reconstructed prior context.\n${"x".repeat(40_000)}\nContinue with the new instruction.`;
  try {
    await writeFile(fallbackPromptPath, fallbackPrompt, "utf8");
    const result = runTopCli(
      [
        "--mock",
        "--workspace-root",
        workspaceRoot,
        "--capture",
        capturePath,
        "--resume-capture",
        join(workspaceRoot, "missing.json"),
        "--resume-fallback-prompt-file",
        fallbackPromptPath,
        "-p",
        "New instruction only.",
      ],
      { HONEYCRISP_AUTH_FILE: authFile },
    );

    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.request.prompt, fallbackPrompt);
    assert.deepEqual(capture.agent.finalDisposition, {
      outcome: "inconclusive",
      summary: capture.agent.outputText,
      blockerDependencies: [],
      externalStateRequired: false,
      recordedAt: capture.agent.finalDisposition.recordedAt,
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("main CLI initializes the durable knowledge graph without treating run events as memory", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-top-cli-memory-"));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-top-cli-tool-"));
  const fixtureFile = join(fixtureRoot, "parse.c");
  await writeFile(fixtureFile, "cli parser evidence\n", "utf8");
  const result = runTopCli(
    [
      "--mock",
      "--workspace-root",
      workspaceRoot,
      "--inspect-root",
      fixtureRoot,
      "-p",
      [
        `Goal: Inspect local parser evidence in ${fixtureFile}`,
        "Scope constraints: local fixture only",
      ].join("\n"),
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );
  const graph = new MemoryGraphStore({ workspaceRoot });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(graph.search(), []);
  } finally {
    graph.close();
  }
});

test("main CLI injects relevant graph memory without storage or tool-policy prompt sections", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-top-cli-context-"));
  const graph = new MemoryGraphStore({ workspaceRoot });
  const memory = graph.save({
    type: "hypothesis",
    title: "ZFTP length boundary",
    summary: "The ZFTP allocation path may accept a negative length.",
    status: "suspected",
    tags: ["zftp"],
    evidence: [{
      kind: "code",
      pathBase: "repository",
      path: "Src/Modules/zftp.c",
      locator: { line: 734 },
      summary: "Length reaches the allocation boundary.",
    }],
  });
  graph.close();

  const result = runTopCli([
    "--mock",
    "--json",
    "--workspace-root",
    workspaceRoot,
    "-p",
    "Continue bounded vulnerability research on the ZFTP length boundary.",
  ]);
  const payload = JSON.parse(result.stdout);
  const sectionLabels = payload.agentRun.modelInput.contextSections.map((section) => section.label);
  const memorySection = payload.agentRun.modelInput.contextSections.find((section) => section.label === "memory");
  const contextEvent = payload.events.find((event) => event.kind === "context.compiled");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sectionLabels, [
    "workspace",
    "memory",
    "campaign",
    "selected_skills",
    "research_profile",
  ]);
  assert.equal(memorySection.content[0].id, memory.id);
  assert.deepEqual(memorySection.content[0].evidenceRefs, [{
    id: memory.evidence[0].id,
    kind: "code",
  }]);
  assert.equal(memorySection.content[0].evidenceCount, 1);
  assert.equal("evidence" in memorySection.content[0], false);
  assert.equal("storage" in contextEvent.payload, false);
  assert.equal("toolPermissions" in contextEvent.payload, false);
  assert.equal(contextEvent.payload.contextMetrics.counts.memoryNodes, 1);
  assert.ok(contextEvent.payload.contextMetrics.sections.memory > 0);
  assert.ok(contextEvent.payload.availableTools.some((tool) => tool.name === "memory.search"));
});

test("main CLI rejects retired run-mode flags with migration hints", () => {
  const realResult = runTopCli(["--real", "-p", "Goal: old flag"]);

  assert.equal(realResult.status, 1);
  assert.match(realResult.stderr, /--real was removed/);
  assert.match(realResult.stderr, /Pass --mock/);
});

test("main CLI treats config as model preference, not authorization", async () => {
  const authFile = await createEmptyAuthFilePath();
  const configRoot = await mkdtemp(join(tmpdir(), "honeycrisp-cli-config-"));
  const configPath = join(configRoot, "research-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      effort: "minimal",
    }),
    "utf8",
  );
  const result = runTopCli(
    [
      "--config",
      configPath,
      "-p",
      "Goal: Config should not authorize a provider",
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not authorized/);
  assert.match(result.stderr, /honeycrisp auth login openai-codex/);
});

test("main CLI loads default project config when --config is omitted", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-cli-default-config-"));
  const configPath = join(workspaceRoot, ".honeycrisp", "config.json");
  await mkdir(join(workspaceRoot, ".honeycrisp"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      effort: "minimal",
    }),
    "utf8",
  );
  const result = runTopCli(
    [
      "--workspace-root",
      workspaceRoot,
      "-p",
      "Goal: Default config should be discovered",
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /selected .*openai-codex.*not authorized/);
});

test("config CLI shows and sets project model preferences", async () => {
  const authFile = await createEmptyAuthFilePath();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-cli-config-set-"));
  const baseEnv = {
    HONEYCRISP_AUTH_FILE: authFile,
  };
  const setProvider = runTopCli(
    [
      "config",
      "set",
      "provider",
      "openai-codex",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ],
    baseEnv,
  );
  const setModel = runTopCli(
    [
      "config",
      "set",
      "model",
      "gpt-5.3-codex-spark",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ],
    baseEnv,
  );
  const setEffort = runTopCli(
    [
      "config",
      "set",
      "effort",
      "minimal",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ],
    baseEnv,
  );
  const show = runTopCli(
    [
      "config",
      "show",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ],
    baseEnv,
  );
  const shown = JSON.parse(show.stdout);
  const written = JSON.parse(
    await readFile(join(workspaceRoot, ".honeycrisp", "config.json"), "utf8"),
  );

  assert.equal(setProvider.status, 0, setProvider.stderr);
  assert.equal(setModel.status, 0, setModel.stderr);
  assert.equal(setEffort.status, 0, setEffort.stderr);
  assert.equal(show.status, 0, show.stderr);
  assert.deepEqual(written, {
    provider: "openai-codex",
    model: "gpt-5.3-codex-spark",
    effort: "minimal",
  });
  assert.equal(shown.exists, true);
  assert.deepEqual(shown.preference, written);
  assert.equal(shown.authorization.authorized, false);
  assert.match(shown.authorization.message, /not authorized/);
});

test("tools CLI lists configured tools, MCP allowlist, governance, and selected skills", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tools-repo-"));
  const skillRoot = await createCliSkillFixture();
  const result = runTopCli([
    "tools",
    "list",
    "--repo-root",
    repoRoot,
    "--tool-family",
    "analysis",
    "--tool-family",
    "storage",
    "--workspace-root",
    repoRoot,
    "--allowed-side-effect",
    "read",
    "--tool-max-calls",
    "2",
    "--tool-max-bytes",
    "200000",
    "--allow-mcp-server",
    "alpha",
    "--skill-dir",
    skillRoot,
    "--skill",
    "parser-cli",
    "--json",
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    payload.tools.map((tool) => tool.name).sort(),
    [
      "analysis.transform",
      "code.call_candidates",
      "code.detect",
      "code.node_context",
      "code.outline",
      "code.query",
      "code.references",
      "file.read",
      "finding.create",
      "finding.list",
      "finding.transition",
      "memory.correct",
      "memory.get",
      "memory.link",
      "memory.save",
      "memory.search",
      "report.create",
      "report.get",
      "report.list",
      "report.revise",
      "repository.search",
      "runbook.append",
      "runbook.create",
      "runbook.get",
      "runbook.list",
      "runbook.run",
      "session.disposition",
      "shell.run",
      "storage.list",
    ],
  );
  assert.deepEqual(payload.governance.allowedSideEffects, ["read"]);
  assert.equal(payload.governance.maxToolCalls, 2);
  assert.equal(payload.governance.maxBytes, 200000);
  assert.equal(
    payload.tools.find((tool) => tool.name === "repository.search").metadata.defaultBudget.maxBytes,
    200000,
  );
  assert.equal(
    payload.tools.find((tool) => tool.name === "code.outline").metadata.parser,
    "tree-sitter",
  );
  assert.deepEqual(payload.mcp.allowedServers, ["alpha"]);
  assert.equal(payload.mcp.status, "no_mcp_client_configured");
  assert.equal(payload.skills.loaded[0].id, "parser-cli");
  assert.deepEqual(payload.skills.selectedIds, ["parser-cli"]);
});

test("tools config CLI persists skill and MCP preferences used by tools list", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tools-config-"));
  const skillRoot = await createCliSkillFixture();
  const mcpFixture = await createCliMcpFixture();

  try {
    const addSkillDir = runTopCli([
      "tools",
      "config",
      "add",
      "skill-dir",
      skillRoot,
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const addSkill = runTopCli([
      "tools",
      "config",
      "add",
      "skill",
      "parser-cli",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const setMcp = runTopCli([
      "tools",
      "config",
      "set",
      "mcp-config",
      mcpFixture.configPath,
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const allowMcp = runTopCli([
      "tools",
      "config",
      "add",
      "allow-mcp-server",
      "fixture",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const list = runTopCli([
      "tools",
      "list",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const payload = JSON.parse(list.stdout);
    const removeSkill = runTopCli([
      "tools",
      "config",
      "remove",
      "skill",
      "parser-cli",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const clearMcp = runTopCli([
      "tools",
      "config",
      "clear",
      "mcp-config",
      "--workspace-root",
      workspaceRoot,
      "--json",
    ]);
    const shown = JSON.parse(
      runTopCli([
        "tools",
        "config",
        "show",
        "--workspace-root",
        workspaceRoot,
        "--json",
      ]).stdout,
    );

    assert.equal(addSkillDir.status, 0, addSkillDir.stderr);
    assert.equal(addSkill.status, 0, addSkill.stderr);
    assert.equal(setMcp.status, 0, setMcp.stderr);
    assert.equal(allowMcp.status, 0, allowMcp.stderr);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(removeSkill.status, 0, removeSkill.stderr);
    assert.equal(clearMcp.status, 0, clearMcp.stderr);
    assert.equal(payload.toolConfig.exists, true);
    assert.deepEqual(payload.toolConfig.preference.skillDirs, [skillRoot]);
    assert.deepEqual(payload.skills.selectedIds, ["parser-cli"]);
    assert.equal(payload.mcp.status, "configured");
    assert.deepEqual(payload.mcp.allowedServers, ["fixture"]);
    assert.deepEqual(payload.mcp.deniedConfiguredServers, ["denied"]);
    assert.ok(
      payload.tools.some((tool) => tool.name === "mcp.fixture.echo_search"),
    );
    assert.deepEqual(shown.preference.selectedSkillIds ?? [], []);
    assert.equal(shown.preference.mcpConfigPath, undefined);
    assert.deepEqual(shown.preference.allowedMcpServers, ["fixture"]);
  } finally {
    await rm(mcpFixture.root, { recursive: true, force: true });
  }
});

test("tools CLI honors disabled tool families and treats repository roots as context hints", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tools-disabled-"));
  const disabled = runTopCli([
    "tools",
    "list",
    "--repo-root",
    repoRoot,
    "--disable-tool-family",
    "repository-search",
    "--disable-tool-family",
    "file-read",
    "--disable-tool-family",
    "code",
    "--json",
  ]);
  const disabledPayload = JSON.parse(disabled.stdout);
  const workspaceDefault = runTopCli([
    "tools",
    "list",
    "--tool-family",
    "repository-search",
    "--workspace-root",
    repoRoot,
    "--json",
  ]);
  const workspaceDefaultPayload = JSON.parse(workspaceDefault.stdout);

  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(disabledPayload.tools.map((tool) => tool.name), [
    "session.disposition",
    "memory.search",
    "memory.get",
    "memory.save",
    "memory.correct",
    "memory.link",
    "finding.list",
    "finding.create",
    "finding.transition",
    "runbook.list",
    "runbook.get",
    "runbook.create",
    "runbook.append",
    "report.list",
    "report.get",
    "report.create",
    "report.revise",
    "shell.run",
    "runbook.run",
  ]);
  assert.deepEqual(disabledPayload.toolFamilies.disabled, [
    "repository-search",
    "file-read",
    "code",
  ]);
  assert.equal(workspaceDefault.status, 0, workspaceDefault.stderr);
  assert.deepEqual(
    workspaceDefaultPayload.tools.map((tool) => tool.name),
    ["session.disposition", "memory.search", "memory.get", "memory.save", "memory.correct", "memory.link", "finding.list", "finding.create", "finding.transition", "runbook.list", "runbook.get", "runbook.create", "runbook.append", "report.list", "report.get", "report.create", "report.revise", "shell.run", "repository.search", "file.read", "runbook.run"],
  );
  assert.equal(
    workspaceDefaultPayload.workspaceContext.workspaceRoot,
    repoRoot,
  );
});

test("tools CLI requires experiment config and lists configured experiments", async () => {
  const fixture = await createCliExperimentFixture();
  try {
    const missingConfig = runTopCli([
      "tools",
      "list",
      "--tool-family",
      "experiment",
    ]);
    const listed = runTopCli([
      "tools",
      "list",
      "--tool-family",
      "experiment",
      "--experiment-config",
      fixture.configPath,
      "--workspace-root",
      fixture.workspaceRoot,
      "--json",
    ]);
    const payload = JSON.parse(listed.stdout);

    assert.equal(missingConfig.status, 1);
    assert.match(missingConfig.stderr, /requires --experiment-config/);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(payload.tools.some((tool) => tool.name === "experiment.run"));
    assert.deepEqual(payload.toolFamilies.enabled, ["shell", "repository-search", "file-read", "experiment"]);
    assert.equal(
      payload.tools.find((tool) => tool.name === "experiment.run").metadata.experiments[0].name,
      "echo",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("tools CLI discovers configured live MCP servers", async () => {
  const fixture = await createCliMcpFixture();
  try {
    const result = runTopCli([
      "tools",
      "list",
      "--mcp-config",
      fixture.configPath,
      "--allow-mcp-server",
      "fixture",
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(payload.mcp.status, "configured");
    assert.deepEqual(payload.mcp.configuredServers, ["fixture", "denied"]);
    assert.deepEqual(payload.mcp.allowedServers, ["fixture"]);
    assert.deepEqual(payload.mcp.deniedConfiguredServers, ["denied"]);
    assert.ok(
      payload.tools.some((tool) => tool.name === "mcp.fixture.echo_search"),
    );
    assert.ok(
      payload.mcp.discoveredCapabilities.some(
        (tool) => tool.name === "mcp.fixture.echo_search",
      ),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("research runs defer Beale management tools until the prompt requests them", async () => {
  const fixture = await createCliMcpFixture("beale-introspection.beale");
  const authFile = await createEmptyAuthFilePath();
  const researchCapturePath = join(fixture.root, "research-capture.json");
  const managementCapturePath = join(fixture.root, "management-capture.json");
  try {
    const research = runTopCli([
      "--mock",
      "--capture",
      researchCapturePath,
      "--workspace-root",
      fixture.root,
      "--mcp-config",
      fixture.configPath,
      "--allow-mcp-server",
      "beale-introspection.beale",
      "-p",
      "Inspect the parser boundary using the available workspace resources for memory safety issues.",
    ], { HONEYCRISP_AUTH_FILE: authFile });
    assert.equal(research.status, 0, research.stderr);
    const researchCapture = JSON.parse(await readFile(researchCapturePath, "utf8"));
    assert.equal(
      researchCapture.runtimeConfig.tools.some((tool) => tool.name === "mcp.beale-introspection.beale.echo_search"),
      false,
    );
    assert.deepEqual(
      researchCapture.runtimeConfig.modelToolCuration.deferredToolNames,
      ["mcp.beale-introspection.beale.echo_search"],
    );
    assert.ok(
      researchCapture.runtimeConfig.mcp.discoveredCapabilities.some(
        (tool) => tool.name === "mcp.beale-introspection.beale.echo_search",
      ),
    );

    const management = runTopCli([
      "--mock",
      "--capture",
      managementCapturePath,
      "--workspace-root",
      fixture.root,
      "--mcp-config",
      fixture.configPath,
      "--allow-mcp-server",
      "beale-introspection.beale",
      "-p",
      "List the workspace resources for this research session.",
    ], { HONEYCRISP_AUTH_FILE: authFile });
    assert.equal(management.status, 0, management.stderr);
    const managementCapture = JSON.parse(await readFile(managementCapturePath, "utf8"));
    assert.ok(
      managementCapture.runtimeConfig.tools.some((tool) => tool.name === "mcp.beale-introspection.beale.echo_search"),
    );
    assert.deepEqual(
      managementCapture.runtimeConfig.modelToolCuration.deferredToolNames,
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("main CLI capture includes runtime tool and skill configuration", async () => {
  const authFile = await createEmptyAuthFilePath();
  const repoRoot = await mkdtemp(join(tmpdir(), "honeycrisp-capture-repo-"));
  const skillRoot = await createCliSkillFixture();
  const capturePath = join(repoRoot, "capture.json");
  const result = runTopCli(
    [
      "--mock",
      "--capture",
      capturePath,
      "--repo-root",
      repoRoot,
      "--tool-family",
      "analysis",
      "--allowed-side-effect",
      "read",
      "--tool-max-calls",
      "2",
      "--skill-dir",
      skillRoot,
      "--skill",
      "parser-cli",
      "-p",
      "Goal: List configured parser tools\nScope constraints: local fixture only",
    ],
    {
      HONEYCRISP_AUTH_FILE: authFile,
    },
  );
  const capture = JSON.parse(await readFile(capturePath, "utf8"));

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    capture.runtimeConfig.tools.some(
      (tool) => tool.name === "repository.search",
    ),
  );
  assert.ok(
    capture.runtimeConfig.tools.some(
      (tool) => tool.name === "analysis.transform",
    ),
  );
  assert.ok(capture.runtimeConfig.tools.some((tool) => tool.name === "session.disposition"));
  assert.deepEqual(capture.runtimeConfig.skills.selectedIds, ["parser-cli"]);
  assert.equal(capture.runtimeConfig.governance.maxToolCalls, 2);
  assert.equal(capture.schemaVersion, 5);
  assert.ok(capture.context.availableTools.some((tool) => tool.name === "repository.search"));
  assert.equal("toolPermissions" in capture.context, false);
  assert.equal("workspaceRoot" in capture.context.workspaceContext, false);
  assert.equal("memory" in capture.runtimeConfig.workspaceContext, false);
  assert.equal(JSON.stringify(capture.runtimeConfig.workspaceContext).includes("prospective"), false);
});

test("memory CLI shows subcommand help", () => {
  const result = spawnSync(process.execPath, [cliPath, "memory", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: honeycrisp memory <command>/);
});

test("memory CLI saves, searches, corrects, and links durable knowledge", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-cli-"));
  const hypothesis = runMemoryCliJson("save", "hypothesis", "Parser state crosses requests", "--workspace-root", workspaceRoot, "--summary", "Shared state may survive cleanup.", "--status", "suspected", "--tag", "parser");
  const trajectory = runMemoryCliJson("save", "trajectory", "Parser state reuse", "--workspace-root", workspaceRoot, "--summary", "State reuse investigation route was productive.", "--status", "confirmed", "--asset", "asset_api");

  const search = runMemoryCliJson("search", "parser", "--workspace-root", workspaceRoot);
  assert.deepEqual(search.map((node) => node.id).sort(), [trajectory.id, hypothesis.id].sort());

  const corrected = runMemoryCliJson("correct", hypothesis.id, "--workspace-root", workspaceRoot, "--expected-revision", "1", "--status", "rejected", "--summary", "Cleanup covers the suspected path.");
  assert.equal(corrected.status, "rejected");
  assert.equal(corrected.revision, 2);

  const edge = runMemoryCliJson("link", hypothesis.id, trajectory.id, "informed", "--workspace-root", workspaceRoot, "--summary", "The hypothesis informed a reusable trajectory.");
  assert.equal(edge.relation, "informed");

  const reclassified = runMemoryCliJson("correct", hypothesis.id, "--workspace-root", workspaceRoot, "--expected-revision", "2", "--type", "primitive");
  assert.equal(reclassified.type, "primitive");
  assert.match(reclassified.id, /^primitive_/);

  const state = runMemoryCliJson("state", "--workspace-root", workspaceRoot);
  assert.equal(state.nodeCount, 2);
  assert.equal(state.edgeCount, 1);
  assert.deepEqual(state.typeCounts, { primitive: 1, trajectory: 1 });
  assert.ok(state.edges.some((stateEdge) => stateEdge.fromId === reclassified.id && stateEdge.toId === trajectory.id));
});

test("memory CLI requires revision guards for corrections", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-cli-revision-"));
  const node = runMemoryCliJson("save", "invariant", "Length is validated", "--workspace-root", workspaceRoot);
  const result = spawnSync(process.execPath, [cliPath, "memory", "correct", node.id, "--workspace-root", workspaceRoot, "--status", "confirmed", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --expected-revision/);
});

function runMemoryCliJson(...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "memory", ...args, "--json"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runTopCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function createEmptyAuthFilePath() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-auth-empty-"));
  return join(root, "auth.json");
}

async function createOpenAiAuthFilePath() {
  const authFile = await createEmptyAuthFilePath();
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const access = `header.${Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString("base64url")}.signature`;
  await writeFile(authFile, JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: expiresAtSeconds * 1000,
      accountId: "test-account",
    },
  }), "utf8");
  return authFile;
}

async function createAuthorizedWorkspaceContext(label) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `honeycrisp-${label}-`));
  const contextPath = join(workspaceRoot, "workspace-context.json");
  await writeFile(
    contextPath,
    JSON.stringify({
      schemaVersion: 1,
      workspaceRoot,
      authorization: {
        recorded: true,
        source: "beale",
        scopeId: `scope_${label}`,
        scopeName: `Authorized ${label} fixture`,
      },
    }),
    "utf8",
  );
  return { workspaceRoot, contextPath };
}

async function createCliSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-cli-skills-"));
  const skillDir = join(root, "parser-cli");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "# Parser CLI Skill",
      "Id: parser-cli",
      "Version: 0.1",
      "Description: Parser CLI test skill",
      "Domain tags: parser, cli",
      "Recommended tools: repository.search",
      "Recommended action classes: search",
      "Runbook: Preserve configured tool provenance.",
      "---",
      "Use configured tools and keep provenance visible.",
    ].join("\n"),
    "utf8",
  );

  return root;
}

async function createCliMcpFixture(serverName = "fixture") {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-cli-mcp-"));
  const serverPath = join(root, "fixture-mcp.mjs");
  const configPath = join(root, "mcp.json");
  await writeFile(serverPath, createFixtureMcpServerSource(), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      allowedServers: [serverName],
      timeoutMs: 1000,
      servers: {
        [serverName]: {
          command: process.execPath,
          args: [serverPath],
        },
        denied: {
          command: "definitely-not-a-real-honeycrisp-command",
        },
      },
    }),
    "utf8",
  );

  return { root, configPath };
}

async function createCliExperimentFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-cli-experiment-"));
  const workspaceRoot = join(root, "workspace");
  const scriptPath = join(root, "experiment.mjs");
  const configPath = join(root, "experiments.json");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    scriptPath,
    "process.stdin.resume(); process.stdin.on('end', () => console.log('ok'));",
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify({
      experiments: {
        echo: {
          command: process.execPath,
          args: [scriptPath],
          sideEffects: "process",
          requiredPermissions: ["fixture:run"],
          timeoutMs: 1000,
          maxOutputBytes: 4000,
        },
      },
    }),
    "utf8",
  );

  return { root, workspaceRoot, configPath };
}

function createFixtureMcpServerSource() {
  return `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(message) {
  if (!message.id) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "0.1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo_search", description: "Search echo fixture", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + message.params.arguments.query }] } });
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
}
`;
}
