# Agent Core Migration Plan

This plan moves general agent capabilities out of Beale and into Honeycrisp while leaving Beale as a research interface, program/project setup surface, visualization layer, and host for domain-specific skills, MCP servers, and export/report workflows.

The guiding principle is:

1. Honeycrisp owns general research cognition: goals, subgoals, memory, evidence, hypotheses, findings, proof state, tools, storage, and run captures.
2. Beale owns researcher UX: program/project setup, prompt drafting, session display, context/memory visualization, heatmap, and domain-specific report/export flows.
3. Beale should not maintain a parallel agent runtime, semantic memory, benchmark harness, VM sandbox, or finding ledger when Honeycrisp can provide a general interface.
4. Domain-specific behavior should arrive through skills, MCP, and Beale UI affordances, not through hard-coded Honeycrisp vulnerability logic.

## Tracking Rules

Update the checklists in this file as each implementation increment lands. Keep checklist status tied to verified behavior, not intent.

- `[x]` means implemented and verified.
- `[ ]` means not implemented yet.
- If a phase changes direction, update that phase before implementation begins.
- Keep each implementation session scoped to one phase unless the user explicitly expands scope.
- After each phase, run Honeycrisp tests, Beale tests relevant to the changed surface, and at least one real Honeycrisp-through-Beale health check when UI integration changes.

## Current Ownership Analysis

### Honeycrisp Already Owns

- Goal and subgoal runtime with completion, stop, blocked, and loop-limit states.
- Durable SQLite memory event log and derived memory record store.
- Evidence, episodic records, semantic claims, hypotheses, beliefs, procedures, prospective checks, working memory, and claim graph edges.
- Memory retrieval, context packet v2, context compaction, reflection, lifecycle/audit controls, and memory inspector CLI.
- Built-in tool registry, local inspection, repository search, file read, analysis, synthesis, storage listing, configured experiments, MCP tools, and skills.
- Storage layout under `.honeycrisp/memory/` with artifact manifest and artifact references.
- Flow capture suitable for Beale import.
- Preference-only provider/model/effort config.

### Honeycrisp Is Missing Or Too Thin

- A first-class general `finding` memory record distinct from hypotheses and semantic claims.
- A general proof/verifier abstraction that can represent proof obligations and proof attempts without assuming security, math, benchmark, or patch-validation semantics.
- A Beale-facing durable API/CLI surface for listing and mutating evidence, hypotheses, findings, proof obligations, and proof attempts.
- A workspace/repository knowledge packet that tells the agent where repositories and durable storage live without turning those paths into restrictive repository guards.
- A relaxed execution posture that treats local process execution as an operator choice rather than a Beale-enforced VM sandbox policy.
- A migration path for Beale to render Honeycrisp memory directly instead of maintaining parallel hypothesis/finding/evidence tables for general research state.

### Beale Agent Features To Retire Or Reduce

- Project semantic indexing, project inventory, structure graph, graph search, and graph visualization as agent-state mechanisms. Honeycrisp intentionally should not add semantic search now. Tree-sitter, code intelligence, or semantic search can return later as optional Beale skills/MCP servers.
- Beale OpenAI/fake/executor agent runtimes and their custom tool stack once Honeycrisp is the only research agent engine.
- Beale VM/sandbox implementation, VM setup UX, executor backends, network-profile enforcement, and approval gates. Operators can run Beale/Honeycrisp inside their own VM when isolation matters.
- Benchmark and CyberGym code, tests, UI settings, storage, model proxy, and reserved programs. This was proof-of-concept scaffolding and should be removed.
- Beale project graph as a memory surrogate. Keep heatmap/visual emphasis, but compute it from Honeycrisp memory summaries or Beale vulnerability overlays.
- Beale general hypothesis/finding/evidence management after Honeycrisp exposes general equivalents.

### Beale Features To Keep

- Program/project onboarding, scope templates, HackerOne or program import, and source checkout/materialization for now.
- Prompt planning and next-session recommendation.
- Honeycrisp launch/import bridge and UI views.
- Context view, memory summary view, storage directory UI, trace display, notifications, and heatmap visuals.
- Domain-specific vulnerability UI overlays, CWE/security classification, and disclosure/export/report workflows.
- Domain-specific verifier presentation where the backing proof mechanism comes from Honeycrisp plus skills/MCP.

## Phase 1: Honeycrisp Agent State Contract

Define the general agent-state surface Honeycrisp will expose to Beale before changing Beale storage.

Status: completed.

Checklist:

- [x] Add a design note to `planning/ARCHITECTURE.md` clarifying that Honeycrisp owns general agent state and Beale owns interface/program setup.
- [x] Confirm Honeycrisp memory record kinds that remain general: evidence, episodic, semantic claim, hypothesis, belief, procedure, prospective check, working.
- [x] Add or design a first-class `finding` memory record kind with general semantics: a promoted, evidence-backed research conclusion that may still be domain-labeled.
- [x] Define finding statuses without vulnerability-specific terms: `candidate`, `needs_evidence`, `supported`, `verified`, `superseded`, `rejected`, `out_of_scope`, `tombstoned`.
- [x] Define finding provenance as links to evidence records, hypotheses, claims, artifact refs, and proof attempts.
- [x] Define a generic proof/verifier contract model: proof obligation, proof method, proof attempt, proof result, proof artifact refs, and domain metadata.
- [x] Ensure proof contracts can represent mathematical proof, empirical reproduction, static analysis, dynamic exploit proof, patch validation, and investigation corroboration without hard-coding one domain.
- [x] Decide whether proof records are memory record kinds, artifact-backed records, or a separate table indexed by memory refs.
- [x] Define Beale-facing read models for goal, subgoal, latest context, evidence, hypotheses, findings, proof state, artifacts, storage, and session token/context usage.
- [x] Add deterministic contract tests for serialization, record validation, and backward compatibility with existing memory databases.

## Phase 2: Findings In Honeycrisp Memory

Implement general findings as durable Honeycrisp memory, then teach the controller and inspector how to use them.

Status: completed.

Checklist:

- [x] Add `finding` to Honeycrisp memory record contracts and SQLite validation.
- [x] Add migration support for existing `memory_records` rows without requiring a database rebuild.
- [x] Add write-pipeline support for model-visible finding proposals and finding updates.
- [x] Add event kinds for finding lifecycle updates, such as `finding.proposed`, `finding.updated`, and `finding.reviewed`.
- [x] Add lifecycle operations for finding promotion, rejection, supersession, tombstone, and policy deletion.
- [x] Add retrieval scoring so supported or verified findings are recalled above weak hypotheses, while rejected findings remain auditable but ordinary retrieval avoids them.
- [x] Add context packet sections that separate findings from hypotheses and semantic claims.
- [x] Add memory inspector commands for listing findings and showing one finding with linked evidence/proof/artifacts.
- [x] Add tests for finding write, retrieval, lifecycle, context selection, and inspector output.
- [x] Run a real Honeycrisp health check that promotes a non-security finding from evidence and verifies it appears in memory/context.

## Phase 3: Generic Proof And Verifier Layer

Move Beale's general verifier concept into Honeycrisp as an extensible proof mechanism while leaving domain-specific proof logic to skills and MCP.

Status: completed.

Checklist:

- [x] Add proof obligation and proof attempt contracts to Honeycrisp.
- [x] Add accepted event kinds for proof lifecycle: `proof.requested`, `proof.attempted`, `proof.observed`, `proof.reviewed`.
- [x] Persist proof obligations and attempts with links to goals, subgoals, evidence records, findings, artifacts, and tool events.
- [x] Add a generic proof result vocabulary: `pass`, `fail`, `inconclusive`, `blocked`, `superseded`.
- [x] Support proof artifacts through existing Honeycrisp storage manifest and memory artifact refs.
- [x] Add proof retrieval and context sections so the model sees proof state separately from evidence and hypothesis text.
- [x] Add a proof guidance interface that skills can extend with domain-specific proof expectations.
- [x] Add MCP/tool integration hooks so external proof providers can create proof attempts without special Beale code.
- [x] Add inspector commands for proof obligations and proof attempts.
- [x] Add deterministic tests for proof contracts, persistence, retrieval, and context packet rendering.
- [x] Run a real health check using a simple local proof method, such as a command that validates an artifact or reproducible claim.

## Phase 4: Repository And Workspace Context Without Guards

Replace restrictive Beale repository guards with explicit workspace/repository context that guides the agent without locking it into a narrow path model.

Status: not started.

Checklist:

- [ ] Define a Honeycrisp workspace context packet containing workspace root, memory/storage paths, known repositories, materialized source paths, and user-provided project notes.
- [ ] Treat repository paths as discoverability hints and persistence locations, not as authorization fences.
- [ ] Adjust Beale's Honeycrisp invocation to pass known repo/source locations in prompt/capture metadata or a structured config file instead of relying on restrictive file-read roots.
- [ ] Keep Honeycrisp storage instructions clear: memory stores recallable facts and file pointers; storage preserves files, blobs, reports, logs, generated outputs, and scratch material.
- [ ] Ensure repository search and file-read tools can operate from operator-provided workspace context while still preserving audit events.
- [ ] Remove Beale UI language that implies the repo list is a hard permission boundary.
- [ ] Add tests that a Beale-launched Honeycrisp run receives repository/storage context and can recover from nested source layouts.
- [ ] Run a real ZSH health check verifying Honeycrisp finds nested files from context without Beale-specific repository guard logic.

## Phase 5: Beale Reads Honeycrisp Memory As Source Of Truth

Refactor Beale's memory/program-tracking views to read Honeycrisp memory records for general research state.

Status: not started.

Checklist:

- [ ] Add a Honeycrisp memory read adapter in Beale that uses exported Honeycrisp CLI/library APIs where possible rather than duplicating SQL knowledge.
- [ ] Replace Beale general hypothesis/evidence/finding reads with Honeycrisp memory reads in session details.
- [ ] Preserve Beale-specific vulnerability overlays, CWE/security labels, and report/export state separately from generic Honeycrisp memory.
- [ ] Update Beale Context view to show findings and proof state from Honeycrisp when present.
- [ ] Update Beale Memory/Program Tracking views to show Honeycrisp evidence, hypotheses, findings, procedures, prospective checks, and proof state.
- [ ] Keep the heatmap visual but compute its general intensity from Honeycrisp finding/proof/evidence state, with optional Beale vulnerability-specific boosts.
- [ ] Remove or mark obsolete Beale-only graph/memory widgets that duplicate Honeycrisp memory.
- [ ] Add renderer tests for Honeycrisp memory-backed views.
- [ ] Add integration tests using a fixture Honeycrisp memory database with evidence, hypothesis, finding, and proof records.
- [ ] Run a real Beale session and verify UI updates directly from Honeycrisp memory after the run.

## Phase 6: Decommission Beale Semantic Index And Project Graph Agent State

Remove Beale's semantic/project graph machinery from the agent path while keeping room for future optional skills/MCP.

Status: not started.

Checklist:

- [ ] Remove Beale semantic indexing controls from settings and program understanding views.
- [ ] Remove project semantic index executor, worker, worker protocol, and related IPC handlers.
- [ ] Remove project semantic tables from active code paths, leaving migrations tolerant of old databases.
- [ ] Remove project inventory/search/structure/graph refreshes that only exist to feed Beale's old agent tools.
- [ ] Remove graph search and semantic retrieval from Beale's old OpenAI tool stack as that stack is retired.
- [ ] Keep or redesign heatmap visuals so they do not depend on project graph state.
- [ ] Document future code-intelligence direction as optional Tree-sitter or semantic retrieval skills/MCP, not Honeycrisp core.
- [ ] Add migration/recovery tests proving existing workspaces with old semantic tables still open.
- [ ] Remove semantic-index renderer tests or rewrite them around the new memory-backed UI.
- [ ] Run Beale build and workbench tests after removal.

## Phase 7: Remove Beale VM And Sandbox Runtime

Remove the Beale VM/sandbox implementation and make execution posture explicit: users can run Beale/Honeycrisp in their own isolation environment when needed.

Status: not started.

Checklist:

- [ ] Remove VM preference settings and sandbox setup UI.
- [ ] Remove executor manager, vmctl provider, Docker sandbox provider, executor run engine, and host/guest import/export abstractions from Beale agent execution.
- [ ] Remove network-profile enforcement and approval gates that existed only for Beale's VM sandbox model.
- [ ] Remove VM context lifecycle behavior from active Beale Honeycrisp sessions or reduce it to a simple host-process execution record.
- [ ] Update Beale copy to say Honeycrisp runs with the user's chosen host privileges and should be launched inside a VM/container if isolation is desired.
- [ ] Preserve artifact collection through Honeycrisp storage instead of Beale guest export.
- [ ] Update tests that currently assert VM/sandbox behavior.
- [ ] Ensure Beale still launches Honeycrisp and displays traces/context without executor dependencies.
- [ ] Run a real Beale/Honeycrisp session after removal.

## Phase 8: Remove Beale Benchmark And CyberGym Era Code

Delete proof-of-concept benchmark infrastructure from Beale.

Status: not started.

Checklist:

- [ ] Remove benchmark runner, benchmark isolation, benchmark proxy, benchmark suite, benchmark Docker runner, and CyberGym prompt helpers.
- [ ] Remove CyberGym settings, reserved program handling, storage preparation, scenario listing, staging, submission, and grading code.
- [ ] Remove benchmark IPC channels and renderer settings.
- [ ] Remove benchmark-related schema usage from active snapshots; keep old database migrations tolerant but unused.
- [ ] Remove benchmark npm scripts and benchmark/firecracker live test scripts from Beale package metadata.
- [ ] Remove benchmark tests and fixtures.
- [ ] Remove benchmark-specific dependencies or Docker/firecracker scripts if no other code needs them.
- [ ] Run Beale typecheck/build/tests and fix any stale references.

## Phase 9: Retire Beale's Parallel Agent Runtime

Make Honeycrisp the only research agent engine used by Beale.

Status: not started.

Checklist:

- [ ] Remove Beale fake run engine from production code or confine it to narrow renderer/test fixtures.
- [ ] Remove Beale OpenAI run engine, OpenAI tool stack, OpenAI context compaction, and OpenAI auth flow if Honeycrisp is the only model caller.
- [ ] Remove executor-alpha run engine after VM/sandbox removal.
- [ ] Reduce `RunEngineKind` to Honeycrisp plus any explicit non-agent UI fixture mode needed for tests.
- [ ] Ensure Beale's run records, model sessions, trace events, and transcripts are imported from Honeycrisp captures rather than generated by a parallel agent loop.
- [ ] Update run settings defaults and UI labels to reflect Honeycrisp as the engine.
- [ ] Replace Beale tool traces with Honeycrisp tool events where possible.
- [ ] Add tests that starting a research session invokes Honeycrisp and imports goal/subgoal/context/memory/proof/finding state.
- [ ] Run a real Beale/Honeycrisp session and verify no Beale-native agent runtime code is used.

## Phase 10: General Research Steering APIs

Move general steering actions from Beale into Honeycrisp while keeping Beale-specific report/export actions in Beale.

Status: not started.

Checklist:

- [ ] Add Honeycrisp APIs or CLI commands for promoting a hypothesis to finding.
- [ ] Add Honeycrisp APIs or CLI commands for reviewing, rejecting, superseding, or tombstoning hypotheses and findings.
- [ ] Add Honeycrisp APIs or CLI commands for requesting proof, attaching proof attempts, and reviewing proof outcomes.
- [ ] Add Honeycrisp APIs or CLI commands for marking artifacts as important, sensitive, or tombstoned.
- [ ] Keep vulnerability-specific classification, disclosure readiness, and report/export steering in Beale.
- [ ] Update Beale steering actions to call Honeycrisp APIs for general state changes.
- [ ] Ensure all steering changes append Honeycrisp events before mutating derived records.
- [ ] Add tests for Beale-to-Honeycrisp steering calls and memory audit records.
- [ ] Run a UI steering health check on a fixture run.

## Phase 11: Beale Cleanup And Compatibility Boundary

Finish the migration by tightening Beale to a Honeycrisp interface and documenting remaining boundaries.

Status: not started.

Checklist:

- [ ] Remove unused Beale schema tables from new workspace initialization where safe, while preserving old-workspace recovery.
- [ ] Add a compatibility layer for old workspaces that have Beale hypotheses/findings/evidence but no Honeycrisp equivalents.
- [ ] Provide a one-time migration/export path from Beale general research records into Honeycrisp memory events and records.
- [ ] Keep Beale disclosure/export/report tables and vulnerability-specific overlays separate from Honeycrisp memory.
- [ ] Update Beale README or docs to describe Beale as a Honeycrisp research interface.
- [ ] Update Honeycrisp README or docs to describe Beale integration expectations.
- [ ] Run full Honeycrisp and Beale suites.
- [ ] Run a final real Beale/Honeycrisp session with a local repo and verify context, memory, findings, proof state, heatmap, storage, and trace display.
- [ ] Remove obsolete planning notes or mark them superseded by this plan.

## Non-Goals For This Plan

- Do not add semantic/vector retrieval to Honeycrisp core in this migration.
- Do not add Tree-sitter or language-server indexing to Honeycrisp core; those belong in optional skills or MCP servers.
- Do not keep Beale's VM sandbox as a hidden safety layer.
- Do not migrate program/project setup out of Beale yet.
- Do not migrate Beale's disclosure/export/report UX into Honeycrisp until a separate cross-domain design exists.
- Do not hard-code vulnerability-specific fields such as CWE, bounty eligibility, exploitability scoring, or disclosure readiness into Honeycrisp's general memory records.
