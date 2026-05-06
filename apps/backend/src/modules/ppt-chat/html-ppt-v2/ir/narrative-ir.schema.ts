import { z } from "zod";
import { densityBudgetSchema, narrativeArcSchema, slideRoleSchema } from "./enums";
import { citationKeySchema, nonEmptyString, paragraphText, shortText } from "./shared";

export const narrativeSlideSchema = z.object({
  index: z.number().int().min(1).max(50),
  role: slideRoleSchema,
  beat: shortText,
  contentBrief: z.object({
    headline: shortText,
    subhead: z.string().trim().max(260).optional(),
    supportingPoints: z.array(paragraphText).min(1).max(12),
    evidenceRefs: z.array(citationKeySchema).max(12),
    keyMetrics: z.array(shortText).max(8).optional()
  }).strict(),
  densityBudget: densityBudgetSchema,
  estimatedNarrativeChars: z.number().int().min(0).max(8000)
}).strict();

export const narrativeIrSchema = z.object({
  arc: narrativeArcSchema,
  slides: z.array(narrativeSlideSchema).min(1).max(50),
  totalEstimatedChars: z.number().int().min(0).max(50000),
  transitions: z.array(z.object({
    fromSlide: z.number().int().min(1).max(50),
    toSlide: z.number().int().min(1).max(50),
    bridge: nonEmptyString.max(260)
  }).strict()).max(60)
}).strict().superRefine((value, ctx) => {
  const indexes = value.slides.map((slide) => slide.index);
  const unique = new Set(indexes);
  if (unique.size !== indexes.length) {
    ctx.addIssue({ code: "custom", path: ["slides"], message: "Narrative slide indexes must be unique." });
  }

  const sorted = [...indexes].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      ctx.addIssue({ code: "custom", path: ["slides"], message: "Narrative slide indexes must be consecutive and 1-based." });
      break;
    }
  }

  const estimated = value.slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0);
  if (Math.abs(estimated - value.totalEstimatedChars) > Math.max(120, Math.round(estimated * 0.08))) {
    ctx.addIssue({
      code: "custom",
      path: ["totalEstimatedChars"],
      message: "totalEstimatedChars must approximately equal the sum of slide estimates."
    });
  }

  for (const transition of value.transitions) {
    if (!unique.has(transition.fromSlide) || !unique.has(transition.toSlide)) {
      ctx.addIssue({ code: "custom", path: ["transitions"], message: "Transitions must reference existing narrative slide indexes." });
    }
  }
});

export type NarrativeIR = z.infer<typeof narrativeIrSchema>;
export type NarrativeSlideIR = z.infer<typeof narrativeSlideSchema>;
