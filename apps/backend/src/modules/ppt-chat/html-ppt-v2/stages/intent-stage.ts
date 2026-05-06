import { buildIntentPrompt } from "../prompts";
import {
  intentIrSchema,
  type AudienceId,
  type FormatId,
  type IntentIR,
  type LanguageId,
  type ToneId
} from "../ir";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

export type IntentStageInput = {
  userPrompt: string;
  conversationContext?: string[];
  userPreferences?: Record<string, unknown>;
  model?: JsonOnlyModelClient;
};

export type IntentStageResult = {
  intent: IntentIR;
  source: "model" | "fallback";
  attempts: number;
  validationErrors: string[];
  deterministicHints: Partial<IntentIR>;
};

export async function runIntentStage(input: IntentStageInput): Promise<IntentStageResult> {
  const deterministicHints = buildDeterministicIntentHints(input.userPrompt);
  const validationErrors: string[] = [];

  if (input.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildIntentPrompt({
        userPrompt: input.userPrompt,
        conversationContext: input.conversationContext,
        userPreferences: input.userPreferences,
        deterministicHints,
        validationError: validationErrors.at(-1)
      });

      const raw = await input.model.completeJson({
        stage: "01-intent",
        system: prompt.system,
        user: prompt.user,
        temperature: 0
      });
      const candidate = normalizeModelIntentCandidate(raw, deterministicHints);
      const parsed = intentIrSchema.safeParse(candidate);

      if (parsed.success) {
        return {
          intent: parsed.data,
          source: "model",
          attempts: attempt,
          validationErrors,
          deterministicHints
        };
      }

      validationErrors.push(formatZodError(parsed.error));
    }
  }

  const fallback = intentIrSchema.parse(buildFallbackIntent(input.userPrompt, deterministicHints));
  return {
    intent: fallback,
    source: "fallback",
    attempts: input.model ? 2 : 0,
    validationErrors,
    deterministicHints
  };
}

export function buildDeterministicIntentHints(userPrompt: string): Partial<IntentIR> {
  const slideCount = extractNumberNear(userPrompt, [
    /(\d{1,2})\s*(?:页|张|页ppt|张ppt|slides?|pages?)/i,
    /(?:制作|生成|做|create|make)\D{0,12}(\d{1,2})\D{0,8}(?:ppt|slides?|deck|幻灯片)/i
  ]);
  const narrativeChars = extractNumberNear(userPrompt, [
    /(\d{3,5})\s*(?:字|中文字|汉字|words?|characters?|chars?)/i,
    /(?:大约|约|不少于|至少|around|about|at least)\D{0,8}(\d{3,5})/i
  ]);
  const language = inferLanguage(userPrompt);

  return {
    language,
    hardConstraints: {
      ...(slideCount ? { slideCount } : {}),
      ...(narrativeChars ? { narrativeChars } : {}),
      requiredSections: extractRequiredSections(userPrompt)
    },
    preferences: {
      aestheticHints: extractAestheticHints(userPrompt),
      forbiddenThemes: extractForbiddenThemes(userPrompt),
      domainTerminology: extractQuotedTerms(userPrompt),
      knowledgeCutoffWarning: hasTimeSensitiveSignal(userPrompt)
    },
    derivedSlideCount: slideCount ?? inferSlideCount(userPrompt),
    derivedNarrativeChars: narrativeChars ?? inferNarrativeChars(slideCount ?? inferSlideCount(userPrompt), language)
  };
}

function normalizeModelIntentCandidate(raw: unknown, deterministicHints: Partial<IntentIR>): unknown {
  const value = parseJsonLike(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Partial<IntentIR>;
  const hardConstraints = {
    requiredSections: [],
    ...(candidate.hardConstraints ?? {}),
    ...(deterministicHints.hardConstraints?.slideCount ? { slideCount: deterministicHints.hardConstraints.slideCount } : {}),
    ...(deterministicHints.hardConstraints?.narrativeChars ? { narrativeChars: deterministicHints.hardConstraints.narrativeChars } : {})
  };
  const preferences = {
    aestheticHints: [],
    forbiddenThemes: [],
    domainTerminology: [],
    knowledgeCutoffWarning: false,
    ...(candidate.preferences ?? {}),
    ...(deterministicHints.preferences?.knowledgeCutoffWarning !== undefined
      ? { knowledgeCutoffWarning: deterministicHints.preferences.knowledgeCutoffWarning }
      : {})
  };

  return {
    ...candidate,
    language: deterministicHints.language ?? candidate.language,
    hardConstraints,
    preferences,
    derivedSlideCount: hardConstraints.slideCount ?? candidate.derivedSlideCount ?? deterministicHints.derivedSlideCount,
    derivedNarrativeChars: Math.max(
      Number(hardConstraints.narrativeChars ?? 0),
      Number(candidate.derivedNarrativeChars ?? deterministicHints.derivedNarrativeChars ?? 0)
    )
  };
}

function buildFallbackIntent(userPrompt: string, hints: Partial<IntentIR>): IntentIR {
  const language = hints.language ?? "zh-CN";
  const slideCount = hints.hardConstraints?.slideCount ?? hints.derivedSlideCount ?? inferSlideCount(userPrompt);
  const narrativeChars = Math.max(
    hints.hardConstraints?.narrativeChars ?? 0,
    hints.derivedNarrativeChars ?? inferNarrativeChars(slideCount, language)
  );

  return {
    topic: extractTopic(userPrompt),
    language,
    audience: inferAudience(userPrompt),
    tone: inferTone(userPrompt),
    format: inferFormat(userPrompt),
    hardConstraints: {
      ...(hints.hardConstraints?.slideCount ? { slideCount: hints.hardConstraints.slideCount } : {}),
      ...(hints.hardConstraints?.narrativeChars ? { narrativeChars: hints.hardConstraints.narrativeChars } : {}),
      requiredSections: hints.hardConstraints?.requiredSections ?? []
    },
    preferences: {
      aestheticHints: hints.preferences?.aestheticHints ?? [],
      forbiddenThemes: hints.preferences?.forbiddenThemes ?? [],
      domainTerminology: hints.preferences?.domainTerminology ?? [],
      knowledgeCutoffWarning: hints.preferences?.knowledgeCutoffWarning ?? hasTimeSensitiveSignal(userPrompt)
    },
    derivedSlideCount: slideCount,
    derivedNarrativeChars: narrativeChars
  };
}

function extractNumberNear(input: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    const parsed = Number(match?.[1]);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function extractRequiredSections(input: string): string[] {
  const marker = /(?:包括|包含|需要覆盖|sections include|cover)\s*[:：]?\s*([^。.\n]+)/i.exec(input)?.[1];
  if (!marker) {
    return [];
  }
  return marker.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function extractAestheticHints(input: string): string[] {
  const hints: string[] = [];
  const keywords = ["科技", "商务", "极简", "学术", "小红书", "赛博", "复古", "高级", "清新", "technical", "minimal", "academic", "editorial", "premium"];
  for (const keyword of keywords) {
    if (input.toLowerCase().includes(keyword.toLowerCase())) {
      hints.push(keyword);
    }
  }
  return [...new Set(hints)].slice(0, 8);
}

function extractForbiddenThemes(input: string): string[] {
  const match = /(?:不要|避免|forbid|avoid)\s*([^。.\n]+)/i.exec(input)?.[1];
  return match ? match.split(/[、,，;；]/).map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
}

function extractQuotedTerms(input: string): string[] {
  const terms = [...input.matchAll(/["“”'‘’]([^"“”'‘’]{2,40})["“”'‘’]/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
  return [...new Set(terms)].slice(0, 12);
}

function hasTimeSensitiveSignal(input: string): boolean {
  return /(最新|当前|今日|今年|202[4-9]|趋势|市场规模|政策|current|latest|today|recent|202[4-9]|market size|policy|forecast)/i.test(input);
}

function inferSlideCount(input: string): number {
  if (/(briefing|简报|短分享|quick)/i.test(input)) {
    return 6;
  }
  if (/(深度|完整|课程|lecture|report|analysis)/i.test(input)) {
    return 12;
  }
  return 9;
}

function inferNarrativeChars(slideCount: number, language: string): number {
  const perSlide = ["zh-CN", "ja", "ko"].includes(language) ? 130 : 170;
  return Math.max(800, slideCount * perSlide);
}

function inferLanguage(input: string): LanguageId {
  if (/[\u3040-\u30ff]/.test(input)) return "ja";
  if (/[\uac00-\ud7af]/.test(input)) return "ko";
  if (/[\u3400-\u9fff]/.test(input)) return "zh-CN";
  if (/[¿¡]|\b(el|la|los|las|para|sobre|con|sin|mercado|tendencia)s?\b/i.test(input)) return "es";
  if (/[äöüß]|\b(und|der|die|das|für|mit|ohne|markt|trend)\b/i.test(input)) return "de";
  if (/[àâçéèêëîïôûùüÿ]|\b(le|la|les|des|pour|avec|sans|marché|tendance)\b/i.test(input)) return "fr";
  return "en";
}

function inferAudience(input: string): AudienceId {
  if (/(投资|融资|investor|vc|fundraising)/i.test(input)) return "investors";
  if (/(工程|技术|developer|engineer|架构|代码)/i.test(input)) return "engineers";
  if (/(管理层|高管|老板|executive|board)/i.test(input)) return "executives";
  if (/(学生|教学|课程|student|classroom)/i.test(input)) return "students";
  if (/(研究|论文|academic|research)/i.test(input)) return "researchers";
  if (/(销售|客户|sales)/i.test(input)) return "sales";
  if (/(消费者|用户|consumer)/i.test(input)) return "consumers";
  return "general-public";
}

function inferTone(input: string): ToneId {
  if (/(严谨|学术|数据|rigorous|evidence)/i.test(input)) return "rigorous";
  if (/(鼓舞|愿景|inspir)/i.test(input)) return "inspirational";
  if (/(故事|历史|narrative|前世今生)/i.test(input)) return "narrative";
  if (/(教程|教学|tutorial|how to)/i.test(input)) return "tutorial";
  if (/(分析|解读|analysis)/i.test(input)) return "analytical";
  if (/(轻松|友好|friendly)/i.test(input)) return "friendly";
  return "authoritative";
}

function inferFormat(input: string): FormatId {
  if (/(融资|pitch|路演)/i.test(input)) return "pitch";
  if (/(课程|教学|lecture|class)/i.test(input)) return "lecture";
  if (/(教程|tutorial|how to)/i.test(input)) return "tutorial";
  if (/(报告|report)/i.test(input)) return "report";
  if (/(简报|briefing)/i.test(input)) return "briefing";
  if (/(展示|showcase)/i.test(input)) return "showcase";
  return "analysis";
}

function extractTopic(input: string): string {
  const withoutCommand = input
    .replace(/(?:制作|生成|做|create|make)\s*(?:一份|一个)?/gi, "")
    .replace(/\d{1,2}\s*(?:页|张|slides?|pages?)/gi, "")
    .replace(/\d{3,5}\s*(?:字|words?|characters?|chars?)/gi, "")
    .replace(/ppt|html-ppt|slides?|deck|幻灯片/gi, "")
    .trim();
  return withoutCommand.slice(0, 120) || input.slice(0, 120) || "Untitled presentation";
}
