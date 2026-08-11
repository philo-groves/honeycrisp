import assert from "node:assert/strict";
import test from "node:test";

import {
  generateResearchSessionTitle,
  normalizeResearchSessionTitle,
} from "../packages/research-agent/dist/index.js";

test("research session titles use the selected provider model and medium effort", async () => {
  const calls = [];
  const model = { provider: "xai", id: "grok-4.3" };
  const title = await generateResearchSessionTitle({
    provider: "xai",
    model: "grok-4.3",
    prompt: "Audit Zsh parameter expansion for attacker-controlled prompt execution.",
    models: {
      getModel(provider, modelId) {
        assert.equal(provider, "xai");
        assert.equal(modelId, "grok-4.3");
        return model;
      },
      async completeSimple(selectedModel, context, options) {
        calls.push({ selectedModel, context, options });
        return {
          role: "assistant",
          content: [{ type: "text", text: '"Zsh Prompt Expansion Audit."' }],
          api: "fixture",
          provider: "xai",
          model: "grok-4.3",
          usage: {},
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
  });

  assert.equal(title, "Zsh Prompt Expansion Audit");
  assert.equal(calls[0]?.selectedModel, model);
  assert.equal(calls[0]?.options.reasoning, "medium");
  assert.equal("temperature" in calls[0].options, false);
  assert.match(calls[0]?.context.systemPrompt, /3 to 6 words/);
  assert.match(calls[0]?.context.messages[0].content, /parameter expansion/);
});

test("research session title normalization removes response decoration and bounds words", () => {
  assert.equal(
    normalizeResearchSessionTitle("## Session title: **ZFTP Control Channel State Machine Validation.**"),
    "ZFTP Control Channel State Machine Validation",
  );
  assert.equal(
    normalizeResearchSessionTitle("one two three four five six seven eight nine ten"),
    "one two three four five six",
  );
});

test("research session titles use profile vocabulary", async () => {
  let systemPrompt = "";
  await generateResearchSessionTitle({
    provider: "fixture",
    model: "fixture",
    prompt: "Compare the two sediment chronologies.",
    researchProfile: {
      name: "Climate History",
      workspace: { subjectNoun: "Field site" },
      presentation: { sessionLabel: "Study Session" },
    },
    models: {
      getModel() { return { provider: "fixture", id: "fixture" }; },
      async completeSimple(_model, context) {
        systemPrompt = context.systemPrompt;
        return {
          role: "assistant",
          content: [{ type: "text", text: "Sediment Chronology Comparison" }],
          api: "fixture",
          provider: "fixture",
          model: "fixture",
          usage: {},
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
  });

  assert.match(systemPrompt, /Climate History study session/);
  assert.match(systemPrompt, /field site/i);
  assert.doesNotMatch(systemPrompt, /security research/i);
});
