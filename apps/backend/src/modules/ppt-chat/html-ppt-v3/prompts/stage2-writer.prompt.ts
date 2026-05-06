import { fragmentHasMediaKind, type PageFragment, type PlanIR, type TemplateManifestV2 } from "../shared";

export type Stage2WriterPromptInput = {
  plan: PlanIR;
  manifest: TemplateManifestV2;
  previousError?: string;
  batchIndex?: number;
  totalBatches?: number;
  batchSlides?: PlanIR["slides"];
};

export type Stage2WriterPromptResult = {
  systemPrompt: string;
  userPrompt: string;
};

export function buildStage2WriterPrompt(input: Stage2WriterPromptInput): Stage2WriterPromptResult {
  const batchSlides = input.batchSlides ?? input.plan.slides;
  const batchSlideIndexes = batchSlides.map((slide) => slide.slideIndex);
  const batchSlideCount = batchSlides.length;
  const allowedPageTypes = Array.from(new Set(batchSlides.map((slide) => slide.pageType)));
  const plannedChartTypes = batchSlides
    .map((slide) => slide.chartType)
    .filter((chartType): chartType is NonNullable<typeof chartType> => Boolean(chartType));
  const allowedChartTypes = Array.from(new Set(plannedChartTypes));
  const anchorTargets = buildAnchorTargets(input.plan, input.manifest);
  const exampleSlide = batchSlides[0] ?? input.plan.slides[0];
  const validJsonExample = {
    templateId: input.plan.templateId,
    slides: [{
      slideIndex: exampleSlide?.slideIndex ?? 1,
      ...(exampleSlide?.fragmentId ? { fragmentId: exampleSlide.fragmentId } : {}),
      pageType: exampleSlide?.pageType ?? "cover",
      slotFills: { title: "主题标题" },
      ...(exampleSlide?.pageType === "chart"
        ? {
            chartDataBySlot: {
              primary: {
                type: exampleSlide.chartType ?? allowedChartTypes[0] ?? "bar",
                labels: ["一", "二"],
                datasets: [{ label: "指标", data: [40, 70] }]
              }
            }
          }
        : {})
    }]
  };
  const slideSpecs = batchSlides.map((slide) => {
    const fragment = getFragment(input.manifest, slide);
    const chartSlots = fragment?.chartSlots ?? [];
    const requiresChartData = chartSlots.length > 0 || slide.pageType === "chart" || Boolean(fragment && fragmentHasMediaKind(fragment, "chart"));
    const imageSlots = fragment?.imageSlotSelectors?.length ?? 0;
    const requiresVideoHint = slide.pageType === "video" || Boolean(fragment && fragmentHasMediaKind(fragment, "video"));
    const slideTarget = anchorTargets.bySlideIndex.get(slide.slideIndex);
    return {
      slideIndex: slide.slideIndex,
      fragmentId: slide.fragmentId,
      pageType: slide.pageType,
      slideTitle: slide.slideTitle,
      topicPoints: slide.topicPoints,
      chartType: slide.chartType,
      anchors: (fragment?.anchors ?? []).map((anchor) => {
        const kind = anchor.kind ?? inferAnchorKind(anchor.slotId);
        return {
          slotId: anchor.slotId,
          kind,
          ...(shouldExposeTarChars(kind)
            ? { tarChars: slideTarget?.anchorTarChars.get(anchor.slotId) ?? baseTarChars(anchor) }
            : {}),
          maxChars: anchor.maxChars,
          optional: anchor.optional
        };
      }),
      chartSlots: chartSlots.map((slot) => ({
        slotId: slot.slotId,
        kind: slot.kind,
        defaultRenderType: slot.defaultRenderType
      })),
      requiresChartData,
      imageSlots,
      requiresVideoHint
    };
  });
  const deckOutline = buildDeckOutline(input.plan);
  const batchDescription = input.batchIndex && input.totalBatches
    ? `本批是第 ${input.batchIndex}/${input.totalBatches} 批，batchSlideIndexes=[${batchSlideIndexes.join(", ")}]。`
    : `本批覆盖全部页面，batchSlideIndexes=[${batchSlideIndexes.join(", ")}]。`;

  const systemPrompt = [
    "你是 PPT 正文撰稿人。",
    "你只执行 Stage 2：根据 PlanIR 撰写 ContentIR，不重新规划页面，不输出 HTML、Markdown、CSS 或代码。",
    "必须使用简体中文，除专有名词外不要输出英文句子。",
    "必须只输出一个严格 JSON 对象，不能有解释、注释、代码块、Markdown fences（```）或多余文本。",
    "输出必须可被 JSON.parse 直接解析；禁止尾随逗号，禁止 undefined，禁止单引号。",
    "JSON 必须符合 ContentIR：{templateId,slides:[{slideIndex,fragmentId?,pageType,slotFills,chartData?,chartDataBySlot?,imageHints?,videoHint?}]}。",
    "顶层 JSON 只能包含 ContentIR 结果；必须返回 templateId 和 slides，禁止返回 slideSpecs、输入参数副本、数组外壳或嵌套 content/result 包裹。",
    `全量合并后 slides 数量必须等于 pageCount=${input.plan.pageCount}。`,
    `本批只能返回 batchSlideIndexes 中的页面；本批 slides 数量必须等于 batchSlideCount=${batchSlideCount}。`,
    "不得新增、遗漏、合并或重排页面。",
    batchDescription,
    "slides 必须逐页复制 slideSpecs 中的 slideIndex、fragmentId、pageType；Stage 2 只写 slotFills/chartData/imageHints/videoHint，禁止改 fragmentId、pageType 或页序。",
    `允许的 pageType 只能来自 slideSpecs：${allowedPageTypes.join(", ")}。`,
    `允许的 chartData.type 只能是：${allowedChartTypes.join(", ")}。`,
    "slotFills 是 slotId 到文本的对象；每个必填 slot 都必须提供文本。",
    "每个 slot 文本长度必须严格小于或等于 anchors 中的 maxChars。",
    "注意！！！\n注意！！！\n注意！！！\n\ntarChars 是硬指标：所有带 tarChars 的正文类 slot 必须超过 anchors[].tarChars；除非 maxChars 更小；同时绝不能超过 maxChars。",
    "再次强调：tarChars 和 pageCount 是本阶段最重要的两个硬指标；先满足页数完整，再让每个带 tarChars 的正文 slot 写足目标长度。",
    "标题、页眉、页脚、badge、cta、stat、codeLine、mediaLabel 等补充元素不会提供 tarChars，不承担凑字数任务，不要为了字数刻意拉长。",
    "如果无法精确命中 tarChars，仍然只输出 ContentIR JSON，不要输出错误、解释或额外说明。",
    "anchors.kind 表示文本用途：title/subtitle/kicker/body/cardHeading/cardBody/listItem/statNumber/statLabel/tableCell/quote/caption/footer/badge/cta/codeLine/mediaLabel；请按用途写对应长度和语气。",
    "listItem、statNumber、statLabel、tableCell、footer、badge、cta 都是正式内容槽位，不得留空或复用模板示例。",
    "decorative-label-*、footer-label-*、meta-badge-*、section-label-* 也是内容槽位，必须按本页主题填写短标签，禁止复制模板原文或占位英文。",
    "重点词可以使用 关键词|STRONG| 后续描述 标记；不要使用任何 HTML 标签。",
    "带 chartSlots 的页必须输出 chartDataBySlot，key 必须覆盖每个 chartSlots[].slotId；labels 长度必须等于每个 dataset.data 长度。",
    "没有 chartSlots 的 legacy chart 页才使用 chartData；chartData.type 必须等于计划中的 chartType。",
    "只要 slideSpecs.imageSlots > 0 就必须输出 imageHints，数量应覆盖图片槽；只要 requiresVideoHint=true 就必须输出 videoHint。",
    `有效 JSON 示例：${JSON.stringify(validJsonExample)}`
  ].join("\n");

  const userPayload = {
    templateId: input.plan.templateId,
    pageCount: input.plan.pageCount,
    totalChars: input.plan.totalChars,
    batchIndex: input.batchIndex ?? 1,
    totalBatches: input.totalBatches ?? 1,
    batchSlideIndexes,
    batchSlideCount,
    deckOutline,
    slideSpecs,
    allowedPageTypes,
    allowedChartTypes,
    outputRule: "只返回严格 JSON 对象，不要输出 HTML、Markdown、代码围栏、数组外壳或英文正文。",
    previousError: input.previousError
  };

  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload, null, 2)
  };
}

function buildDeckOutline(plan: PlanIR) {
  return plan.slides.map((slide) => ({
    slideIndex: slide.slideIndex,
    slideTitle: slide.slideTitle,
    pageType: slide.pageType,
    fragmentId: slide.fragmentId,
    topicPoints: slide.topicPoints
  }));
}

type AnchorTargets = {
  bySlideIndex: Map<number, {
    anchorTarChars: Map<string, number>;
  }>;
};

function buildAnchorTargets(plan: PlanIR, manifest: TemplateManifestV2): AnchorTargets {
  const anchorsBySlide = new Map<number, NonNullable<PageFragment["anchors"]>>();
  let totalBaseTarChars = 0;

  for (const slide of plan.slides) {
    const fragment = getFragment(manifest, slide);
    const anchors = fragment?.anchors ?? [];
    anchorsBySlide.set(slide.slideIndex, anchors);
    totalBaseTarChars += anchors.reduce((sum, anchor) => {
      const kind = anchor.kind ?? inferAnchorKind(anchor.slotId);
      return shouldExposeTarChars(kind) ? sum + baseTarChars(anchor) : sum;
    }, 0);
  }

  const scaleRatio = totalBaseTarChars > 0 ? plan.totalChars / totalBaseTarChars : 1;
  const bySlideIndex = new Map<number, AnchorTargets["bySlideIndex"] extends Map<number, infer T> ? T : never>();

  for (const [slideIndex, anchors] of anchorsBySlide.entries()) {
    const anchorTarChars = new Map<string, number>();

    for (const anchor of anchors) {
      const kind = anchor.kind ?? inferAnchorKind(anchor.slotId);
      if (!shouldExposeTarChars(kind)) {
        continue;
      }
      const finalTarChars = scaledTarChars(anchor, scaleRatio);
      anchorTarChars.set(anchor.slotId, finalTarChars);
    }

    bySlideIndex.set(slideIndex, {
      anchorTarChars
    });
  }

  return { bySlideIndex };
}

function baseTarChars(anchor: PageFragment["anchors"][number]): number {
  return anchor.tarChars ?? Math.ceil(anchor.maxChars / 2);
}

function scaledTarChars(anchor: PageFragment["anchors"][number], scaleRatio: number): number {
  return Math.min(anchor.maxChars, Math.ceil(baseTarChars(anchor) * scaleRatio));
}

function inferAnchorKind(slotId: string): string {
  if (/title/i.test(slotId)) return "title";
  if (/subtitle/i.test(slotId)) return "subtitle";
  if (/kicker/i.test(slotId)) return "kicker";
  if (/footer/i.test(slotId)) return "footer";
  if (/badge/i.test(slotId)) return "badge";
  if (/cta/i.test(slotId)) return "cta";
  if (/heading/i.test(slotId)) return "cardHeading";
  if (/caption/i.test(slotId)) return "caption";
  return "body";
}

function shouldExposeTarChars(kind: string): boolean {
  return ["body", "cardBody", "listItem", "tableCell", "quote", "caption"].includes(kind);
}

function getFragment(manifest: TemplateManifestV2, slide: PlanIR["slides"][number]): PageFragment | undefined {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}
