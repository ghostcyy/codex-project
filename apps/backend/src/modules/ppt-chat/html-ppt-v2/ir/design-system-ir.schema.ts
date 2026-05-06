import { z } from "zod";
import { animationIdSchema, donorIdSchema, fxIdSchema, slideRoleSchema, themeIdSchema } from "./enums";
import {
  cssColorTokenSchema,
  cssEasingTokenSchema,
  cssFontFamilyTokenSchema,
  cssShadowTokenSchema,
  nonEmptyString,
  shortText,
  wcagReportSchema
} from "./shared";

export const themeTokensSchema = z.object({
  palette: z.object({
    bg: cssColorTokenSchema,
    surface: cssColorTokenSchema,
    surface2: cssColorTokenSchema,
    accent: cssColorTokenSchema,
    accent2: cssColorTokenSchema,
    accent3: cssColorTokenSchema,
    text1: cssColorTokenSchema,
    text2: cssColorTokenSchema,
    border: cssColorTokenSchema,
    good: cssColorTokenSchema.optional(),
    warn: cssColorTokenSchema.optional(),
    bad: cssColorTokenSchema.optional()
  }).strict(),
  typography: z.object({
    fontDisplay: cssFontFamilyTokenSchema,
    fontBody: cssFontFamilyTokenSchema,
    fontMono: cssFontFamilyTokenSchema,
    scaleRatio: z.number().min(1).max(2),
    baseSize: z.number().int().min(10).max(28)
  }).strict(),
  geometry: z.object({
    radiusSm: z.number().min(0).max(80),
    radiusMd: z.number().min(0).max(120),
    radiusLg: z.number().min(0).max(160),
    gapSm: z.number().min(0).max(80),
    gapMd: z.number().min(0).max(120),
    gapLg: z.number().min(0).max(200)
  }).strict(),
  elevation: z.object({
    shadowSm: cssShadowTokenSchema.max(160),
    shadowMd: cssShadowTokenSchema.max(200),
    shadowLg: cssShadowTokenSchema.max(260)
  }).strict(),
  motion: z.object({
    easing: cssEasingTokenSchema,
    durationFast: z.number().int().min(0).max(3000),
    durationBase: z.number().int().min(0).max(5000),
    durationSlow: z.number().int().min(0).max(8000)
  }).strict()
}).strict();

export const donorContractSchema = z.object({
  id: donorIdSchema,
  decorativeClasses: z.array(shortText).max(80),
  coverOnlyClasses: z.array(shortText).max(80),
  bodyAllowedClasses: z.array(shortText).max(120),
  dnaSignature: z.object({
    titleTreatment: shortText,
    cardTreatment: shortText,
    kickerTreatment: shortText,
    accentRule: shortText,
    density: z.enum(["airy", "balanced", "dense"])
  }).strict(),
  forbiddenTextPatterns: z.array(shortText).max(80)
}).strict();

export const designSystemIrSchema = z.object({
  themeId: themeIdSchema,
  themeTokens: themeTokensSchema,
  donorTemplateId: donorIdSchema,
  donorContract: donorContractSchema,
  deckClass: z.string().trim().regex(/^tpl-[a-z0-9-]+$/),
  contrastReport: wcagReportSchema,
  animationBudget: z.object({
    allowedAnims: z.array(animationIdSchema).min(1).max(12),
    allowedFx: z.array(fxIdSchema).max(12),
    maxAccentSlides: z.number().int().min(0).max(20),
    fxAllowedRoles: z.array(slideRoleSchema).max(8)
  }).strict(),
  accentPolicy: z.enum(["rotate", "static", "gradient-build"]),
  audienceFitReport: z.object({
    score: z.number().min(0).max(1),
    reasons: z.array(nonEmptyString.max(220)).max(10)
  }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.donorContract.id !== value.donorTemplateId) {
    ctx.addIssue({
      code: "custom",
      path: ["donorContract", "id"],
      message: "donorContract.id must match donorTemplateId."
    });
  }

  if (!value.contrastReport.passed) {
    ctx.addIssue({
      code: "custom",
      path: ["contrastReport"],
      message: "DesignSystemIR cannot lock a theme that fails its contrast report."
    });
  }
});

export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type DonorContractIR = z.infer<typeof donorContractSchema>;
export type DesignSystemIR = z.infer<typeof designSystemIrSchema>;
