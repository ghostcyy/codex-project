import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectAll, selectOne } from "css-select";
import type { AnyNode, ChildNode, Element } from "domhandler";
import { render } from "dom-serializer";
import { parseDocument } from "htmlparser2";
import {
  CHART_TYPES,
  IMAGE_PAGE_TYPES,
  TEMPLATES_ROOT,
  VIDEO_PAGE_TYPES,
  type ChartSlot,
  type ChartSlotKind,
  type ChartType,
  type DeckEffects,
  type PageFragment,
  type PageType,
  type SlotAnchor,
  type SlotAnchorKind,
  type TemplateManifestV2
} from "../shared";
import { detectMediaKinds, detectsChartMedia } from "./media-kind-detector";
import { parseManifestV2Json } from "./manifest-v2.validator";
import { buildPagePortrait } from "./page-portrait";

type LegacySlideManifest = {
  slideIndex: number;
  slideTitle: string;
  pageType: PageType;
  topicSlots: number;
  topicSlotMaxChars: number;
  hasImage: boolean;
  imageCount: number;
  hasVideo: boolean;
  hasChart: boolean;
  anchors: SlotAnchor[];
};

type LegacyTemplateManifest = {
  id: string;
  label: { "zh-CN": string; en: string };
  description: { "zh-CN": string; en: string };
  deckClass: string;
  slides: LegacySlideManifest[];
};

type NormalizedSection = {
  html: string;
  chartSlots: ChartSlot[];
};

type ExtractedDeckEffects = DeckEffects & {
  html?: string;
};

async function main() {
  const targetId = process.argv[2]?.trim();
  const templateIds = targetId ? [targetId] : await listTemplateIds();

  for (const templateId of templateIds) {
    try {
      const result = await convertTemplate(templateId);
      console.log(`[OK] ${templateId}: wrote ${result.fragmentCount} fragments`);
    } catch (error) {
      console.error(`[ERR] ${templateId}: ${formatError(error)}`);
      process.exitCode = 1;
    }
  }
}

export async function convertTemplate(templateId: string): Promise<{ fragmentCount: number }> {
  const templateDir = join(TEMPLATES_ROOT, templateId);
  const indexPath = join(templateDir, "index.html");
  const fragmentsDir = join(templateDir, "fragments");

  const indexHtml = await readFile(indexPath, "utf8");
  const sections = extractSections(indexHtml);
  const legacy = await readTemplateSourceManifest(templateDir, sections);
  const cssFiles = extractLocalCssFiles(indexHtml);
  const cssText = await readTemplateCss(templateDir, cssFiles);
  const deckEffects = await extractDeckEffects(templateDir, indexHtml);
  if (sections.length !== legacy.slides.length) {
    throw new Error(`legacy manifest has ${legacy.slides.length} slides but index.html has ${sections.length} section.slide blocks`);
  }

  await mkdir(fragmentsDir, { recursive: true });

  const coverSlide = legacy.slides[0]!;
  const closingSlide = legacy.slides.at(-1)!;
  const coverSection = normalizeSection(sections[coverSlide.slideIndex - 1]!, "cover");
  const closingSection = normalizeSection(sections[closingSlide.slideIndex - 1]!, "closing");
  const fixedCover = toFragment(coverSlide, "cover", "cover", "fragments/cover.html", coverSection, cssText);
  const fixedClosing = toFragment(closingSlide, "closing", "closing", "fragments/closing.html", closingSection, cssText);
  const pool: Record<string, PageFragment> = {};

  await writeFragment(templateDir, fixedCover, coverSection.html);
  await writeFragment(templateDir, fixedClosing, closingSection.html);

  for (const slide of legacy.slides.slice(1, -1)) {
    const pageType = resolveCanonicalPageType(slide, sections[slide.slideIndex - 1] ?? "");
    if (pageType === "cover" || pageType === "closing") continue;
    const fragmentId = fragmentIdForSourceSlide(slide.slideIndex);
    const normalized = normalizeSection(sections[slide.slideIndex - 1]!, pageType);
    const fragment = toFragment(slide, pageType, fragmentId, `fragments/${fragmentId}.html`, normalized, cssText);
    pool[fragmentId] = fragment;
    await writeFragment(templateDir, fragment, normalized.html);
  }

  const manifest: TemplateManifestV2 = {
    schemaVersion: 2,
    id: legacy.id,
    deckClass: legacy.deckClass,
    label: legacy.label,
    description: legacy.description,
    shellHtmlFile: "shell.html",
    cssFiles,
    jsFiles: extractLocalJsFiles(indexHtml),
    assetDirs: ["assets", "img"].filter((dir) => existsSync(join(templateDir, dir))),
    ...(deckEffects ? { deckEffects: toManifestDeckEffects(deckEffects) } : {}),
    fixed: {
      cover: fixedCover,
      closing: fixedClosing
    },
    pool,
    capabilities: {
      chartTypes: Object.values(pool).some((fragment) => fragment.mediaKinds.includes("chart")) ? [...CHART_TYPES] : [],
      hasImagePages: Object.values(pool).some((fragment) => fragment.mediaKinds.includes("image")),
      hasVideoPages: Object.values(pool).some((fragment) => fragment.mediaKinds.includes("video")),
      hasAudioPages: Object.values(pool).some((fragment) => fragment.mediaKinds.includes("audio"))
    }
  };

  const parsed = await parseManifestV2Json(JSON.stringify(manifest));
  if (!parsed.ok) {
    throw new Error(`generated manifest-v2 failed schema validation: ${parsed.reasons.join("; ")}`);
  }

  await writeFile(join(templateDir, "manifest-v2.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(templateDir, "shell.html"), buildShell(indexHtml, legacy.deckClass, deckEffects), "utf8");

  return { fragmentCount: 2 + Object.keys(pool).length };
}

function toFragment(
  slide: LegacySlideManifest,
  pageType: PageType,
  fragmentId: string,
  htmlFile: string,
  normalized: NormalizedSection,
  cssText: string
): PageFragment {
  const html = normalized.html;
  const baseAnchors = refineAnchors(slide.anchors, html);
  const mediaKinds = detectMediaKinds(html);
  const chartSlots = normalized.chartSlots.length ? normalized.chartSlots : buildChartSlotsFromCanvases(html);
  return {
    fragmentId,
    pageType,
    sourcePageType: slide.pageType,
    sourceSlideIndex: slide.slideIndex,
    sourceSlideTitle: slide.slideTitle,
    htmlFile,
    pagePortrait: buildPagePortrait({ html, pageType, chartSlots, cssText }),
    topicSlots: pageType === "cover" || pageType === "closing" ? 0 : slide.topicSlots,
    topicSlotMaxChars: pageType === "cover" || pageType === "closing" ? 0 : slide.topicSlotMaxChars,
    anchors: promoteVisibleTextAnchors(baseAnchors, html),
    chartCanvasSelector: chartSlots.some((slot) => slot.slotId === "primary") ? "canvas[data-chart-slot='primary']" : undefined,
    chartSlots,
    imageSlotSelectors: buildImageSlotSelectors(html),
    videoSlotSelector: /<video\b/i.test(html) ? "video[data-video-slot='primary']" : undefined,
    mediaKinds
  };
}

function resolveCanonicalPageType(slide: LegacySlideManifest, sectionHtml: string): PageType {
  if (slide.pageType === "cover" || slide.pageType === "closing") return slide.pageType;
  return detectsChartMedia(sectionHtml) ? "chart" : slide.pageType;
}

async function writeFragment(templateDir: string, fragment: PageFragment, html: string) {
  await writeFile(join(templateDir, fragment.htmlFile), `${html.trim()}\n`, "utf8");
}

async function readTemplateSourceManifest(templateDir: string, sections: string[]): Promise<LegacyTemplateManifest> {
  const manifestV2Raw = await readFile(join(templateDir, "manifest-v2.json"), "utf8");
  const parsed = await parseManifestV2Json(manifestV2Raw);
  if (!parsed.ok) {
    throw new Error(`manifest-v2 source failed schema validation: ${parsed.reasons.join("; ")}`);
  }

  const manifest = parsed.manifest;
  const fragmentsBySourceIndex = new Map<number, PageFragment>();
  for (const fragment of [manifest.fixed.cover, manifest.fixed.closing, ...Object.values(manifest.pool as Record<string, PageFragment>)]) {
    if (fragment.sourceSlideIndex > 0) fragmentsBySourceIndex.set(fragment.sourceSlideIndex, fragment);
  }

  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    deckClass: manifest.deckClass,
    slides: sections.map((sectionHtml, index) => {
      const slideIndex = index + 1;
      const fragment = fragmentsBySourceIndex.get(slideIndex);
      const pageType = fragment?.sourcePageType ?? fragment?.pageType ?? inferPageTypeFromSection(sectionHtml, slideIndex, sections.length);
      return {
        slideIndex,
        slideTitle: fragment?.sourceSlideTitle || extractSectionTitle(sectionHtml) || `Slide ${slideIndex}`,
        pageType,
        topicSlots: fragment?.topicSlots ?? (pageType === "cover" || pageType === "closing" ? 0 : 1),
        topicSlotMaxChars: fragment?.topicSlotMaxChars ?? (pageType === "cover" || pageType === "closing" ? 0 : 120),
        hasImage: fragment?.mediaKinds.includes("image") ?? false,
        imageCount: fragment?.imageSlotSelectors.length ?? 0,
        hasVideo: fragment?.mediaKinds.includes("video") ?? false,
        hasChart: fragment?.mediaKinds.includes("chart") ?? false,
        anchors: fragment?.anchors ?? []
      };
    })
  };
}

function inferPageTypeFromSection(sectionHtml: string, slideIndex: number, slideCount: number): PageType {
  if (slideIndex === 1) return "cover";
  if (slideIndex === slideCount) return "closing";
  if (detectsChartMedia(sectionHtml)) return "chart";
  const dataPageType = sectionHtml.match(/\bdata-page-type=(["'])(.*?)\1/i)?.[2];
  if (dataPageType && isPageType(dataPageType)) return dataPageType;
  const className = sectionHtml.match(/<section\b[^>]*\bclass=(["'])(.*?)\1/i)?.[2] ?? "";
  const classPageType = className.split(/\s+/).find(isPageType);
  return classPageType ?? "title-text";
}

function extractSectionTitle(sectionHtml: string) {
  return sectionHtml.match(/\bdata-title=(["'])(.*?)\1/i)?.[2] ?? null;
}

function isPageType(value: string): value is PageType {
  return [
    "cover",
    "closing",
    "grid-2",
    "grid-3",
    "grid-4",
    "grid-5",
    "sidebar",
    "title-text",
    "chart",
    "image-full",
    "image-text",
    "image-grid",
    "video",
    "audio",
    "table",
    "path-flow"
  ].includes(value);
}

function normalizeSection(sectionHtml: string, pageType: PageType): NormalizedSection {
  let html = sectionHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/(<section\b[^>]*?)\sdata-page-type=(["']).*?\2/gi, "$1")
    .replace(/<section\b([^>]*)>/i, (_match, attrs: string) => `<section${attrs} data-page-type="${pageType}">`);
  let chartSlots: ChartSlot[] = [];

  if (pageType === "chart") {
    const normalized = normalizeChartMarkup(html);
    html = normalized.html;
    chartSlots = normalized.chartSlots;
  }

  let imageIndex = 0;
  html = html.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
    const cleaned = stripAttribute(stripAttribute(attrs, "src"), "data-image-slot");
    return `<img${cleaned} data-image-slot="${imageIndex++}">`;
  });

  if (pageType === "video") {
    html = html.replace(/<video\b([^>]*)>/gi, (_match, attrs: string) => {
      const cleaned = stripAttribute(stripAttribute(attrs, "src"), "data-video-slot");
      return `<video${cleaned} data-video-slot="primary">`;
    });
  }

  return { html, chartSlots };
}

function normalizeChartMarkup(html: string): NormalizedSection {
  const dom = parseDocument(html, { decodeEntities: false });
  const section = selectOne("section.slide", dom as unknown as ChildNode) as Element | null;
  if (!section) return { html, chartSlots: [] };

  const existingCanvases = selectAll("canvas", section as unknown as ChildNode) as Element[];
  if (existingCanvases.length) {
    const chartSlots = existingCanvases.map((canvas, index) => normalizeCanvasSlot(canvas, index, existingCanvases.length, "unknown"));
    return { html: render(dom as unknown as AnyNode, { decodeEntities: false }), chartSlots };
  }

  const chartTargets = findStaticChartTargets(section);
  if (!chartTargets.length) return { html, chartSlots: [] };

  removeNodes(selectAll(".chart-legend", section as unknown as ChildNode) as Element[]);
  const chartSlots: ChartSlot[] = [];
  chartTargets.forEach((chartTarget, index) => {
    const kind = inferChartKind(chartTarget);
    const slotId = chartTargets.length === 1 ? "primary" : `chart-${index + 1}`;
    const canvas = createChartCanvas(slotId, kind);
    const componentId = `chart-${index + 1}`;
    if (chartTarget.tagName.toLowerCase() === "svg") {
      replaceNode(chartTarget, canvas);
      const parent = canvas.parent as Element | null;
      if (parent) parent.attribs = rewriteChartContainerClass(parent.attribs ?? {});
    } else {
      chartTarget.attribs = rewriteChartContainerClass(chartTarget.attribs ?? {});
      chartTarget.children = [canvas];
      chartTarget.children[0]!.parent = chartTarget;
    }
    chartSlots.push({
      slotId,
      selector: `canvas[data-chart-slot='${slotId}']`,
      kind,
      defaultRenderType: defaultRenderTypeForChartKind(kind),
      componentId
    });
  });

  return { html: render(dom as unknown as AnyNode, { decodeEntities: false }), chartSlots };
}

function buildChartSlotsFromCanvases(html: string): ChartSlot[] {
  const dom = parseDocument(html, { decodeEntities: false });
  const canvases = selectAll("canvas[data-chart-slot]", dom as unknown as ChildNode) as Element[];
  return canvases.map((canvas, index) => {
    const slotId = canvas.attribs?.["data-chart-slot"] ?? (canvases.length === 1 ? "primary" : `chart-${index + 1}`);
    const kind = chartKindFromValue(canvas.attribs?.["data-chart-kind"] ?? "");
    return {
      slotId,
      selector: `canvas[data-chart-slot='${slotId}']`,
      kind,
      defaultRenderType: defaultRenderTypeForChartKind(kind),
      componentId: `chart-${index + 1}`
    };
  });
}

function normalizeCanvasSlot(canvas: Element, index: number, total: number, fallbackKind: ChartSlotKind): ChartSlot {
  const slotId = total === 1 ? "primary" : `chart-${index + 1}`;
  const kind = chartKindFromValue(canvas.attribs?.["data-chart-kind"] ?? canvas.attribs?.class ?? "") || fallbackKind;
  const cleaned = { ...(canvas.attribs ?? {}) };
  delete cleaned.id;
  cleaned["data-chart-slot"] = slotId;
  cleaned["data-chart-kind"] = kind;
  canvas.attribs = cleaned;
  return {
    slotId,
    selector: `canvas[data-chart-slot='${slotId}']`,
    kind,
    defaultRenderType: defaultRenderTypeForChartKind(kind),
    componentId: `chart-${index + 1}`
  };
}

function findStaticChartTargets(section: Element) {
  const candidates = selectAll(
    "svg, .pie-chart, .bar-chart, .line-chart, .xbar-chart, .s-chart, .donut-chart, .area-chart, .gantt-chart, .chart-container, .chart-wrapper, .chart-card",
    section as unknown as ChildNode
  ) as Element[];
  const specific = candidates.filter(isSpecificChartTarget);
  return filterNestedChartTargets(specific.length ? specific : candidates);
}

function isSpecificChartTarget(element: Element) {
  const className = element.attribs?.class ?? "";
  return element.tagName.toLowerCase() === "svg" || /\b(?:pie|bar|line|xbar|s|donut|area|gantt)-chart\b/i.test(className);
}

function filterNestedChartTargets(elements: Element[]) {
  const set = new Set(elements);
  return elements.filter((element) => {
    let current = element.parent as Element | null;
    while (current) {
      if (set.has(current)) return false;
      current = current.parent as Element | null;
    }
    return true;
  });
}

function createChartCanvas(slotId: string, kind: ChartSlotKind) {
  const dom = parseDocument(`<canvas data-chart-slot="${slotId}" data-chart-kind="${kind}"></canvas>`, { decodeEntities: false });
  return selectOne("canvas", dom as unknown as ChildNode) as Element;
}

function inferChartKind(element: Element): ChartSlotKind {
  const signature = `${element.tagName} ${element.attribs?.class ?? ""} ${element.attribs?.id ?? ""}`.toLowerCase();
  const explicit = chartKindFromValue(signature);
  if (explicit !== "unknown") return explicit;
  if (element.tagName.toLowerCase() === "svg") {
    const raw = render(element as unknown as AnyNode, { decodeEntities: false }).toLowerCase();
    if (/<polyline\b|<path\b/.test(raw)) return "line";
    if (/<rect\b/.test(raw)) return "bar";
  }
  return "unknown";
}

function chartKindFromValue(value: string): ChartSlotKind {
  if (/\bxbar-chart\b|\bxbar\b/i.test(value)) return "xbar";
  if (/\bs-chart\b|\bschart\b/i.test(value)) return "s";
  if (/\bdonut-chart\b|\bdonut\b/i.test(value)) return "donut";
  if (/\bpie-chart\b|\bpie\b/i.test(value)) return "pie";
  if (/\bgantt-chart\b|\bgantt\b/i.test(value)) return "gantt";
  if (/\barea-chart\b|\barea\b/i.test(value)) return "area";
  if (/\bbar-chart\b|\bbar\b/i.test(value)) return "bar";
  if (/\bline-chart\b|\bline\b|\btrend\b/i.test(value)) return "line";
  return "unknown";
}

function defaultRenderTypeForChartKind(kind: ChartSlotKind): ChartType {
  if (kind === "bar") return "bar";
  if (kind === "pie" || kind === "donut") return "pie";
  if (kind === "gantt") return "gantt";
  return "line";
}

function rewriteChartContainerClass(attrs: Element["attribs"]) {
  const next = { ...attrs };
  const classes = (next.class ?? "").split(/\s+/).filter(Boolean);
  const filtered = classes.filter((className) =>
    !/^(?:image-placeholder|pie-chart|bar-chart|line-chart|xbar-chart|s-chart|donut-chart|area-chart|gantt-chart)$/.test(className)
  );
  if (!filtered.includes("chart-container")) filtered.push("chart-container");
  next.class = filtered.join(" ");
  return next;
}

function removeNodes(nodes: Element[]) {
  for (const node of nodes) {
    const parent = node.parent as Element | null;
    if (!parent?.children) continue;
    parent.children = parent.children.filter((child) => child !== node);
  }
}

function replaceNode(target: Element, replacement: Element) {
  const parent = target.parent as Element | null;
  if (!parent?.children) return;
  const index = parent.children.indexOf(target);
  if (index < 0) return;
  parent.children[index] = replacement;
  replacement.parent = parent;
}

async function extractDeckEffects(templateDir: string, indexHtml: string): Promise<ExtractedDeckEffects | undefined> {
  const dom = parseDocument(indexHtml, { decodeEntities: false });
  const effectNodes = uniqueElements(selectAll(
    "body > canvas[id], body > div[id], body > svg[id], .deck > canvas[id], .deck > div[id], .deck > svg[id]",
    dom as unknown as ChildNode
  ) as Element[])
    .filter(isDeckLevelEffectNode);
  if (!effectNodes.length) return undefined;

  const html = effectNodes.map((node) => render(node as unknown as AnyNode, { decodeEntities: false })).join("\n");
  const elementIds = effectNodes
    .map((node) => node.attribs?.id)
    .filter((id): id is string => Boolean(id));

  const htmlFile = "fragments/deck-effects.html";
  await writeFile(join(templateDir, htmlFile), `${html.trim()}\n`, "utf8");

  const scriptChunks = extractInlineDeckEffectScripts(indexHtml, elementIds);
  let jsFile: string | undefined;
  if (scriptChunks.length) {
    jsFile = "assets/deck-effects.js";
    await mkdir(join(templateDir, "assets"), { recursive: true });
    await writeFile(join(templateDir, jsFile), buildDeckEffectsScript(scriptChunks), "utf8");
  }

  return { htmlFile, jsFile, elementIds, html };
}

function toManifestDeckEffects(deckEffects: ExtractedDeckEffects): DeckEffects {
  return {
    htmlFile: deckEffects.htmlFile,
    jsFile: deckEffects.jsFile,
    elementIds: deckEffects.elementIds
  };
}

function isDeckLevelEffectNode(node: Element) {
  const tag = node.tagName.toLowerCase();
  if (tag !== "canvas" && tag !== "div" && tag !== "svg") return false;
  const signature = `${node.attribs?.id ?? ""} ${node.attribs?.class ?? ""}`.toLowerCase();
  return /(?:particle|particles|canvas|matrix|zen|bokeh|rogue|quantum|luxury|fresh|home|outdoor|innovation|experimental|ocean)/.test(signature);
}

function uniqueElements(elements: Element[]) {
  return Array.from(new Set(elements));
}

function extractInlineDeckEffectScripts(indexHtml: string, elementIds: string[]) {
  const inlineScripts = [...indexHtml.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? "");
  const chunks: string[] = [];
  for (const script of inlineScripts) {
    for (const elementId of elementIds) {
      const chunk = extractDeckEffectScriptChunk(script, elementId);
      if (chunk && !chunks.includes(chunk)) chunks.push(chunk);
    }
  }
  return chunks.filter((chunk) => !containsLegacyChartInit(chunk));
}

function extractDeckEffectScriptChunk(script: string, elementId: string) {
  const idPattern = new RegExp(`getElementById\\(\\s*(['"])${escapeRegExp(elementId)}\\1\\s*\\)`);
  const idMatch = idPattern.exec(script);
  if (!idMatch) return null;

  const declarationStart = Math.max(0, script.lastIndexOf("\n", idMatch.index) + 1);
  const declarationEnd = script.indexOf(";", idMatch.index);
  if (declarationEnd < 0) return null;

  const ifPattern = /if\s*\([^)]*\)\s*\{/g;
  ifPattern.lastIndex = declarationEnd + 1;
  const ifMatch = ifPattern.exec(script);
  if (!ifMatch) return script.slice(declarationStart, declarationEnd + 1).trim();

  const blockOpen = script.indexOf("{", ifMatch.index);
  const blockEnd = findMatchingBrace(script, blockOpen);
  if (blockOpen < 0 || blockEnd < 0) return script.slice(declarationStart, declarationEnd + 1).trim();
  return script.slice(declarationStart, blockEnd + 1).trim();
}

function findMatchingBrace(value: string, openIndex: number) {
  if (openIndex < 0) return -1;
  let depth = 0;
  for (let index = openIndex; index < value.length; index++) {
    const char = value[index];
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function buildDeckEffectsScript(scriptChunks: string[]) {
  return [
    "(function () {",
    "  function runDeckEffects() {",
    ...scriptChunks.flatMap((chunk) => indentLines(chunk, 4)),
    "  }",
    "  if (document.readyState === \"loading\") {",
    "    document.addEventListener(\"DOMContentLoaded\", runDeckEffects, { once: true });",
    "  } else {",
    "    runDeckEffects();",
    "  }",
    "})();",
    ""
  ].join("\n");
}

function indentLines(value: string, spaces: number) {
  const prefix = " ".repeat(spaces);
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function containsLegacyChartInit(value: string) {
  return /createChart\s*\(|getElementById\(["'](?:lineChart|pieChart|barChart|ganttChart)["']\)/i.test(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildShell(indexHtml: string, deckClass: string, deckEffects?: ExtractedDeckEffects) {
  const head = indexHtml.match(/<head\b[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? "<head><meta charset=\"utf-8\"><title>{{deckTitle}}</title></head>";
  const effectHtml = deckEffects?.html ? `${deckEffects.html.trim()}\n    ` : "";
  const effectScript = deckEffects?.jsFile ? `  <script src="${deckEffects.jsFile}" data-html-ppt-v3-deck-effects></script>\n` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
${head}
<body class="${deckClass}">
  <main class="deck">
    ${effectHtml}<!-- SLIDES -->
  </main>
  <!-- CHART_INITS -->
${effectScript}</body>
</html>
`;
}

function buildImageSlotSelectors(html: string) {
  const count = [...html.matchAll(/<img\b[^>]*data-image-slot=["'](\d+)["'][^>]*>/gi)].length;
  return Array.from({ length: count }, (_value, index) => `img[data-image-slot='${index}']`);
}

function refineAnchors(anchors: SlotAnchor[], html: string) {
  const dom = parseDocument(html);
  const section = selectOne("section.slide", dom as unknown as ChildNode) as Element | null;
  if (!section) return anchors;

  return anchors.flatMap((anchor) => {
    const target = findAnchorTarget(anchor, section);
    if (!target) return [];
    const selector = buildUniqueSelector(target, section);
    return selector
      ? [normalizeAnchorCharTargets({
          ...anchor,
          selector,
          kind: anchor.kind ?? inferAnchorKind(anchor.slotId, target),
          sourceText: normalizeText(textOf(target))
        })]
      : [];
  });
}

function promoteVisibleTextAnchors(anchors: SlotAnchor[], html: string): SlotAnchor[] {
  const dom = parseDocument(html);
  const section = selectOne("section.slide", dom as unknown as ChildNode) as Element | null;
  if (!section) return anchors;

  const occupied = new Set<Element>();
  const covered = new Set<Element>();
  for (const anchor of anchors) {
    const matches = selectAll(anchor.selector, section as unknown as ChildNode) as Element[];
    if (matches.length === 1) {
      occupied.add(matches[0]!);
      markSubtreeCovered(matches[0]!, covered);
    }
  }

  const additions: SlotAnchor[] = [];
  const counters = seedSlotCounters(anchors);
  const candidates = collectVisibleTextCandidates(section)
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || depth(a) - depth(b));

  for (const candidate of candidates) {
    if (occupied.has(candidate)) continue;
    if (covered.has(candidate)) continue;
    if (isPageNumberElement(candidate)) continue;
    const text = normalizeText(textOf(candidate));
    if (!text || isExemptVisibleText(candidate, text)) continue;
    const selector = buildUniqueSelector(candidate, section);
    if (!selector) continue;
    const kind = inferAnchorKind("", candidate);
    const prefix = slotPrefixForKind(kind);
    const nextIndex = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, nextIndex);
    additions.push(normalizeAnchorCharTargets({
      slotId: `${prefix}-${nextIndex}`,
      selector,
      maxChars: maxCharsForKind(kind, text),
      optional: false,
      kind,
      sourceText: text
    }));
    occupied.add(candidate);
    markSubtreeCovered(candidate, covered);
  }

  return [...anchors, ...additions];
}

function normalizeAnchorCharTargets(anchor: SlotAnchor): SlotAnchor {
  return orderAnchorFields({
    ...anchor,
    tarChars: Math.ceil(anchor.maxChars / 2)
  });
}

function orderAnchorFields(anchor: SlotAnchor): SlotAnchor {
  return {
    slotId: anchor.slotId,
    selector: anchor.selector,
    tarChars: anchor.tarChars,
    maxChars: anchor.maxChars,
    optional: anchor.optional,
    kind: anchor.kind,
    sourceText: anchor.sourceText
  };
}

function collectVisibleTextCandidates(section: Element) {
  return (selectAll("h1, h2, h3, h4, p, li, td, th, small, span, strong, em, b, i, code, button, a, div", section as unknown as ChildNode) as Element[])
    .filter((element) => {
      const text = normalizeText(textOf(element));
      if (!text || isPageNumberElement(element) || isExemptVisibleText(element, text)) return false;
      if (containsProtectedRuntimeElement(element)) return false;
      if (isFooterContainerWithStructure(element)) return false;
      return isSemanticTextElement(element);
    });
}

function isSemanticTextElement(element: Element) {
  const tag = element.tagName.toLowerCase();
  const signature = `${tag} ${element.attribs?.class ?? ""}`.toLowerCase();
  if (/^(h1|h2|h3|h4|p|li|td|th|small|span|strong|em|b|i|code|button|a)$/.test(tag)) return true;
  if (tag !== "div") return false;
  if (isFooterContainerWithStructure(element)) return false;
  if (hasDirectText(element) && /(?:^|\s)(?:text-block|title|card-title|item-title|feature-title|number|number-huge|label|data-label|desc|card-desc|item-desc|feature-desc|kicker|pill|tag|card-tag|badge|caption|quote|footer|meta|mono|chip|cta|stat|callout|lead|lede|subtitle|prepared|author|presenter|contact|affiliation|code|status|system|sync|terminal|console|button|btn|action|command|value|metric|readout|data-readout)(?:\s|$)/.test(signature)) {
    return true;
  }
  if (isLeafTextElement(element) && (hasInlineStyle(element) || isResidueLikeText(normalizeText(textOf(element))))) {
    return true;
  }
  return false;
}

function textOf(element: Element): string {
  return (element.children ?? [])
    .map((child) => {
      if (child.type === "text") return "data" in child ? String(child.data) : "";
      if ((child as Element).tagName) return textOf(child as Element);
      return "";
    })
    .join("");
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function isPageNumberElement(element: Element) {
  const attrs = element.attribs ?? {};
  const classes = (attrs.class ?? "").split(/\s+/);
  return classes.includes("slide-number") || "data-current" in attrs || "data-total" in attrs || /^\d{1,3}\s*\/\s*\d{1,3}$/.test(normalizeText(textOf(element)));
}

function containsProtectedRuntimeElement(element: Element): boolean {
  if (isRuntimeProtectedElement(element)) return true;
  return (element.children ?? []).some((child) => {
    if (!(child as Element).tagName) return false;
    return containsProtectedRuntimeElement(child as Element);
  });
}

function isRuntimeProtectedElement(element: Element) {
  const attrs = element.attribs ?? {};
  const classes = (attrs.class ?? "").split(/\s+/);
  return classes.includes("slide-number")
    || classes.includes("progress-bar")
    || "data-current" in attrs
    || "data-total" in attrs;
}

function isFooterContainerWithStructure(element: Element) {
  if (element.tagName.toLowerCase() !== "div") return false;
  const className = element.attribs?.class ?? "";
  if (!/(?:footer|footer-bar|page-foot)/i.test(className)) return false;
  return (element.children ?? []).some((child) => (child as Element).tagName);
}

function isExemptVisibleText(element: Element, text: string) {
  const className = element.attribs?.class ?? "";
  if (/(?:^|\s)(?:card-icon|decorative-icon|visual-icon|icon-mark)(?:\s|$)/i.test(className)) return true;
  if (element.attribs?.["aria-hidden"] === "true") return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\s]+$/u.test(text)) return true;
  if (/^[\p{Symbol}\s]+$/u.test(text)) return true;
  if (/^[•·—–\-+*/\\|()[\]{}<>=_:;,.!?，。！？、\s]+$/.test(text)) return true;
  return false;
}

function hasDirectText(element: Element) {
  return (element.children ?? []).some((child) => child.type === "text" && normalizeText("data" in child ? String(child.data) : "").length > 0);
}

function isLeafTextElement(element: Element) {
  return !(element.children ?? []).some((child) => Boolean((child as Element).tagName));
}

function hasInlineStyle(element: Element) {
  return typeof element.attribs?.style === "string" && element.attribs.style.trim().length > 0;
}

function isResidueLikeText(text: string) {
  return /(?:\bSYSTEM(?:_|\b)|GITHUB|PGP|0x[0-9a-f]|CONNECT@|WWW\.|\bSTATUS(?:_|\b)|COMPLETE|REBOOT|SYNC|READY|UNLOCKED|FAILED|@[^@\s]+\.[a-z]{2,})/i.test(text);
}

function inferAnchorKind(slotId: string, element: Element): SlotAnchorKind {
  const normalizedSlotId = slotId.toLowerCase();
  if (normalizedSlotId === "title" || /title/.test(normalizedSlotId)) return "title";
  if (/subtitle/.test(normalizedSlotId)) return "subtitle";
  if (/kicker|eyebrow/.test(normalizedSlotId)) return "kicker";
  if (/card-\d+-heading|heading/.test(normalizedSlotId)) return "cardHeading";
  if (/card-\d+-body/.test(normalizedSlotId)) return "cardBody";
  if (/footer/.test(normalizedSlotId)) return "footer";
  if (/meta|badge/.test(normalizedSlotId)) return "badge";
  if (/section-label|label/.test(normalizedSlotId)) return "statLabel";

  const tag = element.tagName.toLowerCase();
  const signature = `${element.tagName} ${element.attribs?.class ?? ""}`.toLowerCase();
  if (/^h1$/.test(tag)) return "title";
  if (/^h[2-4]$/.test(tag)) return signature.includes("card") ? "cardHeading" : "title";
  if (tag === "li") return "listItem";
  if (tag === "td" || tag === "th") return "tableCell";
  if (tag === "code") return "codeLine";
  if (/number|metric|value|amount|percent|readout|data-readout/.test(signature)) return "statNumber";
  if (/label|data-label|desc/.test(signature)) return "statLabel";
  if (/kicker|eyebrow/.test(signature)) return "kicker";
  if (/pill|tag|badge|meta|chip|mono/.test(signature)) return "badge";
  if (/footer|page-foot/.test(signature)) return "footer";
  if (/caption/.test(signature)) return "caption";
  if (/quote/.test(signature)) return "quote";
  if (/cta|button/.test(signature)) return "cta";
  if (/audio|video|media|play/.test(signature)) return "mediaLabel";
  if (tag === "strong" || tag === "b") return "body";
  return "body";
}

function slotPrefixForKind(kind: SlotAnchorKind) {
  const map: Record<SlotAnchorKind, string> = {
    title: "title",
    subtitle: "subtitle",
    kicker: "kicker",
    body: "body",
    cardHeading: "card-heading",
    cardBody: "card-body",
    listItem: "list-item",
    statNumber: "stat-number",
    statLabel: "stat-label",
    tableCell: "table-cell",
    quote: "quote",
    caption: "caption",
    footer: "footer-label",
    badge: "meta-badge",
    cta: "cta",
    codeLine: "code-line",
    mediaLabel: "media-label"
  };
  return map[kind];
}

function maxCharsForKind(kind: SlotAnchorKind, sourceText: string) {
  const caps: Record<SlotAnchorKind, { min: number; max: number }> = {
    title: { min: 40, max: 80 },
    subtitle: { min: 60, max: 160 },
    kicker: { min: 24, max: 48 },
    body: { min: 80, max: 260 },
    cardHeading: { min: 20, max: 48 },
    cardBody: { min: 80, max: 220 },
    listItem: { min: 36, max: 100 },
    statNumber: { min: 8, max: 24 },
    statLabel: { min: 20, max: 56 },
    tableCell: { min: 24, max: 120 },
    quote: { min: 60, max: 180 },
    caption: { min: 30, max: 100 },
    footer: { min: 24, max: 64 },
    badge: { min: 16, max: 40 },
    cta: { min: 16, max: 60 },
    codeLine: { min: 40, max: 140 },
    mediaLabel: { min: 20, max: 80 }
  };
  const range = caps[kind];
  return Math.max(range.min, Math.min(range.max, sourceText.length + Math.ceil(sourceText.length * 0.2) + 8));
}

function seedSlotCounters(anchors: SlotAnchor[]) {
  const counters = new Map<string, number>();
  for (const anchor of anchors) {
    const match = anchor.slotId.match(/^(.+)-(\d+)$/);
    if (!match) continue;
    counters.set(match[1]!, Math.max(counters.get(match[1]!) ?? 0, Number(match[2])));
  }
  return counters;
}

function markSubtreeCovered(element: Element, covered: Set<Element>) {
  covered.add(element);
  for (const child of element.children ?? []) {
    if ((child as Element).tagName) markSubtreeCovered(child as Element, covered);
  }
}

function candidatePriority(element: Element) {
  const kind = inferAnchorKind("", element);
  const order: SlotAnchorKind[] = [
    "title",
    "subtitle",
    "kicker",
    "cardHeading",
    "cardBody",
    "body",
    "listItem",
    "statNumber",
    "statLabel",
    "tableCell",
    "quote",
    "caption",
    "badge",
    "footer",
    "cta",
    "codeLine",
    "mediaLabel"
  ];
  return order.indexOf(kind);
}

function depth(element: Element) {
  let count = 0;
  let current = element.parent as Element | null;
  while (current) {
    count++;
    current = current.parent as Element | null;
  }
  return count;
}

function findAnchorTarget(anchor: SlotAnchor, section: Element) {
  const existing = selectAll(anchor.selector, section as unknown as ChildNode) as Element[];
  if (existing.length === 1) return existing[0]!;

  if (anchor.slotId === "title") {
    return (selectOne("h2.h2", section as unknown as ChildNode) ?? selectOne("h1.h1", section as unknown as ChildNode)) as Element | null;
  }
  if (anchor.slotId === "kicker") {
    return selectOne(".kicker", section as unknown as ChildNode) as Element | null;
  }
  if (anchor.slotId === "footer") {
    return selectOne(".footer span:first-child", section as unknown as ChildNode) as Element | null;
  }
  if (anchor.slotId === "subtitle") {
    return selectOne("p", section as unknown as ChildNode) as Element | null;
  }

  const cardMatch = anchor.slotId.match(/^card-(\d+)-(heading|body)$/);
  if (cardMatch) {
    const cardIndex = Number(cardMatch[1]) - 1;
    const kind = cardMatch[2];
    const cards = selectAll(".card", section as unknown as ChildNode) as Element[];
    const card = cards[cardIndex];
    if (!card) return null;
    return selectOne(kind === "heading" ? "h3" : "p", card as unknown as ChildNode) as Element | null;
  }

  return existing[0] ?? null;
}

function buildUniqueSelector(target: Element, root: Element) {
  const parts: string[] = [];
  let current: Element | null = target;

  while (current && current !== root) {
    const parent = current.parent as Element | null;
    if (!parent) return null;
    const tag = current.tagName.toLowerCase();
    const className = primaryClass(current);
    const siblings = (parent.children ?? []).filter(
      (child): child is Element => (child as Element).tagName !== undefined && (child as Element).tagName === current!.tagName
    );
    const sameTagIndex = siblings.indexOf(current) + 1;
    const nth = siblings.length > 1 ? `:nth-of-type(${sameTagIndex})` : "";
    parts.unshift(`${tag}${className ? `.${className}` : ""}${nth}`);
    current = parent === root ? null : parent;
  }

  const selector = parts.join(" > ");
  const matches = selectAll(selector, root as unknown as ChildNode);
  return matches.length === 1 ? selector : null;
}

function primaryClass(element: Element) {
  const classes = (element.attribs?.class ?? "").split(/\s+/).filter(Boolean);
  return classes[0] ?? null;
}

function extractSections(indexHtml: string) {
  return [...indexHtml.matchAll(/<section\b(?=[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'])[\s\S]*?<\/section>/gi)].map((match) => match[0]);
}

function extractLocalCssFiles(indexHtml: string) {
  return [...indexHtml.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => normalizeLocalAssetPath(match[1]!))
    .filter((href): href is string => typeof href === "string")
    .filter((href) => href.endsWith(".css"));
}

function extractLocalJsFiles(indexHtml: string) {
  return [...indexHtml.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => normalizeLocalAssetPath(match[1]!))
    .filter((src): src is string => typeof src === "string")
    .filter((src) => src.endsWith(".js"));
}

function normalizeLocalAssetPath(value: string) {
  if (/^(https?:)?\/\//i.test(value)) return null;
  return value.replace(/^\.\//, "");
}

function stripAttribute(attrs: string, name: string) {
  const pattern = new RegExp(`\\s${name}=(["']).*?\\1`, "gi");
  return attrs.replace(pattern, "");
}

async function listTemplateIds() {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((templateId) =>
      existsSync(join(TEMPLATES_ROOT, templateId, "manifest-v2.json"))
    )
    .sort();
}

async function readTemplateCss(templateDir: string, cssFiles: string[]) {
  const chunks = await Promise.all(cssFiles.map((cssFile) => readFile(join(templateDir, cssFile), "utf8").catch(() => "")));
  return chunks.join("\n");
}

function fragmentIdForSourceSlide(slideIndex: number) {
  return `slide-${String(slideIndex).padStart(2, "0")}`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal: ${formatError(error)}`);
    process.exit(1);
  });
}
