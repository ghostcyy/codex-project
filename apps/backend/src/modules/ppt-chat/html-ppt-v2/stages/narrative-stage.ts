import { buildNarrativePrompt } from "../prompts";
import { visibleEvidenceCitationKeys, visibleEvidenceDataPoints, visibleEvidenceFacts, visibleEvidenceTerminology } from "../evidence-helpers";
import {
  narrativeIrSchema,
  type DensityBudgetId,
  type EvidencePack,
  type IntentIR,
  type NarrativeIR,
  type NarrativeSlideIR,
  type SlideRoleId
} from "../ir";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

export type NarrativeStageInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  model?: JsonOnlyModelClient;
};

export type NarrativeStageResult = {
  narrative: NarrativeIR;
  source: "model" | "fallback";
  attempts: number;
  validationErrors: string[];
};

export async function runNarrativeStage(input: NarrativeStageInput): Promise<NarrativeStageResult> {
  const validationErrors: string[] = [];
  let modelCalls = 0;

  if (input.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildNarrativePrompt({
        intent: input.intent,
        evidence: input.evidence,
        validationError: validationErrors.at(-1)
      });
      const candidateCount = attempt === 1 ? creativeCandidateCount("HTML_PPT_V2_NARRATIVE_CANDIDATES") : 1;
      const rawCandidates = await requestNarrativeCandidates(input.model, {
        stage: "03-narrative",
        system: prompt.system,
        user: prompt.user,
        candidateCount,
        temperature: candidateCount > 1 ? 0.28 : 0
      });
      modelCalls += rawCandidates.calls;

      const evaluated = rawCandidates.values.map((raw) => evaluateNarrativeCandidate(raw, input));
      const valid = evaluated.filter((item): item is EvaluatedNarrativeCandidate & { narrative: NarrativeIR } => Boolean(item.narrative));
      if (valid.length) {
        const best = valid.sort((a, b) => b.score - a.score)[0]!;
        return {
          narrative: best.narrative,
          source: "model",
          attempts: modelCalls,
          validationErrors
        };
      }

      validationErrors.push(evaluated.map((item, index) => `candidate ${index + 1}: ${item.error}`).join("; "));
    }
  }

  const fallback = narrativeIrSchema.parse(buildFallbackNarrative(input.intent, input.evidence));
  return {
    narrative: fallback,
    source: "fallback",
    attempts: input.model ? modelCalls : 0,
    validationErrors
  };
}

export function validateNarrativeAgainstIntentAndEvidence(narrative: NarrativeIR, intent: IntentIR, evidence: EvidencePack): string[] {
  const issues: string[] = [];
  if (narrative.slides.length !== intent.derivedSlideCount) {
    issues.push(`slides.length must equal IntentIR.derivedSlideCount (${intent.derivedSlideCount}), got ${narrative.slides.length}`);
  }
  if (narrative.totalEstimatedChars < intent.derivedNarrativeChars) {
    issues.push(`totalEstimatedChars must be at least IntentIR.derivedNarrativeChars (${intent.derivedNarrativeChars}), got ${narrative.totalEstimatedChars}`);
  }

  const availableCitationKeys = getAvailableCitationKeys(evidence);
  for (const slide of narrative.slides) {
    for (const citationKey of slide.contentBrief.evidenceRefs) {
      if (!availableCitationKeys.has(citationKey)) {
        issues.push(`slide ${slide.index} references unknown citationKey '${citationKey}'`);
      }
    }
  }

  if (narrative.slides[0]?.role !== "cover") {
    issues.push("slide 1 should use role 'cover'");
  }
  if (intent.derivedSlideCount >= 5 && !narrative.slides.some((slide) => slide.role === "toc")) {
    issues.push("decks with 5+ slides should include one toc slide");
  }

  return issues;
}

function normalizeNarrativeCandidate(raw: unknown, intent: IntentIR, evidence: EvidencePack): unknown {
  const value = parseJsonLike(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Partial<NarrativeIR>;
  const slidesRaw = Array.isArray(candidate.slides) ? candidate.slides : [];
  const availableCitationKeys = [...getAvailableCitationKeys(evidence)];
  const dataPointLabels = visibleEvidenceDataPoints(evidence).map((point) => point.metric).slice(0, 8);
  const slides = slidesRaw.map((slideRaw, offset) => normalizeNarrativeSlide(slideRaw, offset, intent, availableCitationKeys, dataPointLabels));
  const totalEstimatedChars = Math.max(
    Number(candidate.totalEstimatedChars ?? 0),
    slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0)
  );

  return {
    arc: normalizeArc(candidate.arc, intent),
    slides,
    totalEstimatedChars,
    transitions: normalizeTransitions(candidate.transitions, slides)
  };
}

function normalizeNarrativeSlide(
  slideRaw: unknown,
  offset: number,
  intent: IntentIR,
  citationKeys: string[],
  dataPointLabels: string[]
): NarrativeSlideIR {
  const slide = asRecord(slideRaw);
  const contentBrief = asRecord(slide.contentBrief);
  const role = normalizeRole(slide.role, offset, intent.derivedSlideCount);
  const supportingPoints = asArray(contentBrief.supportingPoints)
    .map((point) => stringValue(point, ""))
    .filter(Boolean)
    .slice(0, 12);
  const evidenceRefs = asArray(contentBrief.evidenceRefs)
    .map((ref) => stringValue(ref, ""))
    .filter((ref) => citationKeys.includes(ref))
    .slice(0, 12);
  const keyMetrics = asArray(contentBrief.keyMetrics)
    .map((metric) => stringValue(metric, ""))
    .filter(Boolean)
    .slice(0, 8);

  return {
    index: offset + 1,
    role,
    beat: stringValue(slide.beat, beatForRole(role, intent.topic)).slice(0, 160),
    contentBrief: {
      headline: stringValue(contentBrief.headline, headlineForRole(role, intent.topic, offset)).slice(0, 160),
      ...(optionalString(contentBrief.subhead) ? { subhead: optionalString(contentBrief.subhead) } : {}),
      supportingPoints: supportingPoints.length ? supportingPoints : [fallbackSupportingPoint(role, intent.topic)],
      evidenceRefs: evidenceRefs.length ? evidenceRefs : citationKeys.slice(0, Math.min(2, citationKeys.length)),
      ...(keyMetrics.length || dataPointLabels.length
        ? { keyMetrics: keyMetrics.length ? keyMetrics : dataPointLabels.slice(0, 3) }
        : {})
    },
    densityBudget: normalizeDensity(slide.densityBudget, role),
    estimatedNarrativeChars: normalizeEstimate(slide.estimatedNarrativeChars, role, intent)
  };
}

function buildFallbackNarrative(intent: IntentIR, evidence: EvidencePack): NarrativeIR {
  const count = intent.derivedSlideCount;
  const citationKeys = [...getAvailableCitationKeys(evidence)];
  const dataPointLabels = visibleEvidenceDataPoints(evidence).map((point) => point.metric).slice(0, 8);
  const roles = roleSequence(count);
  const requiredSections = intent.hardConstraints.requiredSections;
  const factClaims = visibleEvidenceFacts(evidence).map((fact) => fact.claim);
  const chars = distributeNarrativeChars(intent.derivedNarrativeChars, roles);
  const slides: NarrativeSlideIR[] = roles.map((role, offset) => {
    const section = requiredSections[offset - 2] || "";
    const headline = role === "cover"
      ? intent.topic
      : role === "toc"
        ? "内容地图"
        : role === "cta" || role === "thanks"
          ? "下一步行动"
          : section || headlineFromClaim(factClaims[offset % Math.max(1, factClaims.length)], role, intent.topic, offset);

    return {
      index: offset + 1,
      role,
      beat: beatForRole(role, intent.topic),
      contentBrief: {
        headline,
        ...(role === "cover" ? { subhead: `${intent.format} for ${intent.audience}` } : {}),
        supportingPoints: supportingPointsForSlide(role, intent, evidence, offset),
        evidenceRefs: citationKeys.slice(offset % Math.max(1, citationKeys.length), offset % Math.max(1, citationKeys.length) + 2).length
          ? citationKeys.slice(offset % Math.max(1, citationKeys.length), offset % Math.max(1, citationKeys.length) + 2)
          : citationKeys.slice(0, 2),
        ...(role === "data-highlight" && dataPointLabels.length ? { keyMetrics: dataPointLabels.slice(0, 3) } : {})
      },
      densityBudget: densityForRole(role, count),
      estimatedNarrativeChars: chars[offset] ?? Math.max(120, Math.round(intent.derivedNarrativeChars / count))
    };
  });
  const totalEstimatedChars = slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0);

  return {
    arc: inferNarrativeArc(intent),
    slides,
    totalEstimatedChars,
    transitions: slides.slice(1).map((slide, offset) => ({
      fromSlide: offset + 1,
      toSlide: offset + 2,
      bridge: `Move from ${slides[offset]!.contentBrief.headline} to ${slide.contentBrief.headline}.`
    }))
  };
}

function validateModelNarrativeDensity(narrative: NarrativeIR): string[] {
  const issues: string[] = [];
  if (!narrative.slides.every((slide) => slide.contentBrief.supportingPoints.length >= 1)) {
    issues.push("every slide must include at least one supporting point");
  }
  return issues;
}

type EvaluatedNarrativeCandidate = {
  narrative?: NarrativeIR;
  score: number;
  error?: string;
};

async function requestNarrativeCandidates(model: JsonOnlyModelClient, input: {
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
    throw reason?.reason instanceof Error ? reason.reason : new Error(String(reason?.reason ?? "Narrative candidate generation failed."));
  }
  return { values, calls: calls.length };
}

function evaluateNarrativeCandidate(raw: unknown, input: NarrativeStageInput): EvaluatedNarrativeCandidate {
  const candidate = normalizeNarrativeCandidate(raw, input.intent, input.evidence);
  const parsed = narrativeIrSchema.safeParse(candidate);
  if (!parsed.success) {
    return { score: -1, error: formatZodError(parsed.error) };
  }

  const issues = [
    ...validateNarrativeAgainstIntentAndEvidence(parsed.data, input.intent, input.evidence),
    ...validateModelNarrativeDensity(parsed.data)
  ];
  if (issues.length) {
    return { score: -0.5, error: issues.join("; ") };
  }

  return {
    narrative: parsed.data,
    score: scoreNarrativeCandidate(parsed.data, input)
  };
}

function scoreNarrativeCandidate(narrative: NarrativeIR, input: NarrativeStageInput): number {
  const targetChars = Math.max(1, input.intent.derivedNarrativeChars);
  const charRatio = narrative.totalEstimatedChars / targetChars;
  const charScore = charRatio >= 1 ? Math.max(0, 1 - Math.abs(charRatio - 1.08) * 0.35) : charRatio;
  const roleVariety = new Set(narrative.slides.map((slide) => slide.role)).size / Math.max(1, Math.min(8, narrative.slides.length));
  const supportScore = Math.min(1, narrative.slides.reduce((sum, slide) => sum + slide.contentBrief.supportingPoints.length, 0) / Math.max(1, narrative.slides.length * 2));
  const citationKeys = getAvailableCitationKeys(input.evidence);
  const citationUse = Math.min(1, narrative.slides.reduce((sum, slide) => sum + slide.contentBrief.evidenceRefs.filter((key) => citationKeys.has(key)).length, 0) / Math.max(1, narrative.slides.length));
  return Number((charScore * 0.36 + roleVariety * 0.22 + supportScore * 0.24 + citationUse * 0.18).toFixed(4));
}

function creativeCandidateCount(envName: string): number {
  const specific = Number.parseInt(process.env[envName] ?? "", 10);
  const shared = Number.parseInt(process.env.HTML_PPT_V2_CREATIVE_CANDIDATES ?? "", 10);
  const value = Number.isFinite(specific) && specific > 0 ? specific : Number.isFinite(shared) && shared > 0 ? shared : 3;
  return Math.min(4, Math.max(1, Math.trunc(value)));
}

function getAvailableCitationKeys(evidence: EvidencePack): Set<string> {
  return new Set(visibleEvidenceCitationKeys(evidence));
}

function normalizeArc(value: unknown, intent: IntentIR): NarrativeIR["arc"] {
  const allowed = ["problem-solution", "chronological", "deductive", "comparative", "thematic-clusters", "inverted-pyramid", "hero-journey", "pyramid-principle"] as const;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as NarrativeIR["arc"];
  }
  return inferNarrativeArc(intent);
}

function inferNarrativeArc(intent: IntentIR): NarrativeIR["arc"] {
  if (intent.tone === "narrative" || /历史|前世今生|history|evolution/i.test(intent.topic)) return "chronological";
  if (intent.format === "report" || intent.tone === "rigorous") return "deductive";
  if (intent.format === "pitch") return "problem-solution";
  if (intent.format === "analysis") return "comparative";
  return "thematic-clusters";
}

function normalizeRole(value: unknown, offset: number, total: number): SlideRoleId {
  const allowed = ["cover", "toc", "hook", "context", "evidence", "analysis", "comparison", "process", "case-study", "data-highlight", "transition-divider", "synthesis", "cta", "thanks"] as const;
  if (offset === 0) return "cover";
  if (total >= 5 && offset === 1) return "toc";
  if (offset === total - 1) return "cta";
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as SlideRoleId;
  }
  return roleSequence(total)[offset] ?? "analysis";
}

function roleSequence(count: number): SlideRoleId[] {
  if (count <= 1) return ["cover"];
  if (count === 2) return ["cover", "cta"];
  if (count === 3) return ["cover", "analysis", "cta"];

  const middleRoles: SlideRoleId[] = ["hook", "context", "evidence", "analysis", "comparison", "process", "data-highlight", "case-study", "synthesis"];
  const roles: SlideRoleId[] = ["cover"];
  if (count >= 5) roles.push("toc");
  while (roles.length < count - 1) {
    roles.push(middleRoles[(roles.length - 1) % middleRoles.length] ?? "analysis");
  }
  roles.push("cta");
  return roles;
}

function normalizeDensity(value: unknown, role: SlideRoleId): DensityBudgetId {
  const allowed = ["sparse", "balanced", "dense"] as const;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as DensityBudgetId;
  }
  return densityForRole(role, 10);
}

function densityForRole(role: SlideRoleId, total: number): DensityBudgetId {
  if (role === "cover" || role === "toc" || role === "cta" || role === "thanks" || role === "transition-divider") return "sparse";
  if (role === "evidence" || role === "analysis" || role === "comparison" || role === "data-highlight") return total >= 10 ? "dense" : "balanced";
  return "balanced";
}

function normalizeEstimate(value: unknown, role: SlideRoleId, intent: IntentIR): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return Math.min(8000, parsed);
  }
  const base = Math.max(120, Math.round(intent.derivedNarrativeChars / intent.derivedSlideCount));
  if (role === "cover" || role === "toc" || role === "cta") return Math.max(120, Math.round(base * 0.65));
  if (role === "evidence" || role === "analysis" || role === "comparison") return Math.round(base * 1.15);
  return base;
}

function distributeNarrativeChars(total: number, roles: SlideRoleId[]): number[] {
  const weights = roles.map((role) => role === "cover" || role === "toc" || role === "cta" || role === "thanks" ? 0.7 : role === "evidence" || role === "analysis" || role === "comparison" ? 1.2 : 1);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const estimates = weights.map((weight) => Math.max(120, Math.round((total * weight) / weightSum)));
  const delta = total - estimates.reduce((sum, estimate) => sum + estimate, 0);
  estimates[estimates.length - 1] = (estimates.at(-1) ?? 120) + delta;
  return estimates;
}

function supportingPointsForSlide(role: SlideRoleId, intent: IntentIR, evidence: EvidencePack, offset: number): string[] {
  if (role === "cover") return [`Frame ${intent.topic} for ${intent.audience} with a ${intent.tone} tone.`];
  if (role === "toc") return intent.hardConstraints.requiredSections.length ? intent.hardConstraints.requiredSections.slice(0, 6) : ["Context", "Evidence", "Implications", "Action"];
  if (role === "cta") return ["Close with a concrete action and decision path."];
  const facts = visibleEvidenceFacts(evidence).map((fact) => fact.claim);
  const terms = visibleEvidenceTerminology(evidence).map((term) => `${term.term}: ${term.definition}`);
  return [
    facts[offset % Math.max(1, facts.length)] ?? fallbackSupportingPoint(role, intent.topic),
    terms[offset % Math.max(1, terms.length)] ?? `Explain the practical implication for ${intent.audience}.`
  ].slice(0, 4);
}

function beatForRole(role: SlideRoleId, topic: string): string {
  const beats: Record<SlideRoleId, string> = {
    cover: `Open ${topic} with a clear audience promise.`,
    toc: "Orient the audience around the deck map.",
    hook: "Create urgency and curiosity.",
    context: "Establish the background and stakes.",
    evidence: "Ground the argument in source-backed facts.",
    analysis: "Interpret what the evidence means.",
    comparison: "Show tradeoffs and alternatives.",
    process: "Explain the sequence or operating path.",
    "case-study": "Make the topic concrete through an example.",
    "data-highlight": "Surface the most important numbers.",
    "transition-divider": "Reset the audience before the next section.",
    synthesis: "Connect the ideas into a conclusion.",
    cta: "End with the action or decision.",
    thanks: "Close the presentation cleanly."
  };
  return beats[role];
}

function headlineForRole(role: SlideRoleId, topic: string, offset: number): string {
  if (role === "cover") return topic;
  if (role === "toc") return "内容地图";
  if (role === "cta") return "下一步行动";
  return `${topic} · ${offset + 1}`;
}

function headlineFromClaim(claim: string | undefined, role: SlideRoleId, topic: string, offset: number): string {
  if (!claim) return headlineForRole(role, topic, offset);
  const firstSentence = claim.split(/[。.!?]/)[0]?.trim();
  return (firstSentence || claim).slice(0, 80);
}

function fallbackSupportingPoint(role: SlideRoleId, topic: string): string {
  return `${role} slide explains one concrete part of ${topic}.`;
}

function normalizeTransitions(rawTransitions: unknown, slides: NarrativeSlideIR[]): NarrativeIR["transitions"] {
  const slideIndexes = new Set(slides.map((slide) => slide.index));
  const normalized = asArray(rawTransitions)
    .map((transition) => {
      const item = asRecord(transition);
      const fromSlide = Number(item.fromSlide);
      const toSlide = Number(item.toSlide);
      if (!slideIndexes.has(fromSlide) || !slideIndexes.has(toSlide)) {
        return null;
      }
      return {
        fromSlide,
        toSlide,
        bridge: stringValue(item.bridge, `Move from slide ${fromSlide} to slide ${toSlide}.`).slice(0, 260)
      };
    })
    .filter((transition): transition is NarrativeIR["transitions"][number] => Boolean(transition));

  if (normalized.length) {
    return normalized.slice(0, 60);
  }

  return slides.slice(1).map((slide, offset) => ({
    fromSlide: offset + 1,
    toSlide: slide.index,
    bridge: `Move from ${slides[offset]!.contentBrief.headline} to ${slide.contentBrief.headline}.`
  }));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 260) : undefined;
}
