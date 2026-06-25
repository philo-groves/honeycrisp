import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dirname,
  relative,
  resolve,
} from "node:path";
import type {
  ResearchArtifactRef,
  ResearchStorageDirectory,
  ResearchStorageDirectoryName,
  ResearchStorageLayout,
} from "./types.js";

export const DEFAULT_MEMORY_DATABASE_RELATIVE_PATH = ".honeycrisp/memory/memory.sqlite";
export const DEFAULT_ARTIFACT_RELATIVE_PATH = ".honeycrisp/memory/artifacts";
export const RESEARCH_STORAGE_MANIFEST_FILENAME = "manifest.json";

const DEFAULT_STORAGE_DIRECTORIES: readonly {
  name: ResearchStorageDirectoryName;
  purpose: string;
}[] = [
  {
    name: "events",
    purpose: "Append-only event logs, raw transcripts, and event-adjacent file payloads.",
  },
  {
    name: "episodes",
    purpose: "Loop and session summaries linked to accepted event ids.",
  },
  {
    name: "claims",
    purpose: "Semantic claim graph data, citations, support links, and contradiction material.",
  },
  {
    name: "procedures",
    purpose: "Reusable runbooks, scripts, tool recipes, and known recovery patterns.",
  },
  {
    name: "hypotheses",
    purpose: "Active and retired research hypotheses with evidence for and against.",
  },
  {
    name: "prospective",
    purpose: "Scheduled follow-ups, monitoring commitments, and future checks.",
  },
  {
    name: "artifacts",
    purpose: "Reports, generated files, extracted data, raw tool outputs, and experiment outputs.",
  },
  {
    name: "scratch",
    purpose: "Miscellaneous persistent workspace files that are not yet structured elsewhere.",
  },
];

export interface CreateResearchStorageLayoutOptions {
  workspaceRoot?: string;
  databasePath?: string;
  artifactDirectoryPath?: string;
}

export interface ResearchStorageArtifactManifestEntry {
  id: string;
  kind: string;
  purpose: string;
  path: string;
  relativePath: string;
  uri: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  sourceEventIds: readonly string[];
}

export interface ResearchStorageArtifactManifest {
  schemaVersion: 1;
  manifestPath: string;
  updatedAt?: string;
  artifacts: readonly ResearchStorageArtifactManifestEntry[];
}

export interface RegisterResearchStorageArtifactInput {
  id?: string;
  path: string;
  kind: string;
  purpose?: string;
  sourceEventIds?: readonly string[];
  createdAt?: string;
}

export function getDefaultMemoryDatabasePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_MEMORY_DATABASE_RELATIVE_PATH);
}

export function getDefaultMemoryArtifactDirectoryPath(
  workspaceRoot: string,
): string {
  return resolve(workspaceRoot, DEFAULT_ARTIFACT_RELATIVE_PATH);
}

export function createResearchStorageLayout(
  options: CreateResearchStorageLayoutOptions = {},
): ResearchStorageLayout {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const databasePath =
    options.databasePath ?? getDefaultMemoryDatabasePath(workspaceRoot);
  const rootPath = deriveStorageRootPath(databasePath, workspaceRoot);
  const artifactDirectoryPath =
    options.artifactDirectoryPath ??
    getDefaultMemoryArtifactDirectoryPath(workspaceRoot);

  return {
    schemaVersion: 1,
    rootPath,
    databasePath,
    artifactDirectoryPath,
    directories: DEFAULT_STORAGE_DIRECTORIES.map((directory) => ({
      name: directory.name,
      path:
        directory.name === "artifacts"
          ? artifactDirectoryPath
          : resolve(rootPath, directory.name),
      purpose: directory.purpose,
    })),
    rules: [
      "Memory is for recallable facts, summaries, claims, decisions, procedures, commitments, and paths to persisted files.",
      "Storage is for durable files, blobs, artifacts, binaries, raw logs, generated outputs, and other non-memory objects.",
      "When a stored file should be recalled later, write a memory event or trace that summarizes it and includes the file path or artifact reference.",
      "Use events, episodes, claims, procedures, hypotheses, prospective, artifacts, and scratch according to their directory purposes.",
    ],
  };
}

export function ensureResearchStorageLayout(
  layout: ResearchStorageLayout,
): ResearchStorageLayout {
  if (layout.databasePath !== ":memory:") {
    mkdirSync(dirname(layout.databasePath), { recursive: true });
  }
  mkdirSync(layout.rootPath, { recursive: true });
  mkdirSync(layout.artifactDirectoryPath, { recursive: true });
  for (const directory of layout.directories) {
    mkdirSync(directory.path, { recursive: true });
  }

  return layout;
}

export function findResearchStorageDirectory(
  layout: ResearchStorageLayout,
  name: ResearchStorageDirectoryName,
): ResearchStorageDirectory {
  const directory = layout.directories.find((candidate) => candidate.name === name);
  if (!directory) {
    throw new Error(`Missing research storage directory: ${name}`);
  }

  return directory;
}

export function getResearchStorageManifestPath(
  layout: ResearchStorageLayout,
): string {
  return resolve(layout.artifactDirectoryPath, RESEARCH_STORAGE_MANIFEST_FILENAME);
}

export function loadResearchStorageManifest(
  layout: ResearchStorageLayout,
): ResearchStorageArtifactManifest {
  const manifestPath = getResearchStorageManifestPath(layout);
  if (!existsSync(manifestPath)) {
    return {
      schemaVersion: 1,
      manifestPath,
      artifacts: [],
    };
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Storage manifest must be a JSON object: ${manifestPath}`);
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported storage manifest schema version: ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error(`Storage manifest artifacts must be an array: ${manifestPath}`);
  }

  return {
    schemaVersion: 1,
    manifestPath,
    ...(typeof parsed.updatedAt === "string"
      ? { updatedAt: parsed.updatedAt }
      : {}),
    artifacts: parsed.artifacts.map((entry, index) =>
      normalizeManifestEntry(entry, manifestPath, index),
    ),
  };
}

export function saveResearchStorageManifest(
  layout: ResearchStorageLayout,
  manifest: ResearchStorageArtifactManifest,
): ResearchStorageArtifactManifest {
  const manifestPath = getResearchStorageManifestPath(layout);
  const updatedAt = new Date().toISOString();
  const sortedArtifacts = [...manifest.artifacts].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
  const next: ResearchStorageArtifactManifest = {
    schemaVersion: 1,
    manifestPath,
    updatedAt,
    artifacts: sortedArtifacts,
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: next.schemaVersion,
      updatedAt: next.updatedAt,
      artifacts: next.artifacts,
    }, null, 2)}\n`,
    "utf8",
  );

  return next;
}

export function registerResearchStorageArtifact(
  layout: ResearchStorageLayout,
  input: RegisterResearchStorageArtifactInput,
): ResearchStorageArtifactManifestEntry {
  ensureResearchStorageLayout(layout);
  const absolutePath = resolve(input.path);
  ensurePathInsideStorageRoot(layout, absolutePath);
  const fileStat = statSync(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Storage artifact must be a file: ${absolutePath}`);
  }

  const manifest = loadResearchStorageManifest(layout);
  const contentHash = hashFile(absolutePath);
  const existing = input.id
    ? manifest.artifacts.find((entry) => entry.id === input.id)
    : manifest.artifacts.find(
        (entry) => entry.path === absolutePath && entry.contentHash === contentHash,
      );
  const now = new Date().toISOString();
  const sourceEventIds = [...new Set(input.sourceEventIds ?? [])].sort();
  const entry: ResearchStorageArtifactManifestEntry = {
    id:
      input.id ??
      existing?.id ??
      createStorageArtifactId({
        path: absolutePath,
        kind: input.kind,
        contentHash,
      }),
    kind: input.kind,
    purpose: input.purpose ?? existing?.purpose ?? "Persisted research artifact.",
    path: absolutePath,
    relativePath: relative(layout.rootPath, absolutePath),
    uri: pathToFileURL(absolutePath).href,
    sizeBytes: fileStat.size,
    contentHash,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
    sourceEventIds,
  };
  const artifacts = [
    ...manifest.artifacts.filter((candidate) => candidate.id !== entry.id),
    entry,
  ];
  saveResearchStorageManifest(layout, {
    schemaVersion: 1,
    manifestPath: manifest.manifestPath,
    artifacts,
  });

  return entry;
}

export function registerResearchStorageArtifactRef(
  layout: ResearchStorageLayout,
  artifactRef: ResearchArtifactRef,
  sourceEventIds: readonly string[] = [],
): ResearchStorageArtifactManifestEntry | undefined {
  if (!artifactRef.uri?.startsWith("file:")) {
    return undefined;
  }

  const path = fileURLToPath(artifactRef.uri);
  if (!existsSync(path)) {
    return undefined;
  }

  return registerResearchStorageArtifact(layout, {
    id: artifactRef.id,
    path,
    kind: artifactRef.kind,
    ...(artifactRef.summary ? { purpose: artifactRef.summary } : {}),
    sourceEventIds,
  });
}

export function listResearchStorageArtifacts(
  layout: ResearchStorageLayout,
  options: {
    kind?: string;
    sourceEventId?: string;
  } = {},
): readonly ResearchStorageArtifactManifestEntry[] {
  const artifacts = loadResearchStorageManifest(layout).artifacts;

  return artifacts.filter((entry) => {
    if (options.kind && entry.kind !== options.kind) {
      return false;
    }
    if (
      options.sourceEventId &&
      !entry.sourceEventIds.includes(options.sourceEventId)
    ) {
      return false;
    }

    return true;
  });
}

export function resolveResearchStorageArtifact(
  layout: ResearchStorageLayout,
  artifactId: string,
): ResearchStorageArtifactManifestEntry | undefined {
  return loadResearchStorageManifest(layout).artifacts.find(
    (entry) => entry.id === artifactId,
  );
}

function deriveStorageRootPath(databasePath: string, workspaceRoot: string): string {
  return databasePath === ":memory:"
    ? dirname(getDefaultMemoryDatabasePath(workspaceRoot))
    : dirname(resolve(databasePath));
}

function createStorageArtifactId(input: {
  path: string;
  kind: string;
  contentHash: string;
}): string {
  const hash = createHash("sha256")
    .update(`${input.kind}\0${input.path}\0${input.contentHash}`)
    .digest("hex")
    .slice(0, 24);

  return `artifact_${hash}`;
}

function ensurePathInsideStorageRoot(
  layout: ResearchStorageLayout,
  path: string,
): void {
  const root = resolve(layout.rootPath);
  const relativePath = relative(root, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${"/"}`) ||
    relativePath.startsWith(`..${"\\"}`) ||
    resolve(path) === root
  ) {
    throw new Error(`Storage artifact must live under storage root: ${path}`);
  }
}

function hashFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function normalizeManifestEntry(
  value: unknown,
  manifestPath: string,
  index: number,
): ResearchStorageArtifactManifestEntry {
  if (!isRecord(value)) {
    throw new Error(`Storage manifest artifact ${index} must be an object: ${manifestPath}`);
  }

  return {
    id: readManifestString(value, "id", manifestPath, index),
    kind: readManifestString(value, "kind", manifestPath, index),
    purpose: readManifestString(value, "purpose", manifestPath, index),
    path: readManifestString(value, "path", manifestPath, index),
    relativePath: readManifestString(value, "relativePath", manifestPath, index),
    uri: readManifestString(value, "uri", manifestPath, index),
    sizeBytes: readManifestNumber(value, "sizeBytes", manifestPath, index),
    contentHash: readManifestString(value, "contentHash", manifestPath, index),
    createdAt: readManifestString(value, "createdAt", manifestPath, index),
    updatedAt: readManifestString(value, "updatedAt", manifestPath, index),
    sourceEventIds: readManifestStringArray(
      value,
      "sourceEventIds",
      manifestPath,
      index,
    ),
  };
}

function readManifestString(
  value: Record<string, unknown>,
  key: string,
  manifestPath: string,
  index: number,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim().length === 0) {
    throw new Error(`Storage manifest artifact ${index}.${key} must be a string: ${manifestPath}`);
  }

  return item;
}

function readManifestNumber(
  value: Record<string, unknown>,
  key: string,
  manifestPath: string,
  index: number,
): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
    throw new Error(`Storage manifest artifact ${index}.${key} must be a non-negative number: ${manifestPath}`);
  }

  return item;
}

function readManifestStringArray(
  value: Record<string, unknown>,
  key: string,
  manifestPath: string,
  index: number,
): readonly string[] {
  const item = value[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new Error(`Storage manifest artifact ${index}.${key} must be a string array: ${manifestPath}`);
  }

  return item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
