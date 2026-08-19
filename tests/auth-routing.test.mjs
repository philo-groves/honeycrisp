import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderAuthenticationRouter,
  isAuthenticationUsageExhaustion,
  readProviderAuthenticationPreferences,
} from "../packages/research-agent/dist/auth-routing.js";

test("authentication preferences parse only supported providers and methods", () => {
  assert.deepEqual(readProviderAuthenticationPreferences(JSON.stringify({
    "openai-codex": "api_key",
    anthropic: "subscription",
    unsupported: "api_key",
    xai: "invalid",
    zai: "subscription",
    openrouter: "subscription",
  })), {
    "openai-codex": "api_key",
    anthropic: "subscription",
    zai: "subscription",
  });
});

test("OpenRouter remains API-key-only and exposes OPENROUTER_API_KEY", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  try {
    const router = new ProviderAuthenticationRouter({ openrouter: "subscription" });
    assert.equal(router.method("openrouter"), "api_key");
    assert.equal(router.requestApiKey("openrouter"), "test-openrouter-key");
    assert.equal(router.tryFallback("openrouter", "insufficient credits"), false);
    const context = router.authContext({
      env: async (name) => process.env[name],
      fileExists: async () => false,
    });
    assert.equal(await context.env("OPENROUTER_API_KEY"), "test-openrouter-key");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("Z.ai API-key preference exposes only the dedicated ZAI_API_KEY route", async () => {
  const previous = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = "test-zai-key";
  try {
    const router = new ProviderAuthenticationRouter({ zai: "api_key" });
    assert.equal(router.method("zai"), "api_key");
    assert.equal(router.requestApiKey("zai"), "test-zai-key");
    const context = router.authContext({
      env: async (name) => process.env[name],
      fileExists: async () => false,
    });
    assert.equal(await context.env("ZAI_API_KEY"), "test-zai-key");
  } finally {
    if (previous === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = previous;
  }
});

test("OpenAI API-key preference routes the same model through the API provider", () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const router = new ProviderAuthenticationRouter({ "openai-codex": "api_key" });
    const models = {
      getModel(provider, model) {
        return { provider, id: model };
      },
    };
    assert.deepEqual(router.routePiModel(models, "openai-codex", "gpt-5.6-sol"), {
      provider: "openai",
      id: "gpt-5.6-sol",
    });
    assert.equal(router.requestApiKey("openai-codex"), "test-key");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("usage exhaustion switches once to the available alternate authentication source", () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  try {
    const router = new ProviderAuthenticationRouter({ xai: "subscription" });
    assert.equal(router.tryFallback("xai", "Subscription usage limit reached"), true);
    assert.equal(router.method("xai"), "api_key");
    assert.equal(router.tryFallback("xai", "insufficient_quota"), false);
    assert.equal(router.tryFallback("xai", "ordinary provider error"), false);
    assert.equal(isAuthenticationUsageExhaustion("insufficient_quota", "api_key"), true);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("subscription preference hides ambient API keys until an intentional usage fallback", async () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  try {
    const router = new ProviderAuthenticationRouter({ xai: "subscription" });
    const context = router.authContext({
      env: async (name) => process.env[name],
      fileExists: async () => false,
    });

    assert.equal(await context.env("XAI_API_KEY"), undefined);
    assert.equal(await context.env("PATH"), process.env.PATH);
    assert.equal(router.tryFallback("xai", "Subscription usage limit reached"), true);
    assert.equal(await context.env("XAI_API_KEY"), "test-key");
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("Anthropic subscription preference removes API billing from the Agent SDK environment", () => {
  const router = new ProviderAuthenticationRouter({ anthropic: "subscription" });
  const env = router.claudeEnvironment({ ANTHROPIC_API_KEY: "test-key", PATH: "test-path" });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, "test-path");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "honeycrisp/0.1.0");
});
