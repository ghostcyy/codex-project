import { buildRequiredImageSlidePlan, type AvailablePool, type GenerateRequest } from "../shared";

const REQUIRED_IMAGE_FRAGMENT_COUNT = 3;

export type Stage1PlannerPromptInput = {
  request: GenerateRequest;
  pool: AvailablePool;
  previousError?: string;
};

export type Stage1PlannerPromptResult = {
  systemPrompt: string;
  userPrompt: string;
};

export function buildStage1PlannerPrompt(input: Stage1PlannerPromptInput): Stage1PlannerPromptResult {
  const allowedMiddleFragmentIds = Object.keys(input.pool.middle);
  const middleSummaries = Object.values(input.pool.middle);
  const middlePageTypeLabels = Array.from(new Set(middleSummaries.map((summary) => summary.pageType)));
  const imageFragmentIds = middleSummaries
    .filter((summary) => summary.isImage && summary.imageSlotCount > 0)
    .map((summary) => summary.fragmentId);
  const nonImageFragmentIds = middleSummaries
    .filter((summary) => !(summary.isImage && summary.imageSlotCount > 0))
    .map((summary) => summary.fragmentId);
  const fragmentPageTypeMap = Object.fromEntries(
    middleSummaries.map((summary) => [summary.fragmentId, summary.pageType])
  );
  const imageRequired = input.request.includeImages && imageFragmentIds.length > 0;
  const requiredImageSlides = buildRequiredImageSlidePlan(input.request, input.pool);
  const regularMiddleSummaries = imageRequired
    ? middleSummaries.filter((summary) => !(summary.isImage && summary.imageSlotCount > 0))
    : middleSummaries;
  const allowedRegularMiddleFragmentIds = regularMiddleSummaries.map((summary) => summary.fragmentId);
  const allowedPageTypes = ["cover", ...middlePageTypeLabels, "closing"];
  const allowedChartTypes = input.pool.chartTypesAvailable;
  const exampleImageMiddles = middleSummaries.filter((summary) => summary.isImage && summary.imageSlotCount > 0);
  const exampleMiddle = imageRequired ? (exampleImageMiddles[0] ?? middleSummaries[0]) : middleSummaries[0];
  const exampleSecondMiddle = imageRequired
    ? (exampleImageMiddles[1] ?? exampleImageMiddles[0] ?? middleSummaries[1] ?? exampleMiddle)
    : undefined;
  const exampleMiddleFragmentId = exampleMiddle?.fragmentId ?? allowedMiddleFragmentIds[0] ?? "slide-02";
  const exampleMiddlePageType = exampleMiddle?.pageType ?? "title-text";
  const exampleSecondMiddleFragmentId = exampleSecondMiddle?.fragmentId ?? exampleMiddleFragmentId;
  const exampleSecondMiddlePageType = exampleSecondMiddle?.pageType ?? exampleMiddlePageType;
  const exampleChartType = allowedChartTypes[0] ?? "bar";
  const topicPointsFor = (summary: typeof exampleMiddle) =>
    Array.from({ length: Math.max(1, summary?.topicSlots ?? 1) }, (_, index) => `要点${index + 1}`);
  const validJsonExample = imageRequired ? {
    templateId: input.request.templateId,
    totalChars: 800,
    pageCount: 4,
    slides: [
      { slideIndex: 1, pageType: "cover", slideTitle: "主题", topicPoints: ["开场"], charBudget: 120 },
      {
        slideIndex: 2,
        fragmentId: exampleMiddleFragmentId,
        pageType: exampleMiddlePageType,
        slideTitle: "核心视觉一",
        topicPoints: topicPointsFor(exampleMiddle),
        ...(exampleMiddle?.isChart ? { chartType: exampleChartType } : {}),
        charBudget: 280
      },
      {
        slideIndex: 3,
        fragmentId: exampleSecondMiddleFragmentId,
        pageType: exampleSecondMiddlePageType,
        slideTitle: "核心视觉二",
        topicPoints: topicPointsFor(exampleSecondMiddle),
        ...(exampleSecondMiddle?.isChart ? { chartType: exampleChartType } : {}),
        charBudget: 280
      },
      { slideIndex: 4, pageType: "closing", slideTitle: "总结", topicPoints: ["行动"], charBudget: 120 }
    ]
  } : {
    templateId: input.request.templateId,
    totalChars: 600,
    pageCount: 3,
    slides: [
      { slideIndex: 1, pageType: "cover", slideTitle: "主题", topicPoints: ["开场"], charBudget: 120 },
      {
        slideIndex: 2,
        fragmentId: exampleMiddleFragmentId,
        pageType: exampleMiddlePageType,
        slideTitle: "核心洞察",
        topicPoints: ["要点一"],
        ...(exampleMiddle?.isChart ? { chartType: exampleChartType } : {}),
        charBudget: 360
      },
      { slideIndex: 3, pageType: "closing", slideTitle: "总结", topicPoints: ["行动"], charBudget: 120 }
    ]
  };
  const middleFragments = regularMiddleSummaries.map((summary) => ({
    fragmentId: summary.fragmentId,
    pageType: summary.pageType,
    htmlFile: summary.htmlFile,
    topicSlots: summary.topicSlots,
    topicSlotMaxChars: summary.topicSlotMaxChars,
    approxCharCapacity: summary.approxCharCapacity,
    description: summary.description,
    pagePortrait: {
      summary: summary.pagePortrait.summary,
      layoutFamily: summary.pagePortrait.layoutFamily,
      componentSignature: summary.pagePortrait.componentSignature,
      density: summary.pagePortrait.density,
      componentCounts: summary.pagePortrait.componentCounts,
      tags: summary.pagePortrait.tags,
      useCases: summary.pagePortrait.useCases
    },
    chartSlots: summary.chartSlots.map((slot) => ({
      slotId: slot.slotId,
      kind: slot.kind,
      defaultRenderType: slot.defaultRenderType
    })),
    imageSlots: summary.imageSlotCount,
    isChart: summary.isChart,
    isImage: summary.isImage,
    isVideo: summary.isVideo,
    isAudio: summary.isAudio
  }));

  const retryInstruction = input.previousError
    ? [
        "上一次输出无效，必须先修正这些错误，再输出新的 PlanIR：",
        input.previousError,
        "不要重复上一次的错误；如果图片页数量、fragmentId/pageType 映射或 topicPoints 数量错误，必须重新规划对应页面。"
      ].join("\n")
    : "";

  const systemPrompt = [
    "你是 PPT 大纲规划师。",
    "你只执行 Stage 1：规划 PlanIR，不撰写正文，不输出 HTML、Markdown、CSS 或代码。",
    "必须使用简体中文。",
    "必须只输出一个严格 JSON 对象，不能有解释、注释、代码块、Markdown fences（```）或多余文本。",
    "输出必须可被 JSON.parse 直接解析；禁止尾随逗号，禁止 undefined，禁止单引号。",
    "JSON 必须符合 PlanIR：{templateId,totalChars,pageCount,slides:[{slideIndex,fragmentId?,pageType,slideTitle,topicPoints,chartType?,charBudget}]}。",
    "第一页 pageType 必须是 cover，最后一页 pageType 必须是 closing。",
    `允许的 pageType 只能是：${allowedPageTypes.join(", ")}。`,
    imageRequired
      ? `除 requiredImageSlides 固定指定的图片页外，普通中间页只能从这些非图片 fragmentId 中选择，可重复：${allowedRegularMiddleFragmentIds.join(", ") || "(none)"}。`
      : `中间页必须从这些 fragmentId 中选择，可重复：${allowedMiddleFragmentIds.join(", ") || "(none)"}。`,
    "中间页必须先选择 fragmentId，再从 user JSON 的 fragmentPageTypeMap 精确复制对应 pageType；pageType 不允许自行猜测。",
    "pageType 必须从 fragmentPageTypeMap 复制；例如 fragmentPageTypeMap[fragmentId] 是 grid-3，就必须输出 pageType:grid-3。",
    "topicPoints 数量必须等于所选 fragmentId 对应 fragment 的 topicSlots。",
    `chart 页必须填写 chartType，且只能使用这些 chartType：${allowedChartTypes.join(", ") || "(none)"}。`,
    imageRequired
      ? [
          "注意！！！",
          "注意！！！",
          "注意！！！",
          `includeImages=true，图片页是硬性要求：必须且只能选择 ${REQUIRED_IMAGE_FRAGMENT_COUNT} 页图片页，否则 PlanIR 无效。`,
          `requiredImageSlides 是固定图片页计划，必须逐项原样使用：${JSON.stringify(requiredImageSlides)}。`,
          `图片页计数公式：slides.filter(s => [${imageFragmentIds.map((id) => `"${id}"`).join(", ")}].includes(s.fragmentId)).length 必须等于 ${REQUIRED_IMAGE_FRAGMENT_COUNT}。`,
          `图片页只能从这些 fragmentId 中选择：${imageFragmentIds.join(", ")}。`,
          "除 requiredImageSlides 指定页面外，其他任何 slideIndex 禁止使用图片 fragmentId。",
          `非图片中间页必须优先从这些 fragmentId 中选择：${nonImageFragmentIds.join(", ") || "(none)"}。`,
          `由你自行决定使用哪 ${REQUIRED_IMAGE_FRAGMENT_COUNT} 个图片 fragment；如果候选不足，可以重复使用同一个 image fragment，但最终图片页数量必须等于 ${REQUIRED_IMAGE_FRAGMENT_COUNT}。`,
          `如果你同时选择全部图片 fragment（${imageFragmentIds.join(", ")}），图片页计数会是 ${imageFragmentIds.length}，不是 ${REQUIRED_IMAGE_FRAGMENT_COUNT}，必定无效。`
        ].join("\n")
      : "如果 includeImages=false 或没有图片 fragment，禁止自行创造图片页。",
    "不要规划用户已禁用且已从选项池删除的图片、视频、图表或音频页。",
    retryInstruction,
    `有效 JSON 示例：${JSON.stringify(validJsonExample)}`
  ].filter(Boolean).join("\n");

  const userPayload = {
    theme: input.request.theme,
    pageCount: input.request.pageCount,
    wordBudget: input.request.wordBudget,
    templateId: input.request.templateId,
    includeImages: input.request.includeImages,
    includeVideo: input.request.includeVideo,
    includeChart: input.request.includeChart,
    includeAudio: input.request.includeAudio,
    fixed: {
      cover: input.pool.cover,
      closing: input.pool.closing
    },
    allowedPageTypes,
    allowedMiddleFragmentIds: imageRequired ? allowedRegularMiddleFragmentIds : allowedMiddleFragmentIds,
    requiredImageSlides,
    fragmentPageTypeMap,
    imageRequired,
    imageFragmentIds,
    nonImageFragmentIds,
    imageRequirement: imageRequired
      ? {
          required: true,
          targetCount: REQUIRED_IMAGE_FRAGMENT_COUNT,
          rule: `必须且只能规划 ${REQUIRED_IMAGE_FRAGMENT_COUNT} 页图片页，否则 PlanIR 无效。`,
          countFormula: `slides.filter(s => ${JSON.stringify(imageFragmentIds)}.includes(s.fragmentId)).length`,
          allowedImageFragmentIds: imageFragmentIds,
          nonImageFragmentIds,
          requiredImageSlides
        }
      : { required: false },
    allowedChartTypes,
    chartTypesAvailable: input.pool.chartTypesAvailable,
    availableMiddleFragments: middleFragments,
    budgetRule: "所有 charBudget 之和应尽量等于 wordBudget，允许误差不超过 15%。",
    outputRule: "只返回严格 JSON 对象，不要输出数组外壳、HTML、Markdown、代码围栏或英文正文。",
    previousError: input.previousError
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload, null, 2)
  };
}
