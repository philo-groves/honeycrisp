# Changelog

## Unreleased

### Added

- Added strict schema-v1 research profiles with a bundled security default, workspace and explicit resolution, deterministic hashed snapshots, arbitrary workflows, domain-specific agent and workspace language, dynamic memory catalogs, capability defaults, auxiliary model-job routes, presentation labels, a resolver CLI envelope, and a complete general-research example.
- Added Manual Approval, provider-small-model Auto-Review, and Danger Mode authorization for host shell commands, including live mode changes and correlated concurrent approval responses.

### Changed

- Made durable memory type and status IDs open profile-defined strings, with renameable display names, aliases, retirement and replacement metadata, typed attributes, conditional evidence/asset/neighbor requirements, status polarity and context weighting, profile-aware tool schemas and model context, and readable grandfathered rows whose stored IDs are retired or unknown.
- Added bounded JSON attribute and evidence inputs to standalone memory save and correction commands so profile-required schemas can be satisfied outside an agent run.
- Added immutable, separately hashed memory-catalog provenance so workflow-only profile changes share compatible nodes, incompatible catalogs do not silently merge identities, and legacy rows remain explicitly unrecorded.
- Made catalog evolution compatible per stored node instead of treating every exact catalog-hash change as a new memory universe; presentation edits and unrelated additive entries preserve recall and stable identities, while legacy pre-profile rows remain confined to the bundled security-compatible lineage.
- Made neighbor requirements executable through atomic node-and-link writes, made duplicate attribute keys wholly type-conditional, and allowed memory-disabled profiles to use an empty catalog.
- Pinned each run, capture, and continuation to one normalized research-profile snapshot and workflow; legacy memory-description overrides now produce a new effective profile hash.
- Made the configurable memory-type descriptions the authoritative taxonomy for research-agent prompts, with a validated CLI transport for host frontends.
- Reworked model-context compaction to use copy-on-write message arrays, compact toward a lower watermark, retain untouched immutable messages by reference, discard history before the latest accepted native OpenAI compaction boundary, and release the loop's discarded message accumulator after each turn.
- Returned `memory.save`, `memory.correct`, and `memory.link` to root agents and subagents alongside memory search and retrieval, so the active agent with full research context directly owns durable persistence.
- Replaced storage tiers with subject-owned memories that accumulate session and workspace membership lists whenever they are saved or corrected; memory search now uses a single Session, Workspace, or Subject scope while save no longer asks the model to choose ownership.
- Loaded Codex-compatible `AGENTS.md` guidance once per invocation from the host configuration and active workspace into root and subagent system context, including continuation invocations, while retaining only source metadata in durable events.
- Preserved OpenAI Codex commentary and final-answer message phases in live root and subagent output, selected only terminal answer text for captured results, and instructed every research agent to emit concise user-facing commentary while working.
- Calibrated the core research system prompt around world-class security-research capability, adaptive subsystem exploration, and treating hypotheses as temporary leads rather than binary session objectives.
- Made research-goal lifecycle state host-managed: terminal state is inferred from structured session dispositions, model-facing goal controls were removed, and continuations now use bounded research-focused context.
- Added `--goal-objective` so frontends can keep a concise persistent objective separate from an expanded research prompt.
- Added host-side research checkpoints after every native, local, or retry compaction, persisted goal/focus state across process resumes, bounded repeated-read recovery with later and externally-triggered state probes, and sustained tool-only loop steering. Checkpoints replace prior copies, retain bounded decisive tool evidence in a distinct provider-safe host assistant-data envelope without rewriting real tool results, and host-control events survive flow-capture recovery.
- Explicitly resumed terminal goals now reactivate for the new invocation while preserving prior turn history, and host-generated continuation messages no longer elevate model-authored summaries or tool arguments into user-role instructions.

### Fixed

- Aligned memory tool schemas and research-agent guidance on lowercase-hyphenated root-cause keys while treating source, sink, and asset links as recommended rather than required for confirmed chains.
- Prevented long research turns from retaining full-context deep copies for ordinary and parallel tool calls; spawn inheritance uses bounded structural snapshots, while model-visible tool details omit full outputs that remain available in canonical observed events and artifacts.
- Aborted the underlying tool execution when its runtime budget expires so a late shell approval cannot spawn a process after the command was reported blocked.
- Made context-window recovery one-shot, authoritative for subsequent turns, and durable in resumable state while stripping bulky raw tool-result details.
- Kept peer-agent output in a lower-trust assistant-data envelope, rejected self-messaging, derived safety-recovery authorization only from host workspace metadata, retained adopted recovery context across later turns, and kept provider error text out of host steering instructions.
- Limited safeguard recovery to one automatic retry, then wait interruptibly for correlated host steering and broadcast it to every active agent without changing provider sessions; reasoning-only rejected output is discarded, transient retries are bounded, and root failures clean up active descendants.

### Security

- Kept profile capability choices inside host policy: workspace and explicit profiles have no executable authority without direct host grants or bounded family/side-effect ceilings; network, MCP, and selected skills remain explicit host-only, profile MCP server IDs can only restrict a host allowlist, and only the code-owned bundled security profile retains deliberate local shell defaults. Direct agent bootstrap now rejects stale resolved-profile hashes before compiling context, and non-security safeguard recovery uses neutral profile and workspace-boundary language while the bundled security profile retains its stronger security-specific recovery policy. Recognized shell network intent now fails closed before every approval mode unless the host explicitly allows network effects and supplies active recorded authorization; scoped commands must resolve entirely to host-recorded destinations. The bundled security profile now requires evidence for new or transitioned confirmed primitives and chains without retroactively invalidating legacy rows.
- Enforced shell authorization after immutable utility and protected-directory checks but before lease acquisition or process spawn; Auto-Review uses assigned provider-small-model defaults and fails closed even when a provider ignores cancellation, Manual Approval refuses commands whose executable fields cannot be displayed exactly, and shell events/results omit raw stdin while redacting paired credential arguments, cookie values, and authorization headers.

### Removed

- Removed the second-model background memory curator, its advisory `memory.request` tool, provider-model CLI options, turn queue, notifications, and synthetic activity events.
