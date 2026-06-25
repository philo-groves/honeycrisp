# Integration Layer Implementation Plan

This plan covers the remaining architecture gaps after the memory, tool, storage, and config layers reached their first complete slices. The goal is to make the layers work together as the default runtime, not just as independently tested libraries.

The guiding principle is:

1. Real runs should use the durable memory stack end to end.
2. Tool, storage, MCP, skill, and config decisions should be visible in captures and event logs.
3. Operator-facing configuration should remain explicit, non-secret, and safe by default.
4. Every integration phase should end with a real model health check and a small commit.

## Tracking Rules

Update the checklists in this file as each implementation increment lands. Keep checklist status tied to verified behavior, not intent.

- `[x]` means implemented and verified.
- `[ ]` means not implemented yet.
- If a phase changes direction, update that phase before implementation begins.
- After each completed phase, run a real health check, review the capture or durable outputs, and commit with a short message.

## Current Baseline

Honeycrisp already has strong individual layers:

- The processing layer has goal frames, bounded loops, completion gates, continuation state, deterministic execution, real model execution, and Pi Agent lifecycle execution.
- The memory layer has SQLite event retention, derived-record storage, retrieval, reflection, lifecycle controls, context packet v2, and inspectability APIs.
- The tool layer has registry governance, built-in families, MCP adapter abstractions, skill selection, durable tool events, artifact spillover, and CLI configuration.
- The storage layer creates the default durable layout beside `.honeycrisp/memory/memory.sqlite`.
- The config layer resolves provider, model, and effort preferences without storing credentials.

Known integration gaps:

- The top-level runtime still relies on the first-run snapshot controller instead of making the durable event log, record store, retriever, context packet v2, and memory-driven controller the default loop path.
- MCP adapter tests exist, but live MCP client discovery and configuration are not wired into normal CLI runs.
- Experiment tools exist as a built-in family, but operator configuration for safe allowlisted commands needs a clearer shape before broad CLI exposure.
- Storage directories are exposed to model context, but there is no first-class storage manifest or storage tool surface for listing and recording durable artifacts.
- Config can be supplied explicitly, but there is no default config file path or `honeycrisp config show/set` UX.
- The final integration path needs multi-loop real health checks that exercise config, storage, tools, durable memory, and capture review together.

## Phase 1: Durable Runtime Memory Path

Make real CLI runs use the durable memory stack as the default integration path.

Status: completed on 2026-06-24.

Checklist:

- [x] Add a runtime integration path that opens the SQLite event log and derived-record store for the workspace.
- [x] Append accepted runtime events to SQLite during each loop, not only after ad hoc captures.
- [x] Run the memory write pipeline after accepted events are appended.
- [x] Persist derived memory records after each loop.
- [x] Retrieve from the durable record store before planning the next loop.
- [x] Use the memory-driven controller and context packet v2 when durable retrieval is available.
- [x] Preserve first-run fallback behavior when durable memory has no useful records.
- [x] Keep the existing deterministic and test-oriented bootstrap path working.
- [x] Include durable-memory integration metadata in flow captures.
- [x] Add tests for a two-loop durable-memory run across event log, record store, retriever, and controller.
- [x] Run a real health check and review the capture for durable events, records, retrieval, and controller metadata.

Verification:

- `pnpm test` passed with 110 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase1/phase1-real-rerun.json`.
- Durable SQLite workspace: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase1/workspace-rerun/.honeycrisp/memory/memory.sqlite`.
- The real run used two model loops against local zsh `context.c`, appended 29 events, wrote 29 derived records, retrieved 17 candidates in loop two, selected context packet v2 evidence record `mem_evidence_f69669935994e589a0c77312`, and used the memory-driven controller for the final `respond` action.

## Phase 2: Storage Manifest And Storage Tools

Make storage inspectable and actionable without confusing storage with memory.

Status: completed on 2026-06-24.

Checklist:

- [x] Add a storage manifest format under `.honeycrisp/memory/artifacts/` or `.honeycrisp/memory/`.
- [x] Record artifact path, kind, purpose, size, hash, created time, and source event ids.
- [x] Add helper APIs to register, list, and resolve stored artifacts.
- [x] Add a read-only storage listing tool.
- [x] Add a storage artifact registration helper for generated outputs.
- [x] Ensure memory records store summaries and artifact pointers rather than large file contents.
- [x] Include storage manifest metadata in flow captures.
- [x] Add tests for manifest registration, listing, hashing, and restart-safe reload.
- [x] Run a real health check that produces or registers a stored artifact and review the manifest plus memory pointer.

Verification:

- `pnpm test` passed with 112 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase2/phase2-real.json`.
- Durable SQLite workspace: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase2/workspace/.honeycrisp/memory/memory.sqlite`.
- Storage manifest: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase2/workspace/.honeycrisp/memory/artifacts/manifest.json`.
- The real run registered one `tool_raw_output` artifact spilled from the `tool.observed` event for local zsh `parse.c`; the manifest recorded `artifact_evt_4a2a2ba7-9010-4482-a9b4-07a8e2e7e4a9_tool_result`, 97,500 bytes, SHA-256 hash `sha256:5fbbacb181615e0e04cb1958413d71924edf563211ffc792cd523a26af02fd18`, and source event `evt_4a2a2ba7-9010-4482-a9b4-07a8e2e7e4a9`.

## Phase 3: Live MCP Client Integration

Wire MCP into normal runtime configuration while keeping the current allowlist and untrusted-output posture.

Status: completed on 2026-06-24.

Checklist:

- [x] Define a CLI/config shape for MCP server definitions and allowlists.
- [x] Add a live MCP connector loader that can discover configured servers.
- [x] Register allowlisted MCP tools and resources into the runtime tool registry.
- [x] Preserve server/tool provenance in descriptors, captures, and events.
- [x] Treat MCP resource and tool outputs as untrusted external content in model context.
- [x] Add clear errors for missing server definitions, denied servers, startup failures, and timeouts.
- [x] Keep fake MCP fixtures for deterministic tests.
- [x] Add tests for config loading, allowlist enforcement, and live-connector error handling.
- [x] Run a real health check with a configured local MCP fixture or available user MCP server and review discovery plus events.

Verification:

- `pnpm test` passed with 114 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase3/phase3-real.json`.
- MCP fixture config: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase3/mcp.json`.
- The real run discovered allowlisted `mcp.fixture.echo_search`, preserved transport name `mcp_fixture_echo_search`, side effect `read`, permission `mcp:fixture:tool:echo_search`, and `untrustedOutput: true`; the model made one MCP tool call with `query: "parser context"`, the `tool.observed` event stored the untrusted fixture result, and memory derived evidence record `mem_evidence_016bf253443a143f1208d396`.

## Phase 4: Experiment Tool Operator Configuration

Expose experiment capabilities only through explicit, auditable operator policy.

Status: completed on 2026-06-24.

Checklist:

- [x] Define an allowlisted experiment spec format for commands, scripts, probes, and tests.
- [x] Require explicit side-effect and permission policy for each experiment.
- [x] Validate working directory, environment, command, arguments, timeout, and output limits before execution.
- [x] Capture stdout, stderr, exit status, hashes, and artifact paths without storing oversized output inline.
- [x] Add CLI/config support for loading experiment specs.
- [x] Register configured experiments as tool registry entries.
- [x] Block unconfigured experiment execution with user-facing errors.
- [x] Add tests for allowed, denied, timeout, output-spill, and restart-safe artifact cases.
- [x] Run a real health check with a harmless allowlisted experiment and review events plus artifacts.

Verification:

- `pnpm test` passed with 119 tests on 2026-06-24.
- Real health check capture: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase4/phase4-real-provenance.json`.
- Experiment fixture config: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase4/experiments.json`.
- Durable SQLite workspace: `/Users/philogroves/Desktop/honeycrisp/tmp/integration-phase4/workspace-provenance/.honeycrisp/memory/memory.sqlite`.
- The real run registered configured tool `experiment.run` with process side effects and permissions `experiment:run` plus `fixture:run`; the model called `echo_probe` with `query: "parser-context"`, captured stdout `experiment-result:parser-context`, persisted stdout and stderr artifacts, and the storage manifest links both artifacts to observed event `evt_f6347db4-b2fa-4f7c-9721-08dae84d92ba`.

## Phase 5: Config File UX

Make model preference configuration discoverable without turning it into auth.

Status: pending.

Checklist:

- [ ] Choose and document a default project config path.
- [ ] Load default project config when `--config` is not supplied.
- [ ] Add `honeycrisp config show`.
- [ ] Add `honeycrisp config set provider/model/effort`.
- [ ] Preserve CLI overrides as higher precedence than config files.
- [ ] Reject auth-like secret fields in default config files.
- [ ] Surface whether the selected provider is authorized without printing credentials.
- [ ] Add tests for default config loading, show/set commands, precedence, and secret rejection.
- [ ] Run a real health check that uses default config without provider/model flags and review capture metadata.

## Phase 6: End-To-End Integration Health And Roadmap Cleanup

Prove the architecture works as one system and update the roadmap to reflect reality.

Status: pending.

Checklist:

- [ ] Add an integration health script or documented command sequence for real runs.
- [ ] Run a multi-loop real health check against a local research target.
- [ ] Verify durable events, derived records, retrieval, selected tools, storage paths, config, and captures all line up.
- [ ] Update `planning/ARCHITECTURE.md` with implemented status and remaining known limitations.
- [ ] Update `README.md` with the integrated real-run path.
- [ ] Remove or document obsolete runtime residue such as old storage draft directories.
- [ ] Add regression coverage for the integrated health path where deterministic coverage is possible.
- [ ] Run the full test suite.
- [ ] Commit the final integration cleanup with a short message.
