import { createId, nowIso } from "./ids.js";
import type {
  ResearchCompletionGate,
  ResearchGoalFrame,
  ResearchGoalFrameOptions,
  ResearchGoalNode,
  ResearchPromptFrame,
} from "./types.js";
import { parseResearchPrompt } from "./prompt.js";

export function createResearchGoalFrame(
  prompt: string,
  options: ResearchGoalFrameOptions = {},
): ResearchGoalFrame {
  const promptFrame = parseResearchPrompt(prompt, options);

  const timestamp = nowIso();
  const root: ResearchGoalNode = {
    id: createId("goal"),
    status: "active",
    objective: promptFrame.rootGoal,
    rationale: "Root research goal created from the user prompt.",
    completionGates: createGates(promptFrame, "success"),
    stopGates: createGates(promptFrame, "stop"),
    memoryRefs: [],
    expectedArtifacts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    prompt: promptFrame,
    root,
    nodes: [root],
    scopeConstraints: promptFrame.scopeConstraints,
    evidenceRequirements: promptFrame.evidenceRequirements,
    riskFlags: promptFrame.initialRiskFlags,
    userPreferences: promptFrame.userPreferences,
  };
}

function createGates(
  promptFrame: ResearchPromptFrame,
  polarity: "success" | "stop",
): ResearchCompletionGate[] {
  const descriptions =
    polarity === "success"
      ? promptFrame.successGates
      : promptFrame.failureOrStopGates;

  return descriptions.map((description) => ({
    id: createId("gate"),
    description,
    polarity,
  }));
}
