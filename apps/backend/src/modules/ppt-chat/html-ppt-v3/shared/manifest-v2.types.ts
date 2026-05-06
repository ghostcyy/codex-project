import { z } from "zod";

export const PAGE_TYPES = [
  "cover",
  "closing",
  "grid-2",
  "grid-3",
  "grid-4",
  "grid-5",
  "sidebar",
  "title-text",
  "chart",
  "image-full",
  "image-text",
  "image-grid",
  "video",
  "audio",
  "table",
  "path-flow"
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const MIDDLE_PAGE_TYPES = PAGE_TYPES.filter(
  (pageType) => pageType !== "cover" && pageType !== "closing"
) as readonly Exclude<PageType, "cover" | "closing">[];

export const CHART_TYPES = ["line", "bar", "pie", "gantt"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MEDIA_KINDS = ["image", "video", "chart", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const LAYOUT_FAMILIES = ["cover", "closing", "grid", "chart", "mixed", "table", "media", "timeline", "text"] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

export const PAGE_COMPONENT_KINDS = ["grid", "chart", "card", "stat", "table", "timeline", "image", "video", "text", "list", "quote", "icon"] as const;
export type PageComponentKind = (typeof PAGE_COMPONENT_KINDS)[number];

export const PAGE_DENSITIES = ["low", "medium", "high"] as const;
export type PageDensity = (typeof PAGE_DENSITIES)[number];

export const CHART_SLOT_KINDS = ["line", "bar", "xbar", "s", "pie", "donut", "gantt", "area", "unknown"] as const;
export type ChartSlotKind = (typeof CHART_SLOT_KINDS)[number];

export const SLOT_ANCHOR_KINDS = [
  "title",
  "subtitle",
  "kicker",
  "body",
  "cardHeading",
  "cardBody",
  "listItem",
  "statNumber",
  "statLabel",
  "tableCell",
  "quote",
  "caption",
  "footer",
  "badge",
  "cta",
  "codeLine",
  "mediaLabel"
] as const;
export type SlotAnchorKind = (typeof SLOT_ANCHOR_KINDS)[number];

export const IMAGE_PAGE_TYPES: readonly PageType[] = ["image-full", "image-text", "image-grid"];
export const VIDEO_PAGE_TYPES: readonly PageType[] = ["video"];
export const AUDIO_PAGE_TYPES: readonly PageType[] = ["audio"];

export const slotAnchorSchema = z.object({
  slotId: z.string().min(1),
  selector: z.string().min(1),
  tarChars: z.number().int().min(1).max(2000).optional(),
  maxChars: z.number().int().min(1).max(2000),
  optional: z.boolean().default(false),
  kind: z.enum(SLOT_ANCHOR_KINDS).optional(),
  sourceText: z.string().optional()
});
export type SlotAnchor = z.infer<typeof slotAnchorSchema>;

export const pageComponentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(PAGE_COMPONENT_KINDS),
  subtype: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  layout: z.object({
    rows: z.number().int().min(1).optional(),
    cols: z.number().int().min(1).optional(),
    items: z.number().int().min(0).optional(),
    orientation: z.enum(["row", "column", "matrix"]).optional()
  }).optional(),
  chartSlotId: z.string().min(1).optional()
});
export type PageComponent = z.infer<typeof pageComponentSchema>;

export const pagePortraitSchema = z.object({
  summary: z.string().min(1),
  layoutFamily: z.enum(LAYOUT_FAMILIES),
  componentSignature: z.string().min(1),
  density: z.enum(PAGE_DENSITIES),
  components: z.array(pageComponentSchema).default([]),
  componentCounts: z.record(z.string(), z.number().int().min(0)).default({}),
  tags: z.array(z.string().min(1)).default([]),
  useCases: z.array(z.string().min(1)).default([])
});
export type PagePortrait = z.infer<typeof pagePortraitSchema>;

export const chartSlotSchema = z.object({
  slotId: z.string().min(1),
  selector: z.string().min(1),
  kind: z.enum(CHART_SLOT_KINDS),
  defaultRenderType: z.enum(CHART_TYPES),
  componentId: z.string().min(1)
});
export type ChartSlot = z.infer<typeof chartSlotSchema>;

export const deckEffectsSchema = z.object({
  htmlFile: z.string().min(1).optional(),
  jsFile: z.string().min(1).optional(),
  elementIds: z.array(z.string().min(1)).default([])
});
export type DeckEffects = z.infer<typeof deckEffectsSchema>;

export const pageFragmentSchema = z.object({
  fragmentId: z.string().min(1).optional(),
  pageType: z.enum(PAGE_TYPES),
  sourcePageType: z.enum(PAGE_TYPES).optional(),
  sourceSlideIndex: z.number().int().min(0).default(0),
  sourceSlideTitle: z.string().default(""),
  htmlFile: z.string().min(1),
  pagePortrait: pagePortraitSchema.optional(),
  topicSlots: z.number().int().min(0).max(8),
  topicSlotMaxChars: z.number().int().min(0).max(600),
  anchors: z.array(slotAnchorSchema),
  chartCanvasSelector: z.string().min(1).optional(),
  chartSlots: z.array(chartSlotSchema).default([]),
  imageSlotSelectors: z.array(z.string().min(1)).default([]),
  videoSlotSelector: z.string().min(1).optional(),
  mediaKinds: z.array(z.enum(MEDIA_KINDS)).default([])
});
export type PageFragment = z.infer<typeof pageFragmentSchema>;
const pageFragmentRecordSchema = z.record(z.string().min(1), pageFragmentSchema) as z.ZodType<Record<string, PageFragment>>;

const templateManifestV2BaseSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  deckClass: z.string().regex(/^tpl-[a-z0-9-]+$/),
  label: z.object({ "zh-CN": z.string().min(1), en: z.string().min(1) }),
  description: z.object({ "zh-CN": z.string().min(1), en: z.string().min(1) }),
  shellHtmlFile: z.string().min(1),
  cssFiles: z.array(z.string().min(1)),
  jsFiles: z.array(z.string().min(1)),
  assetDirs: z.array(z.string().min(1)),
  deckEffects: deckEffectsSchema.optional(),
  fixed: z.object({
    cover: pageFragmentSchema,
    closing: pageFragmentSchema
  }),
  pool: pageFragmentRecordSchema,
  capabilities: z.object({
    chartTypes: z.array(z.enum(CHART_TYPES)).default([]),
    hasImagePages: z.boolean().default(false),
    hasVideoPages: z.boolean().default(false),
    hasAudioPages: z.boolean().default(false)
  })
});
export const templateManifestV2Schema = templateManifestV2BaseSchema.transform((manifest) => {
  const pool = Object.fromEntries(
    Object.entries(manifest.pool).map(([key, fragment]) => {
      const normalized = normalizeFragmentMetadata(fragment, key);
      return [normalized.fragmentId, normalized];
    })
  );
  return {
    ...manifest,
    fixed: {
      cover: normalizeFragmentMetadata(manifest.fixed.cover, "cover"),
      closing: normalizeFragmentMetadata(manifest.fixed.closing, "closing")
    },
    pool
  };
});
type TemplateManifestV2SchemaOutput = z.infer<typeof templateManifestV2Schema>;
export type TemplateManifestV2 = Omit<TemplateManifestV2SchemaOutput, "fixed" | "pool"> & {
  fixed: { cover: PageFragment; closing: PageFragment };
  pool: Record<string, PageFragment>;
};

export function isImagePageType(pageType: PageType) {
  return IMAGE_PAGE_TYPES.includes(pageType);
}

export function isVideoPageType(pageType: PageType) {
  return VIDEO_PAGE_TYPES.includes(pageType);
}

export function isAudioPageType(pageType: PageType) {
  return AUDIO_PAGE_TYPES.includes(pageType);
}

export function fragmentHasMediaKind(fragment: PageFragment, mediaKind: MediaKind) {
  return (fragment.mediaKinds ?? []).includes(mediaKind);
}

function normalizeFragmentMetadata(fragment: PageFragment, fallbackFragmentId: string): PageFragment {
  const fragmentId = fragment.fragmentId ?? fallbackFragmentId;
  const chartSlots = fragment.chartSlots?.length
    ? fragment.chartSlots
    : fragment.chartCanvasSelector
      ? [{
          slotId: "primary",
          selector: fragment.chartCanvasSelector,
          kind: "unknown" as const,
          defaultRenderType: "line" as const,
          componentId: "chart-1"
        }]
      : [];
  return {
    ...fragment,
    fragmentId,
    sourcePageType: fragment.sourcePageType ?? fragment.pageType,
    sourceSlideTitle: fragment.sourceSlideTitle ?? "",
    pagePortrait: fragment.pagePortrait ?? defaultPagePortrait(fragment.pageType),
    chartSlots
  };
}

function defaultPagePortrait(pageType: PageType): PagePortrait {
  const layoutFamily: LayoutFamily = pageType === "cover" || pageType === "closing"
    ? pageType
    : pageType === "chart"
      ? "chart"
      : isImagePageType(pageType) || isVideoPageType(pageType) || isAudioPageType(pageType)
        ? "media"
        : pageType.startsWith("grid-")
          ? "grid"
          : "text";
  return {
    summary: `${pageType} page`,
    layoutFamily,
    componentSignature: pageType,
    density: "medium",
    components: [],
    componentCounts: {},
    tags: [`pageType:${pageType}`],
    useCases: []
  };
}
