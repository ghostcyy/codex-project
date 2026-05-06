import { z } from "zod";
import { chartTypeSchema } from "./enums";
import { citationKeySchema, cssColorTokenSchema, paragraphText, shortText } from "./shared";

const assetKeySchema = z.string().trim().regex(/^[a-z][a-z0-9-]{1,80}$/i);
const safeAssetSrcSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^(placeholder:\/\/[a-z0-9-]+|asset:\/\/[a-z0-9-./]+|assets\/[a-z0-9-./]+|https:\/\/[^\s"'<>`{}\\]+)$/i, {
    message: "Asset src must be a safe placeholder, registry asset, local asset path, or https URL."
  });

const chartSeriesSchema = z.object({
  label: shortText,
  data: z.array(z.number().finite()).min(1).max(12),
  color: cssColorTokenSchema.optional()
}).strict();

export const deterministicChartConfigSchema = z.object({
  title: shortText,
  labels: z.array(shortText).min(1).max(12),
  series: z.array(chartSeriesSchema).min(1).max(4),
  unit: z.string().trim().max(40).optional(),
  summary: paragraphText.optional()
}).strict().superRefine((value, ctx) => {
  for (const [seriesIndex, series] of value.series.entries()) {
    if (series.data.length !== value.labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["series", seriesIndex, "data"],
        message: "Chart series data length must match labels length."
      });
    }
  }
});

export const svgIconAssetSchema = z.object({
  kind: z.literal("svg-icon"),
  iconId: shortText,
  tint: cssColorTokenSchema
}).strict();

export const chartAssetSchema = z.object({
  kind: z.literal("chart"),
  chartType: chartTypeSchema,
  chartConfig: deterministicChartConfigSchema,
  sourceCitationKeys: z.array(citationKeySchema).max(12)
}).strict();

export const photoAssetSchema = z.object({
  kind: z.literal("photo"),
  src: safeAssetSrcSchema,
  alt: paragraphText,
  credit: shortText,
  license: shortText
}).strict();

export const illustrationAssetSchema = z.object({
  kind: z.literal("illustration"),
  src: safeAssetSrcSchema,
  alt: paragraphText,
  provenance: z.enum(["generated", "library"])
}).strict();

export const assetSchema = z.discriminatedUnion("kind", [
  svgIconAssetSchema,
  chartAssetSchema,
  photoAssetSchema,
  illustrationAssetSchema
]);

export const assetIrSchema = z.record(assetKeySchema, assetSchema);

export type AssetIR = z.infer<typeof assetIrSchema>;
export type DeckAsset = z.infer<typeof assetSchema>;
export type DeterministicChartConfig = z.infer<typeof deterministicChartConfigSchema>;
