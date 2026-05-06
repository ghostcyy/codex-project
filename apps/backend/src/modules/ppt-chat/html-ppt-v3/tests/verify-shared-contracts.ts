import {
  buildAvailablePool,
  chartDataIRSchema,
  contentIRSchema,
  generateRequestSchema,
  normalizeGenerateRequest,
  planIRSchema,
  templateManifestV2Schema,
  validateContentIR,
  validatePlanIR
} from "../shared";

const request = generateRequestSchema.parse({
  theme: "AI驱动的个性化学习路径设计",
  pageCount: 5,
  wordBudget: 1200,
  templateId: "01-tech-web3",
  includeImages: false,
  includeVideo: false
});

const legacyRequest = normalizeGenerateRequest({
  theme: "AI驱动的个性化学习路径设计",
  pageCount: 5,
  wordBudget: 1200,
  templateId: "01-tech-web3",
  includeImages: false,
  includeVideo: false
});

if (legacyRequest.includeChart !== false || legacyRequest.includeAudio !== false) {
  throw new Error("normalizeGenerateRequest should default missing includeChart/includeAudio to false.");
}

const manifest = templateManifestV2Schema.parse({
  schemaVersion: 2,
  id: "01-tech-web3",
  deckClass: "tpl-tech-web3",
  label: { "zh-CN": "技术 Web3", en: "Tech Web3" },
  description: { "zh-CN": "技术主题模板", en: "Technical deck template" },
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
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 60 },
        { slotId: "subtitle", selector: ".subtitle", maxChars: 120, optional: true }
      ]
    },
    closing: {
      fragmentId: "closing",
      pageType: "closing",
      sourceSlideIndex: 7,
      sourceSlideTitle: "Closing",
      htmlFile: "fragments/closing.html",
      pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [{ slotId: "title", selector: ".title", maxChars: 60 }]
    }
  },
  pool: {
    "slide-02": {
      fragmentId: "slide-02",
      pageType: "grid-2",
      sourcePageType: "grid-2",
      sourceSlideIndex: 2,
      sourceSlideTitle: "Grid",
      htmlFile: "fragments/slide-02.html",
      pagePortrait: buildPortrait("双栏网格页", "grid", "grid:1x2 x1 + card x2"),
      topicSlots: 2,
      topicSlotMaxChars: 120,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 60 },
        { slotId: "card-1-heading", selector: ".card:nth-child(1) h3", maxChars: 24 },
        { slotId: "card-1-body", selector: ".card:nth-child(1) p", maxChars: 120 },
        { slotId: "card-2-heading", selector: ".card:nth-child(2) h3", maxChars: 24 },
        { slotId: "card-2-body", selector: ".card:nth-child(2) p", maxChars: 120 }
      ]
    },
    "slide-03": {
      fragmentId: "slide-03",
      pageType: "chart",
      sourcePageType: "chart",
      sourceSlideIndex: 3,
      sourceSlideTitle: "Chart",
      htmlFile: "fragments/slide-03.html",
      pagePortrait: buildPortrait("趋势图表页", "chart", "chart:line x1"),
      topicSlots: 1,
      topicSlotMaxChars: 120,
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 60 },
        { slotId: "body", selector: ".copy", maxChars: 140 }
      ],
      chartCanvasSelector: "canvas[data-chart-slot='primary']",
      chartSlots: [{ slotId: "primary", selector: "canvas[data-chart-slot='primary']", kind: "line", defaultRenderType: "line", componentId: "chart-1" }],
      mediaKinds: ["chart"],
      imageSlotSelectors: []
    },
    "slide-04": {
      fragmentId: "slide-04",
      pageType: "image-full",
      sourcePageType: "image-full",
      sourceSlideIndex: 4,
      sourceSlideTitle: "Image",
      htmlFile: "fragments/slide-04.html",
      pagePortrait: buildPortrait("图片页", "media", "image x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [{ slotId: "title", selector: ".title", maxChars: 60 }],
      mediaKinds: ["image"],
      imageSlotSelectors: ["img"]
    },
    "slide-05": {
      fragmentId: "slide-05",
      pageType: "video",
      sourcePageType: "video",
      sourceSlideIndex: 5,
      sourceSlideTitle: "Video",
      htmlFile: "fragments/slide-05.html",
      pagePortrait: buildPortrait("视频页", "media", "video x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [{ slotId: "title", selector: ".title", maxChars: 60 }],
      mediaKinds: ["video"],
      imageSlotSelectors: [],
      videoSlotSelector: "video"
    },
    "slide-06": {
      fragmentId: "slide-06",
      pageType: "audio",
      sourcePageType: "audio",
      sourceSlideIndex: 6,
      sourceSlideTitle: "Audio",
      htmlFile: "fragments/slide-06.html",
      pagePortrait: buildPortrait("音频页", "media", "audio x1"),
      topicSlots: 1,
      topicSlotMaxChars: 80,
      anchors: [{ slotId: "title", selector: ".title", maxChars: 60 }],
      mediaKinds: ["audio"],
      imageSlotSelectors: []
    }
  },
  capabilities: {
    chartTypes: ["line", "bar"],
    hasImagePages: true,
    hasVideoPages: true,
    hasAudioPages: true
  }
});

const pool = buildAvailablePool(manifest, request);

if (pool.middle["slide-04"] || pool.middle["slide-05"] || pool.middle["slide-06"] || pool.middle["slide-03"]) {
  throw new Error("AvailablePool should hard-filter image/video/chart/audio for the selected request.");
}

if (!pool.middle["slide-02"] || pool.middle["slide-02"].pageType !== "grid-2") {
  throw new Error("AvailablePool should preserve non-media fragments by fragmentId.");
}

if (pool.chartTypesAvailable.length !== 0) {
  throw new Error("AvailablePool should hide chartTypesAvailable when includeChart=false.");
}

const chartRequest = generateRequestSchema.parse({
  ...request,
  includeChart: true
});
const chartPool = buildAvailablePool(manifest, chartRequest);
if (!chartPool.middle["slide-03"] || chartPool.chartTypesAvailable.length !== 2) {
  throw new Error("AvailablePool should expose chart and chart types only when includeChart=true.");
}

const audioRequest = generateRequestSchema.parse({
  ...request,
  includeAudio: true
});
const audioPool = buildAvailablePool(manifest, audioRequest);
if (!audioPool.middle["slide-06"]) {
  throw new Error("AvailablePool should expose audio only when includeAudio=true and the manifest has audio.");
}

const plan = planIRSchema.parse({
  templateId: request.templateId,
  totalChars: request.wordBudget,
  pageCount: request.pageCount,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "AI学习路径", topicPoints: ["主题引入"], charBudget: 180 },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "学习画像", topicPoints: ["能力诊断", "目标拆解"], charBudget: 260 },
    { slideIndex: 3, fragmentId: "slide-03", pageType: "chart", slideTitle: "效果趋势", topicPoints: ["路径优化"], chartType: "line", charBudget: 260 },
    { slideIndex: 4, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "落地流程", topicPoints: ["内容适配", "反馈闭环"], charBudget: 260 },
    { slideIndex: 5, pageType: "closing", slideTitle: "持续进化", topicPoints: ["总结"], charBudget: 180 }
  ]
});

const planResult = validatePlanIR(plan, chartRequest, chartPool);
if (!planResult.ok) {
  throw new Error(`PlanIR should validate: ${planResult.reasons.join("; ")}`);
}

const missingFragmentPlan = planIRSchema.parse({
  ...plan,
  slides: plan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, fragmentId: undefined } : slide)
});
const missingFragmentPlanResult = validatePlanIR(missingFragmentPlan, chartRequest, chartPool);
if (missingFragmentPlanResult.ok) {
  throw new Error("PlanIR should reject middle slides without fragmentId.");
}

const badPlan = planIRSchema.parse({
  ...plan,
  slides: plan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, fragmentId: "slide-04", pageType: "image-full" } : slide)
});
const badPlanResult = validatePlanIR(badPlan, request, pool);
if (badPlanResult.ok) {
  throw new Error("PlanIR should reject filtered image page types.");
}

const badChartPlanResult = validatePlanIR(plan, request, pool);
if (badChartPlanResult.ok) {
  throw new Error("PlanIR should reject chart page types when includeChart=false.");
}

chartDataIRSchema.parse({
  type: "line",
  labels: ["诊断", "推荐", "反馈"],
  datasets: [{ label: "完成率", data: [42, 68, 81] }]
});

const content = contentIRSchema.parse({
  templateId: request.templateId,
  slides: [
    { slideIndex: 1, pageType: "cover", slotFills: { title: "AI学习路径", subtitle: "从诊断到反馈的闭环" } },
    {
      slideIndex: 2,
      fragmentId: "slide-02",
      pageType: "grid-2",
      slotFills: {
        title: "学习画像",
        "card-1-heading": "能力诊断",
        "card-1-body": "识别当前水平与薄弱环节。",
        "card-2-heading": "目标拆解",
        "card-2-body": "把长期目标拆成可执行路径。"
      }
    },
    {
      slideIndex: 3,
      fragmentId: "slide-03",
      pageType: "chart",
      slotFills: { title: "效果趋势", body: "路径推荐随反馈持续优化。" },
      chartDataBySlot: {
        primary: { type: "line", labels: ["一周", "两周"], datasets: [{ label: "达成率", data: [52, 76] }] }
      }
    },
    {
      slideIndex: 4,
      fragmentId: "slide-02",
      pageType: "grid-2",
      slotFills: {
        title: "落地流程",
        "card-1-heading": "内容适配",
        "card-1-body": "根据画像匹配材料。",
        "card-2-heading": "反馈闭环",
        "card-2-body": "用练习结果修正路径。"
      }
    },
    { slideIndex: 5, pageType: "closing", slotFills: { title: "持续进化" } }
  ]
});

const contentResult = validateContentIR(content, plan, manifest);
if (!contentResult.ok) {
  throw new Error(`ContentIR should validate: ${contentResult.reasons.join("; ")}`);
}

const promptLikeContent = contentIRSchema.parse({
  ...content,
  slides: content.slides.map((slide) => slide.slideIndex === 2
    ? {
        ...slide,
        slotFills: {
          ...slide.slotFills,
          title: "制作一个16页HTML 报告",
          "card-1-body": "开展面向中高层管理者的AI认知培训，建立统一认识。",
          "card-2-body": "标准应涵盖效率提升、成本降低、风险控制和满意度评分。"
        }
      }
    : slide)
});
const promptLikeContentResult = validateContentIR(promptLikeContent, plan, manifest);
if (!promptLikeContentResult.ok) {
  throw new Error(`ContentIR should not reject prompt-like or management-facing business text: ${promptLikeContentResult.reasons.join("; ")}`);
}

console.log("HTML-PPT v3 shared contracts verification passed.");

function buildPortrait(summary: string, layoutFamily: string, componentSignature: string) {
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
