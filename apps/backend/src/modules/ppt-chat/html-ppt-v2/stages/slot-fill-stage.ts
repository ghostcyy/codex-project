import { z } from "zod";
import { buildSlotFillPrompt } from "../prompts";
import { visibleEvidenceCitationKeys, visibleEvidenceDataPoints, visibleEvidenceFacts } from "../evidence-helpers";
import {
  slotFillIrSchema,
  type DesignSystemIR,
  type EvidencePack,
  type IntentIR,
  type LayoutPlanIR,
  type NarrativeIR,
  type NarrativeSlideIR,
  type SlideSlotFillIR,
  type SlotFillIR
} from "../ir";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

const slotChoiceSchema = z.array(z.record(z.string(), z.unknown())).min(1).max(50);

export type SlotFillStageInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  narrative: NarrativeIR;
  design: DesignSystemIR;
  layoutPlan: LayoutPlanIR;
  model?: JsonOnlyModelClient;
  verificationFeedback?: string[];
  targetSlideIndexes?: number[];
};

export type SlotFillStageResult = {
  slots: SlotFillIR;
  source: "model" | "fallback";
  attempts: number;
  validationErrors: string[];
};

export async function runSlotFillStage(input: SlotFillStageInput): Promise<SlotFillStageResult> {
  const stageInput = scopeSlotFillStageInput(input);
  const validationErrors: string[] = [];
  let modelCalls = 0;

  if (stageInput.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildSlotFillPrompt({
        intent: stageInput.intent,
        evidence: stageInput.evidence,
        narrative: stageInput.narrative,
        design: stageInput.design,
        layoutPlan: stageInput.layoutPlan,
        validationError: validationErrors.at(-1),
        verificationFeedback: stageInput.verificationFeedback
      });
      const candidateCount = attempt === 1 ? creativeCandidateCount("HTML_PPT_V2_SLOT_CANDIDATES") : 1;
      const rawCandidates = await requestSlotFillCandidates(stageInput.model, {
        stage: "06-slot-fill",
        system: prompt.system,
        user: prompt.user,
        candidateCount,
        temperature: candidateCount > 1 ? 0.24 : 0
      });
      modelCalls += rawCandidates.calls;

      const evaluated = rawCandidates.values.map((raw) => evaluateSlotFillCandidate(raw, stageInput));
      const valid = evaluated.filter((item): item is EvaluatedSlotFillCandidate & { slots: SlotFillIR } => Boolean(item.slots));
      if (valid.length) {
        const best = valid.sort((a, b) => b.score - a.score)[0]!;
        return {
          slots: best.slots,
          source: "model",
          attempts: modelCalls,
          validationErrors
        };
      }

      validationErrors.push(evaluated.map((item, index) => `candidate ${index + 1}: ${item.error}`).join("; "));
    }
  }

  const fallback = slotFillIrSchema.parse(buildFallbackSlots(stageInput));
  return {
    slots: fallback,
    source: "fallback",
    attempts: stageInput.model ? modelCalls : 0,
    validationErrors
  };
}

function scopeSlotFillStageInput(input: SlotFillStageInput): SlotFillStageInput {
  const targetSet = new Set((input.targetSlideIndexes ?? []).filter((value) => Number.isInteger(value) && value > 0));
  if (!targetSet.size) {
    return input;
  }

  const layoutPlan = input.layoutPlan.filter((item) => targetSet.has(item.slideIndex));
  if (!layoutPlan.length) {
    return input;
  }
  const activeIndexes = new Set(layoutPlan.map((item) => item.slideIndex));
  const slides = input.narrative.slides.filter((slide) => activeIndexes.has(slide.index));
  const totalEstimatedChars = slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0);
  return {
    ...input,
    layoutPlan,
    targetSlideIndexes: [...activeIndexes],
    narrative: {
      ...input.narrative,
      slides,
      totalEstimatedChars,
      transitions: input.narrative.transitions.filter((transition) =>
        activeIndexes.has(transition.fromSlide) && activeIndexes.has(transition.toSlide)
      )
    }
  };
}

export function validateSlotsAgainstPlan(slots: SlotFillIR, input: Pick<SlotFillStageInput, "layoutPlan" | "narrative" | "evidence">): string[] {
  const issues: string[] = [];
  if (slots.length !== input.layoutPlan.length) {
    issues.push(`SlotFillIR length must equal LayoutPlanIR length (${input.layoutPlan.length}), got ${slots.length}`);
  }

  const layoutBySlide = new Map(input.layoutPlan.map((item) => [item.slideIndex, item.layoutId]));
  const citationKeys = getAvailableCitationKeys(input.evidence);
  for (const slot of slots) {
    const expectedKind = layoutBySlide.get(slot.slideIndex);
    if (slot.kind !== expectedKind) {
      issues.push(`slide ${slot.slideIndex} slot kind '${slot.kind}' must match layout '${expectedKind}'`);
    }
    for (const citationKey of collectSlotCitationKeys(slot)) {
      if (!citationKeys.has(citationKey)) {
        issues.push(`slide ${slot.slideIndex} references unknown citationKey '${citationKey}'`);
      }
    }
  }

  const narrativeIndexes = new Set(input.narrative.slides.map((slide) => slide.index));
  for (const slot of slots) {
    if (!narrativeIndexes.has(slot.slideIndex)) {
      issues.push(`slot references unknown narrative slide ${slot.slideIndex}`);
    }
  }

  return issues;
}

function validateRawSlotChoices(choices: Array<Record<string, unknown>>, input: SlotFillStageInput): string[] {
  const issues: string[] = [];
  if (choices.length !== input.layoutPlan.length) {
    issues.push(`slot choice length must equal layout plan count (${input.layoutPlan.length}), got ${choices.length}`);
  }

  const layoutBySlide = new Map(input.layoutPlan.map((item) => [item.slideIndex, item.layoutId]));
  const seen = new Set<number>();
  for (const choice of choices) {
    const slideIndex = Number(choice.slideIndex);
    const kind = typeof choice.kind === "string" ? choice.kind : "";
    const expectedKind = layoutBySlide.get(slideIndex);
    if (!expectedKind) {
      issues.push(`slot choice references unknown slideIndex ${choice.slideIndex}`);
    }
    if (seen.has(slideIndex)) {
      issues.push(`slot choice duplicates slideIndex ${slideIndex}`);
    }
    seen.add(slideIndex);
    if (expectedKind && kind !== expectedKind) {
      issues.push(`slide ${slideIndex} kind '${kind}' must equal layoutId '${expectedKind}'`);
    }
  }

  return issues;
}

type EvaluatedSlotFillCandidate = {
  slots?: SlotFillIR;
  score: number;
  error?: string;
};

async function requestSlotFillCandidates(model: JsonOnlyModelClient, input: {
  stage: string;
  system: string;
  user: string;
  candidateCount: number;
  temperature: number;
}): Promise<{ values: unknown[]; calls: number }> {
  const calls = Array.from({ length: input.candidateCount }, async (_, index) => {
    const stage = input.candidateCount > 1 ? `${input.stage}:candidate-${index + 1}` : input.stage;
    return model.completeJson({
      stage,
      system: input.system,
      user: input.user,
      temperature: input.temperature
    });
  });
  const settled = await Promise.allSettled(calls);
  const values = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  if (!values.length) {
    const reason = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
    throw reason?.reason instanceof Error ? reason.reason : new Error(String(reason?.reason ?? "Slot-fill candidate generation failed."));
  }
  return { values, calls: calls.length };
}

function evaluateSlotFillCandidate(raw: unknown, input: SlotFillStageInput): EvaluatedSlotFillCandidate {
  const parsedChoice = slotChoiceSchema.safeParse(parseJsonLike(raw, { shape: "array" }));
  if (!parsedChoice.success) {
    return { score: -1, error: formatZodError(parsedChoice.error) };
  }

  const choiceIssues = validateRawSlotChoices(parsedChoice.data, input);
  if (choiceIssues.length) {
    return { score: -0.8, error: choiceIssues.join("; ") };
  }

  const candidate = normalizeSlotFillCandidate(parsedChoice.data, input);
  const parsedSlots = slotFillIrSchema.safeParse(candidate);
  if (!parsedSlots.success) {
    return { score: -0.5, error: formatZodError(parsedSlots.error) };
  }

  const stageIssues = validateSlotsAgainstPlan(parsedSlots.data, input);
  if (stageIssues.length) {
    return { score: -0.3, error: stageIssues.join("; ") };
  }

  return {
    slots: parsedSlots.data,
    score: scoreSlotFillCandidate(parsedSlots.data, input)
  };
}

function scoreSlotFillCandidate(slots: SlotFillIR, input: SlotFillStageInput): number {
  const targetChars = Math.max(1, input.intent.derivedNarrativeChars);
  const textChars = slots.reduce((sum, slot) => sum + visibleSlotTextLength(slot), 0);
  const charRatio = Math.min(1.15, textChars / targetChars);
  const titleCoverage = slots.filter((slot) => slot.title.trim().length >= 4).length / Math.max(1, slots.length);
  const citationCoverage = slots.filter((slot) => (slot.citationKeys ?? []).length > 0).length / Math.max(1, slots.length);
  const structureCoverage = slots.reduce((sum, slot) => sum + slotStructureScore(slot), 0) / Math.max(1, slots.length);
  return Number((charRatio * 0.34 + titleCoverage * 0.18 + citationCoverage * 0.14 + structureCoverage * 0.34).toFixed(4));
}

function visibleSlotTextLength(slot: SlideSlotFillIR): number {
  const parts: string[] = [slot.title, slot.kicker ?? "", slot.footer ?? ""];
  switch (slot.kind) {
    case "cover":
      parts.push(slot.subtitle ?? "", ...slot.meta);
      break;
    case "toc":
      for (const item of slot.items) parts.push(item.label, item.description ?? "");
      break;
    case "two-column":
      parts.push(slot.leftTitle, slot.leftBody, slot.rightTitle, slot.rightBody, ...slot.bullets);
      break;
    case "three-column":
      for (const card of slot.cards) parts.push(card.title, card.body);
      break;
    case "kpi-grid":
      parts.push(slot.summary ?? "");
      for (const metric of slot.metrics) parts.push(metric.label, metric.value, metric.note ?? "");
      break;
    case "timeline":
      for (const event of slot.events) parts.push(event.label, event.date ?? "", event.description);
      break;
    case "comparison":
      parts.push(slot.left.title, slot.left.body, slot.right.title, slot.right.body, slot.verdict ?? "");
      break;
    case "bullet-list":
      parts.push(slot.lede ?? "");
      for (const group of slot.groups) parts.push(group.title, ...group.items);
      break;
    case "process":
      parts.push(slot.lede ?? "");
      for (const step of slot.steps) parts.push(step.label, step.title, step.description);
      break;
    case "image-hero":
      parts.push(slot.lede ?? "", slot.imageAlt ?? "", slot.visualLabel ?? "", slot.body, ...slot.chips);
      break;
    case "quote":
      parts.push(slot.quote, slot.attribution ?? "", slot.supportingText ?? "");
      break;
    case "section-divider":
      parts.push(slot.marker, slot.progressText ?? "", slot.supportingText ?? "");
      break;
    case "stat-highlight":
      parts.push(slot.value, slot.label, slot.explanation);
      for (const card of slot.cards) parts.push(card.title, card.body);
      break;
    case "chart":
      parts.push(slot.chartType, slot.dataAssetKey, slot.insight);
      break;
    case "cta":
      parts.push(slot.headline, slot.action, slot.supportingText ?? "");
      break;
    default:
      parts.push(JSON.stringify(slot));
  }
  return parts.join("").replace(/\s+/g, "").length;
}

function slotStructureScore(slot: SlideSlotFillIR): number {
  switch (slot.kind) {
    case "cover":
      return slot.subtitle || slot.meta.length >= 2 ? 1 : 0.65;
    case "toc":
      return Math.min(1, slot.items.filter((item) => item.label && item.description).length / Math.max(3, slot.items.length));
    case "two-column":
      return [slot.leftTitle, slot.leftBody, slot.rightTitle, slot.rightBody].filter(Boolean).length / 4;
    case "three-column":
      return slot.cards.filter((card) => card.title && card.body).length / 3;
    case "kpi-grid":
      return slot.metrics.filter((metric) => metric.label && metric.value && metric.note).length / Math.max(3, slot.metrics.length);
    case "timeline":
      return slot.events.filter((event) => event.label && event.description).length / Math.max(4, slot.events.length);
    case "comparison":
      return [slot.left.title, slot.left.body, slot.right.title, slot.right.body, slot.verdict].filter(Boolean).length / 5;
    case "bullet-list":
      return slot.groups.filter((group) => group.title && group.items.length >= 2).length / Math.max(2, slot.groups.length);
    case "process":
      return slot.steps.filter((step) => step.label && step.title && step.description).length / Math.max(3, slot.steps.length);
    case "image-hero":
      return [slot.title, slot.lede, slot.body, slot.visualLabel ?? slot.imageAssetKey].filter(Boolean).length / 4;
    case "quote":
      return [slot.quote, slot.attribution, slot.supportingText].filter(Boolean).length / 3;
    case "section-divider":
      return [slot.marker, slot.title, slot.supportingText, slot.progressText].filter(Boolean).length / 4;
    case "stat-highlight":
      return [slot.value, slot.label, slot.explanation].filter(Boolean).length / 3;
    case "chart":
      return [slot.chartType, slot.dataAssetKey, slot.insight].filter(Boolean).length / 3;
    case "cta":
      return [slot.headline, slot.action, slot.supportingText].filter(Boolean).length / 3;
    default:
      return 0.7;
  }
}

function creativeCandidateCount(envName: string): number {
  const specific = Number.parseInt(process.env[envName] ?? "", 10);
  const shared = Number.parseInt(process.env.HTML_PPT_V2_CREATIVE_CANDIDATES ?? "", 10);
  const value = Number.isFinite(specific) && specific > 0 ? specific : Number.isFinite(shared) && shared > 0 ? shared : 3;
  return Math.min(4, Math.max(1, Math.trunc(value)));
}

function normalizeSlotFillCandidate(choices: Array<Record<string, unknown>>, input: SlotFillStageInput): SlotFillIR {
  const bySlide = new Map(choices.map((choice) => [Number(choice.slideIndex), choice]));
  return input.layoutPlan.map((planItem) => {
    const slide = input.narrative.slides.find((item) => item.index === planItem.slideIndex)!;
    const choice = bySlide.get(planItem.slideIndex) ?? {};
    return normalizeSlotForLayout(choice, slide, input);
  });
}

function buildFallbackSlots(input: SlotFillStageInput): SlotFillIR {
  return input.layoutPlan.map((planItem) => {
    const slide = input.narrative.slides.find((item) => item.index === planItem.slideIndex)!;
    return fallbackSlotForLayout(planItem.layoutId, slide, input);
  });
}

function normalizeSlotForLayout(raw: Record<string, unknown>, slide: NarrativeSlideIR, input: SlotFillStageInput): SlideSlotFillIR {
  const layoutId = input.layoutPlan.find((item) => item.slideIndex === slide.index)!.layoutId;
  const fallback = fallbackSlotForLayout(layoutId, slide, input);
  const citationKeys = normalizeCitationKeys(raw.citationKeys, slide, input.evidence);
  const title = stringValue(raw.title, fallback.title);
  const kicker = optionalString(raw.kicker) ?? fallback.kicker;
  const footer = optionalString(raw.footer) ?? fallback.footer;

  switch (layoutId) {
    case "cover": {
      const coverFallback = fallback as Extract<SlideSlotFillIR, { kind: "cover" }>;
      return {
        ...coverFallback,
        title,
        kicker,
        footer,
        subtitle: optionalString(raw.subtitle) ?? coverFallback.subtitle,
        meta: normalizeStringArray(raw.meta, coverFallback.meta).slice(0, 4),
        citationKeys
      };
    }
    case "toc": {
      const tocFallback = fallback as Extract<SlideSlotFillIR, { kind: "toc" }>;
      return {
        ...tocFallback,
        title,
        kicker,
        footer,
        items: normalizeTocItems(raw.items, tocFallback.items),
        citationKeys
      };
    }
    case "two-column": {
      const twoColumnFallback = fallback as Extract<SlideSlotFillIR, { kind: "two-column" }>;
      return {
        ...twoColumnFallback,
        title,
        kicker,
        footer,
        leftTitle: stringValue(raw.leftTitle, twoColumnFallback.leftTitle),
        leftBody: stringValue(raw.leftBody, twoColumnFallback.leftBody),
        rightTitle: stringValue(raw.rightTitle, twoColumnFallback.rightTitle),
        rightBody: stringValue(raw.rightBody, twoColumnFallback.rightBody),
        bullets: normalizeStringArray(raw.bullets, twoColumnFallback.bullets).slice(0, 8),
        citationKeys
      };
    }
    case "three-column": {
      const threeColumnFallback = fallback as Extract<SlideSlotFillIR, { kind: "three-column" }>;
      return {
        ...threeColumnFallback,
        title,
        kicker,
        footer,
        cards: normalizeCards(raw.cards, threeColumnFallback.cards, 3, 3, input.evidence),
        citationKeys
      };
    }
    case "kpi-grid": {
      const kpiGridFallback = fallback as Extract<SlideSlotFillIR, { kind: "kpi-grid" }>;
      return {
        ...kpiGridFallback,
        title,
        kicker,
        footer,
        summary: optionalString(raw.summary) ?? kpiGridFallback.summary,
        metrics: normalizeMetrics(raw.metrics, kpiGridFallback.metrics, input.evidence),
        citationKeys
      };
    }
    case "timeline": {
      const timelineFallback = fallback as Extract<SlideSlotFillIR, { kind: "timeline" }>;
      return {
        ...timelineFallback,
        title,
        kicker,
        footer,
        events: normalizeEvents(raw.events, timelineFallback.events, input.evidence),
        citationKeys
      };
    }
    case "comparison": {
      const comparisonFallback = fallback as Extract<SlideSlotFillIR, { kind: "comparison" }>;
      return {
        ...comparisonFallback,
        title,
        kicker,
        footer,
        left: normalizeCard(raw.left, comparisonFallback.left, input.evidence),
        right: normalizeCard(raw.right, comparisonFallback.right, input.evidence),
        verdict: optionalString(raw.verdict) ?? comparisonFallback.verdict,
        citationKeys
      };
    }
    case "chart": {
      const chartFallback = fallback as Extract<SlideSlotFillIR, { kind: "chart" }>;
      return {
        ...chartFallback,
        title,
        kicker,
        footer,
        chartType: normalizeChartType(raw.chartType, chartFallback.chartType),
        dataAssetKey: stringValue(raw.dataAssetKey, chartFallback.dataAssetKey).replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 80) || chartFallback.dataAssetKey,
        insight: stringValue(raw.insight, chartFallback.insight),
        citationKeys
      };
    }
    case "bullet-list": {
      const bulletFallback = fallback as Extract<SlideSlotFillIR, { kind: "bullet-list" }>;
      return {
        ...bulletFallback,
        title,
        kicker,
        footer,
        lede: optionalString(raw.lede) ?? bulletFallback.lede,
        groups: normalizeBulletGroups(raw.groups, bulletFallback.groups, input.evidence),
        citationKeys
      };
    }
    case "process": {
      const processFallback = fallback as Extract<SlideSlotFillIR, { kind: "process" }>;
      return {
        ...processFallback,
        title,
        kicker,
        footer,
        lede: optionalString(raw.lede) ?? processFallback.lede,
        steps: normalizeProcessSteps(raw.steps, processFallback.steps, input.evidence),
        citationKeys
      };
    }
    case "image-hero": {
      const imageHeroFallback = fallback as Extract<SlideSlotFillIR, { kind: "image-hero" }>;
      return {
        ...imageHeroFallback,
        title,
        kicker,
        footer,
        lede: optionalString(raw.lede) ?? imageHeroFallback.lede,
        imageAssetKey: optionalString(raw.imageAssetKey)?.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 80) || imageHeroFallback.imageAssetKey,
        imageAlt: optionalString(raw.imageAlt) ?? imageHeroFallback.imageAlt,
        visualLabel: optionalString(raw.visualLabel) ?? imageHeroFallback.visualLabel,
        body: stringValue(raw.body, imageHeroFallback.body),
        chips: normalizeStringArray(raw.chips, imageHeroFallback.chips).slice(0, 5),
        citationKeys
      };
    }
    case "quote": {
      const quoteFallback = fallback as Extract<SlideSlotFillIR, { kind: "quote" }>;
      return {
        ...quoteFallback,
        title,
        kicker,
        footer,
        quote: stringValue(raw.quote, quoteFallback.quote),
        attribution: optionalString(raw.attribution) ?? quoteFallback.attribution,
        supportingText: optionalString(raw.supportingText) ?? quoteFallback.supportingText,
        citationKeys
      };
    }
    case "section-divider": {
      const dividerFallback = fallback as Extract<SlideSlotFillIR, { kind: "section-divider" }>;
      return {
        ...dividerFallback,
        title,
        kicker,
        footer,
        marker: normalizeSectionMarker(raw.marker, slide.index, dividerFallback.marker),
        progressText: normalizeSectionProgressText(raw.progressText, slide.index, input.intent.derivedSlideCount, dividerFallback.progressText),
        supportingText: optionalString(raw.supportingText) ?? dividerFallback.supportingText,
        citationKeys
      };
    }
    case "stat-highlight": {
      const statFallback = fallback as Extract<SlideSlotFillIR, { kind: "stat-highlight" }>;
      return {
        ...statFallback,
        title,
        kicker,
        footer,
        value: stringValue(raw.value, statFallback.value),
        label: stringValue(raw.label, statFallback.label),
        explanation: stringValue(raw.explanation, statFallback.explanation),
        cards: normalizeCards(raw.cards, statFallback.cards, 2, 3, input.evidence),
        citationKeys
      };
    }
    case "cta": {
      const ctaFallback = fallback as Extract<SlideSlotFillIR, { kind: "cta" }>;
      return {
        ...ctaFallback,
        title,
        kicker,
        footer,
        headline: stringValue(raw.headline, ctaFallback.headline),
        action: stringValue(raw.action, ctaFallback.action),
        supportingText: optionalString(raw.supportingText) ?? ctaFallback.supportingText,
        citationKeys
      };
    }
    default:
      return fallback;
  }
}

function fallbackSlotForLayout(layoutId: SlideSlotFillIR["kind"], slide: NarrativeSlideIR, input: SlotFillStageInput): SlideSlotFillIR {
  const citationKeys = normalizeCitationKeys(slide.contentBrief.evidenceRefs, slide, input.evidence);
  const title = slide.contentBrief.headline;
  const kicker = roleKicker(slide.role);
  const footer = footerText(input.intent, slide);
  const points = slide.contentBrief.supportingPoints;
  const facts = visibleEvidenceFacts(input.evidence).map((fact) => fact.claim);
  const dataPoints = visibleEvidenceDataPoints(input.evidence);
  const labels = localizedFallbackLabels(input.intent.language);

  switch (layoutId) {
    case "cover":
      return {
        slideIndex: slide.index,
        kind: "cover",
        title,
        kicker,
        subtitle: slide.contentBrief.subhead ?? points[0],
        meta: [input.intent.audience, input.intent.format, `${input.intent.derivedSlideCount} slides`],
        footer,
        citationKeys
      };
    case "toc":
      return {
        slideIndex: slide.index,
        kind: "toc",
        title,
        kicker,
        items: buildTocItems(input.narrative.slides, slide.index),
        footer,
        citationKeys
      };
    case "two-column":
      return {
        slideIndex: slide.index,
        kind: "two-column",
        title,
        kicker,
        leftTitle: shortTitle(points[0] ?? title, labels.coreJudgment),
        leftBody: points[0] ?? facts[0] ?? labels.firstArgument(title),
        rightTitle: shortTitle(points[1] ?? facts[1] ?? title, labels.keyImpact),
        rightBody: points[1] ?? facts[1] ?? labels.evidenceToAction(title),
        bullets: points.slice(0, 4).map((item) => item.slice(0, 160)),
        footer,
        citationKeys
      };
    case "three-column":
      return {
        slideIndex: slide.index,
        kind: "three-column",
        title,
        kicker,
        cards: buildCards(points, facts, 3, citationKeys, labels),
        footer,
        citationKeys
      };
    case "kpi-grid":
      return {
        slideIndex: slide.index,
        kind: "kpi-grid",
        title,
        kicker,
        summary: slide.contentBrief.subhead ?? points[0],
        metrics: buildMetrics(slide, dataPoints, citationKeys, labels),
        footer,
        citationKeys
      };
    case "timeline":
      return {
        slideIndex: slide.index,
        kind: "timeline",
        title,
        kicker,
        events: buildEvents(points, facts, citationKeys, labels),
        footer,
        citationKeys
      };
    case "comparison":
      return {
        slideIndex: slide.index,
        kind: "comparison",
        title,
        kicker,
        left: { title: shortTitle(points[0] ?? labels.currentState, labels.currentState), body: points[0] ?? facts[0] ?? labels.currentStateBody, accent: "neutral", citationKeys: citationKeys.slice(0, 1) },
        right: { title: shortTitle(points[1] ?? labels.targetState, labels.targetState), body: points[1] ?? facts[1] ?? labels.targetStateBody, accent: "primary", citationKeys: citationKeys.slice(1, 2).length ? citationKeys.slice(1, 2) : citationKeys.slice(0, 1) },
        verdict: points[2] ?? labels.verdict,
        footer,
        citationKeys
      };
    case "chart":
      return {
        slideIndex: slide.index,
        kind: "chart",
        title,
        kicker,
        chartType: chooseChartType(slide),
        dataAssetKey: `chart-slide-${slide.index}`,
        insight: points[0] ?? facts[0] ?? labels.chartInsight,
        footer,
        citationKeys
      };
    case "bullet-list":
      return {
        slideIndex: slide.index,
        kind: "bullet-list",
        title,
        kicker,
        lede: slide.contentBrief.subhead ?? points[0] ?? slide.beat,
        groups: buildBulletGroups(points, facts, citationKeys, labels),
        footer,
        citationKeys
      };
    case "process":
      return {
        slideIndex: slide.index,
        kind: "process",
        title,
        kicker,
        lede: slide.contentBrief.subhead ?? points[0] ?? labels.processLede,
        steps: buildProcessSteps(points, facts, citationKeys, labels),
        footer,
        citationKeys
      };
    case "image-hero":
      return {
        slideIndex: slide.index,
        kind: "image-hero",
        title,
        kicker,
        lede: slide.contentBrief.subhead ?? points[0],
        visualLabel: shortTitle(slide.contentBrief.keyMetrics?.[0] ?? title, labels.imageHeroLabel),
        body: points[1] ?? facts[0] ?? labels.imageHeroBody,
        chips: [input.intent.audience, input.intent.format, slide.role].slice(0, 5),
        footer,
        citationKeys
      };
    case "quote":
      return {
        slideIndex: slide.index,
        kind: "quote",
        title,
        kicker,
        quote: points[0] ?? slide.beat ?? labels.quoteFallback(title),
        attribution: points[1] ? shortTitle(points[1], labels.quoteAttribution) : labels.quoteAttribution,
        supportingText: points[2] ?? slide.contentBrief.subhead ?? labels.quoteSupport,
        footer,
        citationKeys
      };
    case "section-divider":
      return {
        slideIndex: slide.index,
        kind: "section-divider",
        title,
        kicker,
        marker: labels.sectionMarker(slide.index),
        progressText: `${slide.index} / ${input.intent.derivedSlideCount}`,
        supportingText: slide.contentBrief.subhead ?? points[0] ?? labels.sectionSupport,
        footer,
        citationKeys
      };
    case "stat-highlight": {
      const metric = dataPoints[0];
      return {
        slideIndex: slide.index,
        kind: "stat-highlight",
        title,
        kicker,
        value: metric ? String(metric.value) : slide.contentBrief.keyMetrics?.[0] ?? labels.statValue,
        label: metric?.metric ?? shortTitle(points[0] ?? title, labels.statLabel),
        explanation: points[1] ?? metric?.period ?? facts[0] ?? labels.statExplanation,
        cards: buildCards(points.slice(2), facts, 2, citationKeys, labels),
        footer,
        citationKeys
      };
    }
    case "cta":
      return {
        slideIndex: slide.index,
        kind: "cta",
        title,
        kicker,
        headline: title,
        action: points[0] ?? labels.nextDecision,
        supportingText: points[1] ?? slide.beat,
        footer,
        citationKeys
      };
    default:
      throw new Error(`Unsupported v2 deterministic slot layout '${layoutId}'.`);
  }
}

function buildTocItems(slides: NarrativeSlideIR[], currentSlideIndex: number) {
  const preferred = slides.filter((item) => item.index !== currentSlideIndex && item.role !== "cover" && item.role !== "cta" && item.role !== "thanks");
  const fallback = slides.filter((item) => item.index !== currentSlideIndex);
  const source = (preferred.length >= 3 ? preferred : fallback).slice(0, 8);
  const items = source.map((item) => ({ label: item.contentBrief.headline, description: item.beat }));
  while (items.length < 3) {
    const number = items.length + 1;
    items.push({
      label: `Agenda ${number}`,
      description: "Reserved section generated to keep the deterministic TOC layout valid."
    });
  }
  return items;
}

function normalizeTocItems(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "toc" }>["items"]) {
  const items = asArray(value).map((item) => {
    const record = asRecord(item);
    return {
      label: stringValue(record.label, ""),
      ...(optionalString(record.description) ? { description: optionalString(record.description) } : {})
    };
  }).filter((item) => item.label);
  return (items.length >= 3 ? items : fallback).slice(0, 12);
}

function normalizeCards(value: unknown, fallback: Array<{ title: string; body: string; accent?: "primary" | "secondary" | "neutral" | "good" | "warn" | "bad"; citationKeys: string[] }>, min: number, max: number, evidence: EvidencePack) {
  const cards = asArray(value).map((item, index) => normalizeCard(item, fallback[index] ?? fallback[0]!, evidence)).filter(Boolean);
  const result = cards.length >= min ? cards : fallback;
  return result.slice(0, max);
}

function normalizeCard(value: unknown, fallback: { title: string; body: string; accent?: "primary" | "secondary" | "neutral" | "good" | "warn" | "bad"; citationKeys: string[] }, evidence: EvidencePack) {
  const record = asRecord(value);
  return {
    title: stringValue(record.title, fallback.title),
    body: stringValue(record.body, fallback.body),
    accent: normalizeAccent(record.accent, fallback.accent),
    citationKeys: normalizeNestedCitationKeys(record.citationKeys, fallback.citationKeys, evidence)
  };
}

function normalizeMetrics(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "kpi-grid" }>["metrics"], evidence: EvidencePack) {
  const metrics = asArray(value).map((item, index) => {
    const record = asRecord(item);
    const fallbackMetric = fallback[index] ?? fallback[0]!;
    return {
      label: stringValue(record.label, fallbackMetric.label),
      value: stringValue(record.value, fallbackMetric.value),
      note: optionalString(record.note) ?? fallbackMetric.note,
      citationKeys: normalizeNestedCitationKeys(record.citationKeys, fallbackMetric.citationKeys, evidence)
    };
  });
  const result = metrics.length >= 3 ? metrics : fallback;
  return result.slice(0, 6);
}

function normalizeEvents(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "timeline" }>["events"], evidence: EvidencePack) {
  const events = asArray(value).map((item, index) => {
    const record = asRecord(item);
    const fallbackEvent = fallback[index] ?? fallback[0]!;
    return {
      label: stringValue(record.label, fallbackEvent.label),
      date: optionalString(record.date) ?? fallbackEvent.date,
      description: stringValue(record.description, fallbackEvent.description),
      accent: normalizeTimelineAccent(record.accent, fallbackEvent.accent),
      citationKeys: normalizeNestedCitationKeys(record.citationKeys, fallbackEvent.citationKeys, evidence)
    };
  });
  const result = events.length >= 4 ? events : fallback;
  return result.slice(0, 8);
}

function buildCards(points: string[], facts: string[], count: number, citationKeys: string[], labels: LocalizedFallbackLabels) {
  const source = [...points, ...facts, labels.cardBaseline, labels.cardImplication, labels.cardDecisionPath];
  return Array.from({ length: count }, (_, index) => ({
    title: shortTitle(source[index] ?? labels.point(index + 1), labels.point(index + 1)),
    body: source[index] ?? labels.supportingPoint(index + 1),
    accent: (["primary", "secondary", "neutral"] as const)[index % 3],
    citationKeys: citationKeys.length ? [citationKeys[index % citationKeys.length]!] : []
  }));
}

function buildMetrics(slide: NarrativeSlideIR, dataPoints: EvidencePack["dataPoints"], citationKeys: string[], labels: LocalizedFallbackLabels) {
  const metricLabels = slide.contentBrief.keyMetrics?.length ? slide.contentBrief.keyMetrics : dataPoints.map((point) => point.metric);
  const fallback = labels.metricFallbacks;
  return Array.from({ length: 3 }, (_, index) => {
    const dataPoint = dataPoints[index];
    return {
      label: metricLabels[index] ?? fallback[index]!,
      value: dataPoint ? String(dataPoint.value) : `${index + 1}`,
      note: dataPoint?.period ?? slide.contentBrief.supportingPoints[index] ?? labels.metricNote,
      citationKeys: dataPoint?.citationKey ? [dataPoint.citationKey] : citationKeys.length ? [citationKeys[index % citationKeys.length]!] : []
    };
  });
}

function buildEvents(points: string[], facts: string[], citationKeys: string[], labels: LocalizedFallbackLabels) {
  const source = [...points, ...facts, labels.eventBaseline, labels.eventPath, labels.eventScale, labels.eventAction];
  return Array.from({ length: 4 }, (_, index) => ({
    label: shortTitle(source[index] ?? labels.step(index + 1), labels.step(index + 1)),
    date: labels.step(index + 1),
    description: source[index] ?? labels.timelineEvent(index + 1),
    accent: (["neutral", "primary", "secondary", "primary"] as const)[index],
    citationKeys: citationKeys.length ? [citationKeys[index % citationKeys.length]!] : []
  }));
}

function buildBulletGroups(points: string[], facts: string[], citationKeys: string[], labels: LocalizedFallbackLabels) {
  const source = [...points, ...facts, labels.bulletFallbackOne, labels.bulletFallbackTwo, labels.bulletFallbackThree, labels.bulletFallbackFour];
  const titles = [labels.bulletGroupOne, labels.bulletGroupTwo, labels.bulletGroupThree, labels.bulletGroupFour];
  return Array.from({ length: 2 }, (_, index) => ({
    title: titles[index]!,
    items: source.slice(index * 2, index * 2 + 3).filter(Boolean).slice(0, 3).map((item) => item.slice(0, 160)),
    accent: (["primary", "secondary"] as const)[index],
    citationKeys: citationKeys.length ? [citationKeys[index % citationKeys.length]!] : []
  }));
}

function buildProcessSteps(points: string[], facts: string[], citationKeys: string[], labels: LocalizedFallbackLabels) {
  const source = [...points, ...facts, labels.processFallbackOne, labels.processFallbackTwo, labels.processFallbackThree];
  return Array.from({ length: 3 }, (_, index) => ({
    label: String(index + 1).padStart(2, "0"),
    title: shortTitle(source[index] ?? labels.step(index + 1), labels.step(index + 1)),
    description: source[index] ?? labels.processStep(index + 1),
    accent: (["neutral", "primary", "secondary"] as const)[index],
    citationKeys: citationKeys.length ? [citationKeys[index % citationKeys.length]!] : []
  }));
}

function normalizeBulletGroups(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "bullet-list" }>["groups"], evidence: EvidencePack) {
  const groups = asArray(value).map((item, index) => {
    const record = asRecord(item);
    const fallbackGroup = fallback[index] ?? fallback[0]!;
    const items = normalizeStringArray(record.items, fallbackGroup.items).slice(0, 5);
    return {
      title: stringValue(record.title, fallbackGroup.title),
      items: items.length >= 2 ? items : fallbackGroup.items,
      accent: normalizeAccent(record.accent, fallbackGroup.accent),
      citationKeys: normalizeNestedCitationKeys(record.citationKeys, fallbackGroup.citationKeys, evidence)
    };
  });
  const result = groups.length >= 2 ? groups : fallback;
  return result.slice(0, 4);
}

function normalizeProcessSteps(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "process" }>["steps"], evidence: EvidencePack) {
  const steps = asArray(value).map((item, index) => {
    const record = asRecord(item);
    const fallbackStep = fallback[index] ?? fallback[0]!;
    return {
      label: stringValue(record.label, fallbackStep.label),
      title: stringValue(record.title, fallbackStep.title),
      description: stringValue(record.description, fallbackStep.description),
      accent: normalizeAccent(record.accent, fallbackStep.accent),
      citationKeys: normalizeNestedCitationKeys(record.citationKeys, fallbackStep.citationKeys, evidence)
    };
  });
  const result = steps.length >= 3 ? steps : fallback;
  return result.slice(0, 6);
}

function normalizeCitationKeys(value: unknown, slide: NarrativeSlideIR, evidence: EvidencePack): string[] {
  const available = getAvailableCitationKeys(evidence);
  const requested = normalizeStringArray(value, slide.contentBrief.evidenceRefs).filter((key) => available.has(key));
  return (requested.length ? requested : slide.contentBrief.evidenceRefs.filter((key) => available.has(key))).slice(0, 12);
}

function normalizeNestedCitationKeys(value: unknown, fallback: string[], evidence: EvidencePack): string[] {
  const available = getAvailableCitationKeys(evidence);
  const requested = normalizeStringArray(value, []).filter((key) => available.has(key));
  const fallbackKeys = fallback.filter((key) => available.has(key));
  return (requested.length ? requested : fallbackKeys).slice(0, 6);
}

function collectSlotCitationKeys(slot: SlideSlotFillIR): string[] {
  const keys = [...(slot.citationKeys ?? [])];
  switch (slot.kind) {
    case "three-column":
      for (const card of slot.cards) keys.push(...card.citationKeys);
      break;
    case "kpi-grid":
      for (const metric of slot.metrics) keys.push(...metric.citationKeys);
      break;
    case "timeline":
      for (const event of slot.events) keys.push(...event.citationKeys);
      break;
    case "comparison":
      keys.push(...slot.left.citationKeys, ...slot.right.citationKeys);
      break;
    case "bullet-list":
      for (const group of slot.groups) keys.push(...group.citationKeys);
      break;
    case "process":
      for (const step of slot.steps) keys.push(...step.citationKeys);
      break;
    case "stat-highlight":
      for (const card of slot.cards) keys.push(...card.citationKeys);
      break;
    default:
      break;
  }
  return [...new Set(keys)];
}

function getAvailableCitationKeys(evidence: EvidencePack): Set<string> {
  return new Set(visibleEvidenceCitationKeys(evidence));
}

type LocalizedFallbackLabels = ReturnType<typeof localizedFallbackLabels>;

function localizedFallbackLabels(language: IntentIR["language"]) {
  const zh = {
    coreJudgment: "核心判断",
    keyImpact: "关键影响",
    currentState: "现状",
    targetState: "目标",
    currentStateBody: "当前状态定义了决策基线。",
    targetStateBody: "目标状态说明了这个决策为什么重要。",
    verdict: "推荐路径应同时回应证据和受众需求。",
    chartInsight: "图表将证据数据转化为可判断的视觉信号。",
    nextDecision: "把这份内容转化为明确的下一步决策。",
    cardBaseline: "清晰定义基线。",
    cardImplication: "说明运营影响。",
    cardDecisionPath: "收束到决策路径。",
    metricFallbacks: ["范围", "证据", "行动"],
    metricNote: "用这个信号支撑页面论证。",
    eventBaseline: "厘清基线。",
    eventPath: "构建行动路径。",
    eventScale: "放大有效做法。",
    eventAction: "以行动收束。",
    firstArgument: (title: string) => `${title} 需要一个清晰的第一论点。`,
    evidenceToAction: (title: string) => `${title} 应把证据连接到行动。`,
    point: (index: number) => `要点 ${index}`,
    supportingPoint: (index: number) => `支撑要点 ${index}。`,
    step: (index: number) => `步骤 ${index}`,
    timelineEvent: (index: number) => `时间线事件 ${index}。`
    ,
    quoteAttribution: "关键引用",
    quoteSupport: "用这一页强调叙事中的关键转折。",
    sectionSupport: "这一节将进入新的论证层级。",
    statValue: "1",
    statLabel: "关键信号",
    statExplanation: "这个数字需要连接到可判断的业务含义。",
    quoteFallback: (title: string) => `${title} 的关键观点需要被清晰强调。`,
    sectionMarker: (index: number) => fallbackSectionMarker(index),
    bulletGroupOne: "核心要点",
    bulletGroupTwo: "落地判断",
    bulletGroupThree: "风险约束",
    bulletGroupFour: "下一步",
    bulletFallbackOne: "先定义关键问题。",
    bulletFallbackTwo: "再识别证据和约束。",
    bulletFallbackThree: "最后收束为可执行动作。",
    bulletFallbackFour: "保留复盘和迭代空间。",
    processLede: "把复杂行动拆解为可执行步骤。",
    processFallbackOne: "明确输入和边界。",
    processFallbackTwo: "建立执行路径。",
    processFallbackThree: "验证结果并迭代。",
    processStep: (index: number) => `流程步骤 ${index}。`,
    imageHeroLabel: "视觉",
    imageHeroBody: "视觉区域用于承载安全占位图或已验证素材。"
  };

  if (language === "zh-CN") return zh;
  if (language === "ja") {
    return {
      ...zh,
      coreJudgment: "主要判断",
      keyImpact: "重要な影響",
      currentState: "現状",
      targetState: "目標",
      currentStateBody: "現状は意思決定の基準線を定義します。",
      targetStateBody: "目標状態は、その判断が重要な理由を明確にします。",
      verdict: "推奨される方向性は、根拠と聞き手のニーズに沿うべきです。",
      chartInsight: "このチャートは根拠データを判断しやすい視覚シグナルに変換します。",
      nextDecision: "この内容を具体的な次の意思決定につなげます。",
      cardBaseline: "基準線を明確にする。",
      cardImplication: "運用上の意味を示す。",
      cardDecisionPath: "意思決定の道筋に収束させる。",
      metricFallbacks: ["範囲", "根拠", "行動"],
      metricNote: "このシグナルでスライドの論点を支えます。",
      eventBaseline: "基準線を整理する。",
      eventPath: "実行経路を組み立てる。",
      eventScale: "有効な方法を広げる。",
      eventAction: "行動で締めくくる。",
      firstArgument: (title: string) => `${title} には明確な第一論点が必要です。`,
      evidenceToAction: (title: string) => `${title} は根拠を行動につなげる必要があります。`,
      point: (index: number) => `要点 ${index}`,
      supportingPoint: (index: number) => `補足要点 ${index}。`,
      step: (index: number) => `ステップ ${index}`,
      timelineEvent: (index: number) => `タイムライン項目 ${index}。`
      ,
      quoteAttribution: "重要な引用",
      quoteSupport: "このページは物語上の重要な転換点を強調します。",
      sectionSupport: "このセクションでは新しい論点に移ります。",
      statValue: "1",
      statLabel: "重要シグナル",
      statExplanation: "この数値は判断可能な意味につなげる必要があります。",
      quoteFallback: (title: string) => `${title} の重要な考えを明確に強調します。`,
      sectionMarker: (index: number) => fallbackSectionMarker(index),
      bulletGroupOne: "主要ポイント",
      bulletGroupTwo: "実行判断",
      bulletGroupThree: "制約",
      bulletGroupFour: "次の一手",
      bulletFallbackOne: "まず重要な問題を定義します。",
      bulletFallbackTwo: "次に根拠と制約を特定します。",
      bulletFallbackThree: "最後に実行可能な行動へ収束させます。",
      bulletFallbackFour: "振り返りと改善の余地を残します。",
      processLede: "複雑な行動を実行可能な手順に分解します。",
      processFallbackOne: "入力と境界を明確にします。",
      processFallbackTwo: "実行経路を構築します。",
      processFallbackThree: "結果を検証し改善します。",
      processStep: (index: number) => `プロセス手順 ${index}。`,
      imageHeroLabel: "ビジュアル",
      imageHeroBody: "ビジュアル領域は安全なプレースホルダーまたは検証済み素材を表示します。"
    };
  }
  if (language === "ko") {
    return {
      ...zh,
      coreJudgment: "핵심 판단",
      keyImpact: "주요 영향",
      currentState: "현재 상태",
      targetState: "목표 상태",
      currentStateBody: "현재 상태는 의사결정의 기준선을 정의합니다.",
      targetStateBody: "목표 상태는 이 결정이 중요한 이유를 명확히 합니다.",
      verdict: "권장 경로는 근거와 청중의 요구를 함께 반영해야 합니다.",
      chartInsight: "차트는 근거 데이터를 판단 가능한 시각 신호로 전환합니다.",
      nextDecision: "이 내용을 구체적인 다음 결정으로 연결합니다.",
      cardBaseline: "기준선을 명확히 정의합니다.",
      cardImplication: "운영상의 의미를 보여줍니다.",
      cardDecisionPath: "결정 경로로 수렴합니다.",
      metricFallbacks: ["범위", "근거", "행동"],
      metricNote: "이 신호로 슬라이드의 논점을 뒷받침합니다.",
      eventBaseline: "기준선을 정리합니다.",
      eventPath: "실행 경로를 만듭니다.",
      eventScale: "효과적인 방식을 확장합니다.",
      eventAction: "행동으로 마무리합니다.",
      firstArgument: (title: string) => `${title}에는 명확한 첫 번째 논점이 필요합니다.`,
      evidenceToAction: (title: string) => `${title}는 근거를 행동으로 연결해야 합니다.`,
      point: (index: number) => `요점 ${index}`,
      supportingPoint: (index: number) => `보조 요점 ${index}.`,
      step: (index: number) => `단계 ${index}`,
      timelineEvent: (index: number) => `타임라인 항목 ${index}.`
      ,
      quoteAttribution: "핵심 인용",
      quoteSupport: "이 페이지는 이야기의 중요한 전환점을 강조합니다.",
      sectionSupport: "이 섹션은 새로운 논증 단계로 이동합니다.",
      statValue: "1",
      statLabel: "핵심 신호",
      statExplanation: "이 숫자는 판단 가능한 의미로 연결되어야 합니다.",
      quoteFallback: (title: string) => `${title}의 핵심 관점을 명확히 강조합니다.`,
      sectionMarker: (index: number) => fallbackSectionMarker(index),
      bulletGroupOne: "핵심 요점",
      bulletGroupTwo: "실행 판단",
      bulletGroupThree: "제약",
      bulletGroupFour: "다음 단계",
      bulletFallbackOne: "먼저 핵심 문제를 정의합니다.",
      bulletFallbackTwo: "다음으로 근거와 제약을 식별합니다.",
      bulletFallbackThree: "마지막으로 실행 가능한 행동으로 정리합니다.",
      bulletFallbackFour: "회고와 반복 여지를 남깁니다.",
      processLede: "복잡한 행동을 실행 가능한 단계로 나눕니다.",
      processFallbackOne: "입력과 경계를 명확히 합니다.",
      processFallbackTwo: "실행 경로를 구축합니다.",
      processFallbackThree: "결과를 검증하고 반복합니다.",
      processStep: (index: number) => `프로세스 단계 ${index}.`,
      imageHeroLabel: "비주얼",
      imageHeroBody: "비주얼 영역은 안전한 플레이스홀더 또는 검증된 자산을 표시합니다."
    };
  }

  return {
    coreJudgment: "Core judgment",
    keyImpact: "Key impact",
    currentState: "Current state",
    targetState: "Target state",
    currentStateBody: "The current state defines the decision baseline.",
    targetStateBody: "The target state clarifies why the decision matters.",
    verdict: "The recommended path follows the evidence and audience need.",
    chartInsight: "The chart converts evidence data points into a visual decision signal.",
    nextDecision: "Turn the deck into a concrete next decision.",
    cardBaseline: "Define the baseline clearly.",
    cardImplication: "Show the operational implication.",
    cardDecisionPath: "Close with the decision path.",
    metricFallbacks: ["Scope", "Evidence", "Action"],
    metricNote: "Use this signal to guide the slide argument.",
    eventBaseline: "Clarify the baseline.",
    eventPath: "Build the operating path.",
    eventScale: "Scale what works.",
    eventAction: "Close with action.",
    firstArgument: (title: string) => `${title} requires a clear first argument.`,
    evidenceToAction: (title: string) => `${title} should connect evidence to action.`,
    point: (index: number) => `Point ${index}`,
    supportingPoint: (index: number) => `Supporting point ${index}.`,
    step: (index: number) => `Step ${index}`,
    timelineEvent: (index: number) => `Timeline event ${index}.`
    ,
    quoteAttribution: "Key source",
    quoteSupport: "Use this slide to emphasize the narrative turning point.",
    sectionSupport: "This section moves into a new layer of the argument.",
    statValue: "1",
    statLabel: "Key signal",
    statExplanation: "This number should connect to a decision-ready meaning.",
    quoteFallback: (title: string) => `${title} needs one decisive idea in focus.`,
    sectionMarker: (index: number) => fallbackSectionMarker(index),
    bulletGroupOne: "Core points",
    bulletGroupTwo: "Execution judgment",
    bulletGroupThree: "Constraints",
    bulletGroupFour: "Next move",
    bulletFallbackOne: "Define the key problem first.",
    bulletFallbackTwo: "Identify evidence and constraints next.",
    bulletFallbackThree: "Close with an executable action.",
    bulletFallbackFour: "Leave room for review and iteration.",
    processLede: "Break the complex action into executable steps.",
    processFallbackOne: "Clarify the inputs and boundaries.",
    processFallbackTwo: "Build the operating path.",
    processFallbackThree: "Verify results and iterate.",
    processStep: (index: number) => `Process step ${index}.`,
    imageHeroLabel: "Visual",
    imageHeroBody: "The visual area uses a safe placeholder or a verified asset reference."
  };
}

function fallbackSectionMarker(index: number): string {
  return String(Math.max(1, index)).padStart(2, "0");
}

function normalizeSectionMarker(value: unknown, slideIndex: number, fallbackValue: string): string {
  const candidate = stringValue(value, fallbackValue).trim();
  if (!candidate) {
    return fallbackSectionMarker(slideIndex);
  }
  if (/^\d{1,2}$/.test(candidate)) {
    return candidate.padStart(2, "0");
  }
  if (isGenericSectionMarker(candidate)) {
    return fallbackSectionMarker(slideIndex);
  }
  return candidate;
}

function normalizeSectionProgressText(
  value: unknown,
  slideIndex: number,
  totalSlides: number,
  fallbackValue?: string
): string | undefined {
  const candidate = optionalString(value)?.trim();
  if (!candidate) {
    return fallbackValue;
  }
  if (isGenericSectionMarker(candidate) || isGenericSectionProgress(candidate)) {
    return `${slideIndex} / ${totalSlides}`;
  }
  return candidate;
}

function isGenericSectionMarker(value: string): boolean {
  const input = value.trim();
  return [
    /^section[-_\s]?\d+$/i,
    /^第\s*\d+\s*[节部]$/u,
    /^섹션\s*\d+$/iu
  ].some((pattern) => pattern.test(input));
}

function isGenericSectionProgress(value: string): boolean {
  const input = value.trim();
  return [
    /^section[-_\s]?\d+\s*(?:of|\/|-)\s*\d+$/i,
    /^section\s+\d+\s+of\s+\d+$/i,
    /^第\s*\d+\s*[节部]\s*(?:\/|of|-)\s*\d+$/iu,
    /^섹션\s*\d+\s*(?:\/|of|-)\s*\d+$/iu
  ].some((pattern) => pattern.test(input));
}

function roleKicker(role: NarrativeSlideIR["role"]): string {
  return role.replace(/-/g, " ").toUpperCase();
}

function footerText(intent: IntentIR, slide: NarrativeSlideIR): string {
  return `${intent.topic} · ${String(slide.index).padStart(2, "0")}`;
}

function shortTitle(value: string, fallback: string): string {
  const first = value.split(/[。.!?；;]/)[0]?.trim();
  return (first || fallback).slice(0, 80);
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  const items = asArray(value).map((item) => stringValue(item, "").slice(0, 160)).filter(Boolean);
  return items.length ? items : fallback.map((item) => item.slice(0, 160));
}

function normalizeAccent(value: unknown, fallback?: "primary" | "secondary" | "neutral" | "good" | "warn" | "bad") {
  const allowed = ["primary", "secondary", "neutral", "good", "warn", "bad"] as const;
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as typeof allowed[number] : fallback;
}

function normalizeTimelineAccent(value: unknown, fallback?: "primary" | "secondary" | "neutral") {
  const allowed = ["primary", "secondary", "neutral"] as const;
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as typeof allowed[number] : fallback;
}

function normalizeChartType(value: unknown, fallback: Extract<SlideSlotFillIR, { kind: "chart" }>["chartType"]) {
  const allowed = ["bar", "line", "area", "pie", "doughnut", "radar"] as const;
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as typeof allowed[number] : fallback;
}

function chooseChartType(slide: NarrativeSlideIR): Extract<SlideSlotFillIR, { kind: "chart" }>["chartType"] {
  if (slide.role === "comparison") return "bar";
  if (slide.contentBrief.keyMetrics && slide.contentBrief.keyMetrics.length >= 4) return "radar";
  if (/趋势|增长|变化|未来|trend|growth|change/i.test(`${slide.contentBrief.headline} ${slide.beat}`)) return "line";
  return "bar";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 780) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 260) : undefined;
}
