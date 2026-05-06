import { z } from "zod";
import { runStage0PoolBuild } from "../stages/stage0-pool-build";
import { runStage1Planner } from "../stages/stage1-planner";
import { buildStage1PlannerPrompt } from "../prompts/stage1-planner.prompt";
import {
  type GenerateRequest,
  type PagePortrait,
  type PlanIR,
  type TemplateManifestV2,
  validatePlanIR
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

const request: GenerateRequest = {
  theme: "AI驱动的城市韧性治理",
  pageCount: 5,
  wordBudget: 1200,
  templateId: "mock-template",
  includeImages: false,
  includeVideo: false,
  includeChart: true,
  includeAudio: false
};

const manifest = buildMockManifest();
const { pool } = runStage0PoolBuild({ request, manifest });

if (pool.middle["slide-04"] || pool.middle["slide-05"]) {
  throw new Error("Stage 0 should filter image/video page types before Stage 1 sees them.");
}
if (!pool.middle["slide-02"] || !pool.middle["slide-03"]) {
  throw new Error("Stage 0 should keep allowed non-media fragments by fragmentId.");
}

const chartDisabledRequest: GenerateRequest = { ...request, includeChart: false };
const { pool: chartDisabledPool } = runStage0PoolBuild({ request: chartDisabledRequest, manifest });
if (chartDisabledPool.middle["slide-03"] || chartDisabledPool.chartTypesAvailable.length !== 0) {
  throw new Error("Stage 0 should filter chart page types and chart types when includeChart=false.");
}
const chartDisabledPrompt = buildStage1PlannerPrompt({ request: chartDisabledRequest, pool: chartDisabledPool });
const chartDisabledPayload = JSON.parse(chartDisabledPrompt.userPrompt) as {
  allowedMiddleFragmentIds: string[];
  allowedMiddlePageTypes?: string[];
  availableMiddleFragments: Array<{ fragmentId: string; pageType: string; htmlFile: string; pagePortrait: unknown }>;
  allowedChartTypes: string[];
  chartTypesAvailable: string[];
};
if (
  !Array.isArray(chartDisabledPayload.allowedMiddleFragmentIds) ||
  !Array.isArray(chartDisabledPayload.availableMiddleFragments) ||
  chartDisabledPayload.allowedMiddleFragmentIds.includes("slide-03") ||
  chartDisabledPayload.availableMiddleFragments.some((entry) => entry.pageType === "chart" || entry.fragmentId === "slide-03" || !entry.pagePortrait || !entry.htmlFile?.startsWith("fragments/slide-")) ||
  "allowedMiddlePageTypes" in chartDisabledPayload ||
  chartDisabledPayload.allowedChartTypes.length ||
  chartDisabledPayload.chartTypesAvailable.length ||
  chartDisabledPrompt.systemPrompt.includes("chart canvas") ||
  /topicPoints 数量必须等于该 pageType/.test(chartDisabledPrompt.systemPrompt)
) {
  throw new Error("Stage 1 prompt should expose fragmentId/pagePortrait, hide chart fragments, and avoid pageType-only middle selection.");
}

try {
  runStage0PoolBuild({
    request: { ...request, includeChart: false, includeImages: false, includeVideo: false, includeAudio: false },
    manifest: buildMediaOnlyManifest()
  });
  throw new Error("Stage 0 should fail fast when all middle fragments are removed by media gating.");
} catch (err) {
  if (!(err instanceof Error) || !/no available middle fragments/i.test(err.message)) {
    throw err;
  }
}

const modelPlan: PlanIR = {
  templateId: request.templateId,
  totalChars: request.wordBudget,
  pageCount: request.pageCount,
  slides: [
    { slideIndex: 1, pageType: "cover", slideTitle: "AI城市韧性", topicPoints: ["主题引入"], charBudget: 220 },
    { slideIndex: 2, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "风险画像", topicPoints: ["数据汇聚", "动态研判"], charBudget: 260 },
    { slideIndex: 3, fragmentId: "slide-03", pageType: "chart", slideTitle: "响应效率", topicPoints: ["协同提升"], chartType: "bar", charBudget: 260 },
    { slideIndex: 4, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "治理闭环", topicPoints: ["预警触发", "复盘优化"], charBudget: 260 },
    { slideIndex: 5, pageType: "closing", slideTitle: "走向韧性城市", topicPoints: ["行动总结"], charBudget: 200 }
  ]
};

expectInvalidPlan(
  {
    ...modelPlan,
    slides: modelPlan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, fragmentId: undefined } : slide)
  },
  "missing fragmentId"
);
expectInvalidPlan(
  {
    ...modelPlan,
    slides: modelPlan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, fragmentId: "grid-2" } : slide)
  },
  "nonexistent fragmentId"
);
expectInvalidPlan(
  {
    ...modelPlan,
    slides: modelPlan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, pageType: "sidebar" } : slide)
  },
  "pageType mismatch"
);
expectInvalidPlan(
  {
    ...modelPlan,
    slides: modelPlan.slides.map((slide) => slide.slideIndex === 2 ? { ...slide, topicPoints: ["only one"] } : slide)
  },
  "topicPoints count mismatch"
);

const stage1CallStages: Array<string | undefined> = [];
const fakeLlm: HtmlPptV3LLMClient = {
  async callStructured<T extends z.ZodTypeAny>(args: { schema: T; stage?: string }): Promise<z.infer<T>> {
    stage1CallStages.push(args.stage);
    return args.schema.parse(modelPlan);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const result = await runStage1Planner({ request, pool, llm: fakeLlm });

  if (result.source !== "model") throw new Error("Stage 1 should prefer valid model output.");
  if (stage1CallStages[0] !== "v3-stage1-planner") {
    throw new Error(`Stage 1 LLM calls should be tagged v3-stage1-planner, got ${stage1CallStages[0] ?? "undefined"}.`);
  }
  if (result.plan.slides.length !== request.pageCount) throw new Error("Stage 1 should preserve requested page count.");
  if (result.plan.slides[0]?.pageType !== "cover") throw new Error("Stage 1 first slide should be cover.");
  if (result.plan.slides.at(-1)?.pageType !== "closing") throw new Error("Stage 1 last slide should be closing.");

  const validation = validatePlanIR(result.plan, request, pool);
  if (!validation.ok) throw new Error(`Stage 1 PlanIR should validate: ${validation.reasons.join("; ")}`);

  const chartSlide = result.plan.slides.find((slide) => slide.pageType === "chart");
  if (chartSlide?.fragmentId !== "slide-03") throw new Error("Stage 1 should preserve the selected fragmentId for chart variants.");
  if (chartSlide?.chartType !== "bar") throw new Error("Stage 1 should preserve chartType from valid model output.");

  await verifyStage1NormalizesModelStructuralDrift();

  console.log("HTML-PPT v3 Stage 1 planner verification passed.");
}

async function verifyStage1NormalizesModelStructuralDrift() {
  const driftedPlan: PlanIR = {
    templateId: request.templateId,
    totalChars: 6442,
    pageCount: request.pageCount,
    slides: [
      { slideIndex: 1, pageType: "cover", slideTitle: "AI城市韧性", topicPoints: ["主题引入"], charBudget: 1200 },
      { slideIndex: 2, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "风险画像", topicPoints: ["数据汇聚"], charBudget: 1200 },
      { slideIndex: 3, fragmentId: "slide-03", pageType: "chart", slideTitle: "响应效率", topicPoints: ["协同提升", "多余要点"], chartType: "bar", charBudget: 1200 },
      { slideIndex: 4, fragmentId: "slide-02", pageType: "grid-2", slideTitle: "治理闭环", topicPoints: ["预警触发", "复盘优化", "多余要点"], charBudget: 1200 },
      { slideIndex: 5, pageType: "closing", slideTitle: "走向韧性城市", topicPoints: ["行动总结"], charBudget: 1642 }
    ]
  };
  const driftLlm: HtmlPptV3LLMClient = {
    async callStructured<T extends z.ZodTypeAny>(args: { schema: T }): Promise<z.infer<T>> {
      return args.schema.parse(driftedPlan);
    }
  };
  const result = await runStage1Planner({ request, pool, llm: driftLlm });
  if (result.source !== "model") {
    throw new Error("Stage 1 should normalize structurally drifted model output instead of falling back.");
  }
  if (result.plan.totalChars !== request.wordBudget) {
    throw new Error("Stage 1 should normalize totalChars to request.wordBudget.");
  }
  const totalBudget = result.plan.slides.reduce((sum, slide) => sum + slide.charBudget, 0);
  if (totalBudget !== request.wordBudget) {
    throw new Error(`Stage 1 should normalize charBudget sum exactly to wordBudget; got ${totalBudget}.`);
  }
  const slide2 = result.plan.slides[1]!;
  const slide3 = result.plan.slides[2]!;
  const slide4 = result.plan.slides[3]!;
  if (slide2.topicPoints.length !== 2 || slide3.topicPoints.length !== 1 || slide4.topicPoints.length !== 2) {
    throw new Error("Stage 1 should normalize middle slide topicPoints length to selected fragment topicSlots.");
  }
  const validation = validatePlanIR(result.plan, request, pool);
  if (!validation.ok) {
    throw new Error(`Normalized model plan should validate: ${validation.reasons.join("; ")}`);
  }
}

function buildMockManifest(): TemplateManifestV2 {
  return {
    schemaVersion: 2,
    id: "mock-template",
    deckClass: "tpl-mock-template",
    label: { "zh-CN": "测试模板", en: "Mock Template" },
    description: { "zh-CN": "用于 Stage 1 验证", en: "Stage 1 verification" },
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
        anchors: [{ slotId: "title", selector: ".title", maxChars: 60, optional: false }]
      },
      closing: {
        fragmentId: "closing",
        pageType: "closing",
        sourceSlideIndex: 6,
        sourceSlideTitle: "Closing",
        htmlFile: "fragments/closing.html",
        pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
        mediaKinds: [],
        topicSlots: 1,
        topicSlotMaxChars: 80,
        imageSlotSelectors: [],
        chartSlots: [],
        anchors: [{ slotId: "title", selector: ".title", maxChars: 60, optional: false }]
      }
    },
    pool: {
      "slide-02": {
        fragmentId: "slide-02",
        pageType: "grid-2",
        sourcePageType: "grid-2",
        sourceSlideIndex: 2,
        sourceSlideTitle: "Risk Grid",
        htmlFile: "fragments/slide-02.html",
        pagePortrait: buildPortrait("双栏网格页，适合风险画像和对比说明", "grid", "grid:1x2 x1 + card x2"),
        mediaKinds: [],
        topicSlots: 2,
        topicSlotMaxChars: 120,
        imageSlotSelectors: [],
        chartSlots: [],
        anchors: [
          { slotId: "title", selector: ".title", maxChars: 60, optional: false },
          { slotId: "card-1-body", selector: ".card-1", maxChars: 90, optional: false },
          { slotId: "card-2-body", selector: ".card-2", maxChars: 90, optional: false }
        ]
      },
      "slide-03": {
        fragmentId: "slide-03",
        pageType: "chart",
        sourcePageType: "grid-2",
        sourceSlideIndex: 3,
        sourceSlideTitle: "Chart Variant",
        htmlFile: "fragments/slide-03.html",
        pagePortrait: buildPortrait("趋势图表页，左侧说明右侧图表", "mixed", "grid:1x2 x1 + chart:line x1"),
        mediaKinds: ["chart"],
        topicSlots: 1,
        topicSlotMaxChars: 100,
        imageSlotSelectors: [],
        anchors: [
          { slotId: "title", selector: ".title", maxChars: 60, optional: false },
          { slotId: "body", selector: ".body", maxChars: 120, optional: false }
        ],
        chartCanvasSelector: "canvas[data-chart-slot='primary']",
        chartSlots: [{ slotId: "primary", selector: "canvas[data-chart-slot='primary']", kind: "line", defaultRenderType: "line", componentId: "chart-1" }]
      },
      "slide-04": {
        fragmentId: "slide-04",
        pageType: "image-full",
        sourcePageType: "image-full",
        sourceSlideIndex: 4,
        sourceSlideTitle: "Image",
        htmlFile: "fragments/slide-04.html",
        pagePortrait: buildPortrait("图片页", "media", "image x1"),
        mediaKinds: ["image"],
        topicSlots: 1,
        topicSlotMaxChars: 80,
        anchors: [{ slotId: "title", selector: ".title", maxChars: 60, optional: false }],
        imageSlotSelectors: ["img"],
        chartSlots: []
      },
      "slide-05": {
        fragmentId: "slide-05",
        pageType: "video",
        sourcePageType: "video",
        sourceSlideIndex: 5,
        sourceSlideTitle: "Video",
        htmlFile: "fragments/slide-05.html",
        pagePortrait: buildPortrait("视频页", "media", "video x1"),
        mediaKinds: ["video"],
        topicSlots: 1,
        topicSlotMaxChars: 80,
        imageSlotSelectors: [],
        chartSlots: [],
        anchors: [{ slotId: "title", selector: ".title", maxChars: 60, optional: false }],
        videoSlotSelector: "video"
      }
    },
    capabilities: {
      chartTypes: ["line", "bar"],
      hasImagePages: true,
      hasVideoPages: true,
      hasAudioPages: false
    }
  };
}

function expectInvalidPlan(plan: PlanIR, expectedReason: string) {
  const validation = validatePlanIR(plan, request, pool);
  if (validation.ok) {
    throw new Error(`PlanIR validation should reject ${expectedReason}.`);
  }
}

function buildMediaOnlyManifest(): TemplateManifestV2 {
  const manifest = buildMockManifest();
  return {
    ...manifest,
    pool: {
      "slide-03": manifest.pool["slide-03"]!,
      "slide-04": manifest.pool["slide-04"]!,
      "slide-05": manifest.pool["slide-05"]!
    }
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
