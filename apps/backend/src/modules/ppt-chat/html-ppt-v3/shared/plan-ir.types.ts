import { z } from "zod";
import {
  CHART_TYPES,
  IMAGE_PAGE_TYPES,
  PAGE_TYPES,
  VIDEO_PAGE_TYPES,
  type ChartType,
  type ChartSlot,
  type PageFragment,
  type PagePortrait,
  type PageType,
  type TemplateManifestV2,
  fragmentHasMediaKind,
  isAudioPageType,
  isImagePageType,
  isVideoPageType
} from "./manifest-v2.types";
import type { GenerateRequest } from "./job.types";

export type PageTypeSummary = {
  fragmentId: string;
  pageType: PageType;
  htmlFile: string;
  topicSlots: number;
  topicSlotMaxChars: number;
  approxCharCapacity: number;
  description: string;
  pagePortrait: PagePortrait;
  chartSlots: ChartSlot[];
  isChart: boolean;
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
};

export type AvailablePool = {
  templateId: string;
  middle: Record<string, PageTypeSummary>;
  cover: PageTypeSummary;
  closing: PageTypeSummary;
  chartTypesAvailable: ChartType[];
};

export const plannedSlideSchema = z.object({
  slideIndex: z.number().int().min(1),
  fragmentId: z.string().min(1).optional(),
  pageType: z.enum(PAGE_TYPES),
  slideTitle: z.string().min(1).max(60),
  topicPoints: z.array(z.string().min(1).max(80)),
  chartType: z.enum(CHART_TYPES).optional(),
  charBudget: z.number().int().min(50).max(3000)
});
export type PlannedSlide = z.infer<typeof plannedSlideSchema>;

export const planIRSchema = z.object({
  templateId: z.string().min(1),
  totalChars: z.number().int(),
  pageCount: z.number().int(),
  slides: z.array(plannedSlideSchema)
});
export type PlanIR = z.infer<typeof planIRSchema>;

export function buildAvailablePool(manifest: TemplateManifestV2, req: GenerateRequest): AvailablePool {
  const middle: Record<string, PageTypeSummary> = {};

  for (const [key, fragment] of Object.entries(manifest.pool) as Array<[string, PageFragment]>) {
    const fragmentId = fragment.fragmentId ?? key;
    if (!req.includeImages && (IMAGE_PAGE_TYPES.includes(fragment.pageType) || fragmentHasMediaKind(fragment, "image"))) continue;
    if (!req.includeVideo && (VIDEO_PAGE_TYPES.includes(fragment.pageType) || fragmentHasMediaKind(fragment, "video"))) continue;
    if (!req.includeChart && (fragment.pageType === "chart" || fragmentHasMediaKind(fragment, "chart"))) continue;
    if (!req.includeAudio && (isAudioPageType(fragment.pageType) || fragmentHasMediaKind(fragment, "audio"))) continue;
    middle[fragmentId] = summarizeFragment({ ...fragment, fragmentId });
  }

  return {
    templateId: manifest.id,
    middle,
    cover: summarizeFragment(manifest.fixed.cover),
    closing: summarizeFragment(manifest.fixed.closing),
    chartTypesAvailable: req.includeChart ? manifest.capabilities.chartTypes : []
  };
}

export function validatePlanIR(
  plan: PlanIR,
  req: GenerateRequest,
  pool: AvailablePool
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (plan.templateId !== req.templateId) reasons.push(`templateId must equal request templateId '${req.templateId}'.`);
  if (plan.pageCount !== req.pageCount) reasons.push(`pageCount must equal request pageCount ${req.pageCount}.`);
  if (plan.totalChars !== req.wordBudget) reasons.push(`totalChars must equal request wordBudget ${req.wordBudget}.`);
  if (plan.slides.length !== req.pageCount) reasons.push(`slides length must equal pageCount ${req.pageCount}.`);

  const first = plan.slides[0];
  const last = plan.slides.at(-1);
  if (first?.pageType !== "cover") reasons.push("slide 1 must use pageType cover.");
  if (last?.pageType !== "closing") reasons.push("last slide must use pageType closing.");

  const seen = new Set<number>();
  for (let index = 0; index < plan.slides.length; index++) {
    const slide = plan.slides[index]!;
    const expectedIndex = index + 1;
    if (slide.slideIndex !== expectedIndex) reasons.push(`slideIndex at position ${expectedIndex} must be ${expectedIndex}.`);
    if (seen.has(slide.slideIndex)) reasons.push(`duplicate slideIndex ${slide.slideIndex}.`);
    seen.add(slide.slideIndex);

    if (index > 0 && index < plan.slides.length - 1) {
      if (!slide.fragmentId) {
        reasons.push(`slide ${slide.slideIndex} middle slide must include fragmentId.`);
      }
      const summary = slide.fragmentId ? pool.middle[slide.fragmentId] : undefined;
      if (!summary) {
        reasons.push(`slide ${slide.slideIndex} fragmentId '${slide.fragmentId ?? ""}' is not available.`);
      } else if (summary.pageType !== slide.pageType) {
        reasons.push(`slide ${slide.slideIndex} pageType '${slide.pageType}' must match fragment '${slide.fragmentId}' pageType '${summary.pageType}'.`);
      } else if (slide.topicPoints.length !== summary.topicSlots) {
        reasons.push(`slide ${slide.slideIndex} topicPoints length must equal fragment '${slide.fragmentId}' topicSlots ${summary.topicSlots}.`);
      }
    }

    const summary = slide.fragmentId ? pool.middle[slide.fragmentId] : undefined;
    const hasChartSlots = Boolean(summary?.chartSlots.length);
    if (slide.pageType === "chart" && !slide.chartType && !hasChartSlots) reasons.push(`slide ${slide.slideIndex} chart page must include chartType.`);
    if (slide.chartType && !pool.chartTypesAvailable.includes(slide.chartType)) {
      reasons.push(`slide ${slide.slideIndex} chartType '${slide.chartType}' is not available.`);
    }

    if ((isImagePageType(slide.pageType) || summary?.isImage) && !req.includeImages) {
      reasons.push(`slide ${slide.slideIndex} uses image pageType while includeImages=false.`);
    }
    if ((isVideoPageType(slide.pageType) || summary?.isVideo) && !req.includeVideo) {
      reasons.push(`slide ${slide.slideIndex} uses video pageType while includeVideo=false.`);
    }
    if ((slide.pageType === "chart" || summary?.isChart) && !req.includeChart) {
      reasons.push(`slide ${slide.slideIndex} uses chart pageType while includeChart=false.`);
    }
    if ((isAudioPageType(slide.pageType) || summary?.isAudio) && !req.includeAudio) {
      reasons.push(`slide ${slide.slideIndex} uses audio pageType while includeAudio=false.`);
    }
  }

  const totalBudget = plan.slides.reduce((sum, slide) => sum + slide.charBudget, 0);
  const tolerance = Math.max(1, Math.round(req.wordBudget * 0.15));
  if (Math.abs(totalBudget - req.wordBudget) > tolerance) {
    reasons.push(`sum(charBudget) must be within 15% of wordBudget ${req.wordBudget}; got ${totalBudget}.`);
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

function summarizeFragment(fragment: PageFragment): PageTypeSummary {
  const requiredCapacity = fragment.anchors
    .filter((anchor) => !anchor.optional)
    .reduce((sum, anchor) => sum + anchor.maxChars, 0);
  const pagePortrait = fragment.pagePortrait ?? {
    summary: `${fragment.pageType} page`,
    layoutFamily: "text" as const,
    componentSignature: fragment.pageType,
    density: "medium" as const,
    components: [],
    componentCounts: {},
    tags: [`pageType:${fragment.pageType}`],
    useCases: []
  };

  return {
    fragmentId: fragment.fragmentId ?? fragment.pageType,
    pageType: fragment.pageType,
    htmlFile: fragment.htmlFile,
    topicSlots: fragment.topicSlots,
    topicSlotMaxChars: fragment.topicSlotMaxChars,
    approxCharCapacity: Math.round(requiredCapacity * 0.9),
    description: describePageType(fragment),
    pagePortrait,
    chartSlots: fragment.chartSlots ?? [],
    isChart: fragment.pageType === "chart" || fragmentHasMediaKind(fragment, "chart"),
    isImage: isImagePageType(fragment.pageType) || fragmentHasMediaKind(fragment, "image"),
    isVideo: isVideoPageType(fragment.pageType) || fragmentHasMediaKind(fragment, "video"),
    isAudio: isAudioPageType(fragment.pageType) || fragmentHasMediaKind(fragment, "audio")
  };
}

function describePageType(fragment: PageFragment) {
  const parts = [
    `${fragment.fragmentId ?? fragment.pageType}:${fragment.pageType}`,
    `${fragment.topicSlots} topic slots`,
    `slot max ${fragment.topicSlotMaxChars} chars`,
    (fragment.pagePortrait?.componentSignature ?? fragment.pageType)
  ];
  if (fragment.pageType === "chart" || fragmentHasMediaKind(fragment, "chart")) parts.push(`${fragment.chartSlots?.length ?? 0} chart slots`);
  if (isImagePageType(fragment.pageType) || fragmentHasMediaKind(fragment, "image")) parts.push(`${fragment.imageSlotSelectors.length} image slots`);
  if (isVideoPageType(fragment.pageType) || fragmentHasMediaKind(fragment, "video")) parts.push("video slot");
  if (isAudioPageType(fragment.pageType) || fragmentHasMediaKind(fragment, "audio")) parts.push("audio slot");
  return parts.join("; ");
}
