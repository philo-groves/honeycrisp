# Changelog

## Unreleased

### Changed

- Calibrated the core research system prompt around world-class security-research capability, adaptive subsystem exploration, and treating hypotheses as temporary leads rather than binary session objectives.
- Made research-goal lifecycle state host-managed: terminal state is inferred from structured session dispositions, model-facing goal controls were removed, and continuations now use bounded research-focused context.
- Added `--goal-objective` so frontends can keep a concise persistent objective separate from an expanded research prompt.
- Added host-side research checkpoints after every native, local, or retry compaction, persisted goal/focus state across process resumes, bounded repeated-read recovery with later and externally-triggered state probes, and sustained tool-only loop steering. Checkpoints replace prior copies, retain bounded decisive tool evidence in a distinct provider-safe host assistant-data envelope without rewriting real tool results, and host-control events survive flow-capture recovery.
- Explicitly resumed terminal goals now reactivate for the new invocation while preserving prior turn history, and host-generated continuation messages no longer elevate model-authored summaries or tool arguments into user-role instructions.

### Fixed

- Made context-window recovery one-shot, authoritative for subsequent turns, and durable in resumable state while stripping bulky raw tool-result details.
- Kept peer-agent output in a lower-trust assistant-data envelope, rejected self-messaging, derived safety-recovery authorization only from host workspace metadata, retained adopted recovery context across later turns, and kept provider error text out of host steering instructions.
- Limited safeguard recovery to one automatic retry, then wait interruptibly for correlated host steering and broadcast it to every active agent without changing provider sessions; reasoning-only rejected output is discarded, transient retries are bounded, and root failures clean up active descendants.
