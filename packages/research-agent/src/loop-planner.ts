import { createId } from "./ids.js";
import type {
  ResearchActionClass,
  ResearchContextPacket,
  ResearchLoopPlan,
  ResearchMemoryControllerDecision,
  ResearchRequiredContextSection,
  ResearchSkippedToolAction,
  ResearchToolAction,
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
  const plannedTools = selectPlannedToolActions(
    decision.candidateToolActions,
    decision.skippedToolActions,
    permittedToolClasses,
    decision.toolBudget.maxToolCalls,
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
    ...(packet.governancePolicy
      ? { governancePolicy: packet.governancePolicy }
      : {}),
    candidateToolActions: plannedTools.candidateToolActions,
    skippedToolActions: plannedTools.skippedToolActions,
    expectedArtifacts: decision.subGoal.expectedArtifacts,
    completionGates: decision.completionGates,
    writebackRequirements: decision.writeback,
    contextPacket: packet,
    loopPrompt: renderLoopPrompt({
      packet,
      requiredContext,
      permittedToolClasses,
      candidateToolActions: plannedTools.candidateToolActions,
      skippedToolActions: plannedTools.skippedToolActions,
      decision,
    }),
  };
}

function selectPlannedToolActions(
  candidateActions: readonly ResearchToolAction[],
  skippedActions: readonly ResearchSkippedToolAction[],
  permittedToolClasses: readonly ResearchActionClass[],
  maxToolCalls: number,
): {
  candidateToolActions: ResearchToolAction[];
  skippedToolActions: ResearchSkippedToolAction[];
} {
  const accepted: ResearchToolAction[] = [];
  const skipped: ResearchSkippedToolAction[] = [...skippedActions];

  for (const action of candidateActions) {
    if (!permittedToolClasses.includes(action.actionClass)) {
      skipped.push({
        action,
        code: "action_class_not_permitted",
        reason: `Action class ${action.actionClass} is not permitted for this loop.`,
      });
      continue;
    }

    if (accepted.length >= maxToolCalls) {
      skipped.push({
        action,
        code: "tool_budget_exhausted",
        reason: `Tool budget permits ${maxToolCalls} call(s) for this loop.`,
      });
      continue;
    }

    accepted.push(action);
  }

  return {
    candidateToolActions: accepted,
    skippedToolActions: skipped,
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
      label: "selected_skills",
      description: "Skill instructions selected for domain alignment.",
      itemCount: packet.selectedSkills.length,
      required: false,
    },
    {
      label: "tool_permissions",
      description: "Tools and action classes permitted for this loop.",
      itemCount: packet.toolPermissions.length,
      required: false,
    },
    {
      label: "candidate_tool_actions",
      description: "Controller-proposed tool actions selected for this loop.",
      itemCount: packet.candidateToolActions.length,
      required: false,
    },
    {
      label: "skipped_tool_actions",
      description: "Controller-proposed tool actions skipped with explicit reasons.",
      itemCount: packet.skippedToolActions.length,
      required: false,
    },
  ];
}

function renderLoopPrompt(input: {
  packet: ResearchContextPacket;
  requiredContext: readonly ResearchRequiredContextSection[];
  permittedToolClasses: readonly ResearchActionClass[];
  candidateToolActions: readonly ResearchToolAction[];
  skippedToolActions: readonly ResearchSkippedToolAction[];
  decision: ResearchMemoryControllerDecision;
}): string {
  const {
    packet,
    requiredContext,
    permittedToolClasses,
    candidateToolActions,
    skippedToolActions,
    decision,
  } = input;
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
    "Selected skills:",
    formatSelectedSkills(packet.selectedSkills),
    "Controller-proposed tool actions:",
    formatCandidateToolActions(candidateToolActions),
    "Skipped candidate tool actions:",
    formatSkippedToolActions(skippedToolActions),
    `Expected artifacts: ${artifacts}`,
    "Completion gates:",
    gates,
    "Required context manifest:",
    contextManifest,
    "Writeback requirements:",
    decision.writeback.map((target) => `- ${target}`).join("\n"),
  ].join("\n");
}

function formatSelectedSkills(
  skills: ResearchContextPacket["selectedSkills"],
): string {
  if (skills.length === 0) {
    return "- none";
  }

  return skills
    .map(
      (skill) =>
        `- ${skill.id}${skill.version ? `@${skill.version}` : ""}: ${skill.description}`,
    )
    .join("\n");
}

function formatCandidateToolActions(
  actions: readonly ResearchToolAction[],
): string {
  if (actions.length === 0) {
    return "- none";
  }

  return actions
    .map(
      (action) =>
        `- ${action.id}: ${action.toolName} (${action.actionClass}) ${JSON.stringify(action.input)}`,
    )
    .join("\n");
}

function formatSkippedToolActions(
  actions: readonly ResearchSkippedToolAction[],
): string {
  if (actions.length === 0) {
    return "- none";
  }

  return actions
    .map((skipped) => `- ${skipped.action.id}: ${skipped.code} - ${skipped.reason}`)
    .join("\n");
}
