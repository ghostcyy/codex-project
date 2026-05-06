import type { DesignSystemIR, IntentIR, NarrativeIR } from "../ir";
import type { SkillRegistry } from "../registry";

export type LayoutPlanPromptInput = {
  intent: IntentIR;
  narrative: NarrativeIR;
  design: DesignSystemIR;
  registry: SkillRegistry;
  renderableLayoutIds: string[];
  validationError?: string;
};

export function buildLayoutPlanPrompt(input: LayoutPlanPromptInput): { system: string; user: string } {
  const validationBlock = input.validationError
    ? [
        "The previous JSON failed validation.",
        "Validation error:",
        input.validationError,
        "Return a corrected full JSON array. Do not explain."
      ].join("\n")
    : "";

  const layouts = input.registry.layouts
    .filter((layout) => input.renderableLayoutIds.includes(layout.id))
    .map((layout) => ({
      id: layout.id,
      contract: {
        roleFit: layout.contract.roleFit,
        density: layout.contract.density,
        axis: layout.contract.axis,
        columns: layout.contract.columns,
        capacity: layout.contract.capacity,
        requiredSlots: layout.contract.requiredSlots,
        primitives: layout.contract.primitives,
        fallbackLayouts: layout.contract.fallbackLayouts
      },
      tags: layout.tags
    }));

  return {
    system: [
      "You are Stage 5 of HTML-PPT v2: Layout Plan Selection.",
      "You output LayoutPlanIR JSON array only.",
      "You must not output Markdown, prose, HTML, CSS, or comments.",
      "The backend will recompute capacityCheck; your capacityCheck text is advisory only.",
      "Hard rules:",
      "1. Output exactly one entry per NarrativeIR slide.",
      "2. slideIndex must match the narrative slide index exactly.",
      "3. layoutId must be one of the renderable layout IDs provided.",
      "4. cover slide uses cover layout; toc slide uses toc layout; cta/thanks uses cta layout.",
      "5. Prefer layout variety, but never choose a layout that does not fit the slide role.",
      "6. Use quote only for hook, context, synthesis, case-study, or transition-style narrative emphasis.",
      "7. Use section-divider only for transition-divider slides or strong narrative breaks.",
      "8. Use stat-highlight for data-highlight/evidence slides with one key number or a few key metrics.",
      "9. Use bullet-list for context/evidence/analysis slides with many bullets and low visual complexity.",
      "10. Use process for process/case-study slides with step-by-step flows.",
      "11. Use image-hero for hook/context/case-study slides with explicit visual hero or generated-image intent.",
      "Self-check before responding:",
      "1. The response is exactly one JSON array.",
      "2. Array length equals NarrativeIR.slides.length.",
      "3. No unknown layout IDs.",
      "4. All capacityCheck.passed values are true."
    ].join("\n"),
    user: [
      validationBlock,
      "Intent summary:",
      JSON.stringify({
        topic: input.intent.topic,
        audience: input.intent.audience,
        tone: input.intent.tone,
        format: input.intent.format,
        derivedSlideCount: input.intent.derivedSlideCount,
        derivedNarrativeChars: input.intent.derivedNarrativeChars
      }, null, 2),
      "",
      "DesignSystemIR summary:",
      JSON.stringify({
        themeId: input.design.themeId,
        donorTemplateId: input.design.donorTemplateId,
        deckClass: input.design.deckClass,
        accentPolicy: input.design.accentPolicy,
        donorDna: input.design.donorContract.dnaSignature
      }, null, 2),
      "",
      "Narrative slides:",
      JSON.stringify(input.narrative.slides.map((slide) => ({
        index: slide.index,
        role: slide.role,
        headline: slide.contentBrief.headline,
        supportingPointCount: slide.contentBrief.supportingPoints.length,
        keyMetricCount: slide.contentBrief.keyMetrics?.length ?? 0,
        densityBudget: slide.densityBudget,
        estimatedNarrativeChars: slide.estimatedNarrativeChars
      })), null, 2),
      "",
      "Renderable layout catalog:",
      JSON.stringify(layouts, null, 2),
      "",
      "Return JSON array matching this shape:",
      JSON.stringify([
        {
          slideIndex: 1,
          layoutId: "cover",
          capacityCheck: {
            passed: true,
            details: "Cover role maps directly to cover layout."
          },
          variancePosition: 0
        }
      ], null, 2)
    ].filter(Boolean).join("\n")
  };
}
