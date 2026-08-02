import type { Readable } from "node:stream";

interface HoneycrispControlRequest {
  schemaVersion: 1;
  requestId?: string;
}

export type HoneycrispControlMessage = HoneycrispControlRequest & (
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "configure"; modelSelection: HoneycrispModelSelection }
  | { type: "steer"; instruction: string; modelSelection?: HoneycrispModelSelection }
);

export interface HoneycrispModelSelection {
  provider: string;
  model: string;
  reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type HoneycrispControlEvent =
  | { type: "pause" | "resume" | "stop" | "configure" | "steer"; accepted: true; requestId?: string }
  | { type: "invalid"; accepted: false; error: string; requestId?: string };

interface SteeringWaiter {
  resolve(instructions: string[]): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class HoneycrispControlStream {
  private buffer = "";
  private paused = false;
  private readonly steeringInstructions: string[] = [];
  private modelSelection: HoneycrispModelSelection | undefined;
  private readonly resumeWaiters = new Set<() => void>();
  private readonly steeringWaiters = new Set<SteeringWaiter>();
  private readonly stopController = new AbortController();
  private started = false;
  private inputEnded = false;

  public constructor(
    private readonly input: Readable,
    private readonly onEvent: (event: HoneycrispControlEvent) => void = () => undefined,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.inputEnded = false;
    this.input.setEncoding("utf8");
    this.input.on("data", this.handleData);
    this.input.on("end", this.handleEnd);
    this.input.resume();
  }

  public get signal(): AbortSignal {
    return this.stopController.signal;
  }

  public close(): void {
    if (!this.started) return;
    this.started = false;
    this.inputEnded = true;
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
    this.input.pause();
    this.buffer = "";
    this.paused = false;
    this.resolveResumeWaiters();
    this.resolveSteeringWaiters([]);
  }

  public async takeSteeringInstructions(): Promise<string[]> {
    await this.waitUntilResumed();
    return this.steeringInstructions.splice(0);
  }

  public async waitForSteeringInstructions(signal?: AbortSignal): Promise<string[]> {
    await this.waitUntilResumed();
    if (this.steeringInstructions.length > 0) return this.steeringInstructions.splice(0);
    if (!this.started || this.inputEnded || signal?.aborted || this.stopController.signal.aborted) return [];
    return new Promise((resolve) => {
      const waiter: SteeringWaiter = { resolve, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          this.steeringWaiters.delete(waiter);
          resolve([]);
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.steeringWaiters.add(waiter);
      if (!this.paused && this.steeringInstructions.length > 0) {
        this.resolveSteeringWaiters(this.steeringInstructions.splice(0));
      }
    });
  }

  public getModelSelection(): HoneycrispModelSelection | undefined {
    return this.modelSelection ? { ...this.modelSelection } : undefined;
  }

  private readonly handleData = (chunk: string | Buffer): void => {
    this.buffer += chunk.toString();
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  private readonly handleEnd = (): void => {
    this.inputEnded = true;
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    if (line.trim()) this.handleLine(line);
    this.paused = false;
    this.resolveResumeWaiters();
    this.resolveSteeringWaiters(this.steeringInstructions.splice(0));
  };

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      const message = parseControlMessage(line);
      if (message.type === "pause") {
        this.paused = true;
      } else if (message.type === "resume") {
        this.paused = false;
        this.resolveResumeWaiters();
        if (this.steeringWaiters.size > 0 && this.steeringInstructions.length > 0) {
          this.resolveSteeringWaiters(this.steeringInstructions.splice(0));
        }
      } else if (message.type === "stop") {
        this.paused = false;
        this.resolveResumeWaiters();
        this.resolveSteeringWaiters([]);
        this.stopController.abort(new Error("Honeycrisp run stopped by the host."));
      } else if (message.type === "configure") {
        this.modelSelection = message.modelSelection;
      } else {
        if (message.modelSelection) this.modelSelection = message.modelSelection;
        this.steeringInstructions.push(message.instruction);
        if (!this.paused && this.steeringWaiters.size > 0) {
          this.resolveSteeringWaiters(this.steeringInstructions.splice(0));
        }
      }
      this.onEvent({
        type: message.type,
        accepted: true,
        ...(message.requestId ? { requestId: message.requestId } : {}),
      });
    } catch (error) {
      const requestId = requestIdFromLine(line);
      this.onEvent({
        type: "invalid",
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
        ...(requestId ? { requestId } : {}),
      });
    }
  }

  private waitUntilResumed(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.add(resolve));
  }

  private resolveResumeWaiters(): void {
    for (const resolve of this.resumeWaiters) resolve();
    this.resumeWaiters.clear();
  }

  private resolveSteeringWaiters(instructions: string[]): void {
    if (this.paused && instructions.length > 0) return;
    for (const waiter of this.steeringWaiters) {
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve([...instructions]);
    }
    this.steeringWaiters.clear();
  }
}

function parseControlMessage(line: string): HoneycrispControlMessage {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("Control messages require schemaVersion 1.");
  }
  const requestId = parseRequestId(parsed.requestId);
  if (parsed.type === "pause" || parsed.type === "resume" || parsed.type === "stop") {
    return { schemaVersion: 1, type: parsed.type, ...(requestId ? { requestId } : {}) };
  }
  if (parsed.type === "steer") {
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
    if (!instruction) throw new Error("Steering instructions cannot be empty.");
    const modelSelection = parsed.modelSelection === undefined ? undefined : parseModelSelection(parsed.modelSelection);
    return {
      schemaVersion: 1,
      type: "steer",
      instruction,
      ...(modelSelection ? { modelSelection } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
  if (parsed.type === "configure") {
    return {
      schemaVersion: 1,
      type: "configure",
      modelSelection: parseModelSelection(parsed.modelSelection),
      ...(requestId ? { requestId } : {}),
    };
  }
  throw new Error("Unknown Honeycrisp control message type.");
}

function parseRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new Error("Control requestId must be a non-empty string of at most 200 characters.");
  }
  return value.trim();
}

function requestIdFromLine(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.requestId !== "string") return undefined;
    const requestId = parsed.requestId.trim();
    return requestId && requestId.length <= 200 ? requestId : undefined;
  } catch {
    return undefined;
  }
}

function parseModelSelection(value: unknown): HoneycrispModelSelection {
  if (!isRecord(value)) throw new Error("Model selection must be an object.");
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const reasoningEffort = value.reasoningEffort;
  if (!provider || !model) throw new Error("Model selection requires provider and model.");
  if (
    reasoningEffort !== "off" && reasoningEffort !== "minimal" && reasoningEffort !== "low"
    && reasoningEffort !== "medium" && reasoningEffort !== "high" && reasoningEffort !== "xhigh"
    && reasoningEffort !== "max"
  ) throw new Error("Model selection has an unsupported reasoning effort.");
  return { provider, model, reasoningEffort };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
