#!/usr/bin/env node
import { usage } from "./cli-usage.js";

const VERSION = "0.1.0";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    if (argv[0] === "-h" || argv[0] === "--help") {
      console.log(usage());
      return;
    }    if (argv[0] === "-v" || argv[0] === "--version") {
      console.log(VERSION);
      return;
    }
    if (argv[0] === "profile") {
      const { runProfileCommand } = await import("./profile-command.js");
      await runProfileCommand(argv.slice(1));
      return;
    }
    if (argv[0] === "auth") {
      const { runAuthCommand } = await import("./auth-command.js");
      await runAuthCommand(argv.slice(1));
      return;
    }
    if (argv[0] === "models") {
      const { runModelsCommand } = await import("./auth-command.js");
      await runModelsCommand(argv.slice(1));
      return;
    }
    if (argv[0] === "complete") {
      const { runCompleteCommand } = await import("./complete-command.js");
      await runCompleteCommand(argv.slice(1));
      return;
    }
    if (argv[0] === "protocol") {
      const { runProtocolCommand } = await import("./protocol-command.js");
      await runProtocolCommand(argv.slice(1));
      return;
    }
    if (argv[0] === "session") {
      const { runSessionCommand } = await import("./session-command.js");
      await runSessionCommand(argv.slice(1));
      return;
    }
    const { main: runRuntimeCli } = await import("./runtime-cli.js");
    await runRuntimeCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
