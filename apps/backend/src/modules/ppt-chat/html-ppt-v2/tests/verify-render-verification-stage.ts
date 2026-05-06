import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DeckRendererService, readZipEntryNames } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry, resolveTemplatePackageSelection, type SkillRegistry, type TemplatePackage } from "../registry";
import { runRenderVerificationStage } from "../stages";
import { deckIrFixtures } from "./fixtures/deck-ir-fixtures";
import type { DeckIR } from "../ir";
import type { Page } from "playwright";

type ScreenshotCssProbe = {
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  borderRadius: string;
  borderTopWidth: string;
  boxShadow: string;
  color: string;
  content: string;
  letterSpacing: string;
  textTransform: string;
};

type ScreenshotStyleProbe = {
  bodyClass: string;
  bodyDonor: string | null;
  fallbackProfile: string;
  viewport: { width: number; height: number };
  deckRect: { width: number; height: number };
  deck: ScreenshotCssProbe;
  deckBefore: ScreenshotCssProbe;
  deckAfter: ScreenshotCssProbe;
  deckViewport: ScreenshotCssProbe;
  kicker: ScreenshotCssProbe;
  kickerBefore: ScreenshotCssProbe;
  card: ScreenshotCssProbe;
};

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const outputDir = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-fixture");
  const runtimeRoot = resolve(workspaceRoot, ".local-runtime");
  if (!outputDir.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputDir: ${outputDir}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const selectedTemplate = requireTemplate(registry, "tech-sharing");
  const deck = deckIrFixtures[0];
  if (!deck) {
    throw new Error("Missing DeckIR fixture for render verification.");
  }

  const renderer = new DeckRendererService();
  await renderer.renderToDirectory(deck, { outputDir, registryHash: registry.hash, registry });

  const report = await runRenderVerificationStage({ outputDir, deck, registryHash: registry.hash, selectedTemplate, browserVerification: "required" });
  if (report.status === "failed" || report.summary.hardIssueCount !== 0) {
    throw new Error(`Expected clean render verification without hard issues: ${JSON.stringify(report.hardIssues)}`);
  }
  if (report.signals.templateFidelity.status !== "pass") {
    throw new Error(`Expected pinned template fidelity checks to pass: ${JSON.stringify(report.signals.templateFidelity.issues)}`);
  }
  if (report.mode !== "playwright" || report.summary.screenshotCount !== deck.intent.derivedSlideCount) {
    throw new Error("Render verification must run Playwright and capture one screenshot per slide.");
  }
  for (const screenshot of report.screenshots) {
    if (!existsSync(join(outputDir, screenshot.file))) {
      throw new Error(`Missing browser verification screenshot: ${screenshot.file}`);
    }
  }
  if (!existsSync(join(outputDir, "verification-report.json"))) {
    throw new Error("Render verification must write verification-report.json.");
  }

  const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
    files?: { verificationReport?: string };
    verification?: { reportFile?: string; hardIssueCount?: number };
  };
  if (manifest.files?.verificationReport !== "verification-report.json" || manifest.verification?.reportFile !== "verification-report.json") {
    throw new Error("Render verification must write report metadata back into manifest.json.");
  }
  if (manifest.verification?.hardIssueCount !== 0) {
    throw new Error("Rendered fixture should not contain hard verification issues.");
  }

  const zipEntries = new Set(readZipEntryNames(await readFile(join(outputDir, "html-ppt-deck.zip"))));
  if (!zipEntries.has("verification-report.json")) {
    throw new Error("Render verification must update html-ppt-deck.zip with verification-report.json.");
  }

  const indexPath = join(outputDir, "index.html");
  const originalIndex = await readFile(indexPath, "utf8");
  await writeFile(indexPath, originalIndex.replace(" is-active", ""), "utf8");
  const failedReport = await runRenderVerificationStage({ outputDir, deck, registryHash: registry.hash, selectedTemplate, writeArtifacts: false, browserVerification: "required" });
  if (failedReport.status !== "failed" || !failedReport.hardIssues.some((issue) => issue.code === "active-slide-count-invalid")) {
    throw new Error("Render verification must fail when index.html has no active slide.");
  }
  await writeFile(indexPath, originalIndex.replace("</section>", "<p>request-scope</p></section>"), "utf8");
  const leakedInternalTextReport = await runRenderVerificationStage({
    outputDir,
    deck,
    registryHash: registry.hash,
    selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (leakedInternalTextReport.status !== "failed" || !leakedInternalTextReport.hardIssues.some((issue) => issue.code === "internal-citation-key-visible")) {
    throw new Error("Render verification must fail when visible slide text leaks internal evidence tokens.");
  }

  await assertTemplateFidelityCorruptionChecks({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-template-fidelity-fixture"), runtimeRoot, registry, renderer, deck, selectedTemplate });
  await assertAllTemplatePackageFidelity({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-all-template-fidelity-fixture"), runtimeRoot, registry, renderer, deck });
  await assertTemplateAspectRatioChecks({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-template-aspect-fixture"), runtimeRoot, registry, renderer, deck });
  await assertScreenshotTemplateSmokeSubset({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-template-screenshot-smoke-fixture"), runtimeRoot, registry, renderer, deck });
  await assertFirstBatchLayoutDnaRenderVerification({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-first-batch-layout-dna-fixture"), runtimeRoot, registry, renderer, baseDeck: deck, selectedTemplate });
  await assertSecondBatchLayoutDnaRenderVerification({ outputDir: resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "render-verification-second-batch-layout-dna-fixture"), runtimeRoot, registry, renderer, baseDeck: deck, selectedTemplate });

  console.log(`HTML-PPT v2 render verification stage passed. outputDir=${outputDir}`);
}

async function assertTemplateFidelityCorruptionChecks(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  deck: DeckIR;
  selectedTemplate: TemplatePackage;
}) {
  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  await input.renderer.renderToDirectory(input.deck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });

  const indexPath = join(input.outputDir, "index.html");
  const originalIndex = await readFile(indexPath, "utf8");
  await writeFile(indexPath, originalIndex.replace(`data-donor="${input.selectedTemplate.donorTemplateId}"`, 'data-donor="wrong-donor"'), "utf8");
  const wrongDonorReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: input.deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (wrongDonorReport.status !== "failed" || !wrongDonorReport.hardIssues.some((issue) => issue.code === "template-body-donor-mismatch")) {
    throw new Error("Render verification must fail pinned template fidelity when body data-donor is wrong.");
  }

  await writeFile(
    indexPath,
    originalIndex.replace(
      `data-dna-title-treatment="${input.deck.design.donorContract.dnaSignature.titleTreatment}"`,
      'data-dna-title-treatment="wrong-title-treatment"'
    ),
    "utf8"
  );
  const wrongDnaReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: input.deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (wrongDnaReport.status !== "failed" || !wrongDnaReport.hardIssues.some((issue) => issue.code === "template-body-dna-title-treatment-mismatch")) {
    throw new Error("Render verification must fail when body donor DNA metadata is wrong.");
  }

  await writeFile(indexPath, originalIndex.replace(input.selectedTemplate.deckClass, "tpl-wrong-template"), "utf8");
  const wrongDeckClassReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: input.deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (wrongDeckClassReport.status !== "failed" || !wrongDeckClassReport.hardIssues.some((issue) => issue.code === "template-body-class-missing")) {
    throw new Error("Render verification must fail pinned template fidelity when body deckClass is wrong.");
  }
}

async function assertAllTemplatePackageFidelity(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  deck: DeckIR;
}) {
  if (input.registry.templatePackages.length !== 15) {
    throw new Error(`Expected 15 template packages for fidelity regression, got ${input.registry.templatePackages.length}.`);
  }

  for (const template of input.registry.templatePackages) {
    await resetRuntimeDir(input.outputDir, input.runtimeRoot);

    const resolution = resolveTemplatePackageSelection(input.registry, template.id);
    if (resolution.kind !== "pinned" || resolution.template.id !== template.id) {
      throw new Error(`Template '${template.id}' must resolve as a pinned template package.`);
    }

    const deck = deckForTemplate(input.deck, input.registry, template);
    await input.renderer.renderToDirectory(deck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });
    const report = await runRenderVerificationStage({
      outputDir: input.outputDir,
      deck,
      registryHash: input.registry.hash,
      selectedTemplate: template,
      writeArtifacts: false,
      browserVerification: "disabled"
    });
    if (report.summary.hardIssueCount !== 0 || report.signals.templateFidelity.status !== "pass") {
      throw new Error(`Template '${template.id}' failed deterministic fidelity verification: ${JSON.stringify(report.hardIssues)}`);
    }

    const indexHtml = await readFile(join(input.outputDir, "index.html"), "utf8");
    const styleCss = await readFile(join(input.outputDir, "style.css"), "utf8");
    const manifest = JSON.parse(await readFile(join(input.outputDir, "manifest.json"), "utf8")) as {
      donorTemplateId?: string;
      themeId?: string;
      deckClass?: string;
    };
    assertTemplateMetadata({ template, manifest, indexHtml, styleCss });
    assertDonorCssScope({ registry: input.registry, template, styleCss });
    assertNoDonorContractLeakage({ registry: input.registry, template, indexHtml });
  }
}

async function assertScreenshotTemplateSmokeSubset(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  deck: DeckIR;
}) {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const subset = [
    "xhs-post",
    "testing-safety-alert",
    "presenter-mode-reveal",
    "graphify-dark-graph",
    "course-module",
    "dir-key-nav-minimal"
  ];

  try {
    const baseline = await captureTemplateScreenshotProbe({
      outputDir: input.outputDir,
      runtimeRoot: input.runtimeRoot,
      registry: input.registry,
      renderer: input.renderer,
      deck: input.deck,
      template: requireTemplate(input.registry, "tech-sharing"),
      page
    });

    for (const templateId of subset) {
      const template = requireTemplate(input.registry, templateId);
      const probe = await captureTemplateScreenshotProbe({
        outputDir: input.outputDir,
        runtimeRoot: input.runtimeRoot,
        registry: input.registry,
        renderer: input.renderer,
        deck: input.deck,
        template,
        page
      });
      assertScreenshotProbe({ template, probe, baseline });
    }
  } finally {
    await browser.close();
  }
}

async function captureTemplateScreenshotProbe(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  deck: DeckIR;
  template: TemplatePackage;
  page: Page;
}) {
  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  const deck = deckForTemplate(input.deck, input.registry, input.template);
  await input.renderer.renderToDirectory(deck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });

  await openRenderedDeckFixturePage(input.page, join(input.outputDir, "index.html"));
  const deckLocator = input.page.locator(".deck");
  const screenshot = await deckLocator.screenshot({ animations: "disabled" });
  const dimensions = readPngDimensions(screenshot);
  const styleProbe = await input.page.evaluate(`
    (() => {
      const read = (selector, pseudo) => {
        const element = document.querySelector(selector);
        if (!element) {
          return {
            backgroundColor: "",
            backgroundImage: "",
            backgroundSize: "",
            borderRadius: "",
            borderTopWidth: "",
            boxShadow: "",
            color: "",
            content: "",
            letterSpacing: "",
            textTransform: ""
          };
        }
        const style = window.getComputedStyle(element, pseudo);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backgroundSize: style.backgroundSize,
          borderRadius: style.borderRadius,
          borderTopWidth: style.borderTopWidth,
          boxShadow: style.boxShadow,
          color: style.color,
          content: style.content,
          letterSpacing: style.letterSpacing,
          textTransform: style.textTransform
        };
      };
      const body = document.body;
      const deck = document.querySelector(".deck");
      const rect = deck && deck.getBoundingClientRect();
      return {
        bodyClass: body.className,
        bodyDonor: body.getAttribute("data-donor"),
        fallbackProfile: window.getComputedStyle(body).getPropertyValue("--renderer-fallback-profile").replace(/['"]/g, "").trim(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        deckRect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : { width: 0, height: 0 },
        deck: read(".deck"),
        deckBefore: read(".deck", "::before"),
        deckAfter: read(".deck", "::after"),
        deckViewport: read(".deck-viewport"),
        kicker: read(".kicker"),
        kickerBefore: read(".kicker", "::before"),
        card: read(".card, .comparison-panel, .metric-card, .timeline-event")
      };
    })()
  `) as ScreenshotStyleProbe;

  return {
    hash: createHash("sha256").update(screenshot).digest("hex"),
    byteLength: screenshot.byteLength,
    dimensions,
    styleProbe
  };
}

async function openRenderedDeckFixturePage(page: Page, indexHtmlPath: string) {
  const url = pathToFileURL(indexHtmlPath).toString();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.waitForSelector(".deck", { state: "attached", timeout: 8_000 });
    await page.waitForSelector(".slide.is-active", { state: "attached", timeout: 8_000 });
    await page.waitForFunction(
      () => {
        const deck = document.querySelector(".deck");
        const active = document.querySelector(".slide.is-active");
        if (!deck || !active) return false;
        const deckRect = deck.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return deckRect.width > 10 && deckRect.height > 10 && activeRect.width > 10 && activeRect.height > 10;
      },
      undefined,
      { timeout: 8_000 }
    );
  } catch (error) {
    throw new Error(`Timed out waiting for screenshot smoke deck readiness at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertTemplateAspectRatioChecks(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  deck: DeckIR;
}) {
  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  const productTemplate = requireTemplate(input.registry, "product-launch");
  const productDeck = deckForTemplate(input.deck, input.registry, productTemplate);
  await input.renderer.renderToDirectory(productDeck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });
  const productReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: productDeck,
    registryHash: input.registry.hash,
    selectedTemplate: productTemplate,
    writeArtifacts: false,
    browserVerification: "required"
  });
  if (productReport.status === "failed" || productReport.hardIssues.some((issue) => issue.code.startsWith("template-"))) {
    throw new Error(`product-launch pinned template should pass 16:9 fidelity checks: ${JSON.stringify(productReport.hardIssues)}`);
  }
  if (productReport.mode !== "playwright") {
    throw new Error("product-launch aspect-ratio verification must run in Playwright mode.");
  }

  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  const xhsTemplate = requireTemplate(input.registry, "xhs-post");
  const xhsDeck = deckForTemplate(input.deck, input.registry, xhsTemplate);
  await input.renderer.renderToDirectory(xhsDeck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });
  const xhsReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: xhsDeck,
    registryHash: input.registry.hash,
    selectedTemplate: xhsTemplate,
    writeArtifacts: false,
    browserVerification: "required"
  });
  if (xhsReport.status === "failed" || xhsReport.hardIssues.some((issue) => issue.code.startsWith("template-"))) {
    throw new Error(`xhs-post pinned template should pass 3:4 fidelity checks: ${JSON.stringify(xhsReport.hardIssues)}`);
  }
  if (xhsReport.mode !== "playwright") {
    throw new Error("xhs-post aspect-ratio verification must run in Playwright mode.");
  }

  const stylePath = join(input.outputDir, "style.css");
  const originalCss = await readFile(stylePath, "utf8");
  await writeFile(
    stylePath,
    `${originalCss}\nbody.${xhsTemplate.deckClass}[data-donor='${xhsTemplate.donorTemplateId}'] .deck { width: min(100vw, calc(100vh * 16 / 9)); aspect-ratio: 16 / 9; }\n`,
    "utf8"
  );
  const stretchedPortraitReport = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: xhsDeck,
    registryHash: input.registry.hash,
    selectedTemplate: xhsTemplate,
    writeArtifacts: false,
    browserVerification: "required"
  });
  if (
    stretchedPortraitReport.status !== "failed"
    || !stretchedPortraitReport.hardIssues.some((issue) => issue.code === "browser-template-aspect-ratio-mismatch")
  ) {
    throw new Error("Browser verification must fail when a pinned portrait template is stretched to a wide deck box.");
  }
}

async function assertFirstBatchLayoutDnaRenderVerification(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  baseDeck: DeckIR;
  selectedTemplate: TemplatePackage;
}) {
  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  const deck = firstBatchLayoutDnaDeck(input.baseDeck);
  await input.renderer.renderToDirectory(deck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });
  const indexHtml = await readFile(join(input.outputDir, "index.html"), "utf8");
  for (const marker of [
    'data-layoutid="quote"',
    "quote-text",
    'data-layoutid="section-divider"',
    "section-marker",
    'data-layoutid="stat-highlight"',
    "stat-value",
    "stat-card"
  ]) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`First-batch layout DNA render verification fixture missing marker: ${marker}`);
    }
  }
  const report = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (report.summary.hardIssueCount !== 0) {
    throw new Error(`First-batch layout DNA deck should pass render verification: ${JSON.stringify(report.hardIssues)}`);
  }
}

async function assertSecondBatchLayoutDnaRenderVerification(input: {
  outputDir: string;
  runtimeRoot: string;
  registry: SkillRegistry;
  renderer: DeckRendererService;
  baseDeck: DeckIR;
  selectedTemplate: TemplatePackage;
}) {
  await resetRuntimeDir(input.outputDir, input.runtimeRoot);
  const deck = secondBatchLayoutDnaDeck(input.baseDeck);
  await input.renderer.renderToDirectory(deck, { outputDir: input.outputDir, registryHash: input.registry.hash, registry: input.registry });
  const indexHtml = await readFile(join(input.outputDir, "index.html"), "utf8");
  for (const marker of [
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
    "image-hero-placeholder"
  ]) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`Second-batch layout DNA render verification fixture missing marker: ${marker}`);
    }
  }
  const report = await runRenderVerificationStage({
    outputDir: input.outputDir,
    deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate,
    writeArtifacts: false,
    browserVerification: "disabled"
  });
  if (report.summary.hardIssueCount !== 0) {
    throw new Error(`Second-batch layout DNA deck should pass render verification: ${JSON.stringify(report.hardIssues)}`);
  }
}

function assertScreenshotProbe(input: {
  template: TemplatePackage;
  probe: Awaited<ReturnType<typeof captureTemplateScreenshotProbe>>;
  baseline: Awaited<ReturnType<typeof captureTemplateScreenshotProbe>>;
}) {
  const { template, probe, baseline } = input;
  const ratio = probe.dimensions.width / probe.dimensions.height;
  const expectedRatio = template.aspectRatio === "3:4" ? 0.75 : 16 / 9;
  if (Math.abs(ratio - expectedRatio) > 0.025) {
    throw new Error(`Template '${template.id}' deck screenshot ratio ${ratio.toFixed(3)} did not match ${template.aspectRatio}.`);
  }
  if (probe.hash === baseline.hash) {
    throw new Error(`Template '${template.id}' deck screenshot is byte-identical to the generic tech-sharing baseline.`);
  }
  if (probe.byteLength < 20_000) {
    throw new Error(`Template '${template.id}' deck screenshot is unexpectedly small (${probe.byteLength} bytes).`);
  }
  if (probe.styleProbe.bodyClass !== template.deckClass || probe.styleProbe.bodyDonor !== template.donorTemplateId) {
    throw new Error(`Template '${template.id}' screenshot probe lost body donor/template metadata.`);
  }

  assertTemplateChromeMarker(template.id, probe.styleProbe);
}

function assertTemplateChromeMarker(templateId: string, styleProbe: Awaited<ReturnType<typeof captureTemplateScreenshotProbe>>["styleProbe"]) {
  switch (templateId) {
    case "xhs-post":
      if (!styleProbe.deckViewport.backgroundColor.includes("240, 234, 226") || Number.parseFloat(styleProbe.deck.borderRadius) < 20) {
        throw new Error("xhs-post screenshot smoke expected portrait paper background and rounded deck chrome.");
      }
      return;
    case "testing-safety-alert":
      if (styleProbe.fallbackProfile !== "testing-safety-alert" || styleProbe.deckBefore.backgroundImage === "none" || styleProbe.kicker.textTransform !== "uppercase") {
        throw new Error("testing-safety-alert screenshot smoke expected alert fallback profile, hazard rails, and uppercase chrome.");
      }
      return;
    case "presenter-mode-reveal":
      if (styleProbe.fallbackProfile !== "presenter-mode-reveal" || !styleProbe.kickerBefore.content.includes("STAGE")) {
        throw new Error("presenter-mode-reveal screenshot smoke expected presenter fallback profile and STAGE kicker chrome.");
      }
      return;
    case "graphify-dark-graph":
      if (!styleProbe.deck.backgroundImage.includes("radial-gradient") || !styleProbe.deck.backgroundSize.includes("42px")) {
        throw new Error("graphify-dark-graph screenshot smoke expected radial graph background and 42px grid sizing.");
      }
      return;
    case "course-module":
      if (!styleProbe.kickerBefore.content.includes("LESSON") || Number.parseFloat(styleProbe.card.borderRadius) < 20) {
        throw new Error("course-module screenshot smoke expected LESSON kicker and rounded learning cards.");
      }
      return;
    case "dir-key-nav-minimal":
      if (styleProbe.deck.boxShadow !== "none" || Number.parseFloat(styleProbe.kicker.letterSpacing) < 3) {
        throw new Error("dir-key-nav-minimal screenshot smoke expected no deck shadow and wide minimal kicker tracking.");
      }
      return;
    default:
      throw new Error(`Unexpected screenshot smoke template '${templateId}'.`);
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
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
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
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
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
          evidenceRefs: ["cloud-servers"],
          keyMetrics: []
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

function assertTemplateMetadata(input: {
  template: TemplatePackage;
  manifest: { donorTemplateId?: string; themeId?: string; deckClass?: string };
  indexHtml: string;
  styleCss: string;
}) {
  const { template, manifest, indexHtml, styleCss } = input;
  const bodyTag = indexHtml.match(/<body\b[^>]*>/i)?.[0] ?? "";
  const donorScopedSelector = `body.${template.deckClass}[data-donor='${template.donorTemplateId}']`;
  const expectedAspectRatioCss = template.aspectRatio === "3:4"
    ? /aspect-ratio\s*:\s*3\s*\/\s*4/i
    : /aspect-ratio\s*:\s*16\s*\/\s*9/i;

  if (manifest.donorTemplateId !== template.donorTemplateId || manifest.themeId !== template.themeId || manifest.deckClass !== template.deckClass) {
    throw new Error(`Template '${template.id}' manifest metadata does not match the pinned package.`);
  }
  if (
    !bodyTag.includes(`class="${template.deckClass}"`)
    || !bodyTag.includes(`data-donor="${template.donorTemplateId}"`)
    || !bodyTag.includes('data-dna-density=')
    || !bodyTag.includes('data-dna-title-treatment=')
    || !bodyTag.includes('data-dna-card-treatment=')
    || !bodyTag.includes('data-dna-kicker-treatment=')
    || !bodyTag.includes('data-dna-accent-rule=')
  ) {
    throw new Error(`Template '${template.id}' body metadata does not expose the expected donor/template identity.`);
  }
  if (
    !styleCss.includes(donorScopedSelector)
    || !styleCss.includes("--donor-density:")
    || !styleCss.includes("--donor-title-treatment:")
    || !styleCss.includes("--donor-card-treatment:")
    || !styleCss.includes("--donor-kicker-treatment:")
    || !styleCss.includes("--donor-accent-rule:")
    || !expectedAspectRatioCss.test(styleCss)
  ) {
    throw new Error(`Template '${template.id}' style.css is missing scoped donor CSS or the expected aspect-ratio contract.`);
  }
}

function assertDonorCssScope(input: {
  registry: SkillRegistry;
  template: TemplatePackage;
  styleCss: string;
}) {
  const allDeckClasses = input.registry.templatePackages.map((template) => template.deckClass);
  const unscopedDonorSelectors = input.styleCss.match(/(?:^|[,{]\s*)\.tpl-[a-z0-9-]+/gm) ?? [];
  if (unscopedDonorSelectors.length) {
    throw new Error(`Template '${input.template.id}' emitted unscoped donor selectors: ${unscopedDonorSelectors.join(", ")}`);
  }

  for (const deckClass of allDeckClasses) {
    if (deckClass !== input.template.deckClass && input.styleCss.includes(deckClass)) {
      throw new Error(`Template '${input.template.id}' style.css leaked another template deckClass '${deckClass}'.`);
    }
  }
}

function assertNoDonorContractLeakage(input: {
  registry: SkillRegistry;
  template: TemplatePackage;
  indexHtml: string;
}) {
  const donor = input.registry.donors.find((item) => item.id === input.template.donorTemplateId);
  if (!donor) {
    throw new Error(`Template '${input.template.id}' references missing donor '${input.template.donorTemplateId}'.`);
  }

  const slideHtml = extractRenderedSlides(input.indexHtml).join("\n");
  for (const text of [...donor.contract.forbiddenTextExamples, ...donor.contract.forbiddenTextPatterns]) {
    if (matchesForbiddenText(slideHtml, text)) {
      throw new Error(`Template '${input.template.id}' rendered donor-forbidden text in body slides: ${text}`);
    }
  }
  for (const className of donor.contract.forbiddenClasses) {
    if (hasRenderedClass(slideHtml, className)) {
      throw new Error(`Template '${input.template.id}' rendered donor-forbidden class in body slides: ${className}`);
    }
  }
}

function extractRenderedSlides(html: string): string[] {
  return html.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
}

function hasRenderedClass(html: string, className: string): boolean {
  const escaped = escapeRegExp(className);
  return new RegExp(`\\bclass=(["'])[^"']*\\b${escaped}\\b[^"']*\\1`, "i").test(html);
}

function matchesForbiddenText(html: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (/^[\p{L}\p{N}_-]+$/u.test(trimmed)) {
    return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_-])`, "iu").test(html);
  }
  try {
    return new RegExp(trimmed, "i").test(html);
  } catch {
    return html.toLowerCase().includes(trimmed.toLowerCase());
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Screenshot buffer is not a PNG.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function requireTemplate(registry: SkillRegistry, id: string): TemplatePackage {
  const template = registry.templatePackages.find((item) => item.id === id);
  if (!template) {
    throw new Error(`Missing template package '${id}'.`);
  }
  return template;
}

function deckForTemplate(deck: DeckIR, registry: SkillRegistry, template: TemplatePackage): DeckIR {
  const clone = JSON.parse(JSON.stringify(deck)) as DeckIR;
  const donor = registry.donors.find((item) => item.id === template.donorTemplateId);
  const theme = registry.themes.find((item) => item.id === template.themeId);
  if (!donor || !theme) {
    throw new Error(`Template '${template.id}' references missing donor or theme.`);
  }
  clone.design = {
    ...clone.design,
    themeId: theme.id,
    themeTokens: {
      ...clone.design.themeTokens,
      palette: {
        ...clone.design.themeTokens.palette,
        bg: theme.tokens.bg,
        surface: theme.tokens.surface,
        surface2: theme.tokens.surface2,
        accent: theme.tokens.accent,
        accent2: theme.tokens.accent2,
        accent3: theme.tokens.accent3,
        text1: theme.tokens.text1,
        text2: theme.tokens.text2,
        border: theme.tokens.border
      }
    },
    donorTemplateId: template.donorTemplateId,
    deckClass: template.deckClass,
    donorContract: {
      ...clone.design.donorContract,
      id: donor.id,
      forbiddenTextPatterns: donor.contract.forbiddenTextPatterns,
      coverOnlyClasses: donor.contract.coverOnlyClasses
    },
    contrastReport: theme.wcag
  };
  return clone;
}

async function resetRuntimeDir(outputDir: string, runtimeRoot: string) {
  if (!outputDir.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputDir: ${outputDir}`);
  }
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
