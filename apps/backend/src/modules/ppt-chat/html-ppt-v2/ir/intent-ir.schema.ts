import { z } from "zod";
import { audienceSchema, formatSchema, languageSchema, toneSchema } from "./enums";
import { nonEmptyString, shortText } from "./shared";

export const intentIrSchema = z.object({
  topic: nonEmptyString.max(240),
  language: languageSchema,
  audience: audienceSchema,
  tone: toneSchema,
  format: formatSchema,
  hardConstraints: z.object({
    slideCount: z.number().int().min(1).max(50).optional(),
    narrativeChars: z.number().int().min(100).max(50000).optional(),
    requiredSections: z.array(shortText).max(30).default([])
  }).strict(),
  preferences: z.object({
    aestheticHints: z.array(shortText).max(20).default([]),
    forbiddenThemes: z.array(shortText).max(20).default([]),
    domainTerminology: z.array(shortText).max(40).default([]),
    knowledgeCutoffWarning: z.boolean()
  }).strict(),
  derivedSlideCount: z.number().int().min(1).max(50),
  derivedNarrativeChars: z.number().int().min(100).max(50000)
}).strict().superRefine((value, ctx) => {
  if (value.hardConstraints.slideCount !== undefined && value.derivedSlideCount !== value.hardConstraints.slideCount) {
    ctx.addIssue({
      code: "custom",
      path: ["derivedSlideCount"],
      message: "derivedSlideCount must equal hardConstraints.slideCount when the user requested an exact slide count."
    });
  }

  if (value.hardConstraints.narrativeChars !== undefined && value.derivedNarrativeChars < value.hardConstraints.narrativeChars) {
    ctx.addIssue({
      code: "custom",
      path: ["derivedNarrativeChars"],
      message: "derivedNarrativeChars must satisfy the requested narrative minimum."
    });
  }
});

export type IntentIR = z.infer<typeof intentIrSchema>;
