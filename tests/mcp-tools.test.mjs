import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfiguredResearchMcpClient,
  createMcpResearchTools,
  createResearchToolRegistry,
  createToolActionAuthorizer,
  loadResearchMcpClientConfig,
  projectModelToolResult,
} from "../packages/research-agent/dist/index.js";

test("MCP discovery maps allowlisted tools and resources into executable research tools", async () => {
  const calls = [];
  const client = {
    async listTools() {
      return [
        {
          serverName: "alpha",
          name: "search_docs",
          description: "Search local documentation",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {
              query: {
                type: "string",
              },
            },
          },
          outputSchema: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
              },
            },
          },
        },
        {
          serverName: "beta",
          name: "secret_search",
          description: "Denied server search",
        },
      ];
    },
    async callTool(input) {
      calls.push(input);
      return {
        items: [
          {
            title: "Parser notes",
          },
        ],
      };
    },
    async listResources() {
      return [
        {
          serverName: "alpha",
          uri: "mcp://alpha/parser-notes",
          name: "Parser notes",
          mimeType: "text/plain",
        },
        {
          serverName: "beta",
          uri: "mcp://beta/secret",
        },
      ];
    },
    async readResource(input) {
      calls.push(input);
      return {
        text: "resource parser note",
      };
    },
    async listResourceTemplates() {
      return [
        {
          serverName: "alpha",
          uriTemplate: "mcp://alpha/docs/{name}",
          name: "Doc template",
        },
        {
          serverName: "beta",
          uriTemplate: "mcp://beta/{name}",
        },
      ];
    },
  };

  const discovery = await createMcpResearchTools({
    client,
    allowedServers: ["alpha"],
  });
  const registry = createResearchToolRegistry(discovery.tools);
  const searchDescriptor = discovery.descriptors.find(
    (descriptor) => descriptor.name === "mcp.alpha.search_docs",
  );
  const resourceDescriptor = discovery.descriptors.find((descriptor) =>
    descriptor.name.startsWith("mcp.alpha.resource."),
  );

  assert.equal(discovery.tools.length, 2);
  assert.equal(discovery.resourceTemplates.length, 1);
  assert.equal(discovery.deniedCapabilities.length, 3);
  assert.equal(searchDescriptor?.actionClasses[0], "search");
  assert.equal(searchDescriptor?.sideEffects, "read");
  assert.equal(searchDescriptor?.metadata.provider, "mcp");
  assert.equal(searchDescriptor?.metadata.serverName, "alpha");
  assert.equal(searchDescriptor?.requiredPermissions[0], "mcp:alpha:tool:search_docs");
  assert.equal(resourceDescriptor?.actionClasses[0], "inspect");

  const toolResult = await registry.execute({
    id: "mcp_call",
    actionClass: "search",
    toolName: "mcp.alpha.search_docs",
    input: {
      query: "parser",
    },
  });
  assert.equal(toolResult.result.status, "complete");
  assert.equal(toolResult.result.output.untrusted, true);
  assert.equal(toolResult.result.output.output.items[0].title, "Parser notes");
  assert.deepEqual(calls[0], {
    serverName: "alpha",
    toolName: "search_docs",
    arguments: {
      query: "parser",
    },
  });

  const resourceResult = await registry.execute({
    id: "mcp_resource",
    actionClass: "inspect",
    toolName: resourceDescriptor.name,
    input: {
      uri: "mcp://alpha/parser-notes",
    },
  });
  assert.equal(resourceResult.result.status, "complete");
  assert.equal(resourceResult.result.output.kind, "resource");
  assert.equal(resourceResult.result.output.output.text, "resource parser note");
});

test("MCP capability families are discovered concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const discover = async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return value;
  };
  const client = {
    listTools: () => discover([]),
    listResources: () => discover([]),
    listResourceTemplates: () => discover([]),
    async callTool() {
      return {};
    },
    async readResource() {
      return {};
    },
  };

  await createMcpResearchTools({ client, allowedServers: [] });

  assert.equal(maxActive, 3);
});

test("Beale MCP annotations require host approval for mutations and preserve bounded image content", async () => {
  const calls = [];
  const approvals = [];
  const imageData = Buffer.from("small-png-fixture").toString("base64");
  const client = {
    async listTools() {
      return [{
        serverName: "computer-use",
        name: "click",
        description: "Click a freshly observed element.",
        inputSchema: { type: "object", additionalProperties: true },
        annotations: {
          "beale.io/tool": {
            actionClasses: ["experiment"],
            sideEffects: "write",
            requiredPermissions: ["computer-use:mutate"],
            confirmation: "always",
          },
        },
      }];
    },
    async callTool(input) {
      calls.push(input);
      return {
        content: [
          { type: "text", text: "clicked" },
          { type: "image", mimeType: "image/png", data: imageData },
        ],
      };
    },
  };
  const discovery = await createMcpResearchTools({
    client,
    allowedServers: ["computer-use"],
    authorizeToolAction: async (request) => {
      approvals.push(request);
      return {
        ...request,
        approvalRequestId: "tool_approval_1",
        argumentsHash: "a".repeat(64),
        decision: "approved",
        source: "human",
        reason: "Approved once.",
      };
    },
  });
  const descriptor = discovery.descriptors[0];
  assert.deepEqual(descriptor.actionClasses, ["experiment"]);
  assert.equal(descriptor.sideEffects, "write");
  assert.deepEqual(descriptor.requiredPermissions, [
    "mcp:computer-use:tool:click",
    "computer-use:mutate",
  ]);

  const registry = createResearchToolRegistry(discovery.tools);
  const execution = await registry.execute({
    id: "computer_click",
    actionClass: "experiment",
    toolName: descriptor.name,
    input: { observationId: "observation_1" },
  });
  assert.equal(approvals.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(execution.result.status, "complete");
  assert.equal(execution.result.output.output.content[1].dataOmitted, true);
  assert.equal(JSON.stringify(execution.result.output).includes(imageData), false);
  const projection = projectModelToolResult(execution.result);
  assert.equal(projection.content.at(-1).type, "image");
  assert.equal(projection.content.at(-1).data, imageData);
});

test("Beale MCP mutations fail closed when host approval is unavailable", async () => {
  let called = false;
  const client = {
    async listTools() {
      return [{
        serverName: "computer-use",
        name: "type",
        annotations: { "beale.io/tool": { confirmation: "always" } },
      }];
    },
    async callTool() {
      called = true;
      return {};
    },
  };
  const discovery = await createMcpResearchTools({ client, allowedServers: ["computer-use"] });
  const registry = createResearchToolRegistry(discovery.tools);
  const execution = await registry.execute({
    id: "computer_type",
    actionClass: "analyze",
    toolName: discovery.descriptors[0].name,
    input: {},
  });
  assert.equal(execution.result.status, "blocked");
  assert.equal(called, false);
});

test("tool approvals preserve exact arguments and deny lossy review projections", async () => {
  const reviews = [];
  const resolved = [];
  const authorize = createToolActionAuthorizer({
    async requestManualApproval(request) {
      reviews.push(request);
      return { decision: "approved", reason: "Reviewed exactly." };
    },
    onResolved(event) {
      resolved.push(event);
    },
  });

  const exact = await authorize({
    actionId: "action_exact",
    serverName: "computer-use",
    toolName: "type",
    description: "Type exact text.",
    arguments: { text: "  preserve surrounding whitespace  " },
  });
  assert.equal(exact.decision, "approved");
  assert.equal(reviews[0].arguments.text, "  preserve surrounding whitespace  ");

  const lossy = await authorize({
    actionId: "action_oversized",
    serverName: "computer-use",
    toolName: "type",
    description: "Type oversized text.",
    arguments: { text: "x".repeat(16_385) },
  });
  assert.equal(lossy.decision, "denied");
  assert.equal(lossy.source, "policy");
  assert.equal(reviews.length, 1);
  assert.equal(resolved.length, 2);
});

test("MCP discovery denylist defaults to no servers and execution reports timeouts", async () => {
  const deniedClient = {
    async listTools() {
      return [
        {
          serverName: "alpha",
          name: "search_docs",
        },
      ];
    },
    async callTool() {
      return {
        items: [],
      };
    },
  };
  const deniedDiscovery = await createMcpResearchTools({
    client: deniedClient,
  });
  assert.equal(deniedDiscovery.tools.length, 0);
  assert.equal(deniedDiscovery.deniedCapabilities[0]?.serverName, "alpha");

  const timeoutClient = {
    async listTools() {
      return [
        {
          serverName: "alpha",
          name: "search_docs",
          actionClasses: ["search"],
          sideEffects: "read",
        },
      ];
    },
    async callTool() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        items: [],
      };
    },
  };
  const timeoutDiscovery = await createMcpResearchTools({
    client: timeoutClient,
    allowedServers: ["alpha"],
    timeoutMs: 1,
  });
  const registry = createResearchToolRegistry(timeoutDiscovery.tools);
  const result = await registry.execute({
    id: "mcp_timeout",
    actionClass: "search",
    toolName: "mcp.alpha.search_docs",
    input: {},
  });

  assert.equal(result.result.status, "error");
  assert.match(result.result.summary, /exceeded timeout/);
});

test("configured stdio MCP client discovers and executes a live fixture server", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-live-mcp-"));
  const serverPath = join(root, "fixture-mcp.mjs");
  const configPath = join(root, "mcp.json");
  await writeFile(serverPath, createFixtureMcpServerSource(), "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      allowedServers: ["fixture"],
      timeoutMs: 1000,
      servers: {
        fixture: {
          command: process.execPath,
          args: [serverPath],
        },
      },
    }),
    "utf8",
  );

  const config = loadResearchMcpClientConfig(configPath);
  const client = createConfiguredResearchMcpClient(config);
  try {
    const discovery = await createMcpResearchTools({
      client,
      allowedServers: config.allowedServers,
      timeoutMs: config.timeoutMs,
    });
    const registry = createResearchToolRegistry(discovery.tools);
    const descriptor = discovery.descriptors.find(
      (candidate) => candidate.name === "mcp.fixture.echo_search",
    );
    const result = await registry.execute({
      id: "live_mcp_tool",
      actionClass: "search",
      toolName: "mcp.fixture.echo_search",
      input: {
        query: "parser",
      },
    });

    assert.equal(config.servers[0].name, "fixture");
    assert.ok(descriptor);
    assert.equal(descriptor.metadata.untrustedOutput, true);
    assert.equal(discovery.resourceTemplates.length, 1);
    assert.equal(result.result.status, "complete");
    assert.equal(result.result.output.output.content[0].text, "echo:parser");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

function createFixtureMcpServerSource() {
  return `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(message) {
  if (!message.id) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "0.1" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo_search", description: "Search echo fixture", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + message.params.arguments.query }] } });
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "mcp://fixture/note", name: "note", mimeType: "text/plain" }] } });
    return;
  }
  if (message.method === "resources/read") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: message.params.uri, text: "fixture note" }] } });
    return;
  }
  if (message.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [{ uriTemplate: "mcp://fixture/{name}", name: "template" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
}
`;
}
