import { z } from "zod";
import { generateRequestSchema, type GenerateRequest } from "../shared";

export const pptV3NaturalLanguageParseSchema = z.preprocess(normalizeIntentParsePayload, z.object({
  schemaVersion: z.literal("html-ppt-v3.intent.v1").optional(),
  action: z.literal("generate_deck").optional(),
  status: z.enum(["complete", "needs_clarification", "unsupported"]).default("complete"),
  deck: z.object({
    contentTheme: z.string().trim().min(1).nullable().optional(),
    title: z.string().trim().min(1).nullable().optional(),
    pageCount: z.number().int().nullable().optional(),
    wordBudget: z.number().int().nullable().optional(),
    audience: z.string().trim().min(1).nullable().optional(),
    purpose: z.string().trim().min(1).nullable().optional(),
    tone: z.string().trim().min(1).nullable().optional(),
    mustInclude: z.array(z.string()).optional().default([]),
    mustAvoid: z.array(z.string()).optional().default([])
  }).optional(),
  quality: z.object({
    confidence: z.number().min(0).max(1).nullable().optional(),
    missingFields: z.array(z.string()).optional(),
    ambiguities: z.array(z.string()).optional()
  }).optional(),
  extensions: z.record(z.string(), z.unknown()).optional()
}));

export type PptV3NaturalLanguageParse = z.infer<typeof pptV3NaturalLanguageParseSchema>;

export type MissingGenerateField =
  | "theme"
  | "pageCount"
  | "wordBudget"
  | "templateId"
  | "includeImages"
  | "includeVideo"
  | "includeChart"
  | "includeAudio";

export type PptV3ParsedMessage =
  | {
      ok: true;
      request: GenerateRequest;
      source: "metadata" | "llm" | "fallback" | "mixed";
      partialRequest: Partial<GenerateRequest>;
    }
  | {
      ok: false;
      missingFields: MissingGenerateField[];
      issues: string[];
      clarification: string;
      source: "metadata" | "llm" | "fallback" | "mixed";
      partialRequest: Partial<GenerateRequest>;
    };

const MEDIA_FIELDS = ["includeImages", "includeVideo", "includeChart", "includeAudio"] as const;
type MediaField = (typeof MEDIA_FIELDS)[number];

type ExtractedRequest = Partial<GenerateRequest> & {
  explicitMediaFields: Partial<Record<MediaField, true>>;
  forcedMissingFields?: MissingGenerateField[];
  used: boolean;
};

export function parsePptV3MessageRequest(input: {
  content: string;
  metadata: Record<string, unknown>;
  projectSelectedTemplateId?: string | null;
  llmParse?: PptV3NaturalLanguageParse | null;
}): PptV3ParsedMessage {
  const metadata = extractMetadataRequest(input.metadata);
  const llm = extractLlmRequest(input.llmParse);
  const theme = firstString(llm.theme);

  const partialRequest: Partial<GenerateRequest> = {
    theme: theme ? cleanTheme(theme) : undefined,
    pageCount: llm.pageCount,
    wordBudget: llm.wordBudget,
    templateId: firstString(
      metadata.templateId,
      input.projectSelectedTemplateId ?? undefined
    )
  };

  for (const field of MEDIA_FIELDS) {
    const value = metadata[field];
    if (value !== undefined) {
      partialRequest[field] = value;
    }
  }

  const missingFields = uniqueMissingFields([
    ...findMissingFields(partialRequest, metadata.explicitMediaFields),
    ...(llm.forcedMissingFields ?? [])
  ]);
  const source = resolveSource(metadata.used, llm.used, false);

  if (missingFields.length > 0) {
    return {
      ok: false,
      missingFields,
      issues: missingFields.map((field) => `${field} is required`),
      clarification: buildClarification(missingFields),
      source,
      partialRequest
    };
  }

  const parsed = generateRequestSchema.safeParse(partialRequest);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return {
      ok: false,
      missingFields: [],
      issues,
      clarification: `I need a valid generation request before starting. Please fix: ${issues.join("; ")}.`,
      source,
      partialRequest
    };
  }

  return {
    ok: true,
    request: parsed.data,
    source,
    partialRequest: parsed.data
  };
}

function extractMetadataRequest(metadata: Record<string, unknown>): ExtractedRequest {
  const media = asRecord(metadata.media) ?? asRecord(metadata.mediaChoices) ?? {};
  const extracted: ExtractedRequest = { explicitMediaFields: {}, used: false };

  extracted.templateId = stringValue(metadata.templateId) ?? stringValue(metadata.selectedTemplateId);

  setMetadataMedia(extracted, "includeImages", metadata.includeImages, metadata.wantsImageSlides, media.includeImages, media.images);
  setMetadataMedia(extracted, "includeVideo", metadata.includeVideo, metadata.wantsVideoSlides, media.includeVideo, media.video);
  setMetadataMedia(extracted, "includeChart", metadata.includeChart, metadata.wantsChartSlides, media.includeChart, media.chart);
  setMetadataMedia(extracted, "includeAudio", metadata.includeAudio, metadata.wantsAudioSlides, media.includeAudio, media.audio);

  extracted.used = Object.keys(extracted).some((key) => key !== "explicitMediaFields" && key !== "used" && extracted[key as keyof ExtractedRequest] !== undefined);
  return extracted;
}

function normalizeIntentParsePayload(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const deckSource = asRecord(record.deck) ?? record;
  const qualitySource = asRecord(record.quality) ?? record;
  const missingFields = arrayOfStrings(qualitySource.missingFields);
  const ambiguities = arrayOfStrings(qualitySource.ambiguities);
  return {
    ...record,
    schemaVersion: stringValue(record.schemaVersion) ?? "html-ppt-v3.intent.v1",
    action: stringValue(record.action) ?? "generate_deck",
    status: normalizeIntentStatus(record.status, record.needs_clarification, missingFields),
    deck: {
      ...(asRecord(record.deck) ?? {}),
      contentTheme: firstString(
        stringValue(deckSource.contentTheme),
        stringValue(deckSource.theme),
        stringValue(deckSource.topic),
        stringValue(deckSource.title)
      ) ?? null,
      title: firstString(
        stringValue(deckSource.title),
        stringValue(deckSource.contentTheme),
        stringValue(deckSource.theme),
        stringValue(deckSource.topic)
      ) ?? null,
      pageCount: numberValue(deckSource.pageCount) ?? numberValue(deckSource.pages) ?? numberValue(deckSource.slideCount) ?? null,
      wordBudget: numberValue(deckSource.wordBudget) ?? numberValue(deckSource.totalWordBudget) ?? numberValue(deckSource.charCount) ?? numberValue(deckSource.words) ?? null,
      audience: normalizeOptionalIntentString(deckSource.audience),
      purpose: normalizeOptionalIntentString(deckSource.purpose),
      tone: normalizeOptionalIntentString(deckSource.tone),
      mustInclude: arrayOfStrings(deckSource.mustInclude),
      mustAvoid: arrayOfStrings(deckSource.mustAvoid)
    },
    quality: {
      ...(asRecord(record.quality) ?? {}),
      confidence: numberValue(qualitySource.confidence) ?? null,
      missingFields,
      ambiguities
    }
  };
}

function normalizeIntentStatus(status: unknown, needsClarification: unknown, missingFields: string[]): "complete" | "needs_clarification" | "unsupported" {
  const normalized = stringValue(status)?.toLowerCase();
  if (normalized === "needs_clarification" || normalized === "clarification" || booleanValue(needsClarification) === true || missingFields.length > 0) {
    return "needs_clarification";
  }
  if (normalized === "unsupported") return "unsupported";
  if (normalized === "complete" || normalized === "ready" || normalized === "ok" || normalized === "success" || !normalized) {
    return "complete";
  }
  return "needs_clarification";
}

function normalizeOptionalIntentString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const joined = value.map(stringValue).filter((entry): entry is string => Boolean(entry)).join("、");
    return joined || null;
  }
  return stringValue(value) ?? null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter((entry): entry is string => Boolean(entry));
}

function extractLlmRequest(parse?: PptV3NaturalLanguageParse | null): ExtractedRequest {
  if (!parse) return { explicitMediaFields: {}, used: false };
  const deck = (parse.deck ?? {}) as NonNullable<PptV3NaturalLanguageParse["deck"]>;
  const normalizedMissingFields = normalizeIntentMissingFields(parse.quality?.missingFields ?? []);
  const forcedMissingFields: MissingGenerateField[] = parse.status === "complete"
    ? []
    : (normalizedMissingFields.length > 0 ? normalizedMissingFields : ["theme", "pageCount", "wordBudget"]);
  const extracted: ExtractedRequest = {
    explicitMediaFields: {},
    forcedMissingFields,
    used: true,
    theme: stringValue(deck.contentTheme) ?? stringValue(deck.title),
    pageCount: numberValue(deck.pageCount),
    wordBudget: numberValue(deck.wordBudget)
  };

  return extracted;
}

function extractFallbackRequest(content: string): ExtractedRequest {
  const extracted: ExtractedRequest = {
    explicitMediaFields: {},
    used: false,
    theme: extractTheme(content),
    pageCount: extractCount(content, [
      /(?:pageCount|pages?|slides?|页数|页|张)\s*[:：=]?\s*(\d{1,2})/i,
      /(\d{1,2})\s*(?:pages?|slides?|页|张)/i
    ]),
    wordBudget: extractCount(content, [
      /(?:wordBudget|words?|字数|字|字符|charCount)\s*[:：=]?\s*(\d+(?:\.\d+)?\s*[kK]?)/i,
      /(\d+(?:\.\d+)?\s*[kK]?)\s*(?:words?|字|字符|chars?|characters?)/i
    ]),
    templateId: extractTemplateId(content)
  };

  setFallbackMedia(extracted, "includeImages", detectMedia(content, {
    positive: [/(?:需要|包含|使用|要|加|带).{0,8}(?:图片|图像|配图)/, /\b(?:with|include|use|add|enable)\s+(?:images?|photos?|illustrations?)\b/i],
    negative: [/(?:不要|不需要|无|不用|禁用).{0,8}(?:图片|图像|配图)/, /\b(?:no|without|disable|exclude)\s+(?:images?|photos?|illustrations?)\b/i]
  }));
  setFallbackMedia(extracted, "includeVideo", detectMedia(content, {
    positive: [/(?:需要|包含|使用|要|加|带).{0,8}(?:视频|影片)/, /\b(?:with|include|use|add|enable)\s+(?:videos?)\b/i],
    negative: [/(?:不要|不需要|无|不用|禁用).{0,8}(?:视频|影片)/, /\b(?:no|without|disable|exclude)\s+(?:videos?)\b/i]
  }));
  setFallbackMedia(extracted, "includeChart", detectMedia(content, {
    positive: [/(?:需要|包含|使用|要|加|带).{0,8}(?:图表|数据图|chart)/i, /\b(?:with|include|use|add|enable)\s+(?:charts?|graphs?)\b/i],
    negative: [/(?:不要|不需要|无|不用|禁用).{0,8}(?:图表|数据图|chart)/i, /\b(?:no|without|disable|exclude)\s+(?:charts?|graphs?)\b/i]
  }));
  setFallbackMedia(extracted, "includeAudio", detectMedia(content, {
    positive: [/(?:需要|包含|使用|要|加|带).{0,8}(?:音频|音效|配音)/, /\b(?:with|include|use|add|enable)\s+(?:audio|sound|voiceover)\b/i],
    negative: [/(?:不要|不需要|无|不用|禁用).{0,8}(?:音频|音效|配音)/, /\b(?:no|without|disable|exclude)\s+(?:audio|sound|voiceover)\b/i]
  }));

  extracted.used = Object.keys(extracted).some((key) => key !== "explicitMediaFields" && key !== "used" && extracted[key as keyof ExtractedRequest] !== undefined);
  return extracted;
}

function extractTheme(content: string): string | undefined {
  const explicit = [
    /(?:内容主题|主题|题目|标题|内容)\s*(?:为|是|[:：])\s*["“]?([^。；;\n.，,"]+)/i,
    /\b(?:theme|topic|title)\s*[:=]\s*["“]?([^.;\n"]+)/i,
    /\b(?:about|on|regarding)\s+([^.;\n]+)/i
  ];
  for (const pattern of explicit) {
    const match = content.match(pattern)?.[1]?.trim();
    if (match) return cleanTheme(match);
  }

  const cleaned = cleanTheme(
    content
      .replace(/(?:请|帮我|生成|制作|做一份|做一个|一份|一个|PPT|ppt|幻灯片|presentation|deck|slides?)/gi, " ")
      .replace(/(?:pageCount|pages?|slides?|页数|页|张)\s*[:：=]?\s*\d{1,2}/gi, " ")
      .replace(/\d{1,2}\s*(?:pages?|slides?|页|张)/gi, " ")
      .replace(/(?:wordBudget|words?|字数|字|字符|charCount)\s*[:：=]?\s*\d+(?:\.\d+)?\s*[kK]?/gi, " ")
      .replace(/\d+(?:\.\d+)?\s*[kK]?\s*(?:words?|字|字符|chars?|characters?)/gi, " ")
      .replace(/(?:模板|templateId|template)\s*[:：=]?\s*[a-z0-9][a-z0-9_-]*/gi, " ")
      .replace(/(?:需要|包含|使用|要|加|带|不要|不需要|无|不用|禁用).{0,8}(?:图片|图像|配图|视频|影片|图表|数据图|音频|音效|配音)/gi, " ")
      .replace(/\b(?:with|include|use|add|enable|no|without|disable|exclude)\s+(?:images?|photos?|illustrations?|videos?|charts?|graphs?|audio|sound|voiceover)\b/gi, " ")
  );
  return cleaned || undefined;
}

function extractTemplateId(content: string): string | undefined {
  return stringValue(
    content.match(/(?:模板|templateId|template)\s*[:：=]?\s*([a-z0-9][a-z0-9_-]*)/i)?.[1] ??
      content.match(/\busing\s+([a-z0-9][a-z0-9_-]*\d[a-z0-9_-]*)\b/i)?.[1]
  );
}

function extractCount(content: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const raw = content.match(pattern)?.[1];
    const value = numberValue(raw);
    if (value !== undefined) return value;
  }
  return undefined;
}

function detectMedia(content: string, patterns: { positive: RegExp[]; negative: RegExp[] }): boolean | undefined {
  if (patterns.negative.some((pattern) => pattern.test(content))) return false;
  if (patterns.positive.some((pattern) => pattern.test(content))) return true;
  return undefined;
}

function setMetadataMedia(extracted: ExtractedRequest, field: MediaField, ...candidates: unknown[]) {
  const value = candidates.map(booleanValue).find((candidate) => candidate !== undefined);
  if (value === undefined) return;
  extracted[field] = value;
  extracted.explicitMediaFields[field] = true;
}

function setFallbackMedia(extracted: ExtractedRequest, field: MediaField, value: boolean | undefined) {
  if (value === undefined) return;
  extracted[field] = value;
  extracted.explicitMediaFields[field] = true;
}

function findMissingFields(
  request: Partial<GenerateRequest>,
  ...mediaSources: Array<Partial<Record<MediaField, true>>>
): MissingGenerateField[] {
  const missing: MissingGenerateField[] = [];
  if (!request.theme?.trim()) missing.push("theme");
  if (request.pageCount === undefined) missing.push("pageCount");
  if (request.wordBudget === undefined) missing.push("wordBudget");
  if (!request.templateId?.trim()) missing.push("templateId");

  for (const field of MEDIA_FIELDS) {
    const explicit = mediaSources.some((source) => source[field]);
    if (!explicit || typeof request[field] !== "boolean") {
      missing.push(field);
    }
  }
  return missing;
}

function buildClarification(missingFields: MissingGenerateField[]) {
  return [
    "I need a few details before creating the deck job.",
    `Missing fields: ${missingFields.join(", ")}.`,
    "Please provide theme, pageCount, wordBudget, templateId, and explicit true/false choices for images, video, charts, and audio."
  ].join(" ");
}

function normalizeIntentMissingFields(fields: string[]): MissingGenerateField[] {
  const normalized: MissingGenerateField[] = [];
  for (const field of fields) {
    const key = field.trim();
    if (key === "contentTheme" || key === "theme" || key === "title") normalized.push("theme");
    if (key === "pageCount" || key === "pages" || key === "slides") normalized.push("pageCount");
    if (key === "wordBudget" || key === "words" || key === "charCount") normalized.push("wordBudget");
    if (key === "templateId" || key === "template") normalized.push("templateId");
  }
  return uniqueMissingFields(normalized);
}

function uniqueMissingFields(fields: MissingGenerateField[]): MissingGenerateField[] {
  return [...new Set(fields)];
}

function resolveSource(metadataUsed: boolean, llmUsed: boolean, fallbackUsed: boolean): "metadata" | "llm" | "fallback" | "mixed" {
  if (llmUsed) return "llm";
  if (metadataUsed) return "metadata";
  if (fallbackUsed) return "fallback";
  return "fallback";
}

function firstString(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function firstBoolean(...values: Array<boolean | undefined>): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*k?$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isFinite(number) ? Math.round(normalized.endsWith("k") ? number * 1000 : number) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "on", "include", "需要", "要"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "off", "exclude", "不要", "不需要", "无"].includes(normalized)) return false;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanTheme(value: string): string {
  const normalized = value
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/^(?:请|帮我|生成|制作|做一份|做一个|一份|一个)\s*/gi, "")
    .replace(/^\d{1,2}\s*(?:页|张|pages?|slides?)\s*/gi, "")
    .replace(/^(?:HTML\s*)?(?:PPT|ppt|报告|幻灯片|presentation|deck|slides?)\s*/gi, "")
    .replace(/^(?:主题|题目|标题|内容主题|内容)\s*(?:为|是|[:：])\s*/gi, "")
    .replace(/(?:，|,)?\s*(?:约|大约|左右)?\s*\d+(?:\.\d+)?\s*[kK]?\s*(?:字|字符|words?|chars?|characters?).*$/i, "")
    .replace(/(?:，|,)?\s*(?:面向|包含|包括|要求|需要|不要|不需要|使用模板|模板).*$/i, "")
    .replace(/(?:，|,)?\s*(?:for|about|with|including|include|requires?|template)\b.*$/i, "");
  return normalized
    .replace(/[。；;,.，、]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
