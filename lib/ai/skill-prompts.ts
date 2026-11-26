import type { Skill } from "@earendil-works/pi-coding-agent";

type SkillPromptEntry = Pick<Skill, "name" | "disableModelInvocation">;

export function buildSkillInstructionsPrompt(
  skills: readonly SkillPromptEntry[],
  loader: "load_skill" | "read"
) {
  const names = new Set(
    skills
      .filter((skill) => !skill.disableModelInvocation)
      .map(({ name }) => name)
  );
  const office: string[] = [];
  if (names.has("office-routing")) {
    office.push(
      "For local PDF, Word, spreadsheet (including CSV/TSV), presentation, or mind-map content work, load office-routing first, then load the available specialist it selects before reading, editing, converting, or creating the file. This includes creating a formal document from supplied materials."
    );
  }
  if (names.has("pdf")) {
    office.push(
      "Use pdf for PDF reading, summarization, search, and questions about its contents; follow its documented extraction and page-checking workflow."
    );
  }
  if (names.has("office-documents")) {
    office.push(
      "Use office-documents for Word, Excel/CSV/TSV, PowerPoint, and XMind reading, creation, editing, and supported conversions. Use its bundled scripts and documented commands rather than improvising a parallel Office pipeline."
    );
  }
  if (office.length) {
    office.push(
      "Route by the requested deliverable and the loaded skill's instructions. Hand source materials to the selected workflow rather than pre-processing them through a different route. Preserve original files and report format or layout limitations honestly. A question about a file format or a request to preview a file is not a content-editing task. Ordinary answers stay in chat; respect an explicit request for Markdown, plain text, or another output format."
    );
  }

  const images: string[] = [];
  if (names.has("image-processing")) {
    images.push(
      "Use image-processing for local image operations such as background removal, resizing, and enhancement. Check its supported operations before choosing generative editing."
    );
  }
  if (names.has("piwork-brand-design")) {
    images.push(
      "For brand assets (logos, mascots, visual identity systems, and IP merchandise), load piwork-brand-design before generating images."
    );
  }
  if (names.has("piwork-image-generation")) {
    images.push(
      "For general image generation or generative editing (posters, illustrations, App icons, and ecommerce detail images), load piwork-image-generation before generating images. Brand-asset requests follow the brand workflow when available."
    );
  }
  if (
    names.has("piwork-creative-core") &&
    (names.has("piwork-brand-design") || names.has("piwork-image-generation"))
  ) {
    images.push(
      "The image-generation and brand workflows share piwork-creative-core; load it as a dependency before generating, and follow its scope and cost-confirmation rules without repeatedly asking for already authorized work."
    );
  }
  if (images.length) {
    images.push(
      "Generate images only through image_gen when that tool is available. Pass actual workspace reference-image paths for edits and confirmed visual anchors; a textual description does not replace the reference. Image results are delivered automatically as attachment cards; do not deliver or embed them again unless the user requests it."
    );
  }

  return [
    "## Skill use",
    "Skills are reusable, on-demand instruction packages. Check the available catalog before doing task work. When a skill matches, load it before processing files, implementing the task, or giving a substantive answer; follow its relevant references and dependencies. Avoid loading unrelated skills just because a keyword appears in the conversation.",
    loader === "load_skill"
      ? "Call load_skill with the exact available skill name. Resolve bundled references, scripts, and assets relative to the directory returned by that tool."
      : "Use read to load the sandbox-local SKILL.md advertised in the catalog. Resolve references, scripts, and assets relative to that sandbox skill directory. If a loaded skill mentions a host-only skill-loading tool, load the named dependency with read instead.",
    "Use only skills in the current catalog or explicitly supplied for this task. Honor an explicitly selected skill and load its required dependencies. Skill names do not imply that their dependencies, tools, or models are installed. If a required capability is unavailable, state the limitation and offer a supported alternative; do not invent calls or bypass the workflow's constraints.",
    loader === "load_skill"
      ? "When the user asks to create or save a reusable skill, call create_skill with complete, actionable Markdown instructions."
      : "Host skill-loading and skill-creation tools are unavailable in this runtime.",
    ...(office.length ? ["## Office task routing", ...office] : []),
    ...(images.length ? ["## Image task routing", ...images] : []),
  ].join("\n\n");
}
