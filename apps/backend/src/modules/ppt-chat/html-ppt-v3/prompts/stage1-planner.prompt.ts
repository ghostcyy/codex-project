import type { AvailablePool, GenerateRequest } from "../shared";

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
  const allowedPageTypes = ["cover", ...middlePageTypeLabels, "closing"];
  const allowedChartTypes = input.pool.chartTypesAvailable;
  const exampleMiddle = middleSummaries[0];
  const exampleMiddleFragmentId = exampleMiddle?.fragmentId ?? allowedMiddleFragmentIds[0] ?? "slide-02";
  const exampleMiddlePageType = exampleMiddle?.pageType ?? "title-text";
  const exampleChartType = allowedChartTypes[0] ?? "bar";
  const validJsonExample = {
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
  const middleFragments = middleSummaries.map((summary) => ({
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
    isChart: summary.isChart,
    isImage: summary.isImage,
    isVideo: summary.isVideo,
    isAudio: summary.isAudio
  }));

  const systemPrompt = [
    "你是 PPT 大纲规划师。",
    "你只执行 Stage 1：规划 PlanIR，不撰写正文，不输出 HTML、Markdown、CSS 或代码。",
    "必须使用简体中文。",
    "必须只输出一个严格 JSON 对象，不能有解释、注释、代码块、Markdown fences（```）或多余文本。",
    "输出必须可被 JSON.parse 直接解析；禁止尾随逗号，禁止 undefined，禁止单引号。",
    "JSON 必须符合 PlanIR：{templateId,totalChars,pageCount,slides:[{slideIndex,fragmentId?,pageType,slideTitle,topicPoints,chartType?,charBudget}]}。",
    "第一页 pageType 必须是 cover，最后一页 pageType 必须是 closing。",
    `允许的 pageType 只能是：${allowedPageTypes.join(", ")}。`,
    `中间页必须从这些 fragmentId 中选择，可重复：${allowedMiddleFragmentIds.join(", ") || "(none)"}。`,
    "中间页必须同时填写 fragmentId 和该 fragment 对应的 pageType。",
    "topicPoints 数量必须等于所选 fragmentId 对应 fragment 的 topicSlots。",
    `chart 页必须填写 chartType，且只能使用这些 chartType：${allowedChartTypes.join(", ") || "(none)"}。`,
    "不要规划用户已禁用且已从选项池删除的图片、视频、图表或音频页。",
    `有效 JSON 示例：${JSON.stringify(validJsonExample)}`
  ].join("\n");

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
    allowedMiddleFragmentIds,
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
