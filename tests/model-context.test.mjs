import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileMemoryModelContext,
  createAvailableToolContext,
  createModelWorkspaceContext,
  createResearchWorkspaceContext,
  MemoryGraphStore,
  selectMemoryModelContext,
  workspaceContextFileReadHints,
} from "../packages/research-agent/dist/index.js";

test("model workspace context preserves research identity without storage paths", () => {
  const context = createModelWorkspaceContext({
    schemaVersion: 1,
    workspaceRoot: "/private/workspaces/zsh",
    authorization: {
      recorded: true,
      source: "beale",
      scopeName: "Apple OSS Zsh",
      scopeOwner: "Apple",
      networkProfile: "offline",
    },
    memoryTierContext: {
      sessionId: "run_zftp",
      workspaceId: "workspace_zsh",
      workspaceName: "Zsh",
      subjectId: "subject_apple",
      subjectName: "Apple",
      peers: [{
        databasePath: "/private/workspaces/mdns/.honeycrisp/memory/memory.sqlite",
        workspaceId: "workspace_mdns",
        workspaceName: "mDNSResponder",
        subjectId: "subject_apple",
        subjectName: "Apple",
      }],
    },
    knownRepositories: [{
      rootPath: "/sources/zsh",
      contentRoots: ["/sources/zsh/zsh"],
      role: "materialized_source",
      source: "beale",
    }],
    materializedSourcePaths: ["/sources/zsh"],
    projectNotes: ["Inspect only the recorded authorized scope."],
  });

  assert.deepEqual(context.memory, {
    sessionId: "run_zftp",
    workspace: { id: "workspace_zsh", name: "Zsh" },
    subject: { id: "subject_apple", name: "Apple" },
  });
  assert.equal("workspaceRoot" in context, false);
  assert.doesNotMatch(JSON.stringify(context), /memory\.sqlite|private\/workspaces/);
  assert.match(JSON.stringify(context), /\/sources\/zsh/);
  assert.match(JSON.stringify(context), /\/sources\/zsh\/zsh/);
});

test("repository content roots become bounded file-read hints", () => {
  const context = createResearchWorkspaceContext({
    workspaceRoot: "/workspaces/zsh",
    knownRepositories: [{
      rootPath: "/sources/zsh/default",
      contentRoots: ["/sources/zsh/default/zsh"],
      role: "materialized_source",
    }],
  });

  assert.deepEqual(workspaceContextFileReadHints(context), [
    "/workspaces/zsh",
    "/sources/zsh/default",
    "/sources/zsh/default/zsh",
  ]);
});

test("memory context selects bounded tiered nodes with evidence and relationships", () => {
  const nodes = [
    memoryNode({
      id: "mem_session_zftp",
      tier: "session",
      type: "hypothesis",
      title: "ZFTP length handling",
      summary: "The ZFTP command parser may mishandle a negative length.",
      evidence: [{
        id: "evidence_zftp",
        kind: "code",
        pathBase: "repository",
        path: "Src/Modules/zftp.c",
        locator: { line: 734 },
        summary: "Length reaches the allocation boundary without a sign check.",
        createdAt: "2026-07-20T12:00:00.000Z",
      }],
    }),
    memoryNode({
      id: "mem_subject_zftp",
      tier: "subject",
      type: "invariant",
      title: "Apple ZFTP module boundary",
      summary: "ZFTP module input must remain length-bounded before allocation.",
    }),
    memoryNode({
      id: "mem_subject_mdns",
      tier: "subject",
      type: "invariant",
      title: "mDNS label compression",
      summary: "DNS labels require bounded pointer traversal.",
    }),
    memoryNode({
      id: "mem_workspace_parser",
      tier: "workspace",
      type: "source",
      title: "Parser entrypoints",
      summary: "General shell parser orientation.",
    }),
  ];
  const context = selectMemoryModelContext({
    nodes,
    edges: [{
      fromId: "mem_session_zftp",
      toId: "mem_subject_zftp",
      relation: "depends_on",
      note: "The candidate crosses this invariant.",
      createdAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    }],
    prompt: "Continue vulnerability research on the ZFTP allocation boundary.",
    maxNodes: 3,
  });

  assert.deepEqual(context.map((node) => node.id), [
    "mem_session_zftp",
    "mem_subject_zftp",
    "mem_workspace_parser",
  ]);
  assert.equal(context[0].evidence[0].path, "Src/Modules/zftp.c");
  assert.deepEqual(context[0].relationships[0], {
    direction: "outgoing",
    relation: "depends_on",
    memoryId: "mem_subject_zftp",
    note: "The candidate crosses this invariant.",
  });
  assert.ok(!context.some((node) => node.id === "mem_subject_mdns"));
});

test("available tool capture summarizes actual tools without duplicating schemas or permissions", () => {
  const context = createAvailableToolContext([{
    name: "repository.search",
    description: "Search materialized source repositories.",
    actionClasses: ["inspect"],
    sideEffects: "read",
    requiredPermissions: ["filesystem:read"],
    inputSchema: { type: "object" },
  }]);

  assert.deepEqual(context, [{
    name: "repository.search",
    description: "Search materialized source repositories.",
    actionClasses: ["inspect"],
    sideEffects: "read",
  }]);
});

test("memory context retrieves an older relevant node beyond the recent context window", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "honeycrisp-model-context-old-"));
  const store = new MemoryGraphStore({ workspaceRoot });
  try {
    const relevant = store.save({
      type: "primitive",
      title: "ZFTP signed length",
      summary: "A negative ZFTP length reaches allocation.",
      status: "confirmed",
      tags: ["zftp"],
    });
    for (let index = 0; index < 100; index += 1) {
      store.save({
        type: "source",
        title: `Recent unrelated source ${index}`,
        summary: "Shell completion orientation.",
      });
    }
    const database = new DatabaseSync(store.databasePath);
    database.prepare("UPDATE memory_nodes SET updated_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000Z",
      relevant.id,
    );
    database.close();

    assert.ok(!store.search({ limit: 100 }).some((node) => node.id === relevant.id));
    const context = compileMemoryModelContext(store, "Inspect the ZFTP allocation length.");
    assert.ok(context.some((node) => node.id === relevant.id));
  } finally {
    store.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function memoryNode(overrides) {
  return {
    id: "mem_default",
    tier: "workspace",
    sessionId: "run_zftp",
    workspaceId: "workspace_zsh",
    workspaceName: "Zsh",
    subjectId: "subject_apple",
    subjectName: "Apple",
    type: "hypothesis",
    title: "Default memory",
    summary: "Default summary",
    body: "Detailed research state.",
    status: "suspected",
    confidence: 0.7,
    assetIds: ["asset_zsh"],
    tags: ["zftp"],
    attributes: {},
    evidence: [],
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}
