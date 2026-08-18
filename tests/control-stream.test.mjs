import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { HoneycrispControlStream } from "../packages/cli/dist/control-stream.js";

test("control stream queues steering and holds it while paused", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  input.write(`${JSON.stringify({ schemaVersion: 1, type: "pause" })}\n`);
  input.write(`${JSON.stringify({ schemaVersion: 1, type: "steer", instruction: "Inspect the auth boundary." })}\n`);

  let settled = false;
  const instructionsPromise = controls.takeSteeringInstructions().then((instructions) => {
    settled = true;
    return instructions;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  input.write(`${JSON.stringify({ schemaVersion: 1, type: "resume" })}\n`);
  assert.deepEqual(await instructionsPromise, ["Inspect the auth boundary."]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["pause", "steer", "resume"],
  );
  controls.close();
  assert.equal(input.isPaused(), true);
  input.destroy();
});

test("control stream rejects malformed messages without closing", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  input.write("not-json\n");
  input.write(`${JSON.stringify({ schemaVersion: 1, type: "steer", instruction: "Continue carefully." })}\n`);

  assert.deepEqual(await controls.takeSteeringInstructions(), ["Continue carefully."]);
  assert.equal(events[0]?.accepted, false);
  assert.equal(events[1]?.accepted, true);
  controls.close();
  assert.equal(input.isPaused(), true);
  input.destroy();
});

test("control stream retains the latest model selection from steering", async () => {
  const input = new PassThrough();
  const controls = new HoneycrispControlStream(input);
  controls.start();

  input.write(`${JSON.stringify({
    schemaVersion: 1,
    type: "steer",
    instruction: "Continue with the selected model.",
    modelSelection: { provider: "xai", model: "grok-4.5", reasoningEffort: "high" },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(controls.getModelSelection(), {
    provider: "xai",
    model: "grok-4.5",
    reasoningEffort: "high",
  });
  assert.deepEqual(await controls.takeSteeringInstructions(), ["Continue with the selected model."]);
  controls.close();
  input.destroy();
});

test("control stream exposes a stop signal for the complete agent tree", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  assert.equal(controls.signal.aborted, false);
  const pendingApproval = controls.waitForShellApproval("approval_stopped");
  input.write(`${JSON.stringify({ schemaVersion: 1, type: "stop" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controls.signal.aborted, true);
  assert.equal((await pendingApproval).decision, "denied");
  assert.deepEqual(events, [{ type: "stop", accepted: true }]);
  controls.close();
  input.destroy();
});

test("control stream configures safety and correlates concurrent shell approvals", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "configure_shell_safety",
    requestId: "safety-1",
    shellSafetyMode: "manual_approval",
  }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controls.getShellSafetyMode(), "manual_approval");
  assert.deepEqual(events.at(-1), {
    type: "configure_shell_safety",
    accepted: true,
    requestId: "safety-1",
  });

  const first = controls.waitForShellApproval("approval-1");
  const second = controls.waitForShellApproval("approval-2");
  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "resolve_shell_approval",
    requestId: "resolve-2",
    approvalRequestId: "approval-2",
    decision: "denied",
  }) + "\n");
  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "resolve_shell_approval",
    requestId: "resolve-1",
    approvalRequestId: "approval-1",
    decision: "approved",
  }) + "\n");
  assert.equal((await second).decision, "denied");
  assert.equal((await first).decision, "approved");

  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "resolve_shell_approval",
    requestId: "duplicate-1",
    approvalRequestId: "approval-1",
    decision: "denied",
  }) + "\n");
  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "configure_shell_safety",
    requestId: "invalid-safety",
    shellSafetyMode: "unreviewed",
  }) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-2)?.type, "invalid");
  assert.equal(events.at(-2)?.requestId, "duplicate-1");
  assert.equal(events.at(-1)?.type, "invalid");
  assert.equal(events.at(-1)?.requestId, "invalid-safety");
  controls.close();
  input.destroy();
});

test("control stream denies pending shell approvals on EOF and close", async () => {
  const endedInput = new PassThrough();
  const endedControls = new HoneycrispControlStream(endedInput);
  endedControls.start();
  const endedApproval = endedControls.waitForShellApproval("approval-eof");
  endedInput.end();
  assert.equal((await endedApproval).decision, "denied");
  endedControls.close();

  const closedInput = new PassThrough();
  const closedControls = new HoneycrispControlStream(closedInput);
  closedControls.start();
  const closedApproval = closedControls.waitForShellApproval("approval-close");
  closedControls.close();
  assert.equal((await closedApproval).decision, "denied");
  endedInput.destroy();
  closedInput.destroy();
});

test("control stream correlates host decisions for computer-use approvals", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();
  const waiting = controls.waitForToolApproval("tool-approval-1");
  input.write(JSON.stringify({
    schemaVersion: 1,
    type: "resolve_tool_approval",
    requestId: "resolve-tool-1",
    approvalRequestId: "tool-approval-1",
    decision: "approved",
  }) + "\n");
  assert.equal((await waiting).decision, "approved");
  assert.deepEqual(events.at(-1), {
    type: "resolve_tool_approval",
    accepted: true,
    requestId: "resolve-tool-1",
  });
  controls.close();
  input.destroy();
});

test("control stream wakes safeguard steering waits and correlates accepted controls", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  const waiting = controls.waitForSteeringInstructions();
  input.write(`${JSON.stringify({
    schemaVersion: 1,
    type: "steer",
    requestId: " safeguard-recovery-1 ",
    instruction: "Continue the authorized review safely.",
  })}\n`);

  assert.deepEqual(await waiting, ["Continue the authorized review safely."]);
  assert.deepEqual(events, [{
    type: "steer",
    accepted: true,
    requestId: "safeguard-recovery-1",
  }]);
  controls.close();
  input.destroy();
});

test("control stream correlates rejected controls and does not wait after input EOF", async () => {
  const input = new PassThrough();
  const events = [];
  const controls = new HoneycrispControlStream(input, (event) => events.push(event));
  controls.start();

  input.write(`${JSON.stringify({
    schemaVersion: 1,
    type: "unsupported",
    requestId: "invalid-control-1",
  })}\n`);
  input.end();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0]?.type, "invalid");
  assert.equal(events[0]?.accepted, false);
  assert.equal(events[0]?.requestId, "invalid-control-1");
  assert.deepEqual(await controls.waitForSteeringInstructions(), []);
  controls.close();
  input.destroy();
});
