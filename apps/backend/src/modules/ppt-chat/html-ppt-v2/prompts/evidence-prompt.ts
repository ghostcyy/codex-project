import type { EvidencePack, IntentIR } from "../ir";
import type { ResearchHit, ResearchQuery } from "../stages/research-client";

export type EvidencePromptInput = {
  intent: IntentIR;
  researchQueries: ResearchQuery[];
  researchHits: ResearchHit[];
  validationError?: string;
};

export function buildEvidencePrompt(input: EvidencePromptInput): { system: string; user: string } {
  const validationBlock = input.validationError
    ? [
        "The previous JSON failed validation.",
        "Validation error:",
        input.validationError,
        "Return a corrected full JSON object. Do not explain."
      ].join("\n")
    : "";

  const targetCounts = targetEvidenceCounts(input.intent);

  return {
    system: [
      "You are Stage 2 of HTML-PPT v2: Evidence Pack synthesis.",
      "You produce typed EvidencePack JSON only.",
      "You must not output Markdown, prose, HTML, CSS, or comments.",
      "Use the provided research hits when available. Do not invent source URLs.",
      "If the evidence is thin or research hits are absent, say so in knownGaps instead of fabricating facts.",
      "Citation keys must be unique and stable, using lowercase letters, numbers, and hyphens.",
      "Self-check before responding:",
      "1. The response is exactly one JSON object.",
      "2. Every fact has at least one source.",
      "3. Every citationKey is unique.",
      "4. Facts are presentation-ready claims, not vague notes.",
      "5. knownGaps honestly records missing or unverified evidence."
    ].join("\n"),
    user: [
      validationBlock,
      "IntentIR:",
      JSON.stringify(input.intent, null, 2),
      "",
      "Research queries planned by the deterministic stage:",
      JSON.stringify(input.researchQueries, null, 2),
      "",
      "Research hits available to you:",
      JSON.stringify(input.researchHits, null, 2),
      "",
      "Target evidence density:",
      JSON.stringify(targetCounts, null, 2),
      "",
      "Return JSON matching this shape:",
      JSON.stringify(exampleEvidencePack(), null, 2)
    ].filter(Boolean).join("\n")
  };
}

function targetEvidenceCounts(intent: IntentIR) {
  const slideCount = intent.derivedSlideCount;
  return {
    facts: { min: Math.min(30, Math.max(8, slideCount + 4)), ideal: Math.min(30, Math.max(12, slideCount * 2)) },
    dataPoints: { min: intent.preferences.knowledgeCutoffWarning ? 5 : 2, ideal: intent.preferences.knowledgeCutoffWarning ? 10 : 5 },
    candidateVisuals: { min: 5, ideal: Math.min(15, Math.max(6, slideCount)) },
    terminology: { min: 3, ideal: 8 },
    narrativeAngles: { min: 3, ideal: 5 }
  };
}

function exampleEvidencePack(): EvidencePack {
  return {
    facts: [
      {
        claim: "A concise, source-backed claim that can support one slide.",
        confidence: "medium",
        sources: [
          {
            url: "https://example.invalid/source",
            title: "Source title",
            publishedAt: "2026-01-01",
            type: "web"
          }
        ],
        citationKey: "source-claim"
      }
    ],
    dataPoints: [
      {
        metric: "Metric name",
        value: "Metric value",
        unit: "optional unit",
        period: "optional period",
        source: "source-claim",
        citationKey: "source-metric"
      }
    ],
    candidateVisuals: [
      {
        kind: "illustration",
        description: "A visual idea relevant to the topic.",
        relevanceScore: 0.8
      }
    ],
    terminology: [
      {
        term: "Term",
        definition: "A concise definition suitable for the deck audience.",
        usage: "technical"
      }
    ],
    narrativeAngles: [
      {
        angle: "Narrative angle",
        tradeoffs: "Why this angle is useful and what it may omit."
      }
    ],
    knownGaps: ["Unverified areas or missing source coverage."]
  };
}
