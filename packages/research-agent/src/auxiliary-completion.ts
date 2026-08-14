import type { AssistantMessage, Models, ThinkingLevel } from "@earendil-works/pi-ai";
import { createAuthenticatedModels } from "./auth.js";
import { completeClaudeAgentText } from "./claude-agent-executor.js";
import {
  ProviderAuthenticationRouter,
  type ProviderAuthenticationPreferences,
} from "./auth-routing.js";

export interface CompleteAuxiliaryTextOptions {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  effort?: ThinkingLevel | "off";
  maxTokens?: number;
  cwd?: string;
  signal?: AbortSignal;
  authenticationPreferences?: ProviderAuthenticationPreferences;
  models?: Pick<Models, "getModel" | "completeSimple">;
  completeClaudeText?: typeof completeClaudeAgentText;
}

export interface AuxiliaryTextCompletion {
  text: string;
  usage: Record<string, unknown>;
}

/**
 * Completes a bounded host-side support task without exposing research tools.
 * Anthropic stays on the official Agent SDK/Claude CLI path; other providers
 * use Pi with the same authentication preference and fallback routing as runs.
 */
export async function completeAuxiliaryText(
  options: CompleteAuxiliaryTextOptions,
): Promise<AuxiliaryTextCompletion> {
  if (options.provider === "anthropic") {
    const completion = await (options.completeClaudeText ?? completeClaudeAgentText)({
      model: options.model,
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      reasoning: options.effort ?? "medium",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.authenticationPreferences
        ? { authenticationPreferences: options.authenticationPreferences }
        : {}),
    });
    return completion;
  }

  const authenticationRouter = new ProviderAuthenticationRouter(options.authenticationPreferences);
  const models = options.models
    ?? createAuthenticatedModels({ authContext: authenticationRouter.authContext() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const model = authenticationRouter.routePiModel(models, options.provider, options.model);
    if (!model) throw new Error(`Unknown auxiliary model ${options.provider}/${options.model}`);
    const apiKey = authenticationRouter.requestApiKey(options.provider);
    let response: AssistantMessage;
    const reasoning = options.effort === "off" ? undefined : options.effort ?? "medium";
    try {
      response = await models.completeSimple(
        model,
        {
          systemPrompt: options.systemPrompt,
          messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
        },
        {
          ...(reasoning ? { reasoning } : {}),
          maxTokens: options.maxTokens ?? 8_192,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (authenticationRouter.tryFallback(options.provider, message)) continue;
      throw error;
    }
    if (response.stopReason === "error") {
      if (authenticationRouter.tryFallback(options.provider, response.errorMessage ?? "")) continue;
      throw new Error(response.errorMessage ?? "Auxiliary model completion failed.");
    }
    if (response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? "Auxiliary model completion was aborted.");
    }
    const text = response.content
      .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Auxiliary model returned no text.");
    return { text, usage: { ...response.usage } };
  }
  throw new Error("No authentication source could complete the auxiliary model request.");
}
