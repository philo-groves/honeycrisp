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

On a real run, Honeycrisp opens durable SQLite memory under the workspace root, asks the memory controller for the next bounded sub-goal, retrieves relevant records, compiles context packet v2, exposes configured tools and storage guidance, and processes the loop with a Pi-backed executor. Accepted runtime events are appended to `.honeycrisp/memory/memory.sqlite`, derived records are consolidated after each loop, and captures include memory integration, storage manifest, tool, skill, MCP, and model-config metadata.

Run with stored auth. If no config is provided, Honeycrisp first checks `.honeycrisp/config.json` under `--workspace-root`, then falls back to the first authorized provider/model from the CLI auth store. A config file is only a model preference file; credentials still come from `honeycrisp auth login`.

```sh
pnpm start \
  --max-tokens 1800 \
  -p "Goal: Produce a first-run research plan..."
```

Optional model preference config:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.3-codex-spark",
  "effort": "minimal"
}
```

```sh
pnpm start --config ./honeycrisp.config.json -p "Goal: Produce a first-run research plan..."
```

The project config can also be managed through the CLI:

```sh
pnpm start config set provider openai-codex
pnpm start config set model gpt-5.3-codex-spark
pnpm start config set effort minimal
pnpm start config show
```

CLI flags such as `--provider`, `--model`, and `--effort` override the config file for a run. The selected provider/model must already be authorized through the auth CLI.

Use `--mock` for deterministic offline practice runs that do not make model calls.

```sh
pnpm start --mock -p "Goal: Produce a first-run research plan..."
```

For local practice runs, Honeycrisp can seed the raw event log from a bounded
read-only inspection, execute configured tools, and write a flow-capture artifact:

```sh
pnpm start --mock \
  --inspect-root /path/to/project \
  --inspect-path /path/to/project/src/file.c \
  --inspect-bytes 1024 \
  --goal-loops 2 \
  --capture .honeycrisp-runs/example-flow.json \
  -p "Goal: Triage local source evidence"
```

The capture JSON records the event timeline, routed memory counts, context
packet view, loop result, and visible research trace. It preserves reasoning
consequences such as observations, inferences, hypotheses, assumptions, and
uncertainty, not private model thought traces.

Storage lives beside durable memory under `.honeycrisp/memory/`. The runtime creates `events/`, `episodes/`, `claims/`, `procedures/`, `hypotheses/`, `prospective/`, `artifacts/`, and `scratch/`; large raw outputs and generated artifacts are recorded in `.honeycrisp/memory/artifacts/manifest.json` with hashes and event provenance. Memory should store recallable facts and pointers to files; storage should hold full files, blobs, binaries, logs, and generated artifacts.

An end-to-end real health check should use the same integrated path users rely on:

```sh
pnpm start config set provider openai-codex --workspace-root .honeycrisp-health
pnpm start config set model gpt-5.3-codex-spark --workspace-root .honeycrisp-health
pnpm start config set effort minimal --workspace-root .honeycrisp-health

pnpm start \
  --workspace-root .honeycrisp-health \
  --repo-root /path/to/local/research-target \
  --file-read-root /path/to/local/research-target \
  --tool-family storage \
  --allowed-side-effect read \
  --tool-max-calls 2 \
  --goal-loops 2 \
  --capture .honeycrisp-health/flow.json \
  -p "Goal: Inspect the local target and summarize one evidence-backed finding"
```

Review the capture for `runtimeConfig.modelConfig.source`, `memoryIntegration`, `contextV2`, selected tools, storage directories, storage manifest entries, and tool events. Add `--mcp-config` plus `--allow-mcp-server` for live MCP servers, and `--tool-family experiment --experiment-config <path> --allowed-side-effect process` for allowlisted local experiments.

Goal loops are runtime-controlled. Honeycrisp adds a Codex-style continuation
contract to each loop, tracks `goal.updated` events, and keeps an incomplete goal
active until completion evidence, a strict repeated-blocker threshold, a
user-response point, or the configured `--goal-loops` budget stops the run. Use
`--goal-loops none` for no configured loop limit; an internal safety ceiling
still prevents accidental infinite runs.

## Auth

Honeycrisp stores provider credentials in `~/.honeycrisp/auth.json` by default, or the path set in `HONEYCRISP_AUTH_FILE`.

```sh
pnpm start auth list
pnpm start auth login openai-codex
pnpm start auth status openai-codex
pnpm start auth verify openai-codex
```
