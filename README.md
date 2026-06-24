# Honeycrisp

Honeycrisp is an experimental research agent for long-running, goal-oriented work such as vulnerability research, mathematics, puzzles, and evidence synthesis.

Honeycrisp is based on Pi's published core packages:

- `@earendil-works/pi-ai` for cross-provider model support.
- `@earendil-works/pi-agent-core` for the agent runtime, tool calling, and state management.

Honeycrisp is not a fork of Pi and is not an implementation of `pi-coding-agent`. This repository should contain the research-agent functionality around Pi, not local replacements for Pi's core packages.

## Packages

- `@honeycrisp/research-agent`: research-goal and memory-policy scaffolding built on Pi.
- `honeycrisp`: command-line entry point for running research prompts.

## Development

```sh
pnpm install
pnpm build
pnpm start -p "Investigate the prompt as a research goal"
```

The first runtime step converts `honeycrisp -p <prompt>` into a goal frame with a root goal, success gates, stop gates, scope constraints, user preferences, evidence requirements, and initial risk flags. Prompts can provide those fields inline with labels such as `Goal:`, `Success gates:`, `Stop gates:`, `Scope constraints:`, `Evidence:`, `Preferences:`, and `Risk:`.

CLI flags can also add explicit fields:

```sh
pnpm start -p "Investigate parser behavior" \
  --scope "local corpus only" \
  --evidence "preserve repro provenance" \
  --json
```

On a first run, Honeycrisp also asks the memory controller for the next bounded sub-goal, compiles a context packet, and turns that decision into a loop plan. Until durable memory and tools are integrated, the packet contains empty typed memory buckets, explicit open questions, user commitments from the goal frame, tool permissions, tool budget, and writeback expectations. The loop plan is the executable per-loop contract: reason, required context manifest, permitted tool classes, action budget, expected artifacts, completion gates, writeback requirements, and a model-facing loop prompt.

## Auth

Honeycrisp stores provider credentials in `~/.honeycrisp/auth.json` by default, or the path set in `HONEYCRISP_AUTH_FILE`.

```sh
pnpm start auth list
pnpm start auth login openai-codex
pnpm start auth status openai-codex
pnpm start auth verify openai-codex
```
