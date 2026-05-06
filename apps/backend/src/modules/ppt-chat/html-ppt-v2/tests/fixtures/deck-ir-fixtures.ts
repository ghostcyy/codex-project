import type { AssetIR, DeckIR, RenderableLayoutId, SlideSlotFillIR } from "../../ir";
import { sampleDeckIr } from "./sample-deck-ir";

type NarrativeSlideRole = DeckIR["narrative"]["slides"][number]["role"];
type SlideFixtureSpec = {
  role: NarrativeSlideRole;
  layoutId: RenderableLayoutId;
  title: string;
  beat: string;
  supportingPoints: string[];
  estimatedNarrativeChars: number;
  slot: SlideSlotFillIR;
};

function cloneDeck(deck: DeckIR): DeckIR {
  return JSON.parse(JSON.stringify(deck)) as DeckIR;
}

function makeDeckFixture(input: {
  topic: string;
  title: string;
  subtitle: string;
  audience: DeckIR["intent"]["audience"];
  tone: DeckIR["intent"]["tone"];
  format: DeckIR["intent"]["format"];
  requiredSections: string[];
  slides: SlideFixtureSpec[];
}): DeckIR {
  const deck = cloneDeck(sampleDeckIr);
  const totalChars = input.slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0);

  deck.intent = {
    ...deck.intent,
    topic: input.topic,
    audience: input.audience,
    tone: input.tone,
    format: input.format,
    hardConstraints: {
      slideCount: input.slides.length,
      narrativeChars: Math.max(500, totalChars - 60),
      requiredSections: input.requiredSections
    },
    derivedSlideCount: input.slides.length,
    derivedNarrativeChars: Math.max(500, totalChars - 60)
  };

  deck.narrative = {
    arc: input.format === "report" ? "deductive" : "problem-solution",
    slides: input.slides.map((slide, offset) => ({
      index: offset + 1,
      role: slide.role,
      beat: slide.beat,
      contentBrief: {
        headline: slide.title,
        subhead: offset === 0 ? input.subtitle : undefined,
        supportingPoints: slide.supportingPoints,
        evidenceRefs: offset % 2 === 0 ? ["cloud-servers"] : ["edge-cloud"],
        keyMetrics: slide.layoutId === "kpi-grid" ? ["Provisioning speed"] : undefined
      },
      densityBudget: slide.layoutId === "cover" || slide.layoutId === "cta" ? "sparse" : "balanced",
      estimatedNarrativeChars: slide.estimatedNarrativeChars
    })),
    totalEstimatedChars: totalChars,
    transitions: input.slides.slice(1).map((slide, offset) => ({
      fromSlide: offset + 1,
      toSlide: offset + 2,
      bridge: `Move from ${input.slides[offset]!.title} into ${slide.title}.`
    }))
  };

  deck.layoutPlan = input.slides.map((slide, offset) => ({
    slideIndex: offset + 1,
    layoutId: slide.layoutId,
    capacityCheck: {
      passed: true,
      details: `${slide.layoutId} fixture content fits the deterministic v2 layout contract.`
    },
    variancePosition: offset
  }));

  deck.slots = input.slides.map((slide, offset) => ({
    ...slide.slot,
    slideIndex: offset + 1
  }));

  deck.assets = buildFixtureAssets(deck.slots);

  deck.choreography = input.slides.map((slide, offset) => ({
    slideIndex: offset + 1,
    entrance: "fade-up",
    builds: slide.layoutId === "toc"
      ? [{ target: "toc-item", anim: "stagger-list", delay: 80 }]
      : slide.layoutId === "three-column" || slide.layoutId === "two-column" || slide.layoutId === "comparison"
        ? [{ target: "card", anim: "stagger-list", delay: 100 }]
        : [],
    fx: slide.layoutId === "cover" || slide.layoutId === "cta" ? "soft-glow" : "none"
  }));

  deck.meta = {
    ...deck.meta,
    generatedAt: "2026-04-28T00:00:00.000-07:00",
    checkpoints: [
      {
        stage: "stage-0:fixture",
        status: "completed",
        startedAt: "2026-04-28T00:00:00.000-07:00",
        completedAt: "2026-04-28T00:00:01.000-07:00",
        summary: `${input.title} fixture for v2 deterministic renderer verification.`
      }
    ]
  };

  return deck;
}

function buildFixtureAssets(slots: SlideSlotFillIR[]): AssetIR {
  const assets: AssetIR = {};

  for (const slot of slots) {
    if (slot.kind !== "chart") {
      continue;
    }

    assets[slot.dataAssetKey] = {
      kind: "chart",
      chartType: slot.chartType,
      chartConfig: {
        title: slot.title,
        labels: ["Plan", "Render", "Verify"],
        series: [
          {
            label: slot.title,
            data: [3, 7, 10],
            color: "#0f766e"
          }
        ],
        unit: "score",
        summary: "Fixture chart asset used to verify deterministic chart rendering and export."
      },
      sourceCitationKeys: slot.citationKeys
    };
  }

  return assets;
}

const commonCover = (title: string, subtitle: string): SlideSlotFillIR => ({
  slideIndex: 1,
  kind: "cover",
  title,
  kicker: "V2 Fixture",
  subtitle,
  meta: ["Deterministic render", "DeckIR"],
  citationKeys: ["cloud-servers"]
});

const commonToc = (title: string, items: string[]): SlideSlotFillIR => ({
  slideIndex: 2,
  kind: "toc",
  title,
  kicker: "Agenda",
  items: items.map((label) => ({ label, description: `${label} as a structured briefing section` })),
  citationKeys: ["cloud-servers"]
});

const cta = (title: string, action: string): SlideSlotFillIR => ({
  slideIndex: 99,
  kind: "cta",
  title,
  kicker: "Next step",
  headline: title,
  action,
  supportingText: "The deterministic renderer keeps the structure stable while later stages improve narrative quality.",
  citationKeys: ["edge-cloud"]
});

export const operationsMetricsDeckIr = makeDeckFixture({
  topic: "Operations metrics for cloud reliability teams",
  title: "Cloud Reliability Metrics",
  subtitle: "A concise operating dashboard for infrastructure teams",
  audience: "engineers",
  tone: "rigorous",
  format: "report",
  requiredSections: ["Metrics", "Roadmap", "Action"],
  slides: [
    {
      role: "cover",
      layoutId: "cover",
      title: "Cloud Reliability Metrics",
      beat: "Open with the operating question.",
      supportingPoints: ["Reliability teams need a shared view of speed, availability, and latency."],
      estimatedNarrativeChars: 280,
      slot: commonCover("Cloud Reliability Metrics", "A concise operating dashboard for infrastructure teams")
    },
    {
      role: "toc",
      layoutId: "toc",
      title: "Three signals to align",
      beat: "Preview the metric groups.",
      supportingPoints: ["Provisioning speed", "Availability", "Latency"],
      estimatedNarrativeChars: 260,
      slot: commonToc("Three signals to align", ["Provisioning speed", "Availability", "Latency"])
    },
    {
      role: "data-highlight",
      layoutId: "kpi-grid",
      title: "Track the metrics that reveal operating drag",
      beat: "Show the dashboard shape.",
      supportingPoints: ["Provisioning, availability, and latency are the highest-signal indicators."],
      estimatedNarrativeChars: 520,
      slot: {
        slideIndex: 3,
        kind: "kpi-grid",
        title: "Track the metrics that reveal operating drag",
        kicker: "Metrics",
        summary: "These numbers give engineering leaders a fast read on delivery friction and user-facing risk.",
        metrics: [
          { label: "Provisioning", value: "Minutes", note: "Time from request to usable environment", citationKeys: [] },
          { label: "Availability", value: "99.9%+", note: "Service-level operating target", citationKeys: [] },
          { label: "Latency", value: "<50ms", note: "Target for interactive edge paths", citationKeys: [] }
        ],
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "process",
      layoutId: "timeline",
      title: "Move from inventory to optimization",
      beat: "Lay out the operating sequence.",
      supportingPoints: ["Inventory, pilot, scale, and optimize form the path."],
      estimatedNarrativeChars: 560,
      slot: {
        slideIndex: 4,
        kind: "timeline",
        title: "Move from inventory to optimization",
        kicker: "Roadmap",
        events: [
          { label: "Inventory", date: "Now", description: "Classify workloads by latency, risk, and data gravity.", accent: "neutral", citationKeys: [] },
          { label: "Pilot", date: "30 days", description: "Run one production-adjacent workload with strict telemetry.", accent: "primary", citationKeys: [] },
          { label: "Scale", date: "90 days", description: "Standardize deployment, reliability, and cost controls.", accent: "secondary", citationKeys: [] },
          { label: "Optimize", date: "180 days", description: "Blend central cloud and edge services for critical paths.", accent: "primary", citationKeys: [] }
        ],
        citationKeys: ["edge-cloud"]
      }
    },
    {
      role: "cta",
      layoutId: "cta",
      title: "Make reliability visible before scaling",
      beat: "Close with a practical operating action.",
      supportingPoints: ["A metric-first roadmap prevents migration theater."],
      estimatedNarrativeChars: 260,
      slot: cta("Make reliability visible before scaling", "Publish a workload-fit scorecard before the next migration wave.")
    }
  ]
});

export const marketComparisonDeckIr = makeDeckFixture({
  topic: "Central cloud and edge cloud market positioning",
  title: "Central Cloud vs Edge Cloud",
  subtitle: "How to choose the right execution layer",
  audience: "executives",
  tone: "analytical",
  format: "briefing",
  requiredSections: ["Comparison", "Decision"],
  slides: [
    {
      role: "cover",
      layoutId: "cover",
      title: "Central Cloud vs Edge Cloud",
      beat: "Frame the decision as workload-fit strategy.",
      supportingPoints: ["The question is not which platform wins, but which workload belongs where."],
      estimatedNarrativeChars: 300,
      slot: commonCover("Central Cloud vs Edge Cloud", "How to choose the right execution layer")
    },
    {
      role: "toc",
      layoutId: "toc",
      title: "Decision map",
      beat: "Preview the comparison logic.",
      supportingPoints: ["Central strengths", "Edge strengths", "Roadmap choice"],
      estimatedNarrativeChars: 260,
      slot: commonToc("Decision map", ["Central strengths", "Edge strengths", "Roadmap choice"])
    },
    {
      role: "comparison",
      layoutId: "comparison",
      title: "Each layer has a distinct job",
      beat: "Compare platform roles.",
      supportingPoints: ["Central cloud coordinates shared services.", "Edge cloud shortens the loop for real-time workloads."],
      estimatedNarrativeChars: 720,
      slot: {
        slideIndex: 3,
        kind: "comparison",
        title: "Each layer has a distinct job",
        kicker: "Comparison",
        left: {
          title: "Central cloud",
          body: "Best for shared services, batch processing, global coordination, and durable data platforms.",
          accent: "neutral",
          citationKeys: []
        },
        right: {
          title: "Edge cloud",
          body: "Best for low-latency experiences, local inference, device-adjacent workflows, and resilience at the boundary.",
          accent: "primary",
          citationKeys: []
        },
        verdict: "Most enterprises need a governed blend rather than a universal target.",
        citationKeys: ["edge-cloud"]
      }
    },
    {
      role: "data-highlight",
      layoutId: "chart",
      title: "Chart assets render as real SVG output",
      beat: "Exercise the chart renderer and exported asset JSON.",
      supportingPoints: ["A chart slide consumes AssetIR and renders deterministic SVG without external libraries."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 8,
        kind: "chart",
        title: "Chart assets render as real SVG output",
        kicker: "Chart",
        chartType: "bar",
        dataAssetKey: "renderer-chart",
        insight: "Chart data travels through AssetIR, exported JSON, manifest, zip, and deterministic SVG render output.",
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "cta",
      layoutId: "cta",
      title: "Choose by workload, not fashion",
      beat: "Close with decision discipline.",
      supportingPoints: ["Use latency, data gravity, and risk as the selection criteria."],
      estimatedNarrativeChars: 260,
      slot: cta("Choose by workload, not fashion", "Score each workload before assigning it to central or edge infrastructure.")
    }
  ]
});

export const strategyPillarsDeckIr = makeDeckFixture({
  topic: "AI product strategy pillars",
  title: "AI Product Strategy Pillars",
  subtitle: "A compact framework for responsible AI product planning",
  audience: "executives",
  tone: "authoritative",
  format: "pitch",
  requiredSections: ["Pillars", "Execution"],
  slides: [
    {
      role: "cover",
      layoutId: "cover",
      title: "AI Product Strategy Pillars",
      beat: "Introduce the strategic frame.",
      supportingPoints: ["AI product work needs value, trust, and operating leverage."],
      estimatedNarrativeChars: 300,
      slot: commonCover("AI Product Strategy Pillars", "A compact framework for responsible AI product planning")
    },
    {
      role: "toc",
      layoutId: "toc",
      title: "The strategic checklist",
      beat: "Preview the pillars.",
      supportingPoints: ["Value", "Trust", "Operations"],
      estimatedNarrativeChars: 260,
      slot: commonToc("The strategic checklist", ["Value", "Trust", "Operations"])
    },
    {
      role: "analysis",
      layoutId: "three-column",
      title: "Three pillars make the roadmap durable",
      beat: "Explain the operating pillars.",
      supportingPoints: ["Value creates demand.", "Trust creates adoption.", "Operations creates repeatability."],
      estimatedNarrativeChars: 720,
      slot: {
        slideIndex: 3,
        kind: "three-column",
        title: "Three pillars make the roadmap durable",
        kicker: "Framework",
        cards: [
          { title: "Value", body: "Prioritize use cases with measurable user or business leverage.", accent: "primary", citationKeys: [] },
          { title: "Trust", body: "Design for explainability, safety, and user confidence from the first release.", accent: "secondary", citationKeys: [] },
          { title: "Operations", body: "Treat evaluation, monitoring, and rollback as product capabilities.", accent: "neutral", citationKeys: [] }
        ],
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "cta",
      layoutId: "cta",
      title: "Turn the pillars into release gates",
      beat: "Close with execution discipline.",
      supportingPoints: ["Each roadmap item should pass value, trust, and operations gates."],
      estimatedNarrativeChars: 260,
      slot: cta("Turn the pillars into release gates", "Require value, trust, and operations evidence before expanding an AI feature.")
    }
  ]
});

export const allCoreLayoutsDeckIr = makeDeckFixture({
  topic: "Deterministic HTML-PPT v2 renderer coverage",
  title: "Renderer Coverage Deck",
  subtitle: "One fixture exercising every core deterministic layout",
  audience: "engineers",
  tone: "rigorous",
  format: "tutorial",
  requiredSections: ["Coverage", "Layouts", "Renderer"],
  slides: [
    {
      role: "cover",
      layoutId: "cover",
      title: "Renderer Coverage Deck",
      beat: "Introduce deterministic renderer coverage.",
      supportingPoints: ["This fixture exercises every core layout without model-authored HTML."],
      estimatedNarrativeChars: 220,
      slot: commonCover("Renderer Coverage Deck", "One fixture exercising every core deterministic layout")
    },
    {
      role: "toc",
      layoutId: "toc",
      title: "Coverage map",
      beat: "List the renderer sections.",
      supportingPoints: ["Narrative sections align with deterministic layouts."],
      estimatedNarrativeChars: 240,
      slot: commonToc("Coverage map", ["Two columns", "Three cards", "Metrics", "Timeline", "Comparison", "Chart"])
    },
    {
      role: "analysis",
      layoutId: "two-column",
      title: "Two columns separate premise and implication",
      beat: "Exercise the two-column renderer.",
      supportingPoints: ["The layout holds symmetric explanatory content."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 3,
        kind: "two-column",
        title: "Two columns separate premise and implication",
        kicker: "Two-column",
        leftTitle: "Premise",
        leftBody: "The model should provide structured slot JSON instead of raw markup.",
        rightTitle: "Implication",
        rightBody: "The renderer owns class names, tag balance, and the HTML shell.",
        bullets: ["Typed slots", "Closed classes", "Stable render"],
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "analysis",
      layoutId: "three-column",
      title: "Three cards keep parallel ideas aligned",
      beat: "Exercise the three-column renderer.",
      supportingPoints: ["Parallel cards need equal structure and complete bodies."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 4,
        kind: "three-column",
        title: "Three cards keep parallel ideas aligned",
        kicker: "Three-column",
        cards: [
          { title: "Schema", body: "Zod validates every slot before render.", accent: "primary", citationKeys: ["cloud-servers"] },
          { title: "Renderer", body: "Templates emit only known class names.", accent: "secondary", citationKeys: ["edge-cloud"] },
          { title: "Verify", body: "Static checks inspect the output contract.", accent: "neutral", citationKeys: ["cloud-servers"] }
        ],
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "data-highlight",
      layoutId: "kpi-grid",
      title: "Metrics expose the render contract",
      beat: "Exercise the KPI grid renderer.",
      supportingPoints: ["Renderer health can be reported as stable counts."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 5,
        kind: "kpi-grid",
        title: "Metrics expose the render contract",
        kicker: "KPI grid",
        summary: "The fixture checks sections, assets, runtime, and manifest output.",
        metrics: [
          { label: "Core layouts", value: "9", note: "Initial deterministic set plus chart", citationKeys: ["cloud-servers"] },
          { label: "Model HTML", value: "0", note: "Forbidden in v2 path", citationKeys: ["edge-cloud"] },
          { label: "Output files", value: "7+", note: "HTML, CSS, runtime, manifest, chart assets", citationKeys: ["cloud-servers"] }
        ],
        citationKeys: ["cloud-servers"]
      }
    },
    {
      role: "process",
      layoutId: "timeline",
      title: "The render path is sequential and measurable",
      beat: "Exercise timeline renderer.",
      supportingPoints: ["Validation, render, write, and verify form a stable path."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 6,
        kind: "timeline",
        title: "The render path is sequential and measurable",
        kicker: "Timeline",
        events: [
          { label: "Validate", description: "Parse DeckIR and reject invalid structures.", accent: "neutral", citationKeys: ["cloud-servers"] },
          { label: "Render", description: "Convert slot fills into deterministic sections.", accent: "primary", citationKeys: ["edge-cloud"] },
          { label: "Compose", description: "Build CSS, runtime, manifest, and HTML shell.", accent: "secondary", citationKeys: ["cloud-servers"] },
          { label: "Verify", description: "Check files, counts, and output invariants.", accent: "primary", citationKeys: ["edge-cloud"] }
        ],
        citationKeys: ["edge-cloud"]
      }
    },
    {
      role: "comparison",
      layoutId: "comparison",
      title: "The v2 path removes the riskiest authoring surface",
      beat: "Exercise comparison renderer.",
      supportingPoints: ["The model still writes content, but not tags or styles."],
      estimatedNarrativeChars: 420,
      slot: {
        slideIndex: 7,
        kind: "comparison",
        title: "The v2 path removes the riskiest authoring surface",
        kicker: "Comparison",
        left: { title: "Legacy risk", body: "Raw HTML and CSS can leak donor text, break navigation, or invent class names.", accent: "bad", citationKeys: ["cloud-servers"] },
        right: { title: "V2 contract", body: "Typed JSON feeds deterministic templates with known classes and runtime behavior.", accent: "good", citationKeys: ["edge-cloud"] },
        verdict: "The renderer is now a controlled compiler target rather than a model-authored artifact.",
        citationKeys: ["edge-cloud"]
      }
    },
    {
      role: "cta",
      layoutId: "cta",
      title: "Use fixtures as the safety rail",
      beat: "Close the coverage fixture.",
      supportingPoints: ["Every later stage should preserve these deterministic renderer guarantees."],
      estimatedNarrativeChars: 260,
      slot: cta("Use fixtures as the safety rail", "Run the fixture suite before adding any model-authored IR stage.")
    }
  ]
});

export const deckIrFixtures = [
  sampleDeckIr,
  operationsMetricsDeckIr,
  marketComparisonDeckIr,
  strategyPillarsDeckIr,
  allCoreLayoutsDeckIr
] satisfies DeckIR[];
