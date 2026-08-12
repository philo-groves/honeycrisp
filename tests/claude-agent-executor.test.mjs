import test from "node:test";
import assert from "node:assert/strict";
import {
  createPiAgentExecutor,
  extractCompatibleClaudeAgentResumableState,
} from "../packages/research-agent/dist/index.js";

test("Pi executor rejects Anthropic before model resolution", () => {
  assert.throws(
    () => createPiAgentExecutor({ provider: "anthropic", model: "claude-opus-5" }),
    /official Claude Agent SDK/,
  );
  assert.throws(
    () => createPiAgentExecutor({ provider: " ANTHROPIC ", model: "claude-opus-5" }),
    /official Claude Agent SDK/,
  );
});

test("Claude Agent SDK resume state is pinned to model, profile, and workflow", () => {
  const raw = {
    resumableState: {
      schemaVersion: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      providerSessionId: "640dd3c9-3afb-4e3f-83e8-3cc4fd3d8a10",
      researchProfileHash: "profile-hash",
      workflowId: "discovery",
    },
  };
  assert.deepEqual(
    extractCompatibleClaudeAgentResumableState(raw, "claude-opus-5", {
      researchProfileHash: "profile-hash",
      workflowId: "discovery",
    }),
    raw.resumableState,
  );
  assert.equal(
    extractCompatibleClaudeAgentResumableState(raw, "claude-opus-5", {
      researchProfileHash: "other-profile",
      workflowId: "discovery",
    }),
    undefined,
  );
});
