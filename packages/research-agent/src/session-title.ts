import {
  isRetryableAssistantError,
  type AssistantMessage,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { createAuthenticatedModels } from "./auth.js";
import { completeClaudeAgentText } from "./claude-agent-executor.js";
import {
  ProviderAuthenticationRouter,
  type ProviderAuthenticationPreferences,
} from "./auth-routing.js";
import type { ResearchProfile } from "./research-profile.js";

/*
 * Title generation is deliberately independent from the main agent turn. Keep
 * its retry budget small so a provider incident cannot delay session startup.
 */
const TITLE_RETRY_DELAYS_MS = [250, 750] as const;

export interface GenerateResearchSessionTitleOptions {
  provider: string;
  model: string;
  prompt: string;
  effort?: ThinkingLevel;
  timeoutMs?: number;
  signal?: AbortSignal;
  models?: Pick<Models, "getModel" | "completeSimple">;
  completeClaudeText?: typeof completeClaudeAgentText;
  researchProfile?: Pick<ResearchProfile, "name" | "workspace" | "presentation">;
  authenticationPreferences?: ProviderAuthenticationPreferences;
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
  const useOfficialClaude = options.provider === "anthropic";
  const authenticationRouter = new ProviderAuthenticationRouter(options.authenticationPreferences);
  const models = useOfficialClaude
    ? undefined
    : options.models ?? createAuthenticatedModels({ authContext: authenticationRouter.authContext() });
  let model = useOfficialClaude
    ? undefined
    : authenticationRouter.routePiModel(models!, options.provider, options.model);
  if (!useOfficialClaude && !model) throw new Error(`Unknown title model ${options.provider}/${options.model}`);

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
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let response: AssistantMessage | undefined;
    for (let attempt = 0; attempt <= TITLE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        if (useOfficialClaude) {
          const completion = await (options.completeClaudeText ?? completeClaudeAgentText)({
            model: options.model,
            systemPrompt,
            prompt: boundedPrompt(options.prompt),
            reasoning: options.effort ?? "medium",
            signal,
            ...(options.authenticationPreferences ? { authenticationPreferences: options.authenticationPreferences } : {}),
          });
          const title = normalizeResearchSessionTitle(completion.text);
          if (!title) throw new Error("Title model returned an empty title.");
          return title;
        }
        const apiKey = authenticationRouter.requestApiKey(options.provider);
        response = await models!.completeSimple(
          model!,
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
            signal,
            ...(apiKey ? { apiKey } : {}),
          },
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!useOfficialClaude && authenticationRouter.tryFallback(options.provider, errorMessage)) {
          model = authenticationRouter.routePiModel(models!, options.provider, options.model);
          if (!model) throw new Error("Alternate authentication source does not support the title model.");
          continue;
        }
        if (
          attempt >= TITLE_RETRY_DELAYS_MS.length
          || signal.aborted
          || !isRetryableTitleErrorMessage(errorMessage)
          || !(await retryDelay(TITLE_RETRY_DELAYS_MS[attempt] ?? 0, signal))
        ) {
          throw error;
        }
        continue;
      }

      if (response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? "Title generation was aborted.");
      }
      if (response.stopReason !== "error") break;
      if (authenticationRouter.tryFallback(options.provider, response.errorMessage ?? "")) {
        model = authenticationRouter.routePiModel(models!, options.provider, options.model);
        if (!model) throw new Error("Alternate authentication source does not support the title model.");
        continue;
      }
      if (
        attempt >= TITLE_RETRY_DELAYS_MS.length
        || !isRetryableTitleError(response)
        || !(await retryDelay(TITLE_RETRY_DELAYS_MS[attempt] ?? 0, signal))
      ) {
        throw new Error(response.errorMessage ?? "Title model did not return a title.");
      }
    }
    if (!response || response.stopReason === "error") {
      throw new Error(response?.errorMessage ?? "Title model did not return a title.");
    }
    const title = normalizeResearchSessionTitle(assistantText(response));
    if (!title) throw new Error("Title model returned an empty title.");
    return title;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableTitleError(message: AssistantMessage): boolean {
  return isRetryableAssistantError(message)
    || isRetryableTitleErrorMessage(message.errorMessage ?? "");
}

function isRetryableTitleErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("overloaded")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("unexpected server error")
    || normalized.includes("internal server error")
    || normalized.includes("server_error")
    || normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("connection reset");
}

function retryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
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
