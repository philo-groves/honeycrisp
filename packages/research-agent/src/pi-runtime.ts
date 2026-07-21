import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { createResearchSystemPrompt } from "./system-prompt.js";

export interface CreateResearchPiAgentOptions {
  model: Model<any>;
  models: Pick<Models, "streamSimple">;
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  agentOptions?: Omit<AgentOptions, "initialState" | "streamFn">;
}

export function createResearchPiAgent(
  options: CreateResearchPiAgentOptions,
): Agent {
  const streamFn = options.models.streamSimple.bind(options.models) as StreamFn;

  return new Agent({
    ...options.agentOptions,
    initialState: {
      model: options.model,
      systemPrompt: options.systemPrompt ?? createResearchSystemPrompt({
        hasTools: (options.tools?.length ?? 0) > 0,
      }),
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: [...(options.tools ?? [])],
    },
    streamFn,
  });
}
