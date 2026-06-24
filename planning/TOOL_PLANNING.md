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

Known limitations to address:

- The memory controller selects an action class but does not yet propose concrete tool actions or inputs.
- Registry validation is still shallow: action class and tool existence are checked, but schemas, side effects, permissions, latency, cost, and hooks need stronger enforcement.
- Durable SQLite event-log integration is not yet the default runtime write path for every top-level run.
- Tool outputs can still be large inline event payloads; storage-backed raw output pointers and artifact refs are needed.
- Only local inspection is executable.
- MCP servers and skills are not yet represented in Honeycrisp's own tool/skill registries.
- The runtime uses Pi model tool calls through `completeSimple`, not the fuller Pi `Agent` lifecycle.

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

Checklist:

- [ ] Extend `ResearchMemoryControllerDecision` with candidate tool actions.
- [ ] Include concrete tool name and normalized inputs in controller decisions when obvious from prompt, memory, and available tools.
- [ ] Preserve the selected action class as the primary policy decision.
- [ ] Teach loop planning to include proposed tool actions in the loop prompt and context packet.
- [ ] Make the Pi loop prefer controller-proposed actions before free-form tool choice.
- [ ] Add a no-model execution path for deterministic controller-planned tools when the action is purely evidence gathering.
- [ ] Record rejected or skipped candidate tool actions with explicit reasons.
- [ ] Add tests for controller-planned local inspection.
- [ ] Add tests proving tools do not execute when their action class is not selected or permitted.

## Phase 3: Tool Validation, Permissions, And Budgets

Harden tool execution so every call is checked against schemas, governance policy, side effects, and budgets before it can run.

Checklist:

- [ ] Validate tool inputs against registered schemas.
- [ ] Add output schema support for normalized tool results.
- [ ] Enforce allowed and denied action classes from governance policy.
- [ ] Enforce side-effect policy: `none`, `read`, `write`, `network`, and `process`.
- [ ] Enforce required permissions declared by each tool.
- [ ] Enforce per-loop `maxToolCalls`.
- [ ] Enforce per-tool or per-loop runtime budgets.
- [ ] Enforce file-count and byte-count budgets for file tools.
- [ ] Preserve validation errors as structured blocked tool results.
- [ ] Add validation hooks before and after execution.
- [ ] Add tests for schema rejection, side-effect rejection, permission rejection, and budget exhaustion.

## Phase 4: Durable Tool Events And Artifact Storage

Make tool results storage-friendly and durable by default, especially for large outputs, logs, traces, and generated artifacts.

Checklist:

- [ ] Write top-level runtime tool events through the SQLite `MemoryEventLog` by default.
- [ ] Store large raw tool outputs outside event payloads under `.honeycrisp/memory/artifacts/`.
- [ ] Add artifact metadata rows or references for tool-generated files.
- [ ] Replace large inline payload fields with raw output pointers when size thresholds are exceeded.
- [ ] Preserve small summaries and evidence extracts inline for routing.
- [ ] Hash raw outputs and artifact payloads for integrity.
- [ ] Add cleanup and tombstone behavior for tool artifacts under memory lifecycle policy.
- [ ] Add tests for large output spillover.
- [ ] Add tests for artifact refs surviving restart.

## Phase 5: MCP Tool Support

Add MCP as a first-class tool source so Honeycrisp can use external and local capability providers without hard-coding every integration.

Checklist:

- [ ] Add an MCP connector abstraction that can list available servers, tools, resources, and resource templates.
- [ ] Map MCP tools into `ResearchToolDescriptor` and `ResearchExecutableTool`.
- [ ] Preserve MCP server name, tool name, schema, permissions, and provenance in descriptors.
- [ ] Support allowlisted MCP servers only by default.
- [ ] Treat MCP tool outputs and resource contents as untrusted external content.
- [ ] Normalize MCP results into tool execution results and events.
- [ ] Add support for MCP resource reads as `inspect` actions.
- [ ] Add support for MCP tool calls as `search`, `analyze`, `experiment`, or `synthesize` actions based on descriptor metadata.
- [ ] Add timeout, cancellation, and error handling around MCP calls.
- [ ] Add MCP capability discovery to debug output.
- [ ] Add tests using a fake MCP server/tool.
- [ ] Add tests proving denied MCP servers or tools cannot execute.

## Phase 6: Skill Support And Domain Alignment

Add skills as lightweight domain-alignment bundles that can shape goals, context, procedures, tool permissions, and output expectations for different research modes.

Example domains include vulnerability research, mathematics, investigations, literature review, reverse engineering, software maintenance, and data analysis.

Checklist:

- [ ] Add a `SkillDescriptor` contract with id, description, domain tags, instructions, recommended tools, and governance hints.
- [ ] Add a skill registry and loader.
- [ ] Support local filesystem skills.
- [ ] Support MCP-exposed skill metadata when available.
- [ ] Select relevant skills from prompt, active goal, memory, and user configuration.
- [ ] Inject selected skill instructions into context as labeled, auditable alignment context.
- [ ] Convert skill runbooks into candidate procedural memory refs when useful.
- [ ] Allow skills to recommend tools without granting permission by themselves.
- [ ] Record selected skill ids and versions in loop events or captures.
- [ ] Add tests for skill selection by domain.
- [ ] Add tests proving skills cannot override governance, tool permissions, or user commitments.

## Phase 7: Built-In Tool Families

Grow the default tool surface beyond local inspection while preserving the small action-class vocabulary.

Checklist:

- [ ] Add a memory recall tool that exposes retriever results as a `recall` action.
- [ ] Add a repository search tool for local source and artifact search.
- [ ] Add a structured file read tool that supports ranges, offsets, and binary-safe metadata.
- [ ] Add an analysis tool surface for transforms such as call graphs, metrics, summaries, and diffs.
- [ ] Add an experiment tool surface for tests, scripts, probes, fuzzing, and simulation under policy.
- [ ] Add a synthesis tool surface for reports, patches, and generated artifacts.
- [ ] Add per-tool safety profiles and default budgets.
- [ ] Add tests for each built-in tool family.

## Phase 8: Pi Agent Lifecycle Integration

Evaluate and adopt the fuller Pi `Agent` lifecycle where it provides better streaming, callbacks, queueing, and native tool execution control than `completeSimple`.

Checklist:

- [ ] Map Honeycrisp tools to Pi `AgentTool` objects where appropriate.
- [ ] Use `beforeToolCall` for Honeycrisp governance validation.
- [ ] Use `afterToolCall` for event capture and result normalization.
- [ ] Preserve Honeycrisp memory event ordering across streamed model/tool events.
- [ ] Support sequential and parallel tool execution modes.
- [ ] Stream tool progress into captures or runtime status when useful.
- [ ] Preserve the current `completeSimple` path as a simpler fallback if needed.
- [ ] Add tests for lifecycle hooks and event ordering.

## Phase 9: Operator Configuration And UX

Expose tool and skill configuration in ways that are inspectable and safe for a general research agent.

Checklist:

- [ ] Add CLI options for enabling and disabling tool families.
- [ ] Add CLI options for allowed side effects.
- [ ] Add CLI options for tool-call, runtime, file, byte, and token budgets.
- [ ] Add CLI options or config for allowed MCP servers.
- [ ] Add CLI options or config for selected skills.
- [ ] Add debug commands to list registered tools, MCP capabilities, and selected skills.
- [ ] Add capture fields for tool registry state and selected skills.
- [ ] Add clear user-facing errors for unavailable tools, denied permissions, and missing MCP servers.
- [ ] Add tests for CLI and config precedence.

## Phase 10: Evaluation And Domain Harnesses

Create small repeatable evaluation harnesses for tool behavior across domains so tool calling remains reliable as the agent becomes more general.

Checklist:

- [ ] Add a local vulnerability-research tool harness.
- [ ] Add a mathematics or puzzle-solving tool harness.
- [ ] Add an investigation/evidence-synthesis tool harness.
- [ ] Add fixtures for MCP tool discovery and execution.
- [ ] Add fixtures for skill selection and instruction injection.
- [ ] Track event-log and memory consequences for each harness.
- [ ] Add regression tests for tool-call loops that require multiple tool calls.
- [ ] Add regression tests for blocked or denied tool paths.
- [ ] Add regression tests for artifact-heavy tool outputs.
