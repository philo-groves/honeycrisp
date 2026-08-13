import test from "node:test";
import assert from "node:assert/strict";
import {
  appendClaudeAgentProgressGuidance,
  createPiAgentExecutor,
  extractCompatibleClaudeAgentResumableState,
  projectClaudeAgentAssistantOutput,
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

test("Claude Agent SDK guidance requests ordinary progress text without private reasoning", () => {
  const prompt = appendClaudeAgentProgressGuidance("Shared research prompt.");
  assert.match(prompt, /^Shared research prompt\./);
  assert.match(prompt, /ordinary assistant text/);
  assert.match(prompt, /Do not leave all user-visible progress inside extended thinking/);
  assert.match(prompt, /do not reveal private chain-of-thought/);
});

test("Claude Agent SDK assistant text projects phased live output", () => {
  const progress = projectClaudeAgentAssistantOutput({
    type: "assistant",
    uuid: "message-progress",
    request_id: "request-progress",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "text", text: "I am mapping the transport boundary first." }],
      stop_reason: "tool_use",
    },
  }, "claude-opus-5", {
    id: "agent-review",
    path: "/root/review",
    parentId: "root",
  });
  assert.deepEqual(progress, {
    text: "I am mapping the transport boundary first.",
    payload: {
      agentId: "agent-review",
      agentPath: "/root/review",
      parentAgentId: "root",
      phase: "completed",
      eventType: "text_end",
      messagePhase: "commentary",
      responseId: "request-progress",
      itemId: "claude-text:message-progress",
      provider: "anthropic",
      model: "claude-opus-5",
      api: "claude-agent-sdk",
      text: "I am mapping the transport boundary first.",
    },
  });

  const finalOutput = projectClaudeAgentAssistantOutput({
    type: "assistant",
    uuid: "message-final",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "text", text: "Review complete." }],
      stop_reason: "end_turn",
    },
  }, "claude-opus-5");
  assert.equal(finalOutput?.payload.messagePhase, "final_answer");

  const privateThinking = projectClaudeAgentAssistantOutput({
    type: "assistant",
    uuid: "message-thinking",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "thinking", thinking: "Private reasoning.", signature: "signature" }],
      stop_reason: "tool_use",
    },
  }, "claude-opus-5");
  assert.equal(privateThinking, undefined);
});
