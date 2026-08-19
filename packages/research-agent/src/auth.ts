import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AuthContext,
  AuthInteraction,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  Models,
  MutableModels,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export type AuthLoginCallbacks = AuthInteraction;

export interface FileCredentialStoreOptions {
  authFile?: string;
  codexAuthFile?: string;
}

export interface AuthProviderSummary {
  id: string;
  name: string;
  authMethods: readonly ("api_key" | "oauth")[];
}

export interface AuthStatus {
  authFile: string;
  providers: readonly {
    id: string;
    name: string;
    authMethods: readonly ("api_key" | "oauth")[];
    storedCredentialType?: Credential["type"];
  }[];
}

export interface AuthLoginResult {
  authFile: string;
  providerId: string;
  providerName: string;
  credentialType: Credential["type"];
}

export interface AuthVerifyResult {
  providerId: string;
  providerName: string;
  modelId: string;
  configured: boolean;
  source?: string;
}

export interface ProviderModelCatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  effortLevels: ReturnType<typeof getSupportedThinkingLevels>;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderModelCatalog {
  providerId: string;
  providerName: string;
  models: ProviderModelCatalogEntry[];
}

type CredentialFile = Record<string, Credential>;
const execFileAsync = promisify(execFile);

const ADDITIONAL_PROVIDER_MODELS: Readonly<Record<string, readonly Model<Api>[]>> = {
  zai: [
    {
      id: "glm-5.3",
      name: "GLM-5.3",
      api: "openai-completions",
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "high",
        high: "high",
        max: "max",
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      api: "openai-completions",
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "high", medium: "high", high: "high" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 128_000,
    },
  ],
  anthropic: [
    {
      id: "claude-mythos-5",
      name: "Claude Mythos 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      reasoning: true,
      thinkingLevelMap: {
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  ],
  xai: [
    {
      id: "grok-4.6",
      name: "Grok 4.6",
      api: "openai-responses",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      compat: {
        supportsLongCacheRetention: false,
      },
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: "xhigh",
      },
      input: ["text", "image"],
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.5,
        cacheWrite: 0,
      },
      contextWindow: 500_000,
      maxTokens: 500_000,
    },
  ],
  "openai-codex": [
    {
      id: "gpt-daybreak-blue-latest",
      name: "Daybreak Blue",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: {
        supportsToolSearch: true,
      },
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 0,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 10,
            output: 45,
            cacheRead: 1,
            cacheWrite: 0,
          },
        ],
      },
      contextWindow: 272_000,
      maxTokens: 128_000,
    },
    {
      id: "gpt-daybreak-red-latest",
      name: "Daybreak Red",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: {
        supportsToolSearch: true,
      },
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 0,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 10,
            output: 45,
            cacheRead: 1,
            cacheWrite: 0,
          },
        ],
      },
      contextWindow: 272_000,
      maxTokens: 128_000,
    },
  ],
};

export class FileCredentialStore implements CredentialStore {
  readonly #authFile: string;
  readonly #codexAuthFile: string | undefined;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: FileCredentialStoreOptions = {}) {
    this.#authFile = options.authFile ?? getDefaultAuthFile();
    this.#codexAuthFile = options.codexAuthFile ?? getCodexAuthFile();
  }

  get authFile(): string {
    return this.#authFile;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId === "anthropic") return undefined;
    const credentials = await this.#readAll();
    return this.#currentCredential(credentials, providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.#readAll();
    const providerIds = new Set(Object.keys(credentials).filter((providerId) => providerId !== "anthropic"));
    if (await this.#readCodexCredential()) providerIds.add("openai-codex");

    const result: CredentialInfo[] = [];
    for (const providerId of providerIds) {
      const credential = await this.#currentCredential(credentials, providerId);
      if (credential) result.push({ providerId, type: credential.type });
    }
    return result.sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId === "anthropic") {
      throw new Error("Anthropic subscription credentials are managed by the official Claude CLI.");
    }
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const credentials = await this.#readAll();
      const current = await this.#currentCredential(credentials, providerId);
      const updated = await fn(current);

      if (updated) {
        credentials[providerId] = updated;
        await this.#writeAll(credentials);
        return updated;
      }

      return current;
    });

    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );

    return next;
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const credentials = await this.#readAll();
      delete credentials[providerId];
      await this.#writeAll(credentials);
    });

    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );

    await next;
  }

  async #readAll(): Promise<CredentialFile> {
    try {
      const raw = await readFile(this.#authFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Auth file must contain a JSON object.");
      }

      return parsed as CredentialFile;
    } catch (error) {
      if (isNotFoundError(error)) {
        return {};
      }

      throw error;
    }
  }

  async #writeAll(credentials: CredentialFile): Promise<void> {
    await mkdir(dirname(this.#authFile), { recursive: true, mode: 0o700 });
    await writeFile(this.#authFile, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async #currentCredential(
    credentials: CredentialFile,
    providerId: string,
  ): Promise<Credential | undefined> {
    if (providerId === "anthropic") return undefined;
    const stored = credentials[providerId];
    if (providerId !== "openai-codex") return stored;

    const bridged = await this.#readCodexCredential();
    if (!bridged) return stored;
    if (!stored || stored.type !== "oauth") return bridged;
    return bridged.expires > stored.expires ? bridged : stored;
  }

  async #readCodexCredential(): Promise<OAuthCredential | undefined> {
    if (!this.#codexAuthFile) return undefined;
    try {
      const raw = await readFile(this.#codexAuthFile, "utf8");
      return codexCredentialFromAuthFile(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw new Error(`Unable to read Codex OAuth credential bridge: ${errorMessage(error)}`);
    }
  }
}

export function getDefaultAuthFile(): string {
  const configured = process.env.HONEYCRISP_AUTH_FILE;
  if (configured) {
    return resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  }

  return join(homedir(), ".honeycrisp", "auth.json");
}

export function getCodexAuthFile(): string | undefined {
  const configured = process.env.HONEYCRISP_CODEX_AUTH_FILE?.trim();
  return configured
    ? resolve(configured.replace(/^~(?=$|\/)/, homedir()))
    : undefined;
}

export function createCredentialStore(
  options: FileCredentialStoreOptions = {},
): FileCredentialStore {
  return new FileCredentialStore(options);
}

export function createAuthenticatedModels(
  options: FileCredentialStoreOptions & { authContext?: AuthContext } = {},
): Models {
  const models = honeycrispModels({
    credentials: createCredentialStore(options),
    ...(options.authContext ? { authContext: options.authContext } : {}),
  });
  models.deleteProvider("anthropic");
  return models;
}

export function listAuthProviders(): AuthProviderSummary[] {
  return honeycrispModels()
    .getProviders()
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      authMethods: getProviderAuthMethods(provider.auth),
    }))
    .filter((provider) => provider.authMethods.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getProviderModelCatalog(providerId?: string): ProviderModelCatalog[] {
  const models = honeycrispModels();
  return models
    .getProviders()
    .filter((provider) => !providerId || provider.id === providerId)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      models: models.getModels(provider.id).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        effortLevels: getSupportedThinkingLevels(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    }));
}

export async function getAuthStatus(
  providerId?: string,
  options: FileCredentialStoreOptions = {},
): Promise<AuthStatus> {
  const store = createCredentialStore(options);
  const providers = listAuthProviders().filter(
    (provider) => !providerId || provider.id === providerId,
  );

  return {
    authFile: store.authFile,
    providers: await Promise.all(
      providers.map(async (provider) => {
        if (provider.id === "anthropic") {
          const claudeStatus = shouldUseClaudeCliAuth(options)
            ? await getClaudeCliAuthStatus()
            : { loggedIn: false };
          return claudeStatus.loggedIn
            ? { ...provider, storedCredentialType: "oauth" as const }
            : provider;
        }
        if (
          provider.id === "zai"
          && shouldUseZCodeSubscriptionAuth(options)
          && await getZCodeSubscriptionAuthStatus()
        ) {
          return { ...provider, storedCredentialType: "oauth" as const };
        }
        const credential = await store.read(provider.id);
        return credential
          ? {
              ...provider,
              storedCredentialType: credential.type,
            }
          : provider;
      }),
    ),
  };
}

export async function loginAuthProvider(
  providerId: string,
  callbacks: AuthLoginCallbacks,
  options: FileCredentialStoreOptions = {},
): Promise<AuthLoginResult> {
  const store = createCredentialStore(options);
  const models = honeycrispModels();
  const provider = models.getProvider(providerId);

  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  if (providerId === "anthropic") {
    await store.delete(providerId);
    const existingStatus = await getClaudeCliAuthStatus();
    if (existingStatus.loggedIn) await runClaudeCliAuthCommand("logout");
    await runClaudeCliAuthCommand("login");
    const status = await getClaudeCliAuthStatus();
    if (!status.loggedIn) throw new Error("Claude CLI authentication did not complete.");
    return {
      authFile: "Claude Code credential store",
      providerId,
      providerName: provider.name,
      credentialType: "oauth",
    };
  }

  const credential = provider.auth.oauth
    ? await provider.auth.oauth.login(callbacks)
    : await provider.auth.apiKey?.login?.(callbacks);

  if (!credential) {
    throw new Error(`Provider does not support interactive login: ${providerId}`);
  }

  await store.modify(provider.id, async () => credential);

  return {
    authFile: store.authFile,
    providerId: provider.id,
    providerName: provider.name,
    credentialType: credential.type,
  };
}

export async function logoutAuthProvider(
  providerId: string,
  options: FileCredentialStoreOptions = {},
): Promise<void> {
  const store = createCredentialStore(options);
  if (providerId === "anthropic") {
    await runClaudeCliAuthCommand("logout");
  }
  await store.delete(providerId);
}

export async function verifyProviderAuth(
  providerId: string,
  modelId?: string,
  options: FileCredentialStoreOptions = {},
): Promise<AuthVerifyResult> {
  const store = createCredentialStore(options);
  const models = honeycrispModels({
    credentials: store,
  });
  const provider = models.getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const model = modelId
    ? models.getModel(providerId, modelId)
    : providerId === "openrouter"
      ? models.getModel(providerId, "auto")
      : models.getModels(providerId)[0];

  if (!model) {
    throw new Error(
      modelId
        ? `Unknown model for ${providerId}: ${modelId}`
        : `No built-in models found for provider: ${providerId}`,
    );
  }

  if (providerId === "anthropic") {
    const apiKeyConfigured = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    const cliStatus = apiKeyConfigured || !shouldUseClaudeCliAuth(options)
      ? { loggedIn: false }
      : await getClaudeCliAuthStatus();
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      configured: apiKeyConfigured || cliStatus.loggedIn,
      ...(apiKeyConfigured
        ? { source: "ANTHROPIC_API_KEY" }
        : cliStatus.loggedIn
          ? { source: "Claude CLI subscription" }
          : {}),
    };
  }

  if (providerId === "zai") {
    const apiKeyConfigured = Boolean(process.env.ZAI_API_KEY?.trim());
    const subscriptionStatus = apiKeyConfigured || !shouldUseZCodeSubscriptionAuth(options)
      ? false
      : await getZCodeSubscriptionAuthStatus();
    return {
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      configured: apiKeyConfigured || subscriptionStatus,
      ...(apiKeyConfigured
        ? { source: "ZAI_API_KEY" }
        : subscriptionStatus
          ? { source: "ZCode subscription" }
          : {}),
    };
  }

  const auth = await models.getAuth(model);

  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    configured: Boolean(auth),
    ...(auth?.source ? { source: auth.source } : {}),
  };
}

export async function removeAuthFile(
  options: FileCredentialStoreOptions = {},
): Promise<void> {
  const store = createCredentialStore(options);
  await rm(store.authFile, { force: true });
}

function codexCredentialFromAuthFile(value: unknown): OAuthCredential | undefined {
  const root = recordValue(value);
  const tokens = recordValue(root?.tokens);
  if (!root || root.auth_mode !== "chatgpt" || !tokens) return undefined;

  const access = stringValue(tokens.access_token);
  const refresh = stringValue(tokens.refresh_token);
  const accountId = stringValue(tokens.account_id);
  const expires = access ? jwtExpiration(access) : undefined;
  if (!access || !refresh || !expires) return undefined;

  return {
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

function jwtExpiration(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = recordValue(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown,
    );
    const expires = decoded?.exp;
    return typeof expires === "number" && Number.isFinite(expires)
      ? expires * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getProviderAuthMethods(
  auth: Models["getProviders"] extends () => readonly (infer TProvider)[]
    ? TProvider extends { auth: infer TAuth }
      ? TAuth
      : never
    : never,
): ("api_key" | "oauth")[] {
  const methods: ("api_key" | "oauth")[] = [];
  if (auth.apiKey) {
    methods.push("api_key");
  }
  if (auth.oauth) {
    methods.push("oauth");
  }

  return methods;
}

function honeycrispModels(
  options?: Parameters<typeof builtinModels>[0],
): MutableModels {
  const models = builtinModels(options);

  for (const [providerId, additionalModels] of Object.entries(
    ADDITIONAL_PROVIDER_MODELS,
  )) {
    const provider = models.getProvider(providerId);
    if (!provider) continue;

    const augmentedProvider = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "getModels") {
          return () => mergeProviderModels(target.getModels(), additionalModels);
        }

        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    models.setProvider(augmentedProvider);
  }

  return models;
}

interface ClaudeCliAuthStatus {
  loggedIn: boolean;
}

export async function getZCodeSubscriptionAuthStatus(userHome = homedir()): Promise<boolean> {
  try {
    const credentialsText = await readFile(
      join(userHome, ".zcode", "v2", "credentials.json"),
      "utf8",
    );
    const credentials = JSON.parse(credentialsText) as unknown;
    const accessToken = isRecord(credentials)
      ? credentials["oauth:zai:access_token"]
      : undefined;
    return typeof accessToken === "string" && accessToken.trim().length > 0;
  } catch {
    return false;
  }
}

function shouldUseZCodeSubscriptionAuth(options: FileCredentialStoreOptions): boolean {
  return !options.authFile && !process.env.HONEYCRISP_AUTH_FILE?.trim();
}

function shouldUseClaudeCliAuth(options: FileCredentialStoreOptions): boolean {
  return !options.authFile && !process.env.HONEYCRISP_AUTH_FILE?.trim();
}

async function getClaudeCliAuthStatus(): Promise<ClaudeCliAuthStatus> {
  try {
    const invocation = claudeCliInvocation(["auth", "status", "--json"]);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as unknown;
    return { loggedIn: recordValue(parsed)?.loggedIn === true };
  } catch {
    return { loggedIn: false };
  }
}

async function runClaudeCliAuthCommand(command: "login" | "logout"): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const invocation = claudeCliInvocation([
      "auth",
      command,
      ...(command === "login" ? ["--claudeai"] : []),
    ]);
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      rejectPromise(new Error(`Unable to start the official Claude CLI. Install Claude Code first: ${errorMessage(error)}`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Claude CLI auth ${command} failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`));
    });
  });
}

function claudeCliInvocation(args: readonly string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "claude", ...args],
    };
  }
  return { command: "claude", args: [...args] };
}

function mergeProviderModels(
  builtInModels: readonly Model<Api>[],
  additionalModels: readonly Model<Api>[],
): Model<Api>[] {
  const additionsById = new Map(additionalModels.map((model) => [model.id, model]));
  return [
    ...builtInModels.filter((model) => !additionsById.has(model.id)),
    ...additionalModels,
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
