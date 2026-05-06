import { buildStage2WriterPrompt } from "../prompts/stage2-writer.prompt";
import {
  contentIRSchema,
  isImagePageType,
  isVideoPageType,
  validateContentIR,
  fragmentHasMediaKind,
  type ContentIR,
  type PageFragment,
  type PageType,
  type PlanIR,
  type TemplateManifestV2
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";
import { z } from "zod";

export type Stage2WriterInput = {
  plan: PlanIR;
  manifest: TemplateManifestV2;
  llm: HtmlPptV3LLMClient;
};

export type SlideContent = {
  slideIndex: number;
  slots: Array<{ slotId: string; text: string }>;
  chartData?: {
    labels: string[];
    datasets: Array<{ label: string; data: number[] }>;
  };
};

export type AllSlideContent = SlideContent[];

export type Stage2WriterResult = {
  content: ContentIR;
  source: "model" | "fallback";
  validationErrors: string[];
};

const STAGE2_BATCH_SIZE = 7;

export async function runStage2Writer(input: Stage2WriterInput): Promise<Stage2WriterResult> {
  const validationErrors: string[] = [];
  const batches = splitPlanSlidesForStage2(input.plan, STAGE2_BATCH_SIZE);

  try {
    const batchResults = await Promise.all(batches.map((batchSlides, index) => runStage2WriterBatch({
      ...input,
      batchSlides,
      batchIndex: index + 1,
      totalBatches: batches.length
    })));
    validationErrors.push(...batchResults.flatMap((result) => result.validationErrors));
    const merged = mergeStage2BatchResults(input.plan, batchResults.map((result) => result.content));
    if (merged.ok) {
      const validation = validateContentIR(merged.content, input.plan, input.manifest);
      if (validation.ok) {
        return { content: merged.content, source: "model", validationErrors };
      }
      validationErrors.push(validation.reasons.join("; "));
    } else {
      validationErrors.push(merged.reasons.join("; "));
    }
  } catch (err) {
    validationErrors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    content: buildFallbackContent(input.plan, input.manifest),
    source: "fallback",
    validationErrors
  };
}

async function runStage2WriterBatch(input: Stage2WriterInput & {
  batchSlides: PlanIR["slides"];
  batchIndex: number;
  totalBatches: number;
}): Promise<{ content: ContentIR; validationErrors: string[] }> {
  const validationErrors: string[] = [];
  const batchPlan = buildBatchPlan(input.plan, input.batchSlides);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildStage2WriterPrompt({
      plan: input.plan,
      manifest: input.manifest,
      previousError: validationErrors.at(-1),
      batchIndex: input.batchIndex,
      totalBatches: input.totalBatches,
      batchSlides: input.batchSlides
    });

    try {
      const candidate = await input.llm.callStructured({
        stage: "v3-stage2-writer",
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        schema: buildStage2ModelContentSchema(batchPlan, input.manifest),
        temperature: attempt === 1 ? 0.15 : 0,
        retries: 1
      });
      const clamped = clampContentToMaxChars(candidate, batchPlan, input.manifest);
      const validation = validateContentIR(clamped, batchPlan, input.manifest);
      if (validation.ok) {
        return { content: clamped, validationErrors };
      }
      validationErrors.push(`batch ${input.batchIndex}/${input.totalBatches}: ${validation.reasons.join("; ")}`);
    } catch (err) {
      validationErrors.push(`batch ${input.batchIndex}/${input.totalBatches}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(validationErrors.join(" | "));
}

function splitPlanSlidesForStage2(plan: PlanIR, batchSize: number): Array<PlanIR["slides"]> {
  const batches: Array<PlanIR["slides"]> = [];
  for (let index = 0; index < plan.slides.length; index += batchSize) {
    batches.push(plan.slides.slice(index, index + batchSize));
  }
  return batches.length ? batches : [[]];
}

function buildBatchPlan(plan: PlanIR, slides: PlanIR["slides"]): PlanIR {
  return {
    ...plan,
    pageCount: slides.length,
    slides
  };
}

function mergeStage2BatchResults(plan: PlanIR, batchContents: ContentIR[]): { ok: true; content: ContentIR } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const expectedIndexes = new Set(plan.slides.map((slide) => slide.slideIndex));
  const slidesByIndex = new Map<number, ContentIR["slides"][number]>();

  for (const content of batchContents) {
    if (content.templateId !== plan.templateId) {
      reasons.push(`batch content templateId must equal '${plan.templateId}'.`);
    }
    for (const slide of content.slides) {
      if (!expectedIndexes.has(slide.slideIndex)) {
        reasons.push(`unexpected content slide ${slide.slideIndex}.`);
        continue;
      }
      if (slidesByIndex.has(slide.slideIndex)) {
        reasons.push(`duplicate content slide ${slide.slideIndex}.`);
        continue;
      }
      slidesByIndex.set(slide.slideIndex, slide);
    }
  }

  const slides = plan.slides.map((planSlide) => {
    const slide = slidesByIndex.get(planSlide.slideIndex);
    if (!slide) {
      reasons.push(`missing content for slide ${planSlide.slideIndex}.`);
    }
    return slide;
  }).filter((slide): slide is ContentIR["slides"][number] => Boolean(slide));

  if (reasons.length) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    content: {
      templateId: plan.templateId,
      slides
    }
  };
}

function buildStage2ModelContentSchema(plan: PlanIR, manifest: TemplateManifestV2) {
  return z.preprocess(
    (raw) => normalizeStage2ModelOutput(raw, plan),
    contentIRSchema.superRefine((content, ctx) => {
      const slideByIndex = new Map(content.slides.map((slide, index) => [slide.slideIndex, { slide, index }]));
      for (const planSlide of plan.slides) {
        const contentSlide = slideByIndex.get(planSlide.slideIndex);
        if (!contentSlide) continue;
        const fragment = getFragment(manifest, planSlide);
        if (!fragment) continue;
        for (const anchor of fragment.anchors) {
          if (anchor.optional) continue;
          if (typeof contentSlide.slide.slotFills[anchor.slotId] !== "string") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["slides", contentSlide.index, "slotFills", anchor.slotId],
              message: `slide ${planSlide.slideIndex} missing required slot '${anchor.slotId}'.`
            });
          }
        }
      }
    })
  );
}

function normalizeStage2ModelOutput(raw: unknown, plan: PlanIR): unknown {
  if (Array.isArray(raw)) {
    return normalizeContentLike({ templateId: plan.templateId, slides: raw }, plan);
  }

  if (!isRecord(raw)) {
    return raw;
  }

  if (Array.isArray(raw.slides)) {
    return normalizeContentLike(raw, plan);
  }

  for (const key of ["contentIR", "content", "result", "output", "data"]) {
    const nested = raw[key];
    if (Array.isArray(nested) || isRecord(nested)) {
      const normalized = normalizeStage2ModelOutput(nested, plan);
      if (isRecord(normalized) && Array.isArray(normalized.slides)) {
        return normalized;
      }
    }
  }

  return raw;
}

function normalizeContentLike(raw: Record<string, unknown>, plan: PlanIR): unknown {
  const slides = Array.isArray(raw.slides) ? raw.slides : [];
  return {
    ...raw,
    templateId: typeof raw.templateId === "string" && raw.templateId.trim() ? raw.templateId : plan.templateId,
    slides: slides.map((slide, index) => normalizeSlideIdentity(slide, index, plan))
  };
}

function normalizeSlideIdentity(rawSlide: unknown, index: number, plan: PlanIR): unknown {
  if (!isRecord(rawSlide)) {
    return rawSlide;
  }

  const rawIndex = Number(rawSlide.slideIndex);
  const fallbackPlanSlide = plan.slides[index];
  const planSlide = Number.isInteger(rawIndex)
    ? plan.slides.find((slide) => slide.slideIndex === rawIndex) ?? fallbackPlanSlide
    : fallbackPlanSlide;

  if (!planSlide) {
    return rawSlide;
  }

  return {
    ...rawSlide,
    slideIndex: planSlide.slideIndex,
    fragmentId: planSlide.fragmentId,
    pageType: planSlide.pageType
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampContentToMaxChars(content: ContentIR, plan: PlanIR, manifest: TemplateManifestV2): ContentIR {
  const planByIndex = new Map(plan.slides.map((slide) => [slide.slideIndex, slide]));
  return {
    ...content,
    slides: content.slides.map((slide) => {
      const planSlide = planByIndex.get(slide.slideIndex);
      const fragment = getFragment(manifest, planSlide ?? slide);
      if (!fragment) return slide;
      const nextSlotFills: Record<string, string> = { ...slide.slotFills };
      for (const anchor of fragment.anchors) {
        const value = nextSlotFills[anchor.slotId];
        if (typeof value === "string" && value.length > anchor.maxChars) {
          nextSlotFills[anchor.slotId] = value.slice(0, anchor.maxChars);
        }
      }
      return { ...slide, slotFills: nextSlotFills };
    })
  };
}

function buildFallbackContent(plan: PlanIR, manifest: TemplateManifestV2): ContentIR {
  return {
    templateId: plan.templateId,
    slides: plan.slides.map((slide) => {
      const fragment = getFragment(manifest, slide);
      const slotFills: Record<string, string> = {};
      for (const anchor of fragment?.anchors ?? []) {
        slotFills[anchor.slotId] = fallbackSlotText(anchor.slotId, slide.slideTitle, anchor.maxChars);
      }

      return {
        slideIndex: slide.slideIndex,
        fragmentId: slide.fragmentId,
        pageType: slide.pageType,
        slotFills,
        chartDataBySlot: fragment?.chartSlots?.length
          ? Object.fromEntries(fragment.chartSlots.map((slot) => [
              slot.slotId,
              {
                type: slot.defaultRenderType,
                labels: ["现状", "推进", "优化", "成果"],
                datasets: [{ label: `${slide.slideTitle}-${slot.slotId}`, data: [35, 58, 76, 88] }]
              }
            ]))
          : undefined,
        chartData: slide.pageType === "chart" && !fragment?.chartSlots?.length
          ? {
              type: slide.chartType ?? "bar",
              labels: ["现状", "推进", "优化", "成果"],
              datasets: [{ label: slide.slideTitle, data: [35, 58, 76, 88] }]
            }
          : undefined,
        imageHints: fragment && (isImagePageType(slide.pageType) || fragmentHasMediaKind(fragment, "image"))
          ? slide.topicPoints.slice(0, 3)
          : undefined,
        videoHint: fragment && (isVideoPageType(slide.pageType) || fragmentHasMediaKind(fragment, "video"))
          ? slide.slideTitle
          : undefined
      };
    })
  };
}

function fallbackSlotText(slotId: string, title: string, maxChars: number): string {
  const text = slotId === "title"
    ? title
    : /(?:decorative|footer|meta|badge|label|section)/i.test(slotId)
      ? `${title.slice(0, 12)} // 2026`
    : slotId.includes("heading")
      ? "关键要点"
      : `${title} 的核心信息以简洁方式呈现，突出可执行判断。`;
  return text.slice(0, maxChars);
}

function getFragment(manifest: TemplateManifestV2, slide: { pageType: PageType; fragmentId?: string }): PageFragment | undefined {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}
