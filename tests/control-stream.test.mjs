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
