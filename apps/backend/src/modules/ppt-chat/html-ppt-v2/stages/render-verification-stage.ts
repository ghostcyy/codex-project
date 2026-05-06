import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deckIrSchema, type DeckIR } from "../ir";
import { checkStaticClassCoverage, createZipBuffer, readZipEntryNames } from "../renderer";
import type { TemplatePackage } from "../registry";

export type RenderVerificationSeverity = "hard" | "warning";
export type RenderVerificationStatus = "clean" | "warning" | "failed";
export type RenderVerificationSignalStatus = "pass" | "warn" | "fail" | "skipped";
export type RenderVerificationSignalName =
  | "files"
  | "htmlStructure"
  | "classCoverage"
  | "assetRefs"
  | "fontPreload"
  | "runtime"
  | "manifest"
  | "templateFidelity"
  | "zip"
  | "browser";

export type RenderVerificationIssue = {
  severity: RenderVerificationSeverity;
  signal: RenderVerificationSignalName;
  code: string;
  message: string;
  file?: string;
  slideIndex?: number;
  details?: Record<string, unknown>;
};

export type RenderVerificationSignal = {
  status: RenderVerificationSignalStatus;
  checked: number;
  passed: number;
  issues: RenderVerificationIssue[];
};

export type RenderVerificationReport = {
  schemaVersion: "html-ppt-v2-render-verification-v1";
  mode: "static" | "playwright";
  generatedAt: string;
  outputDir: string;
  status: RenderVerificationStatus;
  summary: {
    hardIssueCount: number;
    warningCount: number;
    checkedSignals: number;
    slideCount: number;
    screenshotCount: number;
  };
  signals: {
    files: RenderVerificationSignal;
    htmlStructure: RenderVerificationSignal;
    classCoverage: RenderVerificationSignal;
    assetRefs: RenderVerificationSignal;
    fontPreload: RenderVerificationSignal;
    runtime: RenderVerificationSignal;
    manifest: RenderVerificationSignal;
    templateFidelity: RenderVerificationSignal;
    zip: RenderVerificationSignal;
    browser: RenderVerificationSignal;
  };
  hardIssues: RenderVerificationIssue[];
  warnings: RenderVerificationIssue[];
  screenshots: Array<{ slideIndex: number; file: string }>;
};

export type RunRenderVerificationStageInput = {
  outputDir: string;
  deck?: DeckIR;
  registryHash?: string;
  selectedTemplate?: TemplatePackage;
  writeArtifacts?: boolean;
  browserVerification?: "auto" | "disabled" | "required";
};

type FileSnapshot = {
  indexHtml: string;
  previewHtml: string;
  standaloneHtml: string;
  styleCss: string;
  runtimeJs: string;
  manifestJson: string;
  zipBuffer: Buffer;
};

type MutableRenderManifest = {
  files?: {
    indexHtml?: string;
    previewHtml?: string;
    standaloneHtml?: string;
    styleCss?: string;
    zip?: string;
    assets?: string[];
    verificationReport?: string;
    screenshots?: string[];
  };
  deckIr?: unknown;
  registryHash?: string;
  slideCount?: number;
  themeId?: string;
  donorTemplateId?: string;
  deckClass?: string;
  verification?: {
    status: RenderVerificationStatus;
    reportFile: string;
    generatedAt: string;
    hardIssueCount: number;
    warningCount: number;
    mode: "static" | "playwright";
  };
  [key: string]: unknown;
};

const REQUIRED_FILES = [
  "index.html",
  "preview.html",
  "standalone.html",
  "style.css",
  "manifest.json",
  "html-ppt-deck.zip",
  join("assets", "runtime-v2.js")
] as const;

const REQUIRED_ZIP_ENTRIES = [
  "index.html",
  "preview.html",
  "standalone.html",
  "style.css",
  "manifest.json",
  "verification-report.json",
  "assets/runtime-v2.js"
] as const;

const FORBIDDEN_VISIBLE_TEXT_RULES: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "internal-citation-key-visible",
    pattern: /\b(?:section-\d+|required-section-\d+|topic-brief|audience-brief|request-scope|requested-slides|requested-length)\b/iu,
    message: "Rendered visible text leaked an internal evidence or section token."
  },
  {
    code: "fallback-planning-phrase-visible",
    pattern: /needs a clear opening context|should be optimized for|requested output is locked to|scope should stay concise enough to fit|fallback evidence is generated from intentir|local fallback evidence generated from intentir/iu,
    message: "Rendered visible text leaked fallback planning language that should remain internal."
  },
  {
    code: "fallback-terminology-phrase-visible",
    pattern: /is treated as a key term to preserve accurately|is a core term that should stay precise and audience-appropriate/iu,
    message: "Rendered visible text leaked internal terminology guidance instead of presentation copy."
  },
  {
    code: "fallback-layout-placeholder-visible",
    pattern: /reserved section generated to keep the deterministic toc layout valid/iu,
    message: "Rendered visible text leaked a deterministic layout placeholder sentence."
  }
];

export async function runRenderVerificationStage(input: RunRenderVerificationStageInput): Promise<RenderVerificationReport> {
  const outputDir = resolve(input.outputDir);
  const signals = createEmptySignals();
  const snapshot = await readFileSnapshot(outputDir, signals.files);
  const manifest = parseManifest(snapshot?.manifestJson ?? "", signals.manifest);
  const deck = resolveDeck(input.deck, manifest, signals.manifest);
  let browserResult: BrowserVerificationResult = { mode: "static", screenshots: [] };

  if (snapshot && deck) {
    runHtmlStructureChecks({ indexHtml: snapshot.indexHtml, previewHtml: snapshot.previewHtml, standaloneHtml: snapshot.standaloneHtml, deck, signal: signals.htmlStructure });
    runClassCoverageChecks({ indexHtml: snapshot.indexHtml, deck, signal: signals.classCoverage });
    runAssetRefChecks({ outputDir, indexHtml: snapshot.indexHtml, standaloneHtml: snapshot.standaloneHtml, signal: signals.assetRefs });
    runFontPreloadChecks({ indexHtml: snapshot.indexHtml, signal: signals.fontPreload });
    runRuntimeChecks({ indexHtml: snapshot.indexHtml, styleCss: snapshot.styleCss, runtimeJs: snapshot.runtimeJs, deck, signal: signals.runtime });
    runManifestChecks({ manifest, deck, registryHash: input.registryHash, signal: signals.manifest });
    runTemplateFidelityChecks({ manifest, deck, indexHtml: snapshot.indexHtml, styleCss: snapshot.styleCss, selectedTemplate: input.selectedTemplate, signal: signals.templateFidelity });
  }

  if (snapshot) {
    runZipChecks({ zipBuffer: snapshot.zipBuffer, signal: signals.zip });
  }

  if (snapshot && deck) {
    browserResult = await runBrowserVerification({
      outputDir,
      deck,
      signal: signals.browser,
      mode: resolveBrowserVerificationMode(input.browserVerification),
      selectedTemplate: input.selectedTemplate
    });
  } else {
    signals.browser.status = "skipped";
    signals.browser.checked = 1;
    signals.browser.passed = 1;
    signals.browser.issues.push({
      severity: "warning",
      signal: "browser",
      code: "browser-verification-skipped",
      message: "Browser verification skipped because required static artifacts or DeckIR were unavailable."
    });
  }

  const report = finalizeReport({
    outputDir,
    signals,
    slideCount: deck?.intent.derivedSlideCount ?? 0,
    mode: browserResult.mode,
    screenshots: browserResult.screenshots
  });
  if (input.writeArtifacts ?? true) {
    await writeVerificationArtifacts({ outputDir, report, snapshot, manifest });
  }
  return report;
}

type BrowserVerificationMode = "disabled" | "auto" | "required";

type BrowserVerificationResult = {
  mode: "static" | "playwright";
  screenshots: Array<{ slideIndex: number; file: string }>;
};

type PlaywrightModule = typeof import("playwright");
type PlaywrightPage = Awaited<ReturnType<Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>["newPage"]>>;

type BrowserSlideProbe = {
  activeCount: number;
  activeIndex: number;
  viewport: { width: number; height: number };
  deckRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  slideRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  overflow: Array<{
    tag: string;
    className: string;
    text: string;
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  }>;
};

function createEmptySignals(): RenderVerificationReport["signals"] {
  return {
    files: emptySignal(),
    htmlStructure: emptySignal(),
    classCoverage: emptySignal(),
    assetRefs: emptySignal(),
    fontPreload: emptySignal(),
    runtime: emptySignal(),
    manifest: emptySignal(),
    templateFidelity: emptySignal(),
    zip: emptySignal(),
    browser: emptySignal()
  };
}

function emptySignal(): RenderVerificationSignal {
  return { status: "pass", checked: 0, passed: 0, issues: [] };
}

async function readFileSnapshot(outputDir: string, signal: RenderVerificationSignal): Promise<FileSnapshot | undefined> {
  signal.checked = REQUIRED_FILES.length;
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(outputDir, file))) {
      pushIssue(signal, {
        severity: "hard",
        signal: "files",
        code: "missing-required-file",
        message: `Rendered deck is missing required file: ${file}`,
        file
      });
    }
  }

  if (signal.issues.some((issue) => issue.severity === "hard")) {
    signal.status = "fail";
    return undefined;
  }

  signal.passed = REQUIRED_FILES.length;
  return {
    indexHtml: await readFile(join(outputDir, "index.html"), "utf8"),
    previewHtml: await readFile(join(outputDir, "preview.html"), "utf8"),
    standaloneHtml: await readFile(join(outputDir, "standalone.html"), "utf8"),
    styleCss: await readFile(join(outputDir, "style.css"), "utf8"),
    runtimeJs: await readFile(join(outputDir, "assets", "runtime-v2.js"), "utf8"),
    manifestJson: await readFile(join(outputDir, "manifest.json"), "utf8"),
    zipBuffer: await readFile(join(outputDir, "html-ppt-deck.zip"))
  };
}

function parseManifest(manifestJson: string, signal: RenderVerificationSignal): MutableRenderManifest | undefined {
  signal.checked += 1;
  try {
    const value = JSON.parse(manifestJson) as MutableRenderManifest;
    signal.passed += 1;
    return value;
  } catch (error) {
    pushIssue(signal, {
      severity: "hard",
      signal: "manifest",
      code: "manifest-json-invalid",
      message: `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      file: "manifest.json"
    });
    return undefined;
  }
}

function resolveDeck(deck: DeckIR | undefined, manifest: MutableRenderManifest | undefined, signal: RenderVerificationSignal): DeckIR | undefined {
  if (deck) {
    return deckIrSchema.parse(deck);
  }
  signal.checked += 1;
  const parsed = deckIrSchema.safeParse(manifest?.deckIr);
  if (!parsed.success) {
    pushIssue(signal, {
      severity: "hard",
      signal: "manifest",
      code: "manifest-deck-ir-invalid",
      message: "manifest.json must contain a valid DeckIR snapshot.",
      file: "manifest.json",
      details: { errors: parsed.error.issues.slice(0, 5) }
    });
    return undefined;
  }
  signal.passed += 1;
  return parsed.data;
}

function runHtmlStructureChecks(input: {
  indexHtml: string;
  previewHtml: string;
  standaloneHtml: string;
  deck: DeckIR;
  signal: RenderVerificationSignal;
}) {
  const { signal, deck, indexHtml } = input;
  const sections = extractSections(indexHtml);
  const expectedSlideCount = deck.intent.derivedSlideCount;
  const activeSections = sections.filter((section) => hasClass(section, "is-active"));
  const sectionIndexes = sections.map((section) => Number(readAttr(section, "data-slide-index")));
  const sectionLayouts = sections.map((section) => readAttr(section, "data-layoutid"));
  const tagBalanceOk = ["html", "head", "body", "main", "div", "section", "span", "p", "h1", "h2", "h3", "ol", "ul", "li", "footer"].every((tag) =>
    hasBalancedTag(indexHtml, tag)
  );

  signal.checked += 9;
  passOrIssue(signal, sections.length === expectedSlideCount, {
    severity: "hard",
    signal: "htmlStructure",
    code: "slide-count-mismatch",
    message: `index.html contains ${sections.length} slide sections, expected ${expectedSlideCount}.`,
    file: "index.html",
    details: { actual: sections.length, expected: expectedSlideCount }
  });
  passOrIssue(signal, activeSections.length === 1, {
    severity: "hard",
    signal: "htmlStructure",
    code: "active-slide-count-invalid",
    message: `index.html must contain exactly one active slide; found ${activeSections.length}.`,
    file: "index.html"
  });
  passOrIssue(signal, sectionIndexes.every((index, offset) => index === offset + 1), {
    severity: "hard",
    signal: "htmlStructure",
    code: "slide-index-sequence-invalid",
    message: "Rendered sections must use contiguous 1-based data-slide-index values.",
    file: "index.html",
    details: { sectionIndexes }
  });
  passOrIssue(signal, sectionLayouts.every((layoutId, offset) => layoutId === deck.layoutPlan[offset]?.layoutId), {
    severity: "hard",
    signal: "htmlStructure",
    code: "layout-sequence-mismatch",
    message: "Rendered section data-layoutid values must match DeckIR layoutPlan order.",
    file: "index.html",
    details: { sectionLayouts }
  });
  passOrIssue(signal, input.previewHtml === input.indexHtml, {
    severity: "hard",
    signal: "htmlStructure",
    code: "preview-html-mismatch",
    message: "preview.html should match index.html until the product preview shell is added.",
    file: "preview.html"
  });
  passOrIssue(signal, !input.indexHtml.includes(" style=") && !input.indexHtml.includes("<script>"), {
    severity: "hard",
    signal: "htmlStructure",
    code: "index-inline-code-found",
    message: "index.html must not contain inline style attributes or inline scripts in the deterministic v2 path.",
    file: "index.html"
  });
  passOrIssue(signal, input.standaloneHtml.includes("<style>") && input.standaloneHtml.includes("<script>"), {
    severity: "hard",
    signal: "htmlStructure",
    code: "standalone-not-inlined",
    message: "standalone.html must inline deterministic CSS and runtime JavaScript.",
    file: "standalone.html"
  });
  passOrIssue(signal, tagBalanceOk, {
    severity: "hard",
    signal: "htmlStructure",
    code: "tag-balance-invalid",
    message: "index.html failed deterministic tag-balance sanity checks.",
    file: "index.html"
  });

  const visibleTextIssues = collectForbiddenVisibleTextIssues(sections);
  if (visibleTextIssues.length) {
    for (const issue of visibleTextIssues) {
      pushIssue(signal, issue);
    }
  } else {
    signal.passed += 1;
  }
}

function runClassCoverageChecks(input: { indexHtml: string; deck: DeckIR; signal: RenderVerificationSignal }) {
  const report = checkStaticClassCoverage({ html: input.indexHtml, deckClass: input.deck.design.deckClass });
  input.signal.checked += Math.max(1, report.allClasses.length);
  if (report.unknownClasses.length) {
    for (const issue of report.unknownClasses) {
      pushIssue(input.signal, {
        severity: "hard",
        signal: "classCoverage",
        code: "unknown-css-class",
        message: `Rendered HTML emitted an unregistered class: ${issue.className}`,
        file: "index.html",
        slideIndex: issue.slideIndex,
        details: { scope: issue.scope, layoutId: issue.layoutId }
      });
    }
  } else {
    input.signal.passed += Math.max(1, report.allClasses.length);
  }
}

function runAssetRefChecks(input: { outputDir: string; indexHtml: string; standaloneHtml: string; signal: RenderVerificationSignal }) {
  const refs = [...collectLocalRefs(input.indexHtml), ...collectLocalRefs(input.standaloneHtml)];
  input.signal.checked += Math.max(1, refs.length);
  if (!refs.length) {
    input.signal.passed += 1;
    return;
  }

  for (const ref of refs) {
    const target = safeResolveOutputPath(input.outputDir, ref);
    if (!target || !existsSync(target)) {
      pushIssue(input.signal, {
        severity: "hard",
        signal: "assetRefs",
        code: "asset-reference-missing",
        message: `HTML references a missing or unsafe local asset: ${ref}`,
        file: ref
      });
    } else {
      input.signal.passed += 1;
    }
  }
}

function runFontPreloadChecks(input: { indexHtml: string; signal: RenderVerificationSignal }) {
  const linkTags = input.indexHtml.match(/<link\b[^>]*>/gi) ?? [];
  const preloadTags = linkTags.filter((tag) => readAttr(tag, "rel") === "preload");
  const fontStylesheets = linkTags.filter((tag) => {
    if (readAttr(tag, "rel") !== "stylesheet") return false;
    const href = readAttr(tag, "href") ?? "";
    return readAttr(tag, "data-font-provider") === "google-fonts" || /fonts\.googleapis\.com|\/fonts\//i.test(href);
  });
  input.signal.checked += Math.max(1, preloadTags.length + fontStylesheets.length);

  if (fontStylesheets.length) {
    input.signal.passed += fontStylesheets.length;
  } else if (!preloadTags.length) {
    pushIssue(input.signal, {
      severity: "hard",
      signal: "fontPreload",
      code: "font-stylesheet-missing",
      message: "index.html must include a font stylesheet or a valid font preload for the active typography tokens.",
      file: "index.html"
    });
  }

  for (const tag of preloadTags) {
    const asValue = readAttr(tag, "as");
    const href = readAttr(tag, "href");
    if (!href || (/\.(woff2?|ttf|otf)(?:$|\?)/i.test(href) && asValue !== "font")) {
      pushIssue(input.signal, {
        severity: "hard",
        signal: "fontPreload",
        code: "font-preload-invalid",
        message: `Font preload tag must include href and as="font": ${tag}`,
        file: "index.html"
      });
    } else {
      input.signal.passed += 1;
    }
  }
}

function runRuntimeChecks(input: { indexHtml: string; styleCss: string; runtimeJs: string; deck: DeckIR; signal: RenderVerificationSignal }) {
  const { signal } = input;
  signal.checked += 9;
  passOrIssue(signal, input.indexHtml.includes('href="style.css"'), {
    severity: "hard",
    signal: "runtime",
    code: "style-link-missing",
    message: 'index.html must reference href="style.css".',
    file: "index.html"
  });
  passOrIssue(signal, input.indexHtml.includes('src="assets/runtime-v2.js"'), {
    severity: "hard",
    signal: "runtime",
    code: "runtime-script-missing",
    message: 'index.html must reference src="assets/runtime-v2.js".',
    file: "index.html"
  });
  passOrIssue(signal, input.runtimeJs.includes("activateSlide") && input.runtimeJs.includes("ArrowRight") && input.runtimeJs.includes("ArrowLeft"), {
    severity: "hard",
    signal: "runtime",
    code: "runtime-navigation-contract-missing",
    message: "runtime-v2.js must include deterministic keyboard navigation and activateSlide.",
    file: "assets/runtime-v2.js"
  });
  passOrIssue(signal, input.runtimeJs.includes("window.htmlPptV2"), {
    severity: "hard",
    signal: "runtime",
    code: "runtime-debug-api-missing",
    message: "runtime-v2.js must expose window.htmlPptV2 for preview tooling.",
    file: "assets/runtime-v2.js"
  });
  passOrIssue(signal, input.styleCss.includes(`body.${input.deck.design.deckClass}`), {
    severity: "hard",
    signal: "runtime",
    code: "deck-class-css-missing",
    message: "style.css must include deckClass-scoped CSS.",
    file: "style.css"
  });
  passOrIssue(signal, /\.slide\s*\{[\s\S]*position:\s*absolute/i.test(input.styleCss), {
    severity: "hard",
    signal: "runtime",
    code: "slide-position-contract-missing",
    message: "style.css must keep slides absolutely positioned.",
    file: "style.css"
  });
  passOrIssue(signal, /\.slide\.is-active\s*\{[\s\S]*opacity:\s*1/i.test(input.styleCss), {
    severity: "hard",
    signal: "runtime",
    code: "active-slide-css-missing",
    message: "style.css must define the active slide state.",
    file: "style.css"
  });
  passOrIssue(signal, input.styleCss.includes(".deck-progress-bar"), {
    severity: "hard",
    signal: "runtime",
    code: "progress-css-missing",
    message: "style.css must define the deterministic progress bar.",
    file: "style.css"
  });
}

function runManifestChecks(input: {
  manifest: MutableRenderManifest | undefined;
  deck: DeckIR;
  registryHash?: string;
  signal: RenderVerificationSignal;
}) {
  const { manifest, signal, deck } = input;
  signal.checked += 6;
  passOrIssue(signal, manifest?.schemaVersion === "html-ppt-v2-render-manifest-v1", {
    severity: "hard",
    signal: "manifest",
    code: "manifest-schema-version-invalid",
    message: "manifest.json must declare schemaVersion html-ppt-v2-render-manifest-v1.",
    file: "manifest.json"
  });
  passOrIssue(signal, manifest?.slideCount === deck.intent.derivedSlideCount, {
    severity: "hard",
    signal: "manifest",
    code: "manifest-slide-count-mismatch",
    message: "manifest.json slideCount must match DeckIR intent.derivedSlideCount.",
    file: "manifest.json",
    details: { manifestSlideCount: manifest?.slideCount, deckSlideCount: deck.intent.derivedSlideCount }
  });
  passOrIssue(signal, manifest?.themeId === deck.design.themeId, {
    severity: "hard",
    signal: "manifest",
    code: "manifest-theme-mismatch",
    message: "manifest.json themeId must match DeckIR design.themeId.",
    file: "manifest.json"
  });
  passOrIssue(signal, manifest?.deckClass === deck.design.deckClass, {
    severity: "hard",
    signal: "manifest",
    code: "manifest-deck-class-mismatch",
    message: "manifest.json deckClass must match DeckIR design.deckClass.",
    file: "manifest.json"
  });
  passOrIssue(signal, !input.registryHash || manifest?.registryHash === input.registryHash, {
    severity: "hard",
    signal: "manifest",
    code: "manifest-registry-hash-mismatch",
    message: "manifest.json registryHash must match the registry used for rendering.",
    file: "manifest.json",
    details: { manifestRegistryHash: manifest?.registryHash, expectedRegistryHash: input.registryHash }
  });
  passOrIssue(signal, Boolean(manifest?.files?.indexHtml && manifest.files.styleCss && manifest.files.zip), {
    severity: "hard",
    signal: "manifest",
    code: "manifest-files-incomplete",
    message: "manifest.json must list indexHtml, styleCss, and zip file paths.",
    file: "manifest.json"
  });
}

function runTemplateFidelityChecks(input: {
  manifest: MutableRenderManifest | undefined;
  deck: DeckIR;
  indexHtml: string;
  styleCss: string;
  selectedTemplate?: TemplatePackage;
  signal: RenderVerificationSignal;
}) {
  const { manifest, deck, selectedTemplate, signal } = input;
  const bodyTag = input.indexHtml.match(/<body\b[^>]*>/i)?.[0] ?? "";
  const expectedDeckClass = selectedTemplate?.deckClass ?? deck.design.deckClass;
  const expectedDonorTemplateId = selectedTemplate?.donorTemplateId ?? deck.design.donorTemplateId;
  const donorScopedSelector = `body.${expectedDeckClass}[data-donor='${expectedDonorTemplateId}']`;
  const donorDna = deck.design.donorContract.dnaSignature;
  signal.checked += 8;
  passOrIssue(signal, hasClass(bodyTag, expectedDeckClass), {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-class-missing",
    message: "Rendered body class must include the expected template deckClass.",
    file: "index.html",
    details: { expectedDeckClass, bodyTag }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-donor") === expectedDonorTemplateId, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-donor-mismatch",
    message: "Rendered body data-donor must equal the expected donorTemplateId.",
    file: "index.html",
    details: { expectedDonorTemplateId, bodyDataDonor: readAttr(bodyTag, "data-donor") }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-dna-density") === donorDna.density, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-dna-density-mismatch",
    message: "Rendered body data-dna-density must match DeckIR donor DNA.",
    file: "index.html",
    details: { expectedDensity: donorDna.density, actualDensity: readAttr(bodyTag, "data-dna-density") }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-dna-title-treatment") === donorDna.titleTreatment, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-dna-title-treatment-mismatch",
    message: "Rendered body data-dna-title-treatment must match DeckIR donor DNA.",
    file: "index.html",
    details: { expectedTitleTreatment: donorDna.titleTreatment, actualTitleTreatment: readAttr(bodyTag, "data-dna-title-treatment") }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-dna-card-treatment") === donorDna.cardTreatment, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-dna-card-treatment-mismatch",
    message: "Rendered body data-dna-card-treatment must match DeckIR donor DNA.",
    file: "index.html",
    details: { expectedCardTreatment: donorDna.cardTreatment, actualCardTreatment: readAttr(bodyTag, "data-dna-card-treatment") }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-dna-kicker-treatment") === donorDna.kickerTreatment, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-dna-kicker-treatment-mismatch",
    message: "Rendered body data-dna-kicker-treatment must match DeckIR donor DNA.",
    file: "index.html",
    details: { expectedKickerTreatment: donorDna.kickerTreatment, actualKickerTreatment: readAttr(bodyTag, "data-dna-kicker-treatment") }
  });
  passOrIssue(signal, readAttr(bodyTag, "data-dna-accent-rule") === donorDna.accentRule, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-body-dna-accent-rule-mismatch",
    message: "Rendered body data-dna-accent-rule must match DeckIR donor DNA.",
    file: "index.html",
    details: { expectedAccentRule: donorDna.accentRule, actualAccentRule: readAttr(bodyTag, "data-dna-accent-rule") }
  });
  passOrIssue(signal, input.styleCss.includes(donorScopedSelector) && hasDonorDnaCssContract(input.styleCss, donorScopedSelector, donorDna), {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-donor-dna-css-contract-missing",
    message: "style.css must contain the donor-scoped selector and donor DNA contract variables.",
    file: "style.css",
    details: { expectedSelector: donorScopedSelector, donorDna }
  });
  const vocabularyCoverage = collectDonorVocabularyCoverage(input.indexHtml, expectedDonorTemplateId);
  passOrIssue(signal, vocabularyCoverage.failingSlides.length === 0, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-vocabulary-coverage-low",
    message: "Each rendered slide must carry donor-specific vocabulary classes so pinned templates cannot collapse to the generic skeleton.",
    file: "index.html",
    details: vocabularyCoverage
  });

  if (!selectedTemplate) {
    return;
  }

  const expectedAspectRatio = aspectRatioForRendererProfile(selectedTemplate.rendererProfile);
  const allowedThemeIds = new Set([selectedTemplate.themeId, ...selectedTemplate.themeAlternates]);

  signal.checked += 4;
  passOrIssue(signal, deck.design.donorTemplateId === selectedTemplate.donorTemplateId && manifest?.donorTemplateId === selectedTemplate.donorTemplateId, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-donor-mismatch",
    message: "Pinned template donorTemplateId must match DeckIR and manifest donorTemplateId.",
    file: "manifest.json",
    details: { expected: selectedTemplate.donorTemplateId, deckDonorTemplateId: deck.design.donorTemplateId, manifestDonorTemplateId: manifest?.donorTemplateId }
  });
  passOrIssue(signal, allowedThemeIds.has(deck.design.themeId) && manifest?.themeId === deck.design.themeId, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-theme-mismatch",
    message: "Pinned template themeId must match the package themeId or an allowed package theme alternate.",
    file: "manifest.json",
    details: { expected: selectedTemplate.themeId, allowedAlternates: selectedTemplate.themeAlternates, deckThemeId: deck.design.themeId, manifestThemeId: manifest?.themeId }
  });
  passOrIssue(signal, deck.design.deckClass === selectedTemplate.deckClass && manifest?.deckClass === selectedTemplate.deckClass, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-deck-class-mismatch",
    message: "Pinned template deckClass must match DeckIR and manifest deckClass.",
    file: "manifest.json",
    details: { expected: selectedTemplate.deckClass, deckClass: deck.design.deckClass, manifestDeckClass: manifest?.deckClass }
  });
  passOrIssue(signal, selectedTemplate.aspectRatio === expectedAspectRatio, {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-renderer-profile-aspect-ratio-mismatch",
    message: "Template package rendererProfile must map to its declared aspectRatio.",
    file: "manifest.json",
    details: { rendererProfile: selectedTemplate.rendererProfile, expectedAspectRatio, packageAspectRatio: selectedTemplate.aspectRatio }
  });
  passOrIssue(signal, hasRendererProfileAspectRatioCss(input.styleCss, selectedTemplate.aspectRatio), {
    severity: "hard",
    signal: "templateFidelity",
    code: "template-rendered-aspect-ratio-mismatch",
    message: "style.css must contain the pinned template aspect-ratio contract.",
    file: "style.css",
    details: { expectedAspectRatio: selectedTemplate.aspectRatio, rendererProfile: selectedTemplate.rendererProfile }
  });
}

function runZipChecks(input: { zipBuffer: Buffer; signal: RenderVerificationSignal }) {
  const zipEntryNames = new Set(readZipEntryNames(input.zipBuffer));
  input.signal.checked += REQUIRED_ZIP_ENTRIES.length;
  for (const entryName of REQUIRED_ZIP_ENTRIES) {
    if (!zipEntryNames.has(entryName)) {
      if (entryName === "verification-report.json") {
        // The verification report is generated by this stage and injected into the export zip afterwards.
        input.signal.passed += 1;
        continue;
      }
      pushIssue(input.signal, {
        severity: "hard",
        signal: "zip",
        code: "zip-entry-missing",
        message: `html-ppt-deck.zip is missing expected entry: ${entryName}`,
        file: "html-ppt-deck.zip",
        details: { entryName }
      });
    } else {
      input.signal.passed += 1;
    }
  }
}

async function runBrowserVerification(input: {
  outputDir: string;
  deck: DeckIR;
  signal: RenderVerificationSignal;
  mode: BrowserVerificationMode;
  selectedTemplate?: TemplatePackage;
}): Promise<BrowserVerificationResult> {
  const { signal } = input;
  signal.checked += 1;

  if (input.mode === "disabled") {
    signal.status = "skipped";
    signal.passed += 1;
    signal.issues.push({
      severity: "warning",
      signal: "browser",
      code: "browser-verification-disabled",
      message: "Playwright render verification is disabled by configuration; static verification still ran."
    });
    return { mode: "static", screenshots: [] };
  }

  const playwright = await loadPlaywright();
  if (!playwright) {
    signal.status = "skipped";
    if (input.mode === "required") {
      pushIssue(signal, {
        severity: "hard",
        signal: "browser",
        code: "playwright-unavailable",
        message: "Playwright is required for Stage 11 but could not be imported."
      });
    } else {
      signal.passed += 1;
      signal.issues.push({
        severity: "warning",
        signal: "browser",
        code: "playwright-unavailable",
        message: "Playwright is not available; Stage 11 used static verification only."
      });
    }
    return { mode: "static", screenshots: [] };
  }

  const screenshots: Array<{ slideIndex: number; file: string }> = [];
  const screenshotsDir = join(input.outputDir, "screenshots");
  await mkdir(screenshotsDir, { recursive: true });

  let browser: Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>> | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await openRenderedDeckPage(page, join(input.outputDir, "index.html"));

    const slideCount = input.deck.intent.derivedSlideCount;
    signal.checked += slideCount + 2;

    for (let index = 0; index < slideCount; index += 1) {
      await page.evaluate(`window.htmlPptV2 && window.htmlPptV2.activateSlide && window.htmlPptV2.activateSlide(${index});`);
      await page.waitForTimeout(520);
      const probe = await page.evaluate(`
        (() => {
          const slides = Array.from(document.querySelectorAll(".deck .slide"));
          const deck = document.querySelector(".deck");
          const activeSlides = slides.filter((slide) => slide.classList.contains("is-active"));
          const active = activeSlides[0];
          const rectToObject = (rect) => ({
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const overflow = active
            ? Array.from(active.querySelectorAll("*"))
                .filter((element) => {
                  const style = window.getComputedStyle(element);
                  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
                  const rect = element.getBoundingClientRect();
                  if (rect.width < 2 || rect.height < 2) return false;
                  const text = (element.textContent || "").trim();
                  const horizontalOverflow = rect.left < -12 || rect.right > window.innerWidth + 12;
                  const verticalOverflow = rect.top < -12 || rect.bottom > window.innerHeight + 12;
                  return Boolean(text) && (horizontalOverflow || verticalOverflow);
                })
                .slice(0, 8)
                .map((element) => ({
                  tag: element.tagName.toLowerCase(),
                  className: element.className || "",
                  text: (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
                  rect: rectToObject(element.getBoundingClientRect())
                }))
            : [];

          return {
            activeCount: activeSlides.length,
            activeIndex: active ? slides.indexOf(active) + 1 : 0,
            viewport,
            deckRect: deck ? rectToObject(deck.getBoundingClientRect()) : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
            slideRect: active ? rectToObject(active.getBoundingClientRect()) : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
            overflow
          };
        })()
      `) as BrowserSlideProbe;
      const slideIndex = index + 1;
      const screenshotFile = `screenshots/slide-${String(slideIndex).padStart(2, "0")}.png`;
      await page.screenshot({ path: join(input.outputDir, screenshotFile), fullPage: false });
      screenshots.push({ slideIndex, file: screenshotFile });

      verifyBrowserSlideProbe({ signal, probe, slideIndex, selectedTemplate: input.selectedTemplate });
    }

    await page.evaluate("window.htmlPptV2 && window.htmlPptV2.activateSlide && window.htmlPptV2.activateSlide(0);");
    await page.keyboard.press("ArrowRight");
    const activeAfterArrowRight = await page.evaluate("Array.from(document.querySelectorAll('.deck .slide')).findIndex((slide) => slide.classList.contains('is-active')) + 1;");
    passOrIssue(signal, slideCount <= 1 || activeAfterArrowRight === 2, {
      severity: "hard",
      signal: "browser",
      code: "keyboard-navigation-failed",
      message: `ArrowRight should activate slide 2; browser reported active slide ${activeAfterArrowRight}.`,
      file: "index.html"
    });

    passOrIssue(signal, screenshots.length === slideCount, {
      severity: "hard",
      signal: "browser",
      code: "screenshot-count-mismatch",
      message: `Browser verification produced ${screenshots.length} screenshots, expected ${slideCount}.`,
      file: "screenshots"
    });

    return { mode: "playwright", screenshots };
  } catch (error) {
    const severity: RenderVerificationSeverity = input.mode === "required" ? "hard" : "warning";
    pushIssue(signal, {
      severity,
      signal: "browser",
      code: "playwright-verification-failed",
      message: `Playwright render verification failed: ${error instanceof Error ? error.message : String(error)}`
    });
    return { mode: screenshots.length ? "playwright" : "static", screenshots };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function loadPlaywright(): Promise<PlaywrightModule | undefined> {
  try {
    return await import("playwright");
  } catch {
    return undefined;
  }
}

async function openRenderedDeckPage(page: PlaywrightPage, indexHtmlPath: string) {
  const url = pathToFileURL(indexHtmlPath).toString();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await waitForRenderedDeckReady(page);
  } catch (error) {
    throw new Error(`Timed out waiting for rendered deck readiness at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForRenderedDeckReady(page: PlaywrightPage) {
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
}

function resolveBrowserVerificationMode(value: RunRenderVerificationStageInput["browserVerification"]): BrowserVerificationMode {
  if (value) return value;
  const raw = process.env.HTML_PPT_V2_BROWSER_VERIFICATION?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "disabled") return "disabled";
  if (raw === "required" || raw === "1" || raw === "true" || raw === "on") return "required";
  return "auto";
}

function verifyBrowserSlideProbe(input: {
  signal: RenderVerificationSignal;
  probe: BrowserSlideProbe;
  slideIndex: number;
  selectedTemplate?: TemplatePackage;
}) {
  const { signal, probe, slideIndex, selectedTemplate } = input;
  passOrIssue(signal, probe.activeCount === 1 && probe.activeIndex === slideIndex, {
    severity: "hard",
    signal: "browser",
    code: "browser-active-slide-invalid",
    message: `Browser should have exactly one active slide (${slideIndex}); found activeCount=${probe.activeCount}, activeIndex=${probe.activeIndex}.`,
    file: "index.html",
    slideIndex,
    details: { activeCount: probe.activeCount, activeIndex: probe.activeIndex }
  });

  if (selectedTemplate) {
    verifyBrowserTemplateDeckGeometry({ signal, probe, slideIndex, selectedTemplate });
  }

  const expectedSlideRect = selectedTemplate ? probe.deckRect : {
    left: 0,
    top: 0,
    right: probe.viewport.width,
    bottom: probe.viewport.height,
    width: probe.viewport.width,
    height: probe.viewport.height
  };
  const slideCoversExpectedFrame = Math.abs(probe.slideRect.left - expectedSlideRect.left) <= 2
    && Math.abs(probe.slideRect.top - expectedSlideRect.top) <= 2
    && Math.abs(probe.slideRect.width - expectedSlideRect.width) <= 4
    && Math.abs(probe.slideRect.height - expectedSlideRect.height) <= 4;
  passOrIssue(signal, slideCoversExpectedFrame, {
    severity: "hard",
    signal: "browser",
    code: selectedTemplate ? "browser-slide-deck-frame-mismatch" : "browser-slide-viewport-mismatch",
    message: selectedTemplate
      ? `Slide ${slideIndex} does not cover the rendered deck frame in browser verification.`
      : `Slide ${slideIndex} does not cover the 1920x1080 viewport in browser verification.`,
    file: "index.html",
    slideIndex,
    details: { slideRect: probe.slideRect, expectedSlideRect, viewport: probe.viewport }
  });

  for (const overflow of probe.overflow) {
    pushIssue(signal, {
      severity: "warning",
      signal: "browser",
      code: "browser-element-overflow",
      message: `Slide ${slideIndex} has a visible element outside the viewport: ${overflow.tag}.${overflow.className}`,
      file: "index.html",
      slideIndex,
      details: overflow
    });
  }
}

function verifyBrowserTemplateDeckGeometry(input: {
  signal: RenderVerificationSignal;
  probe: BrowserSlideProbe;
  slideIndex: number;
  selectedTemplate: TemplatePackage;
}) {
  const { signal, probe, slideIndex, selectedTemplate } = input;
  const expectedAspectRatio = aspectRatioForRendererProfile(selectedTemplate.rendererProfile);
  const expectedRatio = expectedAspectRatio === "3:4" ? 0.75 : 16 / 9;
  const actualRatio = probe.deckRect.height > 0 ? probe.deckRect.width / probe.deckRect.height : 0;
  const ratioTolerance = 0.018;
  const viewportTolerance = 2;
  signal.checked += 2;

  passOrIssue(signal, Math.abs(actualRatio - expectedRatio) <= ratioTolerance && selectedTemplate.aspectRatio === expectedAspectRatio, {
    severity: "hard",
    signal: "browser",
    code: "browser-template-aspect-ratio-mismatch",
    message: `Rendered deck aspect ratio must match pinned template ${selectedTemplate.rendererProfile}/${selectedTemplate.aspectRatio}.`,
    file: "index.html",
    slideIndex,
    details: {
      expectedAspectRatio,
      expectedRatio,
      actualRatio,
      deckRect: probe.deckRect,
      rendererProfile: selectedTemplate.rendererProfile,
      packageAspectRatio: selectedTemplate.aspectRatio
    }
  });

  passOrIssue(signal, isRectContainedInViewport(probe.deckRect, probe.viewport, viewportTolerance), {
    severity: "hard",
    signal: "browser",
    code: "browser-template-deck-viewport-overflow",
    message: "Rendered deck bounding box must stay contained within the browser viewport.",
    file: "index.html",
    slideIndex,
    details: { deckRect: probe.deckRect, viewport: probe.viewport }
  });
}

function finalizeReport(input: {
  outputDir: string;
  signals: RenderVerificationReport["signals"];
  slideCount: number;
  mode: RenderVerificationReport["mode"];
  screenshots: RenderVerificationReport["screenshots"];
}): RenderVerificationReport {
  const hardIssues = Object.values(input.signals).flatMap((signal) => signal.issues.filter((issue) => issue.severity === "hard"));
  const warnings = Object.values(input.signals).flatMap((signal) => signal.issues.filter((issue) => issue.severity === "warning"));
  for (const signal of Object.values(input.signals)) {
    signal.status = signal.issues.some((issue) => issue.severity === "hard")
      ? "fail"
      : signal.issues.some((issue) => issue.severity === "warning")
        ? "warn"
        : signal.status;
  }
  const status: RenderVerificationStatus = hardIssues.length ? "failed" : warnings.length ? "warning" : "clean";
  return {
    schemaVersion: "html-ppt-v2-render-verification-v1",
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    outputDir: input.outputDir,
    status,
    summary: {
      hardIssueCount: hardIssues.length,
      warningCount: warnings.length,
      checkedSignals: Object.keys(input.signals).length,
      slideCount: input.slideCount,
      screenshotCount: input.screenshots.length
    },
    signals: input.signals,
    hardIssues,
    warnings,
    screenshots: input.screenshots
  };
}

async function writeVerificationArtifacts(input: {
  outputDir: string;
  report: RenderVerificationReport;
  snapshot: FileSnapshot | undefined;
  manifest: MutableRenderManifest | undefined;
}) {
  const reportJson = `${JSON.stringify(input.report, null, 2)}\n`;
  const reportPath = join(input.outputDir, "verification-report.json");
  await writeFile(reportPath, reportJson, "utf8");

  if (!input.snapshot || !input.manifest) {
    return;
  }

  const manifest: MutableRenderManifest = {
    ...input.manifest,
    files: {
      ...(input.manifest.files ?? {}),
      verificationReport: "verification-report.json",
      screenshots: input.report.screenshots.map((screenshot) => screenshot.file)
    },
    verification: {
      status: input.report.status,
      reportFile: "verification-report.json",
      generatedAt: input.report.generatedAt,
      hardIssueCount: input.report.summary.hardIssueCount,
      warningCount: input.report.summary.warningCount,
      mode: input.report.mode
    }
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(input.outputDir, "manifest.json"), manifestJson, "utf8");

  const assetEntries = await readAssetEntries(input.outputDir, manifest.files?.assets ?? []);
  const screenshotEntries = await readAssetEntries(input.outputDir, input.report.screenshots.map((screenshot) => screenshot.file));
  const exportZip = createZipBuffer([
    { name: "index.html", data: input.snapshot.indexHtml },
    { name: "preview.html", data: input.snapshot.previewHtml },
    { name: "standalone.html", data: input.snapshot.standaloneHtml },
    { name: "style.css", data: input.snapshot.styleCss },
    { name: "manifest.json", data: manifestJson },
    { name: "verification-report.json", data: reportJson },
    ...screenshotEntries,
    ...assetEntries
  ]);
  await writeFile(join(input.outputDir, "html-ppt-deck.zip"), exportZip);
}

async function readAssetEntries(outputDir: string, assetPaths: string[]) {
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const assetPath of assetPaths) {
    const target = safeResolveOutputPath(outputDir, assetPath);
    if (!target || !existsSync(target)) {
      continue;
    }
    entries.push({ name: assetPath.replace(/\\/g, "/"), data: await readFile(target) });
  }
  return entries;
}

function passOrIssue(signal: RenderVerificationSignal, condition: boolean, issue: RenderVerificationIssue) {
  if (condition) {
    signal.passed += 1;
  } else {
    pushIssue(signal, issue);
  }
}

function pushIssue(signal: RenderVerificationSignal, issue: RenderVerificationIssue) {
  signal.issues.push(issue);
}

function extractSections(html: string): string[] {
  return html.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
}

function collectForbiddenVisibleTextIssues(sections: string[]): RenderVerificationIssue[] {
  const issues: RenderVerificationIssue[] = [];
  for (const [offset, section] of sections.entries()) {
    const visibleText = extractVisibleText(section);
    if (!visibleText) continue;
    for (const rule of FORBIDDEN_VISIBLE_TEXT_RULES) {
      const match = rule.pattern.exec(visibleText);
      if (!match) continue;
      issues.push({
        severity: "hard",
        signal: "htmlStructure",
        code: rule.code,
        message: rule.message,
        file: "index.html",
        slideIndex: offset + 1,
        details: {
          matchedText: match[0],
          excerpt: visibleText.slice(Math.max(0, match.index - 60), Math.min(visibleText.length, match.index + match[0].length + 120))
        }
      });
    }
  }
  return issues;
}

function extractVisibleText(sectionHtml: string): string {
  return sectionHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function readAttr(html: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escapedName}=(["'])(.*?)\\1`, "i");
  return pattern.exec(html)?.[2] ?? "";
}

function aspectRatioForRendererProfile(rendererProfile: TemplatePackage["rendererProfile"]): TemplatePackage["aspectRatio"] {
  return rendererProfile === "social-portrait" ? "3:4" : "16:9";
}

function hasRendererProfileAspectRatioCss(css: string, aspectRatio: TemplatePackage["aspectRatio"]): boolean {
  const pattern = aspectRatio === "3:4"
    ? /aspect-ratio\s*:\s*3\s*\/\s*4/i
    : /aspect-ratio\s*:\s*16\s*\/\s*9/i;
  return pattern.test(css);
}

function hasDonorDnaCssContract(
  css: string,
  selector: string,
  donorDna: DeckIR["design"]["donorContract"]["dnaSignature"]
): boolean {
  if (!css.includes(selector)) {
    return false;
  }

  const expectedFragments = [
    `--donor-density: "${donorDna.density}"`,
    `--donor-title-treatment: "${donorDna.titleTreatment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `--donor-card-treatment: "${donorDna.cardTreatment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `--donor-kicker-treatment: "${donorDna.kickerTreatment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `--donor-accent-rule: "${donorDna.accentRule.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    `/* donor-dna-density: ${donorDna.density} */`,
    `/* donor-dna-title-treatment: ${donorDna.titleTreatment} */`,
    `/* donor-dna-card-treatment: ${donorDna.cardTreatment} */`,
    `/* donor-dna-kicker-treatment: ${donorDna.kickerTreatment} */`,
    `/* donor-dna-accent-rule: ${donorDna.accentRule} */`
  ];
  return expectedFragments.every((fragment) => css.includes(fragment));
}

function collectDonorVocabularyCoverage(indexHtml: string, donorTemplateId: string) {
  const donorPrefix = `donor-${sanitizeVocabularyToken(donorTemplateId)}-`;
  const sections = indexHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
  const perSlide = sections.map((sectionHtml) => {
    const slideIndex = Number(readAttr(sectionHtml, "data-slide-index"));
    const layoutId = readAttr(sectionHtml, "data-layoutid");
    const donorSpecificClasses = collectClassTokens(sectionHtml).filter((className) => className.startsWith(donorPrefix));
    return {
      slideIndex: Number.isFinite(slideIndex) ? slideIndex : undefined,
      layoutId,
      donorSpecificClassCount: donorSpecificClasses.length,
      donorSpecificClasses: donorSpecificClasses.slice(0, 20)
    };
  });

  return {
    donorTemplateId,
    perSlide,
    failingSlides: perSlide.filter((slide) => slide.donorSpecificClassCount < 3)
  };
}

function isRectContainedInViewport(
  rect: BrowserSlideProbe["deckRect"],
  viewport: BrowserSlideProbe["viewport"],
  tolerance: number
): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left >= -tolerance
    && rect.top >= -tolerance
    && rect.right <= viewport.width + tolerance
    && rect.bottom <= viewport.height + tolerance;
}

function hasClass(html: string, className: string): boolean {
  return readAttr(html, "class").split(/\s+/).includes(className);
}

function hasBalancedTag(html: string, tag: string): boolean {
  const openPattern = new RegExp(`<${tag}\\b`, "gi");
  const closePattern = new RegExp(`</${tag}>`, "gi");
  return (html.match(openPattern) ?? []).length === (html.match(closePattern) ?? []).length;
}

function collectClassTokens(html: string): string[] {
  const found = new Set<string>();
  const pattern = /\bclass=(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const raw = match[2] ?? "";
    for (const token of raw.split(/\s+/)) {
      const className = token.trim();
      if (className) found.add(className);
    }
  }
  return [...found];
}

function sanitizeVocabularyToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function collectLocalRefs(html: string): string[] {
  const refs: string[] = [];
  const pattern = /\b(?:href|src)=(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const ref = match[2]?.trim() ?? "";
    if (!ref || ref.startsWith("#") || /^(?:https?:|data:|mailto:|tel:)/i.test(ref)) {
      continue;
    }
    refs.push(ref.split("#")[0]?.split("?")[0] ?? ref);
  }

  return [...new Set(refs)];
}

function safeResolveOutputPath(outputDir: string, ref: string): string | undefined {
  const normalizedRef = ref.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedRef || normalizedRef.includes("\0")) {
    return undefined;
  }
  const target = resolve(outputDir, normalizedRef);
  const root = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
  if (target !== outputDir && !target.startsWith(root)) {
    return undefined;
  }
  if (dirname(target).startsWith(outputDir)) {
    return target;
  }
  return undefined;
}
