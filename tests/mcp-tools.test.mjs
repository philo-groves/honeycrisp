import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpResearchTools,
  createResearchToolRegistry,
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
