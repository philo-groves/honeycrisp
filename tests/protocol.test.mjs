import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeHoneycrispProtocolEnvelope,
  decodeHoneycrispServerMessage,
  HONEYCRISP_PROTOCOL_OPERATIONS,
  HONEYCRISP_PROTOCOL_VERSION,
  honeycrispProtocolFailure,
  honeycrispProtocolSuccess,
  parseHoneycrispProtocolArguments,
} from "../packages/cli/dist/protocol.js";

const cliPath = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

test("protocol envelopes are versioned, correlated, and strictly decoded", () => {
  const success = honeycrispProtocolSuccess("protocol.describe", { available: true }, "request-1");
  assert.deepEqual(decodeHoneycrispProtocolEnvelope(success), success);

  const failure = honeycrispProtocolFailure("protocol.describe", "unavailable", "Protocol discovery is unavailable.");
  assert.deepEqual(decodeHoneycrispProtocolEnvelope(failure), failure);
  assert.throws(
    () => decodeHoneycrispProtocolEnvelope({ ...success, protocolVersion: 2 }),
    /Invalid or unsupported/,
  );
});

test("protocol describe exposes one v1 contract for CLI and WebSocket clients", () => {
  const result = spawnSync(process.execPath, [
    cliPath, "protocol", "describe", "--json", "--request-id", "describe-1",
  ], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const envelope = decodeHoneycrispProtocolEnvelope(JSON.parse(result.stdout));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.protocolVersion, HONEYCRISP_PROTOCOL_VERSION);
  assert.equal(envelope.operation, "protocol.describe");
  assert.equal(envelope.requestId, "describe-1");
  assert.deepEqual(envelope.result.operations, HONEYCRISP_PROTOCOL_OPERATIONS);
  assert.equal(envelope.result.transports.websocket.path, "/v1/session");
  assert.equal(envelope.result.transports.cli.framing, "single-json-envelope");
  assert.equal(envelope.result.transports.cli.correlation, "request-id");
  assert.equal(envelope.result.transports.websocket.framing, "json-message");
  assert.equal(envelope.result.transports.websocket.errors, "protocol-error-message");
  assert.equal(envelope.result.transports.websocket.correlation, "request-id");
});

test("protocol argument and WebSocket DTO decoders share correlation and error semantics", () => {
  assert.deepEqual(
    parseHoneycrispProtocolArguments(["protocol", "describe", "--request-id", "request-2", "--json"]),
    { args: ["protocol", "describe", "--json"], requestId: "request-2" },
  );
  assert.throws(
    () => parseHoneycrispProtocolArguments(["--request-id", "one", "--request-id", "two"]),
    /only be provided once/,
  );
  assert.deepEqual(decodeHoneycrispServerMessage({
    protocolVersion: 1,
    type: "protocol.error",
    sessionId: "session-1",
    requestId: "request-2",
    error: { code: "invalid_message", message: "Bad message.", retryable: false },
    message: "Bad message.",
  }).error, { code: "invalid_message", message: "Bad message.", retryable: false });
});
