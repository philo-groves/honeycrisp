import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfiguredExperimentTool,
  createResearchStorageLayout,
  createResearchToolRegistry,
  ensureResearchStorageLayout,
  loadResearchStorageManifest,
  listResearchStorageArtifacts,
  loadResearchExperimentConfig,
} from "../packages/research-agent/dist/index.js";

test("configured experiment tool runs allowlisted specs and registers output artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-experiment-"));
  const workspaceRoot = join(root, "workspace");
  const scriptPath = join(root, "echo-input.mjs");
  const configPath = join(root, "experiments.json");
  const layout = ensureResearchStorageLayout(
    createResearchStorageLayout({ workspaceRoot }),
  );
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    scriptPath,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  console.log('stdout:' + parsed.value);",
      "  console.error('stderr:' + parsed.value);",
      "});",
    ].join("\n"),
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

  try {
    const tool = createConfiguredExperimentTool({
      config: loadResearchExperimentConfig(configPath),
      storageLayout: layout,
    });
    const registry = createResearchToolRegistry([tool]);
    const completed = await registry.execute({
      id: "experiment_action",
      actionClass: "experiment",
      toolName: "experiment.run",
      input: {
        name: "echo",
        input: {
          value: "parser",
        },
      },
    });
    const denied = await registry.execute({
      id: "experiment_denied",
      actionClass: "experiment",
      toolName: "experiment.run",
      input: {
        name: "missing",
      },
    });
    const artifacts = listResearchStorageArtifacts(layout);

    assert.equal(completed.result.status, "complete");
    assert.equal(completed.result.output.exitCode, 0);
    assert.equal(completed.result.output.stdoutPreview.trim(), "stdout:parser");
    assert.equal(completed.result.output.stderrPreview.trim(), "stderr:parser");
    assert.match(completed.result.output.stdoutHash, /^sha256:/);
    assert.equal(completed.result.artifactRefs.length, 2);
    assert.equal(artifacts.length, 2);
    assert.equal(
      loadResearchStorageManifest(
        createResearchStorageLayout({ workspaceRoot }),
      ).artifacts.length,
      2,
    );
    assert.ok(artifacts.some((artifact) => artifact.kind === "experiment_stdout"));
    assert.equal(tool.descriptor.sideEffects, "process");
    assert.ok(tool.descriptor.requiredPermissions.includes("fixture:run"));
    assert.equal(denied.result.status, "error");
    assert.match(denied.result.summary, /Unknown configured experiment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured experiment tool reports timeouts as tool errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-experiment-timeout-"));
  const scriptPath = join(root, "slow.mjs");
  const configPath = join(root, "experiments.json");
  await writeFile(
    scriptPath,
    "setTimeout(() => console.log('too late'), 1000);",
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify({
      experiments: {
        slow: {
          command: process.execPath,
          args: [scriptPath],
          sideEffects: "process",
          requiredPermissions: ["fixture:run"],
          timeoutMs: 25,
          maxOutputBytes: 4000,
        },
      },
    }),
    "utf8",
  );

  try {
    const registry = createResearchToolRegistry([
      createConfiguredExperimentTool({
        config: loadResearchExperimentConfig(configPath),
      }),
    ]);
    const record = await registry.execute({
      id: "experiment_timeout",
      actionClass: "experiment",
      toolName: "experiment.run",
      input: {
        name: "slow",
      },
    });

    assert.equal(record.result.status, "error");
    assert.equal(record.result.output.timedOut, true);
    assert.match(record.result.summary, /failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured experiment tool enforces output limits and stores bounded artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-experiment-output-"));
  const workspaceRoot = join(root, "workspace");
  const scriptPath = join(root, "large-output.mjs");
  const configPath = join(root, "experiments.json");
  const layout = ensureResearchStorageLayout(
    createResearchStorageLayout({ workspaceRoot }),
  );
  await writeFile(
    scriptPath,
    "console.log('x'.repeat(2048));",
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify({
      experiments: {
        large: {
          command: process.execPath,
          args: [scriptPath],
          sideEffects: "process",
          requiredPermissions: ["fixture:run"],
          timeoutMs: 1000,
          maxOutputBytes: 128,
        },
      },
    }),
    "utf8",
  );

  try {
    const registry = createResearchToolRegistry([
      createConfiguredExperimentTool({
        config: loadResearchExperimentConfig(configPath),
        storageLayout: layout,
      }),
    ]);
    const record = await registry.execute({
      id: "experiment_large",
      actionClass: "experiment",
      toolName: "experiment.run",
      input: {
        name: "large",
      },
    });
    const artifacts = listResearchStorageArtifacts(layout);

    assert.equal(record.result.status, "error");
    assert.equal(record.result.output.outputLimitExceeded, true);
    assert.ok(record.result.output.stdoutBytes <= 128);
    assert.equal(record.result.artifactRefs.length, 1);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "experiment_stdout");
    assert.ok(artifacts[0].sizeBytes <= 128);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("experiment configs require explicit policy and validate directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-experiment-invalid-"));
  const scriptPath = join(root, "ok.mjs");
  const missingPolicyPath = join(root, "missing-policy.json");
  const missingCwdPath = join(root, "missing-cwd.json");
  await writeFile(scriptPath, "console.log('ok');", "utf8");
  await writeFile(
    missingPolicyPath,
    JSON.stringify({
      experiments: {
        missingPolicy: {
          command: process.execPath,
          args: [scriptPath],
          sideEffects: "process",
          timeoutMs: 1000,
          maxOutputBytes: 4000,
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    missingCwdPath,
    JSON.stringify({
      experiments: {
        missingCwd: {
          command: process.execPath,
          args: [scriptPath],
          cwd: "./does-not-exist",
          sideEffects: "process",
          requiredPermissions: ["fixture:run"],
          timeoutMs: 1000,
          maxOutputBytes: 4000,
        },
      },
    }),
    "utf8",
  );

  try {
    assert.throws(
      () => loadResearchExperimentConfig(missingPolicyPath),
      /requiredPermissions must be a string array/,
    );
    assert.throws(
      () => loadResearchExperimentConfig(missingCwdPath),
      /cwd does not exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
