import { buildEvidencePrompt } from "../prompts";
import {
  evidencePackSchema,
  type EvidencePack,
  type IntentIR
} from "../ir";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";
import type { ResearchClient, ResearchHit, ResearchQuery } from "./research-client";

export type EvidenceStageInput = {
  intent: IntentIR;
  model?: JsonOnlyModelClient;
  researchClient?: ResearchClient;
};

export type EvidenceStageResult = {
  evidence: EvidencePack;
  source: "model" | "fallback";
  attempts: number;
  validationErrors: string[];
  researchQueries: ResearchQuery[];
  researchHits: ResearchHit[];
  researchErrors: string[];
};

export async function runEvidenceStage(input: EvidenceStageInput): Promise<EvidenceStageResult> {
  const researchQueries = buildResearchQueries(input.intent);
  const researchErrors: string[] = [];
  const researchHits = await runResearchClient(input.researchClient, researchQueries, researchErrors);
  const validationErrors: string[] = [];

  if (input.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildEvidencePrompt({
        intent: input.intent,
        researchQueries,
        researchHits,
        validationError: validationErrors.at(-1)
      });
      const raw = await input.model.completeJson({
        stage: "02-evidence",
        system: prompt.system,
        user: prompt.user,
        temperature: 0
      });
      const candidate = normalizeEvidenceCandidate(raw, input.intent, researchHits, researchErrors);
      const parsed = evidencePackSchema.safeParse(candidate);

      if (parsed.success) {
        const completenessIssues = validateModelEvidenceCompleteness(parsed.data);
        if (completenessIssues.length) {
          validationErrors.push(completenessIssues.join("; "));
          continue;
        }

        return {
          evidence: parsed.data,
          source: "model",
          attempts: attempt,
          validationErrors,
          researchQueries,
          researchHits,
          researchErrors
        };
      }

      validationErrors.push(formatZodError(parsed.error));
    }
  }

  const fallback = evidencePackSchema.parse(buildFallbackEvidencePack(input.intent, researchHits, researchErrors));
  return {
    evidence: fallback,
    source: "fallback",
    attempts: input.model ? 2 : 0,
    validationErrors,
    researchQueries,
    researchHits,
    researchErrors
  };
}

function validateModelEvidenceCompleteness(evidence: EvidencePack): string[] {
  const issues: string[] = [];
  if (evidence.facts.length < 2) issues.push("facts must contain at least 2 source-backed claims for Stage 2 model output");
  if (evidence.candidateVisuals.length < 1) issues.push("candidateVisuals must contain at least 1 visual idea");
  if (evidence.terminology.length < 1) issues.push("terminology must contain at least 1 term");
  if (evidence.narrativeAngles.length < 1) issues.push("narrativeAngles must contain at least 1 angle");
  return issues;
}

export function buildResearchQueries(intent: IntentIR): ResearchQuery[] {
  const topic = intent.topic.trim();
  const current = intent.preferences.knowledgeCutoffWarning ? " current 2026" : "";
  const queries: ResearchQuery[] = [
    { query: `${topic}${current} overview`, kind: "web-fact", intentLabel: "topic-overview", priority: 1 },
    { query: `${topic}${current} key facts`, kind: "web-fact", intentLabel: "supporting-facts", priority: 2 },
    { query: `${topic}${current} market data statistics`, kind: "web-stat", intentLabel: "metrics", priority: 3 },
    { query: `${topic} terminology definitions`, kind: "terminology", intentLabel: "terminology", priority: 4 },
    { query: `${topic} visual references diagrams`, kind: "image", intentLabel: "visual-ideas", priority: 5 }
  ];

  if (intent.format === "lecture" || intent.tone === "rigorous" || intent.audience === "researchers") {
    queries.push({ query: `${topic} paper research review`, kind: "paper", intentLabel: "academic-grounding", priority: 6 });
  }

  for (const section of intent.hardConstraints.requiredSections) {
    queries.push({
      query: `${topic} ${section}`,
      kind: "web-fact",
      intentLabel: `required-section:${section}`,
      priority: 7
    });
  }

  return queries.slice(0, 12);
}

async function runResearchClient(
  researchClient: ResearchClient | undefined,
  queries: ResearchQuery[],
  researchErrors: string[]
): Promise<ResearchHit[]> {
  if (!researchClient) {
    researchErrors.push("No ResearchClient configured; Stage 2 used model/fallback synthesis without live search results.");
    return [];
  }

  try {
    return (await researchClient.search(queries)).slice(0, 40);
  } catch (error) {
    researchErrors.push(`ResearchClient failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function normalizeEvidenceCandidate(
  raw: unknown,
  intent: IntentIR,
  researchHits: ResearchHit[],
  researchErrors: string[]
): unknown {
  const value = parseJsonLike(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const candidate = value as Partial<EvidencePack>;
  const fallbackSource = sourceFromHit(researchHits[0]) ?? localFallbackSource(intent);
  const citationKeys = new Set<string>();
  const facts = asArray(candidate.facts).map((fact, index) => {
    const item = asRecord(fact);
    const citationKey = uniqueCitationKey(item.citationKey, `fact-${index + 1}`, citationKeys);
    return {
      claim: stringValue(item.claim, `${intent.topic} requires source-backed explanation before it becomes slide content.`),
      confidence: enumValue(item.confidence, ["high", "medium", "low"] as const, researchHits.length ? "medium" : "low"),
      sources: normalizeSources(item.sources, fallbackSource),
      citationKey
    };
  });
  const dataPoints = asArray(candidate.dataPoints).map((dataPoint, index) => {
    const item = asRecord(dataPoint);
    const citationKey = uniqueCitationKey(item.citationKey, `metric-${index + 1}`, citationKeys);
    return {
      metric: stringValue(item.metric, `${intent.topic} signal ${index + 1}`),
      value: typeof item.value === "number" ? item.value : stringValue(item.value, "Needs sourced value"),
      unit: optionalString(item.unit),
      period: optionalString(item.period),
      source: stringValue(item.source, facts[0]?.citationKey ?? fallbackSource.title),
      citationKey
    };
  });
  const candidateVisuals = asArray(candidate.candidateVisuals).map((visual, index) => {
    const item = asRecord(visual);
    const sourceUrl = optionalUrl(item.sourceUrl);
    return {
      kind: enumValue(item.kind, ["photo", "illustration", "icon", "logo", "chart-data"] as const, index % 3 === 0 ? "chart-data" : "illustration"),
      description: stringValue(item.description, `${intent.topic} visual idea ${index + 1}.`),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(optionalString(item.license) ? { license: optionalString(item.license) } : {}),
      relevanceScore: numberBetween(item.relevanceScore, 0, 1, 0.72)
    };
  });
  const terminology = asArray(candidate.terminology).map((term) => {
    const item = asRecord(term);
    return {
      term: stringValue(item.term, intent.topic.slice(0, 80)),
      definition: stringValue(item.definition, `A key concept related to ${intent.topic}.`),
      usage: enumValue(item.usage, ["technical", "colloquial"] as const, intent.audience === "engineers" || intent.audience === "researchers" ? "technical" : "colloquial")
    };
  });
  const narrativeAngles = asArray(candidate.narrativeAngles).map((angle, index) => {
    const item = asRecord(angle);
    return {
      angle: stringValue(item.angle, `${intent.topic} narrative angle ${index + 1}`),
      tradeoffs: stringValue(item.tradeoffs, "Useful for structure, but should be checked against available evidence.")
    };
  });
  const knownGaps = [
    ...asArray(candidate.knownGaps).map((gap) => stringValue(gap, "")).filter(Boolean),
    ...researchErrors
  ].slice(0, 30);

  return {
    facts,
    dataPoints,
    candidateVisuals,
    terminology,
    narrativeAngles,
    knownGaps
  };
}

function buildFallbackEvidencePack(intent: IntentIR, researchHits: ResearchHit[], researchErrors: string[]): EvidencePack {
  const source = sourceFromHit(researchHits[0]) ?? localFallbackSource(intent);
  const sectionFacts = intent.hardConstraints.requiredSections.slice(0, 5).map((section, index) => ({
    claim: `${section} should be covered as an explicit section because the user requested it for ${intent.topic}.`,
    confidence: "low" as const,
    sources: [source],
    citationKey: normalizeCitationKey(section, `required-section-${index + 1}`),
    internalOnly: true
  }));
  const baseFacts: EvidencePack["facts"] = [
    {
      claim: `${intent.topic} should first establish context, then explain implications, and finally land on a practical takeaway for ${intent.audience}.`,
      confidence: "low",
      sources: [source],
      citationKey: "topic-brief"
    },
    {
      claim: `${intent.audience} will understand ${intent.topic} better when the story connects background, tradeoffs, and concrete next steps.`,
      confidence: "low",
      sources: [source],
      citationKey: "audience-brief"
    },
    {
      claim: `The scope should stay concise enough to fit ${intent.derivedSlideCount} slides without overloading each page.`,
      confidence: "low",
      sources: [source],
      citationKey: "request-scope",
      internalOnly: true
    },
    ...sectionFacts
  ];

  const terms = [
    ...intent.preferences.domainTerminology,
    intent.topic
  ].filter(Boolean).slice(0, 8);

  return {
    facts: baseFacts,
    dataPoints: [
      {
        metric: "Scope width",
        value: `${intent.derivedSlideCount} slides`,
        source: "request-scope",
        citationKey: "requested-slides",
        internalOnly: true
      },
      {
        metric: "Narrative depth",
        value: `${intent.derivedNarrativeChars} ${intent.language === "zh-CN" ? "chars" : "chars"}`,
        source: "request-scope",
        citationKey: "requested-length",
        internalOnly: true
      }
    ],
    candidateVisuals: [
      { kind: "illustration", description: `A conceptual hero visual for ${intent.topic}.`, relevanceScore: 0.74 },
      { kind: "chart-data", description: `A compact data panel showing the key metrics behind ${intent.topic}.`, relevanceScore: 0.7 },
      { kind: "icon", description: `A small icon set for recurring concepts in ${intent.topic}.`, relevanceScore: 0.62 },
      { kind: "illustration", description: `A process diagram explaining the narrative flow of ${intent.topic}.`, relevanceScore: 0.68 },
      { kind: "chart-data", description: `A comparison visual for tradeoffs and decisions around ${intent.topic}.`, relevanceScore: 0.66 }
    ],
    terminology: terms.map((term) => ({
      term,
      definition: `${term} is a core term that should stay precise and audience-appropriate in the deck.`,
      usage: intent.audience === "engineers" || intent.audience === "researchers" ? "technical" : "colloquial",
      internalOnly: true
    })),
    narrativeAngles: [
      {
        angle: "Context to action",
        tradeoffs: "Useful for practical audiences, but may compress historical nuance."
      },
      {
        angle: "Problem to solution",
        tradeoffs: "Creates clear tension and resolution, but depends on strong evidence for the problem statement."
      },
      {
        angle: "Comparative analysis",
        tradeoffs: "Works well for decisions, but requires enough reliable data to avoid shallow comparisons."
      }
    ],
    knownGaps: [
      ...researchErrors,
      ...(intent.preferences.knowledgeCutoffWarning
        ? [`${intent.topic} appears time-sensitive; live source verification is recommended before final publication.`]
        : []),
      "Fallback evidence is generated from IntentIR and should be replaced by sourced research when available."
    ].slice(0, 30)
  };
}

function sourceFromHit(hit: ResearchHit | undefined): EvidencePack["facts"][number]["sources"][number] | undefined {
  if (!hit || !isUrl(hit.url)) {
    return undefined;
  }
  return {
    url: hit.url,
    title: hit.title.slice(0, 160) || "Research source",
    ...(hit.publishedAt ? { publishedAt: hit.publishedAt.slice(0, 60) } : {}),
    type: hit.sourceType
  };
}

function localFallbackSource(intent: IntentIR): EvidencePack["facts"][number]["sources"][number] {
  return {
    url: "https://example.invalid/html-ppt-v2/local-fallback",
    title: "Local fallback evidence generated from IntentIR",
    type: "rag"
  };
}

function normalizeSources(rawSources: unknown, fallbackSource: EvidencePack["facts"][number]["sources"][number]) {
  const sources = asArray(rawSources)
    .map((source) => {
      const item = asRecord(source);
      const url = optionalUrl(item.url);
      if (!url) {
        return null;
      }
      return {
        url,
        title: stringValue(item.title, "Research source"),
        ...(optionalString(item.publishedAt) ? { publishedAt: optionalString(item.publishedAt) } : {}),
        type: enumValue(item.type, ["web", "paper", "data", "rag"] as const, "web")
      };
    })
    .filter((source): source is EvidencePack["facts"][number]["sources"][number] => Boolean(source))
    .slice(0, 8);

  return sources.length ? sources : [fallbackSource];
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
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function optionalUrl(value: unknown): string | undefined {
  return typeof value === "string" && isUrl(value) ? value : undefined;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function enumValue<T extends readonly string[]>(value: unknown, options: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function numberBetween(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function uniqueCitationKey(value: unknown, fallback: string, seen: Set<string>): string {
  let key = normalizeCitationKey(value, fallback);
  let suffix = 2;
  while (seen.has(key.toLowerCase())) {
    key = `${normalizeCitationKey(value, fallback)}-${suffix}`;
    suffix += 1;
  }
  seen.add(key.toLowerCase());
  return key;
}

function normalizeCitationKey(value: unknown, fallback: string): string {
  const base = typeof value === "string" && value.trim() ? value : fallback;
  const normalized = slugify(base).replace(/^[^a-z]+/i, "");
  const key = normalized || slugify(fallback).replace(/^[^a-z]+/i, "") || "source";
  return key.length >= 2 ? key.slice(0, 60) : `${key}x`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}
