import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileLoopModelInput,
  createFirstRunMemoryController,
  createLocalInspectionTool,
  createResearchGoalFrame,
  createResearchSkillsFromMcpMetadata,
  loadResearchSkillsFromDirectory,
  planResearchLoop,
} from "../packages/research-agent/dist/index.js";

test("local skills load, select by domain, and inject instructions into loop context", async () => {
  const skillRoot = await createSkillFixture();
  const [skill] = loadResearchSkillsFromDirectory(skillRoot);
  const goalFrame = createResearchGoalFrame(
    [
      "Goal: Triage a parser vulnerability with local evidence",
      "Scope constraints: authorized local fixture only",
    ].join("\n"),
  );

  const decision = createFirstRunMemoryController().decide({
    goalFrame,
    skills: [skill],
  });
  const loopPlan = planResearchLoop({ decision });
  const modelInput = compileLoopModelInput(loopPlan);
  const skillSection = modelInput.contextSections.find(
    (section) => section.label === "selected_skills",
  );

  assert.equal(skill.id, "vuln-research");
  assert.deepEqual(skill.domainTags, ["vulnerability", "parser"]);
  assert.equal(decision.selectedSkills[0]?.id, "vuln-research");
  assert.match(decision.selectedSkills[0]?.instructions ?? "", /Use local evidence first/);
  assert.ok(
    decision.contextPacket.candidateProcedures.some((procedure) =>
      procedure.id.includes("skill:vuln-research:runbook"),
    ),
  );
  assert.ok(loopPlan.loopPrompt.includes("Selected skills:"));
  assert.ok(loopPlan.loopPrompt.includes("vuln-research@0.1"));
  assert.equal(skillSection?.content[0]?.id, "vuln-research");
});

test("skill recommendations cannot override governance or user commitments", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "honeycrisp-skill-tool-"));
  const fixtureFile = join(fixtureRoot, "parse.c");
  await writeFile(fixtureFile, "parser evidence\n", "utf8");
  const inspectionTool = createLocalInspectionTool({
    allowedRoots: [fixtureRoot],
    maxBytes: 128,
  });
  const skill = {
    id: "aggressive-local-skill",
    description: "Aggressively recommends local inspection",
    domainTags: ["parser"],
    instructions: "Recommend local inspection when parser appears.",
    recommendedToolNames: ["local.inspection"],
    recommendedActionClasses: ["inspect"],
    governanceHints: {
      allowedSideEffects: ["read"],
    },
  };
  const goalFrame = createResearchGoalFrame(
    [
      `Goal: Inspect parser evidence in ${fixtureFile}`,
      "Scope constraints: preserve user commitment: no read tools",
    ].join("\n"),
  );

  const decision = createFirstRunMemoryController().decide({
    goalFrame,
    tools: [inspectionTool.descriptor],
    skills: [skill],
    governance: {
      allowedSideEffects: ["none"],
    },
  });

  assert.equal(decision.selectedSkills[0]?.id, "aggressive-local-skill");
  assert.equal(decision.actionClass, "synthesize");
  assert.equal(decision.contextPacket.toolPermissions.length, 0);
  assert.equal(decision.candidateToolActions.length, 0);
  assert.equal(decision.skippedToolActions[0]?.code, "side_effect_not_permitted");
  assert.ok(
    decision.contextPacket.userCommitments.some((commitment) =>
      commitment.includes("no read tools"),
    ),
  );
  assert.equal(
    decision.contextPacket.selectedSkills[0]?.governanceHints?.allowedSideEffects?.[0],
    "read",
  );
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
  const goalFrame = createResearchGoalFrame(
    "Goal: Investigation of evidence provenance",
  );

  const decision = createFirstRunMemoryController().decide({
    goalFrame,
    skills: [skill],
    selectedSkillIds: ["mcp-investigation"],
  });

  assert.equal(skill.source.kind, "mcp");
  assert.equal(skill.source.uri, "mcp://skills/investigation");
  assert.equal(decision.selectedSkills[0]?.id, "mcp-investigation");
  assert.equal(decision.selectedSkills[0]?.source?.kind, "mcp");
  assert.ok(
    decision.selectedSkills[0]?.selectionReasons.includes("explicitly requested"),
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
