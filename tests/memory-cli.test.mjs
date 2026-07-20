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

test("main CLI defaults to real mode and preflights auth", async () => {
  const authFile = await createEmptyAuthFilePath();
  const result = runTopCli(["-p", "Goal: Check real-mode preflight"], {
    HONEYCRISP_AUTH_FILE: authFile,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No authorized model provider found/);
  assert.match(result.stderr, /--config <path>/);
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
  assert.deepEqual(sectionLabels, ["workspace", "memory", "selected_skills"]);
  assert.equal(memorySection.content[0].id, memory.id);
  assert.equal(memorySection.content[0].evidence[0].path, "Src/Modules/zftp.c");
  assert.equal("storage" in contextEvent.payload, false);
  assert.equal("toolPermissions" in contextEvent.payload, false);
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
      "memory.correct",
      "memory.get",
      "memory.link",
      "memory.save",
      "memory.search",
      "repository.search",
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
    "memory.search",
    "memory.get",
    "memory.save",
    "memory.correct",
    "memory.link",
  ]);
  assert.deepEqual(disabledPayload.toolFamilies.disabled, [
    "repository-search",
    "file-read",
    "code",
  ]);
  assert.equal(workspaceDefault.status, 0, workspaceDefault.stderr);
  assert.deepEqual(
    workspaceDefaultPayload.tools.map((tool) => tool.name),
    ["memory.search", "memory.get", "memory.save", "memory.correct", "memory.link", "repository.search"],
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
    assert.deepEqual(payload.toolFamilies.enabled, ["experiment"]);
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
    assert.deepEqual(payload.mcp.configuredServers, ["fixture"]);
    assert.deepEqual(payload.mcp.allowedServers, ["fixture"]);
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
  assert.deepEqual(capture.runtimeConfig.skills.selectedIds, ["parser-cli"]);
  assert.equal(capture.runtimeConfig.governance.maxToolCalls, 2);
  assert.equal(capture.schemaVersion, 4);
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
  const finding = runMemoryCliJson("save", "finding", "Parser state reuse", "--workspace-root", workspaceRoot, "--summary", "State reuse was reproduced.", "--status", "confirmed", "--asset", "asset_api");

  const search = runMemoryCliJson("search", "parser", "--workspace-root", workspaceRoot);
  assert.deepEqual(search.map((node) => node.id).sort(), [finding.id, hypothesis.id].sort());

  const corrected = runMemoryCliJson("correct", hypothesis.id, "--workspace-root", workspaceRoot, "--expected-revision", "1", "--status", "rejected", "--summary", "Cleanup covers the suspected path.");
  assert.equal(corrected.status, "rejected");
  assert.equal(corrected.revision, 2);

  const edge = runMemoryCliJson("link", hypothesis.id, finding.id, "promoted_to", "--workspace-root", workspaceRoot, "--summary", "Reproduction created a finding.");
  assert.equal(edge.relation, "promoted_to");

  const state = runMemoryCliJson("state", "--workspace-root", workspaceRoot);
  assert.equal(state.nodeCount, 2);
  assert.equal(state.edgeCount, 1);
  assert.deepEqual(state.typeCounts, { finding: 1, hypothesis: 1 });
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

async function createCliMcpFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-cli-mcp-"));
  const serverPath = join(root, "fixture-mcp.mjs");
  const configPath = join(root, "mcp.json");
  await writeFile(serverPath, createFixtureMcpServerSource(), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      allowedServers: ["fixture"],
      timeoutMs: 1000,
      servers: {
        fixture: {
          command: process.execPath,
          args: [serverPath],
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
