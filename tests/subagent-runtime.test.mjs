import assert from "node:assert/strict";
import test from "node:test";

import { SubagentManager } from "../packages/research-agent/dist/index.js";

test("subagent runtime sanitizes partial inheritance and applies explicit overrides", async () => {
  const requests = [];
  const manager = new SubagentManager({
    rootModel: "parent-model",
    rootReasoning: "high",
    async run(request) {
      requests.push(request);
      return resultFor(request, `completed ${request.path}`);
    },
  });
  const tools = toolsByName(manager, "root");
  manager.captureContext("root", "spawn_partial", [
    user("first turn"),
    assistant("first answer"),
    user("second turn"),
    assistantTool("spawn_partial"),
  ]);

  const spawned = await tools.spawn_agent.execute("spawn_partial", {
    task_name: "focused_review",
    message: "Review one boundary.",
    fork_turns: "1",
    model: "child-model",
    reasoning_effort: "low",
  });
  await manager.settle();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/root/focused_review");
  assert.equal(requests[0].model, "child-model");
  assert.equal(requests[0].reasoning, "low");
  assert.deepEqual(requests[0].inheritedMessages.map((message) => message.content), ["second turn"]);
  assert.equal(spawned.details.task_name, "/root/focused_review");
  assert.equal(manager.snapshot().agents[0].status, "completed");

  manager.captureContext("root", "spawn_invalid", [user("root context"), assistantTool("spawn_invalid")]);
  await assert.rejects(
    tools.spawn_agent.execute("spawn_invalid", {
      task_name: "invalid_override",
      message: "This must not launch.",
      fork_turns: "all",
      model: "different-model",
    }),
    /Full-history children inherit/,
  );
});

test("subagent runtime supports mailboxes, idle follow-ups, waiting, listing, and interruption", async () => {
  const requests = [];
  const manager = new SubagentManager({
    rootModel: "parent-model",
    async run(request) {
      requests.push(request);
      return resultFor(request, `result ${requests.length}`);
    },
  });
  const rootTools = toolsByName(manager, "root");
  manager.captureContext("root", "spawn_worker", [user("root context"), assistantTool("spawn_worker")]);
  const spawned = await rootTools.spawn_agent.execute("spawn_worker", {
    task_name: "worker",
    message: "Initial task.",
    fork_turns: "none",
  });
  const childId = spawned.details.agent_id;
  await manager.settle();

  const waiting = await rootTools.wait_agent.execute("wait_1", { timeout_ms: 1000 });
  assert.equal(waiting.details.timed_out, false);
  assert.match(manager.takeMailbox("root")[0].content, /Agent \/root\/worker completed/);

  const listed = await rootTools.list_agents.execute("list_1", {});
  assert.equal(listed.details.agents[0].path, "/root/worker");
  assert.equal(listed.details.agents[0].status, "completed");

  const queued = await rootTools.send_message.execute("message_1", {
    target: childId,
    message: "Context for the next turn.",
  });
  assert.equal(queued.details.triggered_turn, false);
  assert.match(manager.takeMailbox(childId)[0].content, /Context for the next turn/);

  const followup = await rootTools.followup_task.execute("followup_1", {
    target: "/root/worker",
    message: "Perform the follow-up.",
  });
  assert.equal(followup.details.triggered_turn, true);
  await manager.settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].prompt, "Perform the follow-up.");
  assert.deepEqual(manager.takeMailbox(childId), []);

  let started;
  const active = new SubagentManager({
    rootModel: "parent-model",
    run(request) {
      started = request;
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const activeTools = toolsByName(active, "root");
  active.captureContext("root", "spawn_active", [user("root context"), assistantTool("spawn_active")]);
  const activeSpawn = await activeTools.spawn_agent.execute("spawn_active", {
    task_name: "active_worker",
    message: "Long-running task.",
    fork_turns: "none",
  });
  assert.equal(started.path, "/root/active_worker");
  const interrupted = await activeTools.interrupt_agent.execute("interrupt_1", {
    target: activeSpawn.details.agent_id,
  });
  await active.settle();
  assert.equal(interrupted.details.previous_status, "running");
  assert.equal(active.snapshot().agents[0].status, "interrupted");
});

function toolsByName(manager, agentId) {
  return Object.fromEntries(manager.createTools(agentId).map((tool) => [tool.name, tool]));
}

function resultFor(request, text) {
  return {
    messages: [...request.inheritedMessages, user(request.prompt), assistant(text)],
    text,
    turnCount: 1,
    toolCallCount: 0,
    modelCalls: [],
    toolEvents: [],
  };
}

function user(content) {
  return { role: "user", content, timestamp: Date.now() };
}

function assistant(content) {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "faux",
    provider: "faux",
    model: "faux-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantTool(id) {
  return {
    ...assistant(""),
    content: [{ type: "toolCall", id, name: "spawn_agent", arguments: {} }],
    stopReason: "toolUse",
  };
}
