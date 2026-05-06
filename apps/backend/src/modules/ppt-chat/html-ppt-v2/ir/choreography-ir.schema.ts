import { z } from "zod";
import { animatableSurfaceIdSchema, animationIdSchema, fxIdSchema } from "./enums";

export const choreographyItemSchema = z.object({
  slideIndex: z.number().int().min(1).max(50),
  entrance: animationIdSchema.nullable(),
  builds: z.array(z.object({
    target: animatableSurfaceIdSchema,
    anim: animationIdSchema,
    delay: z.number().int().min(0).max(10000)
  }).strict()).max(30),
  fx: fxIdSchema.nullable().optional()
}).strict();

export const choreographyIrSchema = z.array(choreographyItemSchema).min(1).max(50).superRefine((items, ctx) => {
  const seen = new Set<number>();
  for (const [offset, item] of items.entries()) {
    if (seen.has(item.slideIndex)) {
      ctx.addIssue({ code: "custom", path: [offset, "slideIndex"], message: "ChoreographyIR slideIndex values must be unique." });
    }
    seen.add(item.slideIndex);
  }
});

export type ChoreographyIR = z.infer<typeof choreographyIrSchema>;
export type ChoreographyItemIR = z.infer<typeof choreographyItemSchema>;
