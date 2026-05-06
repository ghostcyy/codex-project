import {
  ANIMATION_IDS,
  FX_IDS,
  type EvidencePack,
  type IntentIR,
  type NarrativeIR
} from "../ir";
import type { SkillRegistry } from "../registry";

export type DesignPromptInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  narrative: NarrativeIR;
  registry: SkillRegistry;
  validationError?: string;
};

export function buildDesignPrompt(input: DesignPromptInput): { system: string; user: string } {
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
      "You are Stage 4 of HTML-PPT v2: Design System Lock.",
      "You choose from closed registry IDs and output compact DesignChoice JSON only.",
      "You must not output Markdown, prose, HTML, CSS, theme tokens, donor contracts, or comments.",
      "The backend will deterministically lock themeTokens, donorContract, deckClass, and WCAG from the registry.",
      "Self-check before responding:",
      "1. The response is exactly one JSON object.",
      "2. themeId is one of the registry theme IDs.",
      "3. donorTemplateId is one of the registry donor IDs.",
      "4. allowedAnims uses only the closed animation IDs.",
      "5. allowedFx uses only the closed FX IDs.",
      "6. The choice fits audience, tone, format, and narrative."
    ].join("\n"),
    user: [
      validationBlock,
      "IntentIR:",
      JSON.stringify(input.intent, null, 2),
      "",
      "NarrativeIR summary:",
      JSON.stringify({
        arc: input.narrative.arc,
        slideCount: input.narrative.slides.length,
        roles: input.narrative.slides.map((slide) => slide.role),
        headlines: input.narrative.slides.map((slide) => slide.contentBrief.headline),
        totalEstimatedChars: input.narrative.totalEstimatedChars
      }, null, 2),
      "",
      "Evidence density summary:",
      JSON.stringify({
        facts: input.evidence.facts.length,
        dataPoints: input.evidence.dataPoints.length,
        candidateVisuals: input.evidence.candidateVisuals.length,
        knownGaps: input.evidence.knownGaps
      }, null, 2),
      "",
      "Theme registry choices:",
      JSON.stringify(input.registry.themes.map((theme) => ({
        id: theme.id,
        sourceId: theme.sourceId,
        tags: theme.tags,
        palette: theme.tokens,
        minContrastRatio: theme.wcag.minContrastRatio
      })), null, 2),
      "",
      "Donor template choices:",
      JSON.stringify(input.registry.donors.map((donor) => ({
        id: donor.id,
        deckClass: donor.deckClass,
        tags: donor.tags,
        forbiddenClasses: donor.contract.forbiddenClasses,
        coverOnlyClasses: donor.contract.coverOnlyClasses
      })), null, 2),
      "",
      "Closed animation IDs:",
      JSON.stringify(ANIMATION_IDS),
      "Closed FX IDs:",
      JSON.stringify(FX_IDS),
      "",
      "Return JSON matching this shape:",
      JSON.stringify({
        themeId: "engineering-whiteprint",
        donorTemplateId: "tech-sharing",
        accentPolicy: "static",
        animationBudget: {
          allowedAnims: ["fade-up", "stagger-list", "none"],
          allowedFx: ["soft-glow", "none"],
          maxAccentSlides: 2,
          fxAllowedRoles: ["cover", "cta"]
        },
        audienceFitReasons: [
          "The theme matches the audience and tone.",
          "The donor style supports this narrative structure."
        ]
      }, null, 2)
    ].filter(Boolean).join("\n")
  };
}
