import type { ResearchCollaborationConfig } from "./types.js";

export function createCollaborationSystemGuidance(
  config: ResearchCollaborationConfig,
  workflowId?: string,
): string {
  const enabled = config.providers.filter((provider) => provider.enabled);
  return [
    `Collaboration mode is ${config.mode} with ${config.intensity} intensity. Enabled collaborator routes: ${enabled.map((provider) => `${provider.provider}/${provider.model}`).join(", ") || "none"}.`,
    "For an explicit collaborator route, pass provider and model as separate fields with fork_turns set to none or a bounded number. With fork_turns=all, omit provider, model, and reasoning_effort so the child inherits the parent route.",
    `Use no more than ${config.maxConcurrentRooms} concurrent rooms, ${config.maxMembersPerRoom} members per room, and ${config.maxTotalInvocations} collaborator invocations across the session.`,
    "A single delegated worker is a normal subagent. Use create_room to form every breakout room atomically with at least two role-defined members.",
    "The lead agent is not a breakout-room member. If the lead perspective is needed in a room, spawn a separate subagent on the lead provider/model to represent it; use partial or no inheritance when explicit routing overrides are required.",
    config.independentFirstPass
      ? "Require each room member to produce an independent evidence memo before peer messages or convergence."
      : "Independent first passes are optional for this session.",
    `After independent work, use at most ${config.peerChallengeRounds} peer challenge round${config.peerChallengeRounds === 1 ? "" : "s"} per room.`,
    ...modeGuidance(config.mode, workflowId),
  ].join(" ");
}

function modeGuidance(
  mode: ResearchCollaborationConfig["mode"],
  workflowId: string | undefined,
): readonly string[] {
  if (mode === "adaptive") {
    return [
      "Adaptive collaboration remains available throughout the session; do not treat initial decomposition as the only delegation point.",
      "Reassess whether collaboration would materially improve coverage or confidence whenever evidence changes the plan, a hypothesis is confirmed or refuted, work crosses a subsystem or trust boundary, proving or verification begins, or final synthesis approaches.",
      "At each such transition, choose deliberately among following up a relevant existing subagent, spawning one bounded independent subagent, opening a breakout room for genuinely multi-agent work, or continuing in the lead alone.",
      "Use list_agents when needed to review active and reusable agents. Prefer followup_task when an existing agent's context matches the new work, and avoid duplicate assignments.",
      ...(workflowId === "discovery" ? [
        "During discovery, actively use ordinary subagents beyond the opening phase for parallel source-to-sink tracing, adjacent attack-surface exploration, historical or variant analysis, and independent falsification of promising hypotheses.",
        "A refuted lead or newly exposed primitive is a reason to reconsider delegation across the surrounding attack surface, not a reason to stop collaborating.",
      ] : []),
      "Create breakout rooms only for decomposable coverage, meaningful disagreement, evidence review, or proving work. Keep tightly sequential work in the lead session, and do not spawn merely to satisfy the mode.",
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
