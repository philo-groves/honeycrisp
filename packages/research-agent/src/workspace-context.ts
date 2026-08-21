import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ResearchMemoryContext,
  ResearchWorkspaceAuthorizationContext,
  ResearchWorkspaceContext,
  ResearchWorkspaceRepositoryContext,
  ResearchWorkspaceRepositoryRole,
} from "./types.js";

export interface CreateResearchWorkspaceContextInput {
  workspaceRoot: string;
  knownRepositories?: readonly WorkspaceRepositoryInput[];
  materializedSourcePaths?: readonly string[];
  projectNotes?: readonly string[];
  authorization?: ResearchWorkspaceAuthorizationContext;
  memoryContext?: ResearchMemoryContext;
  sourceRevision?: string;
  environmentFingerprint?: string;
  authorizedAssetIds?: readonly string[];
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
  knownRepositories?: readonly ResearchWorkspaceRepositoryContext[];
  materializedSourcePaths?: readonly string[];
  projectNotes?: readonly string[];
  authorization?: ResearchWorkspaceAuthorizationContext;
  memoryContext?: ResearchMemoryContext;
  sourceRevision?: string;
  environmentFingerprint?: string;
  authorizedAssetIds?: readonly string[];
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
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.memoryContext ? { memoryContext: input.memoryContext } : {}),
    ...(normalizedString(input.sourceRevision) ? { sourceRevision: normalizedString(input.sourceRevision)! } : {}),
    ...(normalizedString(input.environmentFingerprint)
      ? { environmentFingerprint: normalizedString(input.environmentFingerprint)! }
      : {}),
    ...(input.authorizedAssetIds ? { authorizedAssetIds: uniqueStrings(input.authorizedAssetIds) } : {}),
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
  const memoryContext = normalizeMemoryContext(parsed.memoryContext ?? parsed.memoryTierContext);
  const sourceRevision = normalizedString(parsed.sourceRevision);
  const environmentFingerprint = normalizedString(parsed.environmentFingerprint);
  const authorizedAssetIds = uniqueStrings(readStringArray(parsed.authorizedAssetIds));
  return {
    schemaVersion: 1,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(authorization ? { authorization } : {}),
    ...(memoryContext ? { memoryContext } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(environmentFingerprint ? { environmentFingerprint } : {}),
    ...(authorizedAssetIds.length > 0 ? { authorizedAssetIds } : {}),
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
    ...(overlay.authorization
      ? { authorization: overlay.authorization }
      : input.base.authorization
        ? { authorization: input.base.authorization }
        : {}),
    ...(overlay.memoryContext
      ? { memoryContext: overlay.memoryContext }
      : input.base.memoryContext
        ? { memoryContext: input.base.memoryContext }
        : {}),
    ...(overlay.sourceRevision ?? input.base.sourceRevision
      ? { sourceRevision: overlay.sourceRevision ?? input.base.sourceRevision! }
      : {}),
    ...(overlay.environmentFingerprint ?? input.base.environmentFingerprint
      ? { environmentFingerprint: overlay.environmentFingerprint ?? input.base.environmentFingerprint! }
      : {}),
    ...(overlay.authorizedAssetIds ?? input.base.authorizedAssetIds
      ? { authorizedAssetIds: uniqueStrings(overlay.authorizedAssetIds ?? input.base.authorizedAssetIds ?? []) }
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

function normalizeMemoryContext(value: unknown): ResearchMemoryContext | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  const workspaceName = typeof value.workspaceName === "string" ? value.workspaceName.trim() : "";
  if (!workspaceId || !workspaceName) return undefined;
  const recordedSubjectId = typeof value.subjectId === "string" ? value.subjectId.trim() : "";
  const recordedSubjectName = typeof value.subjectName === "string" ? value.subjectName.trim() : "";
  const subjectId = recordedSubjectId || `subject_workspace:${workspaceId}`;
  const subjectName = recordedSubjectName || workspaceName;
  return {
    ...(typeof value.sessionId === "string" && value.sessionId.trim() ? { sessionId: value.sessionId.trim() } : {}),
    workspaceId,
    workspaceName,
    subjectId,
    subjectName,
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
    ...optionalStringProperty(value, "activeFrom"),
    ...optionalStringProperty(value, "expiresAt"),
  };
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    ...context.knownRepositories.flatMap((repository) => repository.contentRoots ?? []),
    ...context.materializedSourcePaths,
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
      ...(Array.isArray(input.contentRoots)
        ? { contentRoots: uniqueResolvedPaths(input.contentRoots.filter((value): value is string => typeof value === "string")) }
        : {}),
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
      ...(repository.contentRoots
        ? { contentRoots: uniqueResolvedPaths(repository.contentRoots) }
        : {}),
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
