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

On a real run, Honeycrisp opens the workspace database at `.honeycrisp/memory/memory.sqlite`, exposes configured research tools plus a small durable knowledge graph, and processes the loop with a Pi-backed executor. Run state, transcripts, and tool traces are operational data; they are not automatically promoted into durable knowledge. The model explicitly searches and updates concise reusable nodes when the research warrants it.

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

Durable knowledge uses typed nodes (`asset`, `bug`, `invariant`, `mitigation`, `source`, `sink`, `hypothesis`, `finding`, `primitive`, `chain`, `procedure`, and `trajectory`), directed relationships, tags, asset links, and lightweight evidence references. Saves are additive; exact corrections require the current node revision. Transcripts, task narration, goals, and bulk tool output do not belong in the graph.

Large raw outputs and generated artifacts remain files under `.honeycrisp/memory/artifacts/`; graph evidence stores relative pointers and locators rather than copying file contents into SQLite. Host interfaces such as Beale use the same SQLite file for compatible headless and desktop operation. Honeycrisp owns this database contract; interface-specific visualization and disclosure/export flows can add operational tables without creating a second workspace database.

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

Review the capture for `runtimeConfig.modelConfig.source`, `runtimeConfig.toolConfig`, `memoryIntegration`, `contextV2`, selected tools, storage directories, storage manifest entries, and tool events. Runtime tool preferences may be persisted with `honeycrisp tools config ...`, which writes `.honeycrisp/tools.json` under the workspace by default. Add `--mcp-config` plus `--allow-mcp-server` for one-off live MCP server runs, or persist them with `tools config set mcp-config <path>` and `tools config add allow-mcp-server <name>`.

Goal loops are runtime-controlled. Honeycrisp adds a Codex-style continuation
contract to each loop, tracks `goal.updated` events, and keeps an incomplete goal
active until completion evidence, a strict repeated-blocker threshold, a
user-response point, or the configured `--goal-loops` budget stops the run. Use
`--goal-loops none` for no configured loop limit; an internal safety ceiling
still prevents accidental infinite runs.

### Host control stream

Hosts can add `--control-stream` to send schema-versioned JSONL commands over
stdin while a run is active:

```jsonl
{"schemaVersion":1,"type":"pause"}
{"schemaVersion":1,"type":"resume"}
{"schemaVersion":1,"type":"steer","instruction":"Inspect the authorization boundary next."}
```

Pause holds the agent at its next safe turn boundary until resume arrives.
Steering is injected as a user message into the active Pi agent loop before its
next model turn. With `--event-stream`, accepted or rejected control messages
are reported as `agent.event` records with `eventType: "control.received"`.

## Auth

Honeycrisp stores provider credentials in `~/.honeycrisp/auth.json` by default, or the path set in `HONEYCRISP_AUTH_FILE`.

When launched by a host workbench, `HONEYCRISP_CODEX_AUTH_FILE` may point to an existing Codex `auth.json`. Honeycrisp uses the fresher `openai-codex` OAuth credential without modifying the Codex file; any refreshed credential is written to Honeycrisp's own auth file.

```sh
pnpm start auth list
pnpm start auth login openai-codex
pnpm start auth status openai-codex
pnpm start auth verify openai-codex
```
