import { createId } from "./ids.js";
import type {
  ResearchActionClass,
  ResearchContextPacket,
  ResearchLoopPlan,
  ResearchMemoryControllerDecision,
  ResearchRequiredContextSection,
} from "./types.js";

export interface PlanResearchLoopInput {
  decision: ResearchMemoryControllerDecision;
}

export function planResearchLoop(
  input: PlanResearchLoopInput,
): ResearchLoopPlan {
  const { decision } = input;
  const packet = decision.contextPacket;
  const permittedToolClasses = getPermittedToolClasses(
    decision.actionClass,
    packet,
  );
  const requiredContext = createRequiredContext(packet);

  return {
    id: createId("loop"),
    rootGoalId: packet.activeGoal.id,
    subGoal: decision.subGoal,
    reason: decision.subGoal.rationale,
    requiredContext,
    permittedToolClasses,
    actionBudget: decision.toolBudget,
    expectedArtifacts: decision.subGoal.expectedArtifacts,
    completionGates: decision.completionGates,
    writebackRequirements: decision.writeback,
    contextPacket: packet,
    loopPrompt: renderLoopPrompt({
      packet,
      requiredContext,
      permittedToolClasses,
      decision,
    }),
  };
}

function getPermittedToolClasses(
  selectedAction: ResearchActionClass,
  packet: ResearchContextPacket,
): ResearchActionClass[] {
  const classes = new Set<ResearchActionClass>();

  if (selectedAction !== "respond" && selectedAction !== "ask_user") {
    classes.add(selectedAction);
  }

  for (const permission of packet.toolPermissions) {
    for (const actionClass of permission.actionClasses) {
      if (actionClass === selectedAction) {
        classes.add(actionClass);
      }
    }
  }

  return [...classes];
}

function createRequiredContext(
  packet: ResearchContextPacket,
): ResearchRequiredContextSection[] {
  return [
    {
      label: "goal_frame",
      description: "Root goal, gates, constraints, preferences, evidence requirements, and risk flags.",
      itemCount: 1,
      required: true,
    },
    {
      label: "active_sub_goal",
      description: "The bounded objective selected for this loop.",
      itemCount: 1,
      required: true,
    },
    {
      label: "direct_evidence",
      description: "Evidence records selected for this loop.",
      itemCount: packet.directEvidence.length,
      required: false,
    },
    {
      label: "prior_observations",
      description: "Relevant episodic observations selected from memory.",
      itemCount: packet.priorObservations.length,
      required: false,
    },
    {
      label: "candidate_procedures",
      description: "Applicable procedures or runbooks.",
      itemCount: packet.candidateProcedures.length,
      required: false,
    },
    {
      label: "current_hypotheses",
      description: "Hypotheses currently in play for this loop.",
      itemCount: packet.currentHypotheses.length,
      required: false,
    },
    {
      label: "contradictions",
      description: "Known contradictions or uncertainty warnings.",
      itemCount: packet.contradictions.length,
      required: false,
    },
    {
      label: "open_questions",
      description: "Questions the loop should reduce or preserve explicitly.",
      itemCount: packet.openQuestions.length,
      required: true,
    },
    {
      label: "user_commitments",
      description: "Scope constraints, preferences, and commitments to preserve.",
      itemCount: packet.userCommitments.length,
      required: true,
    },
    {
      label: "tool_permissions",
      description: "Tools and action classes permitted for this loop.",
      itemCount: packet.toolPermissions.length,
      required: false,
    },
  ];
}

function renderLoopPrompt(input: {
  packet: ResearchContextPacket;
  requiredContext: readonly ResearchRequiredContextSection[];
  permittedToolClasses: readonly ResearchActionClass[];
  decision: ResearchMemoryControllerDecision;
}): string {
  const { packet, requiredContext, permittedToolClasses, decision } = input;
  const artifacts = decision.subGoal.expectedArtifacts.join(", ") || "none";
  const toolClasses = permittedToolClasses.join(", ") || "none";
  const gates = decision.completionGates
    .map((gate) => `- ${gate.description}`)
    .join("\n");
  const contextManifest = requiredContext
    .map((section) => {
      const required = section.required ? "required" : "optional";
      return `- ${section.label}: ${section.itemCount} item(s), ${required}`;
    })
    .join("\n");

  return [
    `Root goal: ${packet.activeGoal.objective}`,
    `Loop sub-goal: ${decision.subGoal.objective}`,
    `Why this sub-goal matters: ${decision.subGoal.rationale}`,
    `Action class: ${decision.actionClass}`,
    `Permitted tool classes: ${toolClasses}`,
    `Action budget: ${JSON.stringify(decision.toolBudget)}`,
    `Expected artifacts: ${artifacts}`,
    "Completion gates:",
    gates,
    "Required context manifest:",
    contextManifest,
    "Writeback requirements:",
    decision.writeback.map((target) => `- ${target}`).join("\n"),
  ].join("\n");
}
