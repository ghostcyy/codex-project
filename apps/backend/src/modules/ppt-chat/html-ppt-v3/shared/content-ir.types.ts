import { z } from "zod";
import { CHART_TYPES, PAGE_TYPES, fragmentHasMediaKind, type PageType, type TemplateManifestV2 } from "./manifest-v2.types";
import type { PlanIR } from "./plan-ir.types";

export const chartDataIRSchema = z.object({
  type: z.enum(CHART_TYPES),
  labels: z.array(z.string()),
  datasets: z.array(z.object({
    label: z.string(),
    data: z.array(z.number()),
    backgroundColor: z.union([z.string(), z.array(z.string())]).optional(),
    borderColor: z.union([z.string(), z.array(z.string())]).optional()
  }))
});
export type ChartDataIR = z.infer<typeof chartDataIRSchema>;

export const slideContentSchema = z.object({
  slideIndex: z.number().int().min(1),
  fragmentId: z.string().min(1).optional(),
  pageType: z.enum(PAGE_TYPES),
  slotFills: z.record(z.string(), z.string()),
  chartData: chartDataIRSchema.optional(),
  chartDataBySlot: z.record(z.string(), chartDataIRSchema).optional(),
  imageHints: z.array(z.string()).optional(),
  videoHint: z.string().optional()
});
export type SlideContent = z.infer<typeof slideContentSchema>;

export const contentIRSchema = z.object({
  templateId: z.string().min(1),
  slides: z.array(slideContentSchema)
});
export type ContentIR = z.infer<typeof contentIRSchema>;

export function validateContentIR(
  content: ContentIR,
  plan: PlanIR,
  manifest: TemplateManifestV2
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (content.templateId !== plan.templateId) reasons.push(`templateId must equal plan templateId '${plan.templateId}'.`);
  if (content.slides.length !== plan.slides.length) reasons.push(`slides length must equal plan slides length ${plan.slides.length}.`);

  const planByIndex = new Map(plan.slides.map((slide) => [slide.slideIndex, slide]));
  const contentByIndex = new Map(content.slides.map((slide) => [slide.slideIndex, slide]));

  for (const planSlide of plan.slides) {
    const slideContent = contentByIndex.get(planSlide.slideIndex);
    if (!slideContent) {
      reasons.push(`missing content for slide ${planSlide.slideIndex}.`);
      continue;
    }
    if (slideContent.pageType !== planSlide.pageType) {
      reasons.push(`slide ${planSlide.slideIndex} pageType must be '${planSlide.pageType}'.`);
    }
    if (planSlide.fragmentId && slideContent.fragmentId !== planSlide.fragmentId) {
      reasons.push(`slide ${planSlide.slideIndex} fragmentId must be '${planSlide.fragmentId}'.`);
    }
    if (planSlide.pageType !== "cover" && planSlide.pageType !== "closing" && !planSlide.fragmentId) {
      reasons.push(`slide ${planSlide.slideIndex} middle plan slide must include fragmentId.`);
    }

    const fragment = getFragmentForPlannedSlide(manifest, planSlide);
    if (!fragment) {
      reasons.push(`slide ${planSlide.slideIndex} fragment '${planSlide.fragmentId ?? planSlide.pageType}' has no manifest fragment.`);
      continue;
    }

    for (const anchor of fragment.anchors) {
      const value = slideContent.slotFills[anchor.slotId];
      if (!anchor.optional && typeof value !== "string") {
        reasons.push(`slide ${planSlide.slideIndex} missing required slot '${anchor.slotId}'.`);
        continue;
      }
      if (typeof value === "string" && value.length > anchor.maxChars) {
        reasons.push(`slide ${planSlide.slideIndex} slot '${anchor.slotId}' exceeds maxChars ${anchor.maxChars}.`);
      }
    }

    if (planSlide.pageType === "chart" || fragmentHasMediaKind(fragment, "chart")) {
      const chartSlots = fragment.chartSlots ?? [];
      if (chartSlots.length > 0) {
        if (!slideContent.chartDataBySlot) {
          reasons.push(`slide ${planSlide.slideIndex} chart page requires chartDataBySlot.`);
        } else {
          for (const slot of chartSlots) {
            const slotData = slideContent.chartDataBySlot[slot.slotId];
            if (!slotData) {
              reasons.push(`slide ${planSlide.slideIndex} chart slot '${slot.slotId}' requires chartDataBySlot entry.`);
              continue;
            }
            validateChartDataLengths(planSlide.slideIndex, slotData, reasons);
          }
        }
      } else if (!slideContent.chartData) {
        reasons.push(`slide ${planSlide.slideIndex} chart page requires chartData.`);
      } else {
        if (planSlide.chartType && slideContent.chartData.type !== planSlide.chartType) {
          reasons.push(`slide ${planSlide.slideIndex} chartData.type must equal planned chartType '${planSlide.chartType}'.`);
        }
        validateChartDataLengths(planSlide.slideIndex, slideContent.chartData, reasons);
      }
    }
  }

  for (const slide of content.slides) {
    if (!planByIndex.has(slide.slideIndex)) reasons.push(`unexpected content slide ${slide.slideIndex}.`);
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

function validateChartDataLengths(slideIndex: number, chartData: z.infer<typeof chartDataIRSchema>, reasons: string[]) {
  for (const [datasetIndex, dataset] of chartData.datasets.entries()) {
    if (dataset.data.length !== chartData.labels.length) {
      reasons.push(`slide ${slideIndex} dataset ${datasetIndex} length must match labels length.`);
    }
  }
}

function getFragmentForPlannedSlide(manifest: TemplateManifestV2, slide: PlanIR["slides"][number]) {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}
