import { buildStage21SpeakerNotesPrompt } from "../prompts/stage2_1-speaker-notes.prompt";
import {
  speakerNotesIRSchema,
  validateSpeakerNotesIR,
  type ContentIR,
  type GenerateRequest,
  type PlanIR,
  type SpeakerNotesIR
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

export type Stage21SpeakerNotesInput = {
  request: GenerateRequest;
  plan: PlanIR;
  content: ContentIR;
  llm: HtmlPptV3LLMClient;
};

export type Stage21SpeakerNotesResult = {
  requested: boolean;
  source: "model" | "skipped" | "failed";
  speakerNotes?: SpeakerNotesIR;
  warnings: string[];
  batchCount: number;
};

const STAGE21_BATCH_SIZE = 7;

export async function runStage21SpeakerNotes(input: Stage21SpeakerNotesInput): Promise<Stage21SpeakerNotesResult> {
  if (!input.request.includeSpeakerNotes) {
    return { requested: false, source: "skipped", warnings: [], batchCount: 0 };
  }

  const batches = splitPlanSlidesForStage21(input.plan, STAGE21_BATCH_SIZE);
  const warnings: string[] = [];

  try {
    const batchResults = await Promise.all(batches.map((batchSlides, index) => runStage21SpeakerNotesBatch({
      ...input,
      batchSlides,
      batchIndex: index + 1,
      totalBatches: batches.length
    })));
    warnings.push(...batchResults.flatMap((result) => result.warnings));
    const merged = mergeSpeakerNotesBatchResults(input.plan, batchResults.map((result) => result.speakerNotes));
    if (!merged.ok) {
      return {
        requested: true,
        source: "failed",
        warnings: [...warnings, ...merged.reasons],
        batchCount: batches.length
      };
    }

    const validation = validateSpeakerNotesIR(merged.speakerNotes, input.plan);
    if (!validation.ok) {
      return {
        requested: true,
        source: "failed",
        warnings: [...warnings, ...validation.reasons],
        batchCount: batches.length
      };
    }

    return {
      requested: true,
      source: "model",
      speakerNotes: merged.speakerNotes,
      warnings,
      batchCount: batches.length
    };
  } catch (error) {
    return {
      requested: true,
      source: "failed",
      warnings: [error instanceof Error ? error.message : String(error)],
      batchCount: batches.length
    };
  }
}

async function runStage21SpeakerNotesBatch(input: Stage21SpeakerNotesInput & {
  batchSlides: PlanIR["slides"];
  batchIndex: number;
  totalBatches: number;
}): Promise<{ speakerNotes: SpeakerNotesIR; warnings: string[] }> {
  const warnings: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildStage21SpeakerNotesPrompt({
      request: input.request,
      plan: input.plan,
      content: input.content,
      batchSlides: input.batchSlides,
      batchIndex: input.batchIndex,
      totalBatches: input.totalBatches,
      previousError: warnings.at(-1)
    });

    try {
      const candidate = await input.llm.callStructured({
        stage: "v3-stage2_1-speaker-notes",
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        schema: speakerNotesIRSchema,
        temperature: attempt === 1 ? 0.2 : 0,
        retries: 1
      });
      const batchPlan = buildBatchPlan(input.plan, input.batchSlides);
      const validation = validateSpeakerNotesIR(candidate, batchPlan);
      if (validation.ok) {
        return { speakerNotes: candidate, warnings };
      }
      warnings.push(`batch ${input.batchIndex}/${input.totalBatches}: ${validation.reasons.join("; ")}`);
    } catch (error) {
      warnings.push(`batch ${input.batchIndex}/${input.totalBatches}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(warnings.join(" | "));
}

function splitPlanSlidesForStage21(plan: PlanIR, batchSize: number): Array<PlanIR["slides"]> {
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

function mergeSpeakerNotesBatchResults(plan: PlanIR, batchResults: SpeakerNotesIR[]): { ok: true; speakerNotes: SpeakerNotesIR } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const expectedIndexes = new Set(plan.slides.map((slide) => slide.slideIndex));
  const slidesByIndex = new Map<number, SpeakerNotesIR["slides"][number]>();

  for (const speakerNotes of batchResults) {
    if (speakerNotes.templateId !== plan.templateId) {
      reasons.push(`batch speaker notes templateId must equal '${plan.templateId}'.`);
    }
    for (const slide of speakerNotes.slides) {
      if (!expectedIndexes.has(slide.slideIndex)) {
        reasons.push(`unexpected speaker notes slide ${slide.slideIndex}.`);
        continue;
      }
      if (slidesByIndex.has(slide.slideIndex)) {
        reasons.push(`duplicate speaker notes slide ${slide.slideIndex}.`);
        continue;
      }
      slidesByIndex.set(slide.slideIndex, slide);
    }
  }

  const slides = plan.slides.map((planSlide) => {
    const slide = slidesByIndex.get(planSlide.slideIndex);
    if (!slide) {
      reasons.push(`missing speaker notes for slide ${planSlide.slideIndex}.`);
    }
    return slide;
  }).filter((slide): slide is SpeakerNotesIR["slides"][number] => Boolean(slide));

  if (reasons.length) return { ok: false, reasons };
  return { ok: true, speakerNotes: { templateId: plan.templateId, slides } };
}
