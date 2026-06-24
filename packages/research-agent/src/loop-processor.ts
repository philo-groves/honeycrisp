import { createId, nowIso } from "./ids.js";
import { createAuthenticatedModels } from "./auth.js";
import type {
  Context,
  Model,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ResearchCompletionGateResult,
  ResearchContextPacket,
  ResearchLoopContextSection,
  ResearchLoopExecutionInput,
  ResearchLoopExecutionOutput,
  ResearchLoopExecutor,
  ResearchLoopFollowUpRecommendation,
  ResearchLoopModelInput,
  ResearchLoopPlan,
  ResearchLoopProcessingResult,
} from "./types.js";

export interface ProcessResearchLoopInput {
  loopPlan: ResearchLoopPlan;
  executor?: ResearchLoopExecutor;
  signal?: AbortSignal;
}

export async function processResearchLoop(
  input: ProcessResearchLoopInput,
): Promise<ResearchLoopProcessingResult> {
  const startedAt = nowIso();
  const modelInput = compileLoopModelInput(input.loopPlan);
  const executor = input.executor ?? createDeterministicLoopExecutor();

  try {
    const output = await executor.execute({
      loopPlan: input.loopPlan,
      modelInput,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const completedAt = nowIso();

    return {
      id: createId("loopresult"),
      loopPlanId: input.loopPlan.id,
      subGoalId: input.loopPlan.subGoal.id,
      status: "complete",
      executorName: executor.name,
      startedAt,
      completedAt,
      modelInput,
      output,
      completionGateResults: evaluateCompletionGates(input.loopPlan, output),
      ...recommendFollowUp(input.loopPlan, output),
    };
  } catch (error) {
    const completedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const output: ResearchLoopExecutionOutput = {
      text: message,
      artifacts: [],
      evidenceRefs: [],
      claimRefs: [],
      followUpActions: ["Report the loop processing error before continuing."],
    };

    return {
      id: createId("loopresult"),
      loopPlanId: input.loopPlan.id,
      subGoalId: input.loopPlan.subGoal.id,
      status: "error",
      executorName: executor.name,
      startedAt,
      completedAt,
      modelInput,
      output,
      completionGateResults: evaluateCompletionGates(input.loopPlan, output),
      followUpRecommendation: "blocked",
      followUpRationale: "Loop processing raised an error.",
    };
  }
}

export function compileLoopModelInput(
  loopPlan: ResearchLoopPlan,
): ResearchLoopModelInput {
  return {
    loopPrompt: loopPlan.loopPrompt,
    contextSections: createLoopContextSections(loopPlan.contextPacket),
    permittedToolClasses: loopPlan.permittedToolClasses,
    toolBudget: loopPlan.actionBudget,
  };
}

export function createDeterministicLoopExecutor(): ResearchLoopExecutor {
  return {
    name: "deterministic-first-run",
    async execute(input: ResearchLoopExecutionInput) {
      const { loopPlan } = input;
      const text = renderDeterministicLoopOutput(loopPlan);

      return {
        text,
        artifacts: [...loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: createFollowUpActions(loopPlan),
        raw: {
          mode: "deterministic",
          note: "No model call was made.",
        },
      };
    },
  };
}

export interface CreatePiLoopExecutorOptions {
  provider: string;
  model: string;
  authFile?: string;
  maxTokens?: number;
  reasoning?: SimpleStreamOptions["reasoning"];
  models?: Pick<Models, "getModel" | "completeSimple">;
}

export function createPiLoopExecutor(
  options: CreatePiLoopExecutorOptions,
): ResearchLoopExecutor {
  return {
    name: `pi:${options.provider}/${options.model}`,
    async execute(input: ResearchLoopExecutionInput) {
      const models =
        options.models ??
        createAuthenticatedModels(
          options.authFile ? { authFile: options.authFile } : {},
        );
      const model = models.getModel(options.provider, options.model);
      if (!model) {
        throw new Error(
          `Unknown model ${options.provider}/${options.model}`,
        );
      }

      const context = createPiContext(input.modelInput);
      const streamOptions = createPiStreamOptions(options, input.signal);
      const message = await models.completeSimple(model, context, streamOptions);
      const text = extractAssistantText(message.content);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage ?? `Model stopped: ${message.stopReason}`);
      }

      return {
        text,
        artifacts: [...input.loopPlan.expectedArtifacts],
        evidenceRefs: [],
        claimRefs: [],
        followUpActions: [
          "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
        ],
        raw: {
          provider: model.provider,
          model: model.id,
          api: model.api,
          stopReason: message.stopReason,
          responseId: message.responseId,
          usage: message.usage,
        },
      };
    },
  };
}

function createLoopContextSections(
  packet: ResearchContextPacket,
): ResearchLoopContextSection[] {
  return [
    {
      label: "goal_frame",
      required: true,
      content: packet.goalFrame,
    },
    {
      label: "active_sub_goal",
      required: true,
      content: packet.activeSubGoal,
    },
    {
      label: "direct_evidence",
      required: false,
      content: packet.directEvidence,
    },
    {
      label: "prior_observations",
      required: false,
      content: packet.priorObservations,
    },
    {
      label: "candidate_procedures",
      required: false,
      content: packet.candidateProcedures,
    },
    {
      label: "current_hypotheses",
      required: false,
      content: packet.currentHypotheses,
    },
    {
      label: "contradictions",
      required: false,
      content: packet.contradictions,
    },
    {
      label: "open_questions",
      required: true,
      content: packet.openQuestions,
    },
    {
      label: "user_commitments",
      required: true,
      content: packet.userCommitments,
    },
    {
      label: "tool_permissions",
      required: false,
      content: packet.toolPermissions,
    },
  ];
}

function createPiContext(modelInput: ResearchLoopModelInput): Context {
  return {
    systemPrompt: [
      "You are Honeycrisp, a goal-oriented research agent built on Pi.",
      "Execute only the current bounded loop. Preserve evidence, inference, hypotheses, uncertainty, and user commitments as distinct categories.",
      "Do not claim that files were inspected unless evidence is present in the supplied context.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          "Execute this planned research loop.",
          "",
          "## Loop Prompt",
          modelInput.loopPrompt,
          "",
          "## Labeled Context Sections",
          ...modelInput.contextSections.map(
            (section) =>
              `### ${section.label} (${section.required ? "required" : "optional"})\n${formatContextContent(section.content)}`,
          ),
          "",
          "## Output Shape",
          "Return concise markdown with: Result, Evidence Used, Assumptions, Open Questions, Suggested Next Step.",
        ].join("\n"),
      },
    ],
  };
}

function createPiStreamOptions(
  options: CreatePiLoopExecutorOptions,
  signal: AbortSignal | undefined,
): SimpleStreamOptions {
  return {
    ...(typeof options.maxTokens === "number"
      ? { maxTokens: options.maxTokens }
      : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(signal ? { signal } : {}),
  };
}

function formatContextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content, null, 2);
}

function extractAssistantText(
  content: Awaited<ReturnType<Models["completeSimple"]>>["content"],
): string {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function renderDeterministicLoopOutput(loopPlan: ResearchLoopPlan): string {
  const lines = [
    `Sub-goal: ${loopPlan.subGoal.objective}`,
    "",
    "Initial loop result:",
    `- Action class: ${loopPlan.subGoal.actionClass}`,
    `- Expected artifacts: ${loopPlan.expectedArtifacts.join(", ") || "none"}`,
    `- Tool calls available in this loop: ${loopPlan.actionBudget.maxToolCalls}`,
    "",
    "Evidence checklist:",
    ...loopPlan.contextPacket.openQuestions.map((question) => `- ${question}`),
  ];

  if (loopPlan.contextPacket.userCommitments.length > 0) {
    lines.push("", "User commitments to preserve:");
    lines.push(
      ...loopPlan.contextPacket.userCommitments.map(
        (commitment) => `- ${commitment}`,
      ),
    );
  }

  return lines.join("\n");
}

function createFollowUpActions(loopPlan: ResearchLoopPlan): string[] {
  if (loopPlan.subGoal.actionClass === "ask_user") {
    return ["Ask the user for the missing scope or constraints."];
  }

  if (loopPlan.permittedToolClasses.length === 0) {
    return ["Respond with the initial plan, or register tools before continuing."];
  }

  return [
    "Ask the memory controller whether to continue this branch, create a sibling, refine the goal tree, or respond.",
  ];
}

function evaluateCompletionGates(
  loopPlan: ResearchLoopPlan,
  output: ResearchLoopExecutionOutput,
): ResearchCompletionGateResult[] {
  const hasOutput = output.text.trim().length > 0;

  return loopPlan.completionGates.map((gate) => ({
    gateId: gate.id,
    description: gate.description,
    satisfied: hasOutput,
    ...(hasOutput ? { evidence: "loop output text" } : {}),
  }));
}

function recommendFollowUp(
  loopPlan: ResearchLoopPlan,
  output: ResearchLoopExecutionOutput,
): {
  followUpRecommendation: ResearchLoopFollowUpRecommendation;
  followUpRationale: string;
} {
  if (loopPlan.subGoal.actionClass === "ask_user") {
    return {
      followUpRecommendation: "respond",
      followUpRationale:
        "The loop result is a user-facing clarification request.",
    };
  }

  if (output.evidenceRefs.length > 0 || output.claimRefs.length > 0) {
    return {
      followUpRecommendation: "continue_branch",
      followUpRationale:
        "The loop produced memory references that can drive another bounded step.",
    };
  }

  return {
    followUpRecommendation: "respond",
    followUpRationale:
      "The deterministic first-loop processor produced a bounded plan but no new evidence or claims.",
  };
}
