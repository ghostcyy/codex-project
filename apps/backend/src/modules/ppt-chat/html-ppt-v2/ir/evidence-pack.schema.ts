import { z } from "zod";
import { citationKeySchema, nonEmptyString, paragraphText, shortText } from "./shared";

export const evidenceSourceSchema = z.object({
  url: z.string().url(),
  title: shortText,
  publishedAt: z.string().max(60).optional(),
  type: z.enum(["web", "paper", "data", "rag"])
}).strict();

export const evidencePackSchema = z.object({
  facts: z.array(z.object({
    claim: paragraphText,
    confidence: z.enum(["high", "medium", "low"]),
    sources: z.array(evidenceSourceSchema).min(1).max(8),
    citationKey: citationKeySchema,
    internalOnly: z.boolean().optional()
  }).strict()).max(80),
  dataPoints: z.array(z.object({
    metric: shortText,
    value: z.union([z.number(), shortText]),
    unit: z.string().max(40).optional(),
    period: z.string().max(80).optional(),
    source: shortText,
    citationKey: citationKeySchema,
    internalOnly: z.boolean().optional()
  }).strict()).max(60),
  candidateVisuals: z.array(z.object({
    kind: z.enum(["photo", "illustration", "icon", "logo", "chart-data"]),
    description: paragraphText,
    sourceUrl: z.string().url().optional(),
    license: z.string().max(120).optional(),
    relevanceScore: z.number().min(0).max(1)
  }).strict()).max(60),
  terminology: z.array(z.object({
    term: shortText,
    definition: paragraphText,
    usage: z.enum(["technical", "colloquial"]),
    internalOnly: z.boolean().optional()
  }).strict()).max(80),
  narrativeAngles: z.array(z.object({
    angle: shortText,
    tradeoffs: paragraphText
  }).strict()).max(20),
  knownGaps: z.array(nonEmptyString.max(260)).max(30)
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, fact] of value.facts.entries()) {
    const key = fact.citationKey.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["facts", index, "citationKey"], message: `Duplicate citationKey: ${fact.citationKey}` });
    }
    seen.add(key);
  }
  for (const [index, dataPoint] of value.dataPoints.entries()) {
    const key = dataPoint.citationKey.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: ["dataPoints", index, "citationKey"], message: `Duplicate citationKey: ${dataPoint.citationKey}` });
    }
    seen.add(key);
  }
});

export type EvidencePack = z.infer<typeof evidencePackSchema>;
