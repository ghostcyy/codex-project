import {
  DENSITY_BUDGET_IDS,
  NARRATIVE_ARC_IDS,
  SLIDE_ROLE_IDS,
  type EvidencePack,
  type IntentIR,
  type NarrativeIR
} from "../ir";
import { visibleEvidenceCitationKeys, visibleEvidenceDataPoints, visibleEvidenceFacts } from "../evidence-helpers";

export type NarrativePromptInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  validationError?: string;
};

export function buildNarrativePrompt(input: NarrativePromptInput): { system: string; user: string } {
  const validationBlock = input.validationError
    ? [
        "The previous JSON failed validation.",
        "Validation error:",
        input.validationError,
        "Return a corrected full JSON object. Do not explain."
      ].join("\n")
    : "";

  return {
    system: [
      "You are Stage 3 of HTML-PPT v2: Narrative Planning.",
      "You produce typed NarrativeIR JSON only.",
      "You must not output Markdown, prose, HTML, CSS, speaker notes, or comments.",
      "Closed enum values only:",
      `arc: ${NARRATIVE_ARC_IDS.join(", ")}`,
      `slide role: ${SLIDE_ROLE_IDS.join(", ")}`,
      `densityBudget: ${DENSITY_BUDGET_IDS.join(", ")}`,
      "Hard rules:",
      `1. Output exactly the requested number of slides.`,
      `2. Slide indexes must be consecutive and 1-based.`,
      `3. totalEstimatedChars must be at least the requested derivedNarrativeChars.`,
      `4. Every evidenceRefs value must come from the EvidencePack citation keys.`,
      `5. Each slide must have concrete supportingPoints that are ready for later slot filling.`,
      "Self-check before responding:",
      "1. The response is exactly one JSON object.",
      "2. slides.length equals IntentIR.derivedSlideCount.",
      "3. Sum of slide estimatedNarrativeChars approximately equals totalEstimatedChars.",
      "4. transitions connect existing adjacent slides.",
      "5. No raw HTML or CSS appears anywhere."
    ].join("\n"),
    user: [
      validationBlock,
      "IntentIR:",
      JSON.stringify(input.intent, null, 2),
      "",
      "EvidencePack:",
      JSON.stringify({
        ...input.evidence,
        facts: visibleEvidenceFacts(input.evidence),
        dataPoints: visibleEvidenceDataPoints(input.evidence)
      }, null, 2),
      "",
      "Available citation keys:",
      JSON.stringify(availableCitationKeys(input.evidence), null, 2),
      "",
      "Return JSON matching this shape:",
      JSON.stringify(exampleNarrative(input.intent, input.evidence), null, 2)
    ].filter(Boolean).join("\n")
  };
}

function availableCitationKeys(evidence: EvidencePack) {
  return visibleEvidenceCitationKeys(evidence);
}

function exampleNarrative(intent: IntentIR, evidence: EvidencePack): NarrativeIR {
  const refs = availableCitationKeys(evidence).slice(0, 2);
  return {
    arc: "problem-solution",
    slides: [
      {
        index: 1,
        role: "cover",
        beat: "Open the topic and frame the audience promise.",
        contentBrief: {
          headline: intent.topic,
          subhead: "A concise framing subtitle.",
          supportingPoints: ["State why this topic matters to the requested audience."],
          evidenceRefs: refs
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 180
      }
    ],
    totalEstimatedChars: Math.max(intent.derivedNarrativeChars, 180),
    transitions: []
  };
}
