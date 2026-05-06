import { CORE_LAYOUT_RENDERER_IDS, coreLayoutPackages, renderCoreLayout } from "../renderer";
import { slideSlotFillSchema, type SlideSlotFillIR } from "../ir";

const fills: SlideSlotFillIR[] = [
  {
    slideIndex: 1,
    kind: "cover",
    title: "Cloud <Servers> & Future",
    kicker: "Executive Briefing",
    subtitle: "Applications today, infrastructure tomorrow",
    meta: ["4 slides", "Strategic overview"],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 2,
    kind: "toc",
    title: "Three questions for leaders",
    kicker: "Agenda",
    items: [
      { label: "Where cloud helps now", description: "Delivery speed and operating leverage" },
      { label: "What changes next", description: "Edge, AI, and distributed services" },
      { label: "How to prepare", description: "Workload-fit roadmap" }
    ],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 3,
    kind: "two-column",
    title: "Applications expand from hosting to intelligent operations",
    kicker: "Current applications",
    leftTitle: "Immediate value",
    leftBody: "Cloud servers reduce provisioning delays and let teams test, deploy, and scale services.",
    rightTitle: "Future shift",
    rightBody: "The next phase blends core cloud regions with edge nodes for latency-sensitive services.",
    bullets: ["Elastic compute", "Managed reliability", "Edge inference"],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 4,
    kind: "three-column",
    title: "Three operating shifts",
    kicker: "Impact",
    cards: [
      { title: "Speed", body: "Teams can provision environments faster.", accent: "primary", citationKeys: [] },
      { title: "Scale", body: "Capacity follows demand instead of procurement cycles.", accent: "secondary", citationKeys: [] },
      { title: "Focus", body: "Engineers spend more time on product workflows.", accent: "neutral", citationKeys: [] }
    ],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 5,
    kind: "kpi-grid",
    title: "Signals to track",
    kicker: "Metrics",
    summary: "A cloud roadmap should be managed through operational indicators, not migration volume.",
    metrics: [
      { label: "Provisioning", value: "Minutes", note: "Baseline environment setup", citationKeys: [] },
      { label: "Availability", value: "99.9%+", note: "Service-level target", citationKeys: [] },
      { label: "Latency", value: "<50ms", note: "Edge-sensitive paths", citationKeys: [] }
    ],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 6,
    kind: "timeline",
    title: "Infrastructure maturity path",
    kicker: "Roadmap",
    events: [
      { label: "Inventory", date: "Now", description: "Classify workloads by risk, latency, and data gravity.", accent: "neutral", citationKeys: [] },
      { label: "Pilot", date: "30 days", description: "Run one production-adjacent workload with strict telemetry.", accent: "primary", citationKeys: [] },
      { label: "Scale", date: "90 days", description: "Standardize deployment, reliability, and cost controls.", accent: "secondary", citationKeys: [] },
      { label: "Optimize", date: "180 days", description: "Blend core cloud with edge services for critical paths.", accent: "primary", citationKeys: [] }
    ],
    citationKeys: ["edge-cloud"]
  },
  {
    slideIndex: 7,
    kind: "comparison",
    title: "Central cloud and edge cloud play different roles",
    kicker: "Comparison",
    left: {
      title: "Central cloud",
      body: "Best for shared services, batch processing, and global coordination.",
      accent: "neutral",
      citationKeys: []
    },
    right: {
      title: "Edge cloud",
      body: "Best for low-latency experiences, local inference, and device-adjacent workloads.",
      accent: "primary",
      citationKeys: []
    },
    verdict: "The correct target is a workload-fit blend, not a single universal platform.",
    citationKeys: ["edge-cloud"]
  },
  {
    slideIndex: 8,
    kind: "bullet-list",
    title: "Execution checklist stays readable",
    kicker: "Checklist",
    lede: "A bullet-list slide groups operational decisions without forcing every point into a card.",
    groups: [
      {
        title: "Plan",
        items: ["Classify workloads", "Define success signals", "Set ownership"],
        accent: "primary",
        citationKeys: []
      },
      {
        title: "Operate",
        items: ["Monitor latency", "Review spend", "Document rollback paths"],
        accent: "secondary",
        citationKeys: []
      }
    ],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 9,
    kind: "process",
    title: "A migration path should be staged",
    kicker: "Process",
    lede: "The process layout turns a roadmap into explicit steps with ownership and sequence.",
    steps: [
      { label: "01", title: "Assess", description: "Map workload constraints before choosing a target.", accent: "neutral", citationKeys: [] },
      { label: "02", title: "Pilot", description: "Run one bounded service with strict observability.", accent: "primary", citationKeys: [] },
      { label: "03", title: "Scale", description: "Standardize automation only after the pilot proves durable.", accent: "secondary", citationKeys: [] }
    ],
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 10,
    kind: "stat-highlight",
    title: "One key number can anchor the story",
    kicker: "Signal",
    value: "50ms",
    label: "Latency target",
    explanation: "A single performance threshold can clarify where edge capacity matters most.",
    cards: [
      { title: "Experience", body: "Interactive paths need lower latency than background jobs.", accent: "primary", citationKeys: [] },
      { title: "Placement", body: "Compute moves closer to the user when the target cannot be met centrally.", accent: "secondary", citationKeys: [] }
    ],
    citationKeys: ["edge-cloud"]
  },
  {
    slideIndex: 11,
    kind: "section-divider",
    title: "From platform choice to operating model",
    kicker: "Transition",
    marker: "02",
    progressText: "Section 2 of 3",
    supportingText: "The deck can introduce strong narrative breaks without turning them into dense content slides.",
    citationKeys: []
  },
  {
    slideIndex: 12,
    kind: "quote",
    title: "A principle for migration choices",
    kicker: "Principle",
    quote: "Cloud strategy is strongest when it follows workload fit rather than fashion.",
    attribution: "Infrastructure operating model",
    supportingText: "The quote layout provides a visual pause and makes a synthesis point memorable.",
    citationKeys: []
  },
  {
    slideIndex: 13,
    kind: "image-hero",
    title: "The operating model needs a visual anchor",
    kicker: "Visual model",
    lede: "Image-hero can use an asset when available, or fall back to a deterministic visual placeholder.",
    visualLabel: "EDGE",
    body: "Use this layout when a case study, product scene, or conceptual model needs stronger visual hierarchy.",
    chips: ["Latency", "Reliability", "Cost control"],
    citationKeys: ["edge-cloud"]
  },
  {
    slideIndex: 14,
    kind: "chart",
    title: "Evidence becomes a chart asset",
    kicker: "Chart",
    chartType: "bar",
    dataAssetKey: "evidence-chart",
    insight: "The deterministic chart renderer can emit SVG without model-authored HTML or external chart libraries.",
    citationKeys: ["cloud-servers"]
  },
  {
    slideIndex: 15,
    kind: "cta",
    title: "Build the roadmap around workload fit",
    kicker: "Next step",
    headline: "Move deliberately, not universally",
    action: "Rank workloads by latency, data gravity, risk, and operating maturity.",
    supportingText: "Selective modernization usually beats broad migration theater.",
    citationKeys: ["edge-cloud"]
  }
];

if (fills.length !== CORE_LAYOUT_RENDERER_IDS.length) {
  throw new Error(`Expected ${CORE_LAYOUT_RENDERER_IDS.length} core fixtures, got ${fills.length}.`);
}

for (const fill of fills) {
  slideSlotFillSchema.parse(fill);
  const rendered = renderCoreLayout(fill);
  const html = rendered.html;
  const sectionCount = (html.match(/<section\b/g) ?? []).length;
  const closingCount = (html.match(/<\/section>/g) ?? []).length;

  if (sectionCount !== 1 || closingCount !== 1) {
    throw new Error(`${fill.kind} renderer must emit exactly one section.`);
  }
  if (!html.includes(`data-layoutid="${fill.kind}"`)) {
    throw new Error(`${fill.kind} renderer missed data-layoutid.`);
  }
  if (!html.includes(`data-slide-index="${fill.slideIndex}"`)) {
    throw new Error(`${fill.kind} renderer missed data-slide-index.`);
  }
  if (html.includes("<script") || html.includes(" style=")) {
    throw new Error(`${fill.kind} renderer emitted unsafe script or inline style.`);
  }
  if (html.includes("Cloud <Servers>")) {
    throw new Error("Renderer failed to escape unsafe title text.");
  }
  if (fill.citationKeys.length && !html.includes("data-citation-keys=")) {
    throw new Error(`${fill.kind} renderer must keep citation keys in hidden DOM metadata.`);
  }
  if (html.includes('<span class="citation-key">')) {
    throw new Error(`${fill.kind} renderer must not render citation keys as visible slide text.`);
  }
}

if (coreLayoutPackages.length !== CORE_LAYOUT_RENDERER_IDS.length) {
  throw new Error(`Expected ${CORE_LAYOUT_RENDERER_IDS.length} layout packages, got ${coreLayoutPackages.length}.`);
}

for (const layoutPackage of coreLayoutPackages) {
  slideSlotFillSchema.parse(layoutPackage.sampleFill);
  const rendered = renderCoreLayout(layoutPackage.sampleFill);
  const classTokens = [...rendered.html.matchAll(/\bclass="([^"]+)"/g)]
    .flatMap((match) => (match[1] ?? "").split(/\s+/).filter(Boolean));
  const allowed = new Set(layoutPackage.allowedClasses);
  // donor-* and dna-* are dynamic donor-vocabulary classes injected by the renderer context;
  // they are explicitly allowed by design (consistent with static-checks.ts isAllowedDynamicClass).
  const unknown = classTokens.filter((className) => !allowed.has(className) && !className.startsWith("donor-") && !className.startsWith("dna-"));

  if (rendered.layoutId !== layoutPackage.id || !rendered.html.includes(`data-layoutid="${layoutPackage.id}"`)) {
    throw new Error(`${layoutPackage.id} package renderer did not preserve its layout id.`);
  }

  if (unknown.length) {
    throw new Error(`${layoutPackage.id} package emitted classes not declared in allowedClasses: ${[...new Set(unknown)].join(", ")}`);
  }
}

console.log(`HTML-PPT v2 core layout renderer verification passed. renderers=${CORE_LAYOUT_RENDERER_IDS.length} packages=${coreLayoutPackages.length}`);
