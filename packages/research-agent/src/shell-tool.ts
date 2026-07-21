import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { nowIso } from "./ids.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONCURRENCY = 64;
const LEASE_RETRY_MS = 50;
const NEW_LEASE_GRACE_MS = 5_000;
const UTILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const FORBIDDEN_HOME_REFERENCE_PATTERN = /(?:\$(?:HOME|home|CODEX_HOME)(?![A-Za-z0-9_])|\$\{(?:HOME|home|CODEX_HOME)\b)/u;
const FORBIDDEN_HOME_ASSIGNMENT_PATTERN = /(?:^|[\s;])(?:export\s+)?(?:HOME|home|CODEX_HOME)\s*=/u;

const SHELL_PARAMETERS = {
  type: "object",
  required: ["utility"],
  properties: {
    utility: {
      type: "string",
      description: "Executable name without a path, such as rg, git, make, or clang.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments passed directly to the executable without shell interpolation.",
    },
    cwd: {
      type: "string",
      description: "Working directory. Relative paths resolve from the research workspace.",
    },
    stdin: { type: "string" },
    timeoutMs: { type: "number" },
  },
};

export interface HoneycrispShellOptions {
  schemaVersion: 1;
  defaultConcurrency: number;
  utilities: Record<string, number>;
  leaseDirectory: string;
}

export interface ShellToolOptions {
  workspaceRoot: string;
  shellOptionsPath?: string;
  maxOutputBytes?: number;
  protectedDirectories?: readonly string[];
}

interface ShellLease {
  path: string;
  release(): Promise<void>;
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface ProtectedDirectory {
  path: string;
  includeDescendants: boolean;
}

export function createShellTool(options: ShellToolOptions): ResearchExecutableTool {
  const workspaceRoot = resolve(options.workspaceRoot);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const protectedDirectories = defaultProtectedDirectories(workspaceRoot, options.protectedDirectories);
  return {
    descriptor: {
      name: "shell.run",
      transportName: "shell_run",
      description:
        "Run one host utility with explicit argv. Use it for repository inspection, builds, tests, debugging, and bounded proof work. Utility policy and core-directory deletion guards are enforced by the Honeycrisp harness before spawn.",
      actionClasses: ["search", "inspect", "analyze", "experiment"],
      sideEffects: "process",
      requiredPermissions: ["process:spawn"],
      inputSchema: SHELL_PARAMETERS,
      metadata: {
        provider: "honeycrisp.built_in",
        safetyProfile: "host-utility-policy",
        defaultBudget: { maxToolCalls: 1 },
      },
    },
    parameters: SHELL_PARAMETERS,
    async execute(action, context) {
      const startedAt = nowIso();
      try {
        const utility = readUtility(action.input.utility);
        const args = readArguments(action.input.args);
        const cwd = readWorkingDirectory(action.input.cwd, workspaceRoot);
        const stdin = readOptionalString(action.input.stdin, "stdin");
        assertNoHomeVariableUsage([cwd, ...args, ...(stdin === undefined ? [] : [stdin])]);
        const timeoutMs = Math.min(
          positiveInteger(action.input.timeoutMs, DEFAULT_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        );
        const policy = await loadShellOptions(options.shellOptionsPath);
        const concurrency = policy.utilities[utility] ?? policy.defaultConcurrency;
        if (concurrency === 0) {
          return errorResult(
            action,
            startedAt,
            `Shell utility ${utility} is disabled by the harness-wide Shell Options policy.`,
          );
        }
        await assertFolderDeleteAllowed(utility, args, cwd, protectedDirectories);

        const deadline = Date.now() + timeoutMs;
        const lease = await acquireLease(
          policy.leaseDirectory,
          utility,
          concurrency,
          action.id,
          context?.signal,
          deadline,
        );
        try {
          return await runUtility({
            action,
            utility,
            args,
            cwd,
            ...(stdin === undefined ? {} : { stdin }),
            startedAt,
            timeoutMs: Math.max(1, deadline - Date.now()),
            maxOutputBytes,
            ...(context?.signal ? { signal: context.signal } : {}),
          });
        } finally {
          await lease.release();
        }
      } catch (error) {
        return errorResult(action, startedAt, errorMessage(error));
      }
    },
  };
}

async function assertFolderDeleteAllowed(
  utility: string,
  args: readonly string[],
  cwd: string,
  protectedDirectories: readonly ProtectedDirectory[],
): Promise<void> {
  const targets = destructiveDirectoryTargets(utility, args, cwd);
  if (targets.length === 0) return;
  const normalizedProtected = await Promise.all(
    protectedDirectories.map(async (entry) => ({
      ...entry,
      path: normalizeComparisonPath(await realpath(entry.path).catch(() => resolve(entry.path))),
    })),
  );
  for (const rawTarget of targets) {
    const target = resolve(cwd, rawTarget);
    const normalizedTarget = normalizeComparisonPath(await realpath(target).catch(() => target));
    const protectedPath = normalizedProtected.find(
      (candidate) =>
        pathContains(normalizedTarget, candidate.path) ||
        (candidate.includeDescendants && pathContains(candidate.path, normalizedTarget)),
    );
    if (!protectedPath) continue;
    throw new Error(
      `Folder delete guard blocked ${utility} from targeting protected directory ${normalizedTarget}.`,
    );
  }
}

function destructiveDirectoryTargets(utility: string, args: readonly string[], cwd: string): string[] {
  if (utility === "rm" || utility === "rmdir") {
    return positionalArguments(args);
  }
  if (utility === "find" && findPerformsDeletion(args)) {
    return findRoots(args);
  }
  if (utility === "git") {
    return gitCleanTargets(args, cwd);
  }
  return [];
}

function positionalArguments(args: readonly string[]): string[] {
  const values: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values;
}

function findPerformsDeletion(args: readonly string[]): boolean {
  if (args.includes("-delete")) return true;
  const executionIndex = args.findIndex((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir");
  if (executionIndex < 0) return false;
  return args
    .slice(executionIndex + 1)
    .some((arg) => arg === "rm" || arg === "rmdir" || arg.endsWith("/rm") || arg.endsWith("/rmdir"));
}

function findRoots(args: readonly string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (arg === "--") continue;
    if (roots.length === 0 && (arg === "-H" || arg === "-L" || arg === "-P")) continue;
    if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") break;
    roots.push(arg);
  }
  return roots.length > 0 ? roots : ["."];
}

function gitCleanTargets(args: readonly string[], cwd: string): string[] {
  let directory = cwd;
  let dryRun = false;
  let clean = false;
  let pathspecs = false;
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const nextArg = args[index + 1];
    if (arg === "-C" && nextArg) {
      directory = resolve(directory, nextArg);
      index += 1;
      continue;
    }
    if (arg === "clean") {
      clean = true;
      continue;
    }
    if (clean && arg === "--") {
      pathspecs = true;
      continue;
    }
    if (clean && (pathspecs || !arg.startsWith("-"))) targets.push(resolve(directory, arg));
    if (arg === "-n" || arg === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/u.test(arg)) dryRun = true;
  }
  if (!clean || dryRun) return [];
  return targets.length > 0 ? targets : [directory];
}

function defaultProtectedDirectories(
  workspaceRoot: string,
  additional: readonly string[] | undefined,
): ProtectedDirectory[] {
  const root = resolve(workspaceRoot).match(/^(?:[A-Za-z]:[\\/]|\/)/u)?.[0] ?? resolve(workspaceRoot);
  const systemDirectoryTrees = process.platform === "win32"
    ? [
        process.env.SystemRoot,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.ProgramData,
      ]
    : [
        "/Applications",
        "/Library",
        "/System",
        "/bin",
        "/boot",
        "/dev",
        "/etc",
        "/lib",
        "/lib64",
        "/opt",
        "/proc",
        "/root",
        "/run",
        "/sbin",
        "/sys",
        "/usr",
      ];
  const coreDirectoryRoots = process.platform === "win32"
    ? [root]
    : ["/", "/Users", "/home", "/media", "/mnt", "/private", "/tmp", "/var"];
  const entries: ProtectedDirectory[] = [
    { path: homedir(), includeDescendants: false },
    ...coreDirectoryRoots.map((path) => ({ path, includeDescendants: false })),
    ...systemDirectoryTrees
      .filter((path): path is string => Boolean(path))
      .map((path) => ({ path, includeDescendants: true })),
    { path: resolve(workspaceRoot, ".honeycrisp"), includeDescendants: true },
    { path: resolve(workspaceRoot, ".beale"), includeDescendants: true },
    ...(additional ?? []).map((path) => ({ path: resolve(path), includeDescendants: true })),
  ];
  const unique = new Map<string, ProtectedDirectory>();
  for (const entry of entries) {
    const path = normalizeComparisonPath(entry.path);
    const current = unique.get(path);
    unique.set(path, { path, includeDescendants: entry.includeDescendants || current?.includeDescendants === true });
  }
  return [...unique.values()];
}

function pathContains(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath === "" || (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath));
}

function normalizeComparisonPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function loadShellOptions(path: string | undefined): Promise<HoneycrispShellOptions> {
  if (!path) {
    return {
      schemaVersion: 1,
      defaultConcurrency: DEFAULT_CONCURRENCY,
      utilities: { sudo: 0 },
      leaseDirectory: resolve(
        tmpdir(),
        `honeycrisp-shell-leases-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
      ),
    };
  }

  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, "utf8");
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Shell Options ${absolutePath} must use schemaVersion 1.`);
  }
  const defaultConcurrency = readConcurrency(value.defaultConcurrency, "defaultConcurrency");
  if (!isRecord(value.utilities)) {
    throw new Error(`Shell Options ${absolutePath} utilities must be an object.`);
  }
  const utilities: Record<string, number> = {};
  for (const [utility, concurrency] of Object.entries(value.utilities)) {
    utilities[readUtility(utility)] = readConcurrency(concurrency, `utilities.${utility}`);
  }
  if (typeof value.leaseDirectory !== "string" || !isAbsolute(value.leaseDirectory)) {
    throw new Error(`Shell Options ${absolutePath} leaseDirectory must be an absolute path.`);
  }
  return {
    schemaVersion: 1,
    defaultConcurrency,
    utilities,
    leaseDirectory: resolve(value.leaseDirectory),
  };
}

async function acquireLease(
  directory: string,
  utility: string,
  concurrency: number,
  actionId: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<ShellLease> {
  await mkdir(directory, { recursive: true });
  const utilityKey = createHash("sha256").update(utility).digest("hex").slice(0, 24);
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    for (let slot = 0; slot < concurrency; slot += 1) {
      const path = resolve(directory, `${utilityKey}.${slot}.lease`);
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, utility, actionId, createdAt: nowIso() }),
          "utf8",
        );
        await handle.close();
        let released = false;
        return {
          path,
          async release() {
            if (released) return;
            released = true;
            await unlink(path).catch(() => undefined);
          },
        };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await reclaimStaleLease(path);
      }
    }
    await waitForRetry(signal);
  }
  throw new Error(`Timed out waiting for a ${utility} concurrency slot.`);
}

async function reclaimStaleLease(path: string): Promise<void> {
  try {
    const leaseStat = await stat(path);
    if (Date.now() - leaseStat.mtimeMs < NEW_LEASE_GRACE_MS) return;
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw) as unknown;
    const pid = isRecord(value) && typeof value.pid === "number" ? value.pid : null;
    if (pid && processIsAlive(pid)) return;
    await unlink(path).catch(() => undefined);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, LEASE_RETRY_MS);
    if (!signal) return;
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("Shell utility execution was aborted."));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    setTimeout(() => signal.removeEventListener("abort", abort), LEASE_RETRY_MS + 1);
  });
}

async function runUtility(input: {
  action: ResearchToolAction;
  utility: string;
  args: string[];
  cwd: string;
  stdin?: string;
  startedAt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<ResearchToolExecutionResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const output = createOutputCollector(input.maxOutputBytes);
    const child = spawn(input.utility, input.args, {
      cwd: input.cwd,
      env: shellEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => output.appendStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.appendStderr(chunk));

    const stop = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000).unref();
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const abort = (): void => stop("abort");
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolvePromise(errorResult(input.action, input.startedAt, errorMessage(error)));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      const captured = output.value();
      const resultOutput = {
        utility: input.utility,
        args: input.args,
        cwd: input.cwd,
        exitCode,
        signal,
        timedOut,
        aborted,
        ...captured,
      };
      if (exitCode === 0 && !timedOut && !aborted) {
        resolvePromise({
          action: input.action,
          status: "complete",
          startedAt: input.startedAt,
          completedAt: nowIso(),
          summary: `${input.utility} completed successfully.`,
          output: resultOutput,
          followUpActions: [],
        });
        return;
      }
      const reason = timedOut
        ? `${input.utility} timed out after ${input.timeoutMs}ms.`
        : aborted
          ? `${input.utility} was aborted.`
          : `${input.utility} exited with status ${exitCode ?? signal ?? "unknown"}.`;
      resolvePromise(errorResult(input.action, input.startedAt, reason, resultOutput));
    });

    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function createOutputCollector(maxBytes: number): {
  appendStdout(chunk: Buffer): void;
  appendStderr(chunk: Buffer): void;
  value(): ShellOutput;
} {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
    const used = stream === "stdout" ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, maxBytes - used);
    if (remaining > 0) target.push(chunk.subarray(0, remaining));
    if (chunk.length > remaining) {
      if (stream === "stdout") stdoutTruncated = true;
      else stderrTruncated = true;
    }
    if (stream === "stdout") stdoutBytes += Math.min(chunk.length, remaining);
    else stderrBytes += Math.min(chunk.length, remaining);
  };
  return {
    appendStdout: (chunk) => append(stdout, chunk, "stdout"),
    appendStderr: (chunk) => append(stderr, chunk, "stderr"),
    value: () => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdoutTruncated,
      stderrTruncated,
    }),
  };
}

function shellEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvironmentName(name) || isHomeEnvironmentName(name)) continue;
    environment[name] = value;
  }
  environment.HONEYCRISP_SHELL = "1";
  return environment;
}

function assertNoHomeVariableUsage(values: readonly string[]): void {
  if (values.some((value) => FORBIDDEN_HOME_REFERENCE_PATTERN.test(value) || FORBIDDEN_HOME_ASSIGNMENT_PATTERN.test(value))) {
    throw new Error(
      "Shell input cannot reference or assign $HOME, $home, or $CODEX_HOME; use an explicit narrowly scoped path.",
    );
  }
}

function isHomeEnvironmentName(name: string): boolean {
  return name === "HOME" || name === "CODEX_HOME" || name === "HOMEDRIVE" || name === "HOMEPATH";
}

function isSensitiveEnvironmentName(name: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/iu.test(name);
}

function readUtility(value: unknown): string {
  if (typeof value !== "string" || !UTILITY_PATTERN.test(value)) {
    throw new Error("shell.run utility must be a simple executable name without a path or whitespace.");
  }
  return value;
}

function readArguments(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((argument) => typeof argument === "string")) {
    throw new Error("shell.run args must be an array of strings.");
  }
  return [...value];
}

function readWorkingDirectory(value: unknown, workspaceRoot: string): string {
  if (value === undefined) return workspaceRoot;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("shell.run cwd must be a non-empty string.");
  }
  return resolve(workspaceRoot, value);
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`shell.run ${field} must be a string.`);
  return value;
}

function readConcurrency(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_CONCURRENCY) {
    throw new Error(`Shell Options ${field} must be an integer from 0 through ${MAX_CONCURRENCY}.`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Shell utility execution was aborted.");
}

function errorResult(
  action: ResearchToolAction,
  startedAt: string,
  message: string,
  output?: unknown,
): ResearchToolExecutionResult {
  return {
    action,
    status: "error",
    startedAt,
    completedAt: nowIso(),
    summary: message,
    ...(output === undefined ? {} : { output }),
    followUpActions: ["Inspect the error and adjust the next utility invocation."],
    error: { message },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
