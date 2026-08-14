import assert from "node:assert/strict";
import test from "node:test";
import { completeAuxiliaryText } from "../packages/research-agent/dist/index.js";

test("auxiliary completions use the assigned non-OpenAI provider and model", async () => {
  const calls = [];
  const completion = await completeAuxiliaryText({
    provider: "xai",
    model: "grok-4.6",
    effort: "high",
    systemPrompt: "Return the requested synthesis.",
    prompt: "Synthesize the evidence.",
    models: {
      getModel(provider, model) {
        calls.push({ kind: "model", provider, model });
        return { provider, id: model };
      },
      async completeSimple(model, context, options) {
        calls.push({ kind: "complete", model, context, options });
        return {
          role: "assistant",
          content: [{ type: "text", text: "Provider-routed result" }],
          api: "fixture",
          provider: model.provider,
          model: model.id,
          usage: { input: 10, output: 3 },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
  });

  assert.equal(completion.text, "Provider-routed result");
  assert.deepEqual(calls[0], { kind: "model", provider: "xai", model: "grok-4.6" });
  assert.equal(calls[1]?.options.reasoning, "high");
});

test("Anthropic auxiliary completions stay on the official Claude completion boundary", async () => {
  const calls = [];
  const completion = await completeAuxiliaryText({
    provider: "anthropic",
    model: "claude-opus-5",
    systemPrompt: "Return the requested synthesis.",
    prompt: "Synthesize the evidence.",
    async completeClaudeText(options) {
      calls.push(options);
      return { text: "Claude-routed result", usage: { inputTokens: 10 } };
    },
  });

  assert.equal(completion.text, "Claude-routed result");
  assert.equal(calls[0]?.model, "claude-opus-5");
  assert.equal(calls[0]?.prompt, "Synthesize the evidence.");
});
