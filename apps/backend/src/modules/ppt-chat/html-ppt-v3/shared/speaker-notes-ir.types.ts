import { z } from "zod";
import { PAGE_TYPES } from "./manifest-v2.types";
import type { PlanIR } from "./plan-ir.types";

export const speakerNoteSlideSchema = z.object({
  slideIndex: z.number().int().min(1),
  fragmentId: z.string().min(1).optional(),
  pageType: z.enum(PAGE_TYPES),
  notes: z.array(z.string().trim().min(1).max(600)).min(1).max(4)
});
export type SpeakerNoteSlide = z.infer<typeof speakerNoteSlideSchema>;

export const speakerNotesIRSchema = z.object({
  templateId: z.string().min(1),
  slides: z.array(speakerNoteSlideSchema)
});
export type SpeakerNotesIR = z.infer<typeof speakerNotesIRSchema>;

export function validateSpeakerNotesIR(
  speakerNotes: SpeakerNotesIR,
  plan: PlanIR
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (speakerNotes.templateId !== plan.templateId) {
    reasons.push(`templateId must equal plan templateId '${plan.templateId}'.`);
  }
  if (speakerNotes.slides.length !== plan.slides.length) {
    reasons.push(`slides length must equal plan slides length ${plan.slides.length}.`);
  }

  const notesByIndex = new Map(speakerNotes.slides.map((slide) => [slide.slideIndex, slide]));
  for (const planSlide of plan.slides) {
    const notesSlide = notesByIndex.get(planSlide.slideIndex);
    if (!notesSlide) {
      reasons.push(`missing speaker notes for slide ${planSlide.slideIndex}.`);
      continue;
    }
    if (notesSlide.pageType !== planSlide.pageType) {
      reasons.push(`slide ${planSlide.slideIndex} pageType must be '${planSlide.pageType}'.`);
    }
    if (planSlide.fragmentId && notesSlide.fragmentId !== planSlide.fragmentId) {
      reasons.push(`slide ${planSlide.slideIndex} fragmentId must be '${planSlide.fragmentId}'.`);
    }
    if (notesSlide.notes.some((note) => /<[^>]+>/.test(note))) {
      reasons.push(`slide ${planSlide.slideIndex} speaker notes must be plain text, not HTML.`);
    }
  }

  const expectedIndexes = new Set(plan.slides.map((slide) => slide.slideIndex));
  for (const notesSlide of speakerNotes.slides) {
    if (!expectedIndexes.has(notesSlide.slideIndex)) {
      reasons.push(`unexpected speaker notes slide ${notesSlide.slideIndex}.`);
    }
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}
