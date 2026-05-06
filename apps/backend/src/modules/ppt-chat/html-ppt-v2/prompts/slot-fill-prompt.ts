import type { DesignSystemIR, EvidencePack, IntentIR, LayoutPlanIR, NarrativeIR } from "../ir";
import { visibleEvidenceDataPoints, visibleEvidenceFacts, visibleEvidenceTerminology } from "../evidence-helpers";

export type SlotFillPromptInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  narrative: NarrativeIR;
  design: DesignSystemIR;
  layoutPlan: LayoutPlanIR;
  validationError?: string;
  verificationFeedback?: string[];
};

export function buildSlotFillPrompt(input: SlotFillPromptInput): { system: string; user: string } {
  const validationBlock = input.validationError
    ? [
        "The previous JSON failed validation.",
        "Validation error:",
        input.validationError,
        "Return a corrected full JSON array. Do not explain."
      ].join("\n")
    : "";
  const verificationFeedbackBlock = input.verificationFeedback?.length
    ? [
        "Stage 11 render verification feedback:",
        ...input.verificationFeedback,
        "Apply this feedback only by changing SlotFillIR text/content density. Do not change slide count, slideIndex, kind, citation keys, or layout identity."
      ].join("\n")
    : "";

  return {
    system: [
      "You are Stage 6 of HTML-PPT v2: Slot Filling.",
      "You produce SlotFillIR JSON array only.",
      "You must not output Markdown, prose, HTML, CSS, or comments.",
      "Hard rules:",
      "1. Output exactly one slot object per LayoutPlanIR item.",
      "2. slideIndex must match the layout plan.",
      "3. kind must exactly equal the selected layoutId.",
      "4. citationKeys at slide and nested component level must use only EvidencePack citation keys.",
      "5. Fill content only. Do not invent layout classes, tags, CSS, or style fields.",
      "6. Keep text presentation-ready and concise enough for 16:9 slides.",
      "Self-check before responding:",
      "1. The response is exactly one JSON array.",
      "2. Every object matches its layout-specific slot schema.",
      "3. Every card/metric/event has real body text, not placeholders.",
      "4. No raw HTML or CSS appears anywhere."
    ].join("\n"),
    user: [
      validationBlock,
      verificationFeedbackBlock,
      "Intent summary:",
      JSON.stringify({
        topic: input.intent.topic,
        language: input.intent.language,
        audience: input.intent.audience,
        tone: input.intent.tone,
        format: input.intent.format,
        derivedSlideCount: input.intent.derivedSlideCount,
        derivedNarrativeChars: input.intent.derivedNarrativeChars
      }, null, 2),
      "",
      "Design summary:",
      JSON.stringify({
        themeId: input.design.themeId,
        donorTemplateId: input.design.donorTemplateId,
        titleTreatment: input.design.donorContract.dnaSignature.titleTreatment,
        cardTreatment: input.design.donorContract.dnaSignature.cardTreatment
      }, null, 2),
      "",
      "Evidence available:",
      JSON.stringify({
        facts: visibleEvidenceFacts(input.evidence).map((fact) => ({ claim: fact.claim, citationKey: fact.citationKey })),
        dataPoints: visibleEvidenceDataPoints(input.evidence).map((point) => ({ metric: point.metric, value: point.value, citationKey: point.citationKey })),
        terminology: visibleEvidenceTerminology(input.evidence)
      }, null, 2),
      "",
      "Target slide indexes for this SlotFillIR response:",
      JSON.stringify(input.layoutPlan.map((item) => item.slideIndex)),
      "",
      "Narrative and selected layouts:",
      JSON.stringify(input.narrative.slides.map((slide) => ({
        index: slide.index,
        role: slide.role,
        layoutId: input.layoutPlan.find((item) => item.slideIndex === slide.index)?.layoutId,
        headline: slide.contentBrief.headline,
        subhead: slide.contentBrief.subhead,
        supportingPoints: slide.contentBrief.supportingPoints,
        evidenceRefs: slide.contentBrief.evidenceRefs,
        keyMetrics: slide.contentBrief.keyMetrics,
        densityBudget: slide.densityBudget
      })), null, 2),
      "",
      "Layout-specific output shapes:",
      JSON.stringify({
        cover: { slideIndex: 1, kind: "cover", title: "string", kicker: "string", subtitle: "string", meta: ["string"], citationKeys: ["citation-key"] },
        toc: { slideIndex: 2, kind: "toc", title: "string", kicker: "string", items: [{ label: "string", description: "string" }], citationKeys: ["citation-key"] },
        "two-column": { slideIndex: 3, kind: "two-column", title: "string", kicker: "string", leftTitle: "string", leftBody: "string", rightTitle: "string", rightBody: "string", bullets: ["string"], citationKeys: ["citation-key"] },
        "three-column": { slideIndex: 4, kind: "three-column", title: "string", kicker: "string", cards: [{ title: "string", body: "string", accent: "primary", citationKeys: ["citation-key"] }], citationKeys: ["citation-key"] },
        "kpi-grid": { slideIndex: 5, kind: "kpi-grid", title: "string", kicker: "string", summary: "string", metrics: [{ label: "string", value: "string", note: "string", citationKeys: ["citation-key"] }], citationKeys: ["citation-key"] },
        timeline: { slideIndex: 6, kind: "timeline", title: "string", kicker: "string", events: [{ label: "string", date: "string", description: "string", accent: "primary", citationKeys: ["citation-key"] }], citationKeys: ["citation-key"] },
        comparison: { slideIndex: 7, kind: "comparison", title: "string", kicker: "string", left: { title: "string", body: "string", accent: "neutral", citationKeys: ["citation-key"] }, right: { title: "string", body: "string", accent: "primary", citationKeys: ["citation-key"] }, verdict: "string", citationKeys: ["citation-key"] },
        chart: { slideIndex: 8, kind: "chart", title: "string", kicker: "string", chartType: "bar", dataAssetKey: "chart-slide-8", insight: "string", citationKeys: ["citation-key"] },
        cta: { slideIndex: 8, kind: "cta", title: "string", kicker: "string", headline: "string", action: "string", supportingText: "string", citationKeys: ["citation-key"] }
      }, null, 2)
    ].filter(Boolean).join("\n")
  };
}
