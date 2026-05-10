import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import type { Element, AnyNode } from "domhandler";
import { runStage3Injector } from "../stages/stage3-injector";
import { generatedImageKey, type ContentIR, type PagePortrait, type PlanIR, type TemplateManifestV2 } from "../shared";

const fixtureRoot = join(tmpdir(), "html-ppt-v3-stage3-injector");
const templateDir = join(fixtureRoot, "template");
const workdir = join(fixtureRoot, "workdir");

rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(join(templateDir, "fragments"), { recursive: true });
mkdirSync(join(templateDir, "assets"), { recursive: true });
mkdirSync(join(templateDir, "img"), { recursive: true });
writeFileSync(join(templateDir, "img", "learning-path-01.jpg"), "fake image");
writeFileSync(join(templateDir, "img", "_placeholder.jpg"), "placeholder");
mkdirSync(join(fixtureRoot, "external-generated"), { recursive: true });
const generatedImagePath = join(fixtureRoot, "external-generated", "slide-03-slot-01.png");
writeFileSync(generatedImagePath, "generated image");
writeFileSync(join(templateDir, "fragments", "deck-effects.html"), "<canvas id=\"fixture-particles\"></canvas>");
writeFileSync(join(templateDir, "assets", "deck-effects.js"), "window.__fixtureDeckEffects = true;");
writeFileSync(join(templateDir, "style.css"), ".deck{display:block}");
writeFileSync(
  join(templateDir, "shell.html"),
  [
    "<!DOCTYPE html>",
    "<html><head><title>Fixture</title><link rel=\"stylesheet\" href=\"style.css\"></head>",
    "<body class=\"tpl-fixture\"><main class=\"deck\"><!-- SLIDES --></main><!-- CHART_INITS --></body></html>"
  ].join("")
);
writeFileSync(
  join(templateDir, "fragments", "cover.html"),
  "<section class=\"slide\" data-page-type=\"cover\"><h1 class=\"title\">{{title}}</h1><p class=\"subtitle\"></p></section>"
);
writeFileSync(
  join(templateDir, "fragments", "chart.html"),
  "<section class=\"slide\" data-page-type=\"chart\"><h2 class=\"title\"></h2><p class=\"copy\"></p><div class=\"chart-wrap\"><canvas data-chart-slot=\"primary\"></canvas><canvas data-chart-slot=\"chart-2\"></canvas></div><footer><span class=\"meta-badge\">MATERIAL_DATA // 2026</span><span class=\"slide-number\" data-current=\"6\" data-total=\"20\">06 / 20</span></footer></section>"
);
writeFileSync(
  join(templateDir, "fragments", "image-full.html"),
  "<section class=\"slide\" data-page-type=\"image-full\"><h2 class=\"title\"></h2><img data-image-slot=\"0\"><p class=\"caption\"></p></section>"
);
writeFileSync(
  join(templateDir, "fragments", "closing.html"),
  "<section class=\"slide\" data-page-type=\"closing\"><h2 class=\"title\"></h2></section>"
);

const manifest: TemplateManifestV2 = {
  schemaVersion: 2,
  id: "fixture-template",
  deckClass: "tpl-fixture",
  label: { "zh-CN": "Fixture", en: "Fixture" },
  description: { "zh-CN": "Fixture", en: "Fixture" },
  shellHtmlFile: "shell.html",
  cssFiles: ["style.css"],
  jsFiles: [],
  assetDirs: ["img"],
  deckEffects: {
    htmlFile: "fragments/deck-effects.html",
    jsFile: "assets/deck-effects.js",
    elementIds: ["fixture-particles"]
  },
  fixed: {
    cover: {
      fragmentId: "cover",
      pageType: "cover",
      sourceSlideIndex: 1,
      sourceSlideTitle: "Cover",
      htmlFile: "fragments/cover.html",
      pagePortrait: buildPortrait("封面页", "cover", "text x1"),
      mediaKinds: [],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 40, optional: false },
        { slotId: "subtitle", selector: ".subtitle", maxChars: 80, optional: false }
      ],
      imageSlotSelectors: [],
      chartSlots: []
    },
    closing: {
      fragmentId: "closing",
      pageType: "closing",
      sourceSlideIndex: 4,
      sourceSlideTitle: "Closing",
      htmlFile: "fragments/closing.html",
      pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
      mediaKinds: [],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [{ slotId: "title", selector: ".title", maxChars: 40, optional: false }],
      imageSlotSelectors: [],
      chartSlots: []
    }
  },
  pool: {
    "slide-02": {
      fragmentId: "slide-02",
      pageType: "chart",
      sourcePageType: "chart",
      sourceSlideIndex: 2,
      sourceSlideTitle: "Chart",
      htmlFile: "fragments/chart.html",
      pagePortrait: buildPortrait("双图表页", "mixed", "chart:line x1 + chart:bar x1"),
      mediaKinds: ["chart"],
      topicSlots: 1,
      topicSlotMaxChars: 120,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 40, optional: false },
        { slotId: "body", selector: ".copy", maxChars: 80, optional: false },
        { slotId: "meta-badge-1", selector: ".meta-badge", maxChars: 24, optional: false }
      ],
      chartCanvasSelector: "canvas[data-chart-slot='primary']",
      chartSlots: [
        { slotId: "primary", selector: "canvas[data-chart-slot='primary']", kind: "line", defaultRenderType: "line", componentId: "chart-1" },
        { slotId: "chart-2", selector: "canvas[data-chart-slot='chart-2']", kind: "bar", defaultRenderType: "bar", componentId: "chart-2" }
      ],
      imageSlotSelectors: []
    },
    "slide-03": {
      fragmentId: "slide-03",
      pageType: "image-full",
      sourcePageType: "image-full",
      sourceSlideIndex: 3,
      sourceSlideTitle: "Image",
      htmlFile: "fragments/image-full.html",
      pagePortrait: buildPortrait("图片页", "media", "image x1"),
      mediaKinds: ["image"],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 40, optional: false },
        { slotId: "image-1-caption", selector: ".caption", maxChars: 80, optional: false }
      ],
      imageSlotSelectors: ["img[data-image-slot='0']"],
      chartSlots: []
    }
  },
  capabilities: {
    chartTypes: ["line", "bar", "pie", "gantt"],
    hasImagePages: true,
    hasVideoPages: false,
    hasAudioPages: false
  }
} as TemplateManifestV2 & {
  deckEffects: { htmlFile: string; jsFile: string; elementIds: string[] };
};

const plan: PlanIR = {
  templateId: manifest.id,
  totalChars: 1000,
  pageCount: 4,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "Cover", topicPoints: ["intro"], charBudget: 200 },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "chart", slideTitle: "Chart", topicPoints: ["trend"], chartType: "line", charBudget: 300 },
    { slideIndex: 3, fragmentId: "slide-03", pageType: "image-full", slideTitle: "Image", topicPoints: ["visual"], charBudget: 300 },
    { slideIndex: 4, pageType: "closing", slideTitle: "Close", topicPoints: ["end"], charBudget: 200 }
  ]
};

const content: ContentIR = {
  templateId: manifest.id,
  slides: [
    {
      slideIndex: 1,
      pageType: "cover",
      slotFills: { title: "AI学习路径", subtitle: "个性化|STRONG| 学习闭环" }
    },
    {
      slideIndex: 2,
      fragmentId: "slide-02",
      pageType: "chart",
      slotFills: { title: "效果趋势", body: "达成率|STRONG| 持续提升" },
      chartDataBySlot: {
        primary: { type: "line", labels: ["一月", "二月"], datasets: [{ label: "达成率", data: [42, 76] }] },
        "chart-2": { type: "bar", labels: ["诊断", "反馈"], datasets: [{ label: "闭环率", data: [58, 83] }] }
      }
    },
    {
      slideIndex: 3,
      fragmentId: "slide-03",
      pageType: "image-full",
      slotFills: { title: "本地素材", "image-1-caption": "学习路径插图" },
      imageHints: ["learning path"]
    },
    { slideIndex: 4, pageType: "closing", slotFills: { title: "持续进化" } }
  ]
};

async function main() {
  const result = await runStage3Injector({
    manifest,
    plan,
    content,
    templateDir,
    workdir,
    jobId: "fixture-job",
    generatedImages: {
      [generatedImageKey(3, 0)]: {
        slideIndex: 3,
        slotIndex: 0,
        relativePath: "img/generated/slide-03-slot-01.png",
        absolutePath: generatedImagePath,
        prompt: "fixture prompt",
        source: "minimax"
      }
    },
    speakerNotes: {
      templateId: manifest.id,
      slides: [
        { slideIndex: 1, pageType: "cover", notes: ["先用开场说明 <script>alert(1)</script> 应被转义。"] },
        { slideIndex: 2, fragmentId: "slide-02", pageType: "chart", notes: ["效果趋势|STRONG| 是这一页讲解重点，执行动作|STRONG| 需要同步说明。", "提醒听众关注趋势背后的执行动作。"] },
        { slideIndex: 3, fragmentId: "slide-03", pageType: "image-full", notes: ["本页结合图片解释学习路径的实际体验。"] },
        { slideIndex: 4, pageType: "closing", notes: ["最后收束到持续迭代和后续行动。"] }
      ]
    }
  });

  if (!existsSync(result.indexHtmlPath)) {
    throw new Error("Stage3 should write index.html to the workdir.");
  }
  const unexpectedWarnings = result.warnings.filter((warning) => !warning.includes("meta-badge-1"));
  if (unexpectedWarnings.length > 0) {
    throw new Error(`Stage3 emitted unexpected warnings: ${unexpectedWarnings.join("; ")}`);
  }
  if (/{{[^}]+}}/.test(result.html)) {
    throw new Error("Stage3 output must not contain unresolved placeholders.");
  }

  const dom = parseDocument(result.html, { decodeEntities: false });
  const root = dom as unknown as AnyNode;
  const sections = selectAll("section.slide", root) as Element[];
  if (sections.length !== 4) {
    throw new Error(`Stage3 should stitch exactly 4 slides, got ${sections.length}.`);
  }
  if (!selectOne("p.subtitle strong", sections[0] as unknown as AnyNode)) {
    throw new Error("Strong parser should wrap text before |STRONG| in <strong>.");
  }
  if ((selectOne(".copy", sections[1] as unknown as AnyNode) as Element | null)?.children.length === 0) {
    throw new Error("Required chart body slot should be filled.");
  }
  const canvases = selectAll("canvas[data-chart-slot]", sections[1] as unknown as AnyNode) as Element[];
  if (canvases.length !== 2 || canvases.some((canvas) => !canvas.attribs.id)) {
    throw new Error("Every chart canvas slot should receive a deterministic id.");
  }
  const chartInitCount = (result.html.match(/new Chart/g) ?? []).length;
  if (chartInitCount !== 2 || canvases.some((canvas) => !canvas.attribs.id || !result.html.includes(canvas.attribs.id))) {
    throw new Error(`Every chart canvas should have a generated init script, got ${chartInitCount}.`);
  }
  const metaBadge = selectOne(".meta-badge", sections[1] as unknown as AnyNode) as Element | null;
  const metaBadgeText = flattenText(metaBadge);
  if (!metaBadgeText || metaBadgeText.includes("MATERIAL_DATA")) {
    throw new Error(`Decorative meta badge should be replaced with non-empty fallback content, got '${metaBadgeText}'.`);
  }
  if (/\/\/\s*\d{4}\b/.test(metaBadgeText)) {
    throw new Error(`Decorative meta badge should not include year-like suffixes that visually merge with slide numbers, got '${metaBadgeText}'.`);
  }
  const slideNumber = selectOne(".slide-number", sections[1] as unknown as AnyNode) as Element | null;
  const slideNumberText = flattenText(slideNumber);
  if (!slideNumber) {
    throw new Error("Slide number element should survive slot filling and post-stitch cleanup.");
  }
  if (slideNumber.attribs["data-current"] !== "2" || slideNumber.attribs["data-total"] !== "4") {
    throw new Error("Slide number should keep actual data-current/data-total attributes for CSS attr() rendering.");
  }
  if (sections[1]?.attribs["data-slide-index"] !== "2" || sections[1]?.attribs["data-slide-total"] !== "4") {
    throw new Error("Section attributes should carry the actual generated slide index and total.");
  }
  if (slideNumberText !== "") {
    throw new Error(`Slide number visible text should be empty to avoid duplicating CSS attr() output, got '${slideNumberText}'.`);
  }
  if (!result.html.includes("html-ppt-v3:navigate") || !result.html.includes("html-ppt-v3:state")) {
    throw new Error("Stage3 output should inject the deterministic in-deck navigation runtime.");
  }
  if (!result.html.includes("querySelectorAll(\"section.slide\")")) {
    throw new Error("Navigation runtime should collect section.slide elements.");
  }
  if (!result.html.includes("progress-bar") || !result.html.includes("updateProgress")) {
    throw new Error("Navigation runtime should create and update the deck progress bar.");
  }
  if (!result.html.includes("html-ppt-v3-presenter") || !result.html.includes("?preview=")) {
    throw new Error("Navigation runtime should include V3 presenter mode and preview iframe support.");
  }
  if (!result.html.includes('src="assets/edit-mode.js"') || !result.html.includes("data-html-ppt-v3-edit-mode")) {
    throw new Error("Stage3 output should load the reusable html-ppt edit-mode runtime.");
  }
  if (result.html.includes('"<script src="assets/edit-mode.js"')) {
    throw new Error("Edit-mode script tag should be injected into the final document, not into a presenter runtime string.");
  }
  if (result.html.includes('src="assets/runtime.js"')) {
    throw new Error("Stage3 output should not load the legacy html-ppt runtime.js because V3 owns navigation.");
  }
  if (!existsSync(join(workdir, "assets", "edit-mode.js"))) {
    throw new Error("Stage3 should publish assets/edit-mode.js so exported decks support E edit mode offline.");
  }
  if (!result.html.includes('id="fixture-particles"') || !result.html.includes("data-html-ppt-v3-deck-effects")) {
    throw new Error("Stage3 should preserve manifest-declared deck-level effect DOM and script.");
  }
  const notes = selectAll("aside.notes[data-html-ppt-v3-speaker-notes='true']", root) as Element[];
  if (notes.length !== 4) {
    throw new Error(`Stage3 should inject one V3 speaker notes aside per slide, got ${notes.length}.`);
  }
  if (!selectOne("aside.notes strong", sections[1] as unknown as AnyNode)) {
    throw new Error("Stage3 should parse |STRONG| markers inside speaker notes.");
  }
  if (result.html.includes("|STRONG|")) {
    throw new Error("Stage3 output must not leak raw |STRONG| markers into the exported HTML.");
  }
  if (result.html.includes("<script>alert(1)</script>")) {
    throw new Error("Stage3 speaker notes injection must escape model-provided HTML.");
  }
  if (flattenText(notes[1] ?? null).includes("MATERIAL_DATA")) {
    throw new Error("Stage3 speaker notes should be generated content, not template residue.");
  }
  const image = selectOne("img[data-image-slot='0']", sections[2] as unknown as AnyNode) as Element | null;
  if (image?.attribs.src !== "img/generated/slide-03-slot-01.png") {
    throw new Error(`Generated image should take priority over local image fallback, got '${image?.attribs.src ?? ""}'.`);
  }
  if (!existsSync(join(workdir, "img", "generated", "slide-03-slot-01.png"))) {
    throw new Error("Generated image file should be copied into the final workdir img/generated folder.");
  }

  const fallbackWorkdir = join(fixtureRoot, "fallback-workdir");
  const fallbackResult = await runStage3Injector({
    manifest,
    plan,
    content,
    templateDir,
    workdir: fallbackWorkdir,
    jobId: "fallback-fixture-job",
  });
  const fallbackDoc = parseDocument(fallbackResult.html, { decodeEntities: false });
  const fallbackRoot = fallbackDoc as unknown as AnyNode;
  const fallbackSections = selectAll("section.slide", fallbackRoot) as Element[];
  const fallbackImage = selectOne("img[data-image-slot='0']", fallbackSections[2] as unknown as AnyNode) as Element | null;
  if (fallbackImage?.attribs.src !== "img/generated/slide-03-slot-01.png") {
    throw new Error(`Fallback image slot should still use stable generated path, got '${fallbackImage?.attribs.src ?? ""}'.`);
  }
  if (fallbackResult.html.includes('src="img/learning-path-01.jpg"') || fallbackResult.html.includes('src="img/_placeholder.jpg"')) {
    throw new Error("Fallback image slots must not reference template image paths directly in HTML.");
  }
  const materializedFallbackPath = join(fallbackWorkdir, "img", "generated", "slide-03-slot-01.png");
  if (!existsSync(materializedFallbackPath)) {
    throw new Error("Fallback image should be materialized into img/generated with the stable slot filename.");
  }
  if (readFileSync(materializedFallbackPath, "utf8") !== "fake image") {
    throw new Error("Fallback generated image file should copy the matched template image content.");
  }
  if (!fallbackResult.warnings.some((warning) => warning.includes("fallback copied from img/learning-path-01.jpg"))) {
    throw new Error("Fallback materialization should report the copied template image source.");
  }

  const placeholderWorkdir = join(fixtureRoot, "placeholder-workdir");
  const placeholderContent: ContentIR = {
    ...content,
    slides: content.slides.map((slide) =>
      slide.slideIndex === 3
        ? { ...slide, imageHints: ["no matching local artwork"] }
        : slide,
    ),
  };
  const placeholderResult = await runStage3Injector({
    manifest,
    plan,
    content: placeholderContent,
    templateDir,
    workdir: placeholderWorkdir,
    jobId: "placeholder-fixture-job",
  });
  const materializedPlaceholderPath = join(placeholderWorkdir, "img", "generated", "slide-03-slot-01.png");
  if (!existsSync(materializedPlaceholderPath)) {
    throw new Error("Placeholder fallback should be materialized into img/generated with the stable slot filename.");
  }
  if (readFileSync(materializedPlaceholderPath, "utf8") !== "placeholder") {
    throw new Error("Unmatched fallback should copy the template placeholder content.");
  }
  if (!placeholderResult.warnings.some((warning) => warning.includes("fallback copied from img/_placeholder.jpg"))) {
    throw new Error("Placeholder materialization should report the placeholder source.");
  }

  const staleManifest = JSON.parse(JSON.stringify(manifest)) as TemplateManifestV2;
  staleManifest.pool["slide-02"]!.htmlFile = "fragments/grid-2.html";
  let staleRejected = false;
  try {
    await runStage3Injector({
      manifest: staleManifest,
      plan,
      content,
      templateDir,
      workdir: join(fixtureRoot, "stale-workdir"),
      jobId: "stale-fixture-job"
    });
  } catch (error) {
    staleRejected = error instanceof Error
      && error.message.includes("旧模板结构")
      && error.message.includes("fragments/grid-2.html");
  }
  if (!staleRejected) {
    throw new Error("Stage3 should reject stale fragment htmlFile before leaking an ENOENT error.");
  }

  console.log("HTML-PPT v3 stage3 injector verification passed.");
}

function flattenText(node: Element | null): string {
  if (!node) return "";
  return (node.children ?? [])
    .map((child) => {
      if (child.type === "text") return child.data;
      if ("children" in child) return flattenText(child as Element);
      return "";
    })
    .join("")
    .trim();
}

function buildPortrait(summary: string, layoutFamily: PagePortrait["layoutFamily"], componentSignature: string): PagePortrait {
  return {
    summary,
    layoutFamily,
    componentSignature,
    density: "medium",
    components: [],
    componentCounts: {},
    tags: [],
    useCases: []
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
