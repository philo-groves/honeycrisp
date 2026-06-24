import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";

export interface CreateResearchPiAgentOptions {
  model: Model<any>;
  models: Pick<Models, "streamSimple">;
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  agentOptions?: Omit<AgentOptions, "initialState" | "streamFn">;
}

export function createResearchSystemPrompt(): string {
  return [
    "You are Honeycrisp, a goal-oriented research agent built on Pi.",
    "Keep evidence, inference, hypotheses, and user commitments distinct.",
    "Prefer bounded research sub-goals with explicit completion gates.",
  ].join("\n");
}

export function createResearchPiAgent(
  options: CreateResearchPiAgentOptions,
): Agent {
  const streamFn = options.models.streamSimple.bind(options.models) as StreamFn;

  return new Agent({
    ...options.agentOptions,
    initialState: {
      model: options.model,
      systemPrompt: options.systemPrompt ?? createResearchSystemPrompt(),
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: [...(options.tools ?? [])],
    },
    streamFn,
  });
}
