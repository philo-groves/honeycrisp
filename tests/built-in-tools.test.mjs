import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createAnalysisTool,
  createCodeIntelligenceTools,
  createDefaultBuiltInToolFamily,
  createExperimentTool,
  createRepositorySearchTool,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createShellTool,
  createToolResultMessage,
  createStorageListTool,
  createStructuredFileReadTool,
  createSynthesisTool,
  ensureResearchStorageLayout,
  modelToolResultDetails,
  registerResearchStorageArtifact,
} from "../packages/research-agent/dist/index.js";

const allowShell = async (request) => approvedAuthorization(request);

function approvedAuthorization(request) {
  return {
    approvalRequestId: "fixture_" + request.actionId,
    actionId: request.actionId,
    mode: "danger",
    decision: "approved",
    source: "danger",
    reason: "Danger Mode test fixture.",
    command: {
      commandHash: "sha256:fixture",
      utility: request.utility,
      args: request.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      stdinPresent: request.stdin !== undefined,
      stdinBytes: request.stdin?.length ?? 0,
    },
  };
}

test("shell tool enforces disabled utilities before spawning and captures argv output", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-tool-"));
  const optionsPath = join(root, "shell-options.json");
  const protectedDirectory = join(root, "protected-core");
  const protectedChildDirectory = join(protectedDirectory, "nested");
  const disposableDirectory = join(root, "build-output");
  await mkdir(protectedChildDirectory, { recursive: true });
  await mkdir(disposableDirectory);
  await writeFile(optionsPath, JSON.stringify({
    schemaVersion: 1,
    defaultConcurrency: 2,
    utilities: { sudo: 0 },
    leaseDirectory: join(root, "leases"),
  }));

  try {
    const registry = createResearchToolRegistry([
      createShellTool({
        workspaceRoot: root,
        shellOptionsPath: optionsPath,
        protectedDirectories: [protectedDirectory],
        authorize: allowShell,
      }),
    ]);
    const disabled = await registry.execute({
      id: "shell_disabled",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "sudo", args: ["true"] },
    });
    const completed = await registry.execute({
      id: "shell_completed",
      actionClass: "inspect",
      toolName: "shell.run",
      input: { utility: "printf", args: ["%s", "argv-safe"] },
    });
    const homeReference = await registry.execute({
      id: "shell_home_reference",
      actionClass: "inspect",
      toolName: "shell.run",
      input: { utility: "printf", args: ["%s", "${HOME:-/}"] },
    });
    const homeAssignment = await registry.execute({
      id: "shell_home_assignment",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "env", args: ["HOME=/tmp", "printf", "safe"] },
    });
    const environment = await registry.execute({
      id: "shell_environment",
      actionClass: "inspect",
      toolName: "shell.run",
      input: {
        utility: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => ['HOME', 'CODEX_HOME', 'HOMEDRIVE', 'HOMEPATH'].includes(name.toUpperCase())))))",
        ],
      },
    });
    const protectedDelete = await registry.execute({
      id: "shell_protected_delete",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "rm", args: ["-rf", protectedDirectory] },
    });
    const workspaceDelete = await registry.execute({
      id: "shell_workspace_delete",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "rm", args: ["-rf", root] },
    });
    const protectedChildDelete = await registry.execute({
      id: "shell_protected_child_delete",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "rmdir", args: [protectedChildDirectory] },
    });
    const findDelete = await registry.execute({
      id: "shell_find_delete",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "find", args: [protectedDirectory, "-depth", "-delete"] },
    });
    const gitClean = await registry.execute({
      id: "shell_git_clean",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "git", args: ["-C", root, "clean", "-fdx"] },
    });
    const disposableDelete = await registry.execute({
      id: "shell_disposable_delete",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "rm", args: ["-rf", disposableDirectory] },
    });

    assert.equal(disabled.result.status, "error");
    assert.match(disabled.result.error.message, /disabled by the harness-wide/);
    assert.equal(completed.result.status, "complete");
    assert.equal(completed.result.output.stdout, "argv-safe");
    assert.equal(completed.result.output.cwd, root);
    assert.equal(homeReference.result.status, "error");
    assert.match(homeReference.result.error.message, /cannot reference or assign \$HOME/);
    assert.equal(homeAssignment.result.status, "error");
    assert.match(homeAssignment.result.error.message, /cannot reference or assign \$HOME/);
    assert.equal(environment.result.status, "complete");
    const homeEnvironment = JSON.parse(environment.result.output.stdout);
    if (process.platform === "win32") {
      assert.equal(
        resolve(`${homeEnvironment.HOMEDRIVE}${homeEnvironment.HOMEPATH}`),
        resolve(root),
      );
      assert.equal("HOME" in homeEnvironment, false);
      assert.equal("CODEX_HOME" in homeEnvironment, false);
    } else {
      assert.deepEqual(homeEnvironment, {});
    }
    assert.equal(protectedDelete.result.status, "error");
    assert.match(protectedDelete.result.error.message, /Folder delete guard blocked rm/);
    assert.equal(workspaceDelete.result.status, "error");
    assert.match(workspaceDelete.result.error.message, /Folder delete guard blocked rm/);
    assert.equal(protectedChildDelete.result.status, "error");
    assert.match(protectedChildDelete.result.error.message, /Folder delete guard blocked rmdir/);
    assert.equal(findDelete.result.status, "error");
    assert.match(findDelete.result.error.message, /Folder delete guard blocked find/);
    assert.equal(gitClean.result.status, "error");
    assert.match(gitClean.result.error.message, /Folder delete guard blocked git/);
    assert.equal(disposableDelete.result.status, "complete");
    await access(protectedDirectory);
    await assert.rejects(access(disposableDirectory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell tool serializes the same utility across tool instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-concurrency-"));
  const optionsPath = join(root, "shell-options.json");
  await writeFile(optionsPath, JSON.stringify({
    schemaVersion: 1,
    defaultConcurrency: 4,
    utilities: { node: 1 },
    leaseDirectory: join(root, "leases"),
  }));

  try {
    const first = createResearchToolRegistry([
      createShellTool({ workspaceRoot: root, shellOptionsPath: optionsPath, authorize: allowShell }),
    ]);
    const second = createResearchToolRegistry([
      createShellTool({ workspaceRoot: root, shellOptionsPath: optionsPath, authorize: allowShell }),
    ]);
    const startedAt = Date.now();
    const results = await Promise.all([
      first.execute({
        id: "node_1",
        actionClass: "experiment",
        toolName: "shell.run",
        input: { utility: "node", args: ["-e", "setTimeout(() => {}, 150)"] },
      }),
      second.execute({
        id: "node_2",
        actionClass: "experiment",
        toolName: "shell.run",
        input: { utility: "node", args: ["-e", "setTimeout(() => {}, 150)"] },
      }),
    ]);

    assert.ok(results.every((result) => result.result.status === "complete"));
    assert.ok(Date.now() - startedAt >= 250, "same-utility calls should not overlap at concurrency 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell tool terminates descendant processes when a command times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-timeout-"));
  try {
    const registry = createResearchToolRegistry([
      createShellTool({ workspaceRoot: root, authorize: allowShell }),
    ]);
    const startedAt = Date.now();
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(`${child.pid}\\n`);",
      "setInterval(() => {}, 1000);",
    ].join("");
    const timedOut = await registry.execute({
      id: "shell_timeout_tree",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "node", args: ["-e", parentScript], timeoutMs: 250 },
    });

    assert.equal(timedOut.result.status, "error");
    assert.match(timedOut.result.error.message, /timed out/);
    assert.ok(Date.now() - startedAt < 5_000, "timed-out descendant must not hold the tool output pipes open");
    const descendantPid = Number.parseInt(timedOut.result.output.stdout.trim(), 10);
    assert.ok(Number.isInteger(descendantPid));
    await assertProcessExited(descendantPid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell tool blocks denied commands before spawn and keeps hard guards ahead of authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-denied-"));
  const marker = join(root, "spawned.txt");
  const protectedDirectory = join(root, "protected");
  await mkdir(protectedDirectory);
  const requests = [];
  const authorize = async (request) => {
    requests.push(request);
    return {
      ...approvedAuthorization(request),
      mode: "manual_approval",
      decision: "denied",
      source: "human",
      reason: "Fixture denial.",
    };
  };
  try {
    const registry = createResearchToolRegistry([
      createShellTool({
        workspaceRoot: root,
        protectedDirectories: [protectedDirectory],
        authorize,
      }),
    ]);
    const denied = await registry.execute({
      id: "shell_denied_before_spawn",
      actionClass: "experiment",
      toolName: "shell.run",
      input: {
        utility: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'spawned')",
        ],
        cwd: ".",
        stdin: "token=secret-value",
        timeoutMs: 1_000,
      },
    });
    assert.equal(denied.result.status, "blocked");
    assert.match(denied.result.summary, /denied by Manual Approval/);
    await assert.rejects(access(marker));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].cwd, root);
    assert.equal(requests[0].stdin, "token=secret-value");

    const hardGuarded = await registry.execute({
      id: "shell_guard_before_authorizer",
      actionClass: "experiment",
      toolName: "shell.run",
      input: { utility: "rm", args: ["-rf", protectedDirectory] },
    });
    assert.equal(hardGuarded.result.status, "error");
    assert.equal(requests.length, 1);
    await access(protectedDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell capture events and tool results omit stdin and redact credential argv values", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-redaction-"));
  const secrets = [
    "raw-stdin-secret",
    "password-argv-secret",
    "token-argv-secret",
    "header-argv-secret",
    "user-password-secret",
    "cookie-pair-secret",
    "cookie-short-secret",
    "cookie-header-secret",
  ];
  try {
    const registry = createResearchToolRegistry([
      createShellTool({ workspaceRoot: root, authorize: allowShell }),
    ]);
    const record = await registry.execute({
      id: "shell_sanitized_transport",
      actionClass: "experiment",
      toolName: "shell.run",
      input: {
        utility: "node",
        args: [
          "-e",
          "",
          "--",
          "--password",
          secrets[1],
          "--token",
          secrets[2],
          "-H",
          `Authorization: Basic ${secrets[3]}`,
          "--user",
          `researcher:${secrets[4]}`,
          "--cookie",
          `session=${secrets[5]}`,
          "-b",
          secrets[6],
          "--header",
          `Cookie: session=${secrets[7]}`,
        ],
        cwd: ".",
        stdin: secrets[0],
        timeoutMs: 1_000,
      },
    });
    assert.equal(record.result.status, "complete");
    const toolResult = createToolResultMessage(record.result, record.action.id, "shell_run");
    const captured = JSON.stringify({ record, toolResult });
    for (const secret of secrets) assert.doesNotMatch(captured, new RegExp(secret));

    for (const event of record.events) {
      const normalized = event.payload.normalizedInputs;
      assert.equal("stdin" in normalized, false);
      assert.equal(normalized.stdinPresent, true);
      assert.equal(normalized.stdinBytes, Buffer.byteLength(secrets[0]));
      assert.match(normalized.stdinHash, /^sha256:/);
      assert.equal(normalized.timeoutMs, 1_000);
    }
    assert.deepEqual(record.action.input.args.slice(3), [
      "--password",
      "[REDACTED]",
      "--token",
      "[REDACTED]",
      "-H",
      "Authorization: [REDACTED]",
      "--user",
      "[REDACTED]",
      "--cookie",
      "[REDACTED]",
      "-b",
      "[REDACTED]",
      "--header",
      "Cookie: [REDACTED]",
    ]);
    assert.deepEqual(record.result.output.args, record.action.input.args);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-result details retain bounded metadata without the full execution payload", () => {
  const result = {
    action: {
      id: "bounded_details",
      actionClass: "inspect",
      toolName: "fixture.inspect",
      input: { marker: "action-input-must-not-be-retained" },
    },
    status: "error",
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: "2026-08-05T12:00:01.000Z",
    summary: "Fixture inspection failed.",
    output: { marker: "full-output-remains-in-content" },
    rawOutputRef: "raw://fixture-output",
    artifactRefs: [
      {
        id: "artifact_fixture",
        kind: "inspection",
        uri: "artifact://fixture",
      },
    ],
    followUpActions: ["Inspect the captured artifact."],
    error: { message: "Fixture failure." },
  };
  const expectedDetails = {
    status: "error",
    summary: "Fixture inspection failed.",
    rawOutputRef: "raw://fixture-output",
    artifactRefs: result.artifactRefs,
    followUpActions: result.followUpActions,
    error: { message: "Fixture failure." },
  };

  assert.deepEqual(modelToolResultDetails(result), expectedDetails);

  const message = createToolResultMessage(
    result,
    "tool_call_bounded_details",
    "fixture_inspect",
  );
  assert.deepEqual(message.details, expectedDetails);
  assert.equal("action" in message.details, false);
  assert.equal("output" in message.details, false);
  assert.equal("startedAt" in message.details, false);
  assert.equal("completedAt" in message.details, false);
  assert.match(message.content[0].text, /full-output-remains-in-content/);
});

test("tool runtime budget aborts a pending approval before any later spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-shell-budget-"));
  const marker = join(root, "late-spawn.txt");
  let approve;
  const authorize = (request) => new Promise((resolveApproval) => {
    approve = () => resolveApproval(approvedAuthorization(request));
  });
  try {
    const registry = createResearchToolRegistry([
      createShellTool({ workspaceRoot: root, authorize }),
    ]);
    const result = await registry.execute({
      id: "shell_late_approval",
      actionClass: "experiment",
      toolName: "shell.run",
      input: {
        utility: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'spawned')",
        ],
      },
    }, {
      governance: { maxRuntimeMs: 25 },
    });
    assert.equal(result.result.status, "blocked");
    assert.match(result.result.summary, /runtime budget exceeded/);
    assert.equal(typeof approve, "function");
    approve();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository search finds bounded local source matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-repo-search-"));
  await mkdir(join(root, "Src"));
  await mkdir(join(root, ".honeycrisp", "memory"), { recursive: true });
  await mkdir(join(root, ".beale"), { recursive: true });
  await writeFile(
    join(root, "Src", "parse.c"),
    "static void parse_context_save(void) {}\nparse_context_save();\n",
  );
  await writeFile(
    join(root, ".honeycrisp", "memory", "memory.sqlite-wal"),
    "parse_context_save stale internal memory hit\n",
  );
  await writeFile(
    join(root, ".beale", "beale.sqlite-wal"),
    "parse_context_save stale interface state hit\n",
  );
  await writeFile(join(root, "README.md"), "no parser symbol here\n");

  try {
    const tool = createRepositorySearchTool({
      root,
      maxResults: 1,
      maxFileBytes: 1024,
    });
    const result = await createResearchToolRegistry([tool]).execute({
      id: "search_1",
      actionClass: "search",
      toolName: "repository.search",
      input: {
        query: "parse_context_save",
      },
    });

    assert.equal(result.result.status, "complete");
    assert.equal(result.result.output.matches.length, 1);
    assert.equal(result.result.output.matches[0].path, "Src/parse.c");
    assert.ok(
      result.result.output.matches.every(
        (match) =>
          !match.path.startsWith(".honeycrisp/") &&
          !match.path.startsWith(".beale/"),
      ),
    );
    assert.equal(result.result.output.matches[0].line, 1);
    assert.equal(tool.descriptor.sideEffects, "read");
    assert.equal(tool.descriptor.requiredPermissions[0], "filesystem:read");
    assert.deepEqual(tool.descriptor.actionClasses, ["search", "inspect"]);

    const inspectResult = await createResearchToolRegistry([tool]).execute({
      id: "inspect_search_1",
      actionClass: "inspect",
      toolName: "repository.search",
      input: {
        query: "parse_context_save",
      },
    });

    assert.equal(inspectResult.result.status, "complete");
    assert.equal(inspectResult.result.output.matches[0].path, "Src/parse.c");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("structured file read supports ranges and annotates paths outside context roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-file-read-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "honeycrisp-file-outside-"));
  const file = join(root, "notes.txt");
  const outsideFile = join(outsideRoot, "outside.txt");
  await writeFile(file, "abcdef\nsecond line\n");
  await writeFile(outsideFile, "outside\n");

  try {
    const tool = createStructuredFileReadTool({
      allowedRoots: [root],
      maxBytes: 4,
    });
    const registry = createResearchToolRegistry([tool]);
    const readResult = await registry.execute({
      id: "read_1",
      actionClass: "inspect",
      toolName: "file.read",
      input: {
        path: file,
        offset: 2,
        maxBytes: 20,
      },
    });

    assert.equal(readResult.result.status, "complete");
    assert.equal(readResult.result.output.text, "cdef");
    assert.equal(readResult.result.output.bytesRead, 4);
    assert.equal(readResult.result.output.truncated, true);
    assert.equal(readResult.result.output.encoding, "utf8");
    assert.equal(readResult.result.output.containsNulByte, false);
    assert.equal(readResult.result.output.withinContextRoot, true);

    const outsideResult = await registry.execute({
      id: "read_2",
      actionClass: "inspect",
      toolName: "file.read",
      input: {
        path: outsideFile,
      },
    });
    assert.equal(outsideResult.result.status, "complete");
    assert.equal(outsideResult.result.output.text, "outs");
    assert.equal(outsideResult.result.output.withinContextRoot, false);
    assert.equal(outsideResult.result.output.root, null);
    assert.match(outsideResult.result.summary, /outside workspace context hints/);

    const repeatedResult = await registry.execute(
      {
        id: "read_3",
        actionClass: "inspect",
        toolName: "file.read",
        input: {
          path: file,
        },
      },
      {
        excludedPaths: [file],
      },
    );
    assert.equal(repeatedResult.result.status, "blocked");
    assert.match(repeatedResult.result.summary, /avoid_repeated_targets/);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
    await rm(outsideRoot, {
      recursive: true,
      force: true,
    });
  }
});

test("analysis tool runs deterministic metrics and diffs", async () => {
  const registry = createResearchToolRegistry([createAnalysisTool()]);
  const metrics = await registry.execute({
    id: "analysis_1",
    actionClass: "analyze",
    toolName: "analysis.transform",
    input: {
      operation: "metrics",
      text: "one two\nthree",
    },
  });
  const diff = await registry.execute({
    id: "analysis_2",
    actionClass: "analyze",
    toolName: "analysis.transform",
    input: {
      operation: "diff",
      left: "a\nb",
      right: "a\nc",
    },
  });

  assert.equal(metrics.result.status, "complete");
  assert.equal(metrics.result.output.words, 3);
  assert.equal(metrics.result.output.lines, 2);
  assert.deepEqual(diff.result.output.changes, ["-2: b", "+2: c"]);
});

test("code intelligence tools expose Tree-sitter detect, outline, query, context, references, and call candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-code-tools-"));
  await mkdir(join(root, "src"));
  const sourcePath = join(root, "src", "parser.js");
  await writeFile(
    sourcePath,
    [
      "function parse_context_save(input) {",
      "  return input;",
      "}",
      "",
      "parse_context_save('fixture');",
      "",
    ].join("\n"),
  );

  try {
    const registry = createResearchToolRegistry(
      createCodeIntelligenceTools({
        roots: [root],
        maxFileBytes: 20_000,
      }),
    );
    for (const descriptor of registry.listDescriptors()) {
      assert.equal(descriptor.inputSchema.properties.maxBytes.maximum, 20_000);
    }
    const detect = await registry.execute({
      id: "code_detect_1",
      actionClass: "inspect",
      toolName: "code.detect",
      input: {
        path: root,
      },
    });
    const outline = await registry.execute({
      id: "code_outline_1",
      actionClass: "inspect",
      toolName: "code.outline",
      input: {
        path: "src/parser.js",
      },
    });
    const query = await registry.execute({
      id: "code_query_1",
      actionClass: "inspect",
      toolName: "code.query",
      input: {
        path: sourcePath,
        query: "(call_expression function: (identifier) @call)",
        includeText: true,
      },
    });
    const context = await registry.execute({
      id: "code_context_1",
      actionClass: "inspect",
      toolName: "code.node_context",
      input: {
        path: sourcePath,
        line: 2,
      },
    });
    const references = await registry.execute({
      id: "code_refs_1",
      actionClass: "search",
      toolName: "code.references",
      input: {
        path: "src/parser.js",
        symbol: "parse_context_save",
      },
    });
    const calls = await registry.execute({
      id: "code_calls_1",
      actionClass: "analyze",
      toolName: "code.call_candidates",
      input: {
        path: "src/parser.js",
        symbol: "parse_context_save",
      },
    });

    assert.equal(detect.result.status, "complete");
    assert.equal(detect.result.output.detections[0].language, "javascript");
    assert.equal(detect.result.output.detections[0].parseHealth.hasError, false);
    assert.equal(outline.result.status, "complete");
    assert.ok(
      outline.result.output.symbols.some(
        (symbol) =>
          symbol.kind === "definition.function" &&
          symbol.name === "parse_context_save",
      ),
    );
    assert.equal(query.result.status, "complete");
    assert.equal(query.result.output.matches[0].captures[0].text, "parse_context_save");
    assert.equal(context.result.status, "complete");
    assert.ok(
      context.result.output.ancestors.some(
        (ancestor) => ancestor.nodeType === "function_declaration",
      ),
    );
    assert.equal(references.result.status, "complete");
    assert.ok(
      references.result.output.references.some(
        (reference) => reference.kind === "definition.function",
      ),
    );
    assert.ok(
      references.result.output.references.some(
        (reference) => reference.kind === "reference.call",
      ),
    );
    assert.equal(calls.result.status, "complete");
    assert.deepEqual(
      calls.result.output.callCandidates.map((candidate) => candidate.kind),
      ["reference.call"],
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("experiment tool runs only allowlisted experiments", async () => {
  const registry = createResearchToolRegistry([
    createExperimentTool({
      experiments: {
        sum(input) {
          return Number(input.a) + Number(input.b);
        },
      },
    }),
  ]);
  const completed = await registry.execute({
    id: "experiment_1",
    actionClass: "experiment",
    toolName: "experiment.run",
    input: {
      name: "sum",
      input: {
        a: 2,
        b: 3,
      },
    },
  });
  const denied = await registry.execute({
    id: "experiment_2",
    actionClass: "experiment",
    toolName: "experiment.run",
    input: {
      name: "missing",
    },
  });

  assert.equal(completed.result.status, "complete");
  assert.equal(completed.result.output.output, 5);
  assert.equal(denied.result.status, "error");
  assert.match(denied.result.summary, /Unknown experiment/);
});

test("synthesis tool returns report output and artifact references", async () => {
  const result = await createResearchToolRegistry([createSynthesisTool()]).execute({
    id: "synthesis_1",
    actionClass: "synthesize",
    toolName: "synthesis.compose",
    input: {
      title: "Parser Notes",
      sections: ["Observed bounded parsing behavior."],
      artifactKind: "report",
    },
  });

  assert.equal(result.result.status, "complete");
  assert.equal(result.result.output.text, "# Parser Notes\n\nObserved bounded parsing behavior.");
  assert.equal(result.result.artifactRefs[0].kind, "report");
});

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${pid} remained alive after shell timeout`);
}

test("storage list tool exposes manifest artifact metadata read-only", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-storage-tool-"));
  const layout = ensureResearchStorageLayout(
    createResearchStorageLayout({ workspaceRoot }),
  );
  const artifactDir = join(layout.artifactDirectoryPath, "analysis");
  const artifactPath = join(artifactDir, "notes.txt");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, "analysis notes\n", "utf8");
  const entry = registerResearchStorageArtifact(layout, {
    path: artifactPath,
    kind: "analysis-note",
    purpose: "Tool listing fixture.",
    sourceEventIds: ["evt_tool"],
  });

  try {
    const tool = createStorageListTool({ storageLayout: layout });
    const result = await createResearchToolRegistry([tool]).execute({
      id: "storage_1",
      actionClass: "inspect",
      toolName: "storage.list",
      input: {
        kind: "analysis-note",
      },
    });

    assert.equal(result.result.status, "complete");
    assert.equal(result.result.output.artifactCount, 1);
    assert.equal(result.result.output.artifacts[0].id, entry.id);
    assert.deepEqual(result.result.output.directories.map((directory) => directory.name), ["artifacts"]);
    assert.equal(tool.descriptor.sideEffects, "read");
    assert.deepEqual(tool.descriptor.requiredPermissions, ["storage:read"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("default built-in family assembles configured tool surfaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-family-"));
  try {
    const tools = createDefaultBuiltInToolFamily({
      repositorySearch: {
        root,
      },
      fileRead: {
        allowedRoots: [root],
      },
      code: {
        roots: [root],
      },
      experiments: {
        experiments: {
          noop() {
            return "ok";
          },
        },
      },
    });
    const names = tools.map((tool) => tool.descriptor.name).sort();
    const transportNames = createResearchToolRegistry(tools)
      .toPiTools()
      .map((tool) => tool.name)
      .sort();

    assert.deepEqual(names, [
      "analysis.transform",
      "code.call_candidates",
      "code.detect",
      "code.node_context",
      "code.outline",
      "code.query",
      "code.references",
      "experiment.run",
      "file.read",
      "repository.search",
      "synthesis.compose",
    ]);
    assert.deepEqual(transportNames, [
      "analysis_transform",
      "code_call_candidates",
      "code_detect",
      "code_node_context",
      "code_outline",
      "code_query",
      "code_references",
      "experiment_run",
      "file_read",
      "repository_search",
      "synthesis_compose",
    ]);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
