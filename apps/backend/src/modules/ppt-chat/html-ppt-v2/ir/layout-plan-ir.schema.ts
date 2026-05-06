import { z } from "zod";
import { renderableLayoutIdSchema } from "./enums";

export const layoutPlanItemSchema = z.object({
  slideIndex: z.number().int().min(1).max(50),
  layoutId: renderableLayoutIdSchema,
  capacityCheck: z.object({
    passed: z.boolean(),
    details: z.string().max(500)
  }).strict(),
  variancePosition: z.number().int().min(0).max(50)
}).strict();

export const layoutPlanIrSchema = z.array(layoutPlanItemSchema).min(1).max(50).superRefine((items, ctx) => {
  const seen = new Set<number>();
  for (const [offset, item] of items.entries()) {
    if (seen.has(item.slideIndex)) {
      ctx.addIssue({ code: "custom", path: [offset, "slideIndex"], message: "layoutPlan slideIndex values must be unique." });
    }
    seen.add(item.slideIndex);

    if (!item.capacityCheck.passed) {
      ctx.addIssue({ code: "custom", path: [offset, "capacityCheck"], message: "LayoutPlanIR cannot contain failed capacity checks." });
    }
  }
});

export type LayoutPlanIR = z.infer<typeof layoutPlanIrSchema>;
export type LayoutPlanItemIR = z.infer<typeof layoutPlanItemSchema>;
