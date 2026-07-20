# Architecture

Honeycrisp is a general-purpose research agent built around Pi's native agent loop. It puts useful workspace context, durable knowledge, and tools in front of the selected model, then lets the model plan and decide when the work is complete.

## Core Ownership

- The model owns investigation planning, decomposition, tool use, collaboration, and completion.
- Honeycrisp owns context compilation, tool execution, durable knowledge, storage, orchestration, live events, and flow captures.
- A host such as Beale owns workspace setup, authorization recording, repository references, researcher interaction, and presentation.

Honeycrisp does not maintain an outer goal tree, generated subgoals, a triager, or completion gates.

## Runtime Flow

1. The host or CLI supplies a research request and structured authorized workspace context.
2. Honeycrisp selects concise relevant tiered knowledge from the unified SQLite database.
3. Honeycrisp compiles projected workspace identity, source references, selected memory, and skills into model context. Database paths and storage layout remain runtime-only.
4. Pi runs the selected model with research tools and collaboration tools.
   Honeycrisp retries a model turn when the provider reports a retryable transient failure before emitting substantive output; partial turns and non-retryable failures remain terminal.
5. Research tool observations are appended to the operational event stream. The model explicitly saves or updates concise graph knowledge when it is reusable.
6. The model may spawn bounded child sessions, communicate with them, and incorporate their results.
7. Honeycrisp returns the root response and writes a schema-v4 flow capture containing the root result, child sessions, tools, compiled context, and operational storage metadata.

## Context

The compiled workspace context is guidance, not a repository permission fence. It contains:

- the user's request;
- structured authorization and scope metadata supplied by the host;
- known repositories and materialized source paths;
- bounded session, workspace, and relevant or linked subject memory with stable ids, evidence references, relationships, and revisions; and
- selected skills.

Pi presents the tools themselves through their typed definitions. Honeycrisp enforces permissions and budgets in lifecycle hooks instead of restating that policy as prompt prose. The compiled-context event records concise summaries of the tools actually available for inspection by host interfaces.

Repository paths help the model discover likely source. A repository may include bounded nested content roots when a host checkout wraps the actual project directory. A repository need not be known before research begins, and the same user-global checkout may be referenced by multiple workspaces.

## Native Agent And Subagents

The root session is `/root`. It receives Pi research tools plus these collaboration tools:

- `spawn_agent`
- `send_message`
- `followup_task`
- `interrupt_agent`
- `list_agents`
- `wait_agent`

Each child receives an opaque id and canonical path such as `/root/parser_review`. The initial defaults allow six concurrent children and one child level.

`spawn_agent` accepts `fork_turns: "all"`, `"none"`, or a positive integer string. The runtime removes the unresolved spawning tool call from inherited history. Full-history children inherit the parent's model and reasoning effort. Partial-history or fresh children can select another model available from the active provider and a supported effort.

Messages use per-session mailboxes. `send_message` queues without starting an idle turn. `followup_task` starts another turn for an idle non-root child or reaches a running child at a message boundary. Interrupting a child aborts only its active turn and keeps its session available. Completion and failure notifications are delivered to the parent conversation.

Children share the active workspace, research tool registry, governance, storage, memory tier context, and cancellation boundary. Delegation cannot broaden authorization or permissions.

## Durable Knowledge

Honeycrisp uses the host-compatible SQLite database as the source of truth. The small model-facing memory tool set searches, reads, saves, corrects, and links concise typed knowledge.

Knowledge is tiered by:

- session id for work useful only to the current session;
- workspace for knowledge reusable across sessions on one research target; and
- subject for knowledge reusable across explicitly related workspaces owned by the same subject.

Transcripts, narration, and bulk tool output are operational data, not durable knowledge. Large outputs remain artifact files referenced by concise graph nodes.

The agent searches memory early and when research crosses system boundaries. It records relevant historical bugs with affected assets, user-controlled ingress as sources, dangerous operations as sinks, always-true security rules as invariants, exploitation blockers as mitigations, and reusable sequences of important research actions as trajectories. Routine action narration is not durable knowledge.

Memory queries are tokenized and relevance-ranked across ids, types, content, assets, tags, and evidence. An exact node id embedded in a broader natural-language query remains directly retrievable.

An individual flaw becomes a primitive only with static-analysis support and code or tool evidence. A chain links its sources, primitives, sinks, and assets only after they establish end-to-end attacker reachability and security impact. Confirming a chain additionally requires a realistic proof-of-vulnerability and independent approval from a review subagent; absent or inconclusive review leaves the chain suspected.

## Research Tools

Research tools expose concrete capabilities such as repository search, bounded file reads, structural code intelligence, analysis, experiments, storage inspection, memory access, skills, and configured MCP servers.

Each research tool has a typed schema, action class, side-effect profile, required permissions, and structured result. Honeycrisp enforces tool governance in lifecycle hooks. Collaboration tools are orchestration primitives and remain available when a research-call budget is exhausted.

Tool-backed observations may support confirmed primitives or chains. Model or child prose alone does not become evidence.

## Storage And Capture

The default durable surfaces are:

- `.honeycrisp/memory/memory.sqlite` for operational state and tiered knowledge; and
- `.honeycrisp/memory/artifacts/` for files, raw outputs, logs, generated material, and reproducible scripts.

The shared SQLite database uses an append-only, component-scoped migration ledger. Honeycrisp owns the `honeycrisp_core` sequence and adopts the idempotent graph baseline for databases created before the ledger existed.

Schema-v4 flow captures summarize the request, root result, child session tree, model calls, tool events, compiled context with selected graph knowledge, and storage manifest. Child metadata includes path, parent, lifecycle state, model, effort, inheritance mode, timestamps, result, errors, and usage.

## Trust Boundary

OpenAI credentials remain in the host credential layer. Host-provided authorization is recorded once and inherited by child sessions. Honeycrisp treats external tool content as untrusted input and does not interpret delegation as authorization expansion.

Isolation is an operator and host choice. Allowlisted local experiments are auditable tools, not a security sandbox.

## Current Limits

- Child sessions use models from the root session's active provider.
- Child depth and concurrency are runtime defaults rather than Beale settings.
- Custom role definitions and agent instruction files are not implemented.
- Configured MCP support currently targets stdio servers.
- Tree-sitter code intelligence is structural assistance, not full semantic or taint analysis.
- Integration health checks are deterministic tests plus bounded real sessions, not a portable live-model CI job.
