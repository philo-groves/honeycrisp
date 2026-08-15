import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HONEYCRISP_TRANSPORT_PROTOCOL_VERSION,
} from "../packages/cli/dist/websocket-protocol.js";
import { HoneycrispWebSocketTransport } from "../packages/cli/dist/websocket-transport.js";

const requireFromCli = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const WebSocket = requireFromCli("ws");
const transports = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WebSocket transport authenticates and exchanges versioned session messages", async () => {
  const transport = await HoneycrispWebSocketTransport.listen({
    sessionId: "session-1",
    token: "test-token",
    serverVersion: "test",
  });
  transports.push(transport);

  const socket = new WebSocket(transport.bootstrap.url, {
    headers: { authorization: "Bearer test-token" },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const hello = nextMessage(socket);
  socket.send(JSON.stringify({
    protocolVersion: HONEYCRISP_TRANSPORT_PROTOCOL_VERSION,
    type: "client.hello",
    sessionId: "session-1",
    client: { name: "test", version: "1" },
  }));
  await transport.waitForClient();
  assert.deepEqual(await hello, {
    protocolVersion: 1,
    type: "server.hello",
    sessionId: "session-1",
    server: { name: "honeycrisp", version: "test" },
    capabilities: ["session.events", "session.controls"],
  });

  const controlData = new Promise((resolve) => transport.controlInput.once("data", resolve));
  socket.send(JSON.stringify({
    protocolVersion: 1,
    type: "session.control",
    sessionId: "session-1",
    requestId: "control-1",
    control: { schemaVersion: 1, type: "pause", requestId: "control-1" },
  }));
  assert.deepEqual(
    JSON.parse((await controlData).toString("utf8")),
    { schemaVersion: 1, type: "pause", requestId: "control-1" },
  );

  const event = nextMessage(socket);
  await transport.eventSink({
    schemaVersion: 1,
    kind: "agent.event",
    timestamp: "2026-08-15T00:00:00.000Z",
    payload: { eventType: "started" },
  });
  assert.deepEqual(await event, {
    protocolVersion: 1,
    type: "session.event",
    sessionId: "session-1",
    event: {
      schemaVersion: 1,
      kind: "agent.event",
      timestamp: "2026-08-15T00:00:00.000Z",
      payload: { eventType: "started" },
    },
  });
});

test("WebSocket transport rejects clients without the bearer token", async () => {
  const transport = await HoneycrispWebSocketTransport.listen({
    sessionId: "session-2",
    token: "required-token",
    serverVersion: "test",
  });
  transports.push(transport);

  const socket = new WebSocket(transport.bootstrap.url);
  const statusCode = await new Promise((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.destroy();
    });
    socket.once("error", reject);
  });
  assert.equal(statusCode, 401);
});

test("runtime CLI completes a mock run entirely over the WebSocket transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "honeycrisp-websocket-runtime-"));
  temporaryDirectories.push(directory);
  const capturePath = join(directory, "capture.json");
  const child = spawn(process.execPath, [
    new URL("../packages/cli/dist/cli.js", import.meta.url).pathname,
    "--mock",
    "--websocket-transport",
    "--session-id",
    "session-runtime",
    "--workspace-root",
    directory,
    "--capture",
    capturePath,
    "-p",
    "Exercise the WebSocket runtime transport.",
  ], {
    env: {
      ...process.env,
      HONEYCRISP_TRANSPORT_TOKEN: "runtime-test-token",
      HONEYCRISP_DATABASE_PATH: join(directory, "memory.sqlite"),
      HONEYCRISP_ARTIFACT_DIRECTORY: join(directory, "artifacts"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bootstrap = await readBootstrap(child.stdout);
  const socket = new WebSocket(bootstrap.url, {
    headers: { authorization: "Bearer runtime-test-token" },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
  socket.send(JSON.stringify({
    protocolVersion: 1,
    type: "client.hello",
    sessionId: "session-runtime",
    client: { name: "runtime-test", version: "1" },
  }));

  const { code, stderr } = await waitForChild(child);
  assert.equal(code, 0, stderr);
  assert.equal(existsSync(capturePath), true);
  assert.equal(messages.some((message) => message.type === "server.hello"), true);
  assert.equal(messages.some((message) => message.type === "session.event"), true);
});

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function readBootstrap(stdout) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      const prefix = "HONEYCRISP_TRANSPORT ";
      if (!line.startsWith(prefix)) {
        reject(new Error(`Unexpected Honeycrisp bootstrap output: ${line}`));
        return;
      }
      resolve(JSON.parse(line.slice(prefix.length)));
    });
    stdout.once("error", reject);
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}
