import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AuthLoginCallbacks,
  Credential,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";

export interface FileCredentialStoreOptions {
  authFile?: string;
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

type CredentialFile = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  readonly #authFile: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: FileCredentialStoreOptions = {}) {
    this.#authFile = options.authFile ?? getDefaultAuthFile();
  }

  get authFile(): string {
    return this.#authFile;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credentials = await this.#readAll();
    return credentials[providerId];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const credentials = await this.#readAll();
      const current = credentials[providerId];
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
}

export function getDefaultAuthFile(): string {
  const configured = process.env.HONEYCRISP_AUTH_FILE;
  if (configured) {
    return resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  }

  return join(homedir(), ".honeycrisp", "auth.json");
}

export function createCredentialStore(
  options: FileCredentialStoreOptions = {},
): FileCredentialStore {
  return new FileCredentialStore(options);
}

export function createAuthenticatedModels(
  options: FileCredentialStoreOptions = {},
): Models {
  return builtinModels({
    credentials: createCredentialStore(options),
  });
}

export function listAuthProviders(): AuthProviderSummary[] {
  return builtinModels()
    .getProviders()
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      authMethods: getProviderAuthMethods(provider.auth),
    }))
    .filter((provider) => provider.authMethods.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
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
  const models = builtinModels();
  const provider = models.getProvider(providerId);

  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
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
  await store.delete(providerId);
}

export async function verifyProviderAuth(
  providerId: string,
  modelId?: string,
  options: FileCredentialStoreOptions = {},
): Promise<AuthVerifyResult> {
  const store = createCredentialStore(options);
  const models = builtinModels({
    credentials: store,
  });
  const provider = models.getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const model = modelId
    ? models.getModel(providerId, modelId)
    : models.getModels(providerId)[0];

  if (!model) {
    throw new Error(
      modelId
        ? `Unknown model for ${providerId}: ${modelId}`
        : `No built-in models found for provider: ${providerId}`,
    );
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

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
