import { resolve } from "node:path";
import {
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  type JsonOnlyModelClient
} from "../stages";
import type { NarrativeIR } from "../ir";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import { coreLayoutPackageById } from "../renderer";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const intent = (await runIntentStage({
    userPrompt: "制作一个8页HTML PPT，主题为企业AI知识库建设方法，约1200字，面向企业管理层，要求包含背景、架构、落地路径。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const narrative = (await runNarrativeStage({ intent, evidence })).narrative;
  const design = (await runDesignStage({ intent, evidence, narrative, registry })).design;
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return [
          {
            slideIndex: 1,
            layoutId: "chart",
            capacityCheck: { passed: true, details: "Bad non-renderable choice." },
            variancePosition: 0
          }
        ];
      }

      return JSON.stringify(narrative.slides.map((slide, index) => ({
        slideIndex: slide.index,
        layoutId: slide.role === "cover"
          ? "cover"
          : slide.role === "toc"
            ? "toc"
            : slide.role === "cta"
              ? "cta"
              : slide.role === "comparison"
                ? "comparison"
                : slide.role === "process" || slide.role === "case-study"
                  ? "timeline"
                  : slide.role === "data-highlight"
                    ? "kpi-grid"
                    : index % 2 === 0 ? "three-column" : "two-column",
        capacityCheck: { passed: true, details: "Model advisory capacity check." },
        variancePosition: index
      })));
    }
  };

  const result = await runLayoutPlanStage({ intent, narrative, design, registry, model });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Layout plan stage should retry once and accept corrected model JSON.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Layout plan retry prompt must include validation feedback.");
  }

  if (!calls[0]?.user.includes("\"contract\"") || !calls[0]?.user.includes("\"requiredSlots\"") || !calls[0]?.user.includes("\"primitives\"")) {
    throw new Error("Layout plan prompt must expose the first-class renderable layout contract.");
  }

  if (result.layoutPlan.length !== narrative.slides.length) {
    throw new Error("Layout plan stage must preserve exact narrative slide count.");
  }

  for (const item of result.layoutPlan) {
    if (!item.capacityCheck.passed) {
      throw new Error(`Layout plan emitted failed capacity check for slide ${item.slideIndex}.`);
    }
    if (!coreLayoutPackageById.has(item.layoutId)) {
      throw new Error(`Layout plan emitted non-renderable layout: ${item.layoutId}`);
    }
  }

  if (result.layoutPlan[0]?.layoutId !== "cover") {
    throw new Error("Cover slide must map to cover layout.");
  }

  const fallback = await runLayoutPlanStage({ intent, narrative, design, registry });
  if (fallback.source !== "fallback" || fallback.layoutPlan.length !== narrative.slides.length) {
    throw new Error("Layout plan fallback must produce a count-locked LayoutPlanIR.");
  }

  const targetedNarrative: NarrativeIR = {
    arc: narrative.arc,
    slides: [
      {
        index: 1,
        role: "transition-divider",
        beat: "Open a new section.",
        contentBrief: {
          headline: "Part two: from insight to action",
          supportingPoints: ["This slide creates a deliberate narrative break before the operating model."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 180
      },
      {
        index: 2,
        role: "data-highlight",
        beat: "Call out a single metric.",
        contentBrief: {
          headline: "One metric changes the decision",
          supportingPoints: ["The audience should remember the number before the explanation."],
          evidenceRefs: [],
          keyMetrics: ["42% faster retrieval"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 220
      },
      {
        index: 3,
        role: "synthesis",
        beat: "Condense the core argument.",
        contentBrief: {
          headline: "The operating model is the product",
          supportingPoints: ["A compact synthesis slide should emphasize the takeaway, not enumerate every detail."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 240
      },
      {
        index: 4,
        role: "case-study",
        beat: "Use a case-study moment as narrative emphasis.",
        contentBrief: {
          headline: "The pilot became the proof",
          supportingPoints: ["A sparse case-study beat can land as a quote-style narrative moment."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 240
      }
    ],
    totalEstimatedChars: 880,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "The divider introduces the evidence." },
      { fromSlide: 2, toSlide: 3, bridge: "The evidence leads into the synthesis." },
      { fromSlide: 3, toSlide: 4, bridge: "The synthesis lands in a concrete case." }
    ]
  };

  const targetedFallback = await runLayoutPlanStage({ intent, narrative: targetedNarrative, design, registry });
  const targetedLayouts = targetedFallback.layoutPlan.map((item) => item.layoutId);
  const expectedTargetedLayouts = ["section-divider", "stat-highlight", "quote", "quote"];
  if (targetedLayouts.join(",") !== expectedTargetedLayouts.join(",")) {
    throw new Error(`New layout DNA fallback mismatch: expected ${expectedTargetedLayouts.join(",")}, got ${targetedLayouts.join(",")}.`);
  }

  const secondBatchNarrative: NarrativeIR = {
    arc: narrative.arc,
    slides: [
      {
        index: 1,
        role: "context",
        beat: "Summarize low-complexity context as grouped bullets.",
        contentBrief: {
          headline: "Five facts define the operating context",
          supportingPoints: [
            "The source systems are fragmented across teams.",
            "The user journeys repeat the same retrieval questions.",
            "The knowledge owners need clearer review lanes.",
            "The rollout depends on governance before tooling.",
            "The first release should avoid unnecessary visual complexity."
          ],
          evidenceRefs: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 520
      },
      {
        index: 2,
        role: "process",
        beat: "Explain the workflow as a step-by-step process.",
        contentBrief: {
          headline: "The rollout follows four phases",
          supportingPoints: [
            "Discover the highest-frequency questions.",
            "Prepare and tag the trusted source corpus.",
            "Pilot retrieval with a narrow user group.",
            "Scale governance once answers stabilize."
          ],
          evidenceRefs: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 460
      },
      {
        index: 3,
        role: "hook",
        beat: "Open with a visual hero scene.",
        contentBrief: {
          headline: "A visual hero makes the knowledge gap tangible",
          supportingPoints: ["Use a generated image style scene to show employees searching across disconnected systems."],
          evidenceRefs: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 260
      },
      {
        index: 4,
        role: "case-study",
        beat: "Show the customer rollout as a step-by-step case-study flow.",
        contentBrief: {
          headline: "The pilot moved through three practical steps",
          supportingPoints: [
            "Start with one department and a bounded source set.",
            "Measure answer acceptance before expanding scope.",
            "Turn exceptions into the next governance rule."
          ],
          evidenceRefs: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 380
      }
    ],
    totalEstimatedChars: 1620,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "The context sets up the rollout process." },
      { fromSlide: 2, toSlide: 3, bridge: "The process can be introduced with a stronger visual hook." },
      { fromSlide: 3, toSlide: 4, bridge: "The visual hook lands in a concrete case-study flow." }
    ]
  };

  const secondBatchExpectedLayouts = ["bullet-list", "process", "image-hero", "process"];
  const secondBatchFallback = await runLayoutPlanStage({ intent, narrative: secondBatchNarrative, design, registry });
  const secondBatchFallbackLayouts = secondBatchFallback.layoutPlan.map((item) => item.layoutId);
  if (secondBatchFallbackLayouts.join(",") !== secondBatchExpectedLayouts.join(",")) {
    throw new Error(`Second-batch layout DNA fallback mismatch: expected ${secondBatchExpectedLayouts.join(",")}, got ${secondBatchFallbackLayouts.join(",")}.`);
  }

  const secondBatchModelResult = await runLayoutPlanStage({
    intent,
    narrative: secondBatchNarrative,
    design,
    registry,
    model: {
      async completeJson() {
        return JSON.stringify(secondBatchNarrative.slides.map((slide, index) => ({
          slideIndex: slide.index,
          layoutId: secondBatchExpectedLayouts[index],
          capacityCheck: { passed: true, details: "Closed-set second-batch layout choice." },
          variancePosition: index
        })));
      }
    }
  });
  const secondBatchModelLayouts = secondBatchModelResult.layoutPlan.map((item) => item.layoutId);
  if (secondBatchModelResult.source !== "model" || secondBatchModelLayouts.join(",") !== secondBatchExpectedLayouts.join(",")) {
    throw new Error(`Second-batch model normalization mismatch: expected model ${secondBatchExpectedLayouts.join(",")}, got ${secondBatchModelResult.source} ${secondBatchModelLayouts.join(",")}.`);
  }

  console.log("HTML-PPT v2 layout plan stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
