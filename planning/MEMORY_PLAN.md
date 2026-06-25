# Memory Layer Implementation Plan

This plan turns the architecture's memory model into an incremental implementation path. The guiding principle is:

1. Raw events are the source of truth.
2. Memory records are derived from accepted events.
3. Context packets are compiled views over memory, not memory itself.

The implementation should preserve the distinction between direct evidence, model inference, hypotheses, procedures, and user commitments. Private model thoughts should not be durably stored, but their visible consequences can be persisted as structured trace fields and accepted events.

## Tracking Rules

Update the checklists in this file as each implementation increment lands. Keep the checklist status tied to committed behavior and verified tests, not intent.

- `[x]` means implemented and verified.
- `[ ]` means not implemented yet.
- If a phase changes direction, update that phase before implementation begins.
- Keep each session scoped to the requested phase unless the user explicitly expands scope.

## Current Baseline

The project already has a first-pass runtime loop, goal frame generation, trace handling, local inspection, context packet compilation, primitive memory routing, phase-1 memory contracts, a phase-2 SQLite event log, a phase-3 deterministic write pipeline, a phase-4 SQLite derived-record store, a phase-5 deterministic memory retriever, a phase-6 context packet v2 compiler, a phase-7 memory-driven controller, phase-8 deterministic reflection, phase-9 lifecycle/audit controls, and phase-10 local inspectability/debug APIs plus CLI commands. The planned memory foundation is implemented, though the runtime still needs a later integration pass before durable memory is the default end-to-end driver.

Known limitations to address:

- Runtime bootstrapping still exposes an in-memory snapshot compatibility path derived from recent events.
- Runtime bootstrapping has not yet fully adopted the durable event log, derived-record store, retriever, context packet v2, reflection, lifecycle, and controller layers as the default loop path.
- CLI/debug inspectability is local and read-only by default; richer operator workflows can be layered on top of the exported inspector API.

## Phase 1: Stabilize Memory Contracts

Define the durable and derived-memory contracts before adding more behavior.

Status: completed on 2026-06-24.

Checklist:

- [x] Add canonical event id format.
- [x] Add canonical event sequence format.
- [x] Add stable memory record ids.
- [x] Add shared provenance shape for derived records.
- [x] Add explicit derived-memory statuses: `candidate`, `active`, `confirmed`, `contradicted`, `superseded`, `stale`, and `tombstoned`.
- [x] Separate raw event payloads from evidence records, semantic claims, hypotheses and beliefs, procedures, prospective checks, and context packet references.
- [x] Preserve evidence-for and evidence-against separately in derived-memory contracts.
- [x] Encode procedure promotion requirements before durable guidance.
- [x] Export the contract helpers for later phases.
- [x] Add tests for ids, statuses, provenance, and typed routed memory refs.

Design constraints:

- Context packets should contain references and summaries, not become the durable source of truth.
- Claims and hypotheses must preserve evidence-for and evidence-against separately.
- Procedures should require repeated usefulness or explicit promotion before becoming durable guidance.

## Phase 2: Retain With A SQLite Append-Only Event Log

Add a `MemoryEventLog` abstraction that stores accepted events before summarization or consolidation.

Status: completed on 2026-06-24.

Use SQLite as the durable index and source-of-truth event store, while preserving append-only event-log semantics. JSONL is no longer the preferred primary implementation because later memory components will need indexed queries over events, records, statuses, confidence, graph edges, and audit relationships.

Storage direction:

- Store accepted events in SQLite under `.honeycrisp/memory/memory.sqlite`.
- Store large binary or text artifacts on disk under `.honeycrisp/memory/artifacts/`.
- Keep storage directories for persistent non-memory objects beside the SQLite database.
- Store artifact metadata and event artifact references in SQLite.
- Do not add derived-memory record tables in this phase.
- Do not mutate or delete accepted event rows during ordinary operation.
- Represent corrections, redactions, contradictions, and tombstones as later events unless a user instruction or policy requires physical deletion.

Suggested layout:

```text
.honeycrisp/
  memory/
    memory.sqlite
    events/
    episodes/
    claims/
    procedures/
    hypotheses/
    prospective/
    artifacts/
    scratch/
```

Suggested `memory_events` schema:

```sql
CREATE TABLE memory_events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  kind TEXT NOT NULL,
  goal_id TEXT,
  loop_id TEXT,
  sub_goal_id TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL
);

CREATE INDEX memory_events_event_id_idx ON memory_events(event_id);
CREATE INDEX memory_events_goal_id_idx ON memory_events(goal_id);
CREATE INDEX memory_events_loop_id_idx ON memory_events(loop_id);
CREATE INDEX memory_events_sub_goal_id_idx ON memory_events(sub_goal_id);
CREATE INDEX memory_events_kind_idx ON memory_events(kind);
CREATE INDEX memory_events_timestamp_idx ON memory_events(timestamp);
```

Event shape:

- `eventId`
- `sequence`
- `timestamp`
- `kind`
- `goalId`
- `loopId`
- `subGoalId`
- `payload`
- `payloadHash`
- `artifactRefs`
- `schemaVersion`

Checklist:

- [x] Choose and add the SQLite dependency or Node runtime API used by the repository.
- [x] Add a `MemoryEventLog` interface that hides the storage backend.
- [x] Add a SQLite-backed implementation for accepted raw events.
- [x] Create `.honeycrisp/memory/memory.sqlite` and parent directories on demand.
- [x] Add schema initialization with idempotent migrations.
- [x] Append events in deterministic sequence order.
- [x] Reject writes that try to reuse an `event_id`.
- [x] Validate accepted event kind before append.
- [x] Validate event payload shape before append.
- [x] Compute and persist `payloadHash`.
- [x] Persist artifact references without storing large artifacts inline.
- [x] Read by event id.
- [x] Read by sequence range.
- [x] Read by goal id.
- [x] Read by loop id.
- [x] Read by subgoal id.
- [x] Read by event kind.
- [x] Add redaction or rejection hooks for disallowed event kinds.
- [x] Ensure private thought-like data is not accepted into durable storage.
- [x] Ensure restart-safe loading from SQLite.
- [x] Keep the existing in-memory snapshot compatibility path working.
- [x] Add tests for deterministic append order.
- [x] Add tests for restart reload preserving order.
- [x] Add tests for invalid payload rejection.
- [x] Add tests for private thought-like data rejection.
- [x] Add tests proving accepted rows are not modified by ordinary appends.

## Phase 3: Add The Memory Write Pipeline

Introduce a `MemoryWritePipeline` that converts accepted events into typed candidate memory records.

Status: completed on 2026-06-24.

Typed records:

- `EpisodicMemoryRecord`
- `SemanticClaimRecord`
- `ProcedureMemoryRecord`
- `HypothesisMemoryRecord`
- `ProspectiveMemoryRecord`
- `WorkingMemoryRecord`

Every record should include:

- `id`
- `kind`
- `status`
- `summary`
- `sourceEventIds`
- `evidenceRefIds`
- `goalId`
- `subGoalId`
- `confidence`
- `tags`
- `entities`
- `createdAt`
- `updatedAt`
- optional `validFrom` and `validUntil`

Initial routing:

- Tool observations become direct evidence or artifact references.
- Goal and loop updates become episodic records.
- Model-visible notes can become episodic records.
- Model claims become semantic claim candidates.
- Model hypotheses become hypothesis records.
- User commitments become durable user/prospective memory.
- Errors and contradictions become uncertainty or contradiction records.

Checklist:

- [x] Add `MemoryWritePipeline` interface.
- [x] Add deterministic event-to-record routing for currently emitted event kinds.
- [x] Convert tool observations into evidence-backed records.
- [x] Convert goal and loop updates into episodic records.
- [x] Convert model-visible notes into episodic or working records.
- [x] Convert model claims into candidate semantic claim records.
- [x] Convert model hypotheses into hypothesis records.
- [x] Convert user commitments into prospective or durable user memory records.
- [x] Convert errors and contradictions into uncertainty or contradiction records.
- [x] Preserve evidence-for and evidence-against separately for claims and hypotheses.
- [x] Keep model claims as candidates until evidence promotes them.
- [x] Keep procedure records as candidates until repeated usefulness or explicit promotion.
- [x] Add tests for tool-observation evidence records.
- [x] Add tests for candidate model claims.
- [x] Add tests for separate hypothesis evidence-for/evidence-against.
- [x] Add tests for goal completion or stop episodic summaries.

## Phase 4: Add Typed Stores And Indexes

Persist derived records as first-class memory.

Status: completed on 2026-06-24.

Use SQLite for derived record metadata and indexes. Keep large artifacts outside the database and referenced from record metadata. Avoid introducing a vector database until record semantics and retrieval behavior are stable.

Suggested SQLite-backed stores:

- episodes
- claims
- procedures
- hypotheses
- prospective checks
- working memory
- artifacts
- claim graph edges

Indexes:

- by record id
- by source event id
- by goal id
- by subgoal id
- by tag/entity
- by status
- by confidence
- by updated time

Claim graph relationships:

- `supports`
- `contradicts`
- `refines`
- `supersedes`
- `depends_on`

Checklist:

- [x] Add typed derived-record tables or a clearly typed record table plus indexes.
- [x] Add source event id indexes.
- [x] Add goal and subgoal indexes.
- [x] Add status indexes.
- [x] Add confidence and updated-time indexes.
- [x] Add tag/entity indexing.
- [x] Add claim graph edge storage.
- [x] Add record write API.
- [x] Add record read API.
- [x] Add record list/query API.
- [x] Add record status update API.
- [x] Ensure contradiction updates preserve earlier evidence.
- [x] Ensure superseded records remain auditable.
- [x] Ensure tombstoned records are excluded from ordinary recall and context.
- [x] Add tests for write/read/list/update.
- [x] Add tests for contradiction preservation.
- [x] Add tests for superseded-record audit behavior.
- [x] Add tests for tombstoned-record exclusion.

## Phase 5: Recall And Preconscious Retrieval

Implement a `MemoryRetriever` that returns a larger staged candidate set before context packet compilation.

Status: completed on 2026-06-24.

Inputs:

- active root goal
- active subgoal
- completion gates
- stop gates
- recent events
- open questions
- action class under consideration
- available tools and governance constraints

Outputs:

- typed records
- scores
- selection reasons
- warnings about contradictions, staleness, or weak evidence

Scoring factors:

- relevance to active goal
- relevance to active subgoal
- recency
- confidence
- evidence quality
- contradiction risk
- novelty
- source authority
- graph centrality
- procedural applicability
- token and tool cost

Checklist:

- [x] Add `MemoryRetriever` interface.
- [x] Add retrieval input shape.
- [x] Add scored retrieval output shape.
- [x] Score relevance to active goal.
- [x] Score relevance to active subgoal.
- [x] Score recency.
- [x] Score confidence.
- [x] Score evidence quality.
- [x] Penalize or warn on contradiction risk.
- [x] Include relevant contradictions even when they lower confidence.
- [x] Score procedural applicability by action class.
- [x] Include prospective checks when trigger conditions are met.
- [x] Include selection reasons for every returned record.
- [x] Add tests proving direct evidence outranks stale weak evidence.
- [x] Add tests proving relevant contradictions are included.
- [x] Add tests proving procedures are action-class scoped.
- [x] Add tests proving prospective triggers surface.

## Phase 6: Context Packet Compiler v2

Split memory selection into two layers:

Status: completed on 2026-06-24.

- Preconscious memory: the larger retrieved candidate set.
- Conscious context: the bounded packet injected into a model call.

Required packet sections:

- goal frame
- active subgoal
- direct evidence
- prior episodes
- candidate procedures
- current hypotheses
- contradictions and uncertainty
- prospective commitments
- tool permissions and budget
- writeback expectations

Compiler responsibilities:

- Enforce section-level token budgets.
- Enforce an overall context token budget by pruning the lowest-ranked selected items after section compilation.
- Prefer direct evidence over inference.
- Preserve labels for evidence, inference, belief, and uncertainty.
- Include selection reasons for inspectability.
- Avoid dumping unlabeled memory blobs into the prompt.

Checklist:

- [x] Add preconscious-memory input type.
- [x] Add conscious-context packet v2 type.
- [x] Enforce section-level token budgets.
- [x] Enforce whole-packet token budgets by excluding lowest-ranked selected context items.
- [x] Prefer direct evidence over inference when budget is tight.
- [x] Preserve labels for evidence, inference, belief, and uncertainty.
- [x] Include selection reasons in context packet metadata.
- [x] Include contradictions and uncertainty when relevant.
- [x] Keep context packet references and summaries separate from durable memory.
- [x] Update flow capture to expose selection reasons.
- [x] Add tests for token budget behavior.
- [x] Add tests for evidence/inference labeling.
- [x] Add tests for contradiction retention.
- [x] Add tests for captured selection reasons.

## Phase 7: Memory Controller v2

Replace or augment the first-run controller with a memory-driven controller.

Status: completed on 2026-06-24.

Controller inputs:

- goal tree
- latest event ids
- retrieved preconscious memory
- available tools
- governance state
- loop budget and goal budget

Controller outputs:

- selected action class
- next bounded subgoal
- context packet
- tool budget
- proposed tool actions
- writeback expectations

Action classes:

- `recall`
- `inspect`
- `search`
- `analyze`
- `experiment`
- `ask_user`
- `synthesize`
- `respond`
- `stop`

Decision principles:

- Ask the user when missing information affects scope, authorization, or safety.
- Inspect when direct evidence is missing and local tools are available.
- Analyze when evidence exists but claims or hypotheses are weak.
- Experiment when a hypothesis has falsification criteria and tools are available.
- Synthesize only when enough evidence exists to update the goal state.
- Respond only when completion gates or ready-to-respond criteria are supported by memory.
- Stop immediately when a stop gate is triggered.

Checklist:

- [x] Add memory-driven controller input type.
- [x] Add memory-driven controller output type.
- [x] Feed retrieved preconscious memory into action selection.
- [x] Select bounded subgoals from memory, gates, and available tools.
- [x] Explain controller decisions from retrieved records and goal gates.
- [x] Preserve first-run fallback behavior.
- [x] Ask the user when scope, authorization, or safety is missing.
- [x] Inspect when direct evidence is missing and local tools are available.
- [x] Analyze when evidence exists but claims or hypotheses are weak.
- [x] Experiment when a hypothesis has falsification criteria and tools are available.
- [x] Synthesize only when enough evidence exists to update the goal state.
- [x] Respond only when supported by memory and gates.
- [x] Stop immediately when a stop gate is triggered.
- [x] Add tests for function-walk bounded subgoals.
- [x] Add tests for maximum function-count stop conditions.
- [x] Add tests for memory-backed completion-gate evaluation.
- [x] Add tests for decision explanation.

## Phase 8: Reflection And Consolidation

Run an explicit reflection step after meaningful loop boundaries.

Status: completed on 2026-06-24.

Reflection responsibilities:

- Update the active goal tree.
- Summarize the loop as an episodic record.
- Revise hypothesis status and confidence.
- Add evidence-for and evidence-against links.
- Promote repeated successful patterns into procedures.
- Mark stale, contradicted, or superseded records.
- Schedule prospective checks.

Initial reflection should be deterministic and schema-driven. Model-assisted summaries can be added later once the write pipeline and tests are stable.

Checklist:

- [x] Add reflection boundary detection.
- [x] Add deterministic reflection step.
- [x] Update active goal tree from reflected memory state.
- [x] Summarize loops as episodic records.
- [x] Revise hypothesis status and confidence.
- [x] Add evidence-for links.
- [x] Add evidence-against links.
- [x] Promote repeated successful patterns into procedures.
- [x] Mark stale records.
- [x] Mark contradicted records.
- [x] Mark superseded records.
- [x] Schedule prospective checks.
- [x] Add tests for hypothesis updates.
- [x] Add tests for procedure promotion.
- [x] Add tests for contradictory evidence lowering confidence or status.
- [x] Add tests for prospective check scheduling.

## Phase 9: Forgetting, Governance, And Audit

Add explicit lifecycle controls for memory records.

Status: completed on 2026-06-24.

Capabilities:

- tombstone
- supersede
- expire
- delete under policy
- audit write
- audit promotion
- audit contradiction
- audit deletion

Rules:

- Tombstoned records should be excluded from recall and context.
- Superseded records should remain linked to their replacement.
- Deletion behavior should be policy-controlled and auditable.
- Raw event auditability should be preserved unless policy or user instruction requires deletion.

Checklist:

- [x] Add tombstone operation.
- [x] Add supersede operation.
- [x] Add expiration operation.
- [x] Add policy-controlled deletion operation.
- [x] Add audit events for writes.
- [x] Add audit events for promotion.
- [x] Add audit events for contradiction.
- [x] Add audit events for deletion.
- [x] Exclude tombstoned records from recall and context.
- [x] Link superseded records to replacements.
- [x] Preserve raw event auditability by default.
- [x] Add tests for tombstoned context exclusion.
- [x] Add tests for superseded audit views.
- [x] Add tests for expired retrieval exclusion.
- [x] Add tests for policy deletion behavior.

## Phase 10: Local Inspectability

Add CLI or debug commands so memory behavior can be inspected without reading internal files by hand.

Status: completed on 2026-06-24.

Useful commands:

- event timeline
- show event by id
- show derived records for event
- run recall query
- show preconscious packet
- show compiled context packet
- explain selected action
- show hypotheses
- show claim graph
- show prospective checks

Captured flow output should include:

- accepted raw events
- rejected raw events and rejection reasons
- candidate writes
- committed writes
- retrieval results
- context packet selections
- controller decision reasons

Checklist:

- [x] Add event timeline command or debug view.
- [x] Add show-event-by-id command or debug view.
- [x] Add show-derived-records-for-event command or debug view.
- [x] Add recall-query command or debug view.
- [x] Add preconscious-packet inspection.
- [x] Add compiled-context-packet inspection.
- [x] Add selected-action explanation.
- [x] Add hypotheses inspection.
- [x] Add claim graph inspection.
- [x] Add prospective checks inspection.
- [x] Include accepted raw events in captured flow output.
- [x] Include rejected raw events and rejection reasons in captured flow output.
- [x] Include candidate writes in captured flow output.
- [x] Include committed writes in captured flow output.
- [x] Include retrieval results in captured flow output.
- [x] Include context packet selections in captured flow output.
- [x] Include controller decision reasons in captured flow output.

## Next Implementation Increment

All planned phases are implemented. The next implementation slice should be a new integration plan that makes durable memory the default runtime path:

1. Replace first-run in-memory snapshot handoff with durable event-log append and record-store derivation.
2. Run retrieval, context packet v2 compilation, memory-driven controller decisions, reflection, and lifecycle checks inside the production loop.
3. Keep the phase-10 inspector and CLI commands as the local verification surface while integration proceeds.

Acceptance criteria:

- Existing tests continue to pass.
- Phase 1 through phase 10 checklist items remain implemented and verified.
- Durable memory becomes the default runtime loop source and sink without regressing the compatibility path.
- Memory behavior remains inspectable without reading SQLite or internal files by hand.
