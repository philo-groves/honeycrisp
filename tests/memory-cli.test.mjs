import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDeterministicMemoryWritePipeline,
  createResearchEventId,
  createSqliteMemoryEventLog,
  createSqliteMemoryRecordStore,
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
  assert.match(result.stdout, /Loop result: complete via deterministic-first-run/);
  assert.match(result.stdout, /Execution mode: deterministic/);
});

test("main CLI persists top-level runtime tool events to sqlite", async () => {
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
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const recordStore = createSqliteMemoryRecordStore({ workspaceRoot });
  const toolEvents = eventLog
    .listAll()
    .filter((event) => event.kind === "tool.requested" || event.kind === "tool.observed");
  const toolRecords = recordStore
    .list()
    .filter((record) => record.sourceEventIds.includes(toolEvents[1]?.id));

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolEvents.map((event) => event.kind), [
      "tool.requested",
      "tool.observed",
    ]);
    assert.match(toolEvents[1]?.payload.summary, /cli parser evidence/);
    assert.ok(toolRecords.some((record) => record.kind === "evidence"));
  } finally {
    eventLog.close();
    recordStore.close();
  }
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
    ["analysis.transform", "repository.search", "storage.list"],
  );
  assert.deepEqual(payload.governance.allowedSideEffects, ["read"]);
  assert.equal(payload.governance.maxToolCalls, 2);
  assert.equal(payload.governance.maxBytes, 200000);
  assert.equal(
    payload.tools.find((tool) => tool.name === "repository.search").metadata.defaultBudget.maxBytes,
    200000,
  );
  assert.deepEqual(payload.mcp.allowedServers, ["alpha"]);
  assert.equal(payload.mcp.status, "no_mcp_client_configured");
  assert.equal(payload.skills.loaded[0].id, "parser-cli");
  assert.deepEqual(payload.skills.selectedIds, ["parser-cli"]);
});

test("tools CLI honors disabled tool families and reports missing required roots", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "honeycrisp-tools-disabled-"));
  const disabled = runTopCli([
    "tools",
    "list",
    "--repo-root",
    repoRoot,
    "--disable-tool-family",
    "repository-search",
    "--json",
  ]);
  const disabledPayload = JSON.parse(disabled.stdout);
  const missingRoot = runTopCli([
    "tools",
    "list",
    "--tool-family",
    "repository-search",
  ]);

  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(disabledPayload.tools, []);
  assert.deepEqual(disabledPayload.toolFamilies.disabled, ["repository-search"]);
  assert.equal(missingRoot.status, 1);
  assert.match(missingRoot.stderr, /repository-search requires --repo-root/);
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
});

test("memory CLI shows subcommand help", () => {
  const result = spawnSync(process.execPath, [cliPath, "memory", "--help"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: honeycrisp memory <command>/);
});

test("memory CLI prints event timelines and records as JSON", async () => {
  const { workspaceRoot, eventId, eventLog, recordStore } = await createCliFixture();

  const timeline = runMemoryCliJson("timeline", "--workspace-root", workspaceRoot);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[1]?.id, eventId);

  const records = runMemoryCliJson(
    "records-for-event",
    eventId,
    "--workspace-root",
    workspaceRoot,
  );
  assert.ok(records.some((record) => record.kind === "semantic_claim"));

  eventLog.close();
  recordStore.close();
});

test("memory CLI prints recall, context, decision, and debug capture data", async () => {
  const { workspaceRoot, eventLog, recordStore } = await createCliFixture();
  const goal = "Goal: Inspect parser memory\nScope constraints: local only";

  const preconscious = runMemoryCliJson(
    "preconscious",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
    "--question",
    "Which parser memory is available?",
  );
  assert.ok(preconscious.candidateCount > 0);

  const context = runMemoryCliJson(
    "context",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.ok(context.sections.some((section) => section.itemCount > 0));

  const decision = runMemoryCliJson(
    "decision",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.equal(typeof decision.actionClass, "string");

  const debugCapture = runMemoryCliJson(
    "debug-capture",
    "--workspace-root",
    workspaceRoot,
    "--goal",
    goal,
  );
  assert.ok(debugCapture.acceptedEvents.length > 0);
  assert.ok(debugCapture.committedWrites.length > 0);
  assert.ok(debugCapture.retrievalResults?.candidateCount);
  assert.ok(debugCapture.contextSelections?.sections.length);
  assert.equal(debugCapture.controllerDecision?.actionClass, decision.actionClass);

  eventLog.close();
  recordStore.close();
});

async function createCliFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-memory-cli-"));
  const eventLog = createSqliteMemoryEventLog({ workspaceRoot });
  const recordStore = createSqliteMemoryRecordStore({ workspaceRoot });
  const events = [
    createEvent("tool.observed", {
      summary: "Parser source was inspected.",
      confidence: 0.95,
    }),
    createEvent("model.claim", {
      claim: "Parser normalization happens before expansion.",
      evidenceRefIds: ["parser_source"],
    }),
    createEvent("user.commitment", {
      commitment: "Keep parser inspection local.",
      trigger: "Before any search action.",
    }),
  ];
  const acceptedEvents = eventLog.appendMany(events);
  const records = createDeterministicMemoryWritePipeline().deriveMany(acceptedEvents);
  recordStore.writeMany(records);

  return {
    workspaceRoot,
    eventId: acceptedEvents[1].id,
    eventLog,
    recordStore,
  };
}

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

function createEvent(kind, payload, options = {}) {
  return {
    id: createResearchEventId(),
    kind,
    timestamp: "2026-06-24T00:00:00.000Z",
    payload,
    ...options,
  };
}
