import {
  defaultProviderAuthContext,
  type AuthContext,
  type Models,
} from "@earendil-works/pi-ai";

export const RESEARCH_MODEL_PROVIDER_IDS = ["openai-codex", "anthropic", "xai", "zai", "openrouter"] as const;

export type ResearchModelProviderId = typeof RESEARCH_MODEL_PROVIDER_IDS[number];
export type ProviderAuthenticationMethod = "subscription" | "api_key";
export type ProviderAuthenticationPreferences = Partial<Record<ResearchModelProviderId, ProviderAuthenticationMethod>>;

const API_KEY_ENVIRONMENT_VARIABLES: Readonly<Record<ResearchModelProviderId, string>> = {
  "openai-codex": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  zai: "ZAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function readProviderAuthenticationPreferences(
  value = process.env.HONEYCRISP_PROVIDER_AUTH_PREFERENCES,
): ProviderAuthenticationPreferences {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return {};
    const preferences: ProviderAuthenticationPreferences = {};
    for (const providerId of RESEARCH_MODEL_PROVIDER_IDS) {
      const method = parsed[providerId];
      if (method === "api_key" || (providerId !== "openrouter" && method === "subscription")) {
        preferences[providerId] = method;
      }
    }
    return preferences;
  } catch {
    return {};
  }
}

export class ProviderAuthenticationRouter {
  readonly #methods = new Map<ResearchModelProviderId, ProviderAuthenticationMethod>();
  readonly #fallbackProviders = new Set<ResearchModelProviderId>();

  constructor(preferences: ProviderAuthenticationPreferences = readProviderAuthenticationPreferences()) {
    for (const providerId of RESEARCH_MODEL_PROVIDER_IDS) {
      const preferred = providerId === "openrouter" ? "api_key" : preferences[providerId] ?? "subscription";
      this.#methods.set(
        providerId,
        providerId !== "openrouter" && preferred === "api_key" && !this.apiKey(providerId)
          ? "subscription"
          : preferred,
      );
    }
  }

  method(providerId: string): ProviderAuthenticationMethod | undefined {
    return isResearchModelProviderId(providerId) ? this.#methods.get(providerId) : undefined;
  }

  apiKey(providerId: string): string | undefined {
    if (!isResearchModelProviderId(providerId)) return undefined;
    return process.env[API_KEY_ENVIRONMENT_VARIABLES[providerId]]?.trim() || undefined;
  }

  routePiModel(
    models: Pick<Models, "getModel">,
    providerId: string,
    modelId: string,
  ): ReturnType<Models["getModel"]> {
    const method = this.method(providerId);
    if (providerId === "openai-codex" && method === "api_key") {
      return models.getModel("openai", modelId);
    }
    return models.getModel(providerId, modelId);
  }

  requestApiKey(providerId: string): string | undefined {
    return this.method(providerId) === "api_key" ? this.apiKey(providerId) : undefined;
  }

  authContext(base: AuthContext = defaultProviderAuthContext()): AuthContext {
    return {
      env: async (name) => {
        const providerId = providerForApiKeyEnvironmentVariable(name);
        if (providerId && this.method(providerId) === "subscription") return undefined;
        return base.env(name);
      },
      fileExists: (path) => base.fileExists(path),
    };
  }

  tryFallback(providerId: string, errorMessage: string): boolean {
    if (!isResearchModelProviderId(providerId)) return false;
    if (providerId === "openrouter") return false;
    if (this.#fallbackProviders.has(providerId)) return false;
    const current = this.#methods.get(providerId) ?? "subscription";
    if (!isAuthenticationUsageExhaustion(errorMessage, current)) return false;
    const alternate: ProviderAuthenticationMethod = current === "subscription" ? "api_key" : "subscription";
    if (alternate === "api_key" && !this.apiKey(providerId)) return false;
    this.#methods.set(providerId, alternate);
    this.#fallbackProviders.add(providerId);
    return true;
  }

  claudeEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: "honeycrisp/0.1.0" };
    if (this.method("anthropic") === "subscription") delete env.ANTHROPIC_API_KEY;
    return env;
  }
}

export function isAuthenticationUsageExhaustion(
  errorMessage: string,
  method: ProviderAuthenticationMethod,
): boolean {
  const normalized = errorMessage.toLowerCase();
  if (method === "api_key") {
    return normalized.includes("insufficient_quota")
      || normalized.includes("insufficient quota")
      || normalized.includes("insufficient credits")
      || normalized.includes("not enough credits")
      || normalized.includes("credit balance")
      || normalized.includes("billing hard limit")
      || normalized.includes("billing limit")
      || normalized.includes("exceeded your current quota")
      || normalized.includes("quota has been exceeded")
      || normalized.includes("no credits available");
  }
  return normalized.includes("usage limit")
    || normalized.includes("usage_limit")
    || normalized.includes("hit your limit")
    || normalized.includes("weekly limit")
    || normalized.includes("monthly limit")
    || normalized.includes("subscription limit")
    || normalized.includes("plan limit")
    || normalized.includes("rate limit exceeded for this account");
}

function isResearchModelProviderId(value: string): value is ResearchModelProviderId {
  return RESEARCH_MODEL_PROVIDER_IDS.includes(value as ResearchModelProviderId);
}

function providerForApiKeyEnvironmentVariable(name: string): ResearchModelProviderId | undefined {
  return RESEARCH_MODEL_PROVIDER_IDS.find((providerId) => API_KEY_ENVIRONMENT_VARIABLES[providerId] === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
