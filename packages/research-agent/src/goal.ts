import { createId, nowIso } from "./ids.js";
import type {
  ResearchCompletionGate,
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchGoalNode,
} from "./types.js";

export function createResearchGoalFrame(
  prompt: string,
  options: ResearchGoalFrameOptions = {},
): ResearchGoalFrame {
  const objective = prompt.trim();
  if (objective.length === 0) {
    throw new Error("A research prompt is required.");
  }

  const timestamp = nowIso();
  const completionGate: ResearchCompletionGate = {
    id: createId("gate"),
    description: "The response or artifact directly addresses the research goal.",
    polarity: "success",
  };
  const stopGate: ResearchCompletionGate = {
    id: createId("gate"),
    description:
      "The goal is blocked by missing scope, unavailable evidence, or unsafe assumptions.",
    polarity: "stop",
  };
  const root: ResearchGoalNode = {
    id: createId("goal"),
    status: "active",
    objective,
    rationale: "Root research goal created from the user prompt.",
    completionGates: [completionGate],
    stopGates: [stopGate],
    memoryRefs: [],
    expectedArtifacts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    root,
    nodes: [root],
    constraints: [...(options.constraints ?? [])],
    evidenceRequirements: [...(options.evidenceRequirements ?? [])],
    riskFlags: [...(options.riskFlags ?? [])],
    userPreferences: [...(options.userPreferences ?? [])],
  };
}
