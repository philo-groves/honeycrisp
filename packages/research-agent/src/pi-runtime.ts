import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentOptions,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import {
  appendResearchAgentInstructions,
  createResearchSystemPrompt,
} from "./system-prompt.js";
import type { ResearchAgentInstructions } from "./types.js";
import type { ResearchProfile } from "./research-profile.js";

export interface CreateResearchPiAgentOptions {
  model: Model<any>;
  models: Pick<Models, "streamSimple">;
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  agentOptions?: Omit<AgentOptions, "initialState" | "streamFn">;
  agentInstructions?: ResearchAgentInstructions;
  researchProfile?: ResearchProfile;
  workflowId?: string;
}

export function createResearchPiAgent(
  options: CreateResearchPiAgentOptions,
): Agent {
  const streamFn = options.models.streamSimple.bind(options.models) as StreamFn;

  return new Agent({
    ...options.agentOptions,
    initialState: {
      model: options.model,
      systemPrompt: options.systemPrompt !== undefined
        ? appendResearchAgentInstructions(options.systemPrompt, options.agentInstructions)
        : createResearchSystemPrompt({
            hasTools: (options.tools?.length ?? 0) > 0,
            ...(options.researchProfile ? { researchProfile: options.researchProfile } : {}),
            ...(options.workflowId ? { workflowId: options.workflowId } : {}),
            ...(options.agentInstructions ? { agentInstructions: options.agentInstructions } : {}),
          }),
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: [...(options.tools ?? [])],
    },
    streamFn,
  });
}
