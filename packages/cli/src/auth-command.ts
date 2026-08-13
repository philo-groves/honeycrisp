import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  getAuthStatus,
  getProviderModelCatalog,
  listAuthProviders,
  loginAuthProvider,
  logoutAuthProvider,
  verifyProviderAuth,
  type AuthLoginCallbacks,
} from "@honeycrisp/research-agent/auth";

export async function runAuthCommand(argv: readonly string[]): Promise<void> {
  const command = argv[0] ?? "status";
  if (command === "list") {
    for (const provider of listAuthProviders()) {
      console.log(`${provider.id}\t${provider.name}\t${provider.authMethods.join(", ")}`);
    }
    return;
  }
  if (command === "status") {
    const status = await getAuthStatus(argv[1]);
    console.log(`Auth file: ${status.authFile}`);
    if (status.providers.length === 0) {
      console.log(argv[1] ? `No provider found: ${argv[1]}` : "No providers found.");
      return;
    }
    for (const provider of status.providers) {
      const stored = provider.storedCredentialType ?? "not stored";
      console.log(`${provider.id}\t${provider.name}\t${provider.authMethods.join(", ")}\t${stored}`);
    }
    return;
  }
  if (command === "login") {
    const providerId = argv[1];
    if (!providerId) throw new Error("Usage: honeycrisp auth login <provider>");
    const callbacks = createTerminalAuthCallbacks();
    try {
      const result = await loginAuthProvider(providerId, callbacks);
      console.log(`Logged in to ${result.providerName} (${result.providerId}) using ${result.credentialType}.`);
      console.log(`Credentials saved to ${result.authFile}`);
    } finally {
      callbacks.close();
    }
    return;
  }
  if (command === "logout") {
    const providerId = argv[1];
    if (!providerId) throw new Error("Usage: honeycrisp auth logout <provider>");
    await logoutAuthProvider(providerId);
    console.log(`Removed stored credentials for ${providerId}.`);
    return;
  }
  if (command === "verify") {
    const providerId = argv[1];
    if (!providerId) throw new Error("Usage: honeycrisp auth verify <provider> [model]");
    const result = await verifyProviderAuth(providerId, argv[2]);
    const source = result.source ? ` via ${result.source}` : "";
    console.log(`${result.providerName} (${result.providerId}) model ${result.modelId}: ${result.configured ? `configured${source}` : "not configured"}`);
    return;
  }
  if (command === "-h" || command === "--help") {
    console.log("Usage: honeycrisp auth <list|status|login|logout|verify> [provider] [model]");
    return;
  }
  throw new Error("Usage: honeycrisp auth <list|status|login|logout|verify> [provider] [model]");
}

export function runModelsCommand(argv: readonly string[]): void {
  const command = argv[0] ?? "list";
  if (command !== "list") throw new Error("Usage: honeycrisp models list [provider] [--json]");
  const providerId = argv.find((value, index) => index > 0 && !value.startsWith("--"));
  const catalogs = getProviderModelCatalog(providerId);
  if (providerId && catalogs.length === 0) throw new Error(`Unknown provider: ${providerId}`);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ providers: catalogs }, null, 2));
    return;
  }
  for (const provider of catalogs) {
    for (const model of provider.models) {
      console.log(`${provider.providerId}\t${model.id}\t${model.name}\t${model.effortLevels.join(", ")}`);
    }
  }
}

function createTerminalAuthCallbacks(): AuthLoginCallbacks & { close(): void } {
  const rl = createInterface({ input, output });
  return {
    async prompt(prompt) {
      if (prompt.signal?.aborted) throw new Error("Prompt cancelled");
      if (prompt.type === "select") {
        console.log(`\n${prompt.message}`);
        prompt.options.forEach((option, index) => {
          const description = option.description ? ` - ${option.description}` : "";
          console.log(`  ${index + 1}. ${option.label}${description}`);
        });
        const answer = await rl.question(`Enter number (1-${prompt.options.length}): `);
        const selected = prompt.options[Number.parseInt(answer, 10) - 1];
        if (!selected) throw new Error("Invalid selection");
        return selected.id;
      }
      const label = prompt.placeholder ? `${prompt.message} (${prompt.placeholder}): ` : `${prompt.message}: `;
      if (prompt.type === "secret" && input.isTTY) return readSecret(label);
      return prompt.signal ? rl.question(label, { signal: prompt.signal }) : rl.question(label);
    },
    notify(event) {
      if (event.type === "auth_url") {
        console.log(`\nOpen this URL in your browser:\n${event.url}`);
        if (event.instructions) console.log(event.instructions);
        console.log();
      } else if (event.type === "device_code") {
        console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
        console.log(`Enter code: ${event.userCode}\n`);
      } else {
        console.log(event.message);
      }
    },
    close() {
      rl.close();
    },
  };
}

function readSecret(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value);
    };
    const onData = (data: Buffer) => {
      const chunk = data.toString("utf8");
      if (chunk === "\u0003") {
        cleanup();
        reject(new Error("Input cancelled"));
      } else if (chunk === "\r" || chunk === "\n") {
        finish();
      } else if (chunk === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += chunk;
      }
    };
    output.write(message);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}