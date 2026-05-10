import { z } from "zod";
import { buildStage21SpeakerNotesPrompt } from "../prompts/stage2_1-speaker-notes.prompt";
import { runStage21SpeakerNotes } from "../stages/stage2_1-speaker-notes";
import type { ContentIR, GenerateRequest, PagePortrait, PlanIR, TemplateManifestV2 } from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

const request: GenerateRequest = {
  theme: "AI Agent 在中小企业的落地路线",
  pageCount: 8,
  wordBudget: 1800,
  templateId: "mock-template",
  includeImages: false,
  includeVideo: false,
  includeChart: false,
  includeAudio: false,
  includeSpeakerNotes: true
};

const manifest: TemplateManifestV2 = {
  schemaVersion: 2,
  id: "mock-template",
  deckClass: "tpl-mock-template",
  label: { "zh-CN": "测试模板", en: "Mock Template" },
  description: { "zh-CN": "用于讲稿验证", en: "Speaker notes verification" },
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
      anchors: [{ slotId: "title", selector: ".title", maxChars: 40, optional: false }]
    },
    closing: {
      fragmentId: "closing",
      pageType: "closing",
      sourceSlideIndex: 8,
      sourceSlideTitle: "Closing",
      htmlFile: "fragments/closing.html",
      pagePortrait: buildPortrait("收尾页", "closing", "text x1"),
      mediaKinds: [],
      topicSlots: 1,
      topicSlotMaxChars: 80,
      imageSlotSelectors: [],
      chartSlots: [],
      anchors: [{ slotId: "title", selector: ".title", maxChars: 40, optional: false }]
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
      pagePortrait: buildPortrait("双栏正文页", "grid", "card x2"),
      mediaKinds: [],
      topicSlots: 2,
      topicSlotMaxChars: 80,
      imageSlotSelectors: [],
      chartSlots: [],
      anchors: [
        { slotId: "title", selector: ".title", maxChars: 40, optional: false },
        { slotId: "body", selector: ".body", maxChars: 120, optional: false }
      ]
    }
  },
  capabilities: {
    chartTypes: [],
    hasImagePages: false,
    hasVideoPages: false,
    hasAudioPages: false
  }
};

const plan: PlanIR = {
  templateId: request.templateId,
  totalChars: request.wordBudget,
  pageCount: request.pageCount,
  slides: Array.from({ length: request.pageCount }, (_, index) => {
    const slideIndex = index + 1;
    if (slideIndex === 1) return { slideIndex, pageType: "cover", slideTitle: "落地总览", topicPoints: ["目标"], charBudget: 180 };
    if (slideIndex === request.pageCount) return { slideIndex, pageType: "closing", slideTitle: "行动收束", topicPoints: ["计划"], charBudget: 180 };
    return {
      slideIndex,
      fragmentId: "slide-02",
      pageType: "grid-2",
      slideTitle: `推进阶段 ${slideIndex}`,
      topicPoints: ["场景识别", "成本控制"],
      charBudget: 220
    };
  })
};

const content: ContentIR = {
  templateId: request.templateId,
  slides: plan.slides.map((slide) => ({
    slideIndex: slide.slideIndex,
    fragmentId: slide.fragmentId,
    pageType: slide.pageType,
    slotFills: {
      title: slide.slideTitle,
      body: `${slide.slideTitle} 需要结合业务场景、团队能力和预算边界形成可执行路线。`
    },
    imageHints: slide.slideIndex === 4 ? ["企业团队围绕数据看板讨论 AI Agent 落地"] : undefined
  }))
};

const prompt = buildStage21SpeakerNotesPrompt({
  request,
  plan,
  content,
  batchSlides: plan.slides.slice(0, 7),
  batchIndex: 1,
  totalBatches: 2
});
const payload = JSON.parse(prompt.userPrompt) as {
  deckOutline?: unknown[];
  slideInputs?: Array<{ slideIndex: number; visibleText?: string[]; imageHints?: string[] }>;
};
if (!prompt.systemPrompt.includes("每页 150-300 字") || !prompt.systemPrompt.includes("只输出严格 JSON")) {
  throw new Error("Stage 2.1 system prompt should require Chinese speaker notes and strict JSON.");
}
if (prompt.systemPrompt.includes("|STRONG|")) {
  throw new Error("Stage 2.1 speaker notes prompt should not ask the model to emit |STRONG| markers.");
}
if (!Array.isArray(payload.deckOutline) || payload.deckOutline.length !== plan.pageCount) {
  throw new Error("Stage 2.1 prompt should include the full compact deckOutline.");
}
if (!Array.isArray(payload.slideInputs) || payload.slideInputs.length !== 7) {
  throw new Error("Stage 2.1 prompt should include only current batch slide inputs.");
}
if (prompt.userPrompt.includes("selector") || prompt.userPrompt.includes("sourceText") || prompt.userPrompt.includes("<section")) {
  throw new Error("Stage 2.1 prompt must not expose HTML, selector, or template sourceText.");
}
if (!payload.slideInputs.some((slide) => slide.visibleText?.some((text) => text.includes("业务场景")))) {
  throw new Error("Stage 2.1 prompt should pass current slide visible text from ContentIR.");
}

async function main() {
  let callCount = 0;
  let firstAwaitReached = false;
  const batchStarts: boolean[] = [];
  const llm: HtmlPptV3LLMClient = {
    async callStructured<T extends z.ZodTypeAny>(args: { schema: T; userPrompt: string; stage?: string }): Promise<z.infer<T>> {
      callCount += 1;
      batchStarts.push(!firstAwaitReached);
      if (args.stage !== "v3-stage2_1-speaker-notes") {
        throw new Error(`Stage 2.1 calls should use v3-stage2_1-speaker-notes stage tag, got ${args.stage ?? "undefined"}.`);
      }
      const requestPayload = JSON.parse(args.userPrompt) as { slideInputs: Array<{ slideIndex: number; fragmentId?: string; pageType: string; title: string }> };
      await Promise.resolve();
      firstAwaitReached = true;
      return args.schema.parse({
        templateId: request.templateId,
        slides: requestPayload.slideInputs.map((slide) => ({
          slideIndex: slide.slideIndex,
          fragmentId: slide.fragmentId,
          pageType: slide.pageType,
          notes: [
            `这一页先用口语化方式介绍${slide.title}，帮助听众理解它和整体落地路线之间的关系。`,
            "接着提醒大家关注行动优先级、资源边界和下一步执行节奏，自然过渡到后续页面。"
          ]
        }))
      });
    }
  };

  const result = await runStage21SpeakerNotes({ request, plan, content, llm });
  if (!result.speakerNotes || result.source !== "model" || result.warnings.length) {
    throw new Error(`Stage 2.1 should return model speaker notes without warnings: ${JSON.stringify(result)}`);
  }
  if (callCount !== 2 || !batchStarts.every(Boolean)) {
    throw new Error(`Stage 2.1 should split 8 slides into 2 concurrent batches; calls=${callCount}, starts=${batchStarts.join(",")}`);
  }
  if (result.speakerNotes.slides.length !== plan.pageCount) {
    throw new Error("Stage 2.1 should merge all batch notes into a full SpeakerNotesIR.");
  }

  let skippedCalls = 0;
  const skipped = await runStage21SpeakerNotes({
    request: { ...request, includeSpeakerNotes: false },
    plan,
    content,
    llm: {
      async callStructured() {
        skippedCalls += 1;
        throw new Error("should not be called");
      }
    }
  });
  if (skipped.requested || skipped.speakerNotes || skippedCalls !== 0) {
    throw new Error("Stage 2.1 should skip LLM calls when includeSpeakerNotes=false.");
  }

  const failed = await runStage21SpeakerNotes({
    request,
    plan,
    content,
    llm: {
      async callStructured() {
        throw new Error("speaker notes model unavailable");
      }
    }
  });
  if (failed.speakerNotes || failed.source !== "failed" || !failed.warnings.some((warning) => warning.includes("speaker notes model unavailable"))) {
    throw new Error("Stage 2.1 model failure should return warnings and allow the main deck pipeline to continue.");
  }

  console.log("HTML-PPT v3 Stage 2.1 speaker notes verification passed.");
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
