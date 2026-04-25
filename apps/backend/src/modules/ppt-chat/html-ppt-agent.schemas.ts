import { z } from "zod";

export const researchSchema = z.object({
  topicSummary: z.string().min(1).max(4000),
  keyFacts: z.array(z.string().min(1)).max(24),
  narrativeAngles: z.array(z.string().min(1)).max(16),
  suggestedSections: z.array(z.string().min(1)).max(16),
  needVerification: z.array(z.string().min(1)).max(16)
});

export const planSchema = z.object({
  title: z.string().min(1).max(80),
  subtitle: z.string().max(200).optional(),
  slideCount: z.number().int().min(1).max(30),
  audience: z.string().min(1).max(200),
  objective: z.string().min(1).max(300),
  slides: z.array(z.object({
    index: z.number().int().min(1).max(50),
    title: z.string().min(1).max(120),
    type: z.string().min(1).max(60),
    layoutId: z.string().min(1).max(80),
    goal: z.string().max(300).default(""),
    keyPoints: z.array(z.string().min(1).max(300)).max(20)
  })).min(1).max(30)
});

export const visualSchema = z.object({
  primaryTheme: z.string().min(1).max(120),
  backupThemes: z.array(z.string().min(1).max(120)).max(12),
  referenceTemplates: z.array(z.string().min(1).max(120)).max(8),
  deckClass: z.string().min(1).max(120),
  visualLanguage: z.string().min(1).max(300),
  slideVisuals: z.array(z.object({
    index: z.number().int().min(1).max(50),
    composition: z.string().min(1).max(240),
    animation: z.string().max(120).optional(),
    fx: z.string().max(120).optional()
  })).max(30)
});

export const structuredOutputSchemaHints = {
  research: [
    "Return one JSON object only.",
    "Schema:",
    '{ "topicSummary": "string", "keyFacts": ["string"], "narrativeAngles": ["string"], "suggestedSections": ["string"], "needVerification": ["string"] }'
  ].join("\n"),
  plan: [
    "Return one JSON object only.",
    "Schema:",
    '{ "title": "string", "subtitle": "string?", "slideCount": 8, "audience": "string", "objective": "string", "slides": [{ "index": 1, "title": "string", "type": "string", "layoutId": "string", "goal": "string", "keyPoints": ["string"] }] }'
  ].join("\n"),
  visual: [
    "Return one JSON object only.",
    "Schema:",
    '{ "primaryTheme": "string", "backupThemes": ["string"], "referenceTemplates": ["string"], "deckClass": "string", "visualLanguage": "string", "slideVisuals": [{ "index": 1, "composition": "string", "animation": "string?", "fx": "string?" }] }'
  ].join("\n")
};

export type ResearchSchema = z.infer<typeof researchSchema>;
export type PlanSchema = z.infer<typeof planSchema>;
export type VisualSchema = z.infer<typeof visualSchema>;
