# Changelog

## Unreleased

### Added

- Added migration 9 artifact revision events so Runbook and Report revisions retain their session and timestamp for workspace activity timelines; existing artifacts receive a conservative latest-known revision event.
- Added first-class revisioned Markdown reports with Complete and Stale states, dedicated `report.*` tools, and workspace artifact storage. Migration 8 adds report metadata, and bundled Security Research and Mathematics profiles advance to 1.2.0 with domain-specific report guidance.
- Added a bundled Mathematics research profile with domain-specific memory types, evidence rules, relations, and exploration, proof, verification, and synthesis workflows; `profile resolve --profile-id mathematics` exposes it to host frontends.
- Exposed the bundled profile ID catalog, profile resolver, Mathematics default, and deterministic profile hash through the narrow `@honeycrisp/research-agent/workspace-tools` compatibility surface for local agent bridges.
- Added a narrow `@honeycrisp/research-agent/workspace-tools` compatibility surface and stored workspace resolvers for external local agents, including deterministic workspace identity, Beale research-subject precedence, external session membership, recorded authorization projection, and hash-validated active research-profile snapshots with workspace-profile fallback.
- Added strict schema-v1 research profiles with a bundled security default, workspace and explicit resolution, deterministic hashed snapshots, arbitrary workflows, domain-specific agent and workspace language, dynamic memory catalogs, capability defaults, auxiliary model-job routes, presentation labels, a resolver CLI envelope, and a complete general-research example.
- Added Manual Approval, provider-small-model Auto-Review, and Danger Mode authorization for host shell commands, including live mode changes and correlated concurrent approval responses.

### Changed

- Research profiles can now define a session-heat palette and status-specific heat for each memory type; the bundled Security Research and Mathematics profiles include distinct defaults.
- Standardized the bundled Mathematics profile presentation labels on Memory and Runbooks.
- Extended the built-in provider catalog with Claude Opus 5 and the OpenAI Codex `gpt-daybreak-blue-latest` model for runtime selection and host frontends.
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

- Added a file-backed resume fallback prompt option so host frontends can continue large sessions without exceeding operating-system process command-line limits.
- Retried transient provider and transport failures during background session-title generation before reporting the title job as failed.
- Aligned memory tool schemas and research-agent guidance on lowercase-hyphenated root-cause keys while treating source, sink, and asset links as recommended rather than required for confirmed chains.
- Prevented long research turns from retaining full-context deep copies for ordinary and parallel tool calls; spawn inheritance uses bounded structural snapshots, while model-visible tool details omit full outputs that remain available in canonical observed events and artifacts.
- Aborted the underlying tool execution when its runtime budget expires so a late shell approval cannot spawn a process after the command was reported blocked.
- Made context-window recovery one-shot, authoritative for subsequent turns, and durable in resumable state while stripping bulky raw tool-result details.
- Kept peer-agent output in a lower-trust assistant-data envelope, rejected self-messaging, derived safety-recovery authorization only from host workspace metadata, retained adopted recovery context across later turns, and kept provider error text out of host steering instructions.
- Limited safeguard recovery to one automatic retry, then wait interruptibly for correlated host steering and broadcast it to every active agent without changing provider sessions; reasoning-only rejected output is discarded, transient retries are bounded, and root failures clean up active descendants.

### Security

- Kept stored workspace binding and profile results free of database, storage, and profile-source paths so host-held credential references remain withheld.
- Removed Honeycrisp's application-level network profiles, destination allowlists, temporal network authorization gate, and fail-closed network veto. Network intent remains reviewer-visible audit metadata, while enforceable network isolation is delegated to operator-managed system controls.
- Kept profile capability choices inside host policy: workspace and explicit profiles have no executable authority without direct host grants or bounded family/side-effect ceilings; MCP and selected skills remain explicit host-only, profile MCP server IDs can only restrict a host allowlist, and only the code-owned bundled security profile retains deliberate local shell defaults. Direct agent bootstrap now rejects stale resolved-profile hashes before compiling context, and non-security safeguard recovery uses neutral profile and workspace-boundary language while the bundled security profile retains its stronger security-specific recovery policy. The bundled security profile now requires evidence for new or transitioned confirmed primitives and chains without retroactively invalidating legacy rows.
- Enforced shell authorization after immutable utility and protected-directory checks but before lease acquisition or process spawn; Auto-Review uses assigned provider-small-model defaults and fails closed even when a provider ignores cancellation, Manual Approval refuses commands whose executable fields cannot be displayed exactly, and shell events/results omit raw stdin while redacting paired credential arguments, cookie values, and authorization headers.

### Removed

- Removed the second-model background memory curator, its advisory `memory.request` tool, provider-model CLI options, turn queue, notifications, and synthetic activity events.
