/**
 * html-ppt-v3 :: manifest.types.ts
 *
 * Core data contract describing the structural slots of each slide in a
 * Gemini template. A manifest.json is stored inside every template folder
 * and is generated once by manifest.parser.ts (CLI tool), then hand-verified.
 */

import { z } from "zod";

/* ─────────────────────────── PageType ───────────────────────────── */

export const PAGE_TYPES = [
  "cover",       // title slide (first slide)
  "closing",     // end slide (last slide)
  "grid-2",      // 2-column card grid
  "grid-3",      // 3-column card grid
  "grid-4",      // 4-column card grid
  "grid-5",      // 5-column card grid
  "sidebar",     // 1:2 sidebar + main content
  "image-text",  // image card + text card side by side
  "image-full",  // full-bleed image with text overlay
  "chart",       // Chart.js data visualisation
  "video",       // video player slide
  "audio",       // audio player slide
  "path-flow",   // flow-step arrow sequence
  "table",       // data-table slide
  "title-text",  // large heading + prose paragraph
] as const;

export type PageType = (typeof PAGE_TYPES)[number];

/* ─────────────────────────── SlotAnchor ─────────────────────────── */

/**
 * A single injectable content slot inside one slide section.
 *
 * selector  – unique CSS selector path relative to the <section>, e.g.
 *             ".grid-3 .card:nth-child(2) h3"
 * maxChars  – hard character limit (injector will truncate if exceeded).
 * optional  – if true the slot may be left empty without breaking layout.
 */
export const slotAnchorSchema = z.object({
  slotId:   z.string().min(1),   // e.g. "title", "card-2-body", "kicker"
  selector: z.string().min(1),   // CSS selector relative to <section>
  maxChars: z.number().int().min(1).max(2000),
  optional: z.boolean().default(false),
});
export type SlotAnchor = z.infer<typeof slotAnchorSchema>;

/* ─────────────────────────── SlideManifest ──────────────────────── */

export const slideManifestSchema = z.object({
  slideIndex:         z.number().int().min(1),
  slideTitle:         z.string(),          // original template default title (reference)
  pageType:           z.enum(PAGE_TYPES),
  topicSlots:         z.number().int().min(0).max(8),   // number of card/topic blocks
  topicSlotMaxChars:  z.number().int().min(0).max(600), // per-block char budget
  hasImage:           z.boolean().default(false),
  imageCount:         z.number().int().min(0).max(6).default(0),
  hasVideo:           z.boolean().default(false),
  hasChart:           z.boolean().default(false),
  chartCanvasIds:     z.array(z.string()).default([]),   // HTML canvas[id] values
  anchors:            z.array(slotAnchorSchema),
});
export type SlideManifest = z.infer<typeof slideManifestSchema>;

/* ─────────────────────────── TemplateManifest ───────────────────── */

export const templateManifestSchema = z.object({
  id:           z.string().min(1),                      // "09-fashion-ar"
  label:        z.object({ "zh-CN": z.string(), en: z.string() }),
  description:  z.object({ "zh-CN": z.string(), en: z.string() }),
  deckClass:    z.string().regex(/^tpl-[a-z0-9-]+$/),  // "tpl-fashion"
  totalSlides:  z.number().int().min(1).max(60),
  slides:       z.array(slideManifestSchema).min(1),
});
export type TemplateManifest = z.infer<typeof templateManifestSchema>;

/* ─────────────────────────── Template summary for LLM ───────────── */

/**
 * Condensed view passed to the LLM in Stage 1.
 * Omits low-level CSS selectors; keeps capacity data.
 */
export type SlideSummaryForPlanner = {
  slideIndex:        number;
  slideTitle:        string;
  pageType:          PageType;
  topicSlots:        number;
  topicSlotMaxChars: number;
  hasImage:          boolean;
  hasVideo:          boolean;
  hasChart:          boolean;
};

export function buildSlideSummaries(manifest: TemplateManifest): SlideSummaryForPlanner[] {
  return manifest.slides.map((s) => ({
    slideIndex:        s.slideIndex,
    slideTitle:        s.slideTitle,
    pageType:          s.pageType,
    topicSlots:        s.topicSlots,
    topicSlotMaxChars: s.topicSlotMaxChars,
    hasImage:          s.hasImage,
    hasVideo:          s.hasVideo,
    hasChart:          s.hasChart,
  }));
}
