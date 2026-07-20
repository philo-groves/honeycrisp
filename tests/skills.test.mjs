import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResearchSkillsFromMcpMetadata,
  loadResearchSkillsFromDirectory,
  selectResearchSkills,
} from "../packages/research-agent/dist/index.js";

test("local skills load and select directly from the research request", async () => {
  const skillRoot = await createSkillFixture();
  const [skill] = loadResearchSkillsFromDirectory(skillRoot);
  const selected = selectResearchSkills({
    prompt: "Triage a parser vulnerability with authorized local evidence",
    skills: [skill],
  });

  assert.equal(skill.id, "vuln-research");
  assert.deepEqual(skill.domainTags, ["vulnerability", "parser"]);
  assert.equal(selected[0]?.id, "vuln-research");
  assert.match(selected[0]?.instructions ?? "", /Use local evidence first/);
  assert.match(selected[0]?.runbook ?? "", /Map trust boundaries/);
});

test("MCP skill metadata converts to selectable skill descriptors", () => {
  const [skill] = createResearchSkillsFromMcpMetadata([
    {
      id: "mcp-investigation",
      version: "2",
      description: "Investigation workflow",
      domainTags: ["investigation"],
      instructions: "Preserve source provenance.",
      recommendedActionClasses: ["search", "synthesize"],
      uri: "mcp://skills/investigation",
    },
  ]);
  const selected = selectResearchSkills({
    prompt: "Investigate evidence provenance",
    skills: [skill],
    requestedSkillIds: ["mcp-investigation"],
  });

  assert.equal(skill.source.kind, "mcp");
  assert.equal(skill.source.uri, "mcp://skills/investigation");
  assert.equal(selected[0]?.id, "mcp-investigation");
  assert.equal(selected[0]?.source?.kind, "mcp");
  assert.ok(
    selected[0]?.selectionReasons.includes("explicitly requested"),
  );
});

async function createSkillFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeycrisp-skills-"));
  const skillDir = join(root, "vuln-research");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "# Vulnerability Research",
      "Id: vuln-research",
      "Version: 0.1",
      "Description: Vulnerability research workflow",
      "Domain tags: vulnerability, parser",
      "Recommended tools: local.inspection",
      "Recommended action classes: inspect, analyze",
      "Runbook: Map trust boundaries before claims.",
      "---",
      "Use local evidence first and preserve uncertainty.",
    ].join("\n"),
    "utf8",
  );

  return root;
}
