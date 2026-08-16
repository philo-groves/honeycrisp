import {
  honeycrispProtocolDescriptor,
  honeycrispProtocolFailure,
  honeycrispProtocolSuccess,
} from "./protocol.js";

export async function runProtocolCommand(argv: readonly string[], requestId?: string): Promise<void> {
  const command = argv[0];
  const json = argv.includes("--json");
  if (!command || command === "--help" || command === "-h") {
    console.log(protocolUsage());
    return;
  }
  if (command !== "describe") {
    const envelope = honeycrispProtocolFailure(
      "protocol.describe",
      "unknown_operation",
      `Unknown protocol command: ${command}`,
      false,
      requestId,
    );
    console.log(JSON.stringify(envelope));
    process.exitCode = 1;
    return;
  }
  const envelope = honeycrispProtocolSuccess("protocol.describe", honeycrispProtocolDescriptor(), requestId);
  console.log(json ? JSON.stringify(envelope) : JSON.stringify(envelope, null, 2));
}

function protocolUsage(): string {
  return [
    "Usage: honeycrisp protocol describe [--json]",
    "",
    "Print the supported versioned client protocol and transport capabilities.",
  ].join("\n");
}
