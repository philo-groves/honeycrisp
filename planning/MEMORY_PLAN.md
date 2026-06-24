# Memory Layer Implementation Plan

This plan turns the architecture's memory model into an incremental implementation path. The guiding principle is:

1. Raw events are the source of truth.
2. Memory records are derived from accepted events.
3. Context packets are compiled views over memory, not memory itself.

The implementation should preserve the distinction between direct evidence, model inference, hypotheses, procedures, and user commitments. Private model thoughts should not be durably stored, but their visible consequences can be persisted as structured trace fields and accepted events.

## Current Baseline

The project already has a first-pass runtime loop, goal frame generation, trace handling, local inspection, context packet compilation, and primitive memory routing. The current memory layer is useful for first-run experiments, but it is not yet the core driver described in the architecture.

Known limitations to address:

- Memory is mostly an in-memory snapshot derived from recent events.
- There is no durable append-only event log abstraction.
- Derived memory records are not yet typed as first-class persisted entities.
- Recall is not yet a scored retrieval step.
- Context compilation does not distinguish a larger preconscious candidate set from the bounded conscious packet.
- Reflection and consolidation are not yet explicit loop-boundary operations.
- Forgetting, tombstoning, superseding, and audit behavior are not yet implemented.

## Phase 1: Stabilize Memory Contracts

Define the durable and derived-memory contracts before adding more behavior.

Deliverables:

- Canonical event id and sequence format.
- Shared provenance shape for all derived records.
- Stable memory record ids.
- Explicit status values for derived records, such as `candidate`, `active`, `confirmed`, `contradicted`, `superseded`, `stale`, and `tombstoned`.
- Clear separation between:
  - raw event payloads
  - evidence records
  - semantic claims
  - hypotheses and beliefs
  - procedures
  - prospective checks
  - context packet references

Design constraints:

- Context packets should contain references and summaries, not become the durable source of truth.
- Claims and hypotheses must preserve evidence-for and evidence-against separately.
- Procedures should require repeated usefulness or explicit promotion before becoming durable guidance.

## Phase 2: Retain With An Append-Only Event Log

Add a `MemoryEventLog` abstraction that stores accepted events before summarization or consolidation.

Suggested layout:

```text
.honeycrisp/
  memory/
    events/
    artifacts/
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

Deliverables:

- Append-only JSONL event log.
- Read by id, sequence range, goal id, loop id, and event kind.
- Validation before append.
- Redaction or rejection hooks for disallowed event kinds.
- Restart-safe loading.

Tests:

- Events append in deterministic sequence order.
- Restart reload preserves event order.
- Invalid event payloads are rejected.
- Private thought-like data is not accepted into durable storage.

## Phase 3: Add The Memory Write Pipeline

Introduce a `MemoryWritePipeline` that converts accepted events into typed candidate memory records.

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

Tests:

- A tool observation produces an evidence-backed record.
- A model claim is stored as a candidate claim, not direct evidence.
- A model hypothesis keeps evidence-for and evidence-against separate.
- Goal completion or stop events produce episodic summaries.

## Phase 4: Add Typed Stores And Indexes

Persist derived records as first-class memory.

Suggested layout:

```text
.honeycrisp/
  memory/
    episodes/
    claims/
    procedures/
    hypotheses/
    prospective/
    artifacts/
```

Initial implementation should use local files and deterministic indexes. Avoid introducing a vector database until record semantics and retrieval behavior are stable.

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

Tests:

- Records can be written, read, listed, and updated.
- Contradiction updates do not destroy earlier evidence.
- Superseded records remain auditable but are excluded from ordinary recall.
- Tombstoned records are omitted from context compilation.

## Phase 5: Recall And Preconscious Retrieval

Implement a `MemoryRetriever` that returns a larger staged candidate set before context packet compilation.

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

Tests:

- Relevant direct evidence outranks stale weak evidence.
- Contradictions are included when they affect an active claim or hypothesis.
- Procedures are only returned when applicable to the current action class.
- Prospective checks surface when their trigger conditions are met.

## Phase 6: Context Packet Compiler v2

Split memory selection into two layers:

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
- Prefer direct evidence over inference.
- Preserve labels for evidence, inference, belief, and uncertainty.
- Include selection reasons for inspectability.
- Avoid dumping unlabeled memory blobs into the prompt.

Tests:

- Packet compilation respects token budgets.
- Evidence and inference remain separately labeled.
- Important contradictions are not dropped when relevant.
- Selection reasons are visible in captured flow output.

## Phase 7: Memory Controller v2

Replace or augment the first-run controller with a memory-driven controller.

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

Tests:

- A function-walk goal creates one bounded subgoal per function.
- A stop condition halts after the requested maximum function count.
- Completion gates are evaluated from memory state, not loop count alone.
- Controller decisions can be explained from retrieved records and goal gates.

## Phase 8: Reflection And Consolidation

Run an explicit reflection step after meaningful loop boundaries.

Reflection responsibilities:

- Update the active goal tree.
- Summarize the loop as an episodic record.
- Revise hypothesis status and confidence.
- Add evidence-for and evidence-against links.
- Promote repeated successful patterns into procedures.
- Mark stale, contradicted, or superseded records.
- Schedule prospective checks.

Initial reflection should be deterministic and schema-driven. Model-assisted summaries can be added later once the write pipeline and tests are stable.

Tests:

- A loop result updates relevant hypothesis state.
- Repeated useful behavior can promote a procedure.
- Contradictory evidence lowers confidence or changes status.
- Prospective checks are scheduled from unresolved follow-up needs.

## Phase 9: Forgetting, Governance, And Audit

Add explicit lifecycle controls for memory records.

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

Tests:

- Tombstoned records do not enter context packets.
- Superseded records remain reachable through audit views.
- Expired records are excluded from normal retrieval.
- Policy deletion removes the allowed stores while preserving required audit facts.

## Phase 10: Local Inspectability

Add CLI or debug commands so memory behavior can be inspected without reading internal files by hand.

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

## First Implementation Increment

The first implementation slice should be intentionally small:

1. Add typed memory record interfaces.
2. Add the file-backed append-only `MemoryEventLog`.
3. Add the `MemoryWritePipeline` for the event kinds already emitted by the runtime.
4. Adapt the current memory routing layer to read from the new write pipeline while preserving the existing public context snapshot shape.
5. Add tests for event retention, candidate writes, and context compatibility.

Acceptance criteria:

- Existing tests continue to pass.
- Raw accepted events are durably append-only.
- Tool observations become evidence-backed derived records.
- Model claims and hypotheses become derived records with proper labels.
- Private thought traces are not durably stored.
- Context packets still compile successfully from the derived memory output.

