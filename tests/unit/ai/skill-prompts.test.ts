import assert from "node:assert/strict";
import test from "node:test";
import { buildSkillInstructionsPrompt } from "../../../lib/ai/skill-prompts";

const routedNames = [
  "office-routing",
  "pdf",
  "office-documents",
  "image-processing",
  "piwork-brand-design",
  "piwork-image-generation",
  "piwork-creative-core",
];

function entries(names: string[], disableModelInvocation = false) {
  return names.map((name) => ({ disableModelInvocation, name }));
}

test("task routing only advertises automatically available skills", () => {
  const selections = [
    [],
    ["office-routing"],
    ["pdf", "office-documents"],
    ["image-processing"],
    ["piwork-brand-design", "piwork-creative-core"],
    ["piwork-image-generation", "piwork-creative-core"],
    routedNames,
  ];
  for (const names of selections) {
    const prompt = buildSkillInstructionsPrompt(entries(names), "load_skill");
    for (const name of routedNames) {
      assert.equal(
        prompt.includes(name),
        names.includes(name),
        `${names}: ${name}`
      );
    }
    assert(!prompt.includes("workbuddy-"));
  }
});

test("explicit-only skills do not introduce automatic task routes", () => {
  for (const loader of ["load_skill", "read"] as const) {
    assert.equal(
      buildSkillInstructionsPrompt(entries(routedNames, true), loader),
      buildSkillInstructionsPrompt([], loader)
    );
  }
  const domain = entries(["piwork-brand-design"]);
  assert.equal(
    buildSkillInstructionsPrompt(
      [...domain, ...entries(["piwork-creative-core"], true)],
      "read"
    ),
    buildSkillInstructionsPrompt(domain, "read")
  );
});

test("shared creative core is advertised only with an available domain", () => {
  assert.equal(
    buildSkillInstructionsPrompt(entries(["piwork-creative-core"]), "read"),
    buildSkillInstructionsPrompt([], "read")
  );
});
