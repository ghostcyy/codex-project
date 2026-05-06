import { z } from "zod";
import { assetIrSchema } from "./asset-ir.schema";
import { choreographyIrSchema } from "./choreography-ir.schema";
import { designSystemIrSchema } from "./design-system-ir.schema";
import { evidencePackSchema } from "./evidence-pack.schema";
import { intentIrSchema } from "./intent-ir.schema";
import { layoutPlanIrSchema } from "./layout-plan-ir.schema";
import { narrativeIrSchema } from "./narrative-ir.schema";
import { slotFillIrSchema } from "./slot-fill-ir.schema";
import { isoDateTimeSchema, qualityScoresSchema, stageCheckpointSchema } from "./shared";

export const deckIrSchema = z.object({
  intent: intentIrSchema,
  evidence: evidencePackSchema,
  narrative: narrativeIrSchema,
  design: designSystemIrSchema,
  layoutPlan: layoutPlanIrSchema,
  slots: slotFillIrSchema,
  assets: assetIrSchema,
  choreography: choreographyIrSchema,
  meta: z.object({
    irVersion: z.literal("v1"),
    revisionRound: z.number().int().min(0).max(20),
    qualityScores: qualityScoresSchema,
    generatedAt: isoDateTimeSchema,
    checkpoints: z.array(stageCheckpointSchema).max(40)
  }).strict()
}).strict().superRefine((deck, ctx) => {
  const expectedCount = deck.intent.derivedSlideCount;
  const slideIndexes = deck.narrative.slides.map((slide) => slide.index);
  const slideIndexSet = new Set(slideIndexes);

  if (deck.narrative.slides.length !== expectedCount) {
    ctx.addIssue({
      code: "custom",
      path: ["narrative", "slides"],
      message: "Narrative slide count must match intent.derivedSlideCount."
    });
  }

  if (deck.narrative.totalEstimatedChars < deck.intent.derivedNarrativeChars) {
    ctx.addIssue({
      code: "custom",
      path: ["narrative", "totalEstimatedChars"],
      message: "Narrative totalEstimatedChars must satisfy intent.derivedNarrativeChars."
    });
  }

  const checkSlideIndexes = (label: string, values: number[], path: Array<string | number>) => {
    if (values.length !== expectedCount) {
      ctx.addIssue({ code: "custom", path, message: `${label} must contain exactly one entry per slide.` });
    }
    for (const index of values) {
      if (!slideIndexSet.has(index)) {
        ctx.addIssue({ code: "custom", path, message: `${label} references unknown slide index ${index}.` });
      }
    }
  };

  checkSlideIndexes("layoutPlan", deck.layoutPlan.map((item) => item.slideIndex), ["layoutPlan"]);
  checkSlideIndexes("slots", deck.slots.map((item) => item.slideIndex), ["slots"]);
  checkSlideIndexes("choreography", deck.choreography.map((item) => item.slideIndex), ["choreography"]);

  const layoutBySlide = new Map(deck.layoutPlan.map((item) => [item.slideIndex, item.layoutId]));
  for (const slot of deck.slots) {
    const expectedLayout = layoutBySlide.get(slot.slideIndex);
    if (expectedLayout !== slot.kind) {
      ctx.addIssue({
        code: "custom",
        path: ["slots"],
        message: `Slide ${slot.slideIndex} slot kind '${slot.kind}' must match layout '${expectedLayout}'.`
      });
    }
  }

  const availableCitationKeys = new Set([
    ...deck.evidence.facts.map((fact) => fact.citationKey),
    ...deck.evidence.dataPoints.map((point) => point.citationKey)
  ]);
  for (const slide of deck.narrative.slides) {
    for (const citationKey of slide.contentBrief.evidenceRefs) {
      if (!availableCitationKeys.has(citationKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["narrative", "slides", slide.index - 1, "contentBrief", "evidenceRefs"],
          message: `Unresolved citationKey: ${citationKey}`
        });
      }
    }
  }

  for (const [key, asset] of Object.entries(deck.assets)) {
    if (asset.kind === "chart") {
      for (const citationKey of asset.sourceCitationKeys) {
        if (!availableCitationKeys.has(citationKey)) {
          ctx.addIssue({
            code: "custom",
            path: ["assets", key, "sourceCitationKeys"],
            message: `Chart asset references unresolved citationKey: ${citationKey}`
          });
        }
      }
    }
  }

  const assetKeys = new Set(Object.keys(deck.assets));
  for (const slot of deck.slots) {
    if (slot.kind === "chart" && !assetKeys.has(slot.dataAssetKey)) {
      ctx.addIssue({ code: "custom", path: ["slots"], message: `Slide ${slot.slideIndex} references missing chart asset '${slot.dataAssetKey}'.` });
    }
  }
});

export type DeckIR = z.infer<typeof deckIrSchema>;
