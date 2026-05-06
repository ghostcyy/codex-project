import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { DeckIR } from "../ir";
import { checkStaticClassCoverage, DeckRendererService, readZipEntryNames } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry, type SkillRegistry } from "../registry";
import { deckIrFixtures } from "./fixtures/deck-ir-fixtures";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const outputDir = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "phase3-fixtures");
  const runtimeRoot = resolve(workspaceRoot, ".local-runtime");
  if (!outputDir.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputDir: ${outputDir}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const renderer = new DeckRendererService();

  const requiredFiles = [
    "index.html",
    "preview.html",
    "standalone.html",
    "style.css",
    "manifest.json",
    "html-ppt-deck.zip",
    join("assets", "runtime-v2.js")
  ];

  if (deckIrFixtures.length !== 5) {
    throw new Error(`Expected 5 DeckIR fixtures, got ${deckIrFixtures.length}.`);
  }

  for (const [fixtureIndex, deck] of deckIrFixtures.entries()) {
    const fixtureOutputDir = join(outputDir, `fixture-${fixtureIndex + 1}`);
    const rendered = await renderer.renderToDirectory(deck, {
      outputDir: fixtureOutputDir,
      registryHash: registry.hash
    });

    for (const file of requiredFiles) {
      const target = join(fixtureOutputDir, file);
      if (!existsSync(target)) {
        throw new Error(`Deck renderer did not write required file: ${target}`);
      }
    }

    const indexHtml = await readFile(join(fixtureOutputDir, "index.html"), "utf8");
    const previewHtml = await readFile(join(fixtureOutputDir, "preview.html"), "utf8");
    const standaloneHtml = await readFile(join(fixtureOutputDir, "standalone.html"), "utf8");
    const styleCss = await readFile(join(fixtureOutputDir, "style.css"), "utf8");
    const runtimeJs = await readFile(join(fixtureOutputDir, "assets", "runtime-v2.js"), "utf8");
    const zipBuffer = await readFile(join(fixtureOutputDir, "html-ppt-deck.zip"));
    const manifest = JSON.parse(await readFile(join(fixtureOutputDir, "manifest.json"), "utf8")) as {
      slideCount?: number;
      registryHash?: string;
      deckIr?: unknown;
      files?: { zip?: string; assets?: string[] };
    };

    const sectionCount = (indexHtml.match(/<section\b/g) ?? []).length;
    if (sectionCount !== deck.intent.derivedSlideCount) {
      throw new Error(`Expected ${deck.intent.derivedSlideCount} rendered sections, got ${sectionCount}.`);
    }

    if ((indexHtml.match(/class="slide[^"]*is-active/g) ?? []).length !== 1) {
      throw new Error("Rendered deck must contain exactly one active slide.");
    }

    if (!indexHtml.includes('href="style.css"') || !indexHtml.includes('src="assets/runtime-v2.js"')) {
      throw new Error("index.html must reference external deterministic CSS and runtime assets.");
    }

    if (!indexHtml.includes('data-font-provider="google-fonts"') || !indexHtml.includes("fonts.googleapis.com")) {
      throw new Error("index.html must include deterministic font resource links for active typography tokens.");
    }

    const chartAssets = Object.entries(deck.assets).filter(([, asset]) => asset.kind === "chart");
    for (const [assetKey] of chartAssets) {
      const chartFile = `chart-${safeAssetFileSlug(assetKey)}.json`;
      const chartPath = join(fixtureOutputDir, "assets", chartFile);
      if (!existsSync(chartPath)) {
        throw new Error(`Deck renderer did not export chart asset JSON: ${chartPath}`);
      }
      const chartJson = JSON.parse(await readFile(chartPath, "utf8")) as { labels?: unknown[]; series?: unknown[] };
      if (!Array.isArray(chartJson.labels) || !Array.isArray(chartJson.series) || !chartJson.labels.length || !chartJson.series.length) {
        throw new Error(`Chart asset JSON must include non-empty labels and series: ${chartFile}`);
      }
      if (!indexHtml.includes(`data-asset-key="${assetKey}"`) || !indexHtml.includes('class="chart-svg"')) {
        throw new Error(`Rendered chart slide must bind ${assetKey} to deterministic SVG output.`);
      }
      if (!rendered.files.assets[chartFile]) {
        throw new Error(`RenderedDeck.files.assets missing chart file: ${chartFile}`);
      }
    }

    if (!standaloneHtml.includes("<style>") || !standaloneHtml.includes("<script>")) {
      throw new Error("standalone.html must inline deterministic CSS and runtime assets.");
    }

    if (previewHtml !== indexHtml) {
      throw new Error("Phase 3 preview.html should match index.html until the product preview shell is added.");
    }

    if (!styleCss.includes(`body.${deck.design.deckClass}`) || !styleCss.includes("--accent:")) {
      throw new Error("style.css must include deckClass-scoped CSS and theme tokens.");
    }

    if (!indexHtml.includes(`data-donor="${deck.design.donorTemplateId}"`) || !styleCss.includes(`[data-donor='${deck.design.donorTemplateId}']`)) {
      throw new Error("Rendered deck must expose donorTemplateId in the DOM and donor-scoped visual DNA in CSS.");
    }
    if (
      !indexHtml.includes(`data-dna-density="${deck.design.donorContract.dnaSignature.density}"`)
      || !indexHtml.includes(`data-dna-title-treatment="${deck.design.donorContract.dnaSignature.titleTreatment}"`)
      || !indexHtml.includes(`data-dna-card-treatment="${deck.design.donorContract.dnaSignature.cardTreatment}"`)
      || !indexHtml.includes(`data-dna-kicker-treatment="${deck.design.donorContract.dnaSignature.kickerTreatment}"`)
      || !indexHtml.includes(`data-dna-accent-rule="${deck.design.donorContract.dnaSignature.accentRule}"`)
    ) {
      throw new Error("Rendered deck must expose donor DNA metadata on the body tag.");
    }
    if (
      !styleCss.includes(`--donor-density: "${deck.design.donorContract.dnaSignature.density}"`)
      || !styleCss.includes(`--donor-title-treatment: "${deck.design.donorContract.dnaSignature.titleTreatment}"`)
      || !styleCss.includes(`--donor-card-treatment: "${deck.design.donorContract.dnaSignature.cardTreatment}"`)
      || !styleCss.includes(`--donor-kicker-treatment: "${deck.design.donorContract.dnaSignature.kickerTreatment}"`)
      || !styleCss.includes(`--donor-accent-rule: "${deck.design.donorContract.dnaSignature.accentRule}"`)
    ) {
      throw new Error("Rendered deck must write donor DNA contract variables into style.css.");
    }

    if (!runtimeJs.includes("activateSlide") || !runtimeJs.includes("ArrowRight")) {
      throw new Error("runtime-v2.js must include deterministic keyboard navigation.");
    }

    for (const item of deck.choreography) {
      const sectionHtml = sectionHtmlForSlide(indexHtml, item.slideIndex);
      if (!sectionHtml) {
        throw new Error(`Could not locate rendered section for choreography slide ${item.slideIndex}.`);
      }

      if (item.entrance && item.entrance !== "none") {
        if (!sectionHtml.includes(`anim-${item.entrance}`) || !sectionHtml.includes(`data-anim="${item.entrance}"`)) {
          throw new Error(`Slide ${item.slideIndex} did not render entrance choreography '${item.entrance}'.`);
        }
      }

      if (item.fx && item.fx !== "none" && !sectionHtml.includes(`data-fx="${item.fx}"`)) {
        throw new Error(`Slide ${item.slideIndex} did not render FX choreography '${item.fx}'.`);
      }

      if (item.builds.length) {
        if (!sectionHtml.includes("data-build-targets=") || !sectionHtml.includes("data-builds=")) {
          throw new Error(`Slide ${item.slideIndex} did not render build choreography metadata.`);
        }
        for (const build of item.builds) {
          const target = build.target;
          const spec = `${target}:${build.anim}:${build.delay}`;
          if (!sectionHtml.includes(target) || !sectionHtml.includes(spec)) {
            throw new Error(`Slide ${item.slideIndex} build choreography missing '${spec}'.`);
          }
        }
      }
    }

    if (
      manifest.slideCount !== deck.intent.derivedSlideCount ||
      manifest.registryHash !== registry.hash ||
      manifest.files?.zip !== "html-ppt-deck.zip" ||
      !manifest.deckIr
    ) {
      throw new Error("manifest.json must include slideCount, registryHash, zip path, and DeckIR snapshot.");
    }

    const zipEntryNames = new Set(readZipEntryNames(zipBuffer));
    for (const entryName of ["index.html", "preview.html", "standalone.html", "style.css", "manifest.json", "assets/runtime-v2.js"]) {
      if (!zipEntryNames.has(entryName)) {
        throw new Error(`html-ppt-deck.zip missing expected entry: ${entryName}`);
      }
    }

    for (const [assetKey] of chartAssets) {
      const assetEntry = `assets/chart-${safeAssetFileSlug(assetKey)}.json`;
      if (!zipEntryNames.has(assetEntry)) {
        throw new Error(`html-ppt-deck.zip missing chart asset entry: ${assetEntry}`);
      }
      if (!manifest.files?.assets?.includes(assetEntry)) {
        throw new Error(`manifest.json missing chart asset entry: ${assetEntry}`);
      }
    }

    if (indexHtml.includes(" style=") || indexHtml.includes("<script>")) {
      throw new Error("index.html should not contain inline styles or inline scripts in the deterministic v2 path.");
    }

    if (rendered.sections.length !== deck.intent.derivedSlideCount) {
      throw new Error("RenderedDeck.sections length mismatch.");
    }

    const classCoverage = checkStaticClassCoverage({ html: indexHtml, deckClass: deck.design.deckClass });
    if (classCoverage.unknownClasses.length) {
      throw new Error(`Rendered deck emitted unregistered classes: ${JSON.stringify(classCoverage.unknownClasses)}`);
    }

    if (indexHtml.includes('<span class="citation-key">')) {
      throw new Error("Rendered deck must not expose citation keys as visible slide text.");
    }

    if (hasAnyCitationKeys(deck.slots) && !indexHtml.includes("data-citation-keys=")) {
      throw new Error("Rendered deck must preserve citation keys in hidden DOM metadata.");
    }

    if (hasNestedCitationKeys(deck.slots) && !indexHtml.includes("inline-citation-row")) {
      throw new Error("Rendered deck must expose nested card/metric/event/panel citation keys.");
    }
  }

  await assertExplicitDonorFallbackProfiles({
    outputDir,
    renderer,
    registry,
    baseDeck: deckIrFixtures[0]!
  });
  await assertUnsafeDonorCssSanitization({
    outputDir,
    renderer,
    registry,
    baseDeck: deckIrFixtures[0]!
  });
  await assertFirstBatchLayoutDna({
    outputDir,
    renderer,
    registry,
    baseDeck: deckIrFixtures[0]!
  });
  await assertSecondBatchLayoutDna({
    outputDir,
    renderer,
    registry,
    baseDeck: deckIrFixtures[0]!
  });

  console.log(`HTML-PPT v2 deck renderer verification passed. fixtures=${deckIrFixtures.length} outputDir=${outputDir}`);
}

function safeAssetFileSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "asset";
}

function sectionHtmlForSlide(html: string, slideIndex: number): string {
  const pattern = new RegExp(`<section\\b(?=[^>]*data-slide-index="${slideIndex}")[\\s\\S]*?<\\/section>`, "i");
  return pattern.exec(html)?.[0] ?? "";
}

function hasNestedCitationKeys(slots: typeof deckIrFixtures[number]["slots"]): boolean {
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

function hasAnyCitationKeys(slots: typeof deckIrFixtures[number]["slots"]): boolean {
  return slots.some((slot) => {
    if (slot.citationKeys.length) return true;
    switch (slot.kind) {
      case "three-column":
        return slot.cards.some((card) => card.citationKeys.length > 0);
      case "kpi-grid":
        return slot.metrics.some((metric) => metric.citationKeys.length > 0);
      case "timeline":
        return slot.events.some((event) => event.citationKeys.length > 0);
      case "comparison":
        return slot.left.citationKeys.length > 0 || slot.right.citationKeys.length > 0;
      case "bullet-list":
        return slot.groups.some((group) => group.citationKeys.length > 0);
      case "process":
        return slot.steps.some((step) => step.citationKeys.length > 0);
      case "stat-highlight":
        return slot.cards.some((card) => card.citationKeys.length > 0);
      default:
        return false;
    }
  });
}

async function assertExplicitDonorFallbackProfiles(input: {
  outputDir: string;
  renderer: DeckRendererService;
  registry: SkillRegistry;
  baseDeck: DeckIR;
}) {
  const expectations = [
    {
      id: "testing-safety-alert",
      markers: [
        "--renderer-fallback-profile: 'testing-safety-alert'",
        "repeating-linear-gradient(135deg",
        "content: 'ALERT'",
        "box-shadow: 54px 0 0 var(--warn), 108px 0 0 var(--good)"
      ]
    },
    {
      id: "presenter-mode-reveal",
      markers: [
        "--renderer-fallback-profile: 'presenter-mode-reveal'",
        "content: 'STAGE'",
        "border-radius: 999px 26px 26px 999px",
        "justify-content: flex-end"
      ]
    }
  ] as const;

  for (const expectation of expectations) {
    const template = input.registry.templatePackages.find((item) => item.id === expectation.id);
    if (!template) {
      throw new Error(`Missing registry donor/template for explicit fallback profile: ${expectation.id}`);
    }

    const deck = JSON.parse(JSON.stringify(input.baseDeck)) as DeckIR;
    deck.design = {
      ...deck.design,
      themeId: template.themeId,
      donorTemplateId: template.donorTemplateId,
      donorContract: {
        ...deck.design.donorContract,
        id: template.donorTemplateId,
        decorativeClasses: [],
        coverOnlyClasses: [],
        bodyAllowedClasses: [],
        forbiddenTextPatterns: [],
        dnaSignature: {
          ...deck.design.donorContract.dnaSignature,
          titleTreatment: `Renderer verification title treatment for ${template.id}.`,
          cardTreatment: `Renderer verification card treatment for ${template.id}.`,
          kickerTreatment: `Renderer verification kicker treatment for ${template.id}.`
        }
      },
      deckClass: template.deckClass,
      audienceFitReport: {
        ...deck.design.audienceFitReport,
        reasons: [`Renderer verification pinned ${template.id} to assert explicit fallback visual DNA.`]
      }
    };

    const profileOutputDir = join(input.outputDir, `explicit-profile-${expectation.id}`);
    await input.renderer.renderToDirectory(deck, {
      outputDir: profileOutputDir,
      registryHash: input.registry.hash
    });
    const styleCss = await readFile(join(profileOutputDir, "style.css"), "utf8");
    const selector = `body.${template.deckClass}[data-donor='${template.donorTemplateId}']`;
    if (!styleCss.includes(selector)) {
      throw new Error(`Explicit fallback profile for ${expectation.id} must be donor-scoped under ${selector}.`);
    }
    for (const marker of expectation.markers) {
      if (!styleCss.includes(marker)) {
        throw new Error(`Explicit fallback profile for ${expectation.id} missing marker: ${marker}`);
      }
    }
  }
}

async function assertUnsafeDonorCssSanitization(input: {
  outputDir: string;
  renderer: DeckRendererService;
  registry: SkillRegistry;
  baseDeck: DeckIR;
}) {
  const registry = JSON.parse(JSON.stringify(input.registry)) as SkillRegistry;
  const donor = registry.donors.find((item) => item.id === "tech-sharing");
  if (!donor) {
    throw new Error("Missing tech-sharing donor for unsafe donor CSS sanitizer verification.");
  }
  donor.css = [
    "@supports (display: grid) { .tpl-tech-sharing .card { color: red; } }",
    "@container deck (min-width: 400px) { .tpl-tech-sharing .card { color: blue; } }",
    "@unknown-rule { .tpl-tech-sharing .card { color: green; } }",
    ".tpl-tech-sharing .card {",
    "  color: #123456;",
    "  background: url('https://evil.example/tracker.png');",
    "  background-image: image-set('x.png' 1x);",
    "  filter: url(#bad);",
    "  box-shadow: expression(alert(1));",
    "  behavior: url(owned.htc);",
    "  --safe-local-token: linear-gradient(90deg,#fff,#000);",
    "  --unsafe-local-token: url(file:///C:/secret.png);",
    "  border-color: javascript:alert(1);",
    "  outline: 1px solid data:text/html,boom;",
    "  padding: 20px 24px;",
    "}"
  ].join("\n");

  const sanitizerOutputDir = join(input.outputDir, "unsafe-donor-css-sanitizer");
  await input.renderer.renderToDirectory(input.baseDeck, {
    outputDir: sanitizerOutputDir,
    registry,
    registryHash: registry.hash
  });
  const styleCss = await readFile(join(sanitizerOutputDir, "style.css"), "utf8");
  const forbiddenMarkers = [
    "@supports",
    "@container",
    "@unknown-rule",
    "evil.example",
    "url(",
    "image-set(",
    "expression(",
    "behavior:",
    "javascript:",
    "data:text",
    "--unsafe-local-token"
  ];
  for (const marker of forbiddenMarkers) {
    if (styleCss.includes(marker)) {
      throw new Error(`Donor CSS sanitizer leaked unsafe marker: ${marker}`);
    }
  }
  const requiredSafeMarkers = [
    "color: #123456",
    "--safe-local-token: linear-gradient(90deg,#fff,#000)",
    "padding: 20px 24px"
  ];
  for (const marker of requiredSafeMarkers) {
    if (!styleCss.includes(marker)) {
      throw new Error(`Donor CSS sanitizer stripped expected safe marker: ${marker}`);
    }
  }
}

async function assertFirstBatchLayoutDna(input: {
  outputDir: string;
  renderer: DeckRendererService;
  registry: SkillRegistry;
  baseDeck: DeckIR;
}) {
  const deck = JSON.parse(JSON.stringify(input.baseDeck)) as DeckIR;
  deck.intent = {
    ...deck.intent,
    hardConstraints: { ...deck.intent.hardConstraints, slideCount: 3, narrativeChars: 390 },
    derivedSlideCount: 3,
    derivedNarrativeChars: 390
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
          subhead: "Editorial emphasis",
          supportingPoints: ["A quote should feel intentionally paced."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 120
      },
      {
        index: 2,
        role: "transition-divider",
        beat: "The deck resets into the next section.",
        contentBrief: {
          headline: "Section Divider",
          subhead: "A low-density rhythm break.",
          supportingPoints: ["The marker tells the audience where they are."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 110
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
        estimatedNarrativeChars: 160
      }
    ],
    totalEstimatedChars: 390,
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

  const layoutOutputDir = join(input.outputDir, "first-batch-layout-dna");
  await input.renderer.renderToDirectory(deck, {
    outputDir: layoutOutputDir,
    registry: input.registry,
    registryHash: input.registry.hash
  });
  const indexHtml = await readFile(join(layoutOutputDir, "index.html"), "utf8");
  const styleCss = await readFile(join(layoutOutputDir, "style.css"), "utf8");
  const expectedHtmlMarkers = [
    'data-layoutid="quote"',
    "quote-text",
    'data-layoutid="section-divider"',
    "section-marker",
    'data-layoutid="stat-highlight"',
    "stat-value",
    "stat-card"
  ];
  for (const marker of expectedHtmlMarkers) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`First-batch layout renderer missing HTML marker: ${marker}`);
    }
  }
  const expectedCssMarkers = [".quote-text", ".section-divider-shell", ".stat-highlight-shell", ".stat-card"];
  for (const marker of expectedCssMarkers) {
    if (!styleCss.includes(marker)) {
      throw new Error(`First-batch layout renderer missing CSS marker: ${marker}`);
    }
  }
  const classCoverage = checkStaticClassCoverage({ html: indexHtml, deckClass: deck.design.deckClass });
  if (classCoverage.unknownClasses.length) {
    throw new Error(`First-batch layout renderer emitted unregistered classes: ${JSON.stringify(classCoverage.unknownClasses)}`);
  }
}

async function assertSecondBatchLayoutDna(input: {
  outputDir: string;
  renderer: DeckRendererService;
  registry: SkillRegistry;
  baseDeck: DeckIR;
}) {
  const deck = JSON.parse(JSON.stringify(input.baseDeck)) as DeckIR;
  deck.intent = {
    ...deck.intent,
    hardConstraints: { ...deck.intent.hardConstraints, slideCount: 3, narrativeChars: 420 },
    derivedSlideCount: 3,
    derivedNarrativeChars: 420
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
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 140
      },
      {
        index: 2,
        role: "process",
        beat: "The process renderer owns numbered steps and connectors.",
        contentBrief: {
          headline: "Process Flow",
          supportingPoints: ["Frame the input.", "Execute the path.", "Verify the result."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 140
      },
      {
        index: 3,
        role: "case-study",
        beat: "A visual hero can use a safe placeholder when no asset exists.",
        contentBrief: {
          headline: "Image Hero",
          subhead: "Safe visual area.",
          supportingPoints: ["Placeholder visuals stay deterministic.", "Text remains typed and scannable."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 140
      }
    ],
    totalEstimatedChars: 420,
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

  const layoutOutputDir = join(input.outputDir, "second-batch-layout-dna");
  await input.renderer.renderToDirectory(deck, {
    outputDir: layoutOutputDir,
    registry: input.registry,
    registryHash: input.registry.hash
  });
  const indexHtml = await readFile(join(layoutOutputDir, "index.html"), "utf8");
  const styleCss = await readFile(join(layoutOutputDir, "style.css"), "utf8");
  const expectedHtmlMarkers = [
    'data-layoutid="bullet-list"',
    "bullet-list-shell",
    "bullet-group",
    "bullet-item",
    'data-layoutid="process"',
    "process-shell",
    "process-step",
    "process-step-number",
    'data-layoutid="image-hero"',
    "image-hero-shell",
    "image-hero-visual",
    "image-hero-placeholder",
    "image-hero-chip"
  ];
  for (const marker of expectedHtmlMarkers) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`Second-batch layout renderer missing HTML marker: ${marker}`);
    }
  }
  const expectedCssMarkers = [".bullet-group-grid", ".process-flow", ".image-hero-shell", ".image-hero-placeholder"];
  for (const marker of expectedCssMarkers) {
    if (!styleCss.includes(marker)) {
      throw new Error(`Second-batch layout renderer missing CSS marker: ${marker}`);
    }
  }
  const classCoverage = checkStaticClassCoverage({ html: indexHtml, deckClass: deck.design.deckClass });
  if (classCoverage.unknownClasses.length) {
    throw new Error(`Second-batch layout renderer emitted unregistered classes: ${JSON.stringify(classCoverage.unknownClasses)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
