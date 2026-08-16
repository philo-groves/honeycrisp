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

Honeycrisp supports bounded independent delegation and atomic provider-neutral collaboration rooms through `create_room`, `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, `wait_agent`, `room_status`, `room_publish`, and `room_wait`. Room members share the current workspace, tool policy, storage, and memory context, but begin from fresh context by default. Each room withholds independent memos until every member submits, then coordinates a bounded targeted-challenge and response protocol before the lead records the synthesized outcome. Packets carry evidence references, confidence, uncertainty, and a proposed next experiment; unresolved rooms prevent the lead from finalizing. A profile may select workflow-specific roles and synthesis requirements, so Security Research and Mathematics use separate domain protocols. Independent children can still inherit all, none, or the last N user turns. Full-history children inherit the parent model and effort; partial or fresh children may use an enabled provider/model route. Collaboration waits are bounded and room-aware. A model stream that produces no response content for three minutes is aborted and retried through the transient-error path. Retryable provider failures recover in the same session with bounded backoff and terminate after four unsuccessful retries. Safety or cyber guardrail errors receive one automatic transcript-aware recovery; if the safeguard repeats, the affected root or child waits interruptibly for host steering, which is broadcast to every active agent before their next provider call.

On a real run, Honeycrisp opens the user-global database at `~/.honeycrisp/memory.sqlite`, exposes configured research tools plus a small durable knowledge graph and workspace runbook family, and runs the selected model through Pi. Records retain their workspace, session, and subject identities so one database can serve headless and host-driven research across workspaces. Run state, transcripts, and tool traces are operational data; they are not automatically promoted into durable knowledge. The model explicitly searches and updates concise reusable nodes when the research warrants it.

Before its final response, the root agent records one structured `session.disposition` with the evidence-grounded outcome, unresolved blocker dependencies, and whether progress requires external state. Honeycrisp captures that disposition for hosts and supplies a conservative fallback when the agent or provider terminates before recording one; subagents cannot finalize the root session.

Every durable graph node belongs to exactly one subject and records lists of the sessions and workspaces in which it was saved or corrected. Updating the same subject-visible type-and-title identity from another session or workspace refines it in place and appends that context instead of creating a copy. `memory.search` queries current-workspace associations by default and accepts current-session or whole-subject scope. Subject ownership is enforced even though records share one database.

Runbooks are workspace-scoped, revisioned Jupyter `nbformat 4` artifacts for reusable proof sequences, environment setup, diagnostics, and investigation procedures. `runbook.list`, `runbook.get`, `runbook.create`, and `runbook.append` preserve ordered markdown/code cells and bounded decisive outputs. Honeycrisp does not require Jupyter and never executes a notebook directly; commands remain subject to the normal `shell.run` broker and its utility controls.

## Research profiles

Honeycrisp is a general research harness with bundled `security-research` and `mathematics` profiles; security research remains the default. A research profile controls the agent role and posture, workflows, collaboration recipes, durable-memory vocabulary and validation, capability requests and feature switches, workspace language, auxiliary model jobs, and presentation labels. It does not replace host safety policy or grant authority.

Honeycrisp resolves one profile before a run, in this order:

1. `--profile <path>` or a host-supplied resolved snapshot.
2. `.honeycrisp/profile.json` under `--workspace-root`.
3. The bundled `security-research` profile.

The normalized profile and its domain-separated SHA-256 hash are captured with the run. Resumes must use the same hash. Hosts can resolve and validate the exact wire contract without starting research:

```sh
pnpm start profile resolve --workspace-root . --json
pnpm start profile resolve --workspace-root . --profile-id mathematics --json
pnpm start profile resolve --workspace-root . --profile ./profile.json --json
```

[`examples/general-research.profile.json`](examples/general-research.profile.json) is a complete non-security example. Copy it to `.honeycrisp/profile.json`, then change its durable IDs, labels, workflows, and requirements for the domain:

```sh
mkdir -p .honeycrisp
cp examples/general-research.profile.json .honeycrisp/profile.json
pnpm start profile resolve --workspace-root . --json
```

Profile schema version 1 is strict: misspelled or unknown fields fail resolution instead of being silently discarded. The main sections are:

- `agent`: role, posture, style, memory guidance, and runbook guidance.
- `memory`: types, statuses, evidence kinds and path bases, advisory relation vocabulary, context budgets, typed attributes, and conditional requirements.
- `workflows`: any number of named research modes with goal-suggestion, prompt, and output guidance.
- `collaboration`: profile-only protocol guidance and workflow-specific room recipes with heterogeneous roles and synthesis requirements.
- `capabilities`: requested tool-family defaults, restrictions, and feature switches for memory, runbooks, and collaboration.
- `workspace`: domain nouns, material kinds, boundary guidance, and whether authorization is required for live network use.
- `modelJobs`: optional provider/model/effort routes for session titles, prompt generation, goal suggestions, memory curation, and shell review.
- `presentation`: user-facing labels for research, memory, runbooks, and sessions.

Treat every catalog `id` as durable data and model-contract identity. `name`, `pluralName`, descriptions, ordering, icons, and colors may change without rewriting stored nodes. Renaming an ID is a migration or reclassification, not a presentation rename. To remove a memory type, retain its ID with `lifecycle: "retired"` and `creatable: false`; an optional `replacedBy` points at its active successor. Stored retired or unknown IDs stay readable and can be repaired or reclassified, while new writes and relevant state transitions are checked against the active profile. Aliases canonicalize new inputs to the durable ID.

Requirements may be unconditional or limited to named statuses, and can require attributes, evidence, asset links, or neighboring memory types. `memory.save` and `memory.correct` accept outgoing `links` atomically with the node write so a required neighbor can be satisfied without creating an invalid intermediate revision. Attribute schemas are selected by node type, including when two types give the same attribute key different definitions. The bundled security profile requires evidence when a primitive or chain becomes `confirmed`; older rows are grandfathered for reads and unrelated corrections. Relationships remain open strings even when a profile supplies a recommended relation catalog.

Honeycrisp hashes the normalized memory catalog separately from the full research profile and records that immutable catalog provenance on new nodes and validated revisions. That exact hash is provenance, not a blanket compatibility boundary: recall compares each stored node's type, status, attributes, requirements, and referenced evidence/path semantics with the active catalog. Presentation changes and unrelated additive catalog entries therefore preserve compatible knowledge and stable identities, while materially incompatible nodes remain discoverable only for explicit migration or reclassification. Pre-provenance rows remain readable as `legacy_unrecorded`, are never falsely backfilled, and are admitted to ordinary recall only for the bundled security-compatible lineage rather than leaking into arbitrary general profiles. Profiles with memory disabled may use an empty memory catalog without constructing unusable memory tools.

Standalone `memory save` and `memory correct` commands accept profile-defined node data through `--attributes-json <object>` and repeatable `--evidence-json <object-or-array>`. Attribute input is limited to 64,000 JSON characters. Evidence input is limited to 64,000 characters per option, 256,000 characters total, and 64 items; each item has `kind`, `locator`, `summary`, and optional `pathBase` and `path` fields. The active profile remains authoritative for attribute types, required fields, evidence kinds, and path rules.

Capability entries remain inside host authority. Only the code-owned `bundled-default` source contributes its deliberate local `shell` and `none`/`read`/`write`/`process` defaults without another host declaration. A workspace profile, `--profile`, or `--resolved-research-profile` has no executable authority by itself. A host may grant a family or side effect directly with `--tool-family` and `--allowed-side-effect`, or let the profile choose requested defaults within repeatable `--profile-tool-family-ceiling` and `--profile-side-effect-ceiling` bounds. Profile family disables act as defaults, an explicit host family grant can override them, and an explicit host disable always wins. Network cannot be delegated through a profile ceiling; network effects, MCP configuration and server allowlists, skill directories, and skill selection are always explicit host-only inputs. `capabilities.allowedMcpServerIds` is only an additional restriction on that host allowlist: a non-empty list intersects it, while an empty list applies no additional profile restriction. It never configures or authorizes an MCP server.

Host workbenches should pass `--no-default-tool-config` when `.honeycrisp/tools.json` is not part of their trusted configuration boundary, then provide every granted family, side effect, MCP server, and skill explicitly. Fixed protections for authorization boundaries, host credentials, global storage, and protected paths remain in force for every profile.

Profile feature switches choose harness topology inside that boundary: memory and runbook tools still require the effective host side effects, and collaboration agents inherit the root tool registry and governance unchanged. A profile can therefore request collaboration or durable-research features, but neither a root agent nor a subagent can use them to expand the host-granted capability set.

Shell authorization records recognized network intent for review and audit, but Honeycrisp does not apply network profiles, destination allowlists, or an application-level network veto. Network commands proceed through the selected Danger Mode, Manual Approval, or Auto-Review flow like other commands. Auto-Review receives compact trusted authorization and operator-managed execution context; when its reviewer returns a valid denial, Honeycrisp can pause for a correlated human decision that applies to that command only. Reviewer failures remain fail-closed. Because Honeycrisp runs target processes with the current user's host privileges, engineers must enforce any required network isolation with an externally launched VM/container, host firewall, proxy, or equivalent system boundary.

`shell.run` accepts either a complete platform shell `command` for pipelines, chaining, redirects, and other shell syntax, or a direct `utility` plus `args` tuple. Direct utilities may be executable paths. HOME-family environment variables are inherited from the host; credential-like environment values remain filtered, and every normalized invocation still passes through the selected shell authorization mode before spawn.

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
Real Pi-agent captures also retain compatible resumable messages, host-managed goal progress, bounded research-focus state, the latest native-compaction identity, and their provider session-affinity identifier in `agent.raw.resumableState`, including provider-encrypted reasoning and compaction items but never host credentials. A host can pass a stable run identifier with `--session-id` and the prior artifact with `--resume-capture`; `--resume-fallback-prompt` supplies bounded reconstructed context when the capture is missing, legacy, malformed, or uses a different provider/model. Hosts can use `--resume-fallback-prompt-file` to supply the same UTF-8 content without placing large reconstructed context on the process command line.
Private model thought traces are not persisted in graph memory.
Subagent identity, lifecycle, model calls, result text, and errors are retained in `agent.raw.subagents` in the flow capture. Research tool events produced by children remain part of the same authorized session event stream. Every collaboration call also emits caller-attributed `tool.requested` and `tool.observed` events, including failed calls, so root and child coordination is visible live and remains replayable from the capture.

Long-running root and child sessions keep their active model context bounded independently of the stored trace. Each root sends one stable Pi `sessionId` on every model call, while each subagent derives its own stable affinity key so parallel provider caches and WebSocket state do not collide. OpenAI Responses models request provider-native compaction before Honeycrisp's local context fallback and replay the returned opaque compaction item on later turns. Other providers, and context-window retries, retain the local policy that preserves the task and recent turns while compacting older bulky tool results. Honeycrisp restores exactly one bounded checkpoint of recent distinct evidence actions after each compaction as a distinct host-data assistant record followed by a constant continuation notice, leaving real tool results unchanged. The checkpoint includes the decisive bounded result rather than only a success label. Honeycrisp temporarily blocks a third unchanged memory or runbook recall, permits a later state probe, leaves collaboration polling available, and steers sustained tool-only no-progress loops back to target research or disposition. Full tool observations remain available in the research event stream and durable memory remains the source for reusable research state.

Under the bundled security profile, durable knowledge uses `asset`, `bug`, `invariant`, `mitigation`, `source`, `sink`, `hypothesis`, `primitive`, `chain`, `procedure`, and `trajectory` nodes, plus directed relationships, tags, asset links, and lightweight evidence references. A `hypothesis` is a specific, testable but unproven proposition: keep it draft or suspected while active, reject it when disproven, and reclassify it as a primitive or chain when proven. `evidence` and `finding` are not node types in that profile; evidence remains attached references and proven flaws are primitives or chains. Other profiles may define entirely different stable IDs and display names. Saves are additive; exact corrections require the current node revision. Transcripts, task narration, and bulk tool output do not belong in the graph.

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

`repository.search` accepts a configured repository path or label as a context hint and also accepts any readable absolute directory path in its `root` input. `file.read` likewise treats workspace and repository roots as context hints rather than access fences. Both tools run with the current user's host filesystem permissions; use an operator-managed VM or container when filesystem isolation is required.

### Host WebSocket transport

Clients can launch a run with `--websocket-transport --session-id <id>` and set a random `HONEYCRISP_TRANSPORT_TOKEN` in the child environment. Honeycrisp binds an ephemeral endpoint to `127.0.0.1` and writes one non-secret `HONEYCRISP_TRANSPORT` bootstrap record to stdout. The client authenticates with `Authorization: Bearer <token>`, then sends `client.hello` as its first message. Protocol v1 uses client-neutral envelopes:

```json
{"protocolVersion":1,"type":"client.hello","sessionId":"session-1","client":{"name":"example","version":"1.0.0"}}
{"protocolVersion":1,"type":"session.control","sessionId":"session-1","requestId":"steer-42","control":{"schemaVersion":1,"type":"steer","requestId":"steer-42","instruction":"Inspect the authorization boundary next."}}
```

Honeycrisp replies with `server.hello`, streams existing live event objects inside `session.event`, and reports accepted or rejected controls as `control.received` agent events. One authenticated client is allowed per run. Messages are capped at 1 MiB, and disconnecting that client stops the active run. The bearer token is never included in the bootstrap record. TypeScript clients can import the public envelope types and constants from `honeycrisp/websocket-protocol`.

The older `--event-stream` and `--control-stream` flags remain available for compatibility with existing hosts. When `--websocket-transport` is present, WebSocket event and control delivery takes precedence.

Honeycrisp's transport-neutral client contract is versioned separately from individual data schemas. `honeycrisp protocol describe --json` returns the supported protocol version, operations, CLI framing, and WebSocket capabilities in a standard success envelope. TypeScript clients can import the shared envelopes and descriptor types from `honeycrisp/protocol`; WebSocket-specific messages remain available from `honeycrisp/websocket-protocol` and use the same protocol version.

Pause holds the agent at its next safe turn boundary until resume arrives.
Steering is injected as a user message into the active Pi agent loop before its
next model turn. Stop aborts the root and every pending or running child. Accepted or rejected control messages are reported as `agent.event` records with `eventType: "control.received"`.
Any control may include a non-empty `requestId` of at most 200 characters; the
accepted or rejected event echoes it so a client can correlate delivery.
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
