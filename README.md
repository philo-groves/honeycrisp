# Honeycrisp

Honeycrisp is an experimental autonomous research agent for open-ended work such as vulnerability research, mathematics, puzzles, and evidence synthesis.

Honeycrisp is based on Pi's published core packages:

- `@earendil-works/pi-ai` for cross-provider model support.
- `@earendil-works/pi-agent-core` for the agent runtime, tool calling, and state management.

Honeycrisp is not a fork of Pi and is not an implementation of `pi-coding-agent`. This repository should contain the research-agent functionality around Pi, not local replacements for Pi's core packages.

## Packages

- `@honeycrisp/research-agent`: workspace context, durable memory, tools, and a Pi-backed agent runtime.
- `honeycrisp`: command-line entry point for running research prompts.

## Development

```sh
pnpm install
pnpm build
pnpm start -p "Investigate the parser behavior in this workspace"
```

Honeycrisp passes the request, authorized workspace and source context, bounded graph memory, and selected skills to Pi's native agent loop. Pi supplies the actual research and collaboration tool definitions separately. Internal database and artifact paths are runtime details rather than prompt guidance. The model owns investigation planning and tool use; Honeycrisp does not create a parallel goal tree, subgoal controller, or structured scan workflow.

Pass `--goal` to keep one flat objective active across root responses in the same Pi session. Goal lifecycle state is host-managed: the model stays focused on research and records `session.disposition`, from which Honeycrisp infers completion or a strict blocker. A goal completes from a validated `objective_achieved` disposition and stops as blocked when a valid disposition says further progress requires concrete external state. Partial results, uncertainty, and ordinary response boundaries receive a short continuation without model-facing goal-control tools.

Frontends that expand a short direction into a detailed research prompt should pass the original direction with `--goal-objective`. This keeps the persistent objective concise and separate from the generated prompt; the option also enables goal mode.

```sh
pnpm start --goal -p "Find and verify a high-impact vulnerability in the authorized target"

pnpm start --goal-objective "Investigate authorization boundaries" -p "<expanded research prompt>"
```

The Pi agent can delegate bounded independent work through Codex-style collaboration tools: `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, and `wait_agent`. Children share the current workspace, tool policy, storage, and memory context. A child may inherit all, none, or the last N user turns. Full-history children inherit the parent model and effort; partial or fresh children may choose another model from the active provider and a supported effort. The initial runtime permits six concurrent children at one level of depth. Collaboration waits are capped at one minute and return immediately when the caller has no running descendants. A model stream that produces no response content for three minutes is aborted and retried through the transient-error path. Retryable provider failures recover in the same session with bounded backoff and terminate after four unsuccessful retries. Safety or cyber guardrail errors receive one automatic transcript-aware recovery; if the safeguard repeats, the affected root or child waits interruptibly for host steering, which is broadcast to every active agent before their next provider call.

On a real run, Honeycrisp opens the user-global database at `~/.honeycrisp/memory.sqlite`, exposes configured research tools plus a small durable knowledge graph and workspace runbook family, and runs the selected model through Pi. Records retain their workspace, session, and subject identities so one database can serve headless and host-driven research across workspaces. Run state, transcripts, and tool traces are operational data; they are not automatically promoted into durable knowledge. The model explicitly searches and updates concise reusable nodes when the research warrants it.

Before its final response, the root agent records one structured `session.disposition` with the evidence-grounded outcome, unresolved blocker dependencies, and whether progress requires external state. Honeycrisp captures that disposition for hosts and supplies a conservative fallback when the agent or provider terminates before recording one; subagents cannot finalize the root session.

Every durable graph node belongs to exactly one subject and records lists of the sessions and workspaces in which it was saved or corrected. Updating the same subject-visible type-and-title identity from another session or workspace refines it in place and appends that context instead of creating a copy. `memory.search` queries current-workspace associations by default and accepts current-session or whole-subject scope. Subject ownership is enforced even though records share one database.

Runbooks are workspace-scoped, revisioned Jupyter `nbformat 4` artifacts for reusable proof sequences, environment setup, diagnostics, and investigation procedures. `runbook.list`, `runbook.get`, `runbook.create`, and `runbook.append` preserve ordered markdown/code cells and bounded decisive outputs. Honeycrisp does not require Jupyter and never executes a notebook directly; commands remain subject to the normal `shell.run` broker and its utility controls.

Run with stored auth. If no config is provided, Honeycrisp first checks `.honeycrisp/config.json` under `--workspace-root`, then falls back to the first authorized provider/model from the CLI auth store. A config file is only a model preference file; credentials still come from `honeycrisp auth login`.

```sh
pnpm start \
  --max-tokens 1800 \
  -p "Produce a research plan for the local parser implementation"
```

Optional model preference config:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "effort": "high"
}
```

```sh
pnpm start --config ./honeycrisp.config.json -p "Produce a research plan for the local parser implementation"
```

The project config can also be managed through the CLI:

```sh
pnpm start config set provider openai-codex
pnpm start config set model gpt-5.6-sol
pnpm start config set effort high
pnpm start config show
```

CLI flags such as `--provider`, `--model`, and `--effort` override the config file for a run. The selected provider/model must already be authorized through the auth CLI.

Hosts may pass `--title-model <model>` with `--title-effort <level>` to generate a short prompt-derived session title concurrently with the research run. Successful titles are emitted as `session.title` live events when `--event-stream` is active; title failures do not interrupt research.

Inspect the provider models and model-specific reasoning levels supplied by the installed Pi runtime with:

```sh
pnpm start models list
pnpm start models list anthropic --json
```

Use `--mock` for deterministic offline practice runs that do not make model calls.

```sh
pnpm start --mock -p "Produce a research plan for the local parser implementation"
```

For local practice runs, Honeycrisp can capture bounded read-only inspection
events, execute configured tools, and write a flow-capture artifact:

```sh
pnpm start --mock \
  --inspect-root /path/to/project \
  --inspect-path /path/to/project/src/file.c \
  --inspect-bytes 1024 \
  --capture .honeycrisp-runs/example-flow.json \
  -p "Review the local source evidence"
```

The schema-v5 capture records the request, agent result, optional goal state, model/tool metadata,
event timeline, bounded memory context, storage manifest, and workspace context.
Real Pi-agent captures also retain compatible resumable messages, host-managed goal progress, bounded research-focus state, the latest native-compaction identity, and their provider session-affinity identifier in `agent.raw.resumableState`, including provider-encrypted reasoning and compaction items but never host credentials. A host can pass a stable run identifier with `--session-id` and the prior artifact with `--resume-capture`; `--resume-fallback-prompt` supplies bounded reconstructed context when the capture is missing, legacy, malformed, or uses a different provider/model.
Private model thought traces are not persisted in graph memory.
Subagent identity, lifecycle, model calls, result text, and errors are retained in `agent.raw.subagents` in the flow capture. Research tool events produced by children remain part of the same authorized session event stream. Every collaboration call also emits caller-attributed `tool.requested` and `tool.observed` events, including failed calls, so root and child coordination is visible live and remains replayable from the capture.

Long-running root and child sessions keep their active model context bounded independently of the stored trace. Each root sends one stable Pi `sessionId` on every model call, while each subagent derives its own stable affinity key so parallel provider caches and WebSocket state do not collide. OpenAI Responses models request provider-native compaction before Honeycrisp's local context fallback and replay the returned opaque compaction item on later turns. Other providers, and context-window retries, retain the local policy that preserves the task and recent turns while compacting older bulky tool results. Honeycrisp restores exactly one bounded checkpoint of recent distinct evidence actions after each compaction as a distinct host-data assistant record followed by a constant continuation notice, leaving real tool results unchanged. The checkpoint includes the decisive bounded result rather than only a success label. Honeycrisp temporarily blocks a third unchanged memory or runbook recall, permits a later state probe, leaves collaboration polling available, and steers sustained tool-only no-progress loops back to target research or disposition. Full tool observations remain available in the research event stream and durable memory remains the source for reusable research state.

Durable knowledge uses typed nodes (`asset`, `bug`, `invariant`, `mitigation`, `source`, `sink`, `hypothesis`, `primitive`, `chain`, `procedure`, and `trajectory`), directed relationships, tags, asset links, and lightweight evidence references. A `hypothesis` is a specific, testable but unproven proposition: keep it suspected while active, reject it when disproven, and reclassify it as a primitive or chain when proven. `evidence` and `finding` are not node types; evidence remains attached references and proven flaws are primitives or chains. Saves are additive; exact corrections require the current node revision. Transcripts, task narration, and bulk tool output do not belong in the graph.

Large raw outputs and generated artifacts remain files under `~/.honeycrisp/artifacts/`; runbooks live under its `runbooks/<workspace-id>/` family, while graph evidence stores relative pointers and locators rather than copying file contents into SQLite. Host interfaces such as Beale use the same SQLite file for compatible headless and desktop operation. Honeycrisp owns this database contract; interface-specific visualization and disclosure/export flows can add operational tables without creating a second database.

An end-to-end real health check should use the same integrated path users rely on:

```sh
pnpm start config set provider openai-codex --workspace-root .honeycrisp-health
pnpm start config set model gpt-5.6-sol --workspace-root .honeycrisp-health
pnpm start config set effort high --workspace-root .honeycrisp-health

pnpm start \
  --workspace-root .honeycrisp-health \
  --repo-root /path/to/local/research-target \
  --file-read-root /path/to/local/research-target \
  --tool-family storage \
  --allowed-side-effect read \
  --tool-max-calls 2 \
  --capture .honeycrisp-health/flow.json \
  -p "Inspect the local target and summarize one evidence-backed security observation"
```

Review the capture for `runtimeConfig.modelConfig.source`, `runtimeConfig.toolConfig`, selected tools, injected graph-memory context, storage directories, storage manifest entries, and tool events. Runtime tool preferences may be persisted with `honeycrisp tools config ...`, which writes `.honeycrisp/tools.json` under the workspace by default. Add `--mcp-config` plus `--allow-mcp-server` for one-off live MCP server runs, or persist them with `tools config set mcp-config <path>` and `tools config add allow-mcp-server <name>`.

### Host control stream

Hosts can add `--control-stream` to send schema-versioned JSONL commands over
stdin while a run is active:

```jsonl
{"schemaVersion":1,"type":"pause"}
{"schemaVersion":1,"type":"resume"}
{"schemaVersion":1,"type":"steer","requestId":"steer-42","instruction":"Inspect the authorization boundary next."}
{"schemaVersion":1,"type":"configure","modelSelection":{"provider":"openai-codex","model":"gpt-5.6-sol","reasoningEffort":"high"}}
{"schemaVersion":1,"type":"stop"}
```

Pause holds the agent at its next safe turn boundary until resume arrives.
Steering is injected as a user message into the active Pi agent loop before its
next model turn. Stop aborts the root and every pending or running child. With
`--event-stream`, accepted or rejected control messages
are reported as `agent.event` records with `eventType: "control.received"`.
Any control may include a non-empty `requestId` of at most 200 characters; the
accepted or rejected event echoes it so a host can correlate stdin delivery.
Model selections received through `configure` or `steer` apply to the root
agent's next provider call; they do not interrupt an in-flight call.

## Auth

Honeycrisp stores provider credentials in `~/.honeycrisp/auth.json` by default, or the path set in `HONEYCRISP_AUTH_FILE`.

When launched by a host workbench, `HONEYCRISP_CODEX_AUTH_FILE` may point to an existing Codex `auth.json`. Honeycrisp uses the fresher `openai-codex` OAuth credential without modifying the Codex file; any refreshed credential is written to Honeycrisp's own auth file.

```sh
pnpm start auth list
pnpm start auth login openai-codex
pnpm start auth status openai-codex
pnpm start auth verify openai-codex
```
