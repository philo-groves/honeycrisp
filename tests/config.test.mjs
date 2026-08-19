import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createAuthenticatedModels,
  createCredentialStore,
  getDefaultResearchModelConfigPath,
  getProviderModelCatalog,
  loadResearchModelConfig,
  resolveResearchModelConfig,
  writeResearchModelConfig,
} from "../packages/research-agent/dist/index.js";

test("authenticated model catalog includes current supplemental models", () => {
  const models = createAuthenticatedModels();
  const daybreak = models.getModel("openai-codex", "gpt-daybreak-blue-latest");
  const daybreakRed = models.getModel("openai-codex", "gpt-daybreak-red-latest");
  const grok46 = models.getModel("xai", "grok-4.6");
  const glm53 = models.getModel("zai", "glm-5.3");

  assert.equal(models.getProvider("anthropic"), undefined);
  assert.equal(models.getModel("anthropic", "claude-opus-5"), undefined);
  assert.equal(daybreak?.name, "Daybreak Blue");
  assert.equal(daybreak?.provider, "openai-codex");
  assert.equal(daybreak?.contextWindow, 272_000);
  assert.equal(daybreakRed?.name, "Daybreak Red");
  assert.equal(daybreakRed?.provider, "openai-codex");
  assert.equal(daybreakRed?.contextWindow, daybreak?.contextWindow);
  assert.equal(grok46?.name, "Grok 4.6");
  assert.equal(grok46?.provider, "xai");
  assert.equal(grok46?.contextWindow, 500_000);
  assert.equal(glm53?.name, "GLM-5.3");
  assert.equal(glm53?.provider, "zai");
  assert.equal(glm53?.contextWindow, 1_000_000);
  assert.equal(glm53?.maxTokens, 128_000);
});

test("credential store treats legacy Anthropic credentials as cleanup-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-anthropic-legacy-"));
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({
    anthropic: { type: "api_key", key: "legacy-secret" },
  }), "utf8");
  const store = createCredentialStore({ authFile });

  assert.equal(await store.read("anthropic"), undefined);
  assert.equal((await store.list()).some((entry) => entry.providerId === "anthropic"), false);
  await assert.rejects(
    store.modify("anthropic", async () => ({ type: "api_key", key: "new-secret" })),
    /official Claude CLI/,
  );
  await store.delete("anthropic");
  assert.equal("anthropic" in JSON.parse(await readFile(authFile, "utf8")), false);
});

test("provider catalogs expose current supplemental models to frontends", () => {
  const [anthropic] = getProviderModelCatalog("anthropic");
  const [openai] = getProviderModelCatalog("openai-codex");
  const [zai] = getProviderModelCatalog("zai");
  const [openrouter] = getProviderModelCatalog("openrouter");

  assert.ok(anthropic?.models.some((model) => model.id === "claude-opus-5"));
  const fable = anthropic?.models.find((model) => model.id === "claude-fable-5");
  const mythos = anthropic?.models.find((model) => model.id === "claude-mythos-5");
  assert.equal(fable?.name, "Claude Fable 5");
  assert.equal(fable?.contextWindow, 1_000_000);
  assert.equal(mythos?.name, "Claude Mythos 5");
  assert.deepEqual(mythos?.effortLevels, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(mythos?.contextWindow, 1_000_000);
  assert.equal(mythos?.maxTokens, 128_000);
  const daybreak = openai?.models.find(
    (model) => model.id === "gpt-daybreak-blue-latest",
  );
  const daybreakRed = openai?.models.find(
    (model) => model.id === "gpt-daybreak-red-latest",
  );
  assert.deepEqual(daybreak?.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(daybreakRed?.effortLevels, daybreak?.effortLevels);
  assert.equal(daybreakRed?.contextWindow, daybreak?.contextWindow);
  const glm53 = zai?.models.find((model) => model.id === "glm-5.3");
  assert.equal(glm53?.name, "GLM-5.3");
  assert.equal(glm53?.contextWindow, 1_000_000);
  assert.equal(glm53?.maxTokens, 128_000);
  assert.equal(openrouter?.providerName, "OpenRouter");
  assert.ok(openrouter?.models.some((model) => model.id === "auto"));
});

test("provider catalog reports Pi model names and model-specific effort levels", () => {
  const [catalog] = getProviderModelCatalog("xai");
  assert.equal(catalog?.providerId, "xai");
  const grok43 = catalog?.models.find((model) => model.id === "grok-4.3");
  const grok45 = catalog?.models.find((model) => model.id === "grok-4.5");
  const grok46 = catalog?.models.find((model) => model.id === "grok-4.6");
  assert.equal(grok43?.name, "Grok 4.3");
  assert.deepEqual(grok43?.effortLevels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(grok45?.effortLevels, ["low", "medium", "high"]);
  assert.equal(grok46?.name, "Grok 4.6");
  assert.deepEqual(grok46?.effortLevels, ["low", "medium", "high", "xhigh"]);
  assert.equal(grok46?.contextWindow, 500_000);
});

test("research model config accepts Pi max effort", async () => {
  const configPath = await writeConfig({ provider: "openai-codex", model: "gpt-5.6-sol", effort: "max" });
  assert.equal((await loadResearchModelConfig(configPath)).effort, "max");
});

test("credential store prefers a fresher host Codex OAuth credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "honeycrisp-codex-bridge-"));
  const authFile = join(directory, "honeycrisp-auth.json");
  const codexAuthFile = join(directory, "codex-auth.json");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const jwt = (expires) =>
    `header.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.signature`;

  await writeFile(
    authFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: jwt(nowSeconds - 60),
        refresh: "stale-refresh",
        expires: (nowSeconds - 60) * 1000,
        accountId: "stale-account",
      },
    }),
    "utf8",
  );
  await writeFile(
    codexAuthFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt(nowSeconds + 3600),
        refresh_token: "host-refresh",
        account_id: "host-account",
      },
    }),
    "utf8",
  );

  const credential = await createCredentialStore({ authFile, codexAuthFile }).read(
    "openai-codex",
  );
  assert.equal(credential?.type, "oauth");
  assert.equal(credential?.accountId, "host-account");
  assert.equal(credential?.expires, (nowSeconds + 3600) * 1000);
});

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

test("research model config resolver applies CLI model override to the first authorized provider", async () => {
  const calls = [];
  const result = await resolveResearchModelConfig({
    model: "spark-research",
    effort: "minimal",
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
    verifyProviderAuth: async (providerId, modelId) => {
      calls.push({ providerId, modelId });
      return {
        providerId,
        providerName: providerId === "beta" ? "Beta" : "Alpha",
        modelId: modelId ?? `${providerId}-default`,
        configured: providerId === "beta",
      };
    },
  });

  assert.deepEqual(calls, [{ providerId: "beta", modelId: "spark-research" }]);
  assert.deepEqual(result, {
    provider: "beta",
    model: "spark-research",
    effort: "minimal",
    source: "cli",
  });
});

test("research model config resolver applies config model preference to the first authorized provider", async () => {
  const configPath = await writeConfig({
    model: "spark-research",
  });
  const result = await resolveResearchModelConfig({
    configPath,
    getAuthStatus: async () => ({
      authFile: "/tmp/auth.json",
      providers: [
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
      configured: true,
    }),
  });

  assert.deepEqual(result, {
    provider: "beta",
    model: "spark-research",
    source: "config",
    configPath: resolve(configPath),
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
