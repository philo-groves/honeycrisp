import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  getAuthStatus,
  verifyProviderAuth,
  type AuthStatus,
  type AuthVerifyResult,
  type FileCredentialStoreOptions,
} from "./auth.js";

export type ResearchModelEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface ResearchModelConfigPreference {
  provider?: string;
  model?: string;
  effort?: ResearchModelEffort;
}

export interface ResolvedResearchModelConfig {
  provider: string;
  model: string;
  effort?: ResearchModelEffort;
  source: "config" | "cli" | "authorized-default";
  configPath?: string;
}

export const DEFAULT_RESEARCH_MODEL_CONFIG_RELATIVE_PATH = ".honeycrisp/config.json";

export interface ResolveResearchModelConfigOptions
  extends FileCredentialStoreOptions {
  configPath?: string;
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  effort?: ResearchModelEffort;
  getAuthStatus?: (
    providerId?: string,
    options?: FileCredentialStoreOptions,
  ) => Promise<AuthStatus>;
  verifyProviderAuth?: (
    providerId: string,
    modelId?: string,
    options?: FileCredentialStoreOptions,
  ) => Promise<AuthVerifyResult>;
}

export interface WriteResearchModelConfigOptions {
  configPath?: string;
  workspaceRoot?: string;
  preference: ResearchModelConfigPreference;
}

export function getDefaultResearchModelConfigPath(
  workspaceRoot: string = process.cwd(),
): string {
  return resolve(workspaceRoot, DEFAULT_RESEARCH_MODEL_CONFIG_RELATIVE_PATH);
}

export async function loadResearchModelConfig(
  configPath: string,
): Promise<ResearchModelConfigPreference> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const value = readConfigObject(parsed);

  rejectAuthLikeConfig(value, absolutePath);

  return normalizeResearchModelConfigPreference(value, absolutePath);
}

export async function loadDefaultResearchModelConfig(
  workspaceRoot: string = process.cwd(),
): Promise<ResearchModelConfigPreference | undefined> {
  const configPath = getDefaultResearchModelConfigPath(workspaceRoot);
  if (!(await pathExists(configPath))) {
    return undefined;
  }

  return loadResearchModelConfig(configPath);
}

export async function writeResearchModelConfig(
  options: WriteResearchModelConfigOptions,
): Promise<{
  configPath: string;
  preference: ResearchModelConfigPreference;
}> {
  const configPath = options.configPath
    ? resolve(options.configPath)
    : getDefaultResearchModelConfigPath(options.workspaceRoot);
  const preference = normalizeResearchModelConfigPreference(
    options.preference as Record<string, unknown>,
    configPath,
  );

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(preference, null, 2)}\n`,
    "utf8",
  );

  return { configPath, preference };
}

export async function resolveResearchModelConfig(
  options: ResolveResearchModelConfigOptions = {},
): Promise<ResolvedResearchModelConfig> {
  const explicitConfigPath = options.configPath
    ? resolve(options.configPath)
    : undefined;
  const defaultConfigPath = explicitConfigPath
    ? undefined
    : getDefaultResearchModelConfigPath(options.workspaceRoot);
  const configPath =
    explicitConfigPath ??
    (defaultConfigPath && await pathExists(defaultConfigPath)
      ? defaultConfigPath
      : undefined);
  const filePreference = configPath
    ? await loadResearchModelConfig(configPath)
    : {};
  const provider = options.provider ?? filePreference.provider;
  const model = options.model ?? filePreference.model;
  const effort = options.effort ?? filePreference.effort;
  const verify = options.verifyProviderAuth ?? verifyProviderAuth;
  const status = options.getAuthStatus ?? getAuthStatus;
  const authOptions = options.authFile ? { authFile: options.authFile } : {};
  const source = resolveConfigSource({
    cliPreference: Boolean(options.provider || options.model || options.effort),
    filePreference: Boolean(
      filePreference.provider || filePreference.model || filePreference.effort,
    ),
  });

  if (provider) {
    const verified = await verify(provider, model, authOptions);
    if (!verified.configured) {
      throw new Error(
        `research config selected ${verified.providerName} (${verified.providerId}) model ${verified.modelId}, but that provider is not authorized. Run: honeycrisp auth login ${verified.providerId}.`,
      );
    }

    return {
      provider: verified.providerId,
      model: verified.modelId,
      ...(effort ? { effort } : {}),
      source,
      ...(configPath ? { configPath } : {}),
    };
  }

  const authorizedDefault = await findFirstAuthorizedProviderModel({
    getAuthStatus: status,
    verifyProviderAuth: verify,
    authOptions,
    ...(model ? { model } : {}),
  });
  if (authorizedDefault) {
    return {
      provider: authorizedDefault.providerId,
      model: authorizedDefault.modelId,
      ...(effort ? { effort } : {}),
      source,
      ...(configPath ? { configPath } : {}),
    };
  }

  if (configPath) {
    throw new Error(
      `Research config file ${configPath} did not specify an authorized provider/model preference, and no authorized default provider was found.`,
    );
  }

  throw new Error(
    "No authorized model provider found. Run: honeycrisp auth login <provider>, or pass --config <path> with provider/model preferences for an already authorized provider.",
  );
}

function readConfigObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Research config file must contain a JSON object.");
  }

  if (isRecord(value.research)) {
    return value.research;
  }
  if (isRecord(value.model)) {
    return value.model;
  }

  return value;
}

function normalizeResearchModelConfigPreference(
  value: Record<string, unknown>,
  configPath: string,
): ResearchModelConfigPreference {
  const provider = readOptionalString(value.provider, "provider", configPath);
  const model = readOptionalString(value.model, "model", configPath);
  const effortValue = value.effort ?? value.reasoning;
  const effort =
    effortValue === undefined
      ? undefined
      : normalizeResearchModelEffort(effortValue, configPath);

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function normalizeResearchModelEffort(
  value: unknown,
  configPath: string,
): ResearchModelEffort {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }

  throw new Error(
    `Research config ${configPath} has invalid effort; expected minimal, low, medium, high, xhigh, or max.`,
  );
}

async function findFirstAuthorizedProviderModel(input: {
  getAuthStatus: NonNullable<ResolveResearchModelConfigOptions["getAuthStatus"]>;
  verifyProviderAuth: NonNullable<ResolveResearchModelConfigOptions["verifyProviderAuth"]>;
  authOptions: FileCredentialStoreOptions;
  model?: string;
}): Promise<AuthVerifyResult | undefined> {
  const status = await input.getAuthStatus(undefined, input.authOptions);
  for (const provider of status.providers) {
    if (!provider.storedCredentialType) {
      continue;
    }

    const verified = await input.verifyProviderAuth(
      provider.id,
      input.model,
      input.authOptions,
    );
    if (verified.configured) {
      return verified;
    }
  }

  return undefined;
}

function resolveConfigSource(input: {
  cliPreference: boolean;
  filePreference: boolean;
}): ResolvedResearchModelConfig["source"] {
  if (input.cliPreference) {
    return "cli";
  }
  if (input.filePreference) {
    return "config";
  }
  return "authorized-default";
}

function rejectAuthLikeConfig(
  value: Record<string, unknown>,
  configPath: string,
): void {
  const forbiddenKeys = [
    "apiKey",
    "api_key",
    "auth",
    "credential",
    "credentials",
    "token",
    "accessToken",
    "refreshToken",
  ];
  const forbidden = forbiddenKeys.find((key) => key in value);
  if (forbidden) {
    throw new Error(
      `Research config ${configPath} contains ${forbidden}; model config stores preferences only. Use honeycrisp auth login for credentials.`,
    );
  }
}

function readOptionalString(
  value: unknown,
  key: string,
  configPath: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Research config ${configPath} field ${key} must be a non-empty string.`);
  }

  return value.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
