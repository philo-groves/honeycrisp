import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import type {
  ResearchAgentInstructionSource,
  ResearchAgentInstructions,
} from "./types.js";

export interface DiscoverResearchAgentInstructionsOptions {
  workingDirectory: string;
  codexHome?: string | null;
  projectDocFallbackFilenames?: readonly string[];
  projectDocMaxBytes?: number;
  projectRootMarkers?: readonly string[];
}

interface ProjectInstructionConfig {
  projectDocFallbackFilenames: readonly string[];
  projectDocMaxBytes: number;
  projectRootMarkers: readonly string[];
}

interface InstructionCandidate {
  path: string;
  content: string;
}

const DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024;
const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];
const PRIMARY_PROJECT_FILENAMES = ["AGENTS.override.md", "AGENTS.md"];

export function discoverResearchAgentInstructions(
  options: DiscoverResearchAgentInstructionsOptions,
): ResearchAgentInstructions {
  const workingDirectory = resolve(options.workingDirectory);
  const codexHome = options.codexHome === null
    ? null
    : resolve(options.codexHome ?? process.env.CODEX_HOME?.trim() ?? join(homedir(), ".codex"));
  const configured = codexHome ? loadProjectInstructionConfig(codexHome) : defaultProjectInstructionConfig();
  const projectDocFallbackFilenames = normalizeCandidateNames(
    options.projectDocFallbackFilenames ?? configured.projectDocFallbackFilenames,
    PRIMARY_PROJECT_FILENAMES,
  );
  const projectDocMaxBytes = normalizeMaxBytes(
    options.projectDocMaxBytes ?? configured.projectDocMaxBytes,
  );
  const projectRootMarkers = normalizeCandidateNames(
    options.projectRootMarkers ?? configured.projectRootMarkers,
  );
  const contents: string[] = [];
  const sources: ResearchAgentInstructionSource[] = [];

  if (codexHome) {
    const globalInstruction = firstNonEmptyInstruction(codexHome, PRIMARY_PROJECT_FILENAMES);
    if (globalInstruction) {
      contents.push(globalInstruction.content);
      sources.push(instructionSource("global", globalInstruction));
    }
  }

  let remainingProjectBytes = projectDocMaxBytes;
  let truncated = false;
  const projectCandidateNames = [...PRIMARY_PROJECT_FILENAMES, ...projectDocFallbackFilenames];
  const projectDirectories = isDirectory(workingDirectory)
    ? directoriesFromRoot(findProjectRoot(workingDirectory, projectRootMarkers), workingDirectory)
    : [];
  for (const directory of projectDirectories) {
    if (remainingProjectBytes <= 0) break;
    const candidate = firstExistingInstruction(directory, projectCandidateNames);
    if (!candidate || !candidate.content.trim()) continue;
    const fullContent = candidate.content.trim();
    const fullByteLength = Buffer.byteLength(fullContent, "utf8");
    const includedContent = fullByteLength <= remainingProjectBytes
      ? fullContent
      : truncateUtf8(fullContent, remainingProjectBytes);
    const includedByteLength = Buffer.byteLength(includedContent, "utf8");
    if (includedContent.trim()) {
      contents.push(includedContent);
      sources.push(instructionSource("project", { ...candidate, content: includedContent }, fullByteLength > includedByteLength));
    }
    remainingProjectBytes = Math.max(0, remainingProjectBytes - includedByteLength);
    if (fullByteLength > includedByteLength) {
      truncated = true;
      break;
    }
  }

  return {
    schemaVersion: 1,
    content: contents.join("\n\n"),
    sources,
    truncated,
    projectDocMaxBytes,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function loadProjectInstructionConfig(codexHome: string): ProjectInstructionConfig {
  const fallback = defaultProjectInstructionConfig();
  const configPath = join(codexHome, "config.toml");
  if (!isRegularFile(configPath)) return fallback;
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return fallback;
  }
  const rootConfig = text.split(/^\s*\[{1,2}[^\r\n]+/mu, 1)[0] ?? "";
  return {
    projectDocFallbackFilenames: tomlStringArray(rootConfig, "project_doc_fallback_filenames")
      ?? fallback.projectDocFallbackFilenames,
    projectDocMaxBytes: tomlInteger(rootConfig, "project_doc_max_bytes")
      ?? fallback.projectDocMaxBytes,
    projectRootMarkers: tomlStringArray(rootConfig, "project_root_markers")
      ?? fallback.projectRootMarkers,
  };
}

function defaultProjectInstructionConfig(): ProjectInstructionConfig {
  return {
    projectDocFallbackFilenames: [],
    projectDocMaxBytes: DEFAULT_PROJECT_DOC_MAX_BYTES,
    projectRootMarkers: DEFAULT_PROJECT_ROOT_MARKERS,
  };
}

function tomlStringArray(text: string, key: string): string[] | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "mu"));
  if (!match) return null;
  const values: string[] = [];
  const quotedValues = match[1]?.match(/"(?:\\.|[^"\\])*"|'[^']*'/gu) ?? [];
  for (const quoted of quotedValues) {
    if (quoted.startsWith("'")) {
      values.push(quoted.slice(1, -1));
      continue;
    }
    try {
      const parsed = JSON.parse(quoted) as unknown;
      if (typeof parsed === "string") values.push(parsed);
    } catch {
      // Ignore malformed configured names and retain the remaining valid entries.
    }
  }
  return values;
}

function tomlInteger(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*([0-9][0-9_]*)`, "mu"));
  if (!match) return null;
  const value = Number.parseInt((match[1] ?? "").replaceAll("_", ""), 10);
  return Number.isSafeInteger(value) ? value : null;
}

function normalizeMaxBytes(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_PROJECT_DOC_MAX_BYTES;
}

function normalizeCandidateNames(
  values: readonly string[],
  excluded: readonly string[] = [],
): string[] {
  const excludedNames = new Set(excluded);
  const normalized: string[] = [];
  for (const value of values) {
    const name = value.trim();
    if (
      !name
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || excludedNames.has(name)
      || normalized.includes(name)
    ) {
      continue;
    }
    normalized.push(name);
  }
  return normalized;
}

function firstNonEmptyInstruction(
  directory: string,
  candidateNames: readonly string[],
): InstructionCandidate | null {
  for (const name of candidateNames) {
    const candidate = readInstruction(join(directory, name));
    if (candidate?.content.trim()) return candidate;
  }
  return null;
}

function firstExistingInstruction(
  directory: string,
  candidateNames: readonly string[],
): InstructionCandidate | null {
  for (const name of candidateNames) {
    const path = join(directory, name);
    if (!isRegularFile(path)) continue;
    return readInstruction(path);
  }
  return null;
}

function readInstruction(path: string): InstructionCandidate | null {
  try {
    if (!isRegularFile(path)) return null;
    return { path, content: readFileSync(path).toString("utf8") };
  } catch {
    return null;
  }
}

function instructionSource(
  scope: ResearchAgentInstructionSource["scope"],
  candidate: InstructionCandidate,
  truncated = false,
): ResearchAgentInstructionSource {
  const content = candidate.content;
  return {
    scope,
    path: candidate.path,
    byteLength: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content).digest("hex"),
    ...(truncated ? { truncated: true } : {}),
  };
}

function findProjectRoot(
  workingDirectory: string,
  markers: readonly string[],
): string {
  if (markers.length === 0) return workingDirectory;
  let directory = workingDirectory;
  while (true) {
    if (markers.some((marker) => existsSync(join(directory, marker)))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return workingDirectory;
    directory = parent;
  }
}

function directoriesFromRoot(root: string, workingDirectory: string): string[] {
  const relativePath = relative(root, workingDirectory);
  if (!relativePath) return [root];
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || parse(relativePath).root) {
    return [workingDirectory];
  }
  const directories = [root];
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    directories.push(current);
  }
  return directories;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
