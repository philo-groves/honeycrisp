import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_RESEARCH_TOOL_CONFIG_RELATIVE_PATH = ".honeycrisp/tools.json";

export interface ResearchToolConfigPreference {
  schemaVersion?: 1;
  toolFamilies?: string[];
  disabledToolFamilies?: string[];
  repoRoots?: string[];
  fileReadRoots?: string[];
  sourcePaths?: string[];
  projectNotes?: string[];
  workspaceContextPath?: string;
  allowedSideEffects?: string[];
  allowedMcpServers?: string[];
  mcpConfigPath?: string;
  mcpTimeoutMs?: number;
  experimentConfigPath?: string;
  selectedSkillIds?: string[];
  skillDirs?: string[];
  toolMaxCalls?: number;
  toolRuntimeMs?: number;
  toolMaxFiles?: number;
  toolMaxBytes?: number;
  toolMaxTokens?: number;
}

export interface WriteResearchToolConfigOptions {
  configPath?: string;
  workspaceRoot?: string;
  preference: ResearchToolConfigPreference;
}

export function getDefaultResearchToolConfigPath(
  workspaceRoot: string = process.cwd(),
): string {
  return resolve(workspaceRoot, DEFAULT_RESEARCH_TOOL_CONFIG_RELATIVE_PATH);
}

export async function loadResearchToolConfig(
  configPath: string,
): Promise<ResearchToolConfigPreference> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeResearchToolConfigPreference(
    readToolConfigObject(parsed),
    absolutePath,
  );
}

export async function loadDefaultResearchToolConfig(
  workspaceRoot: string = process.cwd(),
): Promise<ResearchToolConfigPreference | undefined> {
  const configPath = getDefaultResearchToolConfigPath(workspaceRoot);
  if (!(await pathExists(configPath))) {
    return undefined;
  }

  return loadResearchToolConfig(configPath);
}

export async function writeResearchToolConfig(
  options: WriteResearchToolConfigOptions,
): Promise<{
  configPath: string;
  preference: ResearchToolConfigPreference;
}> {
  const configPath = options.configPath
    ? resolve(options.configPath)
    : getDefaultResearchToolConfigPath(options.workspaceRoot);
  const preference = {
    schemaVersion: 1 as const,
    ...normalizeResearchToolConfigPreference(
      options.preference as Record<string, unknown>,
      configPath,
    ),
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(preference, null, 2)}\n`,
    "utf8",
  );

  return { configPath, preference };
}

function readToolConfigObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Research tool config file must contain a JSON object.");
  }

  if (isRecord(value.tools)) {
    return value.tools;
  }
  if (isRecord(value.runtimeTools)) {
    return value.runtimeTools;
  }

  return value;
}

function normalizeResearchToolConfigPreference(
  value: Record<string, unknown>,
  configPath: string,
): ResearchToolConfigPreference {
  const skills = isRecord(value.skills) ? value.skills : {};
  const mcp = isRecord(value.mcp) ? value.mcp : {};
  const governance = isRecord(value.governance) ? value.governance : {};

  const schemaVersion =
    value.schemaVersion === undefined
      ? undefined
      : readSchemaVersion(value.schemaVersion, configPath);
  const workspaceContextPath = readOptionalString(
    value.workspaceContextPath,
    "workspaceContextPath",
    configPath,
  );
  const mcpConfigPath = readOptionalString(
    value.mcpConfigPath ?? mcp.configPath,
    "mcpConfigPath",
    configPath,
  );
  const experimentConfigPath = readOptionalString(
    value.experimentConfigPath,
    "experimentConfigPath",
    configPath,
  );

  return {
    ...(schemaVersion ? { schemaVersion } : {}),
    ...readStringArrayField(value, "toolFamilies", configPath),
    ...readStringArrayField(value, "disabledToolFamilies", configPath),
    ...readStringArrayField(value, "repoRoots", configPath),
    ...readStringArrayField(value, "fileReadRoots", configPath),
    ...readStringArrayField(value, "sourcePaths", configPath),
    ...readStringArrayField(value, "projectNotes", configPath),
    ...(workspaceContextPath ? { workspaceContextPath } : {}),
    ...readStringArrayField(
      { allowedSideEffects: value.allowedSideEffects ?? governance.allowedSideEffects },
      "allowedSideEffects",
      configPath,
    ),
    ...readStringArrayField(
      { allowedMcpServers: value.allowedMcpServers ?? mcp.allowedServers },
      "allowedMcpServers",
      configPath,
    ),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...readPositiveIntegerField(
      { mcpTimeoutMs: value.mcpTimeoutMs ?? mcp.timeoutMs },
      "mcpTimeoutMs",
      configPath,
    ),
    ...(experimentConfigPath ? { experimentConfigPath } : {}),
    ...readStringArrayField(
      { selectedSkillIds: value.selectedSkillIds ?? skills.selectedIds },
      "selectedSkillIds",
      configPath,
    ),
    ...readStringArrayField(
      { skillDirs: value.skillDirs ?? skills.directories ?? skills.skillDirs },
      "skillDirs",
      configPath,
    ),
    ...readPositiveIntegerField(
      { toolMaxCalls: value.toolMaxCalls ?? governance.maxToolCalls },
      "toolMaxCalls",
      configPath,
    ),
    ...readPositiveIntegerField(
      { toolRuntimeMs: value.toolRuntimeMs ?? governance.maxRuntimeMs },
      "toolRuntimeMs",
      configPath,
    ),
    ...readPositiveIntegerField(
      { toolMaxFiles: value.toolMaxFiles ?? governance.maxFiles },
      "toolMaxFiles",
      configPath,
    ),
    ...readPositiveIntegerField(
      { toolMaxBytes: value.toolMaxBytes ?? governance.maxBytes },
      "toolMaxBytes",
      configPath,
    ),
    ...readPositiveIntegerField(
      { toolMaxTokens: value.toolMaxTokens ?? governance.maxTokens },
      "toolMaxTokens",
      configPath,
    ),
  };
}

function readSchemaVersion(value: unknown, configPath: string): 1 {
  if (value === 1) {
    return value;
  }

  throw new Error(
    `Research tool config ${configPath} has unsupported schemaVersion ${String(value)}.`,
  );
}

function readStringArrayField(
  value: Record<string, unknown>,
  field: keyof ResearchToolConfigPreference,
  configPath: string,
): Partial<ResearchToolConfigPreference> {
  const input = value[field];
  if (input === undefined || input === null) {
    return {};
  }
  if (!Array.isArray(input)) {
    throw new Error(
      `Research tool config ${configPath} field ${String(field)} must be an array of strings.`,
    );
  }

  const items = uniqueStrings(
    input.map((item) => readString(item, String(field), configPath)),
  );
  return items.length > 0 ? { [field]: items } : {};
}

function readPositiveIntegerField(
  value: Record<string, unknown>,
  field: keyof ResearchToolConfigPreference,
  configPath: string,
): Partial<ResearchToolConfigPreference> {
  const input = value[field];
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) {
    throw new Error(
      `Research tool config ${configPath} field ${String(field)} must be a positive integer.`,
    );
  }

  return { [field]: input };
}

function readOptionalString(
  value: unknown,
  field: string,
  configPath: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = readString(value, field, configPath);
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(value: unknown, field: string, configPath: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `Research tool config ${configPath} field ${field} must contain strings.`,
    );
  }

  return value.trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
