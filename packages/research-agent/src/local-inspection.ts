import {
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { isAbsolute, relative, resolve } from "node:path";
import { createResearchEventId, nowIso } from "./ids.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type {
  ResearchEvent,
  ResearchToolAction,
  ResearchToolDescriptor,
} from "./types.js";

export type LocalInspectionAction = "list" | "read_text";

export interface LocalInspectionToolOptions {
  allowedRoots: readonly string[];
  maxBytes?: number;
  maxEntries?: number;
}

export interface LocalInspectionRequest {
  action: LocalInspectionAction;
  path: string;
  maxBytes?: number;
}

export interface LocalInspectionEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
}

export interface LocalInspectionResult {
  toolName: "local.inspection";
  action: LocalInspectionAction;
  requestedPath: string;
  resolvedPath: string;
  root: string;
  type: "file" | "directory";
  truncated: boolean;
  bytesRead?: number;
  entries?: readonly LocalInspectionEntry[];
  text?: string;
  summary: string;
}

export interface LocalInspectionTool {
  executable: ResearchExecutableTool;
  descriptor: ResearchToolDescriptor;
  inspect(request: LocalInspectionRequest): Promise<LocalInspectionResult>;
}

const DEFAULT_MAX_BYTES = 32_768;
const DEFAULT_MAX_ENTRIES = 200;
const LOCAL_INSPECTION_TRANSPORT_NAME = "local_inspection";
const localInspectionParameters = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("inspect"),
      Type.Literal("list"),
      Type.Literal("read_text"),
    ]),
  ),
  path: Type.String(),
  maxBytes: Type.Optional(Type.Number()),
});

export function createLocalInspectionTool(
  options: LocalInspectionToolOptions,
): LocalInspectionTool {
  if (options.allowedRoots.length === 0) {
    throw new Error("Local inspection requires at least one allowed root.");
  }

  let rootPromise: Promise<readonly string[]> | undefined;
  const descriptor: ResearchToolDescriptor = {
    name: "local.inspection",
    transportName: LOCAL_INSPECTION_TRANSPORT_NAME,
    description:
      "Read-only local project inspection for bounded directory listings and text excerpts.",
    actionClasses: ["inspect"],
    sideEffects: "read",
    requiredPermissions: ["filesystem:read"],
    inputSchema: localInspectionParameters,
    artifactLocations: options.allowedRoots,
  };

  const tool: LocalInspectionTool = {
    descriptor,
    executable: {
      descriptor,
      parameters: localInspectionParameters,
      async execute(action, context) {
        return executeLocalInspectionAction(tool, action, context?.signal);
      },
    },
    async inspect(request) {
      const roots = await getAllowedRoots();
      const target = await resolveAllowedPath(request.path, roots);
      const targetStat = await stat(target.path);

      if (request.action === "list") {
        if (!targetStat.isDirectory()) {
          throw new Error(`Cannot list non-directory path: ${target.path}`);
        }

        const entries = await inspectDirectory(
          target.path,
          options.maxEntries ?? DEFAULT_MAX_ENTRIES,
        );

        return {
          toolName: "local.inspection",
          action: request.action,
          requestedPath: request.path,
          resolvedPath: target.path,
          root: target.root,
          type: "directory",
          truncated: entries.truncated,
          entries: entries.items,
          summary: summarizeDirectory(
            target.path,
            entries.items.length,
            entries.truncated,
          ),
        };
      }

      if (targetStat.isDirectory()) {
        throw new Error(`Cannot read directory as text: ${target.path}`);
      }

      const maxBytes =
        request.maxBytes ?? options.maxBytes ?? DEFAULT_MAX_BYTES;
      const result = await readTextPrefix(target.path, maxBytes);

      return {
        toolName: "local.inspection",
        action: request.action,
        requestedPath: request.path,
        resolvedPath: target.path,
        root: target.root,
        type: "file",
        truncated: result.truncated,
        bytesRead: result.bytesRead,
        text: result.text,
        summary: summarizeTextRead(
          target.path,
          result.bytesRead,
          result.truncated,
          result.text,
        ),
      };
    },
  };

  return tool;

  async function getAllowedRoots(): Promise<readonly string[]> {
    rootPromise ??= Promise.all(
      options.allowedRoots.map((root) => realpath(resolve(root))),
    );

    return rootPromise;
  }
}

export function createLocalInspectionObservationEvent(
  result: LocalInspectionResult,
  options: {
    id?: string;
    timestamp?: string;
  } = {},
): ResearchEvent {
  return {
    id: options.id ?? createResearchEventId(),
    kind: "tool.observed",
    timestamp: options.timestamp ?? nowIso(),
    payload: {
      toolName: result.toolName,
      action: result.action,
      path: result.resolvedPath,
      root: result.root,
      summary: result.summary,
      result,
    },
  };
}

async function executeLocalInspectionAction(
  tool: LocalInspectionTool,
  action: ResearchToolAction,
  signal: AbortSignal | undefined,
): Promise<ResearchToolExecutionResult> {
  const startedAt = nowIso();
  if (signal?.aborted) {
    return createLocalInspectionErrorResult(
      action,
      startedAt,
      "Local inspection was aborted before execution.",
    );
  }

  try {
    const result = await tool.inspect(normalizeLocalInspectionRequest(action));
    return {
      action,
      status: "complete",
      startedAt,
      completedAt: nowIso(),
      summary: result.summary,
      output: result,
      followUpActions: createLocalInspectionFollowUps(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createLocalInspectionErrorResult(action, startedAt, message);
  }
}

function normalizeLocalInspectionRequest(
  action: ResearchToolAction,
): LocalInspectionRequest {
  const input = action.input;
  const path = readRequiredString(input, "path");
  const rawAction = typeof input.action === "string" ? input.action : "read_text";
  const localAction: LocalInspectionAction =
    rawAction === "list" ? "list" : "read_text";
  const maxBytes =
    typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes)
      ? input.maxBytes
      : undefined;

  return {
    action: localAction,
    path,
    ...(maxBytes ? { maxBytes } : {}),
  };
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`local.inspection requires a ${key} string.`);
  }

  return value;
}

function createLocalInspectionFollowUps(
  result: LocalInspectionResult,
): string[] {
  if (result.truncated && result.type === "file") {
    return ["Read a narrower or later file slice if parser-relevant content was truncated."];
  }

  if (result.type === "directory") {
    return ["Select a file from the directory listing for a bounded read."];
  }

  return [];
}

function createLocalInspectionErrorResult(
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
    followUpActions: ["Report the local inspection error before continuing."],
    error: {
      message,
    },
  };
}

async function resolveAllowedPath(
  requestPath: string,
  roots: readonly string[],
): Promise<{ path: string; root: string }> {
  const resolvedPath = resolve(requestPath);
  const realTarget = await realpath(resolvedPath);
  const root = roots.find((allowedRoot) =>
    isWithinRoot(realTarget, allowedRoot),
  );

  if (!root) {
    throw new Error(`Path is outside allowed inspection roots: ${requestPath}`);
  }

  return {
    path: realTarget,
    root,
  };
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const offset = relative(rootPath, targetPath);
  return (
    offset === "" ||
    (offset.length > 0 && !offset.startsWith("..") && !isAbsolute(offset))
  );
}

async function inspectDirectory(
  directoryPath: string,
  maxEntries: number,
): Promise<{ items: LocalInspectionEntry[]; truncated: boolean }> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const truncated = entries.length > maxEntries;
  const boundedEntries = entries.slice(0, maxEntries);
  const items = await Promise.all(
    boundedEntries.map(async (entry) => {
      const entryPath = resolve(directoryPath, entry.name);
      const entryStat = await stat(entryPath).catch(() => undefined);
      const item: LocalInspectionEntry = {
        name: entry.name,
        path: entryPath,
        type: classifyEntry(entry),
        ...(entryStat?.isFile() ? { size: entryStat.size } : {}),
      };

      return item;
    }),
  );

  return { items, truncated };
}

async function readTextPrefix(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  const handle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    const visibleBytes = truncated ? maxBytes : bytesRead;

    return {
      text: buffer.subarray(0, visibleBytes).toString("utf8"),
      bytesRead: visibleBytes,
      truncated,
    };
  } finally {
    await handle.close();
  }
}

function classifyEntry(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): LocalInspectionEntry["type"] {
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

function summarizeDirectory(
  directoryPath: string,
  entryCount: number,
  truncated: boolean,
): string {
  return `Listed ${entryCount}${truncated ? "+" : ""} entries in ${directoryPath}.`;
}

function summarizeTextRead(
  filePath: string,
  bytesRead: number,
  truncated: boolean,
  text: string,
): string {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 500);
  const suffix = truncated ? " The read was truncated." : "";

  return `Read ${bytesRead} bytes from ${filePath}.${suffix}${
    preview ? ` Preview: ${preview}` : ""
  }`;
}
