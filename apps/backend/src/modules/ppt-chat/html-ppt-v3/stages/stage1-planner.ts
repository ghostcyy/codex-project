import { buildStage1PlannerPrompt } from "../prompts/stage1-planner.prompt";
import {
  CHART_TYPES,
  planIRSchema,
  validatePlanIR,
  type AvailablePool,
  type GenerateRequest,
  type PlanIR,
  type PageType
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

export type Stage1PlannerInput = {
  request: GenerateRequest;
  pool: AvailablePool;
  llm: HtmlPptV3LLMClient;
};

export type Stage1PlannerResult = {
  plan: PlanIR;
  source: "model" | "fallback";
  validationErrors: string[];
};

export async function runStage1Planner(input: Stage1PlannerInput): Promise<Stage1PlannerResult> {
  const validationErrors: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildStage1PlannerPrompt({
      request: input.request,
      pool: input.pool,
      previousError: validationErrors.at(-1)
    });

    try {
      const candidate = await input.llm.callStructured({
        stage: "v3-stage1-planner",
        structuredOutputName: "html_ppt_v3_stage1_plan",
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        schema: planIRSchema,
        temperature: 0,
        retries: 1
      });
      const normalizedCandidate = normalizeModelPlanCandidate(candidate, input.request, input.pool);
      const validation = validatePlanIR(normalizedCandidate, input.request, input.pool);
      if (validation.ok) {
        return { plan: normalizedCandidate, source: "model", validationErrors };
      }
      validationErrors.push(validation.reasons.join("; "));
    } catch (err) {
      validationErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    plan: buildFallbackPlan(input.request, input.pool),
    source: "fallback",
    validationErrors
  };
}

function normalizeModelPlanCandidate(candidate: PlanIR, request: GenerateRequest, pool: AvailablePool): PlanIR {
  const slides = candidate.slides.map((slide, index) => {
    const isMiddle = index > 0 && index < candidate.slides.length - 1;
    const summary = isMiddle && slide.fragmentId ? pool.middle[slide.fragmentId] : undefined;
    return {
      ...slide,
      topicPoints: summary
        ? normalizeTopicPoints(slide.topicPoints, summary.topicSlots, slide.slideTitle, request.theme)
        : slide.topicPoints
    };
  });
  const budgets = normalizeCharBudgets(slides.map((slide) => slide.charBudget), request.wordBudget);
  return {
    ...candidate,
    templateId: request.templateId,
    totalChars: request.wordBudget,
    pageCount: request.pageCount,
    slides: slides.map((slide, index) => ({
      ...slide,
      charBudget: budgets[index] ?? slide.charBudget
    }))
  };
}

function normalizeTopicPoints(points: string[], topicSlots: number, slideTitle: string, theme: string): string[] {
  if (topicSlots <= 0) return [];
  const normalized = points
    .map((point) => point.trim())
    .filter(Boolean)
    .slice(0, topicSlots)
    .map(truncateTopicPoint);
  while (normalized.length < topicSlots) {
    normalized.push(truncateTopicPoint(`${slideTitle || theme} 要点 ${normalized.length + 1}`));
  }
  return normalized;
}

function normalizeCharBudgets(rawBudgets: number[], wordBudget: number): number[] {
  if (!rawBudgets.length) return [];
  const minTotal = rawBudgets.length * 50;
  if (wordBudget < minTotal) {
    return rawBudgets.map(() => 50);
  }
  const base = Math.floor(wordBudget / rawBudgets.length);
  let remainder = wordBudget - base * rawBudgets.length;
  return rawBudgets.map(() => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return Math.min(3000, Math.max(50, base + extra));
  });
}

function truncateTopicPoint(value: string) {
  return value.length > 80 ? value.slice(0, 80) : value;
}

function buildFallbackPlan(request: GenerateRequest, pool: AvailablePool): PlanIR {
  const middleFragmentIds = Object.keys(pool.middle);
  if (!middleFragmentIds.length && request.pageCount > 2) {
    throw new Error("No available middle fragments for fallback plan; enable at least one media option or choose another template.");
  }
  if (!middleFragmentIds.length) {
    return {
      templateId: request.templateId,
      totalChars: request.wordBudget,
      pageCount: request.pageCount,
      slides: Array.from({ length: request.pageCount }, (_value, offset) => {
        const index = offset + 1;
        return {
          slideIndex: index,
          pageType: index === 1 ? "cover" : "closing",
          slideTitle: buildSlideTitle(request.theme, index, request.pageCount),
          topicPoints: [],
          charBudget: Math.max(50, Math.round(request.wordBudget / request.pageCount))
        };
      })
    };
  }
  const usableMiddle = middleFragmentIds;
  const perPage = Math.max(50, Math.round(request.wordBudget / request.pageCount));
  const slides: PlanIR["slides"] = [];

  for (let index = 1; index <= request.pageCount; index++) {
    const isCover = index === 1;
    const isClosing = index === request.pageCount;
    const middleFragmentId = !isCover && !isClosing ? usableMiddle[(index - 2) % usableMiddle.length] : undefined;
    const middleSummary = middleFragmentId ? pool.middle[middleFragmentId] : undefined;
    const pageType: PageType = isCover
      ? "cover"
      : isClosing
        ? "closing"
        : middleSummary?.pageType ?? "title-text";
    const summary = pageType === "cover"
      ? pool.cover
      : pageType === "closing"
        ? pool.closing
        : middleSummary;
    const topicSlots = summary?.topicSlots ?? 1;
    const chartType = summary?.isChart
      ? (pool.chartTypesAvailable[0] ?? CHART_TYPES[0])
      : undefined;

    slides.push({
      slideIndex: index,
      fragmentId: middleFragmentId,
      pageType,
      slideTitle: buildSlideTitle(request.theme, index, request.pageCount),
      topicPoints: Array.from({ length: topicSlots }, (_, pointIndex) =>
        `${request.theme}：关键要点 ${pointIndex + 1}`
      ),
      chartType,
      charBudget: perPage
    });
  }

  return {
    templateId: request.templateId,
    totalChars: request.wordBudget,
    pageCount: request.pageCount,
    slides
  };
}

function buildSlideTitle(theme: string, index: number, total: number): string {
  if (index === 1) return theme.slice(0, 60);
  if (index === total) return "总结与行动";
  return `${theme.slice(0, 42)} ${index - 1}`;
}
