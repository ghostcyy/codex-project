import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { hydrateHtmlPptV2SkillRegistry, type SkillRegistry } from "../registry";
import { compactDeckForRenderVerification, HtmlPptV2PublishService, type HtmlPptV2AgentResult } from "../orchestration";
import type { DeckIR } from "../ir";
import { operationsMetricsDeckIr } from "./fixtures/deck-ir-fixtures";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const outputRoot = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "publish-fixtures");
  const runtimeRoot = resolve(workspaceRoot, ".local-runtime");
  if (!outputRoot.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputRoot: ${outputRoot}`);
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  verifyRenderRemediationCompactsOnlyTargetSlides();

  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const publisher = new HtmlPptV2PublishService();
  const result = await publisher.generateAndPublish({
    userPrompt: "制作一个5页HTML PPT，主题为城市更新与未来社区，约800字，面向城市规划学生。",
    registry,
    outputRoot,
    projectSlug: "city-renewal"
  });

  if (result.verification.summary.hardIssueCount !== 0) {
    throw new Error(`Published fixture should have no hard verification issues: ${JSON.stringify(result.verification.hardIssues)}`);
  }
  if (result.deck.intent.derivedSlideCount !== 5) {
    throw new Error("Publisher must preserve the requested slide count through DeckIR and render output.");
  }
  for (const file of Object.values(result.trace.files)) {
    if (!existsSync(file)) {
      throw new Error(`Published output is missing file: ${file}`);
    }
  }
  if (result.trace.renderSource !== "deterministic" || result.trace.auxiliarySource !== "deterministic") {
    throw new Error("Publish trace must expose deterministic render and auxiliary stages.");
  }

  await verifyPublishTemplateFidelityProductionPath({ registry, outputRoot });
  await verifyFirstBatchLayoutDnaPublishPath({ registry, outputRoot });
  await verifySecondBatchLayoutDnaPublishPath({ registry, outputRoot });

  console.log(`HTML-PPT v2 publish orchestrator passed. outputDir=${result.outputDir}`);
}

async function verifyPublishTemplateFidelityProductionPath(input: { registry: SkillRegistry; outputRoot: string }) {
  const alignedPublisher = new HtmlPptV2PublishService(new FakeAgentService("tech-sharing", operationsMetricsDeckIr) as never);
  const aligned = await alignedPublisher.generateAndPublish({
    userPrompt: "Deterministic aligned template fidelity publish fixture.",
    registry: input.registry,
    outputRoot: input.outputRoot,
    deckId: "template-fidelity-aligned",
    allowVerificationFailure: false
  });
  if (aligned.verification.summary.hardIssueCount !== 0 || aligned.verification.signals.templateFidelity.status !== "pass") {
    throw new Error(`Aligned publish path should pass selected-template verification: ${JSON.stringify(aligned.verification.hardIssues)}`);
  }

  const mismatchedPublisher = new HtmlPptV2PublishService(new FakeAgentService("product-launch", operationsMetricsDeckIr) as never);
  let failed = false;
  try {
    await mismatchedPublisher.generateAndPublish({
      userPrompt: "Deterministic mismatched template fidelity publish fixture.",
      registry: input.registry,
      outputRoot: input.outputRoot,
      deckId: "template-fidelity-mismatch",
      allowVerificationFailure: false
    });
  } catch (error) {
    failed = error instanceof Error
      && error.message.includes("HTML-PPT v2 render verification failed")
      && (error.message.includes("Pinned template donorTemplateId") || error.message.includes("Pinned template deckClass"));
  }
  if (!failed) {
    throw new Error("Publish path must fail when rendered donor/deckClass mismatches the selected template package.");
  }
}

async function verifyFirstBatchLayoutDnaPublishPath(input: { registry: SkillRegistry; outputRoot: string }) {
  const publisher = new HtmlPptV2PublishService(new FakeAgentService("tech-sharing", firstBatchLayoutDnaDeck(operationsMetricsDeckIr)) as never);
  const result = await publisher.generateAndPublish({
    userPrompt: "Deterministic first-batch layout DNA publish fixture.",
    registry: input.registry,
    outputRoot: input.outputRoot,
    deckId: "first-batch-layout-dna",
    allowVerificationFailure: false
  });
  if (result.verification.summary.hardIssueCount !== 0) {
    throw new Error(`First-batch layout DNA publish fixture should verify cleanly: ${JSON.stringify(result.verification.hardIssues)}`);
  }
  const layouts = result.deck.layoutPlan.map((item) => item.layoutId).join(",");
  if (layouts !== "quote,section-divider,stat-highlight") {
    throw new Error(`First-batch layout DNA publish fixture layout mismatch: ${layouts}`);
  }
  for (const file of Object.values(result.trace.files)) {
    if (!existsSync(file)) {
      throw new Error(`First-batch layout DNA publish output is missing file: ${file}`);
    }
  }
}

async function verifySecondBatchLayoutDnaPublishPath(input: { registry: SkillRegistry; outputRoot: string }) {
  const publisher = new HtmlPptV2PublishService(new FakeAgentService("tech-sharing", secondBatchLayoutDnaDeck(operationsMetricsDeckIr)) as never);
  const result = await publisher.generateAndPublish({
    userPrompt: "Deterministic second-batch layout DNA publish fixture.",
    registry: input.registry,
    outputRoot: input.outputRoot,
    deckId: "second-batch-layout-dna",
    allowVerificationFailure: false
  });
  if (result.verification.summary.hardIssueCount !== 0) {
    throw new Error(`Second-batch layout DNA publish fixture should verify cleanly: ${JSON.stringify(result.verification.hardIssues)}`);
  }
  const layouts = result.deck.layoutPlan.map((item) => item.layoutId).join(",");
  if (layouts !== "bullet-list,process,image-hero") {
    throw new Error(`Second-batch layout DNA publish fixture layout mismatch: ${layouts}`);
  }
  for (const file of Object.values(result.trace.files)) {
    if (!existsSync(file)) {
      throw new Error(`Second-batch layout DNA publish output is missing file: ${file}`);
    }
  }
}

class FakeAgentService {
  constructor(
    private readonly selectedTemplateId: string,
    private readonly deck: DeckIR
  ) {}

  async generateDeckIr(): Promise<HtmlPptV2AgentResult> {
    const deck = JSON.parse(JSON.stringify(this.deck)) as DeckIR;
    return {
      deck,
      trace: {
        intentSource: "fallback",
        evidenceSource: "fallback",
        templateSelectionSource: "pinned",
        templateSelection: {
          chosenTemplateId: this.selectedTemplateId,
          shortlist: [this.selectedTemplateId],
          shortlistScores: [
            {
              id: this.selectedTemplateId,
              deterministicScore: 999,
              breakdown: {
                audienceFit: 0,
                formatFit: 0,
                toneFit: 0,
                promptSignals: 0,
                forbidPromptSignals: 0,
                defaultSlideCount: 0
              }
            }
          ],
          rationale: "Deterministic publish template fidelity fixture.",
          confidence: "high"
        },
        narrativeSource: "fallback",
        designSource: "pinned",
        layoutPlanSource: "pinned",
        slotFillSource: "fallback",
        assetSource: "deterministic",
        choreographySource: "deterministic",
        criticSource: "deterministic",
        criticRounds: 0,
        stageAttempts: {
          intent: 0,
          templateSelection: 0,
          evidence: 0,
          narrative: 0,
          design: 0,
          layoutPlan: 0,
          slotFill: 0,
          critic: 0
        },
        modelCalls: 0,
        warnings: []
      }
    };
  }
}

function firstBatchLayoutDnaDeck(baseDeck: DeckIR): DeckIR {
  const deck = JSON.parse(JSON.stringify(baseDeck)) as DeckIR;
  deck.intent = {
    ...deck.intent,
    hardConstraints: { ...deck.intent.hardConstraints, slideCount: 3, narrativeChars: 530 },
    derivedSlideCount: 3,
    derivedNarrativeChars: 530
  };
  deck.narrative = {
    ...deck.narrative,
    slides: [
      {
        index: 1,
        role: "synthesis",
        beat: "A decisive quote frames the argument.",
        contentBrief: {
          headline: "Quote layout",
          supportingPoints: ["A quote should feel intentionally paced.", "HTML-PPT v2"],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 160
      },
      {
        index: 2,
        role: "transition-divider",
        beat: "The deck resets into the next section.",
        contentBrief: {
          headline: "Section Divider",
          subhead: "A low-density rhythm break.",
          supportingPoints: ["The marker tells the audience where they are."],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 150
      },
      {
        index: 3,
        role: "data-highlight",
        beat: "One metric anchors the decision.",
        contentBrief: {
          headline: "Stat Highlight",
          subhead: "Oversized signal.",
          supportingPoints: ["The number needs context.", "Support cards explain the implication."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: ["Velocity"]
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 220
      }
    ],
    totalEstimatedChars: 530,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "Move from quote into section reset." },
      { fromSlide: 2, toSlide: 3, bridge: "Move from divider into metric focus." }
    ]
  };
  deck.layoutPlan = [
    { slideIndex: 1, layoutId: "quote", capacityCheck: { passed: true, details: "Quote fixture fits." }, variancePosition: 0 },
    { slideIndex: 2, layoutId: "section-divider", capacityCheck: { passed: true, details: "Divider fixture fits." }, variancePosition: 1 },
    { slideIndex: 3, layoutId: "stat-highlight", capacityCheck: { passed: true, details: "Stat fixture fits." }, variancePosition: 2 }
  ];
  deck.slots = [
    {
      slideIndex: 1,
      kind: "quote",
      title: "Quote layout",
      kicker: "Quote",
      quote: "The renderer owns the visual language; the model supplies only typed content.",
      attribution: "HTML-PPT v2",
      supportingText: "A large editorial quote creates a controlled pause.",
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 2,
      kind: "section-divider",
      title: "Section Divider",
      kicker: "Part 02",
      marker: "02",
      progressText: "2 / 3",
      supportingText: "A deterministic marker and rule establish the next section.",
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 3,
      kind: "stat-highlight",
      title: "Stat Highlight",
      kicker: "Metric",
      value: "3.2x",
      label: "faster deterministic review",
      explanation: "The oversized number anchors the message while cards explain context.",
      cards: [
        { title: "Baseline", body: "Typed slots keep the data surface constrained.", accent: "neutral", citationKeys: ["cloud-servers"] },
        { title: "Implication", body: "Closed classes let templates style the result safely.", accent: "primary", citationKeys: ["cloud-servers"] }
      ],
      citationKeys: ["cloud-servers"]
    }
  ];
  deck.choreography = [
    { slideIndex: 1, entrance: "fade-up", builds: [], fx: "none" },
    { slideIndex: 2, entrance: "rise-in", builds: [], fx: "none" },
    { slideIndex: 3, entrance: "fade-up", builds: [{ target: "card", anim: "stagger-list", delay: 80 }], fx: "none" }
  ];
  deck.assets = {};
  return deck;
}

function secondBatchLayoutDnaDeck(baseDeck: DeckIR): DeckIR {
  const deck = JSON.parse(JSON.stringify(baseDeck)) as DeckIR;
  deck.intent = {
    ...deck.intent,
    hardConstraints: { ...deck.intent.hardConstraints, slideCount: 3, narrativeChars: 630 },
    derivedSlideCount: 3,
    derivedNarrativeChars: 630
  };
  deck.narrative = {
    ...deck.narrative,
    slides: [
      {
        index: 1,
        role: "analysis",
        beat: "Grouped bullets make the decision surface scannable.",
        contentBrief: {
          headline: "Bullet List",
          supportingPoints: ["Group related ideas.", "Keep individual bullets compact.", "Use cards for structure."],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 210
      },
      {
        index: 2,
        role: "process",
        beat: "The process renderer owns numbered steps and connectors.",
        contentBrief: {
          headline: "Process Flow",
          supportingPoints: ["Frame the input.", "Execute the path.", "Verify the result."],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 210
      },
      {
        index: 3,
        role: "case-study",
        beat: "A visual hero can use a safe placeholder when no asset exists.",
        contentBrief: {
          headline: "Image Hero",
          subhead: "Safe visual area.",
          supportingPoints: ["Placeholder visuals stay deterministic.", "Text remains typed and scannable."],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 210
      }
    ],
    totalEstimatedChars: 630,
    transitions: [
      { fromSlide: 1, toSlide: 2, bridge: "Move from grouped bullets into process." },
      { fromSlide: 2, toSlide: 3, bridge: "Move from process into hero visual." }
    ]
  };
  deck.layoutPlan = [
    { slideIndex: 1, layoutId: "bullet-list", capacityCheck: { passed: true, details: "Bullet list fixture fits." }, variancePosition: 0 },
    { slideIndex: 2, layoutId: "process", capacityCheck: { passed: true, details: "Process fixture fits." }, variancePosition: 1 },
    { slideIndex: 3, layoutId: "image-hero", capacityCheck: { passed: true, details: "Image hero fixture fits." }, variancePosition: 2 }
  ];
  deck.slots = [
    {
      slideIndex: 1,
      kind: "bullet-list",
      title: "Bullet List",
      kicker: "Checklist",
      lede: "Compact cards group the evidence.",
      groups: [
        { title: "Inputs", items: ["Typed content only", "Closed list classes"], accent: "primary", citationKeys: ["cloud-servers"] },
        { title: "Outputs", items: ["Scannable groups", "Template-profile hooks"], accent: "secondary", citationKeys: ["cloud-servers"] }
      ],
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 2,
      kind: "process",
      title: "Process Flow",
      kicker: "Flow",
      lede: "A step-by-step deterministic process.",
      steps: [
        { label: "01", title: "Frame", description: "Define the input and boundary.", accent: "neutral", citationKeys: ["cloud-servers"] },
        { label: "02", title: "Build", description: "Render through closed classes.", accent: "primary", citationKeys: ["cloud-servers"] },
        { label: "03", title: "Verify", description: "Check class coverage and output.", accent: "secondary", citationKeys: ["cloud-servers"] }
      ],
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 3,
      kind: "image-hero",
      title: "Image Hero",
      kicker: "Visual",
      lede: "The hero uses a safe placeholder.",
      visualLabel: "HERO",
      body: "When no verified asset exists, the renderer creates a deterministic placeholder treatment.",
      chips: ["safe", "typed", "visual"],
      citationKeys: ["cloud-servers"]
    }
  ];
  deck.choreography = [
    { slideIndex: 1, entrance: "fade-up", builds: [{ target: "card", anim: "stagger-list", delay: 80 }], fx: "none" },
    { slideIndex: 2, entrance: "rise-in", builds: [{ target: "card", anim: "stagger-list", delay: 80 }], fx: "none" },
    { slideIndex: 3, entrance: "fade-up", builds: [], fx: "soft-glow" }
  ];
  deck.assets = {};
  return deck;
}

function verifyRenderRemediationCompactsOnlyTargetSlides() {
  const deck = JSON.parse(JSON.stringify(operationsMetricsDeckIr)) as typeof operationsMetricsDeckIr;
  const target = deck.slots.find((slot) => slot.slideIndex === 3);
  if (!target || target.kind !== "kpi-grid") {
    throw new Error("Publish verification fixture must include a kpi-grid slide 3.");
  }
  target.summary = "This deliberately verbose summary is still schema-valid, but it should be compressed by the Stage 11 to Stage 6 render-remediation pass so the affected slide can be re-rendered within the viewport budget.";
  target.metrics[0]!.note = "This deliberately verbose note is schema-valid, but it should be compacted after browser verification reports that slide three has a visible overflow problem near the viewport edge.";
  const untouchedTitle = deck.slots.find((slot) => slot.slideIndex === 4)?.title;
  const compacted = compactDeckForRenderVerification(deck, [3]);
  const compactedTarget = compacted.slots.find((slot) => slot.slideIndex === 3);
  if (!compactedTarget || compactedTarget.kind !== "kpi-grid") {
    throw new Error("Render remediation should preserve the target slide layout kind.");
  }
  if ((compactedTarget.summary?.length ?? 0) >= (target.summary?.length ?? 0)) {
    throw new Error("Render remediation should compact target slide summary text.");
  }
  if ((compactedTarget.metrics[0]?.note?.length ?? 0) >= (target.metrics[0]?.note?.length ?? 0)) {
    throw new Error("Render remediation should compact target slide metric notes.");
  }
  if (compacted.slots.find((slot) => slot.slideIndex === 4)?.title !== untouchedTitle) {
    throw new Error("Render remediation must not alter non-target slides.");
  }
  if (!compacted.meta.checkpoints.some((checkpoint) => checkpoint.stage === "stage-11:render-remediation")) {
    throw new Error("Render remediation should record a stage-11 checkpoint in DeckIR.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
