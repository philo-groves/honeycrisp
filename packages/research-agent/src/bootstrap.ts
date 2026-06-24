import { createResearchGoalFrame } from "./goal.js";
import type {
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchMemoryStoreKind,
} from "./types.js";

export interface BootstrapResearchRunInput extends ResearchGoalFrameOptions {
  prompt: string;
}

export interface BootstrapResearchRunResult {
  goalFrame: ResearchGoalFrame;
  piBase: {
    agentCorePackage: "@earendil-works/pi-agent-core";
    aiPackage: "@earendil-works/pi-ai";
  };
  writeback: readonly ResearchMemoryStoreKind[];
  response: string;
}

export function bootstrapResearchRun(
  input: BootstrapResearchRunInput,
): BootstrapResearchRunResult {
  const goalFrame = createResearchGoalFrame(input.prompt, input);
  const response = [
    `Honeycrisp initialized a research goal: ${goalFrame.root.objective}`,
    "Runtime base: @earendil-works/pi-agent-core with @earendil-works/pi-ai.",
    "Research memory, storage, and domain-specific tools will be layered around Pi instead of replacing it.",
  ].join("\n");

  return {
    goalFrame,
    piBase: {
      agentCorePackage: "@earendil-works/pi-agent-core",
      aiPackage: "@earendil-works/pi-ai",
    },
    writeback: ["event", "working"],
    response,
  };
}
