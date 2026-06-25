import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ResearchStorageDirectory,
  ResearchStorageDirectoryName,
  ResearchStorageLayout,
} from "./types.js";

export const DEFAULT_MEMORY_DATABASE_RELATIVE_PATH = ".honeycrisp/memory/memory.sqlite";
export const DEFAULT_ARTIFACT_RELATIVE_PATH = ".honeycrisp/memory/artifacts";

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

function deriveStorageRootPath(databasePath: string, workspaceRoot: string): string {
  return databasePath === ":memory:"
    ? dirname(getDefaultMemoryDatabasePath(workspaceRoot))
    : dirname(resolve(databasePath));
}
