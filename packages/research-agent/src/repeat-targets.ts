import { goalObjectiveNeedsFreshEvidence } from "./goal-evidence-policy.js";
import type { ResearchContextPacket } from "./types.js";

export interface ResearchRepeatAvoidanceTarget {
  path: string;
  sourceMemoryRefId: string;
  reason: string;
  summary: string;
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".m",
  ".mm",
  ".rs",
  ".go",
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".java",
  ".swift",
  ".rb",
  ".php",
  ".sh",
  ".zsh",
]);

const SOURCE_PATH_PATTERN =
  /(?:\/[A-Za-z0-9._@%+=:,~-]+(?:\/[A-Za-z0-9._@%+=:,~-]+)+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)/g;

export function createRepeatAvoidanceTargets(
  packet: ResearchContextPacket,
): ResearchRepeatAvoidanceTarget[] {
  if (
    packet.activeSubGoal.actionClass !== "inspect" ||
    !goalObjectiveNeedsFreshEvidence(packet.activeGoal.objective)
  ) {
    return [];
  }

  const targets: ResearchRepeatAvoidanceTarget[] = [];
  const seen = new Set<string>();

  for (const ref of packet.priorObservations) {
    const summary = ref.summary ?? "";
    if (!summaryIndicatesPriorScan(summary)) {
      continue;
    }
    for (const path of extractSourcePaths(summary)) {
      const key = path.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      targets.push({
        path,
        sourceMemoryRefId: ref.id,
        reason:
          "Prior memory indicates this source path was already selected, read, scanned, or exhausted in an earlier goal.",
        summary,
      });
    }
  }

  return targets.slice(0, 20);
}

function summaryIndicatesPriorScan(summary: string): boolean {
  return /\b(prior-goal|selected|read|fully read|scanned|analy[sz]ed|functions present|run out|exhausted|no confirmed bug)\b/i.test(
    summary,
  );
}

function extractSourcePaths(summary: string): string[] {
  const paths: string[] = [];
  const matches = summary.matchAll(SOURCE_PATH_PATTERN);

  for (const match of matches) {
    const path = normalizePathCandidate(match[0] ?? "");
    if (path && looksLikeSourcePath(path)) {
      paths.push(path);
    }
  }

  return paths;
}

function normalizePathCandidate(path: string): string {
  return path.trim().replace(/[),.;:]+$/u, "");
}

function looksLikeSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of SOURCE_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }

  return false;
}
