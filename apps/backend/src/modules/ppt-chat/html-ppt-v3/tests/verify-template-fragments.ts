import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import type { AnyNode, Element, Text } from "domhandler";
import { AUDIO_PAGE_TYPES, TEMPLATES_ROOT, type PageFragment } from "../shared";
import { listAvailableTemplateV2Ids, loadManifestV2, resolveTemplateDir } from "../manifest/manifest-v2.loader";
import { buildAvailablePoolFromManifest } from "../manifest/pool-builder";
import { validateManifestV2Files } from "../manifest/manifest-v2.validator";
import { detectMediaKinds, findRemoteImageUrls } from "../manifest/media-kind-detector";

const MIN_TEMPLATE_COUNT = 20;

async function main() {
  const templateIds = await listAvailableTemplateV2Ids();
  const failures: string[] = [];

  if (templateIds.length < MIN_TEMPLATE_COUNT) {
    failures.push(`expected at least ${MIN_TEMPLATE_COUNT} manifest-v2 templates, found ${templateIds.length}: ${templateIds.join(", ")}`);
  }

  for (const templateId of templateIds) {
    try {
      const manifest = await loadManifestV2(templateId);
      const templateDir = resolveTemplateDir(templateId);
      const validation = await validateManifestV2Files(manifest, templateDir);
      if (!validation.ok) failures.push(...validation.reasons.map((reason) => `${templateId}: ${reason}`));

      await verifyHtmlFilePaths(templateId, manifest, templateDir, failures);
      await verifyDeckEffects(templateId, manifest, templateDir, failures);
      await verifyAnchorCoverage(templateId, manifest, templateDir, failures);
      await verifyAnchorCharTargets(templateId, manifest, templateDir, failures);
      await verifyFragmentStructureMatchesSource(templateId, manifest, templateDir, failures);
      await verifyPoolCoversSourceMiddleSlides(templateId, manifest, templateDir, failures);
      verifyPoolBuilder(templateId, manifest, failures);
      await verifyTemplateSpecificExpectations(templateId, manifest, templateDir, failures);
    } catch (error) {
      failures.push(`${templateId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await verifyUnconvertedTemplateSourcePaths(new Set(templateIds), failures);
  await verifyNoLegacyManifestRuntimeImports(failures);

  if (failures.length) {
    console.error(`verify-template-fragments failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`verify-template-fragments passed: ${templateIds.length} templates at ${TEMPLATES_ROOT}`);
}

async function verifyDeckEffects(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8");
  const expectedElementIds = extractDeckLevelEffectIds(indexHtml);
  const deckEffects = (manifest as {
    deckEffects?: { htmlFile?: string; jsFile?: string; elementIds?: string[] };
  }).deckEffects;

  if (!expectedElementIds.length) return;
  if (!deckEffects) {
    failures.push(`${templateId}: source template has deck-level effect element(s) ${expectedElementIds.join(", ")} but manifest-v2.deckEffects is missing.`);
    return;
  }

  const declaredIds = deckEffects.elementIds ?? [];
  for (const elementId of expectedElementIds) {
    if (!declaredIds.includes(elementId)) {
      failures.push(`${templateId}: manifest-v2.deckEffects.elementIds must include '${elementId}'.`);
    }
  }

  if (!deckEffects.htmlFile) {
    failures.push(`${templateId}: manifest-v2.deckEffects.htmlFile is required when deck-level effect DOM exists.`);
  } else {
    const html = await readFile(join(templateDir, deckEffects.htmlFile), "utf8").catch(() => "");
    if (!html) {
      failures.push(`${templateId}: deckEffects.htmlFile does not exist: ${deckEffects.htmlFile}`);
    } else {
      for (const elementId of expectedElementIds) {
        if (!html.includes(`id="${elementId}"`) && !html.includes(`id='${elementId}'`)) {
          failures.push(`${templateId}: deckEffects.htmlFile must contain element id '${elementId}'.`);
        }
      }
    }
  }

  if (deckEffects.jsFile) {
    const js = await readFile(join(templateDir, deckEffects.jsFile), "utf8").catch(() => "");
    if (!js) {
      failures.push(`${templateId}: deckEffects.jsFile does not exist: ${deckEffects.jsFile}`);
    } else if (/createChart\s*\(|getElementById\(["'](?:lineChart|pieChart|barChart|ganttChart)["']\)/i.test(js)) {
      failures.push(`${templateId}: deckEffects.jsFile must not contain legacy chart initialization.`);
    }
  }

  const shell = await readFile(join(templateDir, manifest.shellHtmlFile), "utf8").catch(() => "");
  for (const elementId of expectedElementIds) {
    if (!shell.includes(`id="${elementId}"`) && !shell.includes(`id='${elementId}'`)) {
      failures.push(`${templateId}: shell.html must preserve deck-level effect element '${elementId}'.`);
    }
  }
}

function extractDeckLevelEffectIds(indexHtml: string) {
  const dom = parseDocument(indexHtml, { decodeEntities: false });
  const effectNodes = selectAll("body > canvas[id], .deck > canvas[id]", dom as unknown as AnyNode) as Element[];
  return effectNodes
    .map((node) => node.attribs?.id)
    .filter((id): id is string => Boolean(id));
}

async function verifyNoLegacyManifestRuntimeImports(failures: string[]) {
  const root = join(process.cwd(), "src", "modules", "ppt-chat", "html-ppt-v3");
  const files = await collectTypeScriptFiles(root);
  const forbidden = [
    "manifest/manifest.loader",
    "manifest\\manifest.loader",
    "manifest/manifest.parser",
    "manifest\\manifest.parser",
    "manifest/manifest.types",
    "manifest\\manifest.types"
  ];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("/docs/") || normalized.includes("/tests/")) continue;
    if (normalized.endsWith("/manifest/manifest.loader.ts") || normalized.endsWith("/manifest/manifest.parser.ts") || normalized.endsWith("/manifest/manifest.types.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const token of forbidden) {
      if (source.includes(token)) {
        failures.push(`${normalized}: runtime code must not import legacy ${token}; use manifest-v2 only.`);
      }
    }
  }
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

async function verifyPoolCoversSourceMiddleSlides(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8");
  const sourceSlideCount = extractSourceSlideCount(indexHtml);
  const middleSlideIndexes = Array.from({ length: Math.max(0, sourceSlideCount - 2) }, (_, index) => index + 2);
  const pool = manifest.pool as Record<string, PageFragment>;
  const poolFragments = Object.values(pool);
  if (poolFragments.length !== middleSlideIndexes.length) {
    failures.push(`${templateId}: manifest-v2 pool must expose every source middle slide (${middleSlideIndexes.length}); got ${poolFragments.length}`);
  }

  const referencedHtmlFiles = new Set<string>();
  for (const slideIndex of middleSlideIndexes) {
    const fragmentId = fragmentIdForSourceSlide(slideIndex);
    const fragment = pool[fragmentId];
    if (!fragment) {
      failures.push(`${templateId}: missing pool fragment '${fragmentId}' for source slide ${slideIndex}`);
      continue;
    }
    if (fragment.fragmentId !== fragmentId) {
      failures.push(`${templateId}: pool.${fragmentId}.fragmentId must equal '${fragmentId}'`);
    }
    if (fragment.sourceSlideIndex !== slideIndex) {
      failures.push(`${templateId}: pool.${fragmentId}.sourceSlideIndex must equal ${slideIndex}`);
    }
    if (fragment.htmlFile !== `fragments/${fragmentId}.html`) {
      failures.push(`${templateId}: pool.${fragmentId}.htmlFile must be fragments/${fragmentId}.html`);
    }
    if (!fragment.pagePortrait?.summary || !fragment.pagePortrait.componentSignature) {
      failures.push(`${templateId}: pool.${fragmentId} must include pagePortrait summary and componentSignature`);
    }
    referencedHtmlFiles.add(fragment.htmlFile);
  }

  const expectedReferencedCount = 2 + middleSlideIndexes.length;
  referencedHtmlFiles.add(manifest.fixed.cover.htmlFile);
  referencedHtmlFiles.add(manifest.fixed.closing.htmlFile);
  if (referencedHtmlFiles.size !== expectedReferencedCount) {
    failures.push(`${templateId}: manifest should reference ${expectedReferencedCount} unique fragment html files; got ${referencedHtmlFiles.size}`);
  }
}

function extractSourceSlideCount(indexHtml: string) {
  return [...indexHtml.matchAll(/<section\b(?=[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'])[\s\S]*?<\/section>/gi)].length;
}

async function verifyAnchorCoverage(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  const fragments: PageFragment[] = [
    manifest.fixed.cover,
    manifest.fixed.closing,
    ...Object.values(manifest.pool as Record<string, PageFragment>)
  ];
  let visibleTextCount = 0;
  let anchoredTextCount = 0;
  const unanchoredSamples: string[] = [];

  for (const fragment of fragments) {
    const html = await readFile(join(templateDir, fragment.htmlFile), "utf8");
    const dom = parseDocument(html, { decodeEntities: false });
    const visibleNodes = collectVisibleTextElements(dom as unknown as AnyNode);
    const anchored = new Set<Element>();
    for (const anchor of fragment.anchors) {
      for (const node of selectAll(anchor.selector, dom as unknown as AnyNode) as Element[]) {
        if (containsProtectedRuntimeElement(node)) {
          failures.push(
            `${templateId}: ${fragment.htmlFile} anchor '${anchor.slotId}' selector '${anchor.selector}' must not cover slide-number/progress-bar runtime DOM`
          );
        }
        anchored.add(node);
      }
    }

    for (const node of visibleNodes) {
      const text = textOf(node).trim().replace(/\s+/g, " ");
      if (isExemptVisibleText(node, text)) continue;
      visibleTextCount++;
      if (isCoveredByAnchoredElement(node, anchored)) {
        anchoredTextCount++;
      } else if (unanchoredSamples.length < 10) {
        unanchoredSamples.push(`${fragment.pageType}:${text.slice(0, 80)}`);
      }
      if (!isCoveredByAnchoredElement(node, anchored) && isForbiddenTemplateResidue(text)) {
        failures.push(`${templateId}: ${fragment.htmlFile} has unanchored template residue '${text.slice(0, 120)}'`);
      }
    }
  }

  const coverage = visibleTextCount ? anchoredTextCount / visibleTextCount : 1;
  if (coverage < 0.95) {
    failures.push(
      `${templateId}: visible text anchor coverage ${(coverage * 100).toFixed(1)}% (${anchoredTextCount}/${visibleTextCount}); samples: ${unanchoredSamples.join(" | ")}`
    );
  }
}

async function verifyAnchorCharTargets(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  await verifyAnchorCharTargetJsonOrder(templateId, templateDir, failures);

  const fragments: PageFragment[] = [
    manifest.fixed.cover,
    manifest.fixed.closing,
    ...Object.values(manifest.pool as Record<string, PageFragment>)
  ];

  for (const fragment of fragments) {
    for (const anchor of fragment.anchors) {
      const anchorWithTarget = anchor as typeof anchor & { tarChars?: number };
      if (typeof anchorWithTarget.tarChars !== "number") {
        failures.push(`${templateId}: ${fragment.fragmentId}.${anchor.slotId} must include tarChars before maxChars.`);
        continue;
      }
      const expectedTarChars = Math.ceil(anchor.maxChars / 2);
      if (anchorWithTarget.tarChars !== expectedTarChars) {
        failures.push(
          `${templateId}: ${fragment.fragmentId}.${anchor.slotId} tarChars must equal ceil(maxChars / 2) (${expectedTarChars}); got ${anchorWithTarget.tarChars}.`
        );
      }
      if (fragment.fragmentId === "cover" && /body/i.test(anchor.slotId) && anchor.maxChars > 260) {
        failures.push(
          `${templateId}: cover body slot ${anchor.slotId} maxChars must not exceed compact cover capacity 260; got ${anchor.maxChars}.`
        );
      }
    }
  }
}

async function verifyAnchorCharTargetJsonOrder(templateId: string, templateDir: string, failures: string[]) {
  const manifestRaw = await readFile(join(templateDir, "manifest-v2.json"), "utf8");
  const lines = manifestRaw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s+"maxChars"\s*:/.test(lines[index] ?? "")) continue;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && !lines[previousIndex]!.trim()) previousIndex--;
    if (!/^\s+"tarChars"\s*:/.test(lines[previousIndex] ?? "")) {
      failures.push(`${templateId}: manifest-v2.json line ${index + 1} must place tarChars immediately before maxChars.`);
    }
  }
}

async function verifyFragmentStructureMatchesSource(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8");
  const sourceSections = extractSourceSections(indexHtml);
  const fragments: PageFragment[] = [
    manifest.fixed.cover,
    manifest.fixed.closing,
    ...Object.values(manifest.pool as Record<string, PageFragment>)
  ];

  for (const fragment of fragments) {
    const sourceHtml = sourceSections[fragment.sourceSlideIndex - 1] ?? "";
    if (!sourceHtml) continue;
    const expectedClasses = collectKeyLayoutClasses(sourceHtml);
    if (!expectedClasses.length) continue;

    const fragmentHtml = await readFile(join(templateDir, fragment.htmlFile), "utf8").catch(() => "");
    const actualClasses = collectKeyLayoutClasses(fragmentHtml);
    for (const className of expectedClasses) {
      if (!actualClasses.includes(className)) {
        failures.push(`${templateId}: ${fragment.htmlFile} must preserve source layout class '${className}' from slide ${fragment.sourceSlideIndex}.`);
      }
    }
  }
}

function extractSourceSections(indexHtml: string) {
  return [...indexHtml.matchAll(/<section\b(?=[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'])[\s\S]*?<\/section>/gi)].map((match) => match[0] ?? "");
}

function collectKeyLayoutClasses(html: string) {
  if (!html) return [];
  const dom = parseDocument(html, { decodeEntities: false });
  const elements = selectAll("[class]", dom as unknown as AnyNode) as Element[];
  const classes = new Set<string>();
  for (const element of elements) {
    for (const className of (element.attribs?.class ?? "").split(/\s+/).filter(Boolean)) {
      if (/^(?:layout-|grid-layout-)/.test(className)) classes.add(className);
    }
  }
  return [...classes].sort();
}

function isCoveredByAnchoredElement(node: Element, anchored: Set<Element>) {
  let current: Element | null = node;
  while (current) {
    if (anchored.has(current)) return true;
    current = current.parent as Element | null;
  }
  return false;
}

async function verifyUnconvertedTemplateSourcePaths(convertedTemplateIds: Set<string>, failures: string[]) {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || convertedTemplateIds.has(entry.name)) continue;
    const templateDir = join(TEMPLATES_ROOT, entry.name);
    const sourceFiles = ["index.html", "shell.html", "manifest-v2.json"];
    let referencesBaseCss = false;
    for (const file of sourceFiles) {
      const raw = await readFile(join(templateDir, file), "utf8").catch(() => "");
      if (!raw) continue;
      if (hasSkillRelativeAssetRef(raw)) {
        failures.push(`${entry.name}: ${file} must use local assets/... refs, not ../../../../assets/...`);
      }
      if (raw.includes("assets/base.css")) referencesBaseCss = true;
    }
    if (referencesBaseCss) await verifyLocalBaseCss(entry.name, templateDir, failures);
  }
}

async function verifyHtmlFilePaths(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  const fragments: PageFragment[] = [
    manifest.fixed.cover,
    manifest.fixed.closing,
    ...Object.values(manifest.pool as Record<string, PageFragment>)
  ];

  const shell = await readFile(join(templateDir, manifest.shellHtmlFile), "utf8");
  const markerCount = shell.split("<!-- SLIDES -->").length - 1;
  if (markerCount !== 1) failures.push(`${templateId}: shell.html must have exactly one <!-- SLIDES --> marker; got ${markerCount}`);
  if (hasSkillRelativeAssetRef(shell)) {
    failures.push(`${templateId}: shell.html must use local assets/... refs, not ../../../../assets/...`);
  }
  verifyNoRemoteImageUrls(templateId, manifest.shellHtmlFile, shell, failures);

  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8").catch(() => "");
  if (indexHtml && hasSkillRelativeAssetRef(indexHtml)) {
    failures.push(`${templateId}: index.html must use local assets/... refs, not ../../../../assets/...`);
  }
  if (indexHtml) verifyNoRemoteImageUrls(templateId, "index.html", indexHtml, failures);

  const manifestJson = await readFile(join(templateDir, "manifest-v2.json"), "utf8");
  if (hasSkillRelativeAssetRef(manifestJson)) {
    failures.push(`${templateId}: manifest-v2.json must use local assets/... refs, not ../../../../assets/...`);
  }

  for (const cssFile of manifest.cssFiles) {
    const css = await readFile(join(templateDir, cssFile), "utf8").catch(() => "");
    if (css) verifyNoRemoteImageUrls(templateId, cssFile, css, failures);
  }

  await verifyLocalBaseCss(templateId, templateDir, failures);

  for (const fragment of fragments) {
    try {
      const html = await readFile(join(templateDir, fragment.htmlFile), "utf8");
      verifyNoRemoteImageUrls(templateId, fragment.htmlFile, html, failures);
      const detectedMediaKinds = detectMediaKinds(html);
      const manifestMediaKinds = Array.isArray((fragment as { mediaKinds?: string[] }).mediaKinds)
        ? (fragment as { mediaKinds?: string[] }).mediaKinds ?? []
        : [];
      for (const kind of detectedMediaKinds) {
        if (!manifestMediaKinds.includes(kind)) {
          failures.push(`${templateId}: ${fragment.htmlFile} contains ${kind} media DOM but fragment.mediaKinds does not include '${kind}'`);
        }
      }
    } catch {
      failures.push(`${templateId}: missing fragment htmlFile ${fragment.htmlFile}`);
    }
  }
}

async function verifyLocalBaseCss(templateId: string, templateDir: string, failures: string[]) {
  const baseCssPath = join(templateDir, "assets", "base.css");
  let baseCss = "";
  try {
    baseCss = await readFile(baseCssPath, "utf8");
  } catch {
    failures.push(`${templateId}: missing local assets/base.css`);
    return;
  }
  if (!/\.slide\.is-active\b/.test(baseCss) || !/opacity\s*:\s*0/.test(baseCss) || !/opacity\s*:\s*1/.test(baseCss)) {
    failures.push(`${templateId}: assets/base.css must include slide visibility rules for .slide and .slide.is-active`);
  }
}

function hasSkillRelativeAssetRef(value: string) {
  return /\.\.\/(?:\.\.\/){1,}assets\//.test(value.replace(/\\/g, "/"));
}

function verifyNoRemoteImageUrls(templateId: string, filePath: string, value: string, failures: string[]) {
  const urls = findRemoteImageUrls(value);
  if (urls.length) {
    failures.push(`${templateId}: ${filePath} must use local img/... image refs, not remote image URL(s): ${urls.slice(0, 3).join(", ")}`);
  }
}

function verifyPoolBuilder(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  failures: string[]
) {
  const withMedia = buildAvailablePoolFromManifest(manifest, { includeImages: true, includeVideo: true, includeChart: true, includeAudio: false });
  const withAudio = buildAvailablePoolFromManifest(manifest, { includeImages: true, includeVideo: true, includeChart: true, includeAudio: true });
  const withoutMedia = buildAvailablePoolFromManifest(manifest, { includeImages: false, includeVideo: false, includeChart: false, includeAudio: false });

  for (const [pageType, summary] of Object.entries(withoutMedia.middle)) {
    if (summary?.isImage || summary?.isVideo || summary?.isChart || summary?.isAudio) {
      failures.push(`${templateId}: all-media-off pool exposed media fragment '${pageType}'`);
    }
  }

  const audioFragments = Object.values(manifest.pool as Record<string, PageFragment>).filter((fragment) =>
    AUDIO_PAGE_TYPES.includes(fragment.pageType) || fragment.mediaKinds.includes("audio")
  );
  for (const fragment of audioFragments) {
    const fragmentId = fragment.fragmentId;
    if (!fragmentId) {
      failures.push(`${templateId}: audio fragment is missing fragmentId`);
      continue;
    }
    if (withMedia.middle[fragmentId]) {
      failures.push(`${templateId}: pool-builder exposed audio fragment '${fragmentId}' while includeAudio=false`);
    }
    if (withoutMedia.middle[fragmentId]) {
      failures.push(`${templateId}: pool-builder exposed audio fragment '${fragmentId}' with media disabled`);
    }
    if (!withAudio.middle[fragmentId]) {
      failures.push(`${templateId}: pool-builder did not expose audio fragment '${fragmentId}' while includeAudio=true`);
    }
  }
}

async function verifyTemplateSpecificExpectations(
  templateId: string,
  manifest: Awaited<ReturnType<typeof loadManifestV2>>,
  templateDir: string,
  failures: string[]
) {
  if (templateId === "24-fresh-ecommerce") {
    const css = await readFile(join(templateDir, "style.css"), "utf8");
    if (!/\.tpl-fresh\s+\.slide\.title-slide\s+\.h1\s*\{[\s\S]*font-size:\s*80px/.test(css)) {
      failures.push(`${templateId}: cover/closing title h1 must use fixed 80px via .slide.title-slide .h1.`);
    }
  }

  if (templateId === "12-creative-portfolio") {
    const css = await readFile(join(templateDir, "style.css"), "utf8");
    const html = await readFile(join(templateDir, "index.html"), "utf8");
    if (!/\.tpl-creative-portfolio\s+\.slide\[data-title="(?:02 Manifesto|04 Case Study 1)"\]\s+\.grid-2[\s\S]*min-height:\s*0/.test(css)) {
      failures.push(`${templateId}: slides 02/04 must constrain grid height with min-height:0 to avoid vertical overflow.`);
    }
    if (!/\.tpl-creative-portfolio\s+\.slide\[data-title="(?:02 Manifesto|04 Case Study 1)"\]\s+\.img-wrap[\s\S]*overflow:\s*hidden/.test(css)) {
      failures.push(`${templateId}: slides 02/04 img-wrap must be height-constrained with overflow:hidden.`);
    }
    const clientsSection = html.match(/<section class="slide" data-title="14 Clients">[\s\S]*?<\/section>/)?.[0] ?? "";
    if (!/font-size:\s*14px/.test(clientsSection) || !/font-weight:\s*400/.test(clientsSection) || /font-size:\s*30px/.test(clientsSection) || /font-weight:\s*bold/i.test(clientsSection)) {
      failures.push(`${templateId}: slide 14 client cards must match slide 15 body text at 14px normal-weight.`);
    }
  }

  if (templateId === "07-industry-edge") {
    const css = await readFile(join(templateDir, "style.css"), "utf8");
    if (!/\.tpl-industry\s+\.slide\[data-title="(?:控制延迟对比|非计划停机分析)"\]\s+\.chart-container[\s\S]*max-height:\s*min\(56vh,\s*560px\)/.test(css)) {
      failures.push(`${templateId}: chart pages 6/8 must cap chart-container height with max-height:min(56vh, 560px) for 1920x1080.`);
    }
    const requiredDashboardTexts: Record<string, string[]> = {
      "slide-03": [
        "AVERAGE CLOUD LATENCY",
        "> 120 MS",
        "EDGE NODE LATENCY",
        "< 5 MS",
        "DATA UPLOAD REDUCTION",
        "95.00 %"
      ],
      "slide-07": [
        "SPINDLE SPEED (RPM)",
        "14,250",
        "TOOL WEAR INDEX",
        "82.4 %",
        "VIBRATION ANOMALY",
        "NORMAL"
      ]
    };
    for (const [fragmentId, expectedTexts] of Object.entries(requiredDashboardTexts)) {
      const fragment = (manifest.pool as Record<string, PageFragment>)[fragmentId];
      const sourceTexts = new Set(fragment?.anchors.map((anchor) => anchor.sourceText).filter(Boolean));
      for (const expectedText of expectedTexts) {
        if (!sourceTexts.has(expectedText)) {
          failures.push(`${templateId}: ${fragmentId} dashboard metric '${expectedText}' must be promoted to an anchor to prevent template residue.`);
        }
      }
    }
  }

  if (templateId === "01-tech-web3") {
    const closingBody = manifest.fixed.closing.anchors.find((anchor) => anchor.slotId === "body-1");
    if (closingBody?.maxChars !== 320 || closingBody.tarChars !== 160) {
      failures.push(`${templateId}: non-cover body anchor fixed.closing.body-1 must remain at tarChars=160/maxChars=320.`);
    }
    const slide02Body = (manifest.pool as Record<string, PageFragment>)["slide-02"]?.anchors.find((anchor) => anchor.slotId === "card-1-body");
    if (slide02Body?.maxChars !== 272 || slide02Body.tarChars !== 136) {
      failures.push(`${templateId}: non-cover body anchor slide-02.card-1-body must remain at tarChars=136/maxChars=272.`);
    }
  }

  if (templateId !== "11-corporate-consulting") return;
  const expectedCharts = [
    ["slide-09", "line"],
    ["slide-10", "pie"],
    ["slide-11", "bar"]
  ] as const;
  for (const [fragmentId, chartKind] of expectedCharts) {
    const fragment = (manifest.pool as Record<string, PageFragment>)[fragmentId];
    if (!fragment) {
      failures.push(`${templateId}: source slide ${fragmentId} contains chart-like SVG/CSS visuals, so manifest-v2 must expose '${fragmentId}'`);
      continue;
    }
    if (!fragment.mediaKinds.includes("chart")) {
      failures.push(`${templateId}: ${fragmentId} must declare mediaKinds chart`);
    }
    if (fragment.mediaKinds.includes("image")) {
      failures.push(`${templateId}: ${fragmentId} chart page must not be tagged as image media without real image DOM/URL/slot`);
    }
    if (!fragment.chartSlots?.some((slot) => slot.kind === chartKind)) {
      failures.push(`${templateId}: ${fragmentId} pagePortrait/chartSlots must classify chart kind '${chartKind}'`);
    }
    if (!fragment.pagePortrait?.componentCounts.grid) {
      failures.push(`${templateId}: ${fragmentId} pagePortrait must retain the surrounding grid component`);
    }
  }
}

function fragmentIdForSourceSlide(slideIndex: number) {
  return `slide-${String(slideIndex).padStart(2, "0")}`;
}

function collectVisibleTextElements(root: AnyNode): Element[] {
  const result: Element[] = [];
  visit(root);
  return result;

  function visit(node: AnyNode) {
    if (isElement(node)) {
      if (isVisibleTextElement(node)) result.push(node);
      for (const child of node.children ?? []) visit(child as AnyNode);
      return;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child as AnyNode);
    }
  }
}

function isVisibleTextElement(node: Element) {
  if (["script", "style", "noscript", "template"].includes(node.tagName)) return false;
  const text = textOf(node).trim();
  if (!text) return false;
  if (isPageNumberElement(node, text)) return false;
  if (containsProtectedRuntimeElement(node)) return false;
  if (isFooterContainerWithStructure(node)) return false;
  return isSemanticTextElement(node);
}

function isSemanticTextElement(node: Element) {
  const tag = node.tagName.toLowerCase();
  const className = node.attribs?.class ?? "";
  if (/^(h1|h2|h3|h4|p|li|td|th|small|span|strong|em|b|i|code|button|a)$/.test(tag)) return true;
  if (tag === "div" && /(?:^|\s)(?:text-block|title|card-title|item-title|feature-title|number|number-huge|label|desc|card-desc|item-desc|feature-desc|kicker|pill|tag|card-tag|badge|caption|quote|footer|meta|mono|chip|cta)(?:\s|$)/i.test(className)) {
    return true;
  }
  if (tag === "div" && isLeafTextElement(node)) return true;
  return false;
}

function isExemptVisibleText(node: Element, text: string) {
  const className = node.attribs?.class ?? "";
  if (/(?:^|\s)(?:card-icon|decorative-icon|visual-icon|icon-mark)(?:\s|$)/i.test(className)) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]+$/u.test(text)) return true;
  if (/^[\p{Symbol}\s]+$/u.test(text)) return true;
  if (/^[•·—–\-+*/\\|()[\]{}<>=_:;,.!?，。！？、\s]+$/.test(text)) return true;
  if (node.attribs?.["aria-hidden"] === "true") return true;
  return false;
}

function isPageNumberElement(node: Element, text: string) {
  const attrs = node.attribs ?? {};
  const classes = (attrs.class ?? "").split(/\s+/);
  return classes.includes("slide-number") || "data-current" in attrs || "data-total" in attrs || /^\d{1,3}\s*\/\s*\d{1,3}$/.test(text);
}

function containsProtectedRuntimeElement(node: Element): boolean {
  const classes = (node.attribs?.class ?? "").split(/\s+/);
  if (classes.includes("slide-number") || classes.includes("progress-bar")) return true;
  for (const child of node.children ?? []) {
    if (isElement(child as AnyNode) && containsProtectedRuntimeElement(child as Element)) return true;
  }
  return false;
}

function isFooterContainerWithStructure(node: Element) {
  if (node.tagName.toLowerCase() !== "div") return false;
  const className = node.attribs?.class ?? "";
  if (!/(?:footer|footer-bar|page-foot)/i.test(className)) return false;
  return (node.children ?? []).some((child) => isElement(child as AnyNode));
}

function isElement(node: AnyNode): node is Element {
  return node.type === "tag" && "tagName" in node;
}

function isLeafTextElement(node: Element) {
  return !(node.children ?? []).some((child) => isElement(child as AnyNode));
}

function isForbiddenTemplateResidue(text: string) {
  return /(?:\bSYSTEM(?:_|\b)|GITHUB|PGP|0x[0-9a-f]|CONNECT@|WWW\.|\bSTATUS(?:_|\b)|COMPLETE|REBOOT|SMART-CITY-DAO|SYNC)/i.test(text);
}

function textOf(node: AnyNode): string {
  if (node.type === "text") return (node as Text).data;
  if (!("children" in node) || !node.children) return "";
  return node.children.map((child) => textOf(child as AnyNode)).join("");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
