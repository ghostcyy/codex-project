import { z } from "zod";

export const PLAN_TONES = [
  "clinical",
  "playful",
  "editorial",
  "cyber",
  "enterprise",
  "documentary",
  "lifestyle",
  "energetic",
  "academic",
  "friendly"
] as const;

export const PLAN_FORMATS = [
  "live-talk",
  "pdf-handout",
  "xhs-image",
  "web-share",
  "keynote",
  "internal-memo"
] as const;

export const researchSchema = z.object({
  topicSummary: z.string().min(1).max(4000),
  keyFacts: z.array(z.string().min(1)).max(24),
  narrativeAngles: z.array(z.string().min(1)).max(16),
  suggestedSections: z.array(z.string().min(1)).max(16),
  needVerification: z.array(z.string().min(1)).max(16),
  suggestedSlideCount: z.number().int().min(1).max(30),
  perSlideLengthTargets: z.array(z.object({
    index: z.number().int().min(1).max(50),
    targetLength: z.number().int().min(1).max(4000),
    purpose: z.string().min(1).max(120)
  })).min(1).max(30)
});

export const planSchema = z.object({
  title: z.string().min(1).max(80),
  subtitle: z.string().max(200).optional(),
  slideCount: z.number().int().min(1).max(30),
  audience: z.string().min(1).max(200),
  tone: z.enum(PLAN_TONES),
  format: z.enum(PLAN_FORMATS),
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

export const sectionContentSchema = z.object({
  slides: z.array(z.object({
    index: z.number().int().min(1).max(50),
    title: z.string().min(1).max(120),
    layoutId: z.string().min(1).max(80),
    kicker: z.string().max(80).optional(),
    h1: z.string().max(120).optional(),
    h2: z.string().max(120).optional(),
    lede: z.string().max(260).optional(),
    bullets: z.array(z.string().min(1).max(180)).max(10).default([]),
    cards: z.array(z.object({
      title: z.string().min(1).max(80),
      body: z.string().min(1).max(220),
      tag: z.string().max(40).optional()
    })).max(8).default([]),
    metrics: z.array(z.object({
      label: z.string().min(1).max(60),
      value: z.string().min(1).max(40),
      note: z.string().max(120).optional()
    })).max(8).default([]),
    footer: z.string().max(100).optional()
  })).min(1).max(8)
});

export const structuredOutputSchemaHints = {
  research: [
    "Return one JSON object only.",
    "Schema:",
    '{ "topicSummary": "string", "keyFacts": ["string"], "narrativeAngles": ["string"], "suggestedSections": ["string"], "needVerification": ["string"], "suggestedSlideCount": 8, "perSlideLengthTargets": [{ "index": 1, "targetLength": 80, "purpose": "opening hook" }] }'
  ].join("\n"),
  plan: [
    "Return one JSON object only.",
    "Schema:",
    '{ "title": "string", "subtitle": "string?", "slideCount": 8, "audience": "string", "tone": "clinical|playful|editorial|cyber|enterprise|documentary|lifestyle|energetic|academic|friendly", "format": "live-talk|pdf-handout|xhs-image|web-share|keynote|internal-memo", "objective": "string", "slides": [{ "index": 1, "title": "string", "type": "string", "layoutId": "string", "goal": "string", "keyPoints": ["string"] }] }'
  ].join("\n"),
  visual: [
    "Return one JSON object only.",
    "Schema:",
    '{ "primaryTheme": "string", "backupThemes": ["string"], "referenceTemplates": ["string"], "deckClass": "string", "visualLanguage": "string", "slideVisuals": [{ "index": 1, "composition": "string", "animation": "string?", "fx": "string?" }] }'
  ].join("\n"),
  sectionContent: [
    "Return one JSON object only.",
    "Schema:",
    '{ "slides": [{ "index": 1, "title": "string", "layoutId": "string", "kicker": "string?", "h1": "string?", "h2": "string?", "lede": "string?", "bullets": ["string"], "cards": [{ "title": "string", "body": "string", "tag": "string?" }], "metrics": [{ "label": "string", "value": "string", "note": "string?" }], "footer": "string?" }] }'
  ].join("\n")
};

export type ResearchSchema = z.infer<typeof researchSchema>;
export type PlanSchema = z.infer<typeof planSchema>;
export type VisualSchema = z.infer<typeof visualSchema>;
export type SectionContentSchema = z.infer<typeof sectionContentSchema>;
