import { z } from "zod";
import { QUALITY_SCORE_KEYS } from "./enums";

export const nonEmptyString = z.string().trim().min(1);
export const shortText = nonEmptyString.max(160);
export const paragraphText = nonEmptyString.max(800);
export const cssColorTokenSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^(#[0-9a-f]{3,8}|rgba?\([0-9.,%/\s-]+\)|hsla?\([0-9.,%/\s-]+\)|oklch\([0-9.,%/\s-]+\)|var\(--[a-z0-9-]+\)|transparent|currentcolor|[a-z]+)$/i, {
    message: "CSS color token must be a safe registry color value."
  });
export const cssFontFamilyTokenSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{N}\s,'"._-]+$/u, {
    message: "CSS font token must be a safe registry font family."
  });
export const cssShadowTokenSchema = z.string()
  .trim()
  .min(1)
  .max(260)
  .regex(/^(none|(?:inset\s+)?[-0-9.pxrem\s]+(?:rgba?\([0-9.,%/\s-]+\)|#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))(?:\s*,\s*(?:inset\s+)?[-0-9.pxrem\s]+(?:rgba?\([0-9.,%/\s-]+\)|#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\)))*)$/i, {
    message: "CSS shadow token must be a safe registry shadow value."
  });
export const cssEasingTokenSchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\([-0-9.,\s]+\))$/i, {
    message: "CSS easing token must be a safe registry easing value."
  });
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const citationKeySchema = z.string().trim().regex(/^[a-z][a-z0-9-]{1,60}$/i);
export const stageIdSchema = z.string().trim().regex(/^stage-\d{1,2}:[a-z0-9-]+$/i);

export const wcagReportSchema = z.object({
  passed: z.boolean(),
  minContrastRatio: z.number().min(1).max(21),
  issues: z.array(nonEmptyString.max(240)).max(40)
}).strict();

export const qualityScoresSchema = z.object(
  Object.fromEntries(QUALITY_SCORE_KEYS.map((key) => [key, z.number().min(0).max(1)])) as Record<
    (typeof QUALITY_SCORE_KEYS)[number],
    z.ZodNumber
  >
).strict();

export const stageCheckpointSchema = z.object({
  stage: stageIdSchema,
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  startedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  summary: z.string().max(500).optional(),
  artifactRef: z.string().max(260).optional()
}).strict();

export type WcagReport = z.infer<typeof wcagReportSchema>;
export type QualityScores = z.infer<typeof qualityScoresSchema>;
export type StageCheckpoint = z.infer<typeof stageCheckpointSchema>;
