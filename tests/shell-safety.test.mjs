import assert from "node:assert/strict";
import test from "node:test";

import {
  createShellSafetyAuthorizer,
  DEFAULT_SHELL_REVIEW_MODELS,
} from "../packages/research-agent/dist/index.js";

const BASE_REQUEST = {
  actionId: "shell_action_1",
  workspaceRoot: "/tmp/authorized-workspace",
  utility: "printf",
  args: ["%s", "safe"],
  cwd: "/tmp/authorized-workspace",
  timeoutMs: 1_000,
};

test("standalone Auto-Review defaults cover each supported provider", () => {
  assert.deepEqual(DEFAULT_SHELL_REVIEW_MODELS, {
    "openai-codex": "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
    xai: "grok-4.3",
  });
});

test("Danger Mode approves without a reviewer or human decision", async () => {
  let modelCalls = 0;
  let manualCalls = 0;
  const resolved = [];
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "danger",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => {
      manualCalls += 1;
      return { decision: "denied", reason: "unused" };
    },
    onResolved: (event) => resolved.push(event),
    models: {
      getModel() {
        modelCalls += 1;
        return undefined;
      },
      async completeSimple() {
        modelCalls += 1;
        throw new Error("Danger Mode must not call a model.");
      },
    },
  });

  const decision = await authorize(BASE_REQUEST);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.source, "danger");
  assert.equal(modelCalls, 0);
  assert.equal(manualCalls, 0);
  assert.equal(resolved[0]?.type, "shell_authorization_resolved");
});

test("Manual Approval waits for one correlated human decision", async () => {
  let resolveManual;
  const requested = [];
  const resolved = [];
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "manual_approval",
    getReviewerSelection: () => undefined,
    requestManualApproval: () => new Promise((resolve) => {
      resolveManual = resolve;
    }),
    onRequested: (event) => requested.push(event),
    onResolved: (event) => resolved.push(event),
    models: unreachableModels(),
  });

  let settled = false;
  const pending = authorize(BASE_REQUEST).then((decision) => {
    settled = true;
    return decision;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].type, "shell_authorization_requested");
  assert.match(requested[0].approvalRequestId, /^shell_approval_/);

  resolveManual({
    decision: "approved",
    reason: "The researcher approved this shell command.",
  });
  const decision = await pending;
  assert.equal(decision.decision, "approved");
  assert.equal(decision.source, "human");
  assert.equal(resolved[0]?.approvalRequestId, requested[0].approvalRequestId);
});

test("Manual Approval attributes an ended host approval channel to policy", async () => {
  const requested = [];
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "manual_approval",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => {
      throw new Error("approval channel ended");
    },
    onRequested: (event) => requested.push(event),
    models: unreachableModels(),
  });

  const decision = await authorize(BASE_REQUEST);
  assert.equal(requested.length, 1);
  assert.equal(decision.decision, "denied");
  assert.equal(decision.source, "policy");
  assert.match(decision.reason, /host approval channel ended/);
});

test("Manual Approval denies every Beale-parity redaction before waiter or request emission", async () => {
  let manualWaiters = 0;
  const requested = [];
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "manual_approval",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => {
      manualWaiters += 1;
      return { decision: "approved", reason: "must not be reached" };
    },
    onRequested: (event) => requested.push(event),
    models: unreachableModels(),
  });

  const vectors = [];
  for (const flag of ["--refresh-token", "--credential", "--credentials", "--userpwd"]) {
    const name = flag.slice(2);
    vectors.push(
      { args: [`  ${flag.toUpperCase()}  `, `${name}-paired-secret`], secrets: [`${name}-paired-secret`] },
      { args: [` ${flag}=${name}-inline-secret `], secrets: [`${name}-inline-secret`] },
      { args: ["-c", `client ${flag} '${name}-embedded-secret' target`], secrets: [`${name}-embedded-secret`] },
    );
  }
  vectors.push(
    {
      args: ["--header", "X-Api-Key: x-api-key-header-secret"],
      secrets: ["x-api-key-header-secret"],
    },
    {
      args: ["--proxy-header", "Api-Key: api-key-header-secret"],
      secrets: ["api-key-header-secret"],
    },
    {
      args: ["Basic QWxhZGRpbjpPcGVuU2VzYW1l"],
      secrets: ["QWxhZGRpbjpPcGVuU2VzYW1l"],
    },
    {
      args: ["github_pat_1234567890ABCDEF"],
      secrets: ["1234567890ABCDEF"],
    },
    {
      args: ["ghr_1234567890ABCDEF"],
      secrets: ["1234567890ABCDEF"],
    },
    {
      args: ["access_token='access assignment secret'"],
      secrets: ["access assignment secret"],
    },
    {
      args: ["refresh-token=refresh-assignment-secret"],
      secrets: ["refresh-assignment-secret"],
    },
  );

  for (const vector of vectors) {
    const decision = await authorize({ ...BASE_REQUEST, args: vector.args });
    assert.equal(decision.decision, "denied");
    assert.equal(decision.source, "policy");
    const audit = JSON.stringify(decision.command);
    for (const secret of vector.secrets) assert.doesNotMatch(audit, new RegExp(secret));
  }
  assert.equal(manualWaiters, 0);
  assert.equal(requested.length, 0);
});

test("Manual Approval denies lossy or sanitized command displays before creating a human waiter", async () => {
  let manualWaiters = 0;
  const requested = [];
  const resolved = [];
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "manual_approval",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => {
      manualWaiters += 1;
      return { decision: "approved", reason: "must not be reached" };
    },
    onRequested: (event) => requested.push(event),
    onResolved: (event) => resolved.push(event),
    models: unreachableModels(),
  });

  const hiddenCommands = [
    { ...BASE_REQUEST, stdin: "hidden-stdin-secret" },
    { ...BASE_REQUEST, args: Array.from({ length: 257 }, (_, index) => String(index)) },
    { ...BASE_REQUEST, utility: "u".repeat(2_049) },
    { ...BASE_REQUEST, cwd: "/" + "c".repeat(2_049) },
    { ...BASE_REQUEST, args: ["a".repeat(2_049)] },
    { ...BASE_REQUEST, args: ["-c", "password=$(touch /tmp/manual-review-mismatch)"] },
    { ...BASE_REQUEST, args: ["--password", "paired-password-secret"] },
    { ...BASE_REQUEST, cwd: "/tmp/token=credential-path-secret" },
  ];
  for (const request of hiddenCommands) {
    const decision = await authorize(request);
    assert.equal(decision.decision, "denied");
    assert.equal(decision.source, "policy");
    assert.match(decision.reason, /Manual Approval denied/);
  }

  assert.equal(manualWaiters, 0);
  assert.equal(requested.length, 0);
  assert.equal(resolved.length, hiddenCommands.length);
  assert.doesNotMatch(JSON.stringify(resolved), /hidden-stdin-secret/);
});

test("shell audit argv redaction removes paired credentials, cookies, and auth headers", async () => {
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "danger",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    models: unreachableModels(),
  });
  const decision = await authorize({
    ...BASE_REQUEST,
    utility: "curl",
    args: [
      "--password",
      "hunter2",
      "--token",
      "token-value-secret",
      "-H",
      "Authorization: Basic header-credential-secret",
      "--user",
      "researcher:user-password-secret",
      "--api-key=inline-api-secret",
      "sh -c 'curl --password embedded-password-secret example.test'",
      "--cookie",
      "session=cookie-pair-secret",
      "-b",
      "cookie-short-secret",
      "-H",
      "Cookie: session=cookie-header-secret",
      "--cookie=inline-cookie-secret",
      "sh -c 'curl -b embedded-cookie-secret example.test'",
    ],
  });

  const serialized = JSON.stringify(decision.command);
  for (const secret of [
    "hunter2",
    "token-value-secret",
    "header-credential-secret",
    "researcher:user-password-secret",
    "inline-api-secret",
    "embedded-password-secret",
    "cookie-pair-secret",
    "cookie-short-secret",
    "cookie-header-secret",
    "inline-cookie-secret",
    "embedded-cookie-secret",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.deepEqual(decision.command.args.slice(0, 8), [
    "--password",
    "[REDACTED]",
    "--token",
    "[REDACTED]",
    "-H",
    "Authorization: [REDACTED]",
    "--user",
    "[REDACTED]",
  ]);
});

test("Auto-Review uses the active provider small model and emits a redacted audit", async () => {
  const calls = [];
  let reviewer = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };
  const models = fixtureModels(
    '{"decision":"approved","reason":"Scoped command; token=reviewer-secret is not retained."}',
    calls,
  );
  const authorize = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => reviewer,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    models,
  });

  const request = {
    ...BASE_REQUEST,
    utility: "bash",
    args: ["-c", "printf token=command-secret"],
    stdin: "password=stdin-secret",
  };
  const approved = await authorize(request);
  assert.equal(approved.decision, "approved");
  assert.equal(approved.source, "small_model");
  assert.deepEqual(approved.reviewer, reviewer);
  assert.match(approved.command.commandHash, /^sha256:/);
  assert.match(approved.command.stdinHash, /^sha256:/);
  assert.equal(approved.command.stdinPresent, true);
  assert.equal(approved.command.stdinBytes, Buffer.byteLength(request.stdin));
  assert.equal("stdin" in approved.command, false);
  assert.match(approved.command.args[1], /\[REDACTED\]/);
  assert.doesNotMatch(approved.reason, /reviewer-secret/);
  assert.match(approved.reason, /\[REDACTED\]/);
  assert.equal(calls[0].provider, "openai-codex");
  assert.equal(calls[0].modelId, "gpt-5.6-luna");
  assert.equal(calls[0].options.reasoning, "medium");
  assert.equal(calls[0].options.maxTokens, 256);
  assert.match(calls[0].context.messages[0].content, /password=stdin-secret/);

  reviewer = {
    provider: "xai",
    model: "grok-4.3",
    reasoningEffort: "medium",
  };
  await authorize(BASE_REQUEST);
  assert.equal(calls[1].provider, "xai");
  assert.equal(calls[1].modelId, "grok-4.3");
});

test("Auto-Review fails closed for missing, malformed, oversized, and timed-out reviews", async () => {
  const reviewer = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };
  for (const response of [
    "approved",
    String.fromCharCode(96).repeat(3) + 'json\n{"decision":"approved","reason":"safe"}\n' + String.fromCharCode(96).repeat(3),
    '{"decision":"approved","reason":"safe","extra":true}',
    '{"decision":"unknown","reason":"safe"}',
  ]) {
    const authorize = createShellSafetyAuthorizer({
      getMode: () => "auto_review",
      getReviewerSelection: () => reviewer,
      requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
      models: fixtureModels(response, []),
    });
    const decision = await authorize(BASE_REQUEST);
    assert.equal(decision.decision, "denied");
    assert.match(decision.reason, /failed closed/);
    assert.doesNotMatch(decision.reason, /approved|unknown/);
  }

  let calls = 0;
  const missing = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => undefined,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    models: {
      getModel() {
        calls += 1;
        return undefined;
      },
      async completeSimple() {
        calls += 1;
        throw new Error("unreachable");
      },
    },
  });
  assert.equal((await missing(BASE_REQUEST)).decision, "denied");
  assert.equal(calls, 0);

  const oversized = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => reviewer,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    maxReviewInputBytes: 32,
    models: {
      getModel() {
        calls += 1;
        return { provider: reviewer.provider, id: reviewer.model };
      },
      async completeSimple() {
        calls += 1;
        throw new Error("oversized input must not reach the model");
      },
    },
  });
  const oversizedDecision = await oversized({ ...BASE_REQUEST, stdin: "x".repeat(100) });
  assert.equal(oversizedDecision.decision, "denied");
  assert.match(oversizedDecision.reason, /exceeds the review limit/);

  const timedOut = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => reviewer,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    reviewTimeoutMs: 10,
    models: {
      getModel() {
        return { provider: reviewer.provider, id: reviewer.model };
      },
      async completeSimple(_model, _context, options) {
        await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
        return {
          role: "assistant",
          content: [],
          api: "fixture",
          provider: reviewer.provider,
          model: reviewer.model,
          usage: {},
          stopReason: "aborted",
          timestamp: Date.now(),
        };
      },
    },
  });
  assert.equal((await timedOut(BASE_REQUEST)).decision, "denied");
});

test("Auto-Review timeout and outer abort fail closed when a provider ignores AbortSignal", async () => {
  const reviewer = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };
  let calls = 0;
  const stubbornModels = {
    getModel() {
      return { provider: reviewer.provider, id: reviewer.model };
    },
    async completeSimple() {
      calls += 1;
      return new Promise(() => {});
    },
  };
  const timedOut = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => reviewer,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    reviewTimeoutMs: 10,
    models: stubbornModels,
  });
  const startedAt = Date.now();
  assert.equal((await timedOut(BASE_REQUEST)).decision, "denied");
  assert.ok(Date.now() - startedAt < 1_000, "stubborn reviewer must not outlive the host timeout");

  const aborted = createShellSafetyAuthorizer({
    getMode: () => "auto_review",
    getReviewerSelection: () => reviewer,
    requestManualApproval: async () => ({ decision: "denied", reason: "unused" }),
    reviewTimeoutMs: 30_000,
    models: stubbornModels,
  });
  const controller = new AbortController();
  const pending = aborted(BASE_REQUEST, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).decision, "denied");
  assert.equal(calls, 2);
});

function fixtureModels(responseText, calls) {
  return {
    getModel(provider, modelId) {
      calls.push({ provider, modelId });
      return { provider, id: modelId };
    },
    async completeSimple(selectedModel, context, options) {
      Object.assign(calls.at(-1), { selectedModel, context, options });
      return {
        role: "assistant",
        content: [{ type: "text", text: responseText }],
        api: "fixture",
        provider: selectedModel.provider,
        model: selectedModel.id,
        usage: { input: 10, output: 5 },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };
}

function unreachableModels() {
  return {
    getModel() {
      assert.fail("This safety mode must not select a reviewer.");
    },
    async completeSimple() {
      assert.fail("This safety mode must not call a reviewer.");
    },
  };
}
