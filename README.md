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
