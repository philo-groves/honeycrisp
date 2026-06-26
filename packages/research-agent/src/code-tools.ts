import {
  opendir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {
  getAvailableQueries,
  getQueryPath,
  getWasmPath,
  type SupportedLanguage,
} from "tree-sitter-wasm";
import {
  Language,
  Parser,
  Query,
  type Node,
  type QueryCapture,
  type QueryMatch,
} from "web-tree-sitter";
import { nowIso } from "./ids.js";
import type {
  ResearchToolAction,
  ResearchToolDescriptor,
} from "./types.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";

const DEFAULT_CODE_MAX_BYTES = 128_000;
const DEFAULT_CODE_MAX_FILES = 40;
const DEFAULT_CODE_MAX_RESULTS = 40;
const DEFAULT_QUERY_MAX_MATCHES = 40;
const DEFAULT_NODE_CONTEXT_DEPTH = 8;
const CODE_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".honeycrisp",
  ".beale",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
const CODE_DETECT_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string" },
    maxFiles: { type: "number" },
    maxBytes: { type: "number" },
  },
};
const CODE_OUTLINE_PARAMETERS = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string" },
    language: { type: "string" },
    maxSymbols: { type: "number" },
    maxBytes: { type: "number" },
  },
};
const CODE_QUERY_PARAMETERS = {
  type: "object",
  required: ["path", "query"],
  properties: {
    path: { type: "string" },
    query: { type: "string" },
    language: { type: "string" },
    maxMatches: { type: "number" },
    maxBytes: { type: "number" },
    includeText: { type: "boolean" },
  },
};
const CODE_NODE_CONTEXT_PARAMETERS = {
  type: "object",
  required: ["path", "line"],
  properties: {
    path: { type: "string" },
    language: { type: "string" },
    line: { type: "number" },
    column: { type: "number" },
    endLine: { type: "number" },
    endColumn: { type: "number" },
    maxDepth: { type: "number" },
    maxBytes: { type: "number" },
  },
};
const CODE_REFERENCES_PARAMETERS = {
  type: "object",
  required: ["symbol"],
  properties: {
    symbol: { type: "string" },
    path: { type: "string" },
    language: { type: "string" },
    maxResults: { type: "number" },
    maxBytes: { type: "number" },
  },
};
const CODE_CALL_CANDIDATES_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string" },
    symbol: { type: "string" },
    language: { type: "string" },
    maxResults: { type: "number" },
    maxBytes: { type: "number" },
  },
};

type CodeToolName =
  | "code.detect"
  | "code.outline"
  | "code.query"
  | "code.node_context"
  | "code.references"
  | "code.call_candidates";

interface CodeParseContext {
  requestedPath: string;
  path: string;
  root?: string;
  relativePath: string;
  language: SupportedLanguage;
  text: string;
  tree: NonNullable<ReturnType<Parser["parse"]>>;
}

interface CodeSymbol {
  kind: string;
  name: string;
  nodeType: string;
  range: CodeRange;
  textPreview: string;
}

interface CodeReference {
  kind: string;
  name: string;
  nodeType: string;
  path: string;
  root?: string;
  range: CodeRange;
  textPreview: string;
}

interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}

export interface BuiltInCodeIntelligenceToolOptions {
  roots?: readonly string[];
  maxFileBytes?: number;
  maxFiles?: number;
  maxResults?: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, SupportedLanguage> = {
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".lua": "lua",
  ".php": "php",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const LANGUAGE_BY_BASENAME: Record<string, SupportedLanguage> = {
  Makefile: "make",
  Dockerfile: "dockerfile",
};

let parserInit: Promise<void> | undefined;
const languageCache = new Map<SupportedLanguage, Promise<Language>>();

export function createCodeIntelligenceTools(
  options: BuiltInCodeIntelligenceToolOptions = {},
): ResearchExecutableTool[] {
  const rootHints = uniqueResolvedPaths(options.roots ?? []);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_CODE_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_CODE_MAX_FILES;
  const maxResults = options.maxResults ?? DEFAULT_CODE_MAX_RESULTS;

  return [
    createCodeTool({
      name: "code.detect",
      transportName: "code_detect",
      description:
        "Detect Tree-sitter-supported code files and parse health under a path or workspace code roots.",
      actionClasses: ["search", "inspect"],
      parameters: CODE_DETECT_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const requestedPath = optionalString(action.input.path);
        const requestedMaxFiles = readCappedPositiveInteger(
          action.input.maxFiles,
          maxFiles,
          maxFiles,
        );
        const requestedMaxBytes = readCappedPositiveInteger(
          action.input.maxBytes,
          maxFileBytes,
          maxFileBytes,
        );
        const targets = requestedPath
          ? [await resolvePathWithRoots(requestedPath, rootHints)]
          : await resolveExistingRoots(rootHints);
        if (targets.length === 0) {
          throw new Error("code.detect has no path or readable code roots.");
        }

        const files = await collectCodeFiles(targets, {
          maxFiles: requestedMaxFiles,
          maxFileBytes: requestedMaxBytes,
        });
        const detections = [];
        for (const file of files) {
          const language = detectLanguageForPath(file.path);
          if (!language) {
            continue;
          }
          const parse = await parseCodeFile({
            requestedPath: file.path,
            path: file.path,
            rootHints,
            language,
            maxBytes: requestedMaxBytes,
          });
          detections.push({
            path: parse.relativePath,
            resolvedPath: parse.path,
            root: parse.root ?? null,
            language,
            bytes: parse.text.length,
            parseHealth: summarizeParseHealth(parse.tree.rootNode),
          });
          parse.tree.delete();
        }

        return completeResult(action, startedAt, {
          summary: `Detected ${detections.length} Tree-sitter-supported code file(s).`,
          output: {
            roots: targets,
            maxFiles: requestedMaxFiles,
            maxBytes: requestedMaxBytes,
            detectedCount: detections.length,
            detections,
          },
          evidence: detections.map(
            (item) =>
              `${item.path} language=${item.language} parseError=${item.parseHealth.hasError}`,
          ),
        });
      },
    }),
    createCodeTool({
      name: "code.outline",
      transportName: "code_outline",
      description:
        "Return Tree-sitter tag-query definitions such as functions, methods, classes, types, and modules for one code file.",
      actionClasses: ["inspect", "analyze"],
      parameters: CODE_OUTLINE_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const parse = await parseActionFile(action, rootHints, maxFileBytes);
        const maxSymbols = readCappedPositiveInteger(
          action.input.maxSymbols,
          maxResults,
          maxResults,
        );
        const symbols = await getTagSymbols(parse, {
          mode: "definitions",
          maxResults: maxSymbols,
        });
        const parseHealth = summarizeParseHealth(parse.tree.rootNode);
        parse.tree.delete();

        return completeResult(action, startedAt, {
          summary: `Outlined ${symbols.length} symbol(s) from ${parse.relativePath}.`,
          output: {
            path: parse.relativePath,
            resolvedPath: parse.path,
            language: parse.language,
            parseHealth,
            symbols,
          },
          evidence: symbols.map(
            (symbol) =>
              `${parse.relativePath}:${symbol.range.startLine}: ${symbol.kind} ${symbol.name}`,
          ),
        });
      },
    }),
    createCodeTool({
      name: "code.query",
      transportName: "code_query",
      description:
        "Run a bounded raw Tree-sitter query against one code file and return capture ranges.",
      actionClasses: ["search", "inspect", "analyze"],
      parameters: CODE_QUERY_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const parse = await parseActionFile(action, rootHints, maxFileBytes);
        const querySource = readRequiredString(action.input, "query");
        const maxMatches = readCappedPositiveInteger(
          action.input.maxMatches,
          DEFAULT_QUERY_MAX_MATCHES,
          maxResults,
        );
        const includeText = action.input.includeText === true;
        const language = await loadLanguage(parse.language);
        const query = new Query(language, querySource);
        const matches = query
          .matches(parse.tree.rootNode, {
            matchLimit: boundedQueryMatchLimit(maxMatches),
          })
          .slice(0, maxMatches)
          .map((match) => serializeQueryMatch(match, includeText));
        const exceededMatchLimit = query.didExceedMatchLimit();
        query.delete();
        parse.tree.delete();

        return completeResult(action, startedAt, {
          summary: `Tree-sitter query returned ${matches.length} match(es) from ${parse.relativePath}.`,
          output: {
            path: parse.relativePath,
            resolvedPath: parse.path,
            language: parse.language,
            matchCount: matches.length,
            truncated: matches.length >= maxMatches,
            exceededMatchLimit,
            matches,
          },
          evidence: matches.map(
            (match) =>
              `${parse.relativePath}: pattern ${match.patternIndex} captures ${match.captures.map((capture) => capture.name).join(", ")}`,
          ),
        });
      },
    }),
    createCodeTool({
      name: "code.node_context",
      transportName: "code_node_context",
      description:
        "Return the smallest named Tree-sitter node and enclosing syntax ancestors for a line/range in one code file.",
      actionClasses: ["inspect"],
      parameters: CODE_NODE_CONTEXT_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const parse = await parseActionFile(action, rootHints, maxFileBytes);
        const start = readPoint(action.input, "line", "column");
        const end =
          typeof action.input.endLine === "number"
            ? readPoint(action.input, "endLine", "endColumn")
            : start;
        const maxDepth = readCappedPositiveInteger(
          action.input.maxDepth,
          DEFAULT_NODE_CONTEXT_DEPTH,
          64,
        );
        const node =
          parse.tree.rootNode.namedDescendantForPosition(start, end) ??
          parse.tree.rootNode.descendantForPosition(start, end) ??
          parse.tree.rootNode;
        const ancestors = collectAncestors(node, maxDepth);
        const enclosingSymbol = ancestors.find((ancestor) =>
          isDefinitionLikeNodeType(ancestor.nodeType),
        );
        parse.tree.delete();

        return completeResult(action, startedAt, {
          summary: `Found ${ancestors.length} enclosing syntax node(s) for ${parse.relativePath}:${start.row + 1}.`,
          output: {
            path: parse.relativePath,
            resolvedPath: parse.path,
            language: parse.language,
            requestedRange: {
              startLine: start.row + 1,
              startColumn: start.column,
              endLine: end.row + 1,
              endColumn: end.column,
            },
            node: ancestors[0] ?? null,
            enclosingSymbol: enclosingSymbol ?? null,
            ancestors,
          },
          evidence: ancestors.map(
            (ancestor) =>
              `${parse.relativePath}:${ancestor.range.startLine}: ${ancestor.nodeType} ${ancestor.textPreview}`,
          ),
        });
      },
    }),
    createCodeTool({
      name: "code.references",
      transportName: "code_references",
      description:
        "Find Tree-sitter tag-query references or definitions for a symbol under one file or workspace code roots.",
      actionClasses: ["search", "inspect"],
      parameters: CODE_REFERENCES_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const symbol = readRequiredString(action.input, "symbol");
        const refs = await collectReferencesForAction(action, rootHints, {
          maxFileBytes,
          maxResults,
          symbol,
          referenceMode: "all",
        });

        return completeResult(action, startedAt, {
          summary: `Found ${refs.length} structural reference candidate(s) for ${symbol}.`,
          output: {
            symbol,
            references: refs,
          },
          evidence: refs.map(
            (ref) =>
              `${ref.path}:${ref.range.startLine}: ${ref.kind} ${ref.name}`,
          ),
        });
      },
    }),
    createCodeTool({
      name: "code.call_candidates",
      transportName: "code_call_candidates",
      description:
        "Find cheap Tree-sitter call-reference candidates under one file or workspace code roots. This is not a full call graph.",
      actionClasses: ["inspect", "analyze"],
      parameters: CODE_CALL_CANDIDATES_PARAMETERS,
      rootHints,
      maxFileBytes,
      async run(action, startedAt) {
        const symbol = optionalString(action.input.symbol);
        const refs = await collectReferencesForAction(action, rootHints, {
          maxFileBytes,
          maxResults,
          ...(symbol ? { symbol } : {}),
          referenceMode: "calls",
        });

        return completeResult(action, startedAt, {
          summary: `Found ${refs.length} call candidate(s)${symbol ? ` for ${symbol}` : ""}.`,
          output: {
            ...(symbol ? { symbol } : {}),
            callCandidates: refs,
            precision: "best_effort_tree_sitter_tag_query",
          },
          evidence: refs.map(
            (ref) =>
              `${ref.path}:${ref.range.startLine}: call ${ref.name}`,
          ),
        });
      },
    }),
  ];
}

function createCodeTool(input: {
  name: CodeToolName;
  transportName: string;
  description: string;
  actionClasses: ResearchToolDescriptor["actionClasses"];
  parameters: unknown;
  rootHints: readonly string[];
  maxFileBytes: number;
  run: (
    action: ResearchToolAction,
    startedAt: string,
  ) => Promise<ResearchToolExecutionResult>;
}): ResearchExecutableTool {
  const descriptor: ResearchToolDescriptor = {
    name: input.name,
    transportName: input.transportName,
    description: input.description,
    actionClasses: input.actionClasses,
    sideEffects: "read",
    requiredPermissions: ["filesystem:read"],
    inputSchema: input.parameters,
    artifactLocations: input.rootHints,
    metadata: {
      provider: "honeycrisp.built_in",
      safetyProfile: "workspace-context-tree-sitter-read",
      parser: "tree-sitter",
      defaultBudget: {
        maxToolCalls: 1,
        maxBytes: input.maxFileBytes,
      },
    },
    memoryWritebackDefaults: ["event", "working", "episodic"],
  };

  return {
    descriptor,
    parameters: input.parameters as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      return completeOrError(action, startedAt, () => input.run(action, startedAt));
    },
  };
}

async function collectReferencesForAction(
  action: ResearchToolAction,
  roots: readonly string[],
  options: {
    maxFileBytes: number;
    maxResults: number;
    symbol?: string;
    referenceMode: "all" | "calls";
  },
): Promise<CodeReference[]> {
  const requestedPath = optionalString(action.input.path);
  const requestedMaxResults = readCappedPositiveInteger(
    action.input.maxResults,
    options.maxResults,
    options.maxResults,
  );
  const requestedMaxBytes = readCappedPositiveInteger(
    action.input.maxBytes,
    options.maxFileBytes,
    options.maxFileBytes,
  );
  const targetPaths = requestedPath
    ? [await resolvePathWithRoots(requestedPath, roots)]
    : await resolveExistingRoots(roots);
  if (targetPaths.length === 0) {
    throw new Error(`${action.toolName} has no path or readable code roots.`);
  }

  const files = await collectCodeFiles(targetPaths, {
    maxFiles: requestedMaxResults,
    maxFileBytes: requestedMaxBytes,
  });
  const refs: CodeReference[] = [];
  for (const file of files) {
    if (refs.length >= requestedMaxResults) {
      break;
    }
    const parse = await parseCodeFile({
      requestedPath: file.path,
      path: file.path,
      rootHints: roots,
      language: readLanguage(action.input.language) ?? file.language,
      maxBytes: requestedMaxBytes,
    });
    const symbols = await getTagSymbols(parse, {
      mode: options.referenceMode === "calls" ? "calls" : "all",
      maxResults: requestedMaxResults - refs.length,
      ...(options.symbol ? { symbol: options.symbol } : {}),
    });
    refs.push(
      ...symbols.map((symbol) => ({
        kind: symbol.kind,
        name: symbol.name,
        nodeType: symbol.nodeType,
        path: parse.relativePath,
        ...(parse.root ? { root: parse.root } : {}),
        range: symbol.range,
        textPreview: symbol.textPreview,
      })),
    );
    parse.tree.delete();
  }

  return refs;
}

async function parseActionFile(
  action: ResearchToolAction,
  rootHints: readonly string[],
  fallbackMaxBytes: number,
): Promise<CodeParseContext> {
  const requestedPath = readRequiredString(action.input, "path");
  const target = await resolvePathWithRoots(requestedPath, rootHints);
  return parseCodeFile({
    requestedPath,
    path: target,
    rootHints,
    language: readLanguage(action.input.language) ?? detectLanguageForPath(target),
    maxBytes: readCappedPositiveInteger(
      action.input.maxBytes,
      fallbackMaxBytes,
      fallbackMaxBytes,
    ),
  });
}

async function parseCodeFile(input: {
  requestedPath: string;
  path: string;
  rootHints: readonly string[];
  language: SupportedLanguage | undefined;
  maxBytes: number;
}): Promise<CodeParseContext> {
  if (!input.language) {
    throw new Error(`No Tree-sitter language detected for ${input.path}.`);
  }
  const fileStat = await stat(input.path);
  if (!fileStat.isFile()) {
    throw new Error(`Code path is not a file: ${input.path}`);
  }
  if (fileStat.size > input.maxBytes) {
    throw new Error(
      `Code file exceeds maxBytes (${fileStat.size} > ${input.maxBytes}): ${input.path}`,
    );
  }

  const text = await readFile(input.path, "utf8");
  const language = await loadLanguage(input.language);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  parser.delete();
  if (!tree) {
    throw new Error(`Tree-sitter parser returned no tree for ${input.path}.`);
  }
  const root = findContainingRoot(input.path, input.rootHints);
  return {
    requestedPath: input.requestedPath,
    path: input.path,
    ...(root ? { root } : {}),
    relativePath: root ? relative(root, input.path) || basename(input.path) : input.path,
    language: input.language,
    text,
    tree,
  };
}

async function getTagSymbols(
  parse: CodeParseContext,
  options: {
    mode: "definitions" | "all" | "calls";
    maxResults: number;
    symbol?: string;
  },
): Promise<CodeSymbol[]> {
  const querySource = await readTagQuery(parse.language);
  if (!querySource) {
    return [];
  }

  const language = await loadLanguage(parse.language);
  const query = new Query(language, querySource);
  const symbols: CodeSymbol[] = [];
  for (const match of query.matches(parse.tree.rootNode, {
    matchLimit: boundedQueryMatchLimit(options.maxResults),
  })) {
    if (symbols.length >= options.maxResults) {
      break;
    }
    const nodeCapture = selectSemanticCapture(match.captures, options.mode);
    const nameCapture = match.captures.find((capture) => capture.name === "name");
    if (!nodeCapture || !nameCapture) {
      continue;
    }
    const kind = nodeCapture.name;
    const name = normalizeSymbolName(nameCapture.node.text);
    if (!name || (options.symbol && name !== options.symbol)) {
      continue;
    }
    symbols.push({
      kind,
      name,
      nodeType: nodeCapture.node.type,
      range: nodeRange(nodeCapture.node),
      textPreview: previewText(nodeCapture.node.text),
    });
  }
  query.delete();
  return symbols;
}

function selectSemanticCapture(
  captures: readonly QueryCapture[],
  mode: "definitions" | "all" | "calls",
): QueryCapture | undefined {
  if (mode === "definitions") {
    return captures.find((capture) => capture.name.startsWith("definition."));
  }
  if (mode === "calls") {
    return captures.find((capture) => capture.name === "reference.call");
  }
  return captures.find(
    (capture) =>
      capture.name.startsWith("reference.") ||
      capture.name.startsWith("definition."),
  );
}

async function readTagQuery(language: SupportedLanguage): Promise<string | undefined> {
  const queries = getAvailableQueries(language) as Record<string, string>;
  const tagPath = queries.tags;
  if (!tagPath) {
    return undefined;
  }
  return readFile(tagPath, "utf8");
}

async function loadLanguage(language: SupportedLanguage): Promise<Language> {
  await ensureParserInitialized();
  const existing = languageCache.get(language);
  if (existing) {
    return existing;
  }
  const loaded = Language.load(getWasmPath(language));
  languageCache.set(language, loaded);
  return loaded;
}

async function ensureParserInitialized(): Promise<void> {
  parserInit ??= Parser.init();
  await parserInit;
}

async function collectCodeFiles(
  targets: readonly string[],
  options: {
    maxFiles: number;
    maxFileBytes: number;
  },
): Promise<Array<{ path: string; language: SupportedLanguage }>> {
  const files: Array<{ path: string; language: SupportedLanguage }> = [];
  const seen = new Set<string>();

  async function addFile(path: string): Promise<void> {
    if (files.length >= options.maxFiles) {
      return;
    }
    const language = detectLanguageForPath(path);
    if (!language) {
      return;
    }
    const fileStat = await stat(path).catch(() => undefined);
    if (!fileStat?.isFile() || fileStat.size > options.maxFileBytes) {
      return;
    }
    const real = await realpath(path).catch(() => undefined);
    if (!real || seen.has(real)) {
      return;
    }
    seen.add(real);
    files.push({ path: real, language });
  }

  async function visit(path: string): Promise<void> {
    if (files.length >= options.maxFiles) {
      return;
    }
    const pathStat = await stat(path).catch(() => undefined);
    if (!pathStat) {
      return;
    }
    if (pathStat.isFile()) {
      await addFile(path);
      return;
    }
    if (!pathStat.isDirectory()) {
      return;
    }
    const entries = await opendir(path);
    for await (const entry of entries) {
      if (
        files.length >= options.maxFiles ||
        CODE_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      await visit(resolve(path, entry.name));
    }
  }

  for (const target of targets) {
    await visit(target);
  }
  return files;
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

async function resolvePathWithRoots(
  requestedPath: string,
  roots: readonly string[],
): Promise<string> {
  const candidates = isAbsolute(requestedPath)
    ? [requestedPath]
    : [resolve(requestedPath), ...roots.map((root) => resolve(root, requestedPath))];
  for (const candidate of candidates) {
    const resolvedPath = await realpath(candidate).catch(() => undefined);
    if (resolvedPath) {
      return resolvedPath;
    }
  }
  return realpath(resolve(requestedPath));
}

function findContainingRoot(path: string, roots: readonly string[]): string | undefined {
  const target = resolve(path);
  return roots.find((root) => {
    const relativePath = relative(root, target);
    return relativePath === "" || (!relativePath.startsWith("..") && relativePath !== "..");
  });
}

function detectLanguageForPath(path: string): SupportedLanguage | undefined {
  return LANGUAGE_BY_BASENAME[basename(path)] ?? LANGUAGE_BY_EXTENSION[extname(path)];
}

function readLanguage(value: unknown): SupportedLanguage | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (isSupportedConfiguredLanguage(normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported Tree-sitter language: ${value}`);
}

function isSupportedConfiguredLanguage(
  value: string,
): value is SupportedLanguage {
  return Object.values(LANGUAGE_BY_EXTENSION).includes(value as SupportedLanguage) ||
    Object.values(LANGUAGE_BY_BASENAME).includes(value as SupportedLanguage);
}

function serializeQueryMatch(
  match: QueryMatch,
  includeText: boolean,
): {
  patternIndex: number;
  captures: Array<{
    name: string;
    nodeType: string;
    range: CodeRange;
    text?: string;
  }>;
} {
  return {
    patternIndex: match.patternIndex,
    captures: match.captures.map((capture) => ({
      name: capture.name,
      nodeType: capture.node.type,
      range: nodeRange(capture.node),
      ...(includeText ? { text: capture.node.text } : {}),
    })),
  };
}

function collectAncestors(
  node: Node,
  maxDepth: number,
): Array<{
  nodeType: string;
  named: boolean;
  range: CodeRange;
  textPreview: string;
}> {
  const ancestors = [];
  let current: Node | null = node;
  while (current && ancestors.length < maxDepth) {
    ancestors.push({
      nodeType: current.type,
      named: current.isNamed,
      range: nodeRange(current),
      textPreview: previewText(current.text),
    });
    current = current.parent;
  }
  return ancestors;
}

function summarizeParseHealth(root: Node): {
  hasError: boolean;
  errorNodeCount: number;
  missingNodeCount: number;
  rootType: string;
  namedChildCount: number;
} {
  let errorNodeCount = 0;
  let missingNodeCount = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.isError) {
      errorNodeCount += 1;
    }
    if (node.isMissing) {
      missingNodeCount += 1;
    }
    stack.push(...node.children);
  }

  return {
    hasError: root.hasError,
    errorNodeCount,
    missingNodeCount,
    rootType: root.type,
    namedChildCount: root.namedChildCount,
  };
}

function nodeRange(node: Node): CodeRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
    startByte: node.startIndex,
    endByte: node.endIndex,
  };
}

function readPoint(
  input: Record<string, unknown>,
  lineKey: string,
  columnKey: string,
): { row: number; column: number } {
  const line = readPositiveInteger(input[lineKey], 1);
  return {
    row: Math.max(0, line - 1),
    column: readNonNegativeInteger(input[columnKey], 0),
  };
}

function isDefinitionLikeNodeType(nodeType: string): boolean {
  return /function|method|class|struct|enum|interface|module|declaration|definition|item/.test(
    nodeType,
  );
}

function normalizeSymbolName(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function previewText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 240);
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function readCappedPositiveInteger(
  value: unknown,
  fallback: number,
  cap: number,
): number {
  return Math.min(readPositiveInteger(value, fallback), cap);
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
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

function boundedQueryMatchLimit(maxResults: number): number {
  return Math.max(1, Math.min(65_536, maxResults * 8));
}

function completeResult(
  action: ResearchToolAction,
  startedAt: string,
  input: {
    summary: string;
    output: unknown;
    evidence?: readonly unknown[];
  },
): ResearchToolExecutionResult {
  return {
    action,
    status: "complete",
    startedAt,
    completedAt: nowIso(),
    summary: input.summary,
    output: input.output,
    evidence: input.evidence ?? [],
    claims: [],
    artifactRefs: [],
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
    followUpActions: ["Report the code tool failure before continuing."],
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
