import {
  BUNDLED_RESEARCH_PROFILE_IDS,
  RESEARCH_PROFILE_SCHEMA_VERSION,
  resolveResearchProfile,
  type BundledResearchProfileId,
} from "@honeycrisp/research-agent/research-profile";

const PROFILE_CATALOG_PROTOCOL_VERSION = 1 as const;

export async function runProfileCommand(argv: readonly string[]): Promise<void> {
  const firstArg = argv[0];
  const command = firstArg && !firstArg.startsWith("-") ? firstArg : undefined;
  let workspaceRoot = process.cwd();
  let profilePath: string | undefined;
  let profileId: BundledResearchProfileId | undefined;
  let json = false;
  let help = false;
  const positionals: string[] = [];

  for (let index = command ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace-root") {
      workspaceRoot = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profile") {
      profilePath = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profile-id") {
      const value = readOptionValue(argv, index, arg);
      if (!BUNDLED_RESEARCH_PROFILE_IDS.includes(value as BundledResearchProfileId)) {
        throw new Error(`--profile-id must be one of: ${BUNDLED_RESEARCH_PROFILE_IDS.join(", ")}.`);
      }
      profileId = value as BundledResearchProfileId;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg?.startsWith("-")) {
      throw new Error(`Unknown profile option: ${arg}`);
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (!command || help) {
    console.log(profileUsage());
    return;
  }
  if (positionals.length > 0) {
    throw new Error(`Unexpected profile argument(s): ${positionals.join(" ")}`);
  }
  if (profilePath && profileId) {
    throw new Error("--profile and --profile-id cannot be used together.");
  }
  if (command !== "resolve") {
    throw new Error(`Unknown profile command: ${command}`);
  }

  const resolvedProfile = await resolveResearchProfile({
    workspaceRoot,
    ...(profilePath ? { profilePath } : {}),
    ...(profileId ? { bundledProfileId: profileId } : {}),
  });
  const envelope = {
    catalogProtocolVersion: PROFILE_CATALOG_PROTOCOL_VERSION,
    supportedResearchProfileSchemaVersions: [RESEARCH_PROFILE_SCHEMA_VERSION],
    profile: resolvedProfile.profile,
    hash: resolvedProfile.hash,
    source: resolvedProfile.source,
    ...(resolvedProfile.path ? { path: resolvedProfile.path } : {}),
  };
  if (json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.log(`${envelope.profile.id}@${envelope.profile.version}\t${envelope.hash}\t${envelope.source}`);
}

function profileUsage(): string {
  return [
    "Usage: honeycrisp profile resolve --workspace-root <path> [--profile <path> | --profile-id <security-research|mathematics>] --json",
    "",
    "Resolves an explicit profile or selected bundled profile, then .honeycrisp/profile.json, then the bundled security profile.",
  ].join("\n");
}

function readOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}