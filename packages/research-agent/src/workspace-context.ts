import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ResearchStorageLayout,
  ResearchWorkspaceAuthorizationContext,
  ResearchWorkspaceContext,
  ResearchWorkspaceRepositoryContext,
  ResearchWorkspaceRepositoryRole,
} from "./types.js";

export interface CreateResearchWorkspaceContextInput {
  workspaceRoot: string;
  storageLayout: ResearchStorageLayout;
  knownRepositories?: readonly WorkspaceRepositoryInput[];
  materializedSourcePaths?: readonly string[];
  projectNotes?: readonly string[];
  authorization?: ResearchWorkspaceAuthorizationContext;
}

export type WorkspaceRepositoryInput =
  | string
  | Partial<ResearchWorkspaceRepositoryContext>;

export interface MergeResearchWorkspaceContextInput {
  base: ResearchWorkspaceContext;
  overlay?: ResearchWorkspaceContextOverlay;
}

export interface ResearchWorkspaceContextOverlay {
  schemaVersion?: 1;
  workspaceRoot?: string;
  memory?: Partial<ResearchWorkspaceContext["memory"]>;
  knownRepositories?: readonly ResearchWorkspaceRepositoryContext[];
  materializedSourcePaths?: readonly string[];
  projectNotes?: readonly string[];
  authorization?: ResearchWorkspaceAuthorizationContext;
}

export function createResearchWorkspaceContext(
  input: CreateResearchWorkspaceContextInput,
): ResearchWorkspaceContext {
  const workspaceRoot = resolve(input.workspaceRoot);
  const materializedSourcePaths = uniqueResolvedPaths(
    input.materializedSourcePaths ?? [],
  );
  const repositories = [
    ...normalizeRepositoryInputs(input.knownRepositories ?? [], "cli"),
    ...materializedSourcePaths.map((sourcePath) => ({
      rootPath: sourcePath,
      role: "materialized_source" as const,
      source: "inferred" as const,
    })),
  ];

  return {
    schemaVersion: 1,
    workspaceRoot,
    memory: {
      rootPath: resolve(input.storageLayout.rootPath),
      databasePath: resolve(input.storageLayout.databasePath),
      artifactDirectoryPath: resolve(input.storageLayout.artifactDirectoryPath),
      directories: input.storageLayout.directories,
      rules: input.storageLayout.rules,
    },
    ...(input.authorization ? { authorization: input.authorization } : {}),
    knownRepositories: uniqueRepositories(repositories),
    materializedSourcePaths,
    projectNotes: uniqueStrings(input.projectNotes ?? []),
  };
}

export function loadResearchWorkspaceContextFile(
  path: string,
): ResearchWorkspaceContextOverlay {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Workspace context file must contain a JSON object: ${path}`);
  }

  const workspaceRoot =
    typeof parsed.workspaceRoot === "string" ? resolve(parsed.workspaceRoot) : undefined;
  const knownRepositories = normalizeRepositoryInputs(
    [
      ...readArray(parsed.knownRepositories),
      ...readArray(parsed.repositories),
    ],
    "config",
  );
  const materializedSourcePaths = uniqueResolvedPaths([
    ...readStringArray(parsed.materializedSourcePaths),
    ...readStringArray(parsed.sourcePaths),
  ]);
  const projectNotes = uniqueStrings([
    ...readStringArray(parsed.projectNotes),
    ...readStringArray(parsed.notes),
  ]);
  const authorization = normalizeAuthorization(parsed.authorization);
  const memory = isRecord(parsed.memory)
    ? {
        ...(typeof parsed.memory.rootPath === "string"
          ? { rootPath: resolve(parsed.memory.rootPath) }
          : {}),
        ...(typeof parsed.memory.databasePath === "string"
          ? { databasePath: resolve(parsed.memory.databasePath) }
          : {}),
        ...(typeof parsed.memory.artifactDirectoryPath === "string"
          ? { artifactDirectoryPath: resolve(parsed.memory.artifactDirectoryPath) }
          : {}),
        ...(Array.isArray(parsed.memory.directories)
          ? { directories: parsed.memory.directories as ResearchStorageLayout["directories"] }
          : {}),
        ...(Array.isArray(parsed.memory.rules)
          ? { rules: readStringArray(parsed.memory.rules) }
          : {}),
      }
    : undefined;

  return {
    schemaVersion: 1,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(memory ? { memory } : {}),
    ...(authorization ? { authorization } : {}),
    ...(knownRepositories.length > 0 ? { knownRepositories } : {}),
    ...(materializedSourcePaths.length > 0 ? { materializedSourcePaths } : {}),
    ...(projectNotes.length > 0 ? { projectNotes } : {}),
  };
}

export function mergeResearchWorkspaceContexts(
  input: MergeResearchWorkspaceContextInput,
): ResearchWorkspaceContext {
  const overlay = input.overlay;
  if (!overlay) {
    return input.base;
  }

  return {
    ...input.base,
    ...(overlay.workspaceRoot ? { workspaceRoot: resolve(overlay.workspaceRoot) } : {}),
    memory: {
      ...input.base.memory,
      ...(overlay.memory?.rootPath ? { rootPath: resolve(overlay.memory.rootPath) } : {}),
      ...(overlay.memory?.databasePath
        ? { databasePath: resolve(overlay.memory.databasePath) }
        : {}),
      ...(overlay.memory?.artifactDirectoryPath
        ? { artifactDirectoryPath: resolve(overlay.memory.artifactDirectoryPath) }
        : {}),
      ...(overlay.memory?.directories ? { directories: overlay.memory.directories } : {}),
      ...(overlay.memory?.rules ? { rules: overlay.memory.rules } : {}),
    },
    ...(overlay.authorization
      ? { authorization: overlay.authorization }
      : input.base.authorization
        ? { authorization: input.base.authorization }
        : {}),
    knownRepositories: uniqueRepositories([
      ...input.base.knownRepositories,
      ...(overlay.knownRepositories ?? []),
    ]),
    materializedSourcePaths: uniqueResolvedPaths([
      ...input.base.materializedSourcePaths,
      ...(overlay.materializedSourcePaths ?? []),
    ]),
    projectNotes: uniqueStrings([
      ...input.base.projectNotes,
      ...(overlay.projectNotes ?? []),
    ]),
  };
}

function normalizeAuthorization(
  value: unknown,
): ResearchWorkspaceAuthorizationContext | undefined {
  if (!isRecord(value) || value.recorded !== true) {
    return undefined;
  }
  const source =
    value.source === "beale" || value.source === "cli" || value.source === "config"
      ? value.source
      : "config";
  return {
    recorded: true,
    source,
    ...optionalStringProperty(value, "scopeId"),
    ...optionalStringProperty(value, "scopeName"),
    ...optionalStringProperty(value, "scopeOwner"),
    ...optionalStringProperty(value, "networkProfile"),
    ...optionalStringProperty(value, "activeFrom"),
    ...optionalStringProperty(value, "expiresAt"),
  };
}

function optionalStringProperty(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? { [key]: candidate.trim() }
    : {};
}

export function workspaceContextFileReadHints(
  context: ResearchWorkspaceContext,
): string[] {
  return uniqueResolvedPaths([
    context.workspaceRoot,
    ...context.knownRepositories.map((repository) => repository.rootPath),
    ...context.materializedSourcePaths,
    context.memory.rootPath,
    context.memory.artifactDirectoryPath,
  ]);
}

function normalizeRepositoryInputs(
  inputs: readonly unknown[],
  fallbackSource: NonNullable<ResearchWorkspaceRepositoryContext["source"]>,
): ResearchWorkspaceRepositoryContext[] {
  return inputs.flatMap((input) => {
    if (typeof input === "string") {
      const trimmed = input.trim();
      return trimmed
        ? [{
            rootPath: resolve(trimmed),
            role: "known_repository" as const,
            source: fallbackSource,
          }]
        : [];
    }

    if (!isRecord(input) || typeof input.rootPath !== "string") {
      return [];
    }

    const role = normalizeRepositoryRole(input.role);
    return [{
      rootPath: resolve(input.rootPath),
      role,
      ...(input.label ? { label: String(input.label) } : {}),
      source: normalizeRepositorySource(input.source) ?? fallbackSource,
      ...(input.repositoryUrl ? { repositoryUrl: String(input.repositoryUrl) } : {}),
      ...(Array.isArray(input.notes)
        ? { notes: uniqueStrings(input.notes) }
        : {}),
    }];
  });
}

function normalizeRepositoryRole(
  value: unknown,
): ResearchWorkspaceRepositoryRole {
  if (
    value === "known_repository" ||
    value === "materialized_source" ||
    value === "workspace"
  ) {
    return value;
  }

  return "known_repository";
}

function normalizeRepositorySource(
  value: unknown,
): ResearchWorkspaceRepositoryContext["source"] | undefined {
  if (
    value === "cli" ||
    value === "config" ||
    value === "beale" ||
    value === "inferred"
  ) {
    return value;
  }

  return undefined;
}

function uniqueRepositories(
  repositories: readonly ResearchWorkspaceRepositoryContext[],
): ResearchWorkspaceRepositoryContext[] {
  const seen = new Set<string>();
  const unique: ResearchWorkspaceRepositoryContext[] = [];
  for (const repository of repositories) {
    const rootPath = resolve(repository.rootPath);
    const key = rootPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      ...repository,
      rootPath,
    });
  }
  return unique;
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  return uniqueStrings(paths).map((path) => resolve(path));
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value: unknown): string[] {
  return uniqueStrings(readArray(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
