import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AgentPluginRegistry,
  extractSourceRepositoryUrls,
  getWorkspaceDejunkSummary,
  normalizeSourceRepositoryUrl,
  providerSemanticsDescriptor,
  resolveAuxiliaryModelRoute,
  runWorkspaceDejunk,
  sourceRepositoryCandidates,
} from "../packages/research-agent/dist/harness.js";

test("Honeycrisp owns auxiliary routes, sources, plugins, and retained maintenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-harness-boundary-"));
  try {
    assert.deepEqual(resolveAuxiliaryModelRoute({
      jobName: "goalSuggestions",
      job: { provider: "openai", model: "profile-model", effort: "high" },
      provider: "openai-codex",
      configuredModel: "configured-model",
      fallbackEffort: "low",
    }), { provider: "openai-codex", model: "profile-model", effort: "high" });
    assert.equal(providerSemanticsDescriptor().defaultSmallModels.xai, "grok-4.3");

    const scope = { assets: [{
      id: "repo",
      kind: "repo",
      direction: "in_scope",
      sensitivity: "public",
      value: "https://github.com/Netflix/zuul",
      attributes: {},
    }] };
    assert.equal(normalizeSourceRepositoryUrl("git@github.com:Netflix/zuul.git"), "https://github.com/Netflix/zuul");
    assert.deepEqual(extractSourceRepositoryUrls("Review github.com/Netflix/zuul."), ["https://github.com/Netflix/zuul"]);
    assert.equal(sourceRepositoryCandidates(scope)[0].url, "https://github.com/Netflix/zuul");

    const pluginRoot = join(root, "plugin");
    await mkdir(join(pluginRoot, "skills", "recon"), { recursive: true });
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "boundary-plugin",
      version: "1.0.0",
    }));
    await writeFile(join(pluginRoot, "skills", "recon", "SKILL.md"), "---\nname: Recon\ndescription: Inspect sources.\n---\n");
    const registry = new AgentPluginRegistry(join(root, "registry"), { builtinPlugins: [] });
    const installed = registry.addFromFilesystem(pluginRoot);
    assert.equal(installed.plugins[0].name, "boundary-plugin");
    assert.deepEqual(registry.getHoneycrispRuntime().selectedSkillIds, ["recon"]);

    const disabledBuiltinRegistry = new AgentPluginRegistry(join(root, "builtin-registry"), {
      builtinPlugins: [{
        id: "disabled-builtin",
        path: pluginRoot,
        installedAt: "2026-08-17T00:00:00.000Z",
        enabledByDefault: false,
      }],
    });
    assert.equal(disabledBuiltinRegistry.getState().plugins[0].enabled, false);
    assert.deepEqual(disabledBuiltinRegistry.getHoneycrispRuntime().selectedSkillIds, []);

    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".beale"), { recursive: true });
    await writeFile(join(workspace, ".beale", "dejunk.json"), JSON.stringify({
      version: 1,
      baselineAt: "2020-01-01T00:00:00.000Z",
      lastRun: null,
    }));
    await writeFile(join(workspace, "notes.md"), "retained research\n");
    assert.equal(getWorkspaceDejunkSummary(workspace).newFileCount, 1);
    const maintained = runWorkspaceDejunk(workspace);
    assert.equal(maintained.lastRun.status, "completed");
    assert.equal((await readFile(join(workspace, "research", "notes", "notes.md"), "utf8")).trim(), "retained research");

    const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));
    const inputPath = join(root, "source-input.json");
    await writeFile(inputPath, JSON.stringify({ value: "git@github.com:Netflix/zuul.git" }));
    const cli = spawnSync(process.execPath, [cliPath, "harness", "source-inspect", "--input", inputPath, "--json"], { encoding: "utf8" });
    assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
    const envelope = JSON.parse(cli.stdout);
    assert.equal(envelope.protocolVersion, 1);
    assert.equal(envelope.operation, "source.inspect");
    assert.equal(envelope.result.normalizedUrl, "https://github.com/Netflix/zuul");

    const invalidCompletion = spawnSync(process.execPath, [cliPath, "complete", "--json"], {
      encoding: "utf8",
      input: JSON.stringify({ schemaVersion: 1, provider: "unknown" }),
    });
    assert.equal(invalidCompletion.status, 1);
    const failure = JSON.parse(invalidCompletion.stdout);
    assert.equal(failure.operation, "provider.complete");
    assert.equal(failure.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
