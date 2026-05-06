import { z } from "zod";
import { chartTypeSchema } from "./enums";
import { citationKeySchema, nonEmptyString, paragraphText, shortText } from "./shared";

const baseSlideFillSchema = z.object({
  slideIndex: z.number().int().min(1).max(50),
  title: shortText,
  kicker: z.string().trim().max(80).optional(),
  footer: z.string().trim().max(140).optional(),
  citationKeys: z.array(citationKeySchema).max(12).default([])
});

const cardSchema = z.object({
  title: shortText,
  body: paragraphText,
  accent: z.enum(["primary", "secondary", "neutral", "good", "warn", "bad"]).optional(),
  citationKeys: z.array(citationKeySchema).max(6).default([])
}).strict();

const metricSchema = z.object({
  label: shortText,
  value: shortText,
  note: z.string().trim().max(180).optional(),
  citationKeys: z.array(citationKeySchema).max(6).default([])
}).strict();

const bulletGroupSchema = z.object({
  title: shortText,
  items: z.array(shortText).min(2).max(5),
  accent: z.enum(["primary", "secondary", "neutral", "good", "warn", "bad"]).optional(),
  citationKeys: z.array(citationKeySchema).max(6).default([])
}).strict();

const processStepSchema = z.object({
  label: shortText,
  title: shortText,
  description: paragraphText,
  accent: z.enum(["primary", "secondary", "neutral", "good", "warn", "bad"]).optional(),
  citationKeys: z.array(citationKeySchema).max(6).default([])
}).strict();

export const coverFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("cover"),
  subtitle: z.string().trim().max(260).optional(),
  meta: z.array(shortText).max(4).default([])
}).strict();

export const tocFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("toc"),
  items: z.array(z.object({
    label: shortText,
    description: z.string().trim().max(160).optional()
  }).strict()).min(3).max(12)
}).strict();

export const twoColumnFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("two-column"),
  leftTitle: shortText,
  leftBody: paragraphText,
  rightTitle: shortText,
  rightBody: paragraphText,
  bullets: z.array(shortText).max(8).default([])
}).strict();

export const threeColumnFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("three-column"),
  cards: z.array(cardSchema).min(3).max(3)
}).strict();

export const kpiGridFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("kpi-grid"),
  metrics: z.array(metricSchema).min(3).max(6),
  summary: z.string().trim().max(260).optional()
}).strict();

export const timelineFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("timeline"),
  events: z.array(z.object({
    label: shortText,
    date: z.string().trim().max(60).optional(),
    description: paragraphText,
    accent: z.enum(["primary", "secondary", "neutral"]).optional(),
    citationKeys: z.array(citationKeySchema).max(6).default([])
  }).strict()).min(4).max(8)
}).strict();

export const comparisonFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("comparison"),
  left: cardSchema,
  right: cardSchema,
  verdict: z.string().trim().max(240).optional()
}).strict();

export const ctaFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("cta"),
  headline: shortText,
  action: shortText,
  supportingText: z.string().trim().max(260).optional()
}).strict();

export const chartFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("chart"),
  chartType: chartTypeSchema,
  dataAssetKey: nonEmptyString.max(80),
  insight: paragraphText
}).strict();

export const quoteFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("quote"),
  quote: paragraphText,
  attribution: shortText.optional(),
  supportingText: z.string().trim().max(220).optional()
}).strict();

export const sectionDividerFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("section-divider"),
  marker: shortText,
  progressText: z.string().trim().max(80).optional(),
  supportingText: z.string().trim().max(220).optional()
}).strict();

export const statHighlightFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("stat-highlight"),
  value: shortText,
  label: shortText,
  explanation: paragraphText,
  cards: z.array(cardSchema).min(2).max(3).default([])
}).strict();

export const bulletListFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("bullet-list"),
  lede: z.string().trim().max(260).optional(),
  groups: z.array(bulletGroupSchema).min(2).max(4)
}).strict();

export const processFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("process"),
  lede: z.string().trim().max(240).optional(),
  steps: z.array(processStepSchema).min(3).max(6)
}).strict();

export const imageHeroFillSchema = baseSlideFillSchema.extend({
  kind: z.literal("image-hero"),
  lede: z.string().trim().max(260).optional(),
  imageAssetKey: z.string().trim().max(80).optional(),
  imageAlt: z.string().trim().max(160).optional(),
  visualLabel: shortText.optional(),
  body: paragraphText,
  chips: z.array(shortText).max(5).default([])
}).strict();

export const slideSlotFillSchema = z.discriminatedUnion("kind", [
  coverFillSchema,
  tocFillSchema,
  twoColumnFillSchema,
  threeColumnFillSchema,
  kpiGridFillSchema,
  timelineFillSchema,
  comparisonFillSchema,
  bulletListFillSchema,
  processFillSchema,
  ctaFillSchema,
  chartFillSchema,
  imageHeroFillSchema,
  quoteFillSchema,
  sectionDividerFillSchema,
  statHighlightFillSchema
]);

export const slotFillIrSchema = z.array(slideSlotFillSchema).min(1).max(50).superRefine((items, ctx) => {
  const seen = new Set<number>();
  for (const [offset, item] of items.entries()) {
    if (seen.has(item.slideIndex)) {
      ctx.addIssue({ code: "custom", path: [offset, "slideIndex"], message: "SlotFillIR slideIndex values must be unique." });
    }
    seen.add(item.slideIndex);
  }
});

export type SlideSlotFillIR = z.infer<typeof slideSlotFillSchema>;
export type SlotFillIR = z.infer<typeof slotFillIrSchema>;
