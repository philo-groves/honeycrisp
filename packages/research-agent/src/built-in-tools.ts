import {
  opendir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { nowIso } from "./ids.js";
import {
  getResearchStorageManifestPath,
  listResearchStorageArtifacts,
} from "./storage.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import {
  createCodeIntelligenceTools,
  type BuiltInCodeIntelligenceToolOptions,
} from "./code-tools.js";
import type {
  ResearchArtifactRef,
  ResearchStorageLayout,
  ResearchToolAction,
  ResearchToolDescriptor,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_BYTES = 16_384;
const DEFAULT_REPOSITORY_SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_REPOSITORY_SEARCH_MAX_VISITED_FILES = 50_000;
const GIT_SEARCH_CANDIDATE_MULTIPLIER = 4;
const REPOSITORY_SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".honeycrisp",
  ".beale",
  "node_modules",
]);
const REPOSITORY_SEARCH_PARAMETERS = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    root: {
      type: "string",
      description:
        "Optional configured root path or unique root label. Use this to scope searches in multi-repository workspaces.",
    },
    maxResults: { type: "number" },
  },
};
const STRUCTURED_FILE_READ_PARAMETERS = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string" },
    offset: { type: "number" },
    maxBytes: { type: "number" },
  },
};
const ANALYSIS_PARAMETERS = {
  type: "object",
  required: ["operation"],
  properties: {
    operation: { type: "string" },
    text: { type: "string" },
    left: { type: "string" },
    right: { type: "string" },
  },
};
const EXPERIMENT_PARAMETERS = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    input: { type: "object" },
  },
};
const SYNTHESIS_PARAMETERS = {
  type: "object",
  required: ["title"],
  properties: {
    title: { type: "string" },
    sections: { type: "array" },
    artifactKind: { type: "string" },
  },
};
const STORAGE_LIST_PARAMETERS = {
  type: "object",
  properties: {
    kind: { type: "string" },
    sourceEventId: { type: "string" },
  },
};

export interface BuiltInRepositorySearchToolOptions {
  root?: string;
  roots?: readonly string[];
  maxResults?: number;
  maxFileBytes?: number;
  maxDurationMs?: number;
  maxVisitedFiles?: number;
}

export interface BuiltInStructuredFileReadToolOptions {
  allowedRoots?: readonly string[];
  contextRoots?: readonly string[];
  maxBytes?: number;
}

export interface BuiltInExperimentToolOptions {
  experiments: Record<
    string,
    (input: Record<string, unknown>) => Promise<unknown> | unknown
  >;
}

export interface BuiltInStorageListToolOptions {
  storageLayout: ResearchStorageLayout;
}

export interface DefaultBuiltInToolFamilyOptions {
  repositorySearch?: BuiltInRepositorySearchToolOptions;
  fileRead?: BuiltInStructuredFileReadToolOptions;
  code?: BuiltInCodeIntelligenceToolOptions;
  experiments?: BuiltInExperimentToolOptions;
  storage?: BuiltInStorageListToolOptions;
}

export function createRepositorySearchTool(
  options: BuiltInRepositorySearchToolOptions,
): ResearchExecutableTool {
  const rootHints = uniqueResolvedPaths([
    ...(options.root ? [options.root] : []),
    ...(options.roots ?? []),
  ]);
  const descriptor = createDescriptor({
    name: "repository.search",
    transportName: "repository_search",
    description:
      "Search for a case-insensitive literal text phrase under repository and source context paths. Pass root as a configured path, unique root label, or any readable absolute directory path to keep searches fast and targeted. Time-limited searches return explicitly marked partial results instead of discarding prior matches.",
    actionClasses: ["search", "inspect"],
    sideEffects: "read",
    requiredPermissions: ["filesystem:read"],
    inputSchema: REPOSITORY_SEARCH_PARAMETERS,
    artifactLocations: rootHints,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "host-filesystem-read",
      defaultBudget: {
        maxToolCalls: 1,
        maxFiles: DEFAULT_MAX_RESULTS,
        maxBytes: options.maxFileBytes ?? DEFAULT_MAX_BYTES,
      },
    },
  });

  return {
    descriptor,
    parameters: REPOSITORY_SEARCH_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action, context) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const query = readRequiredString(action.input, "query");
        const maxResults = readPositiveInteger(
          action.input.maxResults,
          options.maxResults ?? DEFAULT_MAX_RESULTS,
        );
        const requestedRoot = typeof action.input.root === "string"
          ? action.input.root.trim()
          : "";
        const availableRoots = await resolveExistingRoots(rootHints);
        if (availableRoots.length === 0 && !requestedRoot) {
          throw new Error(
            "repository.search has no readable repository or source context paths.",
          );
        }
        const roots = requestedRoot
          ? await resolveRepositorySearchRoots(availableRoots, requestedRoot)
          : availableRoots;
        const maxDurationMs = options.maxDurationMs ?? DEFAULT_REPOSITORY_SEARCH_TIMEOUT_MS;
        const searchState = {
          deadline: Date.now() + maxDurationMs,
          maxDurationMs,
          maxVisitedFiles: options.maxVisitedFiles ?? DEFAULT_REPOSITORY_SEARCH_MAX_VISITED_FILES,
          visitedFiles: 0,
          ...(context?.signal ? { signal: context.signal } : {}),
        };
        const matches: {
          root: string;
          path: string;
          line: number;
          preview: string;
        }[] = [];
        const attemptedRoots: string[] = [];
        let timedOut = false;
        for (const root of roots) {
          if (matches.length >= maxResults) {
            break;
          }
          attemptedRoots.push(root);
          try {
            const rootMatches = await searchRepository(root, query, {
              maxResults: maxResults - matches.length,
              maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_BYTES,
              state: searchState,
            });
            matches.push(...rootMatches.map((match) => ({ ...match, root })));
          } catch (error) {
            if (!(error instanceof RepositorySearchTimeoutError)) throw error;
            timedOut = true;
            break;
          }
        }

        return completeResult(action, startedAt, {
          summary: timedOut
            ? `Repository search reached its ${maxDurationMs}ms limit and returned ${matches.length} partial match(es). Retry with a configured root label or a narrower absolute directory path.`
            : `Repository search found ${matches.length} match(es) across ${attemptedRoots.length} context root(s) for: ${query}`,
          output: {
            roots,
            availableRoots: availableRoots.map((root) => ({
              label: repositorySearchRootLabel(root),
              path: root,
            })),
            attemptedRoots,
            query,
            matches,
            partial: timedOut,
            timedOut,
          },
        });
      });
    },
  };
}

export function createStructuredFileReadTool(
  options: BuiltInStructuredFileReadToolOptions,
): ResearchExecutableTool {
  const contextRootHints = uniqueResolvedPaths([
    ...(options.contextRoots ?? []),
    ...(options.allowedRoots ?? []),
  ]);
  const descriptor = createDescriptor({
    name: "file.read",
    transportName: "file_read",
    description:
      "Read a bounded byte range from a local file. Workspace context roots are audit hints, not access fences.",
    actionClasses: ["inspect"],
    sideEffects: "read",
    requiredPermissions: ["filesystem:read"],
    inputSchema: STRUCTURED_FILE_READ_PARAMETERS,
    artifactLocations: contextRootHints,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "workspace-context-filesystem-read",
      defaultBudget: {
        maxToolCalls: 1,
        maxFiles: 1,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      },
    },
  });

  return {
    descriptor,
    parameters: STRUCTURED_FILE_READ_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const roots = await resolveExistingRoots(contextRootHints);
        const target = await resolvePathWithContextRoot(
          readRequiredString(action.input, "path"),
          roots,
        );
        const offset = readNonNegativeInteger(action.input.offset, 0);
        const maxBytes = Math.min(
          readPositiveInteger(action.input.maxBytes, options.maxBytes ?? DEFAULT_MAX_BYTES),
          options.maxBytes ?? DEFAULT_MAX_BYTES,
        );
        const file = await readFile(target.path);
        const slice = file.subarray(offset, offset + maxBytes);
        const text = slice.toString("utf8");
        const truncated = offset + maxBytes < file.length;

        return completeResult(action, startedAt, {
          summary: `Read ${slice.length} byte(s) from ${target.path}${truncated ? " with truncation" : ""}${target.root ? "" : " outside workspace context hints"}.`,
          output: {
            requestedPath: action.input.path,
            resolvedPath: target.path,
            root: target.root ?? null,
            contextRoots: roots,
            withinContextRoot: Boolean(target.root),
            offset,
            bytesRead: slice.length,
            totalBytes: file.length,
            truncated,
            encoding: "utf8",
            containsNulByte: slice.includes(0),
            text,
          },
        });
      });
    },
  };
}

export function createAnalysisTool(): ResearchExecutableTool {
  const descriptor = createDescriptor({
    name: "analysis.transform",
    transportName: "analysis_transform",
    description: "Run deterministic text analysis transforms such as counts and diffs.",
    actionClasses: ["analyze"],
    sideEffects: "none",
    requiredPermissions: [],
    inputSchema: ANALYSIS_PARAMETERS,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "deterministic-transform",
      defaultBudget: {
        maxToolCalls: 1,
      },
    },
  });

  return {
    descriptor,
    parameters: ANALYSIS_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const operation = readRequiredString(action.input, "operation");
        const output =
          operation === "diff"
            ? createLineDiff(
                readRequiredString(action.input, "left"),
                readRequiredString(action.input, "right"),
              )
            : createTextMetrics(readRequiredString(action.input, "text"));

        return completeResult(action, startedAt, {
          summary: `Analysis transform ${operation} completed.`,
          output,
        });
      });
    },
  };
}

export function createExperimentTool(
  options: BuiltInExperimentToolOptions,
): ResearchExecutableTool {
  const descriptor = createDescriptor({
    name: "experiment.run",
    transportName: "experiment_run",
    description: "Run an allowlisted deterministic experiment by name.",
    actionClasses: ["experiment"],
    sideEffects: "process",
    requiredPermissions: ["experiment:run"],
    inputSchema: EXPERIMENT_PARAMETERS,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "allowlisted-process",
      defaultBudget: {
        maxToolCalls: 1,
      },
      experiments: Object.keys(options.experiments),
    },
  });

  return {
    descriptor,
    parameters: EXPERIMENT_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const name = readRequiredString(action.input, "name");
        const experiment = options.experiments[name];
        if (!experiment) {
          return errorResult(action, startedAt, `Unknown experiment: ${name}`);
        }

        const output = await experiment(
          isRecord(action.input.input) ? action.input.input : {},
        );
        return completeResult(action, startedAt, {
          summary: `Experiment ${name} completed.`,
          output: {
            name,
            output,
          },
        });
      });
    },
  };
}

export function createSynthesisTool(): ResearchExecutableTool {
  const descriptor = createDescriptor({
    name: "synthesis.compose",
    transportName: "synthesis_compose",
    description: "Compose a deterministic report, patch sketch, or artifact summary.",
    actionClasses: ["synthesize"],
    sideEffects: "none",
    requiredPermissions: [],
    inputSchema: SYNTHESIS_PARAMETERS,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "deterministic-synthesis",
      defaultBudget: {
        maxToolCalls: 1,
      },
    },
  });

  return {
    descriptor,
    parameters: SYNTHESIS_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const title = readRequiredString(action.input, "title");
        const sections = Array.isArray(action.input.sections)
          ? action.input.sections.map(String)
          : [];
        const artifactKind =
          typeof action.input.artifactKind === "string"
            ? action.input.artifactKind
            : "report";
        const text = [`# ${title}`, "", ...sections].join("\n");
        const artifactRef: ResearchArtifactRef = {
          id: `artifact_${action.id}_synthesis`,
          kind: artifactKind,
          summary: title,
        };

        return completeResult(action, startedAt, {
          summary: `Synthesized ${artifactKind}: ${title}`,
          output: {
            title,
            artifactKind,
            text,
          },
          artifactRefs: [artifactRef],
        });
      });
    },
  };
}

export function createStorageListTool(
  options: BuiltInStorageListToolOptions,
): ResearchExecutableTool {
  const descriptor = createDescriptor({
    name: "storage.list",
    transportName: "storage_list",
    description: "List durable Honeycrisp storage directories and registered artifact metadata.",
    actionClasses: ["inspect"],
    sideEffects: "read",
    requiredPermissions: ["storage:read"],
    inputSchema: STORAGE_LIST_PARAMETERS,
    artifactLocations: [options.storageLayout.rootPath],
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "storage-read",
      defaultBudget: {
        maxToolCalls: 1,
      },
    },
  });

  return {
    descriptor,
    parameters: STORAGE_LIST_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, async () => {
        const kind =
          typeof action.input.kind === "string" && action.input.kind.trim()
            ? action.input.kind.trim()
            : undefined;
        const sourceEventId =
          typeof action.input.sourceEventId === "string" &&
          action.input.sourceEventId.trim()
            ? action.input.sourceEventId.trim()
            : undefined;
        const artifacts = listResearchStorageArtifacts(options.storageLayout, {
          ...(kind ? { kind } : {}),
          ...(sourceEventId ? { sourceEventId } : {}),
        });

        return completeResult(action, startedAt, {
          summary: `Storage manifest contains ${artifacts.length} artifact(s).`,
          output: {
            rootPath: options.storageLayout.rootPath,
            databasePath: options.storageLayout.databasePath,
            manifestPath: getResearchStorageManifestPath(options.storageLayout),
            directories: options.storageLayout.directories,
            filters: {
              ...(kind ? { kind } : {}),
              ...(sourceEventId ? { sourceEventId } : {}),
            },
            artifactCount: artifacts.length,
            artifacts,
          },
        });
      });
    },
  };
}

export function createDefaultBuiltInToolFamily(
  options: DefaultBuiltInToolFamilyOptions = {},
): ResearchExecutableTool[] {
  return [
    ...(options.repositorySearch
      ? [createRepositorySearchTool(options.repositorySearch)]
      : []),
    ...(options.fileRead ? [createStructuredFileReadTool(options.fileRead)] : []),
    ...(options.code ? createCodeIntelligenceTools(options.code) : []),
    ...(options.storage ? [createStorageListTool(options.storage)] : []),
    createAnalysisTool(),
    ...(options.experiments ? [createExperimentTool(options.experiments)] : []),
    createSynthesisTool(),
  ];
}

function createDescriptor(input: ResearchToolDescriptor): ResearchToolDescriptor {
  return input;
}

function completeResult(
  action: ResearchToolAction,
  startedAt: string,
  input: {
    summary: string;
    output: unknown;
    artifactRefs?: readonly ResearchArtifactRef[];
  },
): ResearchToolExecutionResult {
  return {
    action,
    status: "complete",
    startedAt,
    completedAt: nowIso(),
    summary: input.summary,
    output: input.output,
    artifactRefs: input.artifactRefs ?? [],
    followUpActions: [],
  };
}

function errorResult(
  action: ResearchToolAction,
  startedAt: string,
  message: string,
): ResearchToolExecutionResult {
  return {
    action,
    status: "error",
    startedAt,
    completedAt: nowIso(),
    summary: message,
    followUpActions: ["Report the tool failure before continuing."],
    error: {
      message,
    },
  };
}

async function completeOrError(
  action: ResearchToolAction,
  startedAt: string,
  run: () => Promise<ResearchToolExecutionResult>,
): Promise<ResearchToolExecutionResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(action, startedAt, message);
  }
}

async function searchRepository(
  root: string,
  query: string,
  options: {
    maxResults: number;
    maxFileBytes: number;
    state: RepositorySearchState;
  },
) {
  assertRepositorySearchActive(options.state);
  const gitMatches = await searchGitRepository(root, query, options);
  if (gitMatches !== undefined) return gitMatches;

  const matches: {
    path: string;
    line: number;
    preview: string;
  }[] = [];
  const needle = query.toLowerCase();

  async function visit(directory: string): Promise<void> {
    assertRepositorySearchActive(options.state);
    if (matches.length >= options.maxResults) {
      return;
    }

    const entries = await opendir(directory);
    for await (const entry of entries) {
      assertRepositorySearchActive(options.state);
      if (
        matches.length >= options.maxResults ||
        REPOSITORY_SEARCH_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }

      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        options.state.visitedFiles += 1;
        if (options.state.visitedFiles > options.state.maxVisitedFiles) {
          throw new Error(
            `Repository search stopped after inspecting ${options.state.maxVisitedFiles} files. Narrow the query or repository roots.`,
          );
        }
        const fileStat = await stat(path);
        if (fileStat.size > options.maxFileBytes) {
          continue;
        }

        const text = await readFile(path, "utf8").catch(() => undefined);
        if (!text) {
          continue;
        }

        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.toLowerCase().includes(needle)) {
            matches.push({
              path: portableRelativePath(root, path),
              line: index + 1,
              preview: line.trim().slice(0, 240),
            });
            if (matches.length >= options.maxResults) {
              break;
            }
          }
        }
      }
    }
  }

  await visit(root);
  return matches;
}

interface RepositorySearchState {
  deadline: number;
  maxDurationMs: number;
  maxVisitedFiles: number;
  visitedFiles: number;
  signal?: AbortSignal;
}

class RepositorySearchTimeoutError extends Error {
  constructor(maxDurationMs: number) {
    super(
      `Repository search timed out after ${maxDurationMs}ms. Narrow the query or select a repository root.`,
    );
    this.name = "RepositorySearchTimeoutError";
  }
}

async function searchGitRepository(
  root: string,
  query: string,
  options: {
    maxResults: number;
    maxFileBytes: number;
    state: RepositorySearchState;
  },
): Promise<{ path: string; line: number; preview: string }[] | undefined> {
  const gitMarker = await stat(join(root, ".git")).catch(() => undefined);
  if (!gitMarker) return undefined;

  const maxCandidates = Math.max(
    options.maxResults + 8,
    options.maxResults * GIT_SEARCH_CANDIDATE_MULTIPLIER,
  );
  const candidates = await gitGrepCandidatePaths(
    root,
    query,
    maxCandidates,
    options.state,
  );
  if (candidates === undefined) return undefined;

  const matches: { path: string; line: number; preview: string }[] = [];
  const needle = query.toLowerCase();
  for (const candidate of candidates) {
    assertRepositorySearchActive(options.state);
    const path = resolve(root, candidate);
    const relativePath = relative(root, path);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
    const fileStat = await stat(path).catch(() => undefined);
    if (!fileStat?.isFile() || fileStat.size > options.maxFileBytes) continue;
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.toLowerCase().includes(needle)) continue;
      matches.push({
        path: portableRelativePath(root, path),
        line: index + 1,
        preview: line.trim().slice(0, 240),
      });
      if (matches.length >= options.maxResults) return matches;
    }
  }
  return matches;
}

function gitGrepCandidatePaths(
  root: string,
  query: string,
  maxCandidates: number,
  state: RepositorySearchState,
): Promise<string[] | undefined> {
  assertRepositorySearchActive(state);
  return new Promise((resolveCandidates, reject) => {
    const child = spawn("git", [
      "-c",
      "color.grep=false",
      "-c",
      `safe.directory=${root}`,
      "-C",
      root,
      "grep",
      "-l",
      "-z",
      "-I",
      "-i",
      "-F",
      "-e",
      query,
      "--",
      ".",
      ":(glob,exclude)**/.beale/**",
      ":(glob,exclude)**/.honeycrisp/**",
      ":(glob,exclude)**/.hg/**",
      ":(glob,exclude)**/.svn/**",
      ":(glob,exclude)**/node_modules/**",
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const candidates: string[] = [];
    let pending = "";
    let settled = false;
    let reachedLimit = false;
    const remainingMs = Math.max(1, state.deadline - Date.now());
    const finish = (value: string[] | undefined, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      state.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveCandidates(value);
    };
    const stopAtLimit = () => {
      if (candidates.length < maxCandidates) return;
      reachedLimit = true;
      child.kill();
    };
    const consume = (chunk: string) => {
      pending += chunk;
      let separator = pending.indexOf("\0");
      while (separator >= 0 && !reachedLimit) {
        const candidate = pending.slice(0, separator);
        pending = pending.slice(separator + 1);
        if (candidate) candidates.push(candidate);
        stopAtLimit();
        separator = pending.indexOf("\0");
      }
    };
    const abort = () => {
      child.kill();
      finish(undefined, new Error("Repository search was interrupted."));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        undefined,
        new RepositorySearchTimeoutError(state.maxDurationMs),
      );
    }, remainingMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.once("error", () => finish(undefined));
    child.once("close", (code) => {
      if (!reachedLimit && pending) candidates.push(pending);
      finish(code === 0 || code === 1 || reachedLimit ? candidates : undefined);
    });
    state.signal?.addEventListener("abort", abort, { once: true });
    if (state.signal?.aborted) abort();
  });
}

function assertRepositorySearchActive(state: RepositorySearchState): void {
  if (state.signal?.aborted) {
    throw new Error("Repository search was interrupted.");
  }
  if (Date.now() >= state.deadline) {
    throw new RepositorySearchTimeoutError(state.maxDurationMs);
  }
}

function repositorySearchRootLabel(root: string): string {
  const name = basename(root);
  return name.toLowerCase() === "default" ? basename(dirname(root)) : name;
}

function selectRepositorySearchRoots(
  roots: readonly string[],
  requestedRoot: string,
): string[] {
  const normalizedRequest = requestedRoot.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const matches = roots.filter((root) => {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    const label = repositorySearchRootLabel(root).toLowerCase();
    return normalizedRoot === normalizedRequest
      || label === normalizedRequest
      || normalizedRoot.endsWith(`/${normalizedRequest}`);
  });
  if (matches.length === 1) return matches;

  const labels = roots.map((root) => repositorySearchRootLabel(root)).join(", ");
  if (matches.length > 1) {
    throw new Error(
      `repository.search root "${requestedRoot}" is ambiguous. Use an exact configured path. Available root labels: ${labels}`,
    );
  }
  throw new Error(
    `repository.search root "${requestedRoot}" is not configured. Available root labels: ${labels}`,
  );
}

async function resolveRepositorySearchRoots(
  configuredRoots: readonly string[],
  requestedRoot: string,
): Promise<string[]> {
  try {
    return selectRepositorySearchRoots(configuredRoots, requestedRoot);
  } catch (error) {
    if (!isAbsolute(requestedRoot)) throw error;
  }

  const [resolvedRoot] = await resolveExistingRoots([requestedRoot]);
  const rootStat = resolvedRoot
    ? await stat(resolvedRoot).catch(() => undefined)
    : undefined;
  if (!resolvedRoot || !rootStat?.isDirectory()) {
    throw new Error(
      `repository.search root "${requestedRoot}" is not a readable directory.`,
    );
  }
  return [resolvedRoot];
}

function portableRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path) || basename(path);
  return relativePath.split(sep).join("/");
}

function uniqueResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) {
      continue;
    }
    const absolute = resolve(trimmed);
    const key = absolute.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push(absolute);
  }
  return resolved;
}

async function resolveExistingRoots(
  roots: readonly string[],
): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    const rootPath = await realpath(resolve(root)).catch(() => undefined);
    if (rootPath) {
      resolved.push(rootPath);
    }
  }
  return uniqueResolvedPaths(resolved);
}

async function resolvePathWithContextRoot(
  requestedPath: string,
  roots: readonly string[],
): Promise<{ path: string; root?: string }> {
  const target = await realpath(resolve(requestedPath));
  const root = roots.find((candidate) => {
    const relativePath = relative(candidate, target);
    return relativePath === "" || (!relativePath.startsWith("..") && relativePath !== "..");
  });

  return {
    path: target,
    ...(root ? { root } : {}),
  };
}

function createTextMetrics(text: string) {
  return {
    operation: "metrics",
    characters: text.length,
    lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
  };
}

function createLineDiff(left: string, right: string) {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const max = Math.max(leftLines.length, rightLines.length);
  const changes: string[] = [];
  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      if (leftLines[index] !== undefined) {
        changes.push(`-${index + 1}: ${leftLines[index]}`);
      }
      if (rightLines[index] !== undefined) {
        changes.push(`+${index + 1}: ${rightLines[index]}`);
      }
    }
  }

  return {
    operation: "diff",
    changes,
  };
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
