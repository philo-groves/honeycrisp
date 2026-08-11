import type {
  AssistantMessage,
  Models,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { createAuthenticatedModels } from "./auth.js";
import type { ResearchProfile } from "./research-profile.js";

export interface GenerateResearchSessionTitleOptions {
  provider: string;
  model: string;
  prompt: string;
  effort?: ThinkingLevel;
  timeoutMs?: number;
  signal?: AbortSignal;
  models?: Pick<Models, "getModel" | "completeSimple">;
  researchProfile?: Pick<ResearchProfile, "name" | "workspace" | "presentation">;
}

const SECURITY_TITLE_SYSTEM_PROMPT = [
  "Create a short title for an authorized security research session from the user's research prompt.",
  "Return only a plain-text title of 3 to 6 words.",
  "Preserve important target, component, and feature names.",
  "Do not use quotes, markdown, a trailing period, or generic wording such as Security Research.",
].join(" ");
const DEFAULT_TITLE_TIMEOUT_MS = 30_000;
const MAX_TITLE_PROMPT_CHARS = 16_000;
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 6;

export async function generateResearchSessionTitle(
  options: GenerateResearchSessionTitleOptions,
): Promise<string> {
  const models = options.models ?? createAuthenticatedModels();
  const model = models.getModel(options.provider, options.model);
  if (!model) {
    throw new Error(`Unknown title model ${options.provider}/${options.model}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS,
  );
  timeout.unref();

  try {
    const systemPrompt = options.researchProfile
      ? [
          `Create a short title for a ${options.researchProfile.name} ${options.researchProfile.presentation.sessionLabel.toLowerCase()} from the user's research prompt.`,
          "Return only a plain-text title of 3 to 6 words.",
          `Preserve important ${options.researchProfile.workspace.subjectNoun.toLowerCase()}, component, topic, and feature names.`,
          `Do not use quotes, markdown, a trailing period, or generic wording such as ${options.researchProfile.name}.`,
        ].join(" ")
      : SECURITY_TITLE_SYSTEM_PROMPT;
    const response = await models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: boundedPrompt(options.prompt),
            timestamp: Date.now(),
          },
        ],
      },
      {
        reasoning: options.effort ?? "medium",
        maxTokens: 128,
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "Title model did not return a title.");
    }
    const title = normalizeResearchSessionTitle(assistantText(response));
    if (!title) throw new Error("Title model returned an empty title.");
    return title;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeResearchSessionTitle(value: string): string {
  const firstLine = value
    .replace(/```(?:text)?/gi, "")
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";

  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:title|session title)\s*:\s*/i, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  return cleaned
    .split(/\s+/)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

function boundedPrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (normalized.length <= MAX_TITLE_PROMPT_CHARS) return normalized;
  const half = Math.floor(MAX_TITLE_PROMPT_CHARS / 2);
  return `${normalized.slice(0, half)}\n\n[Prompt middle omitted]\n\n${normalized.slice(-half)}`;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}
