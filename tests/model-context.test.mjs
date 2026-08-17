import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compileMemoryModelContext,
  DEFAULT_SECURITY_RESEARCH_PROFILE,
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
    },
    memoryContext: {
      sessionId: "run_zftp",
      workspaceId: "workspace_zsh",
      workspaceName: "Zsh",
      subjectId: "subject_apple",
      subjectName: "Apple",
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
    resolve("/workspaces/zsh"),
    resolve("/sources/zsh/default"),
    resolve("/sources/zsh/default/zsh"),
  ]);
});

test("memory context prioritizes current memberships and relevant subject knowledge", () => {
  const nodes = [
    memoryNode({
      id: "mem_session_zftp",
      sessionIds: ["run_zftp"],
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
      sessionIds: ["run_mdns"],
      workspaces: [{ id: "workspace_mdns", name: "mDNSResponder" }],
      type: "invariant",
      title: "Apple ZFTP module boundary",
      summary: "ZFTP module input must remain length-bounded before allocation.",
    }),
    memoryNode({
      id: "mem_subject_mdns",
      sessionIds: ["run_mdns"],
      workspaces: [{ id: "workspace_mdns", name: "mDNSResponder" }],
      type: "invariant",
      title: "mDNS label compression",
      summary: "DNS labels require bounded pointer traversal.",
    }),
    memoryNode({
      id: "mem_workspace_parser",
      sessionIds: ["run_older"],
      type: "flow-endpoint",
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
    sessionId: "run_zftp",
    workspaceId: "workspace_zsh",
    maxNodes: 3,
  });

  assert.deepEqual(context.map((node) => node.id), [
    "mem_session_zftp",
    "mem_subject_zftp",
    "mem_workspace_parser",
  ]);
  assert.deepEqual(context[0].evidenceRefs, [{
    id: "evidence_zftp",
    kind: "code",
  }]);
  assert.equal(context[0].evidenceCount, 1);
  assert.equal(context[0].relationshipCount, 1);
  assert.deepEqual(context[0].relatedMemoryIds, ["mem_subject_zftp"]);
  assert.equal(context[0].scope, undefined);
  assert.equal(context[0].body, undefined);
  assert.ok(!context.some((node) => node.id === "mem_subject_mdns"));

  const fullContext = selectMemoryModelContext({
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
    sessionId: "run_zftp",
    workspaceId: "workspace_zsh",
    maxNodes: 1,
    detail: "full",
  });
  assert.equal(fullContext[0].evidence[0].path, "Src/Modules/zftp.c");
  assert.deepEqual(fullContext[0].relationships[0], {
    direction: "outgoing",
    relation: "depends_on",
    memoryId: "mem_subject_zftp",
    note: "The candidate crosses this invariant.",
  });
  assert.deepEqual(fullContext[0].scope, {
    sessions: ["run_zftp"],
    workspaces: [{ id: "workspace_zsh", name: "Zsh" }],
    subject: { id: "subject_apple", name: "Apple" },
  });
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

test("memory context combines prompt terms and loads only candidate edges", () => {
  const node = memoryNode({ id: "mem_candidate", title: "Parser allocation boundary" });
  const searches = [];
  let edgeNodeIds;
  const store = {
    getProfileMemory() {
      return DEFAULT_SECURITY_RESEARCH_PROFILE.memory;
    },
    getContext() {
      return { sessionId: "run_zftp", workspaceId: "workspace_zsh" };
    },
    search(input) {
      searches.push(input);
      return [node];
    },
    listEdgesForNodes(nodeIds) {
      edgeNodeIds = nodeIds;
      return [];
    },
  };

  const context = compileMemoryModelContext(store, "Inspect the parser allocation boundary.");
  const subjectSearches = searches.filter((input) => input.scope === "subject");

  assert.equal(subjectSearches.length, 1);
  assert.ok(subjectSearches[0].query.includes(" "));
  assert.deepEqual(edgeNodeIds, [node.id]);
  assert.deepEqual(context.map((candidate) => candidate.id), [node.id]);
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
      evidence: [{
        kind: "code",
        pathBase: "repository",
        path: "src/zftp.c",
        locator: { line: 42 },
        summary: "Signed length reaches the allocation size.",
      }],
    });
    for (let index = 0; index < 100; index += 1) {
      store.save({
        type: "flow-endpoint",
        title: `Recent unrelated source ${index}`,
        summary: "Shell completion orientation.",
        attributes: { role: "source" },
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

test("memory context honors profile type weights and default budgets", () => {
  const profileMemory = {
    types: [
      {
        id: "background",
        name: "Background",
        pluralName: "Background",
        description: "Low-priority background context.",
        lifecycle: "active",
        creatable: true,
        order: 10,
        defaultStatus: "draft",
        allowedStatuses: ["draft", "accepted", "dismissed"],
        contextWeight: 1,
      },
      {
        id: "decision",
        name: "Decision",
        pluralName: "Decisions",
        description: "High-priority research decisions.",
        lifecycle: "active",
        creatable: true,
        order: 20,
        defaultStatus: "draft",
        allowedStatuses: ["draft", "accepted", "dismissed"],
        contextWeight: 200,
      },
    ],
    statuses: [
      { id: "draft", name: "Draft", description: "In progress.", order: 10, polarity: "neutral" },
      { id: "accepted", name: "Accepted", description: "Accepted result.", order: 20, polarity: "positive" },
      { id: "dismissed", name: "Dismissed", description: "Dismissed result.", order: 30, polarity: "negative" },
    ],
    evidenceKinds: [],
    evidencePathBases: [],
    defaultNodeLimit: 1,
    defaultCharacterBudget: 4_000,
  };
  const selected = selectMemoryModelContext({
    nodes: [
      memoryNode({ id: "mem_background", type: "background", status: "draft" }),
      memoryNode({ id: "mem_decision", type: "decision", status: "draft" }),
    ],
    edges: [],
    prompt: "",
    profileMemory,
  });

  assert.deepEqual(selected.map((node) => node.id), ["mem_decision"]);

  const selectedByStatus = selectMemoryModelContext({
    nodes: [
      memoryNode({ id: "mem_dismissed", type: "background", status: "dismissed" }),
      memoryNode({ id: "mem_accepted", type: "background", status: "accepted" }),
    ],
    edges: [],
    prompt: "",
    profileMemory,
  });
  assert.deepEqual(selectedByStatus.map((node) => node.id), ["mem_accepted"]);
});

function memoryNode(overrides) {
  return {
    id: "mem_default",
    sessionIds: ["run_zftp"],
    workspaces: [{ id: "workspace_zsh", name: "Zsh" }],
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
