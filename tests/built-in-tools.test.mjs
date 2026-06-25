import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAnalysisTool,
  createDefaultBuiltInToolFamily,
  createExperimentTool,
  createMemoryRecallTool,
  createRepositorySearchTool,
  createResearchStorageLayout,
  createResearchToolRegistry,
  createStorageListTool,
  createStructuredFileReadTool,
  createSynthesisTool,
  ensureResearchStorageLayout,
  registerResearchStorageArtifact,
} from "../packages/research-agent/dist/index.js";

test("memory recall exposes retriever refs as evidence", async () => {
  let capturedInput;
  const tool = createMemoryRecallTool({
    recall(input) {
      capturedInput = input;
      return [
        {
          store: "working",
          id: "mem_parser_invariant",
          summary: "Parser invariant from earlier loop",
        },
      ];
    },
  });
  const result = await createResearchToolRegistry([tool]).execute({
    id: "recall_1",
    actionClass: "recall",
    toolName: "memory.recall",
    input: {
      query: "parser invariant",
      limit: 3,
    },
  });

  assert.equal(result.result.status, "complete");
  assert.deepEqual(capturedInput, {
    query: "parser invariant",
    limit: 3,
  });
  assert.equal(result.result.output.refs[0].id, "mem_parser_invariant");
  assert.equal(result.result.evidence[0], "Parser invariant from earlier loop");
  assert.equal(tool.descriptor.metadata.safetyProfile, "memory-read");
});

test("repository search finds bounded local source matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-repo-search-"));
  await mkdir(join(root, "Src"));
  await writeFile(
    join(root, "Src", "parse.c"),
    "static void parse_context_save(void) {}\nparse_context_save();\n",
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
  assert.deepEqual(result.result.claims, ["Observed bounded parsing behavior."]);
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
    assert.equal(result.result.output.directories.length, 8);
    assert.match(result.result.evidence[0], /analysis-note/);
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
      recall: {
        recall() {
          return [];
        },
      },
      repositorySearch: {
        root,
      },
      fileRead: {
        allowedRoots: [root],
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
      "experiment.run",
      "file.read",
      "memory.recall",
      "repository.search",
      "synthesis.compose",
    ]);
    assert.deepEqual(transportNames, [
      "analysis_transform",
      "experiment_run",
      "file_read",
      "memory_recall",
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
