import { resolve } from "node:path";
import {
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  runSlotFillStage,
  type JsonOnlyModelClient
} from "../stages";
import type { LayoutPlanIR, NarrativeIR } from "../ir";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";

async function main() {
  const previousCandidateEnv = process.env.HTML_PPT_V2_SLOT_CANDIDATES;
  process.env.HTML_PPT_V2_SLOT_CANDIDATES = "1";
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const intent = (await runIntentStage({
    userPrompt: "制作一个8页HTML PPT，主题为企业AI知识库建设方法，约1200字，面向企业管理层，要求包含背景、架构、落地路径。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const narrative = (await runNarrativeStage({ intent, evidence })).narrative;
  const design = (await runDesignStage({ intent, evidence, narrative, registry })).design;
  const layoutPlan = (await runLayoutPlanStage({ intent, narrative, design, registry })).layoutPlan;
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return [
          {
            slideIndex: layoutPlan[0]!.slideIndex,
            kind: "two-column",
            title: "Wrong kind"
          }
        ];
      }

      return JSON.stringify(layoutPlan.map((planItem) => {
        const slide = narrative.slides.find((item) => item.index === planItem.slideIndex)!;
        const common = {
          slideIndex: planItem.slideIndex,
          kind: planItem.layoutId,
          title: slide.contentBrief.headline,
          kicker: slide.role.toUpperCase(),
          citationKeys: slide.contentBrief.evidenceRefs
        };
        switch (planItem.layoutId) {
          case "cover":
            return { ...common, subtitle: slide.contentBrief.subhead ?? slide.contentBrief.supportingPoints[0], meta: ["AI", "Knowledge Base"] };
          case "toc":
            return {
              ...common,
              items: narrative.slides.slice(2, 6).map((item) => ({ label: item.contentBrief.headline, description: item.beat }))
            };
          case "two-column":
            return {
              ...common,
              leftTitle: "方法",
              leftBody: slide.contentBrief.supportingPoints[0] ?? "先建立可执行方法。",
              rightTitle: "落地",
              rightBody: slide.contentBrief.supportingPoints[1] ?? "再连接组织流程。",
              bullets: slide.contentBrief.supportingPoints.slice(0, 3)
            };
          case "three-column":
            return {
              ...common,
              cards: [0, 1, 2].map((index) => ({
                title: `要点 ${index + 1}`,
                body: slide.contentBrief.supportingPoints[index] ?? `补充说明 ${index + 1}`,
                accent: index === 0 ? "primary" : index === 1 ? "secondary" : "neutral",
                citationKeys: slide.contentBrief.evidenceRefs
              }))
            };
          case "kpi-grid":
            return {
              ...common,
              summary: slide.contentBrief.supportingPoints[0],
              metrics: [0, 1, 2].map((index) => ({
                label: slide.contentBrief.keyMetrics?.[index] ?? `指标 ${index + 1}`,
                value: `${index + 1}`,
                note: slide.contentBrief.supportingPoints[index] ?? "用于支撑判断。",
                citationKeys: slide.contentBrief.evidenceRefs
              }))
            };
          case "timeline":
            return {
              ...common,
              events: [0, 1, 2, 3].map((index) => ({
                label: `阶段 ${index + 1}`,
                date: `Step ${index + 1}`,
                description: slide.contentBrief.supportingPoints[index] ?? `阶段说明 ${index + 1}`,
                accent: index === 0 ? "neutral" : index === 1 ? "primary" : "secondary",
                citationKeys: slide.contentBrief.evidenceRefs
              }))
            };
          case "comparison":
            return {
              ...common,
              left: { title: "现状", body: slide.contentBrief.supportingPoints[0] ?? "当前状态。", accent: "neutral", citationKeys: slide.contentBrief.evidenceRefs },
              right: { title: "目标", body: slide.contentBrief.supportingPoints[1] ?? "目标状态。", accent: "primary", citationKeys: slide.contentBrief.evidenceRefs },
              verdict: "优先选择可衡量、可治理、可迭代的路径。"
            };
          case "cta":
            return {
              ...common,
              headline: slide.contentBrief.headline,
              action: slide.contentBrief.supportingPoints[0] ?? "启动下一步。",
              supportingText: slide.beat
            };
          default:
            return common;
        }
      }));
    }
  };

  const result = await runSlotFillStage({ intent, evidence, narrative, design, layoutPlan, model });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Slot fill stage should retry once and accept corrected model JSON.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Slot fill retry prompt must include validation feedback.");
  }

  if (result.slots.length !== layoutPlan.length) {
    throw new Error("Slot fill stage must preserve exact layout plan count.");
  }

  for (const slot of result.slots) {
    const expectedKind = layoutPlan.find((item) => item.slideIndex === slot.slideIndex)?.layoutId;
    if (slot.kind !== expectedKind) {
      throw new Error(`Slot kind mismatch for slide ${slot.slideIndex}.`);
    }
  }

  if (layoutPlan.some((item) => ["three-column", "kpi-grid", "timeline", "comparison"].includes(item.layoutId)) && !hasAnyNestedCitationKeys(result.slots)) {
    throw new Error("Slot fill stage should preserve nested card/metric/event/panel citation keys from model output.");
  }

  const fallback = await runSlotFillStage({ intent, evidence, narrative, design, layoutPlan });
  if (fallback.source !== "fallback" || fallback.slots.length !== layoutPlan.length) {
    throw new Error("Slot fill fallback must produce a count-locked SlotFillIR.");
  }
  const targetedFallback = await runSlotFillStage({
    intent,
    evidence,
    narrative,
    design,
    layoutPlan,
    targetSlideIndexes: [layoutPlan[2]!.slideIndex],
    verificationFeedback: ["Target only the affected slide."]
  });
  if (targetedFallback.slots.length !== 1 || targetedFallback.slots[0]?.slideIndex !== layoutPlan[2]!.slideIndex) {
    throw new Error("Targeted Stage 11 slot remediation must refill only the affected slide.");
  }

  process.env.HTML_PPT_V2_SLOT_CANDIDATES = "3";
  let sampleCalls = 0;
  const sampledModel: JsonOnlyModelClient = {
    async completeJson() {
      sampleCalls += 1;
      return JSON.stringify(layoutPlan.map((planItem) => {
        const slide = narrative.slides.find((item) => item.index === planItem.slideIndex)!;
        const rich = sampleCalls === 2;
        const common = {
          slideIndex: planItem.slideIndex,
          kind: planItem.layoutId,
          title: rich && planItem.slideIndex === 3 ? "Best sampled slot fill" : slide.contentBrief.headline,
          kicker: slide.role.toUpperCase(),
          citationKeys: rich ? slide.contentBrief.evidenceRefs : []
        };
        switch (planItem.layoutId) {
          case "cover":
            return { ...common, subtitle: rich ? slide.beat : "短说明", meta: rich ? ["AI", "Governance", "Roadmap"] : ["AI"] };
          case "toc":
            return { ...common, items: narrative.slides.slice(2, 6).map((item) => ({ label: item.contentBrief.headline, description: rich ? item.beat : undefined })) };
          case "two-column":
            return { ...common, leftTitle: "方法", leftBody: rich ? slide.contentBrief.supportingPoints[0] : "短", rightTitle: "落地", rightBody: rich ? slide.contentBrief.supportingPoints[1] ?? slide.beat : "短", bullets: rich ? slide.contentBrief.supportingPoints.slice(0, 3) : [] };
          case "three-column":
            return { ...common, cards: [0, 1, 2].map((index) => ({ title: `要点 ${index + 1}`, body: rich ? slide.contentBrief.supportingPoints[index] ?? slide.beat : "短", accent: index === 0 ? "primary" : index === 1 ? "secondary" : "neutral", citationKeys: rich ? slide.contentBrief.evidenceRefs : [] })) };
          case "kpi-grid":
            return { ...common, summary: rich ? slide.beat : "短", metrics: [0, 1, 2].map((index) => ({ label: `指标 ${index + 1}`, value: String(index + 1), note: rich ? slide.contentBrief.supportingPoints[index] ?? slide.beat : undefined, citationKeys: rich ? slide.contentBrief.evidenceRefs : [] })) };
          case "timeline":
            return { ...common, events: [0, 1, 2, 3].map((index) => ({ label: `阶段 ${index + 1}`, date: `Step ${index + 1}`, description: rich ? slide.contentBrief.supportingPoints[index] ?? slide.beat : "短", accent: index === 0 ? "neutral" : index === 1 ? "primary" : "secondary", citationKeys: rich ? slide.contentBrief.evidenceRefs : [] })) };
          case "comparison":
            return { ...common, left: { title: "现状", body: rich ? slide.contentBrief.supportingPoints[0] ?? slide.beat : "短", accent: "neutral", citationKeys: rich ? slide.contentBrief.evidenceRefs : [] }, right: { title: "目标", body: rich ? slide.contentBrief.supportingPoints[1] ?? slide.beat : "短", accent: "primary", citationKeys: rich ? slide.contentBrief.evidenceRefs : [] }, verdict: rich ? "选择可衡量、可治理、可迭代的路径。" : "短" };
          case "cta":
            return { ...common, headline: slide.contentBrief.headline, action: rich ? slide.contentBrief.supportingPoints[0] ?? slide.beat : "短", supportingText: rich ? slide.beat : undefined };
          default:
            return common;
        }
      }));
    }
  };
  const sampled = await runSlotFillStage({ intent, evidence, narrative, design, layoutPlan, model: sampledModel });
  if (sampleCalls !== 3 || sampled.attempts !== 3 || sampled.slots[2]?.title !== "Best sampled slot fill") {
    throw new Error("Slot fill stage should sample three first-pass candidates and choose the highest-scoring candidate.");
  }

  const firstBatchNarrative: NarrativeIR = {
    arc: "deductive",
    slides: [
      {
        index: 1,
        role: "synthesis",
        beat: "Use a quote to crystallize the operating principle.",
        contentBrief: {
          headline: "A decisive quote",
          supportingPoints: ["Typed slots make template fidelity testable.", "HTML-PPT v2 QA"],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 160
      },
      {
        index: 2,
        role: "transition-divider",
        beat: "Reset the audience before the metrics.",
        contentBrief: {
          headline: "Part two: proof",
          subhead: "A section break with visible progress.",
          supportingPoints: ["The narrative turns from principle to evidence."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 150
      },
      {
        index: 3,
        role: "data-highlight",
        beat: "Anchor the proof in one number.",
        contentBrief: {
          headline: "One stat carries the proof",
          supportingPoints: ["The number should dominate the page.", "Support cards explain why it matters.", "The reviewer can scan it quickly."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: ["3.2x"]
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 220
      }
    ],
    totalEstimatedChars: 530,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "The quote opens the next section." },
      { fromSlide: 2, toSlide: 3, bridge: "The divider leads into the stat." }
    ]
  };
  const firstBatchLayoutPlan: LayoutPlanIR = [
    { slideIndex: 1, layoutId: "quote", capacityCheck: { passed: true, details: "Quote fits." }, variancePosition: 0 },
    { slideIndex: 2, layoutId: "section-divider", capacityCheck: { passed: true, details: "Divider fits." }, variancePosition: 1 },
    { slideIndex: 3, layoutId: "stat-highlight", capacityCheck: { passed: true, details: "Stat fits." }, variancePosition: 2 }
  ];
  const firstBatchFallback = await runSlotFillStage({
    intent: { ...intent, derivedSlideCount: 3, hardConstraints: { ...intent.hardConstraints, slideCount: 3 } },
    evidence,
    narrative: firstBatchNarrative,
    design,
    layoutPlan: firstBatchLayoutPlan
  });
  if (firstBatchFallback.slots.map((slot) => slot.kind).join(",") !== "quote,section-divider,stat-highlight") {
    throw new Error(`First-batch layout fallback kinds mismatch: ${firstBatchFallback.slots.map((slot) => slot.kind).join(",")}`);
  }
  const firstBatchModel: JsonOnlyModelClient = {
    async completeJson() {
      return JSON.stringify([
        {
          slideIndex: 1,
          kind: "quote",
          title: "Normalized quote",
          quote: "Normalization keeps quote layouts typed.",
          attribution: "QA Agent",
          supportingText: "The model can provide quote-specific fields.",
          citationKeys: ["cloud-servers"]
        },
        {
          slideIndex: 2,
          kind: "section-divider",
          title: "Normalized divider",
          marker: "section-2",
          progressText: "Section 2 of 3",
          supportingText: "The divider accepts marker and progress text.",
          citationKeys: ["cloud-servers"]
        },
        {
          slideIndex: 3,
          kind: "stat-highlight",
          title: "Normalized stat",
          value: "3.2x",
          label: "faster QA review",
          explanation: "Stat highlight accepts value, label, explanation, and cards.",
          cards: [
            { title: "Evidence", body: "The stat is supported by a typed card.", accent: "primary", citationKeys: ["cloud-servers"] },
            { title: "Implication", body: "The renderer receives closed-set classes.", accent: "secondary", citationKeys: ["cloud-servers"] }
          ],
          citationKeys: ["cloud-servers"]
        }
      ]);
    }
  };
  const firstBatchNormalized = await runSlotFillStage({
    intent: { ...intent, derivedSlideCount: 3, hardConstraints: { ...intent.hardConstraints, slideCount: 3 } },
    evidence,
    narrative: firstBatchNarrative,
    design,
    layoutPlan: firstBatchLayoutPlan,
    model: firstBatchModel
  });
  const quote = firstBatchNormalized.slots[0];
  const divider = firstBatchNormalized.slots[1];
  const stat = firstBatchNormalized.slots[2];
  if (quote?.kind !== "quote" || quote.quote !== "Normalization keeps quote layouts typed.") {
    throw new Error("Slot fill normalization must accept quote-specific fields.");
  }
  if (divider?.kind !== "section-divider" || divider.marker !== "02" || divider.progressText !== "2 / 3") {
    throw new Error("Slot fill normalization must sanitize generic section-divider marker/progress placeholders.");
  }
  if (stat?.kind !== "stat-highlight" || stat.value !== "3.2x" || stat.cards.length !== 2) {
    throw new Error("Slot fill normalization must accept stat-highlight-specific fields.");
  }

  const secondBatchNarrative: NarrativeIR = {
    arc: "deductive",
    slides: [
      {
        index: 1,
        role: "analysis",
        beat: "Use grouped bullets to make the operating choices scannable.",
        contentBrief: {
          headline: "Grouped decisions",
          supportingPoints: [
            "Start from trusted source systems.",
            "Separate governance from retrieval tuning.",
            "Keep release criteria visible to reviewers.",
            "Use a low-complexity slide for fast scanning.",
            "Keep item labels short.",
            "Avoid visual overload."
          ],
          evidenceRefs: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 240
      },
      {
        index: 2,
        role: "process",
        beat: "Explain the rollout as a deterministic sequence.",
        contentBrief: {
          headline: "Rollout process",
          supportingPoints: ["Frame the corpus.", "Build the retrieval path.", "Verify answer quality."],
          evidenceRefs: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 220
      },
      {
        index: 3,
        role: "hook",
        beat: "Use a visual hero placeholder to make the knowledge gap tangible.",
        contentBrief: {
          headline: "Search should feel visible",
          supportingPoints: ["A hero visual introduces the problem before details."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 170
      }
    ],
    totalEstimatedChars: 630,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "The grouped choices become a process." },
      { fromSlide: 2, toSlide: 3, bridge: "The process is introduced with a visual anchor." }
    ]
  };
  const secondBatchLayoutPlan: LayoutPlanIR = [
    { slideIndex: 1, layoutId: "bullet-list", capacityCheck: { passed: true, details: "Bullet list fits." }, variancePosition: 0 },
    { slideIndex: 2, layoutId: "process", capacityCheck: { passed: true, details: "Process fits." }, variancePosition: 1 },
    { slideIndex: 3, layoutId: "image-hero", capacityCheck: { passed: true, details: "Image hero fits." }, variancePosition: 2 }
  ];
  const secondBatchFallback = await runSlotFillStage({
    intent: { ...intent, derivedSlideCount: 3, hardConstraints: { ...intent.hardConstraints, slideCount: 3 } },
    evidence,
    narrative: secondBatchNarrative,
    design,
    layoutPlan: secondBatchLayoutPlan
  });
  if (secondBatchFallback.slots.map((slot) => slot.kind).join(",") !== "bullet-list,process,image-hero") {
    throw new Error(`Second-batch layout fallback kinds mismatch: ${secondBatchFallback.slots.map((slot) => slot.kind).join(",")}`);
  }
  const secondBatchModel: JsonOnlyModelClient = {
    async completeJson() {
      return JSON.stringify([
        {
          slideIndex: 1,
          kind: "bullet-list",
          title: "Normalized bullet list",
          kicker: "Checklist",
          lede: "Bullet list accepts grouped typed items.",
          groups: [
            { title: "Inputs", items: ["Trusted corpus", "Review lanes"], accent: "primary", citationKeys: ["cloud-servers"] },
            { title: "Outputs", items: ["Scannable choices", "Closed classes"], accent: "secondary", citationKeys: ["cloud-servers"] }
          ],
          citationKeys: ["cloud-servers"]
        },
        {
          slideIndex: 2,
          kind: "process",
          title: "Normalized process",
          kicker: "Flow",
          lede: "Process accepts numbered typed steps.",
          steps: [
            { label: "01", title: "Frame", description: "Define the corpus boundary.", accent: "neutral", citationKeys: ["cloud-servers"] },
            { label: "02", title: "Build", description: "Render through closed layout classes.", accent: "primary", citationKeys: ["cloud-servers"] },
            { label: "03", title: "Verify", description: "Check deterministic output contracts.", accent: "secondary", citationKeys: ["cloud-servers"] }
          ],
          citationKeys: ["cloud-servers"]
        },
        {
          slideIndex: 3,
          kind: "image-hero",
          title: "Normalized image hero",
          kicker: "Visual",
          lede: "Image hero accepts safe visual metadata.",
          visualLabel: "HERO",
          body: "The renderer can use a deterministic placeholder when no verified asset is present.",
          chips: ["safe", "typed", "visual"],
          citationKeys: ["cloud-servers"]
        }
      ]);
    }
  };
  const secondBatchNormalized = await runSlotFillStage({
    intent: { ...intent, derivedSlideCount: 3, hardConstraints: { ...intent.hardConstraints, slideCount: 3 } },
    evidence,
    narrative: secondBatchNarrative,
    design,
    layoutPlan: secondBatchLayoutPlan,
    model: secondBatchModel
  });
  const bulletList = secondBatchNormalized.slots[0];
  const processSlot = secondBatchNormalized.slots[1];
  const imageHero = secondBatchNormalized.slots[2];
  if (bulletList?.kind !== "bullet-list" || bulletList.groups.length !== 2 || bulletList.groups[0]?.items.length !== 2) {
    throw new Error("Slot fill normalization must accept bullet-list groups and items.");
  }
  if (processSlot?.kind !== "process" || processSlot.steps.length !== 3 || processSlot.steps[0]?.label !== "01") {
    throw new Error("Slot fill normalization must accept process steps.");
  }
  if (imageHero?.kind !== "image-hero" || imageHero.visualLabel !== "HERO" || imageHero.chips.length !== 3) {
    throw new Error("Slot fill normalization must accept image-hero visual metadata.");
  }

  if (previousCandidateEnv === undefined) {
    delete process.env.HTML_PPT_V2_SLOT_CANDIDATES;
  } else {
    process.env.HTML_PPT_V2_SLOT_CANDIDATES = previousCandidateEnv;
  }

  console.log("HTML-PPT v2 slot fill stage verification passed.");
}

function hasAnyNestedCitationKeys(slots: Awaited<ReturnType<typeof runSlotFillStage>>["slots"]): boolean {
  return slots.some((slot) => {
    switch (slot.kind) {
      case "three-column":
        return slot.cards.some((card) => card.citationKeys.length > 0);
      case "kpi-grid":
        return slot.metrics.some((metric) => metric.citationKeys.length > 0);
      case "timeline":
        return slot.events.some((event) => event.citationKeys.length > 0);
      case "comparison":
        return slot.left.citationKeys.length > 0 || slot.right.citationKeys.length > 0;
      default:
        return false;
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
