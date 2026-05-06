import { z } from "zod";
import type { IntentIR } from "../ir";
import type { SkillRegistry, TemplatePackage } from "../registry";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

const templateSelectSchema = z.object({
  chosenTemplateId: z.string().trim().min(1),
  rationale: z.string().trim().min(1).max(500),
  confidence: z.enum(["high", "medium", "low"]).default("medium")
}).strict();

const MIN_SHORTLIST_SIZE = 3;
const MAX_SHORTLIST_SIZE = 5;

export type TemplateSelectionSource = "pinned" | "auto-deterministic" | "auto-llm";

export type TemplateSelectionScoreBreakdown = {
  audience: number;
  format: number;
  tone: number;
  promptSignals: number;
  forbidPromptSignals: number;
  slideCount: number;
  matchedPromptSignals: string[];
  matchedForbidPromptSignals: string[];
  slideDelta: number;
};

export type TemplateSelectionCandidate = {
  id: string;
  deterministicScore: number;
  reason: string;
  breakdown?: TemplateSelectionScoreBreakdown;
};

export type TemplateSelectionResult = {
  selectedTemplate: TemplatePackage;
  source: TemplateSelectionSource;
  attempts: number;
  shortlist: TemplateSelectionCandidate[];
  rationale: string;
  confidence: "high" | "medium" | "low";
  validationErrors: string[];
};

export type TemplateSelectionStageInput = {
  intent: IntentIR;
  registry: SkillRegistry;
  rawPrompt?: string;
  pinnedTemplate?: TemplatePackage;
  model?: JsonOnlyModelClient;
};

export async function runTemplateSelectionStage(input: TemplateSelectionStageInput): Promise<TemplateSelectionResult> {
  if (input.pinnedTemplate) {
    const candidate = pinnedCandidate(input.pinnedTemplate);
    return {
      selectedTemplate: input.pinnedTemplate,
      source: "pinned",
      attempts: 0,
      shortlist: [candidate],
      rationale: buildSelectionRationale({
        mode: "pinned",
        shortlist: [candidate],
        chosenId: input.pinnedTemplate.id,
        confidence: "high",
        reason: "Template was explicitly selected by the user."
      }),
      confidence: "high",
      validationErrors: []
    };
  }

  const validationErrors: string[] = [];
  const rankedCandidates = rankTemplateCandidates(input);
  const shortlist = buildShortlist(rankedCandidates);
  const deterministicTop = shortlist[0];
  const fallbackTemplate = resolveTemplate(input.registry, deterministicTop?.id) ?? input.registry.templatePackages[0];
  if (!fallbackTemplate) {
    throw new Error("HTML-PPT v2 registry has no template packages.");
  }

  if (input.model && shortlist.length) {
    const prompt = buildTemplateSelectPrompt(input, shortlist);
    const raw = await input.model.completeJson({
      stage: "01b-template-select",
      system: prompt.system,
      user: prompt.user,
      temperature: 0,
      maxAttempts: 1
    });
    const parsed = templateSelectSchema.safeParse(parseJsonLike(raw));
    if (parsed.success) {
      const chosen = shortlist.find((candidate) => candidate.id === parsed.data.chosenTemplateId);
      const selectedTemplate = resolveTemplate(input.registry, parsed.data.chosenTemplateId);
      if (chosen && selectedTemplate && parsed.data.confidence !== "low") {
        return {
          selectedTemplate,
          source: "auto-llm",
          attempts: 1,
          shortlist,
          rationale: buildSelectionRationale({
            mode: "auto-llm",
            shortlist,
            chosenId: selectedTemplate.id,
            confidence: parsed.data.confidence,
            reason: parsed.data.rationale
          }),
          confidence: parsed.data.confidence,
          validationErrors
        };
      }
      validationErrors.push(
        `Model selected '${parsed.data.chosenTemplateId}' with confidence='${parsed.data.confidence}', but it must choose a high/medium-confidence id from the shortlist.`
      );
    } else {
      validationErrors.push(formatZodError(parsed.error));
    }
  }

  return {
    selectedTemplate: fallbackTemplate,
    source: "auto-deterministic",
    attempts: input.model ? 1 : 0,
    shortlist,
    rationale: buildSelectionRationale({
      mode: "auto-deterministic",
      shortlist,
      chosenId: fallbackTemplate.id,
      confidence: "medium",
      reason: validationErrors.length
        ? `Model output rejected; deterministic top-1 retained. ${deterministicTop?.reason ?? `Fallback to first registry template '${fallbackTemplate.id}'.`}`
        : `Deterministic top-1 selected. ${deterministicTop?.reason ?? `Fallback to first registry template '${fallbackTemplate.id}'.`}`
    }),
    confidence: "medium",
    validationErrors
  };
}

export function rankTemplateCandidates(input: Pick<TemplateSelectionStageInput, "intent" | "registry" | "rawPrompt">): TemplateSelectionCandidate[] {
  const corpus = buildCorpus(input.intent, input.rawPrompt);
  return input.registry.templatePackages
    .map((template) => scoreTemplate(template, input.intent, corpus))
    .sort((a, b) => {
      if (b.deterministicScore !== a.deterministicScore) return b.deterministicScore - a.deterministicScore;
      return a.id.localeCompare(b.id);
    });
}

function buildShortlist(candidates: TemplateSelectionCandidate[]): TemplateSelectionCandidate[] {
  const count = Math.min(MAX_SHORTLIST_SIZE, Math.max(MIN_SHORTLIST_SIZE, candidates.length));
  return candidates.slice(0, count);
}

function scoreTemplate(template: TemplatePackage, intent: IntentIR, corpus: string): TemplateSelectionCandidate {
  const reasonParts: string[] = [];
  let score = 0;

  if (template.audienceFit.includes(intent.audience)) {
    score += 4;
    reasonParts.push(`audience +4 (${intent.audience})`);
  } else {
    reasonParts.push(`audience +0 (${intent.audience})`);
  }
  if (template.formatFit.includes(intent.format)) {
    score += 3;
    reasonParts.push(`format +3 (${intent.format})`);
  } else {
    reasonParts.push(`format +0 (${intent.format})`);
  }
  if (template.toneFit.includes(intent.tone)) {
    score += 2;
    reasonParts.push(`tone +2 (${intent.tone})`);
  } else {
    reasonParts.push(`tone +0 (${intent.tone})`);
  }

  const matchedSignals = template.promptSignals.filter((signal) => corpusIncludes(corpus, signal)).slice(0, 5);
  const promptSignalScore = Math.min(6, matchedSignals.length * 1.5);
  if (matchedSignals.length) {
    score += promptSignalScore;
    reasonParts.push(`signals ${formatScore(promptSignalScore)} (${matchedSignals.join("|")})`);
  } else {
    reasonParts.push("signals +0");
  }

  const forbiddenSignals = template.forbidPromptSignals.filter((signal) => corpusIncludes(corpus, signal)).slice(0, 5);
  const forbiddenSignalScore = forbiddenSignals.length ? -8 : 0;
  if (forbiddenSignals.length) {
    score += forbiddenSignalScore;
    reasonParts.push(`forbid ${formatScore(forbiddenSignalScore)} (${forbiddenSignals.join("|")})`);
  } else {
    reasonParts.push("forbid +0");
  }

  const slideDelta = Math.abs(template.defaultSlideCount - intent.derivedSlideCount);
  const slideCountScore = scoreSlideCountCloseness(slideDelta);
  score += slideCountScore;
  reasonParts.push(`slideCount ${formatScore(slideCountScore)} (default=${template.defaultSlideCount}, delta=${slideDelta})`);

  return {
    id: template.id,
    deterministicScore: Number(score.toFixed(2)),
    reason: reasonParts.join("; "),
    breakdown: {
      audience: template.audienceFit.includes(intent.audience) ? 4 : 0,
      format: template.formatFit.includes(intent.format) ? 3 : 0,
      tone: template.toneFit.includes(intent.tone) ? 2 : 0,
      promptSignals: promptSignalScore,
      forbidPromptSignals: forbiddenSignalScore,
      slideCount: slideCountScore,
      matchedPromptSignals: matchedSignals,
      matchedForbidPromptSignals: forbiddenSignals,
      slideDelta
    }
  };
}

function pinnedCandidate(template: TemplatePackage): TemplateSelectionCandidate {
  return {
    id: template.id,
    deterministicScore: 999,
    reason: "Template was explicitly selected by the user.",
    breakdown: {
      audience: 0,
      format: 0,
      tone: 0,
      promptSignals: 0,
      forbidPromptSignals: 0,
      slideCount: 0,
      matchedPromptSignals: [],
      matchedForbidPromptSignals: [],
      slideDelta: 0
    }
  };
}

function scoreSlideCountCloseness(slideDelta: number): number {
  if (slideDelta === 0) return 2;
  if (slideDelta === 1) return 1.5;
  if (slideDelta === 2) return 1;
  if (slideDelta <= 4) return 0.5;
  if (slideDelta >= 8) return -1;
  return 0;
}

function formatScore(value: number): string {
  return value > 0 ? `+${Number(value.toFixed(2))}` : `${Number(value.toFixed(2))}`;
}

function buildSelectionRationale(input: {
  mode: TemplateSelectionSource;
  shortlist: TemplateSelectionCandidate[];
  chosenId: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}): string {
  const shortlistTrace = input.shortlist
    .map((candidate) => `${candidate.id}:${candidate.deterministicScore}`)
    .join(", ");
  return [
    `mode=${input.mode}`,
    `shortlist=[${shortlistTrace}]`,
    `breakdown=[${formatShortlistBreakdown(input.shortlist)}]`,
    `chosen=${input.chosenId}`,
    `confidence=${input.confidence}`,
    `reason=${input.reason.trim()}`
  ].join("; ");
}

function formatShortlistBreakdown(shortlist: TemplateSelectionCandidate[]): string {
  return shortlist
    .map((candidate) => {
      const breakdown = publicBreakdown(candidate);
      return [
        `${candidate.id}{`,
        `audienceFit=${formatScore(breakdown.audienceFit)}`,
        `formatFit=${formatScore(breakdown.formatFit)}`,
        `toneFit=${formatScore(breakdown.toneFit)}`,
        `promptSignals=${formatScore(breakdown.promptSignals)}`,
        `forbidPromptSignals=${formatScore(breakdown.forbidPromptSignals)}`,
        `defaultSlideCount=${formatScore(breakdown.defaultSlideCount)}`,
        "}"
      ].join("");
    })
    .join(",");
}

function publicBreakdown(candidate: TemplateSelectionCandidate) {
  return {
    audienceFit: candidate.breakdown?.audience ?? 0,
    formatFit: candidate.breakdown?.format ?? 0,
    toneFit: candidate.breakdown?.tone ?? 0,
    promptSignals: candidate.breakdown?.promptSignals ?? 0,
    forbidPromptSignals: candidate.breakdown?.forbidPromptSignals ?? 0,
    defaultSlideCount: candidate.breakdown?.slideCount ?? 0
  };
}

function buildTemplateSelectPrompt(input: TemplateSelectionStageInput, shortlist: TemplateSelectionCandidate[]) {
  const templates = shortlist.map((candidate) => {
    const template = resolveTemplate(input.registry, candidate.id);
    return {
      id: candidate.id,
      score: candidate.deterministicScore,
      reason: candidate.reason,
      scoreBreakdown: candidate.breakdown,
      label: template?.label.en ?? candidate.id,
      description: template?.description.en ?? "",
      audienceFit: template?.audienceFit ?? [],
      formatFit: template?.formatFit ?? [],
      toneFit: template?.toneFit ?? [],
      themeId: template?.themeId,
      donorTemplateId: template?.donorTemplateId,
      embeddingPrompt: template?.embeddingPrompt
    };
  });

  return {
    system: [
      "You are the HTML-PPT v2 template selector.",
      "Return strict JSON only.",
      "Choose exactly one template id from the provided shortlist.",
      "Do not invent template ids.",
      "If no candidate is clearly better than the top deterministic score, choose the top-ranked candidate."
    ].join("\n"),
    user: JSON.stringify({
      task: "Select the best template package before design/layout stages.",
      outputSchema: {
        chosenTemplateId: "one id from shortlist",
        rationale: "short reason, <= 500 chars",
        confidence: "high | medium | low"
      },
      intent: {
        topic: input.intent.topic,
        language: input.intent.language,
        audience: input.intent.audience,
        tone: input.intent.tone,
        format: input.intent.format,
        slideCount: input.intent.derivedSlideCount,
        narrativeChars: input.intent.derivedNarrativeChars,
        requiredSections: input.intent.hardConstraints.requiredSections,
        aestheticHints: input.intent.preferences.aestheticHints,
        domainTerminology: input.intent.preferences.domainTerminology
      },
      shortlist: templates,
      rawPrompt: input.rawPrompt ?? ""
    }, null, 2)
  };
}

function buildCorpus(intent: IntentIR, rawPrompt?: string): string {
  return [
    rawPrompt,
    intent.topic,
    intent.language,
    intent.audience,
    intent.tone,
    intent.format,
    ...intent.hardConstraints.requiredSections,
    ...intent.preferences.aestheticHints,
    ...intent.preferences.forbiddenThemes,
    ...intent.preferences.domainTerminology
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function corpusIncludes(corpus: string, signal: string): boolean {
  return corpus.includes(signal.trim().toLowerCase());
}

function resolveTemplate(registry: SkillRegistry, id: string | undefined): TemplatePackage | undefined {
  return id ? registry.templatePackages.find((template) => template.id === id) : undefined;
}
