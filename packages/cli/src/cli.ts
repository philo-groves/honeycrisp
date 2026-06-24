#!/usr/bin/env node
import { bootstrapResearchRun } from "@honeycrisp/research-agent";

const VERSION = "0.1.0";

interface ParsedArgs {
  prompt: string | undefined;
  json: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let prompt: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-p" || arg === "--prompt") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a prompt value.`);
      }

      prompt = value;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (!prompt && positionals.length > 0) {
    prompt = positionals.join(" ");
  }

  return {
    prompt,
    json,
    help,
    version,
  };
}

function usage(): string {
  return [
    "Usage: honeycrisp -p <prompt> [--json]",
    "",
    "Options:",
    "  -p, --prompt <prompt>  Research prompt to turn into a root goal",
    "  --json                 Print the initialized run as JSON",
    "  -h, --help             Show help",
    "  -v, --version          Show version",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      console.log(usage());
      return;
    }

    if (args.version) {
      console.log(VERSION);
      return;
    }

    if (!args.prompt) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }

    const result = bootstrapResearchRun({
      prompt: args.prompt,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`honeycrisp: ${message}`);
    process.exitCode = 1;
  }
}

await main();
