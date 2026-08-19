import assert from "node:assert/strict";
import test from "node:test";

import {
  ResearchDispositionRecorder,
  createSessionDispositionTool,
  fallbackResearchFinalDisposition,
} from "../packages/research-agent/dist/index.js";

test("session disposition records one validated structured terminal state", async () => {
  const recorder = new ResearchDispositionRecorder();
  const tool = createSessionDispositionTool(recorder);
  const action = {
    id: "disposition_one",
    actionClass: "respond",
    toolName: "session.disposition",
    input: {
      outcome: "blocked",
      summary: "Live validation requires an authorized second account.",
      blockerDependencies: [{
        kind: "credentials",
        description: "No second test account is available.",
        requiredState: "Provide an authorized credential reference.",
        external: true,
      }],
      externalStateRequired: true,
      nextPromptSuggestions: [
        {
          title: "Validate with a second account",
          promptMarkdown: "Use an authorized second account to validate the cross-account boundary.",
          rationale: "The missing credential is the only external blocker.",
        },
        {
          title: "Audit the adjacent authorization path",
          promptMarkdown: "Trace the adjacent authorization path and compare its ownership checks.",
        },
        {
          title: "Build a regression proof",
          promptMarkdown: "Turn the observed boundary into a bounded, reproducible regression proof.",
        },
      ],
    },
  };

  assert.equal(tool.descriptor.metadata.requiredBeforeFinalResponse, true);
  assert.equal(tool.descriptor.sideEffects, "none");
  const result = await tool.execute(action);
  assert.equal(result.status, "complete");
  assert.deepEqual(recorder.get(), {
    ...action.input,
    recordedAt: recorder.get().recordedAt,
  });

  const duplicate = await tool.execute({ ...action, id: "disposition_two" });
  assert.equal(duplicate.status, "error");
  assert.match(duplicate.error.message, /already been recorded/);
});

test("session disposition can be reset between nonterminal goal turns", async () => {
  const recorder = new ResearchDispositionRecorder();
  const tool = createSessionDispositionTool(recorder);
  const first = await tool.execute({
    id: "disposition_partial",
    actionClass: "respond",
    toolName: "session.disposition",
    input: {
      outcome: "objective_partially_achieved",
      summary: "The source is verified but the sink is not.",
      blockerDependencies: [],
      externalStateRequired: false,
    },
  });
  assert.equal(first.status, "complete");

  recorder.resetForGoalContinuation();
  const second = await tool.execute({
    id: "disposition_complete",
    actionClass: "respond",
    toolName: "session.disposition",
    input: {
      outcome: "objective_achieved",
      summary: "The complete source-to-sink path is verified.",
      blockerDependencies: [],
      externalStateRequired: false,
    },
  });
  assert.equal(second.status, "complete");
  assert.equal(recorder.get().outcome, "objective_achieved");
});

test("session disposition rejects inconsistent external blockers and provides terminal fallbacks", async () => {
  const recorder = new ResearchDispositionRecorder();
  const tool = createSessionDispositionTool(recorder);
  const result = await tool.execute({
    id: "invalid_disposition",
    actionClass: "respond",
    toolName: "session.disposition",
    input: {
      outcome: "blocked",
      summary: "Blocked.",
      blockerDependencies: [{ kind: "environment", description: "Missing target.", requiredState: "Provide target.", external: true }],
      externalStateRequired: false,
    },
  });

  assert.equal(result.status, "error");
  assert.equal(recorder.get(), null);
  const fallback = fallbackResearchFinalDisposition("error", "Provider failed.");
  assert.deepEqual(fallback, {
    outcome: "failed",
    summary: "Provider failed.",
    blockerDependencies: [],
    externalStateRequired: false,
    recordedAt: fallback.recordedAt,
  });
});
