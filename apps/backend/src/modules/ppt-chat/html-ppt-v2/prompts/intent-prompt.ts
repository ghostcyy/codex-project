import {
  AUDIENCE_IDS,
  FORMAT_IDS,
  LANGUAGE_IDS,
  TONE_IDS,
  type IntentIR
} from "../ir";

export type IntentPromptInput = {
  userPrompt: string;
  conversationContext?: string[];
  userPreferences?: Record<string, unknown>;
  deterministicHints: Partial<IntentIR>;
  validationError?: string;
};

export function buildIntentPrompt(input: IntentPromptInput): { system: string; user: string } {
  const validationBlock = input.validationError
    ? [
        "The previous JSON failed validation.",
        "Validation error:",
        input.validationError,
        "Return a corrected full JSON object. Do not explain."
      ].join("\n")
    : "";

  return {
    system: [
      "You are Stage 1 of HTML-PPT v2: Intent Distillation.",
      "You convert free-form presentation requests into typed IntentIR JSON only.",
      "You must not output Markdown, prose, HTML, CSS, or comments.",
      "Closed enum values only:",
      `language: ${LANGUAGE_IDS.join(", ")}`,
      `audience: ${AUDIENCE_IDS.join(", ")}`,
      `tone: ${TONE_IDS.join(", ")}`,
      `format: ${FORMAT_IDS.join(", ")}`,
      "Self-check before responding:",
      "1. The response is exactly one JSON object.",
      "2. hardConstraints.slideCount, if present, equals derivedSlideCount.",
      "3. hardConstraints.narrativeChars, if present, is <= derivedNarrativeChars.",
      "4. All enum fields use only the closed values above.",
      "5. No raw HTML or CSS appears anywhere."
    ].join("\n"),
    user: [
      validationBlock,
      "User prompt:",
      input.userPrompt,
      "",
      "Recent conversation context:",
      JSON.stringify(input.conversationContext ?? [], null, 2),
      "",
      "User preferences:",
      JSON.stringify(input.userPreferences ?? {}, null, 2),
      "",
      "Deterministic hints extracted locally. Preserve exact hard constraints when present:",
      JSON.stringify(input.deterministicHints, null, 2),
      "",
      "Return JSON matching this shape:",
      JSON.stringify({
        topic: "string",
        language: "zh-CN",
        audience: "general-public",
        tone: "analytical",
        format: "lecture",
        hardConstraints: {
          slideCount: 12,
          narrativeChars: 1500,
          requiredSections: ["string"]
        },
        preferences: {
          aestheticHints: ["string"],
          forbiddenThemes: ["string"],
          domainTerminology: ["string"],
          knowledgeCutoffWarning: false
        },
        derivedSlideCount: 12,
        derivedNarrativeChars: 1500
      }, null, 2)
    ].filter(Boolean).join("\n")
  };
}
