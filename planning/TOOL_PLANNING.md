# Tool Layer Implementation Plan

This plan turns the architecture's tool layer into an incremental implementation path. It is intentionally lighter than the memory plan: tools should stay small, bounded, and replaceable while memory remains the durable source of truth.

The guiding principle is:

1. The memory controller selects the next action policy.
2. The processing layer validates and executes bounded tool actions.
3. Tool calls and results are retained as events before memory derives evidence, claims, procedures, or follow-up work.
4. Domain alignment comes from skills and configured tool surfaces, not from hard-coding research strategy into individual tools.

Tools should expose capability, not decide research direction. Skills should shape context, constraints, procedures, and domain expectations, not bypass governance or memory provenance.

## Tracking Rules

Update the checklists in this file as each implementation increment lands. Keep checklist status tied to verified behavior, not intent.

- `[x]` means implemented and verified.
- `[ ]` means not implemented yet.
- If a phase changes direction, update that phase before implementation begins.
- Keep each session scoped to the requested phase unless the user explicitly expands scope.

## Current Baseline

The project already has a first executable tool slice:

- `ResearchToolRegistry` registers executable tools and exposes provider-safe tool schemas.
- `local.inspection` is executable as a read-only local filesystem tool.
- The Pi loop executor exposes tool schemas to the model, executes native provider tool calls, and recovers textual tool-action JSON as a fallback.
- Tool execution emits `tool.requested` and `tool.observed` events.
- Bootstrap appends tool events before `loop.processed`, allowing memory routing to treat tool observations as direct evidence.
- Real smoke testing has proven one model-initiated local inspection call against the zsh corpus.
- The memory controller can propose obvious local inspection actions from prompt paths, and the loop processor executes accepted controller-planned evidence tools before the first model call.
- Deterministic mock mode can execute controller-planned evidence tools without a model call when an executable registry is supplied.
- The tool registry validates input and output schemas, governance action classes, side effects, required permissions, per-loop call budgets, runtime budgets, and file byte/count budgets. Validation failures are preserved as blocked tool observations.
- Top-level CLI runs append runtime events to the SQLite `MemoryEventLog` by default.
- Large `tool.observed.result` payloads spill to `.honeycrisp/memory/artifacts/tool-results/` with `rawOutputRef`, byte count, and SHA-256 hash metadata while preserving summaries and evidence extracts inline.
- Artifact lifecycle cleanup has an auditable `artifact.tombstoned` event helper with optional local file deletion.
- MCP clients can be adapted into Honeycrisp tools through an allowlisted connector abstraction. MCP tools, resource reads, and resource-template discovery preserve MCP provenance and normalize external content as untrusted output.
- Skills can be registered, loaded from local `SKILL.md` directories, created from MCP metadata, selected from prompt/memory/user ids, and injected as auditable context. Skill runbooks can appear as candidate procedural refs, but skills cannot grant tool permission or override governance.
- Built-in tool families can now be registered from the library layer for memory recall, repository search, structured file reads, deterministic analysis transforms, allowlisted experiments, and deterministic synthesis. Each built-in preserves a canonical dotted Honeycrisp name plus a provider-safe transport alias.
- A Pi Agent lifecycle executor is available from the library layer. It maps Honeycrisp tools to Pi `AgentTool`s, uses Agent tool hooks for governance preflight and event capture, supports sequential or parallel tool batches, and keeps the older `completeSimple` executor as the fallback/default path.
- The CLI can configure tool families, side-effect and budget governance, selected local skills, MCP server allowlists, and the Agent executor. `honeycrisp tools list` exposes the configured registry, MCP allowlist status, and selected skills, and flow captures include runtime tool configuration metadata.
- Tool evaluation stays focused on generic surfaces: built-in tools, MCP adapters, skill selection, governance, Agent lifecycle execution, and durable tool events. Domain-specific research behavior is expected to come from user-provided MCP servers, local skills, and configured tool families rather than packaged Honeycrisp harnesses.

Known limitations to address:

- The CLI supports local inspection, repository search, file read, analysis, and synthesis families; allowlisted experiment functions still need a safer operator configuration shape.
- MCP server allowlists are visible in CLI config and capture output, and evaluation fixtures exercise MCP discovery/execution, but live MCP client discovery still requires a configured client integration.

## Phase 1: Core Tool Contract And Local Inspection Bridge

Introduce the minimal tool action contract, registry, model bridge, and first executable local inspection tool.

Status: completed on 2026-06-24.

Checklist:

- [x] Add a `ResearchToolAction` contract with action class, tool name, inputs, budget hints, and writeback targets.
- [x] Add a `ResearchExecutableTool` interface around tool descriptors and execution.
- [x] Add a `ResearchToolRegistry`.
- [x] Preserve canonical Honeycrisp tool names while supporting provider-safe transport names.
- [x] Convert `local.inspection` into an executable registered tool.
- [x] Expose registered tool schemas to Pi model calls.
- [x] Execute native provider tool calls during loop processing.
- [x] Recover textual tool-action JSON as a fallback for models that emit tool requests as text.
- [x] Feed tool results back to the model before final loop output.
- [x] Emit `tool.requested` and `tool.observed` events.
- [x] Route tool observations back into memory as direct evidence.
- [x] Add tests for native tool calls.
- [x] Add tests for textual tool-call recovery.
- [x] Add a live smoke capture proving a model-initiated local inspection call.

## Phase 2: Controller-Planned Tool Actions

Move tool choice from opportunistic model behavior toward the architecture's intended flow: the memory controller proposes candidate tool actions and the processing layer validates and executes them.

Status: completed on 2026-06-24.

Checklist:

- [x] Extend `ResearchMemoryControllerDecision` with candidate tool actions.
- [x] Include concrete tool name and normalized inputs in controller decisions when obvious from prompt, memory, and available tools.
- [x] Preserve the selected action class as the primary policy decision.
- [x] Teach loop planning to include proposed tool actions in the loop prompt and context packet.
- [x] Make the Pi loop prefer controller-proposed actions before free-form tool choice.
- [x] Add a no-model execution path for deterministic controller-planned tools when the action is purely evidence gathering.
- [x] Record rejected or skipped candidate tool actions with explicit reasons.
- [x] Add tests for controller-planned local inspection.
- [x] Add tests proving tools do not execute when their action class is not selected or permitted.

Verification:

- `pnpm test` passed with 78 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/08-real-controller-planned-tool.json`.
- The health check showed one controller-planned `local.inspection` action, `plannedToolCallCount: 1`, one model call, and tool evidence routed into direct memory evidence.

## Phase 3: Tool Validation, Permissions, And Budgets

Harden tool execution so every call is checked against schemas, governance policy, side effects, and budgets before it can run.

Status: completed on 2026-06-24.

Checklist:

- [x] Validate tool inputs against registered schemas.
- [x] Add output schema support for normalized tool results.
- [x] Enforce allowed and denied action classes from governance policy.
- [x] Enforce side-effect policy: `none`, `read`, `write`, `network`, and `process`.
- [x] Enforce required permissions declared by each tool.
- [x] Enforce per-loop `maxToolCalls`.
- [x] Enforce per-tool or per-loop runtime budgets.
- [x] Enforce file-count and byte-count budgets for file tools.
- [x] Preserve validation errors as structured blocked tool results.
- [x] Add validation hooks before and after execution.
- [x] Add tests for schema rejection, side-effect rejection, permission rejection, and budget exhaustion.

Verification:

- `pnpm test` passed with 81 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/09-real-validated-tool.json`.
- The health check showed the authorized `local.inspection` read completed under registry validation, with `plannedToolCallCount: 1`, no skipped candidates, and direct evidence routed into memory.

## Phase 4: Durable Tool Events And Artifact Storage

Make tool results storage-friendly and durable by default, especially for large outputs, logs, traces, and generated artifacts.

Status: completed on 2026-06-24.

Checklist:

- [x] Write top-level runtime tool events through the SQLite `MemoryEventLog` by default.
- [x] Store large raw tool outputs outside event payloads under `.honeycrisp/memory/artifacts/`.
- [x] Add artifact metadata rows or references for tool-generated files.
- [x] Replace large inline payload fields with raw output pointers when size thresholds are exceeded.
- [x] Preserve small summaries and evidence extracts inline for routing.
- [x] Hash raw outputs and artifact payloads for integrity.
- [x] Add cleanup and tombstone behavior for tool artifacts under memory lifecycle policy.
- [x] Add tests for large output spillover.
- [x] Add tests for artifact refs surviving restart.

Verification:

- `pnpm test` passed with 84 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/10-real-durable-tool-events.json`.
- Durable SQLite workspace: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/phase4-memory`.
- The persisted `tool.observed` event kept summary/evidence inline, removed the large `result` payload, and added `rawOutputRef`, `rawOutputHash`, `rawOutputBytes`, and a `tool_raw_output` artifact ref under `.honeycrisp/memory/artifacts/tool-results/`.

## Phase 5: MCP Tool Support

Add MCP as a first-class tool source so Honeycrisp can use external and local capability providers without hard-coding every integration.

Status: completed on 2026-06-24.

Checklist:

- [x] Add an MCP connector abstraction that can list available servers, tools, resources, and resource templates.
- [x] Map MCP tools into `ResearchToolDescriptor` and `ResearchExecutableTool`.
- [x] Preserve MCP server name, tool name, schema, permissions, and provenance in descriptors.
- [x] Support allowlisted MCP servers only by default.
- [x] Treat MCP tool outputs and resource contents as untrusted external content.
- [x] Normalize MCP results into tool execution results and events.
- [x] Add support for MCP resource reads as `inspect` actions.
- [x] Add support for MCP tool calls as `search`, `analyze`, `experiment`, or `synthesize` actions based on descriptor metadata.
- [x] Add timeout, cancellation, and error handling around MCP calls.
- [x] Add MCP capability discovery to debug output.
- [x] Add tests using a fake MCP server/tool.
- [x] Add tests proving denied MCP servers or tools cannot execute.

Verification:

- `pnpm test` passed with 86 tests on 2026-06-24.
- Fake MCP tests cover allowlisted tool execution, resource reads, resource-template discovery, untrusted output normalization, denied servers, and timeout handling.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/11-real-mcp-layer-health.json`.
- The health check showed the existing real local inspection path still completed with `plannedToolCallCount: 1`, no skipped candidates, and direct evidence routed into memory after adding the MCP adapter layer.

## Phase 6: Skill Support And Domain Alignment

Add skills as lightweight domain-alignment bundles that can shape goals, context, procedures, tool permissions, and output expectations for different research modes.

Example domains include vulnerability research, mathematics, investigations, literature review, reverse engineering, software maintenance, and data analysis.

Status: completed on 2026-06-24.

Checklist:

- [x] Add a `SkillDescriptor` contract with id, description, domain tags, instructions, recommended tools, and governance hints.
- [x] Add a skill registry and loader.
- [x] Support local filesystem skills.
- [x] Support MCP-exposed skill metadata when available.
- [x] Select relevant skills from prompt, active goal, memory, and user configuration.
- [x] Inject selected skill instructions into context as labeled, auditable alignment context.
- [x] Convert skill runbooks into candidate procedural memory refs when useful.
- [x] Allow skills to recommend tools without granting permission by themselves.
- [x] Record selected skill ids and versions in loop events or captures.
- [x] Add tests for skill selection by domain.
- [x] Add tests proving skills cannot override governance, tool permissions, or user commitments.

Verification:

- `pnpm test` passed with 89 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/12-real-skill-context.json`.
- The health check selected `parser-vuln-research@0.1`, preserved selected-skill instructions in captured context, executed one planned local inspection, and routed direct evidence into memory.

## Phase 7: Built-In Tool Families

Grow the default tool surface beyond local inspection while preserving the small action-class vocabulary.

Status: completed on 2026-06-24.

Checklist:

- [x] Add a memory recall tool that exposes retriever results as a `recall` action.
- [x] Add a repository search tool for local source and artifact search.
- [x] Add a structured file read tool that supports ranges, offsets, and binary-safe metadata.
- [x] Add an analysis tool surface for transforms such as call graphs, metrics, summaries, and diffs.
- [x] Add an experiment tool surface for tests, scripts, probes, fuzzing, and simulation under policy.
- [x] Add a synthesis tool surface for reports, patches, and generated artifacts.
- [x] Add per-tool safety profiles and default budgets.
- [x] Add tests for each built-in tool family.

Verification:

- `pnpm test` passed with 96 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/13-real-built-in-repo-search.json`.
- The first live health attempt exposed that dotted canonical tool names are not provider-safe. Built-ins now expose safe transport aliases such as `repository_search` while events retain canonical names such as `repository.search`.
- The successful health check used the real `openai-codex/gpt-5.3-codex-spark` path with `repository.search` against `/Users/philogroves/maxtac-resources/zsh/zsh/Src`. The model made two search calls: the first over-specific query produced zero matches, then `parse_context_save` found `context.c:67` and `parse.c:295`. This is enough evidence for a focused follow-up inspection step and a useful quirk to keep watching in later evaluation harnesses.

## Phase 8: Pi Agent Lifecycle Integration

Evaluate and adopt the fuller Pi `Agent` lifecycle where it provides better streaming, callbacks, queueing, and native tool execution control than `completeSimple`.

Status: completed on 2026-06-24.

Checklist:

- [x] Map Honeycrisp tools to Pi `AgentTool` objects where appropriate.
- [x] Use `beforeToolCall` for Honeycrisp governance validation.
- [x] Use `afterToolCall` for event capture and result normalization.
- [x] Preserve Honeycrisp memory event ordering across streamed model/tool events.
- [x] Support sequential and parallel tool execution modes.
- [x] Stream tool progress into captures or runtime status when useful.
- [x] Preserve the current `completeSimple` path as a simpler fallback if needed.
- [x] Add tests for lifecycle hooks and event ordering.

Verification:

- `pnpm test` passed with 99 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/14-real-agent-lifecycle-search.json`.
- The health check used the real `openai-codex/gpt-5.3-codex-spark` path through the Pi Agent lifecycle executor with sequential tool execution. It produced one `repository.search` call, one complete `tool.observed` event, two model calls, and lifecycle capture entries for `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`.
- The zsh evidence remained stable: `parse_context_save` matched `context.c:67` and `parse.c:295`. The tighter prompt avoided the earlier over-specific first query from Phase 7.

## Phase 9: Operator Configuration And UX

Expose tool and skill configuration in ways that are inspectable and safe for a general research agent.

Status: completed on 2026-06-24.

Checklist:

- [x] Add CLI options for enabling and disabling tool families.
- [x] Add CLI options for allowed side effects.
- [x] Add CLI options for tool-call, runtime, file, byte, and token budgets.
- [x] Add CLI options or config for allowed MCP servers.
- [x] Add CLI options or config for selected skills.
- [x] Add debug commands to list registered tools, MCP capabilities, and selected skills.
- [x] Add capture fields for tool registry state and selected skills.
- [x] Add clear user-facing errors for unavailable tools, denied permissions, and missing MCP servers.
- [x] Add tests for CLI and config precedence.

Verification:

- `pnpm test` passed with 102 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/15-real-cli-tool-config.json`.
- The health check used the real CLI with `--executor agent`, `--repo-root`, `--allowed-side-effect read`, `--tool-max-calls 1`, and `--tool-max-bytes 200000`. Capture metadata recorded `repository.search`, the enabled `repository-search` family, governance, and Agent lifecycle execution.
- The first health attempt showed that the default repository per-file cap skipped the larger `parse.c`; `--tool-max-bytes` now also configures repository-search `maxFileBytes` and file-read `maxBytes`. The rerun found `context.c:67` and `parse.c:295`.

## Phase 10: Evaluation Boundaries And User Tool Surfaces

Keep tool evaluation reliable without shipping domain-specific harness APIs that users might mistake for supported research modes. Honeycrisp should verify the generic tool layer and leave domain alignment to user MCP servers, local skills, and operator-configured tools.

Status: completed on 2026-06-24.

Checklist:

- [x] Avoid exporting packaged domain-specific tool harnesses.
- [x] Keep domain alignment delegated to user-provided MCP servers, local skills, and configured tool families.
- [x] Verify MCP discovery and execution through generic fixtures.
- [x] Verify skill selection and instruction injection through generic/local skill fixtures.
- [x] Verify controller selection for user-configured `recall`, `analyze`, and `experiment` tools.
- [x] Track tool event-log and memory consequences through the normal bootstrap, CLI, and memory tests.
- [x] Preserve regression tests for tool-call loops that require multiple tool calls.
- [x] Preserve regression tests for blocked or denied tool paths.
- [x] Preserve regression tests for artifact-heavy tool outputs.

Verification:

- `pnpm test` passed with 103 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/zsh-honeycrisp-runs/17-real-user-configured-tools.json`.
- The health check used the real `openai-codex/gpt-5.3-codex-spark` Agent executor through normal CLI configuration: `--repo-root`, `--allowed-side-effect read`, `--tool-max-calls 1`, and `--tool-max-bytes 200000`.
- The real run completed one user-configured `repository.search` call with no packaged harness API, produced Agent lifecycle metadata, and routed the search observation into memory.
- The zsh evidence included `Src/context.c:67` and `Src/parse.c:295` for `parse_context_save`, confirming the generic user-configured tool path preserves the same health-check value without locking Honeycrisp into maintained domain harnesses.
