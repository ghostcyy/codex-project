import { z } from "zod";
import { deckIrSchema, type DeckIR, type QualityScores } from "../ir";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

export type CriticKind = "factual" | "narrative" | "visual" | "density" | "accessibility";
export type CriticSeverity = "info" | "warn" | "block";

export type CriticIssue = {
  critic: CriticKind;
  slideIndex?: number;
  issue: string;
  severity: CriticSeverity;
  suggestedFix: string;
};

export type CriticRoundReport = {
  round: number;
  scores: QualityScores;
  aggregateScore: number;
  issues: CriticIssue[];
  appliedFixes: string[];
};

export type CriticStageInput = {
  deck: DeckIR;
  maxRounds?: number;
  model?: JsonOnlyModelClient;
};

export type CriticStageResult = {
  deck: DeckIR;
  source: "deterministic" | "llm-critic-loop";
  reports: CriticRoundReport[];
  warnings: string[];
  attempts: number;
};

export class CriticBlockedError extends Error {
  readonly code = "HTML_PPT_V2_CRITIC_BLOCKED";

  constructor(
    message: string,
    readonly issues: CriticIssue[],
    readonly reports: CriticRoundReport[],
    readonly finalReport: CriticRoundReport
  ) {
    super(message);
    this.name = "CriticBlockedError";
  }
}

export async function runCriticStage(input: CriticStageInput): Promise<CriticStageResult> {
  let current = cloneDeck(input.deck);
  const maxRounds = Math.max(1, Math.min(3, input.maxRounds ?? 3));
  const reports: CriticRoundReport[] = [];
  let previousScore = -1;
  const llmCritic = await runLlmCritic(input.deck, input.model);

  for (let round = 1; round <= maxRounds; round += 1) {
    const report = critiqueDeck(current, round, [], round === 1 ? llmCritic.issues : []);
    const { deck: revised, appliedFixes } = applyDeterministicFixes(current, report.issues);
    const finalReport = { ...report, appliedFixes };
    reports.push(finalReport);
    current = revised;

    if (finalReport.aggregateScore >= 0.92) {
      break;
    }

    if (!appliedFixes.length || finalReport.aggregateScore <= previousScore + 0.01) {
      break;
    }

    previousScore = finalReport.aggregateScore;
  }

  const finalReport = critiqueDeck(current, reports.length + 1, [], llmCritic.issues);
  const blockingIssues = finalReport.issues.filter((issue) => issue.severity === "block");
  if (blockingIssues.length) {
    const summary = blockingIssues
      .slice(0, 4)
      .map((issue) => `${issue.slideIndex ? `Slide ${issue.slideIndex}: ` : ""}${issue.issue}`)
      .join(" | ");
    throw new CriticBlockedError(`HTML-PPT v2 critic blocked publication: ${summary}`, blockingIssues, reports, finalReport);
  }

  const scoredDeck = deckIrSchema.parse({
    ...current,
    meta: {
      ...current.meta,
      revisionRound: reports.length,
      qualityScores: finalReport.scores,
      checkpoints: [
        ...current.meta.checkpoints.filter((checkpoint) => checkpoint.stage !== "stage-9:critic"),
        checkpoint("stage-9:critic", `Critic loop completed. score=${finalReport.aggregateScore.toFixed(2)}, rounds=${reports.length}`)
      ]
    }
  });

  return {
    deck: scoredDeck,
    source: llmCritic.attempts > 0 ? "llm-critic-loop" : "deterministic",
    reports,
    warnings: [
      ...llmCritic.warnings,
      ...finalReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.issue)
    ],
    attempts: llmCritic.attempts
  };
}

export function critiqueDeck(deck: DeckIR, round = 1, appliedFixes: string[] = [], externalIssues: CriticIssue[] = []): CriticRoundReport {
  const issues = [
    ...critiqueFactual(deck),
    ...critiqueNarrative(deck),
    ...critiqueVisual(deck),
    ...critiqueDensity(deck),
    ...critiqueAccessibility(deck),
    ...externalIssues
  ];
  const scores = scoreIssues(issues, deck);
  const aggregateScore = Number(scores.overall.toFixed(2));

  return {
    round,
    scores,
    aggregateScore,
    issues,
    appliedFixes
  };
}

const llmCriticIssueSchema = z.object({
  critic: z.enum(["narrative", "visual"]),
  slideIndex: z.number().int().min(1).max(80).optional(),
  issue: z.string().trim().min(1).max(320),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
  suggestedFix: z.string().trim().min(1).max(260)
}).strict();

const llmCriticResponseSchema = z.object({
  issues: z.array(llmCriticIssueSchema).max(10).default([])
}).strict();

async function runLlmCritic(deck: DeckIR, model?: JsonOnlyModelClient): Promise<{ issues: CriticIssue[]; warnings: string[]; attempts: number }> {
  if (!model) {
    return { issues: [], warnings: [], attempts: 0 };
  }
  try {
    const raw = await model.completeJson({
      stage: "09-critic",
      temperature: 0,
      maxAttempts: 2,
      system: [
        "You are the HTML-PPT v2 critic.",
        "Return JSON only: {\"issues\":[...]}",
        "Only inspect narrative coherence and visual consistency.",
        "Do not comment on facts, citations, or accessibility.",
        "Use severity warn or info unless the deck is structurally unusable."
      ].join("\n"),
      user: buildLlmCriticPrompt(deck)
    });
    const parsed = llmCriticResponseSchema.safeParse(parseJsonLike(raw));
    if (!parsed.success) {
      return {
        issues: [],
        warnings: [`LLM critic returned invalid JSON: ${formatZodError(parsed.error)}`],
        attempts: 1
      };
    }
    return {
      issues: parsed.data.issues.map((issue) => ({
        ...issue,
        // First-pass LLM critic is advisory to avoid model hallucinations blocking publication.
        severity: issue.severity === "block" ? "warn" : issue.severity
      })),
      warnings: [],
      attempts: 1
    };
  } catch (error) {
    return {
      issues: [],
      warnings: [`LLM critic skipped: ${error instanceof Error ? error.message : String(error)}`],
      attempts: 1
    };
  }
}

function buildLlmCriticPrompt(deck: DeckIR): string {
  const slides = deck.narrative.slides.map((slide) => {
    const slot = deck.slots.find((item) => item.slideIndex === slide.index);
    return {
      index: slide.index,
      role: slide.role,
      headline: slide.contentBrief.headline,
      beat: slide.beat,
      layout: slot?.kind ?? "missing",
      supportingPoints: slide.contentBrief.supportingPoints.slice(0, 4)
    };
  });
  return JSON.stringify({
    topic: deck.intent.topic,
    audience: deck.intent.audience,
    language: deck.intent.language,
    themeId: deck.design.themeId,
    donorTemplateId: deck.design.donorTemplateId,
    deckClass: deck.design.deckClass,
    animationBudget: deck.design.animationBudget,
    slides
  }, null, 2);
}

function critiqueFactual(deck: DeckIR): CriticIssue[] {
  const issues: CriticIssue[] = [];
  const availableCitationKeys = new Set([
    ...deck.evidence.facts.map((fact) => fact.citationKey),
    ...deck.evidence.dataPoints.map((point) => point.citationKey)
  ]);

  for (const slot of deck.slots) {
    const narrative = deck.narrative.slides.find((slide) => slide.index === slot.slideIndex);
    if (!slot.citationKeys.length && narrative?.contentBrief.evidenceRefs.length) {
      issues.push({
        critic: "factual",
        slideIndex: slot.slideIndex,
        issue: `Slide ${slot.slideIndex} slot has no citationKeys but narrative has evidenceRefs.`,
        severity: "warn",
        suggestedFix: "Copy narrative evidenceRefs into the slot citationKeys."
      });
    }

    for (const citationKey of slot.citationKeys) {
      if (!availableCitationKeys.has(citationKey)) {
        issues.push({
          critic: "factual",
          slideIndex: slot.slideIndex,
          issue: `Slide ${slot.slideIndex} references unresolved citationKey '${citationKey}'.`,
          severity: "block",
          suggestedFix: "Remove unresolved citation key or replace with a known EvidencePack key."
        });
      }
    }
  }

  if (deck.evidence.knownGaps.length) {
    issues.push({
      critic: "factual",
      issue: `EvidencePack has known gaps: ${deck.evidence.knownGaps.slice(0, 2).join("; ")}`,
      severity: "warn",
      suggestedFix: "Use sourced research before final publication for time-sensitive claims."
    });
  }

  return issues;
}

function critiqueNarrative(deck: DeckIR): CriticIssue[] {
  const issues: CriticIssue[] = [];
  if (deck.narrative.slides.length !== deck.intent.derivedSlideCount) {
    issues.push({
      critic: "narrative",
      issue: `Narrative has ${deck.narrative.slides.length} slides but intent requires ${deck.intent.derivedSlideCount}.`,
      severity: "block",
      suggestedFix: "Regenerate NarrativeIR from Stage 3."
    });
  }

  if (deck.narrative.totalEstimatedChars < deck.intent.derivedNarrativeChars) {
    issues.push({
      critic: "narrative",
      issue: `Narrative chars ${deck.narrative.totalEstimatedChars} below required ${deck.intent.derivedNarrativeChars}.`,
      severity: "block",
      suggestedFix: "Increase per-slide estimatedNarrativeChars or regenerate NarrativeIR."
    });
  }

  if (deck.narrative.slides[0]?.role !== "cover") {
    issues.push({
      critic: "narrative",
      slideIndex: 1,
      issue: "First slide is not a cover.",
      severity: "warn",
      suggestedFix: "Set first slide role to cover and layout to cover."
    });
  }

  const transitionPairs = new Set(deck.narrative.transitions.map((transition) => `${transition.fromSlide}->${transition.toSlide}`));
  for (let index = 1; index < deck.narrative.slides.length; index += 1) {
    const previousSlide = deck.narrative.slides[index - 1]!;
    const currentSlide = deck.narrative.slides[index]!;
    const from = previousSlide.index;
    const to = currentSlide.index;
    const previousHeadline = normalizeHeadline(previousSlide.contentBrief.headline);
    const currentHeadline = normalizeHeadline(currentSlide.contentBrief.headline);
    if (previousHeadline && previousHeadline === currentHeadline) {
      issues.push({
        critic: "narrative",
        slideIndex: to,
        issue: `Slide ${from} and slide ${to} share the same headline "${currentSlide.contentBrief.headline}".`,
        severity: "block",
        suggestedFix: "Rename one slide or merge the repeated content into a single slide."
      });
    }
    if (!transitionPairs.has(`${from}->${to}`)) {
      issues.push({
        critic: "narrative",
        slideIndex: to,
        issue: `Missing transition bridge from slide ${from} to ${to}.`,
        severity: "info",
        suggestedFix: "Add adjacent transition bridge."
      });
    }
  }

  return issues;
}

function normalizeHeadline(value: string): string {
  return value.replace(/\s+/g, "").trim().toLocaleLowerCase();
}

function critiqueVisual(deck: DeckIR): CriticIssue[] {
  const issues: CriticIssue[] = [];
  if (!deck.design.contrastReport.passed) {
    issues.push({
      critic: "visual",
      issue: "Locked theme does not pass contrast report.",
      severity: "block",
      suggestedFix: "Return to Stage 4 and choose a passing theme."
    });
  }

  const fxCount = deck.choreography.filter((item) => item.fx && item.fx !== "none").length;
  if (fxCount > deck.design.animationBudget.maxAccentSlides) {
    issues.push({
      critic: "visual",
      issue: `FX assigned to ${fxCount} slides, above budget ${deck.design.animationBudget.maxAccentSlides}.`,
      severity: "warn",
      suggestedFix: "Drop extra FX assignments after budget is reached."
    });
  }

  const allowedAnims = new Set(deck.design.animationBudget.allowedAnims);
  for (const item of deck.choreography) {
    if (item.entrance && !allowedAnims.has(item.entrance)) {
      issues.push({
        critic: "visual",
        slideIndex: item.slideIndex,
        issue: `Entrance animation '${item.entrance}' is outside animation budget.`,
        severity: "warn",
        suggestedFix: "Replace entrance with 'none' or a budgeted animation."
      });
    }
  }

  return issues;
}

function critiqueDensity(deck: DeckIR): CriticIssue[] {
  const issues: CriticIssue[] = [];
  for (const slot of deck.slots) {
    const textLength = estimateSlotTextLength(slot);
    const limit = slot.kind === "cover" || slot.kind === "toc" || slot.kind === "cta" ? 520 : 1100;
    if (textLength > limit) {
      issues.push({
        critic: "density",
        slideIndex: slot.slideIndex,
        issue: `Slide ${slot.slideIndex} ${slot.kind} slot has estimated text length ${textLength}, above ${limit}.`,
        severity: "warn",
        suggestedFix: "Shorten slot text or choose a denser layout."
      });
    }

    if (slot.kind === "three-column" && slot.cards.some((card) => !card.body.trim())) {
      issues.push({
        critic: "density",
        slideIndex: slot.slideIndex,
        issue: "Three-column slot contains an empty card body.",
        severity: "block",
        suggestedFix: "Fill every card body."
      });
    }
  }

  return issues;
}

function critiqueAccessibility(deck: DeckIR): CriticIssue[] {
  const issues: CriticIssue[] = [];
  if (!deck.intent.language) {
    issues.push({
      critic: "accessibility",
      issue: "Intent language is missing.",
      severity: "block",
      suggestedFix: "Set deck language for the HTML lang attribute."
    });
  }

  for (const [assetKey, asset] of Object.entries(deck.assets)) {
    if ((asset.kind === "photo" || asset.kind === "illustration") && !asset.alt.trim()) {
      issues.push({
        critic: "accessibility",
        issue: `Image asset '${assetKey}' is missing alt text.`,
        severity: "block",
        suggestedFix: "Add descriptive alt text."
      });
    }
  }

  if (deck.design.contrastReport.minContrastRatio < 4.5) {
    issues.push({
      critic: "accessibility",
      issue: `Minimum theme contrast ${deck.design.contrastReport.minContrastRatio} is below WCAG AA.`,
      severity: "block",
      suggestedFix: "Choose a higher-contrast theme."
    });
  }

  return issues;
}

function applyDeterministicFixes(deck: DeckIR, issues: CriticIssue[]) {
  const revised = cloneDeck(deck);
  const appliedFixes: string[] = [];
  const availableCitationKeys = new Set([
    ...revised.evidence.facts.map((fact) => fact.citationKey),
    ...revised.evidence.dataPoints.map((point) => point.citationKey)
  ]);

  for (const issue of issues) {
    if (issue.critic === "factual" && issue.slideIndex && issue.issue.includes("slot has no citationKeys")) {
      const slot = revised.slots.find((item) => item.slideIndex === issue.slideIndex);
      const slide = revised.narrative.slides.find((item) => item.index === issue.slideIndex);
      if (slot && slide) {
        slot.citationKeys = slide.contentBrief.evidenceRefs.filter((key) => availableCitationKeys.has(key)).slice(0, 12);
        appliedFixes.push(`Copied narrative evidenceRefs to slot ${issue.slideIndex}.`);
      }
    }

    if (issue.critic === "visual" && issue.issue.startsWith("FX assigned")) {
      let used = 0;
      for (const item of revised.choreography) {
        if (item.fx && item.fx !== "none") {
          used += 1;
          if (used > revised.design.animationBudget.maxAccentSlides) {
            item.fx = "none";
            appliedFixes.push(`Dropped excess FX from slide ${item.slideIndex}.`);
          }
        }
      }
    }

    if (issue.critic === "visual" && issue.slideIndex && issue.issue.includes("outside animation budget")) {
      const item = revised.choreography.find((entry) => entry.slideIndex === issue.slideIndex);
      if (item) {
        item.entrance = revised.design.animationBudget.allowedAnims.includes("none") ? "none" : revised.design.animationBudget.allowedAnims[0] ?? null;
        appliedFixes.push(`Replaced out-of-budget entrance on slide ${issue.slideIndex}.`);
      }
    }

    if (issue.critic === "narrative" && issue.slideIndex && issue.issue.startsWith("Missing transition bridge")) {
      const toSlide = revised.narrative.slides.find((slide) => slide.index === issue.slideIndex);
      const fromSlide = revised.narrative.slides.find((slide) => slide.index === (issue.slideIndex ?? 0) - 1);
      if (fromSlide && toSlide) {
        revised.narrative.transitions.push({
          fromSlide: fromSlide.index,
          toSlide: toSlide.index,
          bridge: `Move from ${fromSlide.contentBrief.headline} to ${toSlide.contentBrief.headline}.`
        });
        appliedFixes.push(`Added transition bridge ${fromSlide.index}->${toSlide.index}.`);
      }
    }
  }

  return { deck: deckIrSchema.parse(revised), appliedFixes };
}

function scoreIssues(issues: CriticIssue[], deck: DeckIR): QualityScores {
  const scoreFor = (critic: CriticKind, base: number) => {
    const relevant = issues.filter((issue) => issue.critic === critic);
    const penalty = relevant.reduce((sum, issue) => sum + severityPenalty(issue.severity), 0);
    return clampScore(base - penalty);
  };
  const factual = scoreFor("factual", deck.evidence.knownGaps.length ? 0.76 : 0.9);
  const narrative = scoreFor("narrative", 0.88);
  const visual = scoreFor("visual", deck.design.contrastReport.passed ? 0.9 : 0.4);
  const density = scoreFor("density", 0.86);
  const accessibility = scoreFor("accessibility", deck.design.contrastReport.passed ? 0.92 : 0.45);
  const overall = clampScore((factual + narrative + visual + density + accessibility) / 5);

  return {
    factual,
    narrative,
    visual,
    density,
    accessibility,
    overall
  };
}

function severityPenalty(severity: CriticSeverity): number {
  if (severity === "block") return 0.22;
  if (severity === "warn") return 0.1;
  return 0.03;
}

function clampScore(value: number) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function estimateSlotTextLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateSlotTextLength(item), 0);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["slideIndex", "kind", "citationKeys", "footer"].includes(key))
      .reduce((sum, [, item]) => sum + estimateSlotTextLength(item), 0);
  }
  return 0;
}

function cloneDeck(deck: DeckIR): DeckIR {
  return JSON.parse(JSON.stringify(deck)) as DeckIR;
}

function checkpoint(stage: "stage-9:critic", summary: string) {
  const now = new Date().toISOString();
  return {
    stage,
    status: "completed" as const,
    startedAt: now,
    completedAt: now,
    summary
  };
}
