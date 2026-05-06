import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStage25ImageGeneration, type V3ImageGenerationClient } from "../stages/stage2_5-image-generation";
import type { ContentIR, GenerateRequest, PagePortrait, PlanIR, TemplateManifestV2 } from "../shared";

const request: GenerateRequest = {
  theme: "城市更新与绿色社区",
  pageCount: 4,
  wordBudget: 1200,
  templateId: "fixture-image-template",
  includeImages: true,
  includeVideo: false,
  includeChart: false,
  includeAudio: false,
};

const manifest: TemplateManifestV2 = {
  schemaVersion: 2,
  id: request.templateId,
  deckClass: "tpl-fixture",
  label: { "zh-CN": "城市杂志模板", en: "City Magazine" },
  description: { "zh-CN": "大图、数据卡片和杂志式标题", en: "Editorial image template" },
  shellHtmlFile: "shell.html",
  cssFiles: ["style.css"],
  jsFiles: [],
  assetDirs: ["img"],
  fixed: {
    cover: {
      fragmentId: "cover",
      pageType: "cover",
      sourceSlideIndex: 1,
      sourceSlideTitle: "Cover",
      htmlFile: "cover.html",
      pagePortrait: buildPortrait("封面页", "cover", "text x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [],
      chartSlots: [],
      imageSlotSelectors: [],
      mediaKinds: [],
    },
    closing: {
      fragmentId: "closing",
      pageType: "closing",
      sourceSlideIndex: 4,
      sourceSlideTitle: "Closing",
      htmlFile: "closing.html",
      pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [],
      chartSlots: [],
      imageSlotSelectors: [],
      mediaKinds: [],
    },
  },
  pool: {
    "slide-02": {
      fragmentId: "slide-02",
      pageType: "image-text",
      sourcePageType: "image-text",
      sourceSlideIndex: 2,
      sourceSlideTitle: "Image Text",
      htmlFile: "image-text.html",
      pagePortrait: buildPortrait("图文页", "media", "image x2 + text x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [],
      chartSlots: [],
      imageSlotSelectors: ["img[data-image-slot='0']", "img[data-image-slot='1']"],
      mediaKinds: ["image"],
    },
  },
  capabilities: { chartTypes: [], hasImagePages: true, hasVideoPages: false, hasAudioPages: false },
};

const plan: PlanIR = {
  templateId: request.templateId,
  totalChars: request.wordBudget,
  pageCount: request.pageCount,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "城市更新", topicPoints: ["intro"], charBudget: 200 },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "image-text", slideTitle: "口袋公园", topicPoints: ["绿地"], charBudget: 400 },
    { slideIndex: 3, fragmentId: "slide-02", pageType: "image-text", slideTitle: "公共步道", topicPoints: ["低碳出行"], charBudget: 400 },
    { slideIndex: 4, pageType: "closing", slideTitle: "行动建议", topicPoints: ["next"], charBudget: 200 },
  ],
};

const content: ContentIR = {
  templateId: request.templateId,
  slides: [
    { slideIndex: 1, pageType: "cover", slotFills: {} },
    {
      slideIndex: 2,
      fragmentId: "slide-02",
      pageType: "image-text",
      slotFills: { title: "口袋公园", body: "社区绿地带来更高的可达性。" },
      imageHints: ["pocket park", "community garden"],
    },
    {
      slideIndex: 3,
      fragmentId: "slide-02",
      pageType: "image-text",
      slotFills: { title: "公共步道", body: "慢行网络连接生活圈。" },
      imageHints: ["public walkway", "cycling path"],
    },
    { slideIndex: 4, pageType: "closing", slotFills: {} },
  ],
};

async function main() {
  await verifyProviderMissing();
  await verifyProviderSuccess();
  await verifyProviderFailure();
  await verifyCap();
  await verifyImagesDisabled();
  console.log("HTML-PPT v3 stage2.5 image generation verification passed.");
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

async function verifyProviderMissing() {
  const result = await runStage25ImageGeneration({
    request,
    plan,
    content,
    manifest,
    workdir: makeWorkdir("missing"),
  });
  assertEqual(result.requestedCount, 4, "provider missing should still count requested image slots");
  assertEqual(result.generatedCount, 0, "provider missing should not generate images");
  assert(result.warnings.some((warning) => warning.includes("MiniMax image client is unavailable")), "provider missing should warn");
}

async function verifyProviderSuccess() {
  const result = await runStage25ImageGeneration({
    request,
    plan,
    content,
    manifest,
    workdir: makeWorkdir("success"),
    imageClient: fakeClient("success"),
  });
  assertEqual(result.generatedCount, 4, "successful provider should generate one image per slot");
  assertEqual(result.generatedImages["2:0"]?.relativePath, "img/generated/generated-1.png", "generated image map should key by slide and slot");
  assert(result.generatedImages["2:0"]?.prompt.includes("口袋公园"), "image prompt should include slide context");
}

async function verifyProviderFailure() {
  const result = await runStage25ImageGeneration({
    request,
    plan,
    content,
    manifest,
    workdir: makeWorkdir("failure"),
    imageClient: fakeClient("failure"),
  });
  assertEqual(result.generatedCount, 0, "failed provider should not generate images");
  assertEqual(result.skippedCount, 4, "failed provider should skip all slots to fallback");
  assert(result.warnings.some((warning) => warning.includes("provider failed")), "failed provider should warn");
}

async function verifyCap() {
  const result = await runStage25ImageGeneration({
    request,
    plan,
    content,
    manifest,
    workdir: makeWorkdir("cap"),
    imageClient: fakeClient("success"),
    maxImages: 2,
  });
  assertEqual(result.generatedCount, 2, "cap should limit generated images");
  assertEqual(result.skippedCount, 2, "cap should skip remaining image slots");
  assert(result.warnings.some((warning) => warning.includes("max generated images is 2")), "cap skip should warn");
}

async function verifyImagesDisabled() {
  const result = await runStage25ImageGeneration({
    request: { ...request, includeImages: false },
    plan,
    content,
    manifest,
    workdir: makeWorkdir("disabled"),
    imageClient: fakeClient("success"),
  });
  assertEqual(result.requestedCount, 0, "includeImages=false should not request image generation");
  assertEqual(result.generatedCount, 0, "includeImages=false should not generate images");
}

function fakeClient(mode: "success" | "failure"): V3ImageGenerationClient {
  let count = 0;
  return {
    async generateImage() {
      count++;
      if (mode === "failure") return { relativePath: null, warnings: [`provider failed ${count}`] };
      return { relativePath: `img/generated/generated-${count}.png`, warnings: [] };
    },
  };
}

function makeWorkdir(name: string) {
  return join(tmpdir(), `html-ppt-v3-stage25-${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
