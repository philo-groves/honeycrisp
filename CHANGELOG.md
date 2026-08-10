# Changelog

## Unreleased

### Added

- Added a serialized provider-matched background memory curator that reviews completed root and subagent turns, validates explicit memory requests, maintains graph relationships, emits live mutation activity, and carries persistence notifications into the root agent's next natural turn or resumable context.
- Added Manual Approval, provider-small-model Auto-Review, and Danger Mode authorization for host shell commands, including live mode changes and correlated concurrent approval responses.

### Changed

- Made the configurable memory-type descriptions the shared authoritative taxonomy for research-agent and background-curator prompts, with a validated CLI transport for host frontends.
- Reworked model-context compaction to use copy-on-write message arrays, compact toward a lower watermark, retain untouched immutable messages by reference, discard history before the latest accepted native OpenAI compaction boundary, and release the loop's discarded message accumulator after each turn.
- Replaced model-facing memory mutation tools with read-only search/get access plus advisory `memory.request`; trusted background curation now owns memory creation, correction, and linking and drains its turn queue before capture and shutdown.
- Replaced storage tiers with subject-owned memories that accumulate session and workspace membership lists whenever they are saved or corrected; memory search now uses a single Session, Workspace, or Subject scope while save no longer asks the model to choose ownership.
- Loaded Codex-compatible `AGENTS.md` guidance once per invocation from the host configuration and active workspace into root and subagent system context, including continuation invocations, while retaining only source metadata in durable events.
- Preserved OpenAI Codex commentary and final-answer message phases in live root and subagent output, selected only terminal answer text for captured results, and instructed every research agent to emit concise user-facing commentary while working.
- Calibrated the core research system prompt around world-class security-research capability, adaptive subsystem exploration, and treating hypotheses as temporary leads rather than binary session objectives.
- Made research-goal lifecycle state host-managed: terminal state is inferred from structured session dispositions, model-facing goal controls were removed, and continuations now use bounded research-focused context.
- Added `--goal-objective` so frontends can keep a concise persistent objective separate from an expanded research prompt.
- Added host-side research checkpoints after every native, local, or retry compaction, persisted goal/focus state across process resumes, bounded repeated-read recovery with later and externally-triggered state probes, and sustained tool-only loop steering. Checkpoints replace prior copies, retain bounded decisive tool evidence in a distinct provider-safe host assistant-data envelope without rewriting real tool results, and host-control events survive flow-capture recovery.
- Explicitly resumed terminal goals now reactivate for the new invocation while preserving prior turn history, and host-generated continuation messages no longer elevate model-authored summaries or tool arguments into user-role instructions.

### Fixed

- Normalized common case and separator variants in memory-curator temporary refs and their `@ref` link endpoints so otherwise valid curation plans do not fail on model-generated ref spelling.
- Aligned research-agent requests, curator prompting, and validation on lowercase-hyphenated root-cause keys, normalized equivalent separators at the curator boundary, and made source, sink, and asset links recommended rather than required for confirmed chains.
- Consolidated same-type curator saves by stable or semantically equivalent root cause even when titles differ, preserved established root-cause identities during additive refinement, and rejected primitive mutations that omit root-cause metadata.
- Prevented long research turns from retaining full-context deep copies for ordinary and parallel tool calls; spawn inheritance and curator queueing now use bounded structural snapshots, while model-visible tool details omit full outputs that remain available in canonical observed events and artifacts.
- Stopping a research session now cancels the active background memory-curator review and silently drops queued reviews instead of draining the aborted queue as a burst of failed tool events.
- Aborted the underlying tool execution when its runtime budget expires so a late shell approval cannot spawn a process after the command was reported blocked.
- Made context-window recovery one-shot, authoritative for subsequent turns, and durable in resumable state while stripping bulky raw tool-result details.
- Kept peer-agent output in a lower-trust assistant-data envelope, rejected self-messaging, derived safety-recovery authorization only from host workspace metadata, retained adopted recovery context across later turns, and kept provider error text out of host steering instructions.
- Limited safeguard recovery to one automatic retry, then wait interruptibly for correlated host steering and broadcast it to every active agent without changing provider sessions; reasoning-only rejected output is discarded, transient retries are bounded, and root failures clean up active descendants.

### Security

- Enforced shell authorization after immutable utility and protected-directory checks but before lease acquisition or process spawn; Auto-Review uses assigned provider-small-model defaults and fails closed even when a provider ignores cancellation, Manual Approval refuses commands whose executable fields cannot be displayed exactly, and shell events/results omit raw stdin while redacting paired credential arguments, cookie values, and authorization headers.
