import type { ContentIR, GenerateRequest, PlanIR } from "../shared";

export type Stage21SpeakerNotesPromptInput = {
  request: GenerateRequest;
  plan: PlanIR;
  content: ContentIR;
  batchSlides: PlanIR["slides"];
  batchIndex: number;
  totalBatches: number;
  previousError?: string;
};

export type Stage21SpeakerNotesPromptResult = {
  systemPrompt: string;
  userPrompt: string;
};

export function buildStage21SpeakerNotesPrompt(input: Stage21SpeakerNotesPromptInput): Stage21SpeakerNotesPromptResult {
  const contentByIndex = new Map(input.content.slides.map((slide) => [slide.slideIndex, slide]));
  const deckOutline = input.plan.slides.map((slide) => ({
    slideIndex: slide.slideIndex,
    slideTitle: slide.slideTitle,
    pageType: slide.pageType,
    fragmentId: slide.fragmentId,
    topicPoints: slide.topicPoints
  }));
  const slideInputs = input.batchSlides.map((slide) => {
    const content = contentByIndex.get(slide.slideIndex);
    return {
      slideIndex: slide.slideIndex,
      fragmentId: slide.fragmentId,
      pageType: slide.pageType,
      title: slide.slideTitle,
      topicPoints: slide.topicPoints,
      visibleText: collectVisibleText(content),
      chartSummary: summarizeChartData(content),
      imageHints: content?.imageHints ?? [],
      videoHint: content?.videoHint
    };
  });
  const batchSlideIndexes = input.batchSlides.map((slide) => slide.slideIndex);
  const exampleSlide = input.batchSlides[0] ?? input.plan.slides[0];
  const validJsonExample = {
    templateId: input.plan.templateId,
    slides: [{
      slideIndex: exampleSlide?.slideIndex ?? 1,
      ...(exampleSlide?.fragmentId ? { fragmentId: exampleSlide.fragmentId } : {}),
      pageType: exampleSlide?.pageType ?? "cover",
      notes: [
        "这一页先用口语化方式说明核心结论，帮助听众快速理解本页与整套方案的关系。",
        "接着结合页面要点解释落地动作、资源边界和下一步衔接，自然过渡到后续页面。"
      ]
    }]
  };

  const systemPrompt = [
    "你是 HTML-PPT 的演讲者讲稿撰稿人。",
    "你只执行 Stage 2.1：根据已完成的页面标题、要点和正文，为演讲者视图生成逐页讲稿。",
    "必须使用简体中文，口语化、适合现场讲解，不要写成可见 PPT 正文。",
    "每页 150-300 字，2-3 段；每段是 notes 数组中的一个纯文本字符串。",
    "不要输出强调占位符、竖线标记、Markdown 或 HTML 标签；如需强调，用自然口语表达即可。",
    "只输出严格 JSON 对象，不能有 Markdown、代码块、解释、注释或多余文本。",
    "JSON 必须符合 SpeakerNotesIR：{templateId,slides:[{slideIndex,fragmentId?,pageType,notes:string[]}]}。",
    `本批是第 ${input.batchIndex}/${input.totalBatches} 批，只返回 batchSlideIndexes=[${batchSlideIndexes.join(", ")}] 的讲稿。`,
    `本批 slides 数量必须等于 ${input.batchSlides.length}；不得新增、遗漏、合并或重排页面。`,
    "slides 必须逐页复制输入中的 slideIndex、fragmentId、pageType；不得修改页面身份。",
    "讲稿应基于当前页 visibleText、topicPoints、chartSummary、imageHints/videoHint；不要编造与主题无关的案例。",
    "每页最后一句要自然承接下一页，但不要提到“下一页编号”。",
    `有效 JSON 示例：${JSON.stringify(validJsonExample)}`,
    input.previousError ? `上一次错误：${input.previousError}` : ""
  ].filter(Boolean).join("\n");

  const userPayload = {
    templateId: input.plan.templateId,
    deckTheme: input.request.theme,
    pageCount: input.plan.pageCount,
    batchIndex: input.batchIndex,
    totalBatches: input.totalBatches,
    batchSlideIndexes,
    deckOutline,
    slideInputs,
    outputRule: "只返回 SpeakerNotesIR 严格 JSON；notes 是纯文本段落数组，禁止 HTML。"
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload, null, 2)
  };
}

function collectVisibleText(content: ContentIR["slides"][number] | undefined): string[] {
  if (!content) return [];
  return Array.from(new Set(Object.values(content.slotFills)
    .map((value) => value.trim())
    .filter(Boolean)))
    .slice(0, 24);
}

function summarizeChartData(content: ContentIR["slides"][number] | undefined): string[] {
  if (!content) return [];
  const summaries: string[] = [];
  if (content.chartData) {
    summaries.push(`${content.chartData.type}: ${content.chartData.labels.join("、")}`);
  }
  for (const [slotId, chart] of Object.entries(content.chartDataBySlot ?? {})) {
    summaries.push(`${slotId}/${chart.type}: ${chart.labels.join("、")}`);
  }
  return summaries;
}
