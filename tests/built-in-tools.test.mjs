import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAnalysisTool,
  createCodeIntelligenceTools,
  createDefaultBuiltInToolFamily,
  createExperimentTool,
  createRepositorySearchTool,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createStorageListTool,
  createStructuredFileReadTool,
  createSynthesisTool,
  ensureResearchStorageLayout,
  registerResearchStorageArtifact,
} from "../packages/research-agent/dist/index.js";

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
