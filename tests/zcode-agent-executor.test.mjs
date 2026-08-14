import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getZCodeSubscriptionAuthStatus } from "../packages/research-agent/dist/auth.js";
import { extractCompatibleZCodeAgentResumableState } from "../packages/research-agent/dist/zcode-agent-executor.js";

test("ZCode subscription auth recognizes desktop credentials without CLI configuration", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "honeycrisp-zcode-auth-"));
  try {
    const credentialsDirectory = join(userHome, ".zcode", "v2");
    await mkdir(credentialsDirectory, { recursive: true });
    await writeFile(
      join(credentialsDirectory, "credentials.json"),
      JSON.stringify({ "oauth:zai:access_token": "test-token" }),
    );

    assert.equal(await getZCodeSubscriptionAuthStatus(userHome), true);
  } finally {
    await rm(userHome, { recursive: true, force: true });
  }
});

test("ZCode resumable state is accepted only for the same model, profile, and workflow", () => {
  const state = {
    schemaVersion: 1,
    provider: "zai",
    model: "glm-5.3",
    providerSessionId: "session-1",
    researchProfileHash: "profile-1",
    workflowId: "discovery",
  };
  const capture = { resumableState: state };
  assert.deepEqual(extractCompatibleZCodeAgentResumableState(
    capture,
    "glm-5.3",
    { researchProfileHash: "profile-1", workflowId: "discovery" },
  ), state);
  assert.equal(extractCompatibleZCodeAgentResumableState(
    capture,
    "glm-5.3",
    { researchProfileHash: "other", workflowId: "discovery" },
  ), undefined);
});
