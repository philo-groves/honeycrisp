import type { Readable } from "node:stream";

export type HoneycrispControlMessage =
  | { schemaVersion: 1; type: "pause" }
  | { schemaVersion: 1; type: "resume" }
  | { schemaVersion: 1; type: "stop" }
  | { schemaVersion: 1; type: "configure"; modelSelection: HoneycrispModelSelection }
  | { schemaVersion: 1; type: "steer"; instruction: string; modelSelection?: HoneycrispModelSelection };

export interface HoneycrispModelSelection {
  provider: string;
  model: string;
  reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type HoneycrispControlEvent =
  | { type: "pause" | "resume" | "stop" | "configure" | "steer"; accepted: true }
  | { type: "invalid"; accepted: false; error: string };

export class HoneycrispControlStream {
  private buffer = "";
  private paused = false;
  private readonly steeringInstructions: string[] = [];
  private modelSelection: HoneycrispModelSelection | undefined;
  private readonly resumeWaiters = new Set<() => void>();
  private readonly stopController = new AbortController();
  private started = false;

  public constructor(
    private readonly input: Readable,
    private readonly onEvent: (event: HoneycrispControlEvent) => void = () => undefined,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
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
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
    this.input.pause();
    this.buffer = "";
    this.paused = false;
    this.resolveResumeWaiters();
  }

  public async takeSteeringInstructions(): Promise<string[]> {
    await this.waitUntilResumed();
    return this.steeringInstructions.splice(0);
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
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    if (line.trim()) this.handleLine(line);
    this.paused = false;
    this.resolveResumeWaiters();
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
      } else if (message.type === "stop") {
        this.paused = false;
        this.resolveResumeWaiters();
        this.stopController.abort(new Error("Honeycrisp run stopped by the host."));
      } else if (message.type === "configure") {
        this.modelSelection = message.modelSelection;
      } else {
        if (message.modelSelection) this.modelSelection = message.modelSelection;
        this.steeringInstructions.push(message.instruction);
      }
      this.onEvent({ type: message.type, accepted: true });
    } catch (error) {
      this.onEvent({
        type: "invalid",
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
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
}

function parseControlMessage(line: string): HoneycrispControlMessage {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("Control messages require schemaVersion 1.");
  }
  if (parsed.type === "pause" || parsed.type === "resume" || parsed.type === "stop") {
    return { schemaVersion: 1, type: parsed.type };
  }
  if (parsed.type === "steer") {
    const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
    if (!instruction) throw new Error("Steering instructions cannot be empty.");
    const modelSelection = parsed.modelSelection === undefined ? undefined : parseModelSelection(parsed.modelSelection);
    return { schemaVersion: 1, type: "steer", instruction, ...(modelSelection ? { modelSelection } : {}) };
  }
  if (parsed.type === "configure") {
    return { schemaVersion: 1, type: "configure", modelSelection: parseModelSelection(parsed.modelSelection) };
  }
  throw new Error("Unknown Honeycrisp control message type.");
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
