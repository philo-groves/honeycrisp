import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { nowIso } from "./ids.js";
import type {
  ResearchExecutableTool,
  ResearchToolExecutionResult,
} from "./tool-registry.js";
import type { ResearchToolAction } from "./types.js";
import type {
  ShellAuthorizationDecision,
  ShellCommandAuthorizer,
} from "./shell-safety.js";
import {
  redactShellArguments,
  sanitizeShellAuthorizationDecision,
} from "./shell-safety.js";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONCURRENCY = 64;
const LEASE_RETRY_MS = 50;
const NEW_LEASE_GRACE_MS = 5_000;
const WSL_SYSTEM_DISTRIBUTIONS = new Set(["docker-desktop", "docker-desktop-data"]);
const SHELL_PARAMETERS = {
  type: "object",
  description: "Provide either command, or utility with optional args. Do not provide both forms.",
  properties: {
    command: {
      type: "string",
      description: "Complete shell command. On Windows this automatically uses WSL when an installed Linux distribution is available; set runtime to host to require cmd.exe. Supports pipelines, chaining, redirects, and other shell syntax. Do not combine with utility or args.",
    },
    utility: {
      type: "string",
      description: "Executable name or path for direct argv execution. Do not combine with command.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments passed directly to utility without shell interpolation.",
    },
    cwd: {
      type: "string",
      description: "Working directory. Relative paths resolve from the research workspace.",
    },
    stdin: { type: "string" },
    timeoutMs: { type: "number" },
    runtime: {
      type: "string",
      enum: ["host", "wsl"],
      description: "Execution runtime. Direct utility calls default to host. Command calls on Windows default to WSL when available and otherwise use the host shell.",
    },
  },
};

export type ShellRuntime = "host" | "wsl";

export interface WslShellOptions {
  executable?: string;
  distribution?: string;
  listDistributions?: () => readonly string[];
}

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
  authorize?: ShellCommandAuthorizer;
  platform?: NodeJS.Platform;
  wsl?: WslShellOptions;
}

interface RequestedShellInvocation {
  kind: "command" | "utility";
  utility: string;
  args: string[];
}

interface WslSupport {
  executable: string;
  distribution: string;
}

interface ResolvedShellInvocation {
  runtime: ShellRuntime;
  utility: string;
  args: string[];
  policyUtility: string;
  policyArgs: string[];
  displayUtility: string;
  cwd: string;
  wsl?: {
    distribution: string;
    cwd: string;
  };
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
  const platform = options.platform ?? process.platform;
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const protectedDirectories = defaultProtectedDirectories(workspaceRoot, options.protectedDirectories);
  let cachedWslSupport: WslSupport | null | undefined;
  const wslSupport = (): WslSupport | null => {
    if (cachedWslSupport !== undefined) return cachedWslSupport;
    cachedWslSupport = detectWslSupport(platform, options.wsl);
    return cachedWslSupport;
  };
  return {
    descriptor: {
      name: "shell.run",
      transportName: "shell_run",
      description:
        "Run a shell command or execute a utility directly with explicit argv. On Windows, command form automatically uses an installed WSL distribution so POSIX commands and pipelines work; set runtime to host for cmd.exe. Direct utilities stay on the host unless runtime is wsl. Windows workspace paths are translated for WSL. Use repository.search first for literal discovery; raw search commands should use a narrow cwd or path and a bounded timeout. Exit status 1 from direct rg, grep, findstr, or git grep execution is reported as a successful no-match result. Shell safety authorization, recognized network-intent policy, utility policy for direct execution, and core-directory deletion guards are enforced by the Honeycrisp harness before spawn.",
      actionClasses: ["search", "inspect", "analyze", "experiment"],
      sideEffects: "process",
      requiredPermissions: ["process:spawn"],
      inputSchema: SHELL_PARAMETERS,
      metadata: {
        provider: "honeycrisp.built_in",
        safetyProfile: "host-utility-policy",
        networkPolicy: "host-recorded-command-intent",
        shellRuntimes: platform === "win32" ? ["host", "wsl"] : ["host"],
        defaultCommandRuntime: platform === "win32" ? "wsl_when_available" : "host",
        defaultBudget: { maxToolCalls: 1 },
      },
    },
    parameters: SHELL_PARAMETERS,
    async execute(action, context) {
      const startedAt = nowIso();
      try {
        const requested = readShellInvocation(action.input);
        const invocation = resolveShellInvocation({
          requested,
          requestedRuntime: readShellRuntime(action.input.runtime),
          requestedCwd: action.input.cwd,
          workspaceRoot,
          platform,
          wslSupport,
        });
        const stdin = readOptionalString(action.input.stdin, "stdin");
        const timeoutMs = Math.min(
          positiveInteger(
            action.input.timeoutMs,
            defaultUtilityTimeoutMs(invocation.policyUtility, invocation.policyArgs),
          ),
          MAX_TIMEOUT_MS,
        );
        const policy = await loadShellOptions(options.shellOptionsPath);
        const policyUtility = utilityPolicyName(invocation.policyUtility);
        const concurrency = policy.utilities[invocation.policyUtility]
          ?? policy.utilities[policyUtility]
          ?? policy.defaultConcurrency;
        if (concurrency === 0) {
          return errorResult(
            action,
            startedAt,
            `Shell utility ${policyUtility} is disabled by the harness-wide Shell Options policy.`,
          );
        }
        await assertFolderDeleteAllowed(
          invocation.policyUtility,
          invocation.policyArgs,
          invocation.cwd,
          protectedDirectories,
        );
        if (invocation.wsl) {
          await assertWslFolderDeleteAllowed(
            invocation.policyUtility,
            invocation.policyArgs,
            invocation.wsl.cwd,
            invocation.wsl.distribution,
            protectedDirectories,
          );
        }
        if (!options.authorize) {
          return blockedAuthorizationResult(
            action,
            startedAt,
            "Shell execution denied because no shell safety authorizer is configured.",
          );
        }
        let authorization: ShellAuthorizationDecision;
        try {
          authorization = sanitizeShellAuthorizationDecision(await options.authorize({
            actionId: action.id,
            workspaceRoot,
            utility: invocation.utility,
            args: invocation.args,
            cwd: invocation.cwd,
            ...(stdin === undefined ? {} : { stdin }),
            timeoutMs,
            ...(context?.runbookContext ? { runbookContext: context.runbookContext } : {}),
          }, context?.signal));
        } catch {
          return blockedAuthorizationResult(
            action,
            startedAt,
            "Shell execution denied because the shell safety authorizer failed closed.",
          );
        }
        if (authorization.decision !== "approved") {
          return blockedAuthorizationResult(
            action,
            startedAt,
            shellAuthorizationDenialSummary(authorization),
            authorization,
          );
        }
        throwIfAborted(context?.signal);

        const deadline = Date.now() + timeoutMs;
        const lease = await acquireLease(
          policy.leaseDirectory,
          policyUtility,
          concurrency,
          action.id,
          context?.signal,
          deadline,
        );
        try {
          return await runUtility({
            action,
            utility: invocation.utility,
            args: invocation.args,
            logicalUtility: invocation.policyUtility,
            logicalArgs: invocation.policyArgs,
            displayUtility: invocation.displayUtility,
            cwd: invocation.cwd,
            runtime: invocation.runtime,
            ...(invocation.wsl ? { wsl: invocation.wsl } : {}),
            ...(stdin === undefined ? {} : { stdin }),
            startedAt,
            timeoutMs: Math.max(1, deadline - Date.now()),
            maxOutputBytes,
            authorization,
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

async function assertWslFolderDeleteAllowed(
  utility: string,
  args: readonly string[],
  cwd: string,
  distribution: string,
  protectedDirectories: readonly ProtectedDirectory[],
): Promise<void> {
  const targets = destructiveDirectoryTargets(utility, args, cwd, posix.resolve);
  if (targets.length === 0) return;
  const protectedWslPaths: ProtectedDirectory[] = [
    { path: "/", includeDescendants: false },
    { path: "/home", includeDescendants: false },
    { path: "/mnt", includeDescendants: false },
    { path: "/tmp", includeDescendants: false },
    { path: "/var", includeDescendants: false },
    ...["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/sys", "/usr"]
      .map((path) => ({ path, includeDescendants: true })),
    ...protectedDirectories.flatMap((entry) => {
      const translated = windowsPathToWsl(entry.path, distribution);
      return translated ? [{ path: translated, includeDescendants: entry.includeDescendants }] : [];
    }),
  ];
  for (const rawTarget of targets) {
    const target = posix.resolve(cwd, rawTarget.replace(/\\/gu, "/"));
    const protectedPath = protectedWslPaths.find(
      (candidate) =>
        posixPathContains(target, candidate.path) ||
        (candidate.includeDescendants && posixPathContains(candidate.path, target)),
    );
    if (!protectedPath) continue;
    throw new Error(
      `Folder delete guard blocked ${utility} from targeting protected WSL directory ${target}.`,
    );
  }
}

function posixPathContains(parent: string, child: string): boolean {
  const childRelativePath = posix.relative(parent, child);
  return childRelativePath === "" || (!childRelativePath.startsWith("..") && !posix.isAbsolute(childRelativePath));
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

function destructiveDirectoryTargets(
  utility: string,
  args: readonly string[],
  cwd: string,
  pathResolver: (...paths: string[]) => string = resolve,
): string[] {
  if (utility === "rm" || utility === "rmdir") {
    return positionalArguments(args);
  }
  if (utility === "find" && findPerformsDeletion(args)) {
    return findRoots(args);
  }
  if (utility === "git") {
    return gitCleanTargets(args, cwd, pathResolver);
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

function gitCleanTargets(
  args: readonly string[],
  cwd: string,
  pathResolver: (...paths: string[]) => string = resolve,
): string[] {
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
      directory = pathResolver(directory, nextArg);
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
    if (clean && (pathspecs || !arg.startsWith("-"))) targets.push(pathResolver(directory, arg));
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
  logicalUtility: string;
  logicalArgs: string[];
  displayUtility: string;
  cwd: string;
  runtime: ShellRuntime;
  wsl?: {
    distribution: string;
    cwd: string;
  };
  stdin?: string;
  startedAt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  authorization: ShellAuthorizationDecision;
  signal?: AbortSignal;
}): Promise<ResearchToolExecutionResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stopping = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const output = createOutputCollector(input.maxOutputBytes);
    const child = spawn(input.utility, input.args, {
      cwd: input.cwd,
      env: shellEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => output.appendStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.appendStderr(chunk));

    const killProcessTree = (signal: NodeJS.Signals): void => {
      if (process.platform === "win32" && child.pid !== undefined) {
        const result = spawnSync(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          {
            windowsHide: true,
            stdio: "ignore",
          },
        );
        if (result.status === 0 || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
      }
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already be gone; fall back to the direct child.
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const stop = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (stopping) return;
      stopping = true;
      killProcessTree("SIGTERM");
      forceStop = setTimeout(() => killProcessTree("SIGKILL"), 1_000);
      forceStop.unref();
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs);
    const abort = (): void => stop("abort");
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
      input.signal?.removeEventListener("abort", abort);
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? unavailableUtilityMessage(input.utility, input.runtime)
        : errorMessage(error);
      resolvePromise(errorResult(input.action, input.startedAt, message, {
        utility: input.utility,
        args: redactShellArguments(input.args),
        cwd: input.cwd,
        runtime: input.runtime,
        ...(input.wsl ? { wsl: input.wsl } : {}),
        authorization: input.authorization,
      }));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceStop) clearTimeout(forceStop);
      input.signal?.removeEventListener("abort", abort);
      const captured = output.value();
      const resultOutput = {
        utility: input.utility,
        args: redactShellArguments(input.args),
        cwd: input.cwd,
        runtime: input.runtime,
        ...(input.wsl ? { wsl: input.wsl } : {}),
        exitCode,
        signal,
        timedOut,
        aborted,
        authorization: input.authorization,
        ...captured,
      };
      const noMatches = exitCode === 1 && isSearchUtility(input.logicalUtility, input.logicalArgs);
      if ((exitCode === 0 || noMatches) && !timedOut && !aborted) {
        resolvePromise({
          action: input.action,
          status: "complete",
          startedAt: input.startedAt,
          completedAt: nowIso(),
          summary: noMatches
            ? `${input.displayUtility} completed with no matches.`
            : `${input.displayUtility} completed successfully.`,
          output: resultOutput,
          followUpActions: [],
        });
        return;
      }
      const reason = timedOut
        ? `${input.displayUtility} timed out after ${input.timeoutMs}ms.`
        : aborted
          ? `${input.displayUtility} was aborted.`
          : `${input.displayUtility} exited with status ${exitCode ?? signal ?? "unknown"}.`;
      resolvePromise(errorResult(input.action, input.startedAt, reason, resultOutput));
    });

    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function defaultUtilityTimeoutMs(utility: string, args: readonly string[]): number {
  return isSearchUtility(utility, args) ? DEFAULT_SEARCH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function isSearchUtility(utility: string, args: readonly string[]): boolean {
  const normalized = utility.toLowerCase();
  return normalized === "rg"
    || normalized === "grep"
    || normalized === "findstr"
    || (normalized === "git" && args.includes("grep"));
}

function unavailableUtilityMessage(utility: string, runtime: ShellRuntime): string {
  if (runtime === "wsl") {
    return `WSL executable ${utility} is not available. Install or enable WSL, or rerun with runtime host.`;
  }
  const host = process.platform === "win32" ? "Windows host" : "host";
  return `Shell utility ${utility} is not available on the ${host} PATH. Do not repeat the same command. On Windows, use runtime wsl for utilities installed in the workspace's Linux environment.`;
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
    if (value === undefined || isSensitiveEnvironmentName(name)) continue;
    environment[name] = value;
  }
  environment.HONEYCRISP_SHELL = "1";
  return environment;
}

function isSensitiveEnvironmentName(name: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/iu.test(name);
}

function readUtility(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("shell.run utility must be a non-empty executable name or path without null bytes.");
  }
  return value.trim();
}

function readShellInvocation(input: Record<string, unknown>): RequestedShellInvocation {
  const hasCommand = input.command !== undefined;
  const hasUtility = input.utility !== undefined;
  if (hasCommand && (hasUtility || input.args !== undefined)) {
    throw new Error("shell.run accepts command or utility with args, not both.");
  }
  if (hasCommand) {
    return { kind: "command", utility: "/bin/sh", args: ["-lc", readCommand(input.command)] };
  }
  if (!hasUtility) throw new Error("shell.run requires command or utility.");
  return { kind: "utility", utility: readUtility(input.utility), args: readArguments(input.args) };
}

function readCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("shell.run command must be a non-empty string without null bytes.");
  }
  return value;
}

function readShellRuntime(value: unknown): ShellRuntime | undefined {
  if (value === undefined) return undefined;
  if (value === "host" || value === "wsl") return value;
  throw new Error("shell.run runtime must be host or wsl.");
}

function resolveShellInvocation(input: {
  requested: RequestedShellInvocation;
  requestedRuntime: ShellRuntime | undefined;
  requestedCwd: unknown;
  workspaceRoot: string;
  platform: NodeJS.Platform;
  wslSupport(): WslSupport | null;
}): ResolvedShellInvocation {
  const runtime = resolveShellRuntime(
    input.requestedRuntime,
    input.requested.kind,
    input.platform,
    input.wslSupport,
  );
  if (runtime === "host") {
    const cwd = readWorkingDirectory(input.requestedCwd, input.workspaceRoot);
    if (input.requested.kind === "command") {
      const command = input.requested.args[1] ?? "";
      const shell = input.platform === "win32"
        ? process.env.ComSpec?.trim() || "cmd.exe"
        : "/bin/sh";
      return {
        runtime,
        utility: shell,
        args: input.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
        policyUtility: shell,
        policyArgs: input.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
        displayUtility: utilityPolicyName(shell),
        cwd,
      };
    }
    return {
      runtime,
      utility: input.requested.utility,
      args: input.requested.args,
      policyUtility: input.requested.utility,
      policyArgs: input.requested.args,
      displayUtility: input.requested.utility,
      cwd,
    };
  }

  const support = input.wslSupport();
  if (!support) {
    throw new Error(
      input.platform === "win32"
        ? "shell.run runtime wsl requires an installed, user-facing WSL distribution. Install a distribution or use runtime host."
        : "shell.run runtime wsl is available only from a Windows host.",
    );
  }
  const wslCwd = readWslWorkingDirectory(input.requestedCwd, input.workspaceRoot, support.distribution);
  const args = ["--distribution", support.distribution, "--cd", wslCwd, "--exec"];
  if (input.requested.kind === "command") {
    const command = translateWindowsPathsInCommand(input.requested.args[1] ?? "", support.distribution);
    args.push("/bin/sh", "-lc", command);
  } else {
    args.push(
      input.requested.utility,
      ...input.requested.args.map((argument) => translateWindowsPathsInArgument(argument, support.distribution)),
    );
  }
  return {
    runtime,
    utility: support.executable,
    args,
    policyUtility: input.requested.utility,
    policyArgs: input.requested.args,
    displayUtility: input.requested.kind === "command"
      ? `WSL (${support.distribution}) shell`
      : `WSL (${support.distribution}) ${input.requested.utility}`,
    cwd: input.workspaceRoot,
    wsl: { distribution: support.distribution, cwd: wslCwd },
  };
}

function resolveShellRuntime(
  requested: ShellRuntime | undefined,
  kind: RequestedShellInvocation["kind"],
  platform: NodeJS.Platform,
  wslSupport: () => WslSupport | null,
): ShellRuntime {
  if (requested === "host") return "host";
  if (requested === "wsl") {
    if (!wslSupport()) {
      throw new Error(
        platform === "win32"
          ? "shell.run runtime wsl requires an installed, user-facing WSL distribution. Install a distribution or use runtime host."
          : "shell.run runtime wsl is available only from a Windows host.",
      );
    }
    return "wsl";
  }
  return platform === "win32" && kind === "command" && wslSupport() ? "wsl" : "host";
}

function detectWslSupport(platform: NodeJS.Platform, options: WslShellOptions | undefined): WslSupport | null {
  if (platform !== "win32") return null;
  const executable = options?.executable?.trim() || "wsl.exe";
  const distributions = (options?.listDistributions?.() ?? listWslDistributions(executable))
    .map((distribution) => distribution.trim())
    .filter((distribution) => distribution.length > 0);
  const requestedDistribution = options?.distribution?.trim();
  if (requestedDistribution) {
    const distribution = distributions.find(
      (candidate) => candidate.toLowerCase() === requestedDistribution.toLowerCase(),
    );
    if (!distribution) return null;
    return { executable, distribution };
  }
  const distribution = distributions.find(
    (candidate) => !WSL_SYSTEM_DISTRIBUTIONS.has(candidate.toLowerCase()),
  );
  return distribution ? { executable, distribution } : null;
}

function listWslDistributions(executable: string): string[] {
  const result = spawnSync(executable, ["--list", "--quiet"], {
    windowsHide: true,
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return decodeWslListOutput(result.stdout).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

export function decodeWslListOutput(output: Buffer | string): string {
  if (typeof output === "string") return output.replace(/^\uFEFF/u, "").replace(/\0/gu, "");
  const utf16 = output.toString("utf16le").replace(/^\uFEFF/u, "").replace(/\0/gu, "");
  if (/\r?\n/u.test(utf16) || output.includes(0)) return utf16;
  return output.toString("utf8").replace(/^\uFEFF/u, "").replace(/\0/gu, "");
}

export function windowsPathToWsl(path: string, distribution?: string): string | null {
  if (path.startsWith("/")) return path;
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
  if (drive) {
    const suffix = (drive[2] ?? "").replace(/\\/gu, "/");
    return `/mnt/${drive[1]?.toLowerCase()}${suffix ? `/${suffix}` : ""}`;
  }
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/iu.exec(path);
  if (!unc) return null;
  const uncDistribution = unc[1] ?? "";
  if (distribution && uncDistribution.toLowerCase() !== distribution.toLowerCase()) return null;
  const suffix = (unc[2] ?? "").replace(/\\/gu, "/");
  return suffix ? `/${suffix}` : "/";
}

export function translateWindowsPathsInCommand(command: string, distribution?: string): string {
  const quoted = command.replace(/(["'])([A-Za-z]:[\\/][^"']*)\1/gu, (_match, quote: string, path: string) => {
    const translated = windowsPathToWsl(path, distribution);
    return translated ? `${quote}${translated}${quote}` : `${quote}${path}${quote}`;
  });
  return quoted.replace(/(^|[\s=])([A-Za-z]:[\\/][^\s"'|&;<>]*)/gu, (_match, prefix: string, path: string) => {
    const translated = windowsPathToWsl(path, distribution);
    return `${prefix}${translated ?? path}`;
  });
}

function translateWindowsPathsInArgument(argument: string, distribution?: string): string {
  const direct = windowsPathToWsl(argument, distribution);
  if (direct) return direct;
  return argument.replace(/(^|=)([A-Za-z]:[\\/].*)$/u, (_match, prefix: string, path: string) => {
    const translated = windowsPathToWsl(path, distribution);
    return `${prefix}${translated ?? path}`;
  });
}

function readWslWorkingDirectory(value: unknown, workspaceRoot: string, distribution: string): string {
  if (value === undefined) {
    const translated = windowsPathToWsl(workspaceRoot, distribution);
    if (!translated) throw new Error(`Cannot map workspace root ${workspaceRoot} into WSL.`);
    return translated;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("shell.run cwd must be a non-empty string.");
  }
  if (value.startsWith("/")) return value;
  const absolute = resolve(workspaceRoot, value);
  const translated = windowsPathToWsl(absolute, distribution);
  if (!translated) throw new Error(`Cannot map shell.run cwd ${absolute} into WSL.`);
  return translated;
}

function utilityPolicyName(utility: string): string {
  return basename(utility).toLowerCase().replace(/\.(?:bat|cmd|com|exe)$/u, "");
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

function blockedAuthorizationResult(
  action: ResearchToolAction,
  startedAt: string,
  message: string,
  authorization?: ShellAuthorizationDecision,
): ResearchToolExecutionResult {
  return {
    action,
    status: "blocked",
    startedAt,
    completedAt: nowIso(),
    summary: message,
    ...(authorization ? { output: { authorization } } : {}),
    followUpActions: [
      "Narrow the command or ask the researcher to select an appropriate shell safety mode.",
    ],
    error: { message },
  };
}

function shellAuthorizationDenialSummary(authorization: ShellAuthorizationDecision): string {
  const source = authorization.source === "human"
    ? "Manual Approval"
    : authorization.source === "small_model"
      ? "Auto-Review"
      : "shell safety policy";
  return "Shell execution denied by " + source + ": " + authorization.reason;
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
