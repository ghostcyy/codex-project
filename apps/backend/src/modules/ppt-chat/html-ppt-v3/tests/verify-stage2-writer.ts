import { z } from "zod";
import { runStage2Writer } from "../stages/stage2-writer";
import { buildStage2WriterPrompt } from "../prompts/stage2-writer.prompt";
import {
  type ContentIR,
  type PagePortrait,
  type PlanIR,
  type TemplateManifestV2,
  validateContentIR
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

const manifest: TemplateManifestV2 = {
  schemaVersion: 2,
  id: "mock-template",
  deckClass: "tpl-mock-template",
  label: { "zh-CN": "测试模板", en: "Mock Template" },
  description: { "zh-CN": "用于 Stage 2 验证", en: "Stage 2 verification" },
  shellHtmlFile: "shell.html",
  cssFiles: ["style.css"],
  jsFiles: [],
  assetDirs: ["assets", "img"],
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
      imageSlotSelectors: [],
      chartSlots: [],
      anchors: [
        { slotId: "title", selector: ".title", tarChars: 6, maxChars: 12, optional: false },
        { slotId: "subtitle", selector: ".subtitle", tarChars: 9, maxChars: 18, optional: true }
      ]
    },
    closing: {
      fragmentId: "closing",
      pageType: "closing",
      sourceSlideIndex: 5,
      sourceSlideTitle: "Closing",
      htmlFile: "fragments/closing.html",
      pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
      mediaKinds: [],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      imageSlotSelectors: [],
      chartSlots: [],
      anchors: [{ slotId: "title", selector: ".title", tarChars: 5, maxChars: 10, optional: false }]
    }
  },
  pool: {
    "slide-02": {
      fragmentId: "slide-02",
      pageType: "grid-2",
      sourcePageType: "grid-2",
      sourceSlideIndex: 2,
      sourceSlideTitle: "Grid Variant",
      htmlFile: "fragments/slide-02.html",
      pagePortrait: buildPortrait("双栏网格页", "grid", "grid:1x2 x1 + card x2"),
      mediaKinds: [],
      topicSlots: 2,
      topicSlotMaxChars: 80,
      imageSlotSelectors: [],
      chartSlots: [],
      anchors: [
        { slotId: "title", selector: ".title", tarChars: 5, maxChars: 10, optional: false, kind: "title", sourceText: "Legacy Title" },
        { slotId: "card-1-body", selector: ".card-1", tarChars: 16, maxChars: 32, optional: false, kind: "cardBody", sourceText: "Legacy body 1" },
        { slotId: "card-2-body", selector: ".card-2", tarChars: 16, maxChars: 32, optional: false, kind: "cardBody", sourceText: "Legacy body 2" }
      ]
    },
    "slide-03": {
      fragmentId: "slide-03",
      pageType: "chart",
      sourcePageType: "grid-2",
      sourceSlideIndex: 3,
      sourceSlideTitle: "Multi Chart Variant",
      htmlFile: "fragments/slide-03.html",
      pagePortrait: buildPortrait("复合图表页，包含两个图表槽", "mixed", "chart:line x1 + chart:bar x1 + grid:1x2 x1"),
      mediaKinds: ["chart"],
      topicSlots: 1,
      topicSlotMaxChars: 100,
      imageSlotSelectors: [],
      anchors: [
        { slotId: "title", selector: ".title", tarChars: 5, maxChars: 10, optional: false },
        { slotId: "body", selector: ".body", tarChars: 28, maxChars: 56, optional: false }
      ],
      chartCanvasSelector: "canvas[data-chart-slot='primary']",
      chartSlots: [
        { slotId: "primary", selector: "canvas[data-chart-slot='primary']", kind: "line", defaultRenderType: "line", componentId: "chart-1" },
        { slotId: "chart-2", selector: "canvas[data-chart-slot='chart-2']", kind: "bar", defaultRenderType: "bar", componentId: "chart-2" }
      ]
    },
    "slide-04": {
      fragmentId: "slide-04",
      pageType: "image-text",
      sourcePageType: "image-text",
      sourceSlideIndex: 4,
      sourceSlideTitle: "Image Variant",
      htmlFile: "fragments/slide-04.html",
      pagePortrait: buildPortrait("图文页，包含一个图片槽", "media", "image x1 + text x2"),
      mediaKinds: ["image"],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      imageSlotSelectors: ["img[data-image-slot='primary']"],
      chartSlots: [],
      anchors: [
        { slotId: "title", selector: ".title", tarChars: 5, maxChars: 10, optional: false, kind: "title", sourceText: "Legacy Image Title" },
        { slotId: "body", selector: ".body", tarChars: 20, maxChars: 40, optional: false, kind: "body", sourceText: "Legacy image body" }
      ]
    }
  },
  capabilities: {
    chartTypes: ["line", "bar"],
    hasImagePages: false,
    hasVideoPages: false,
    hasAudioPages: false
  }
};

const plan: PlanIR = {
  templateId: "mock-template",
  totalChars: 1200,
  pageCount: 5,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "AI城市韧性", topicPoints: ["主题"], charBudget: 220 },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "风险画像", topicPoints: ["数据", "研判"], charBudget: 260 },
    { slideIndex: 3, fragmentId: "slide-03", pageType: "chart", slideTitle: "响应效率", topicPoints: ["效率"], chartType: "line", charBudget: 260 },
    { slideIndex: 4, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "治理闭环", topicPoints: ["预警", "复盘"], charBudget: 260 },
    { slideIndex: 5, pageType: "closing", slideTitle: "行动总结", topicPoints: ["总结"], charBudget: 200 }
  ]
};

const modelContent: ContentIR = {
  templateId: "mock-template",
  slides: [
    { slideIndex: 1, pageType: "cover", slotFills: { title: "AI城市韧性治理超长标题", subtitle: "数据协同与应急响应能力提升" } },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "grid-2", slotFills: { title: "风险画像超长", "card-1-body": "数据汇聚形成画像", "card-2-body": "动态研判支持响应" } },
    {
      slideIndex: 3,
      fragmentId: "slide-03",
      pageType: "chart",
      slotFills: { title: "响应效率提升", body: "协同机制压缩响应时间" },
      chartDataBySlot: {
        primary: {
          type: "line",
          labels: ["一月", "二月", "三月"],
          datasets: [{ label: "响应指数", data: [42, 63, 81] }]
        },
        "chart-2": {
          type: "bar",
          labels: ["协同", "处置", "复盘"],
          datasets: [{ label: "成熟度", data: [55, 72, 86] }]
        }
      }
    },
    { slideIndex: 4, fragmentId: "slide-02", pageType: "grid-2", slotFills: { title: "治理闭环超长", "card-1-body": "预警触发任务派发", "card-2-body": "复盘优化规则库" } },
    { slideIndex: 5, pageType: "closing", slotFills: { title: "面向韧性未来" } }
  ]
};

const stage2CallStages: Array<string | undefined> = [];
const fakeLlm: HtmlPptV3LLMClient = {
  async callStructured<T extends z.ZodTypeAny>(args: { schema: T; stage?: string }): Promise<z.infer<T>> {
    stage2CallStages.push(args.stage);
    const missingRequiredSlot = {
      ...modelContent,
      slides: modelContent.slides.map((slide) => slide.slideIndex === 2
        ? {
            ...slide,
            slotFills: {
              title: "风险画像",
              "card-1-body": "数据汇聚形成画像"
            }
          }
        : slide)
    };
    const missingSlotParse = args.schema.safeParse(missingRequiredSlot);
    if (missingSlotParse.success) {
      throw new Error("Stage 2 structured schema should reject model output missing required anchor slot keys.");
    }
    return args.schema.parse(modelContent);
  }
};

const driftedModelContent = modelContent.slides.map((slide) => ({
  ...slide,
  fragmentId: "wrong-fragment",
  pageType: "closing"
}));
const driftedLlm: HtmlPptV3LLMClient = {
  async callStructured<T extends z.ZodTypeAny>(args: { schema: T; stage?: string }): Promise<z.infer<T>> {
    stage2CallStages.push(args.stage);
    return args.schema.parse({ content: { slides: driftedModelContent } });
  }
};

const noChartPlan: PlanIR = {
  ...plan,
  slides: plan.slides.map((slide) => slide.slideIndex === 3
    ? { slideIndex: 3, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "响应效率", topicPoints: ["效率", "协同"], charBudget: 260 }
    : slide)
};
const noChartPrompt = buildStage2WriterPrompt({ plan: noChartPlan, manifest });
const noChartPayload = JSON.parse(noChartPrompt.userPrompt) as {
  templateId?: string;
  pageCount?: number;
  totalChars?: number;
  plan?: unknown;
  slideSpecs: Array<{
    fragmentId?: string;
    pageType: string;
    requiresChartData?: boolean;
    chartSlots?: unknown[];
    anchors: Array<{ slotId: string; kind: string; tarChars?: number; maxChars: number }>;
  }>;
  allowedPageTypes: string[];
  allowedChartTypes: string[];
};
if (
  noChartPayload.allowedPageTypes.includes("chart") ||
  noChartPayload.slideSpecs.some((spec) => spec.pageType === "chart" || spec.fragmentId === "slide-03" || spec.requiresChartData) ||
  noChartPayload.slideSpecs.some((spec) => spec.pageType !== "cover" && spec.pageType !== "closing" && (!spec.fragmentId || !Array.isArray(spec.chartSlots))) ||
  noChartPayload.allowedChartTypes.length ||
  noChartPrompt.userPrompt.includes("canvas[data-chart-slot") ||
  noChartPrompt.userPrompt.includes("\"chartCanvasSelector\"")
) {
  throw new Error("Stage 2 prompt should not expose chart specs when the validated plan has no chart slides.");
}
if (noChartPayload.plan || noChartPayload.templateId !== "mock-template" || noChartPayload.pageCount !== noChartPlan.pageCount || noChartPayload.totalChars !== noChartPlan.totalChars) {
  throw new Error("Stage 2 prompt should expose only minimal global plan fields, not the full PlanIR.");
}
const forbiddenStage2PromptFields = [
  "\"plan\"",
  "\"charBudget\"",
  "\"mediaKinds\"",
  "\"contentTarget\"",
  "\"pagePortrait\"",
  "\"pageTarChars\"",
  "\"fillRatio\""
];
const leakedStage2PromptField = forbiddenStage2PromptFields.find((field) => noChartPrompt.userPrompt.includes(field));
if (leakedStage2PromptField) {
  throw new Error(`Stage 2 user prompt should not expose ${leakedStage2PromptField}.`);
}
if (noChartPrompt.userPrompt.includes("Legacy body") || noChartPrompt.userPrompt.includes("\"selector\"")) {
  throw new Error("Stage 2 prompt must not expose template sourceText or selector internals.");
}
if (!noChartPrompt.userPrompt.includes("\"kind\": \"cardBody\"")) {
  throw new Error("Stage 2 prompt should expose anchor kind so the model writes the right text shape.");
}
const targetSlide = noChartPayload.slideSpecs.find((spec) => spec.fragmentId === "slide-02");
if (!targetSlide) {
  throw new Error("Stage 2 prompt should expose selected middle slide specs.");
}
const bodyAnchor = targetSlide.anchors.find((anchor) => anchor.slotId === "card-1-body");
const titleAnchor = targetSlide.anchors.find((anchor) => anchor.slotId === "title");
if (bodyAnchor?.tarChars !== 32) {
  throw new Error(`Stage 2 body anchors should scale tarChars up to maxChars when wordBudget exceeds selected tar capacity; got ${bodyAnchor?.tarChars ?? "missing"}.`);
}
if (titleAnchor && "tarChars" in titleAnchor) {
  throw new Error(`Stage 2 should not expose tarChars for non-body anchors; got title tarChars=${titleAnchor.tarChars}.`);
}
if (!noChartPrompt.systemPrompt.includes("tarChars 是硬指标") || noChartPrompt.systemPrompt.includes("pageTarChars")) {
  throw new Error("Stage 2 prompt should explicitly tell the model that tarChars is a hard target without pageTarChars.");
}
if (!noChartPrompt.systemPrompt.includes("注意！！！\n注意！！！\n注意！！！\n\n")) {
  throw new Error("Stage 2 prompt should put the tarChars hard-target warning in a prominent multi-line block.");
}
if (!noChartPrompt.systemPrompt.includes("所有带 tarChars 的正文类 slot 必须超过 anchors[].tarChars；除非 maxChars 更小；同时绝不能超过 maxChars")) {
  throw new Error("Stage 2 prompt should use the required tarChars hard-target wording.");
}
if (noChartPrompt.systemPrompt.includes("全量合并后 slides 数量必须等于 pageCount")) {
  throw new Error("Stage 2 batch prompt should not tell the model to return full-deck slides for each batch.");
}
if (!noChartPrompt.systemPrompt.includes("本批 slides 数量必须等于 batchSlideCount")) {
  throw new Error("Stage 2 prompt should emphasize the batch slide count, not the full deck page count.");
}
if (!noChartPrompt.systemPrompt.includes("imageHints 是 slide 顶层字段，禁止写入 slotFills") || !noChartPrompt.systemPrompt.includes("slotFills 只能包含 anchors[].slotId")) {
  throw new Error("Stage 2 prompt should explicitly separate imageHints from slotFills.");
}
if (noChartPrompt.systemPrompt.includes("videoHint") || noChartPrompt.userPrompt.includes("videoHint") || noChartPrompt.userPrompt.includes("requiresVideoHint")) {
  throw new Error("Stage 2 prompt should not expose videoHint fields or instructions when the batch has no video slides.");
}
if (!/必须返回 templateId 和 slides/.test(noChartPrompt.systemPrompt) || !/禁止改 fragmentId、pageType/.test(noChartPrompt.systemPrompt)) {
  throw new Error("Stage 2 prompt should explicitly lock ContentIR top-level shape and slide identity fields.");
}
const serializedBodyAnchor = noChartPrompt.userPrompt.match(/\{\n\s+"slotId": "card-1-body",[\s\S]*?\n\s+\}/)?.[0] ?? "";
if (!serializedBodyAnchor || serializedBodyAnchor.indexOf("\"tarChars\"") > serializedBodyAnchor.indexOf("\"maxChars\"")) {
  throw new Error("Stage 2 body anchor JSON should place tarChars before maxChars.");
}
if (/字数质检|必须通过字数/.test(noChartPrompt.systemPrompt)) {
  throw new Error("Stage 2 prompt must not introduce a separate word-count QA gate.");
}

const shrinkManifest = JSON.parse(JSON.stringify(manifest)) as TemplateManifestV2;
shrinkManifest.fixed.cover.anchors = [
  { slotId: "title", selector: ".title", tarChars: 2500, maxChars: 5000, optional: false, kind: "title" },
  { slotId: "body", selector: ".body", tarChars: 5000, maxChars: 10000, optional: false, kind: "body" }
];
shrinkManifest.fixed.closing.anchors = [
  { slotId: "title", selector: ".title", tarChars: 3000, maxChars: 6000, optional: false, kind: "title" },
  { slotId: "caption", selector: ".caption", tarChars: 1000, maxChars: 2000, optional: false, kind: "caption" }
];
const shrinkPlan: PlanIR = {
  templateId: "mock-template",
  totalChars: 3600,
  pageCount: 2,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "容量测试", topicPoints: ["主题"], charBudget: 1800 },
    { slideIndex: 2, pageType: "closing", slideTitle: "总结", topicPoints: ["收束"], charBudget: 1800 }
  ]
};
const shrinkPrompt = buildStage2WriterPrompt({ plan: shrinkPlan, manifest: shrinkManifest });
const shrinkPayload = JSON.parse(shrinkPrompt.userPrompt) as {
  slideSpecs: Array<{
    anchors: Array<{ slotId: string; tarChars?: number }>;
  }>;
};
const shrinkCover = shrinkPayload.slideSpecs[0];
if (!shrinkCover) {
  throw new Error("Stage 2 shrink prompt should include cover slide spec.");
}
const shrinkBody = shrinkCover.anchors.find((anchor) => anchor.slotId === "body");
const shrinkTitle = shrinkCover.anchors.find((anchor) => anchor.slotId === "title");
const shrinkCaption = shrinkPayload.slideSpecs[1]?.anchors.find((anchor) => anchor.slotId === "caption");
if (shrinkBody?.tarChars !== 3000 || shrinkCaption?.tarChars !== 600) {
  throw new Error(`Stage 2 should scale only body-like tarChars by 3600/6000=0.6; got body=${shrinkBody?.tarChars}, caption=${shrinkCaption?.tarChars}.`);
}
if (shrinkTitle && "tarChars" in shrinkTitle) {
  throw new Error(`Stage 2 should not expose tarChars for title anchors; got title=${shrinkTitle.tarChars}.`);
}

const equalPrompt = buildStage2WriterPrompt({ plan: { ...shrinkPlan, totalChars: 6000 }, manifest: shrinkManifest });
const equalPayload = JSON.parse(equalPrompt.userPrompt) as typeof shrinkPayload;
const equalCover = equalPayload.slideSpecs[0];
if (!equalCover) {
  throw new Error("Stage 2 equal-budget prompt should include cover slide spec.");
}
if (equalCover.anchors.find((anchor) => anchor.slotId === "body")?.tarChars !== 5000 || equalPayload.slideSpecs[1]?.anchors.find((anchor) => anchor.slotId === "caption")?.tarChars !== 1000) {
  throw new Error("Stage 2 should preserve original body-like tarChars when wordBudget equals selected body-like tar capacity.");
}
if ("tarChars" in (equalCover.anchors.find((anchor) => anchor.slotId === "title") ?? {})) {
  throw new Error("Stage 2 should not expose title tarChars in equal-budget prompts.");
}

const expansionPrompt = buildStage2WriterPrompt({ plan: { ...shrinkPlan, totalChars: 18000 }, manifest: shrinkManifest });
const expansionPayload = JSON.parse(expansionPrompt.userPrompt) as typeof shrinkPayload;
const expansionCover = expansionPayload.slideSpecs[0];
if (!expansionCover) {
  throw new Error("Stage 2 expansion prompt should include cover slide spec.");
}
if (expansionCover.anchors.find((anchor) => anchor.slotId === "body")?.tarChars !== 10000 || expansionPayload.slideSpecs[1]?.anchors.find((anchor) => anchor.slotId === "caption")?.tarChars !== 2000) {
  throw new Error("Stage 2 should cap expanded body-like tarChars at each anchor maxChars.");
}

const emptyManifest = JSON.parse(JSON.stringify(manifest)) as TemplateManifestV2;
emptyManifest.fixed.cover.anchors = [];
emptyManifest.fixed.closing.anchors = [];
const emptyPrompt = buildStage2WriterPrompt({ plan: shrinkPlan, manifest: emptyManifest });
const emptyPayload = JSON.parse(emptyPrompt.userPrompt) as typeof shrinkPayload;
if (emptyPayload.slideSpecs.some((spec) => spec.anchors.length !== 0)) {
  throw new Error("Stage 2 should handle selectedTarCharsTotal=0 without exposing page targets or throwing.");
}

const videoManifest = JSON.parse(JSON.stringify(manifest)) as TemplateManifestV2;
videoManifest.pool["slide-video"] = {
  fragmentId: "slide-video",
  pageType: "video",
  sourcePageType: "video",
  sourceSlideIndex: 6,
  sourceSlideTitle: "Video Variant",
  htmlFile: "fragments/slide-video.html",
  pagePortrait: buildPortrait("视频页", "media", "video x1 + text x1"),
  mediaKinds: ["video"],
  topicSlots: 1,
  topicSlotMaxChars: 80,
  imageSlotSelectors: [],
  videoSlotSelector: "video[data-video-slot='primary']",
  chartSlots: [],
  anchors: [
    { slotId: "title", selector: ".title", tarChars: 5, maxChars: 10, optional: false, kind: "title" },
    { slotId: "body", selector: ".body", tarChars: 20, maxChars: 40, optional: false, kind: "body" }
  ]
};
const videoPlan: PlanIR = {
  templateId: "mock-template",
  totalChars: 900,
  pageCount: 3,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "视频测试封面", topicPoints: ["总览"], charBudget: 180 },
    { slideIndex: 2, fragmentId: "slide-video", pageType: "video", slideTitle: "视频演示", topicPoints: ["演示"], charBudget: 360 },
    { slideIndex: 3, pageType: "closing", slideTitle: "视频测试收尾", topicPoints: ["总结"], charBudget: 180 }
  ]
};
const videoPrompt = buildStage2WriterPrompt({ plan: videoPlan, manifest: videoManifest });
const videoPayload = JSON.parse(videoPrompt.userPrompt) as {
  slideSpecs: Array<{ slideIndex: number; requiresVideoHint?: boolean }>;
};
if (!videoPrompt.systemPrompt.includes("videoHint") || !videoPayload.slideSpecs.some((spec) => spec.slideIndex === 2 && spec.requiresVideoHint === true)) {
  throw new Error("Stage 2 prompt should expose videoHint instructions only when a batch includes a video slide.");
}
if (videoPayload.slideSpecs.some((spec) => spec.slideIndex !== 2 && "requiresVideoHint" in spec)) {
  throw new Error("Stage 2 prompt should expose requiresVideoHint only on actual video slides.");
}

const missingFragmentPlan: PlanIR = {
  ...plan,
  slides: plan.slides.map((slide) => slide.slideIndex === 2
    ? { slideIndex: 2, pageType: "grid-2", slideTitle: "风险画像", topicPoints: ["数据", "研判"], charBudget: 260 }
    : slide)
};
const missingFragmentValidation = validateContentIR(modelContent, missingFragmentPlan, manifest);
if (missingFragmentValidation.ok) {
  throw new Error("Stage 2 ContentIR validation should reject middle slides whose PlanIR is missing fragmentId.");
}

const chartSlideContent = modelContent.slides.find((slide) => slide.slideIndex === 3);
const primaryChartData = chartSlideContent?.chartDataBySlot?.primary;
if (!primaryChartData) {
  throw new Error("Stage 2 test fixture must include primary chart data.");
}
const missingSlotContent: ContentIR = {
  ...modelContent,
  slides: modelContent.slides.map((slide) => slide.slideIndex === 3
    ? {
        ...slide,
        chartDataBySlot: {
          primary: primaryChartData
        }
      }
    : slide)
};
const missingSlotValidation = validateContentIR(missingSlotContent, plan, manifest);
if (missingSlotValidation.ok) {
  throw new Error("Stage 2 ContentIR validation should reject multi-chart slides missing any chartDataBySlot entry.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const result = await runStage2Writer({ plan, manifest, llm: fakeLlm });

  if (result.source !== "model") throw new Error("Stage 2 should prefer valid model output.");
  if (stage2CallStages.some((stage) => stage !== "v3-stage2-writer")) {
    throw new Error(`Stage 2 LLM calls should be tagged v3-stage2-writer, got ${stage2CallStages.join(", ")}.`);
  }
  if (stage2CallStages.length !== 1) {
    throw new Error(`Stage 2 should use one batch for 5 slides with batch size 7; got ${stage2CallStages.length} calls.`);
  }
  if (result.content.slides.length !== plan.pageCount) throw new Error("Stage 2 should preserve plan page count.");

  const validation = validateContentIR(result.content, plan, manifest);
  if (!validation.ok) throw new Error(`Stage 2 ContentIR should validate after maxChars clamping: ${validation.reasons.join("; ")}`);

  const coverTitle = result.content.slides[0]?.slotFills.title ?? "";
  if (coverTitle.length !== 12) throw new Error(`Stage 2 should clamp cover title to maxChars=12; got ${coverTitle.length}.`);

  const chartDataBySlot = result.content.slides.find((slide) => slide.pageType === "chart")?.chartDataBySlot;
  if (!chartDataBySlot?.primary || !chartDataBySlot["chart-2"]) throw new Error("Stage 2 multi-chart slide should include chartDataBySlot for every chart slot.");
  if (chartDataBySlot.primary.type !== "line" || chartDataBySlot["chart-2"].type !== "bar") {
    throw new Error("Stage 2 chartDataBySlot types should match slot render types.");
  }
  for (const chart of Object.values(chartDataBySlot)) {
    if (chart.datasets.some((dataset) => dataset.data.length !== chart.labels.length)) {
      throw new Error("Stage 2 chart dataset lengths should match labels length.");
    }
  }

  const normalized = await runStage2Writer({ plan, manifest, llm: driftedLlm });
  if (normalized.source !== "model") {
    throw new Error(`Stage 2 should normalize model shape/identity drift without falling back; got ${normalized.source}.`);
  }
  const normalizedValidation = validateContentIR(normalized.content, plan, manifest);
  if (!normalizedValidation.ok) {
    throw new Error(`Stage 2 normalized model content should validate: ${normalizedValidation.reasons.join("; ")}`);
  }
  const normalizedMiddle = normalized.content.slides.find((slide) => slide.slideIndex === 2);
  if (normalizedMiddle?.fragmentId !== "slide-02" || normalizedMiddle.pageType !== "grid-2") {
    throw new Error(`Stage 2 should restore slide identity from PlanIR; got ${JSON.stringify(normalizedMiddle)}.`);
  }

  await verifyBatchedConcurrentStage2();
  await verifyImageHintsFieldPlacementNormalization();

  console.log("HTML-PPT v3 Stage 2 writer verification passed.");
}

async function verifyImageHintsFieldPlacementNormalization() {
  const imagePlan: PlanIR = {
    templateId: "mock-template",
    totalChars: 900,
    pageCount: 3,
    slides: [
      { slideIndex: 1, pageType: "cover", slideTitle: "图像测试封面", topicPoints: ["总览"], charBudget: 180 },
      { slideIndex: 2, fragmentId: "slide-04", pageType: "image-text", slideTitle: "图像场景", topicPoints: ["视觉"], charBudget: 360 },
      { slideIndex: 3, pageType: "closing", slideTitle: "图像测试收尾", topicPoints: ["总结"], charBudget: 180 }
    ]
  };
  const imageHintMisplacedLlm: HtmlPptV3LLMClient = {
    async callStructured<T extends z.ZodTypeAny>(args: { schema: T }): Promise<z.infer<T>> {
      return args.schema.parse({
        templateId: imagePlan.templateId,
        slides: [
          { slideIndex: 1, pageType: "cover", slotFills: { title: "图像测试封面", subtitle: "视觉生成链路" } },
          {
            slideIndex: 2,
            fragmentId: "slide-04",
            pageType: "image-text",
            videoHint: null,
            slotFills: {
              title: "图像场景",
              body: "通过主题化画面呈现核心业务场景。",
              imageHints: [
                { slotId: "primary", prompt: "智慧城市数据中枢的蓝色科技插画" },
                "管理者查看实时仪表盘"
              ]
            }
          },
          { slideIndex: 3, pageType: "closing", videoHint: "不应保留的视频提示", slotFills: { title: "形成视觉闭环" } }
        ]
      });
    }
  };

  const result = await runStage2Writer({ plan: imagePlan, manifest, llm: imageHintMisplacedLlm });
  if (result.source !== "model") {
    throw new Error(`Stage 2 should normalize misplaced imageHints instead of falling back; got ${result.source}: ${result.validationErrors.join("; ")}`);
  }
  const imageSlide = result.content.slides.find((slide) => slide.slideIndex === 2);
  if (!imageSlide?.imageHints?.length || imageSlide.slotFills.imageHints) {
    throw new Error(`Stage 2 should move slotFills.imageHints to top-level imageHints; got ${JSON.stringify(imageSlide)}`);
  }
  if (!imageSlide.imageHints.some((hint) => hint.includes("智慧城市数据中枢"))) {
    throw new Error(`Stage 2 should preserve object prompt text when normalizing imageHints; got ${imageSlide.imageHints.join(" | ")}`);
  }
  if ("videoHint" in imageSlide || result.content.slides.some((slide) => "videoHint" in slide)) {
    throw new Error(`Stage 2 should drop null or unexpected videoHint fields when the plan has no video slides: ${JSON.stringify(result.content.slides)}`);
  }
}

async function verifyBatchedConcurrentStage2() {
  const longPlan = buildLongPlan(22);
  const callRecords: Array<{
    userPrompt: string;
    stage?: string;
    startedBeforeFirstAwait: boolean;
  }> = [];
  let firstAwaitReached = false;
  const batchedLlm: HtmlPptV3LLMClient = {
    async callStructured<T extends z.ZodTypeAny>(args: { schema: T; stage?: string; userPrompt: string }): Promise<z.infer<T>> {
      const payload = JSON.parse(args.userPrompt) as {
        batchSlideIndexes?: number[];
        batchSlideCount?: number;
        deckOutline?: Array<{ slideIndex: number }>;
        slideSpecs?: Array<{ slideIndex: number }>;
      };
      callRecords.push({
        userPrompt: args.userPrompt,
        stage: args.stage,
        startedBeforeFirstAwait: !firstAwaitReached
      });
      await Promise.resolve();
      firstAwaitReached = true;
      const batchSlides = (payload.slideSpecs ?? []).map((spec) => {
        const planSlide = longPlan.slides.find((slide) => slide.slideIndex === spec.slideIndex);
        if (!planSlide) throw new Error(`Missing plan slide ${spec.slideIndex}`);
        const fragment = planSlide.pageType === "cover"
          ? manifest.fixed.cover
          : planSlide.pageType === "closing"
            ? manifest.fixed.closing
            : manifest.pool[planSlide.fragmentId ?? ""];
        return {
          slideIndex: planSlide.slideIndex,
          fragmentId: planSlide.fragmentId,
          pageType: planSlide.pageType,
          slotFills: Object.fromEntries((fragment?.anchors ?? []).map((anchor) => [anchor.slotId, `${planSlide.slideTitle}-${anchor.slotId}`.slice(0, anchor.maxChars)])),
          chartDataBySlot: fragment?.chartSlots?.length
            ? Object.fromEntries(fragment.chartSlots.map((slot) => [
                slot.slotId,
                {
                  type: slot.defaultRenderType,
                  labels: ["一", "二"],
                  datasets: [{ label: `${planSlide.slideTitle}-${slot.slotId}`, data: [1, 2] }]
                }
              ]))
            : undefined
        };
      });
      return args.schema.parse({
        templateId: longPlan.templateId,
        slides: batchSlides
      });
    }
  };

  const result = await runStage2Writer({ plan: longPlan, manifest, llm: batchedLlm });
  if (result.source !== "model") {
    throw new Error(`Batched Stage 2 should return model output; got ${result.source}: ${result.validationErrors.join("; ")}`);
  }
  if (callRecords.length !== 4) {
    throw new Error(`22 slides should be split into 4 concurrent Stage 2 batches of 7; got ${callRecords.length}.`);
  }
  if (!callRecords.every((record) => record.startedBeforeFirstAwait)) {
    throw new Error("Stage 2 batches should be started concurrently before awaiting earlier batch responses.");
  }
  const batchRanges = callRecords.map((record) => (JSON.parse(record.userPrompt) as { batchSlideIndexes: number[] }).batchSlideIndexes.join("-"));
  if (batchRanges.join("|") !== "1-2-3-4-5-6-7|8-9-10-11-12-13-14|15-16-17-18-19-20-21|22") {
    throw new Error(`Unexpected Stage 2 batch ranges: ${batchRanges.join("|")}`);
  }
  for (const record of callRecords) {
    const payload = JSON.parse(record.userPrompt) as {
      deckOutline?: unknown[];
      slideSpecs?: unknown[];
      batchSlideCount?: number;
      batchSlideIndexes?: number[];
    };
    if (!Array.isArray(payload.deckOutline) || payload.deckOutline.length !== longPlan.pageCount) {
      throw new Error("Each Stage 2 batch prompt should include the full compact deckOutline.");
    }
    if (!Array.isArray(payload.slideSpecs) || payload.slideSpecs.length !== payload.batchSlideCount) {
      throw new Error("Each Stage 2 batch prompt should include only its own slideSpecs.");
    }
    if (record.stage !== "v3-stage2-writer") {
      throw new Error(`Batched Stage 2 calls should preserve stage tag; got ${record.stage ?? "undefined"}.`);
    }
  }
  if (result.content.slides.map((slide) => slide.slideIndex).join(",") !== longPlan.slides.map((slide) => slide.slideIndex).join(",")) {
    throw new Error("Merged Stage 2 ContentIR should preserve full slide order after concurrent batch results.");
  }
  const validation = validateContentIR(result.content, longPlan, manifest);
  if (!validation.ok) {
    throw new Error(`Merged Stage 2 ContentIR should validate: ${validation.reasons.join("; ")}`);
  }
}

function buildLongPlan(pageCount: number): PlanIR {
  const slides: PlanIR["slides"] = [];
  for (let index = 1; index <= pageCount; index++) {
    if (index === 1) {
      slides.push({ slideIndex: index, pageType: "cover", slideTitle: "长篇测试封面", topicPoints: ["总览"], charBudget: 120 });
    } else if (index === pageCount) {
      slides.push({ slideIndex: index, pageType: "closing", slideTitle: "长篇测试收束", topicPoints: ["行动"], charBudget: 120 });
    } else if (index % 5 === 0) {
      slides.push({ slideIndex: index, fragmentId: "slide-03", pageType: "chart", slideTitle: `图表页${index}`, topicPoints: ["趋势"], chartType: "line", charBudget: 160 });
    } else {
      slides.push({ slideIndex: index, fragmentId: "slide-02", pageType: "grid-2", slideTitle: `正文页${index}`, topicPoints: ["要点一", "要点二"], charBudget: 160 });
    }
  }
  return {
    templateId: "mock-template",
    totalChars: 3600,
    pageCount,
    slides
  };
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
