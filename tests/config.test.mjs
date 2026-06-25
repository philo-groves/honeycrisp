import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  getDefaultResearchModelConfigPath,
  loadResearchModelConfig,
  resolveResearchModelConfig,
  writeResearchModelConfig,
} from "../packages/research-agent/dist/index.js";

test("research model config loads provider, model, and effort preferences only", async () => {
  const configPath = await writeConfig({
    provider: "alpha",
    model: "alpha-research",
    effort: "high",
  });
  const preference = await loadResearchModelConfig(configPath);

  assert.deepEqual(preference, {
    provider: "alpha",
    model: "alpha-research",
    effort: "high",
  });

  const authLikePath = await writeConfig({
    provider: "alpha",
    model: "alpha-research",
    apiKey: "not-allowed",
  });
  await assert.rejects(
    () => loadResearchModelConfig(authLikePath),
    /preferences only.*auth login/,
  );
});

test("research model config resolver verifies configured provider preferences", async () => {
  const configPath = await writeConfig({
    provider: "alpha",
    model: "alpha-research",
    effort: "medium",
  });
  const calls = [];
  const result = await resolveResearchModelConfig({
    configPath,
    verifyProviderAuth: async (providerId, modelId) => {
      calls.push({ providerId, modelId });
      return {
        providerId,
        providerName: "Alpha",
        modelId,
        configured: true,
        source: "test",
      };
    },
  });

  assert.deepEqual(calls, [{ providerId: "alpha", modelId: "alpha-research" }]);
  assert.deepEqual(result, {
    provider: "alpha",
    model: "alpha-research",
    effort: "medium",
    source: "config",
    configPath: resolve(configPath),
  });
});

test("research model config resolver defaults to the first authorized provider", async () => {
  const result = await resolveResearchModelConfig({
    getAuthStatus: async () => ({
      authFile: "/tmp/auth.json",
      providers: [
        {
          id: "alpha",
          name: "Alpha",
          authMethods: ["api_key"],
        },
        {
          id: "beta",
          name: "Beta",
          authMethods: ["oauth"],
          storedCredentialType: "oauth",
        },
      ],
    }),
    verifyProviderAuth: async (providerId, modelId) => ({
      providerId,
      providerName: "Beta",
      modelId: modelId ?? "beta-default",
      configured: providerId === "beta",
    }),
  });

  assert.deepEqual(result, {
    provider: "beta",
    model: "beta-default",
    source: "authorized-default",
  });
});

test("research model config resolver loads the default project config path", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-default-config-"));
  const configPath = getDefaultResearchModelConfigPath(workspaceRoot);
  await mkdir(resolve(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "alpha",
      model: "alpha-research",
      effort: "minimal",
    }),
    "utf8",
  );

  const result = await resolveResearchModelConfig({
    workspaceRoot,
    verifyProviderAuth: async (providerId, modelId) => ({
      providerId,
      providerName: "Alpha",
      modelId: modelId ?? "alpha-default",
      configured: true,
    }),
  });

  assert.deepEqual(result, {
    provider: "alpha",
    model: "alpha-research",
    effort: "minimal",
    source: "config",
    configPath,
  });
});

test("research model config writer creates preference-only project config files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-write-config-"));
  const written = await writeResearchModelConfig({
    workspaceRoot,
    preference: {
      provider: "alpha",
      model: "alpha-research",
      effort: "low",
    },
  });
  const loaded = await loadResearchModelConfig(written.configPath);

  assert.equal(written.configPath, getDefaultResearchModelConfigPath(workspaceRoot));
  assert.deepEqual(loaded, {
    provider: "alpha",
    model: "alpha-research",
    effort: "low",
  });
});

test("research model config resolver reports missing authorization clearly", async () => {
  await assert.rejects(
    () =>
      resolveResearchModelConfig({
        getAuthStatus: async () => ({
          authFile: "/tmp/auth.json",
          providers: [],
        }),
        verifyProviderAuth: async () => {
          throw new Error("should not be called");
        },
      }),
    /No authorized model provider found.*--config/,
  );

  await assert.rejects(
    () =>
      resolveResearchModelConfig({
        provider: "alpha",
        model: "alpha-research",
        verifyProviderAuth: async (providerId, modelId) => ({
          providerId,
          providerName: "Alpha",
          modelId: modelId ?? "alpha-default",
          configured: false,
        }),
      }),
    /not authorized.*auth login alpha/,
  );
});

test("research model default config rejects auth-like secret fields", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-secret-config-"));
  const configPath = getDefaultResearchModelConfigPath(workspaceRoot);
  await mkdir(resolve(configPath, ".."), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      provider: "alpha",
      model: "alpha-research",
      token: "not-allowed",
    }),
    "utf8",
  );

  await assert.rejects(
    () =>
      resolveResearchModelConfig({
        workspaceRoot,
        verifyProviderAuth: async () => {
          throw new Error("should not verify secret-bearing config");
        },
      }),
    /preferences only.*auth login/,
  );
});

test("research model config CLI-style overrides win over config files", async () => {
  const configPath = await writeConfig({
    provider: "alpha",
    model: "alpha-research",
    effort: "low",
  });
  const result = await resolveResearchModelConfig({
    configPath,
    provider: "beta",
    model: "beta-research",
    effort: "xhigh",
    verifyProviderAuth: async (providerId, modelId) => ({
      providerId,
      providerName: "Beta",
      modelId: modelId ?? "beta-default",
      configured: true,
    }),
  });

  assert.equal(result.provider, "beta");
  assert.equal(result.model, "beta-research");
  assert.equal(result.effort, "xhigh");
  assert.equal(result.source, "cli");
});

async function writeConfig(config) {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-config-"));
  const configPath = join(root, "research-config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}
