# Architecture
Honeycrisp is a general purpose research agent. The architecture is composed of several layers:

- **Processing Layer**: Goal and sub-goal loop planning, execution, and completion gates.
- **Memory Layer**: A cognitive research memory layer that drives action selection and context construction.
- **Tool Layer**: A controlled action surface for searches, file work, analysis, experiments, and external systems.
- **Storage Layer**: Persistent file-based storage to supplement memory.
- **Config Layer**: Non-secret preferences for the provider, model, and effort.

In other words: The processing layer keeps the agent oriented around a goal tree. The memory layer decides what the agent should know and do next. The tool layer executes bounded actions. The storage layer manages structured file system interactions. The config layer selects provider/model/effort preferences for already-authorized model calls.

Honeycrisp should remain goal-based: every run has a root goal, every loop has a bounded sub-goal, and every response is judged against completion gates. The important change is that sub-goals are not planned from prompt text alone. They are proposed by the memory controller after reviewing working state, past episodes, claims, procedures, hypotheses, prospective commitments, and available tools.

## Implementation Status

The current runtime has the integrated first slice of the architecture in place:

- Real CLI runs use durable SQLite memory by default, append accepted events during each loop, consolidate derived records, retrieve before later loops, and capture context packet v2 plus memory-controller metadata.
- General agent-state contracts are owned by Honeycrisp. Evidence, episodes, semantic claims, hypotheses, findings, beliefs, procedures, prospective checks, proof state, storage refs, goal state, and context usage should be exposed through Honeycrisp APIs/CLI rather than reimplemented by client interfaces.
- Built-in tools are registered through the tool registry, governed by side-effect and budget policy, emitted as `tool.requested` and `tool.observed` events, and routed through the memory write pipeline.
- Local MCP servers can be configured through an explicit stdio JSON-RPC config and allowlist. MCP outputs are treated as untrusted external content.
- Local skills can be loaded from `SKILL.md` directories, selected by id, and injected as bounded runtime context without overriding governance.
- Allowlisted experiments can be configured as local subprocess tools with explicit side-effect policy, permissions, timeouts, output limits, stdout/stderr hashing, and artifact registration.
- Storage creates the default `.honeycrisp/memory/` directory layout and records persisted artifacts in `artifacts/manifest.json` with size, hash, kind, purpose, path, and source event ids.
- Config is preference-only. The CLI reads `.honeycrisp/config.json` under `--workspace-root` by default, provides `honeycrisp config show/set`, and still requires provider credentials to be authorized through the auth layer.

Known limitations after this slice:

- Findings and proof/verifier contracts are defined as general interfaces, but their lifecycle write pipeline, inspector commands, and Beale-facing steering APIs remain future work.
- MCP support currently targets configured stdio servers; richer transport management, authentication handoff, and long-lived server health monitoring remain future work.
- Experiment tools are allowlisted and auditable, but they are not a security sandbox. Operators must still choose safe commands and working directories.
- Memory retrieval is sparse/structured and graph-aware enough for the current integration path; dense embedding retrieval and more advanced utility learning remain future work.
- Flow captures intentionally summarize event timelines. Use the durable event log and storage manifest when exact artifact refs, source event ids, or full raw outputs are needed.
- Integration health checks are documented command sequences plus deterministic regression tests, not yet a single packaged CI command that can safely run live models everywhere.

## Runtime Model

The runtime flow is:

1. The user prompt becomes a root goal with positive and negative completion gates.
2. The memory controller builds an initial goal frame and context packet.
3. The processing layer requests the next bounded sub-goal.
4. The memory controller retrieves relevant memory, selects an action class, and proposes one or more tool actions.
5. The model executes the sub-goal with the supplied context packet and action budget.
6. Tool results, observations, decisions, and artifacts are appended to the immutable event log.
7. The memory write pipeline updates working, episodic, semantic, procedural, hypothesis, and prospective memory. Later phases add first-class finding and proof lifecycle writes.
8. The loop repeats until the root goal is complete, blocked, or ready for user response.

The memory controller is therefore the action driver. The processing layer owns the loop shape; memory owns the next-action policy.

## Config

The config layer is not an auth layer. It stores and resolves model preferences only:

- provider id
- model id
- effort level

Provider credentials are managed by the CLI auth layer. A configured provider/model must already be authorized through `honeycrisp auth login`. When no config file or CLI override is provided, Honeycrisp selects the first authorized provider/model found in the auth store. If no authorized provider exists, real mode fails before model execution and asks the user to log in or provide a config preference for an already-authorized provider.

By default, project preferences live at `.honeycrisp/config.json` under `--workspace-root`. CLI overrides remain higher precedence than both explicit and default config files.

## Processing
This section describes the general research workflow of the Honeycrisp agent. Research is never locked into a single workflow. Processing is conducted with a series of dynamic loops. The harness is built to provide the best security-relevant context to the model while processing.

### Goal Tree

The processing layer maintains a goal tree. The root goal represents the user's requested outcome. Each child is a bounded sub-goal selected because it reduces uncertainty, produces required evidence, creates an artifact, or moves the session toward a completion gate.

Each goal node should track:

- id
- parent id
- status: `pending`, `active`, `complete`, `blocked`, or `superseded`
- objective
- rationale
- completion gates
- stop gates
- action class
- relevant memory references
- expected artifacts
- result summary

The processing layer chooses the loop cadence and enforces goal status transitions. The memory controller chooses the next executable leaf node and the action policy for that node.

### Processing Steps

#### 1. Research Prompt

Research instructions are provided to `honeycrisp -p <prompt>`. The prompt should be converted into a goal frame containing:

- root goal
- success gates
- failure or stop gates
- scope constraints
- user preferences
- evidence requirements
- initial risk flags

Frontier models are capable of interpreting broad instructions, while lesser models benefit from narrow targeted prompts. The harness should still normalize both into the same goal frame.

#### 2. Loop Planning

Honeycrisp plans each research loop according to the goal frame and current memory state. The output is a bounded sub-goal with:

- the reason this sub-goal matters
- required context
- permitted tool classes
- action budget
- expected artifacts
- completion gates
- writeback requirements

Loop planning should prefer short, inspectable sub-goals over large monolithic prompts. A good sub-goal is narrow enough that its result can be written back to memory with clear evidence and provenance.

#### 3. Loop Processing

Honeycrisp provides the planned loop prompt to the model with an isolated context packet. This context packet is assembled by the memory controller and should label content by type:

- direct evidence
- prior observations
- current hypotheses
- relevant procedures
- known contradictions
- open questions
- user commitments

After each loop, the agent records the result and asks the memory controller whether to continue the same branch, create a sibling sub-goal, refine the goal tree, or respond.

#### 4. Research Response

A response is generated and returned based on storage artifacts, transcripts, and memory. The response should distinguish sourced evidence from inference when that distinction matters. By default, the response format is natural language, but it may also be returned in JSON format with the `--json` CLI argument.

### Action Driver Loop

At each loop boundary, Honeycrisp should run the same action driver sequence:

1. Refresh working memory from the current goal tree and latest event ids.
2. Retrieve relevant episodes, claims, procedures, hypotheses, and prospective commitments.
3. Score candidate action classes against the active goal and completion gates.
4. Select the next sub-goal and permitted tool actions.
5. Compile a context packet for the model.
6. Execute the selected action through the processing and tool layers.
7. Append raw results to the event log.
8. Reflect and consolidate memory writes.
9. Update the goal node status.

This preserves a goal-based workflow while making memory the driver for what action happens next.

## Memory
Honeycrisp memory is more than a store of information. It accepts raw log events as input and outputs both context and action policy for the agent.

The memory system is ACT-R inspired, but it should not be centered on a hand-authored production-rule engine. For long-running research agents, the best primitive is traceable consolidation: raw events are retained, validated, promoted into typed memories, retrieved when relevant, and used to select the next action.

### Memory Controller

The memory controller is the decision layer between goals and tools. It is responsible for:

- updating the active goal tree
- deciding when to retrieve, search, inspect files, run analysis, ask the user, or stop
- compiling context packets for each sub-goal
- selecting tool classes and budgets
- validating candidate memory writes before consolidation
- preserving evidence, inference, and belief as separate categories
- scheduling future checks through prospective memory
- marking stale, contradicted, or superseded memories
- promoting evidence-backed conclusions into general findings
- tracking proof obligations and proof attempts without assuming a specific research domain

The controller should produce an explicit next-action decision:

```json
{
  "sub_goal": "bounded objective for the next loop",
  "action_class": "recall | search | inspect | analyze | experiment | synthesize | ask_user | respond",
  "context_packet": "typed context assembled from memory",
  "tool_budget": "limits for calls, time, files, or tokens",
  "completion_gates": ["observable condition"],
  "writeback": ["event", "episode", "claim", "procedure", "hypothesis", "finding", "prospective", "proof_state"]
}
```

Action selection should use utility, not prompt order alone. Useful scoring signals include relevance, source authority, temporal validity, past task utility, novelty, graph centrality, confidence, contradiction risk, sensitivity risk, and token or tool cost.

### Memory Operations

#### Retain

All tool calls, observations, quotes, decisions, errors, and generated artifacts are appended to the immutable event log before summarization. Candidate memories are extracted from the event log with provenance.

#### Recall

Recall combines sparse search, dense retrieval, graph traversal, temporal filters, entity links, and procedural applicability checks. Retrieval returns typed memory records, not unlabeled text blobs.

#### Reflect

Reflection runs after meaningful loop boundaries. It updates the goal tree, promotes durable lessons into procedural memory, revises hypotheses, marks contradictions, and writes an episodic summary linked to raw evidence.

#### Forget

Forgetting is controlled rather than accidental. Memories may expire, be superseded, be tombstoned, or be removed by user request. The event log should preserve auditability unless policy or user instruction requires deletion.

### Memory Stores

#### Immutable Event Log
An immutable event log acts as the single source of truth for the agent. This is never summarized away. Includes every source, tool call, observation, decision, code run, quote, and output.

#### Working Memory
Working memory enhances context with the correct relevant information. Includes active goal, current plan, constraints, open questions, evidence packet, scratch variables, and budget.

#### Episodic Memory
Episodic memory maintains the timeline or chronological diary, more structured than the event log. Includes task/session trajectories with goals, steps, sources consulted, failures, pivots, and outcomes.

#### Semantic Claim Graph
A semantic claim graph measures the validity of claims. Includes atomic claims with citations, source reliability, timestamp, validity interval, confidence, contradiction links, and support/oppose edges.

#### Procedural Memory
Procedural memory helps to recall muscle memory and lessons learned from previous work. Includes versioned research runbooks, search strategies, analysis recipes, scripts, tool-use patterns, and known failure recoveries.

#### Hypothesis Memory
Hypothesis memory tracks research hypotheses and their current states. Includes candidate theories, evidence for/against, uncertainty, unresolved objections, falsification criteria.

#### Finding Memory
Finding memory tracks promoted, evidence-backed research conclusions. Findings are domain-neutral: they may carry domain labels or metadata, but core status terms remain general: `candidate`, `needs_evidence`, `supported`, `verified`, `superseded`, `rejected`, `out_of_scope`, and `tombstoned`.

Findings are distinct from hypotheses and semantic claims. A hypothesis is a theory that still needs testing. A semantic claim is an atomic inferred statement. A finding is a reviewed conclusion with provenance links to evidence records, hypotheses, claims, artifact refs, and proof attempts.

#### Prospective Memory
Prospective memory aligns the agent with scenario information. Includes reminders, follow-up checks, monitoring tasks, "verify after release," "rerun when dataset updates," and commitments to the user.

#### Proof And Verifier State
Proof state tracks proof obligations and proof attempts. It is separate from derived memory records and indexed back to memory record ids, goals, sub-goals, evidence refs, and artifact refs. This avoids forcing every proof attempt to become a recalled memory while still allowing findings and hypotheses to cite proof outcomes.

Proof methods must remain general and extensible. The core contract covers mathematical proof, empirical reproduction, static analysis, dynamic execution, artifact validation, investigation corroboration, human review, domain skills, and MCP providers. Domains can add proof expectations through skills, MCP servers, or interface metadata without adding vulnerability-specific, mathematics-specific, or investigation-specific fields to Honeycrisp core.

### Memory Layers

#### Conscious
Synonymous with context. Conscious memory is the information provided to the agent as context for the current sub-goal. It should be small, typed, and directly relevant.

#### Preconscious
Managed by the harness. A much larger collection of information than conscious, staged as potentially relevant but not injected unless the controller selects it.

#### Automatic
Appended to conscious context when appropriate. Includes learned behaviors, always-on rules, tool safety constraints, and tips for commonly encountered mistakes. Automatic memory should be compact and periodically audited to avoid stale habits.

### Context Packet

The context packet is the only memory that reaches the model during a loop. It should be assembled from typed records and preserve labels:

- goal frame
- active sub-goal
- relevant evidence
- relevant prior episodes
- candidate procedures
- current hypotheses
- supported findings
- proof obligations and proof attempts
- contradictions and uncertainty
- tool permissions and budget
- writeback expectations

This prevents long-context dumping and keeps the model aware of whether it is seeing a source, a summary, an inference, or a belief.

### Client Interface Boundary

Honeycrisp should expose a durable read model for external interfaces. That read model should include:

- current goal and sub-goals
- latest compiled context and context usage
- evidence, episodes, semantic claims, hypotheses, findings, beliefs, procedures, prospective checks, and working memory
- proof obligations and proof attempts
- storage directories and artifact refs

Interfaces such as Beale should use this read model for general research state. Beale can still own program/project setup, prompt drafting, visualization, and domain-specific export or disclosure workflows. Beale should not maintain parallel general research ledgers, semantic memory, repository guard policy, VM sandbox policy, or benchmark runtimes when those concerns belong to Honeycrisp or to the operator's chosen environment.

## Tool Layer

Tools are selected by the memory controller and executed by the processing layer. Tool results always write to the event log before being summarized or interpreted.

### Tool Action Contract

Each tool action should have:

- action class
- concrete tool name
- required inputs
- expected outputs
- budget limits
- side-effect profile
- validation strategy
- memory writeback target

The action class vocabulary should stay small:

- `recall`: retrieve from memory without external side effects
- `search`: gather new external or repository information
- `inspect`: read existing files, artifacts, logs, traces, or records
- `analyze`: transform evidence into claims, summaries, graphs, or metrics
- `experiment`: run code, tests, probes, fuzzing, or simulations
- `synthesize`: produce an artifact, plan, report, patch, or final answer
- `ask_user`: request missing information when assumptions are risky
- `respond`: complete the current goal or report a blocker

Tools should not decide research strategy. They expose capabilities. The memory controller decides which capability is appropriate for the current sub-goal.

### Tool Registry

The tool layer exposes a registry that the memory controller can query. Each registered tool should describe:

- action classes it supports
- input schema
- output schema
- side effects
- required permissions
- expected latency and cost
- validation hooks
- artifact locations
- memory writeback defaults

The memory controller selects action classes and candidate tools. The processing layer validates that the selected tool is permitted for the current sub-goal and runtime configuration before execution.

Configured tool surfaces currently include local inspection, repository search, structured file reads, analysis, synthesis, storage listing, live MCP tools/resources, local skills, and allowlisted experiments.

### Tool Result Events

Every tool result should be logged as a structured event containing:

- tool name
- action class
- sub-goal id
- normalized inputs
- raw output pointers
- generated artifact pointers
- exit status
- error information
- evidence extracted
- claims proposed
- follow-up actions proposed

The result event is the bridge from tool execution back into memory. No tool output should be promoted directly into semantic or procedural memory without passing through the memory write pipeline.

## Storage
A strong cognitive memory layer is not enough for an agent to perform best. Just as a human cannot remember everything, the memory layer may forget older unused facts and may not know exact file data. The storage layer fixes this issue with structured file-based persistence.

Storage should be treated as durable substrate, not cognition. Memory stores indexes, summaries, claims, and pointers; storage preserves full artifacts, raw logs, generated files, datasets, reports, and reproducible scripts.

Default storage lives next to the SQLite memory database under `.honeycrisp/memory/`:

- `memory.sqlite`: durable memory event and record metadata.
- `events/`: append-only event logs, raw transcripts, and event-adjacent file payloads.
- `episodes/`: loop and session summaries linked to event ids.
- `claims/`: semantic claim graph data, citations, support links, and contradiction material.
- `procedures/`: reusable runbooks, scripts, tool recipes, and known recovery patterns.
- `hypotheses/`: active and retired research hypotheses with evidence for and against.
- `prospective/`: scheduled follow-ups, monitoring commitments, and future checks.
- `artifacts/`: reports, generated files, extracted data, raw tool outputs, and experiment outputs.
- `scratch/`: miscellaneous persistent workspace files that are not yet structured elsewhere.

The memory controller should store summaries, claims, decisions, procedures, commitments, and pointers to files rather than copying large artifacts into model context. Anything that should be recalled later belongs in memory, including paths or artifact references for persisted files. Storage is for full file contents, blobs, binaries, logs, generated artifacts, and other non-memory objects.
