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
  input.write(`${JSON.stringify({ schemaVersion: 1, type: "stop" })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controls.signal.aborted, true);
  assert.deepEqual(events, [{ type: "stop", accepted: true }]);
  controls.close();
  input.destroy();
});
