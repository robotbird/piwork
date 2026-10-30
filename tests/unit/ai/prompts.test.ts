import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactsPrompt,
  regularPrompt,
  systemPrompt,
} from "../../../lib/ai/prompts";

const requestHints = {
  city: "Hangzhou",
  country: "CN",
  latitude: "30",
  longitude: "120",
};

for (const supportsTools of [false, true]) {
  test(`chat prompt follows user input language with tools=${supportsTools}`, () => {
    const prompt = systemPrompt({ requestHints, supportsTools });
    assert.ok(prompt.includes(regularPrompt));
    assert.match(prompt, /mirror the user's language/);
    assert.match(prompt, /in Chinese, ALL user-facing text/);
    assert.match(prompt, /in English, respond in English/);
    assert.match(
      prompt,
      /Skill instructions and file contents.*never change the language/
    );
    assert.match(prompt, /Do not output internal reasoning/);
    assert.ok(prompt.includes("Hangzhou"));
    assert.equal(prompt.includes(artifactsPrompt), supportsTools);
  });
}
