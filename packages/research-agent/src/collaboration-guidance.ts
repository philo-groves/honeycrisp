import type { ResearchCollaborationConfig } from "./types.js";

export function createCollaborationSystemGuidance(
  config: ResearchCollaborationConfig,
  workflowId?: string,
): string {
  const enabled = config.providers.filter((provider) => provider.enabled);
  return [
    `Collaboration mode is ${config.mode} with ${config.intensity} intensity. Enabled collaborator routes: ${enabled.map((provider) => `${provider.provider}/${provider.model}`).join(", ") || "none"}.`,
    "For an explicit collaborator route, pass provider and model as separate fields with fork_turns set to none or a bounded number. With fork_turns=all, omit provider, model, and reasoning_effort so the child inherits the parent route.",
    `Concurrency limits: ${config.maxConcurrentRooms * config.maxMembersPerRoom} active subagent turns, ${config.maxConcurrentRooms} rooms, and ${config.maxMembersPerRoom} members per room.`,
    `For a room, ${config.independentFirstPass ? "require" : "do not require"} independent first-pass memos and use at most ${config.peerChallengeRounds} peer challenge round${config.peerChallengeRounds === 1 ? "" : "s"}.`,
    ...modeGuidance(config.mode, workflowId),
  ].join(" ");
}

function modeGuidance(
  mode: ResearchCollaborationConfig["mode"],
  workflowId: string | undefined,
): readonly string[] {
  if (mode === "adaptive") {
    return [
      "Adaptive mode makes collaboration available, not required. Delegate only when clean separation or independent review is likely to produce materially better evidence than continuing in the lead.",
      "At major evidence or subsystem transitions, continue solo when work is sequential or coordination cost outweighs the expected gain.",
      "Prefer followup_task when an existing agent's context matches new work, and avoid duplicate assignments.",
      ...(workflowId === "discovery" ? [
        "Discovery may benefit from parallel source-to-sink tracing, adjacent attack-surface exploration, variant analysis, or independent falsification; these are opportunities, not a delegation requirement.",
      ] : []),
      "Use a breakout room only for genuinely multi-agent coverage, disagreement, or review. Do not spawn merely to satisfy the mode.",
    ];
  }
  if (mode === "always") {
    return [
      "Use collaboration throughout every materially separable research stage that benefits from independent coverage or review.",
      "Use an ordinary subagent for single-worker delegation and a breakout room only when at least two subagents need to collaborate.",
    ];
  }
  return [
    "Do not initiate collaboration unless the user explicitly requests it. Continue the research in the lead session.",
  ];
}
