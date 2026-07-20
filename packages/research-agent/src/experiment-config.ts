import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { nowIso } from "./ids.js";
import {
  registerResearchStorageArtifact,
} from "./storage.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type {
  ResearchArtifactRef,
  ResearchStorageLayout,
  ResearchToolAction,
  ResearchToolSideEffect,
} from "./types.js";

const DEFAULT_EXPERIMENT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPERIMENT_MAX_OUTPUT_BYTES = 64_000;

const EXPERIMENT_CONFIG_PARAMETERS = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    input: { type: "object" },
  },
};

export interface ResearchConfiguredExperimentSpec {
  name: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  sideEffects: ResearchToolSideEffect;
  requiredPermissions: readonly string[];
}

export interface ResearchExperimentConfig {
  experiments: readonly ResearchConfiguredExperimentSpec[];
}

export interface CreateConfiguredExperimentToolOptions {
  config: ResearchExperimentConfig;
  storageLayout?: ResearchStorageLayout;
}

export function loadResearchExperimentConfig(
  configPath: string,
): ResearchExperimentConfig {
  const absolutePath = resolve(configPath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Experiment config must be a JSON object: ${absolutePath}`);
  }

  return {
    experiments: parseExperimentSpecs(parsed.experiments, absolutePath),
  };
}

export function createConfiguredExperimentTool(
  options: CreateConfiguredExperimentToolOptions,
): ResearchExecutableTool {
  const experiments = new Map(
    options.config.experiments.map((experiment) => [experiment.name, experiment]),
  );
  const requiredPermissions = [
    "experiment:run",
    ...new Set(
      options.config.experiments.flatMap((experiment) =>
        experiment.requiredPermissions,
      ),
    ),
  ];

  return {
    descriptor: {
      name: "experiment.run",
      transportName: "experiment_run",
      description: "Run an explicitly configured allowlisted experiment.",
      actionClasses: ["experiment"],
      sideEffects: "process",
      requiredPermissions,
      inputSchema: EXPERIMENT_CONFIG_PARAMETERS,
      metadata: {
        provider: "honeycrisp.configured_experiment",
        safetyProfile: "allowlisted-process",
        experiments: options.config.experiments.map((experiment) => ({
          name: experiment.name,
          command: experiment.command,
          args: experiment.args,
          ...(experiment.cwd ? { cwd: experiment.cwd } : {}),
          timeoutMs: experiment.timeoutMs,
          maxOutputBytes: experiment.maxOutputBytes,
          sideEffects: experiment.sideEffects,
          requiredPermissions: experiment.requiredPermissions,
        })),
      },
    },
    parameters: EXPERIMENT_CONFIG_PARAMETERS as NonNullable<ResearchExecutableTool["parameters"]>,
    async execute(action) {
      const startedAt = nowIso();
      const name = readRequiredString(action.input, "name");
      const experiment = experiments.get(name);
      if (!experiment) {
        return createExperimentResult({
          action,
          startedAt,
          status: "error",
          summary: `Unknown configured experiment: ${name}`,
          followUpActions: ["Choose one of the configured experiment names."],
          errorMessage: `Unknown configured experiment: ${name}`,
        });
      }

      return runConfiguredExperiment({
        action,
        startedAt,
        experiment,
        input: isRecord(action.input.input) ? action.input.input : {},
        ...(options.storageLayout ? { storageLayout: options.storageLayout } : {}),
      });
    },
  };
}

async function runConfiguredExperiment(input: {
  action: ResearchToolAction;
  startedAt: string;
  experiment: ResearchConfiguredExperimentSpec;
  input: Record<string, unknown>;
  storageLayout?: ResearchStorageLayout;
}): Promise<ResearchToolExecutionResult> {
  let result: Awaited<ReturnType<typeof runProcessExperiment>>;
  try {
    result = await runProcessExperiment(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createExperimentResult({
      action: input.action,
      startedAt: input.startedAt,
      status: "error",
      summary: `Experiment ${input.experiment.name} failed to start: ${message}`,
      output: {
        name: input.experiment.name,
        command: input.experiment.command,
        args: input.experiment.args,
        ...(input.experiment.cwd ? { cwd: input.experiment.cwd } : {}),
        spawnError: message,
      },
      followUpActions: [
        "Check the configured experiment command, working directory, and arguments.",
      ],
      errorMessage: message,
    });
  }
  const artifactRefs = input.storageLayout
    ? writeExperimentArtifacts({
        storageLayout: input.storageLayout,
        action: input.action,
        experimentName: input.experiment.name,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    : [];
  const output = {
    name: input.experiment.name,
    command: input.experiment.command,
    args: input.experiment.args,
    ...(input.experiment.cwd ? { cwd: input.experiment.cwd } : {}),
    sideEffects: input.experiment.sideEffects,
    requiredPermissions: input.experiment.requiredPermissions,
    timeoutMs: input.experiment.timeoutMs,
    maxOutputBytes: input.experiment.maxOutputBytes,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    stdoutHash: hashText(result.stdout),
    stderrHash: hashText(result.stderr),
    stdoutPreview: result.stdout.slice(0, 2000),
    stderrPreview: result.stderr.slice(0, 2000),
    artifactRefs,
  };
  const completed = result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded;

  const summary = completed
    ? `Experiment ${input.experiment.name} completed with exit code 0.`
    : `Experiment ${input.experiment.name} failed with exit code ${result.exitCode ?? "none"}.`;

  return createExperimentResult({
    action: input.action,
    startedAt: input.startedAt,
    status: completed ? "complete" : "error",
    summary,
    output,
    artifactRefs,
    followUpActions: completed
      ? []
      : ["Review experiment stdout/stderr artifacts before continuing."],
    ...(completed ? {} : { errorMessage: summary }),
  });
}

function runProcessExperiment(input: {
  experiment: ResearchConfiguredExperimentSpec;
  input: Record<string, unknown>;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(input.experiment.command, [...input.experiment.args], {
      cwd: input.experiment.cwd,
      env: {
        ...process.env,
        ...(input.experiment.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.experiment.timeoutMs);

    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const current = kind === "stdout" ? stdout : stderr;
      const next = `${current}${text}`;
      if (Buffer.byteLength(next, "utf8") > input.experiment.maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
      }
      const truncated = next.slice(0, input.experiment.maxOutputBytes);
      if (kind === "stdout") {
        stdout = truncated;
      } else {
        stderr = truncated;
      }
    };

    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveProcess({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        stdout,
        stderr,
      });
    });
    child.stdin.end(`${JSON.stringify(input.input)}\n`, "utf8");
  });
}

function writeExperimentArtifacts(input: {
  storageLayout: ResearchStorageLayout;
  action: ResearchToolAction;
  experimentName: string;
  stdout: string;
  stderr: string;
}): readonly ResearchArtifactRef[] {
  const refs: ResearchArtifactRef[] = [];
  const safePrefix = `${safeFileSegment(input.action.id)}-${safeFileSegment(input.experimentName)}`;

  if (input.stdout.length > 0) {
    refs.push(writeOneExperimentArtifact({
      storageLayout: input.storageLayout,
      path: resolve(
        input.storageLayout.artifactDirectoryPath,
        "experiments",
        `${safePrefix}-stdout.txt`,
      ),
      id: `artifact_${safePrefix}_stdout`,
      kind: "experiment_stdout",
      purpose: `stdout from experiment ${input.experimentName}`,
      content: input.stdout,
    }));
  }
  if (input.stderr.length > 0) {
    refs.push(writeOneExperimentArtifact({
      storageLayout: input.storageLayout,
      path: resolve(
        input.storageLayout.artifactDirectoryPath,
        "experiments",
        `${safePrefix}-stderr.txt`,
      ),
      id: `artifact_${safePrefix}_stderr`,
      kind: "experiment_stderr",
      purpose: `stderr from experiment ${input.experimentName}`,
      content: input.stderr,
    }));
  }

  return refs;
}

function writeOneExperimentArtifact(input: {
  storageLayout: ResearchStorageLayout;
  path: string;
  id: string;
  kind: string;
  purpose: string;
  content: string;
}): ResearchArtifactRef {
  mkdirSync(dirname(input.path), { recursive: true });
  writeFileSync(input.path, input.content, "utf8");
  const entry = registerResearchStorageArtifact(input.storageLayout, {
    id: input.id,
    path: input.path,
    kind: input.kind,
    purpose: input.purpose,
  });

  return {
    id: entry.id,
    kind: entry.kind,
    uri: entry.uri,
    summary: entry.purpose,
    contentHash: entry.contentHash,
  };
}

function createExperimentResult(input: {
  action: ResearchToolAction;
  startedAt: string;
  status: ResearchToolExecutionResult["status"];
  summary: string;
  output?: unknown;
  artifactRefs?: readonly ResearchArtifactRef[];
  followUpActions: readonly string[];
  errorMessage?: string;
}): ResearchToolExecutionResult {
  return {
    action: input.action,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: nowIso(),
    summary: input.summary,
    ...(input.output !== undefined ? { output: input.output } : {}),
    artifactRefs: input.artifactRefs ?? [],
    followUpActions: input.followUpActions,
    ...(input.errorMessage ? { error: { message: input.errorMessage } } : {}),
  };
}

function parseExperimentSpecs(
  value: unknown,
  configPath: string,
): readonly ResearchConfiguredExperimentSpec[] {
  if (Array.isArray(value)) {
    return value.map((experiment, index) =>
      normalizeExperimentSpec(experiment, configPath, String(index)),
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, experiment]) =>
      normalizeExperimentSpec(
        isRecord(experiment) ? { name, ...experiment } : experiment,
        configPath,
        name,
      ),
    );
  }

  throw new Error(`Experiment config requires an experiments object or array: ${configPath}`);
}

function normalizeExperimentSpec(
  value: unknown,
  configPath: string,
  label: string,
): ResearchConfiguredExperimentSpec {
  if (!isRecord(value)) {
    throw new Error(`Experiment ${label} must be an object: ${configPath}`);
  }
  const name = readRequiredString(value, "name");
  const command = readCommand(value, configPath, name);
  const sideEffects = readSideEffect(value.sideEffects, name);
  const cwd = readOptionalWorkingDirectory(value.cwd, configPath, name);

  return {
    name,
    command,
    args: readOptionalStringArray(value, "args"),
    ...(cwd ? { cwd } : {}),
    env: readOptionalStringRecord(value.env, `Experiment ${name}.env`) ?? {},
    timeoutMs:
      readOptionalPositiveNumber(value.timeoutMs, "timeoutMs") ??
      DEFAULT_EXPERIMENT_TIMEOUT_MS,
    maxOutputBytes:
      readOptionalPositiveNumber(value.maxOutputBytes, "maxOutputBytes") ??
      DEFAULT_EXPERIMENT_MAX_OUTPUT_BYTES,
    sideEffects,
    requiredPermissions: readRequiredStringArray(value, "requiredPermissions"),
  };
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return item.trim();
}

function readCommand(
  value: Record<string, unknown>,
  configPath: string,
  experimentName: string,
): string {
  const command = readRequiredString(value, "command");
  if (!isPathLikeCommand(command)) {
    return command;
  }

  const absoluteCommand = resolve(dirname(configPath), command);
  if (!existsSync(absoluteCommand)) {
    throw new Error(`Experiment ${experimentName}.command does not exist: ${absoluteCommand}`);
  }
  if (!statSync(absoluteCommand).isFile()) {
    throw new Error(`Experiment ${experimentName}.command must be a file: ${absoluteCommand}`);
  }

  return absoluteCommand;
}

function readOptionalWorkingDirectory(
  value: unknown,
  configPath: string,
  experimentName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Experiment ${experimentName}.cwd must be a non-empty string.`);
  }
  const cwd = resolve(dirname(configPath), value);
  if (!existsSync(cwd)) {
    throw new Error(`Experiment ${experimentName}.cwd does not exist: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Experiment ${experimentName}.cwd must be a directory: ${cwd}`);
  }

  return cwd;
}

function isPathLikeCommand(value: string): boolean {
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function readSideEffect(value: unknown, experimentName: string): ResearchToolSideEffect {
  if (
    value === "none" ||
    value === "read" ||
    value === "write" ||
    value === "network" ||
    value === "process"
  ) {
    return value;
  }

  throw new Error(`Experiment ${experimentName}.sideEffects must be one of none, read, write, network, process.`);
}

function readRequiredStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  if (value[key] === undefined) {
    throw new Error(`${key} must be a string array.`);
  }

  return readOptionalStringArray(value, key);
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const item = value[key];
  if (item === undefined) {
    return [];
  }
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} must be a string array.`);
  }

  return item;
}

function readOptionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    output[key] = item;
  }

  return output;
}

function readOptionalPositiveNumber(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return Math.floor(value);
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeFileSegment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");

  return safe || "experiment";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
