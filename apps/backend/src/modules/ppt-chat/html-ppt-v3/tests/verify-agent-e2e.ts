import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HtmlPptV3AgentService } from "../orchestration/html-ppt-v3-agent.service";
import { runStage3Injector as runStage3Wrapper } from "../stages/stage3-injector";
import type { V3ImageGenerationClient } from "../stages/stage2_5-image-generation";
import { loadManifestV2 } from "../manifest/manifest-v2.loader";
import { buildAvailablePool, buildRequiredImageSlidePlan, HTML_PPT_V3_OUTPUT_DIR, type ContentIR, type GenerateRequest, type PageFragment, type PlanIR, type TemplateManifestV2 } from "../shared";
import { parsePptV3MessageRequest } from "../projects/ppt-v3-message-parser";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

const request: GenerateRequest = {
  theme: "AI驱动的个性化学习路径设计",
  pageCount: 6,
  wordBudget: 1500,
  templateId: "22-quantum-computing",
  includeImages: false,
  includeVideo: false,
  includeChart: false,
  includeAudio: false,
  includeSpeakerNotes: false
};
const jobId = "00000000-0000-4000-8000-00000000v3e2".replace("v", "0");
const outputRoot = join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", jobId);
const zipPath = join(HTML_PPT_V3_OUTPUT_DIR, "output", `${jobId}.zip`);

class FakeLlm implements HtmlPptV3LLMClient {
  private plan: PlanIR | null = null;

  constructor(private readonly request: GenerateRequest) {}

  async callStructured<T extends z.ZodTypeAny>(args: { userPrompt: string; schema: T }): Promise<z.infer<T>> {
    const payload = JSON.parse(args.userPrompt) as Record<string, unknown>;
    if (payload["availableMiddleFragments"]) {
      assertPlannerPayloadDoesNotExposeDisabledPages(payload, this.request);
      this.plan = await buildPlan(this.request);
      return args.schema.parse(this.plan);
    }
    if (payload["slideSpecs"]) {
      if (!this.plan) throw new Error("Fake writer was called before fake planner.");
      assertWriterPayloadDoesNotExposeDisabledPages(payload, this.request);
      const batchSlideIndexes = Array.isArray(payload["batchSlideIndexes"])
        ? (payload["batchSlideIndexes"] as unknown[]).map((value) => Number(value)).filter((value) => Number.isInteger(value))
        : undefined;
      const content = await buildContent(this.request, this.plan, batchSlideIndexes);
      return args.schema.parse(content);
    }
    throw new Error("Unexpected V3 prompt payload.");
  }
}

async function main() {
  rmSync(outputRoot, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(join(outputRoot, "fragments"), { recursive: true });
  writeFileSync(join(outputRoot, "fragments", "title-text.html"), "<section>stale legacy fragment</section>");
  writeFileSync(join(outputRoot, "fragments", "grid-3.html"), "<section>stale legacy grid fragment</section>");
  writeFileSync(join(outputRoot, "index.html"), "<!doctype html><html><body>stale legacy index</body></html>");

  const service = new HtmlPptV3AgentService();
  let savedPlan: PlanIR | null = null;
  let savedContent: ContentIR | null = null;
  const events: string[] = [];

  const result = await service.generate({
    jobId,
    request,
    llm: new FakeLlm(request),
    llmConfig: {
      id: "1",
      name: "fake",
      providerType: "openai",
      baseUrl: "http://localhost",
      apiKey: "fake",
      model: "fake",
      stageModelOverrides: {},
      enabled: true,
    } satisfies ActiveLlmConfig,
    onPlan: (plan) => {
      savedPlan = plan;
    },
    onContent: (content) => {
      savedContent = content;
    },
    onProgress: (event) => {
      events.push(`${event.stage}:${event.status}`);
    }
  });

  if (result.jobId !== jobId) throw new Error("Agent should preserve the external jobId.");
  if (!savedPlan || !savedContent) throw new Error("Agent should expose plan and content for persistence callbacks.");
  if (!existsSync(result.outputDir) || !existsSync(join(result.outputDir, "index.html"))) {
    throw new Error("Agent should produce a previewable output directory with index.html.");
  }
  if (!existsSync(result.zipPath)) throw new Error("Agent should produce a zip package.");
  if (existsSync(join(result.outputDir, "fragments", "title-text.html"))) {
    throw new Error("Agent should clear stale pageType-named fragments before starting a new generation.");
  }
  if (existsSync(join(result.outputDir, "fragments", "grid-3.html"))) {
    throw new Error("Agent should clear stale grid pageType fragments before starting a new generation.");
  }
  for (const artifact of ["fragments", "manifest-v2.json", "shell.html", "manifest.json"]) {
    if (existsSync(join(result.outputDir, artifact))) {
      throw new Error(`Agent output should not publish template engineering artifact ${artifact}.`);
    }
  }
  const zipBytes = readFileSync(result.zipPath);
  for (const artifact of ["fragments/", "manifest-v2.json", "shell.html", "manifest.json"]) {
    if (zipBytes.includes(Buffer.from(artifact))) {
      throw new Error(`Zip package should not include template engineering artifact ${artifact}.`);
    }
  }
  if (!zipBytes.includes(Buffer.from("assets/edit-mode.js"))) {
    throw new Error("Zip package should include assets/edit-mode.js for exported deck editing.");
  }
  const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
  if (!html.includes('data-html-ppt-v3-output="fragment-id"')) {
    throw new Error("Generated HTML should include the current fragment-id output marker.");
  }
  if (!html.includes("AI驱动的个性化学习路径设计")) {
    throw new Error("Generated HTML should include filled deck content.");
  }
  if (!html.includes('id="quantum-canvas"') || !html.includes("data-html-ppt-v3-deck-effects")) {
    throw new Error("Generated quantum template deck should preserve deck-level particle canvas and runtime.");
  }
  if (!html.includes('src="assets/edit-mode.js"') || !html.includes("data-html-ppt-v3-edit-mode")) {
    throw new Error("Generated HTML should load edit-mode.js so exported decks support E edit mode.");
  }
  if (html.includes('"<script src="assets/edit-mode.js"')) {
    throw new Error("Generated HTML should inject edit-mode.js into the final document, not inside a presenter runtime string.");
  }
  if (html.includes('src="assets/runtime.js"')) {
    throw new Error("Generated HTML should not load legacy runtime.js because V3 owns navigation and presenter support.");
  }
  if (!html.includes("html-ppt-v3-presenter") || !html.includes("?preview=")) {
    throw new Error("Generated HTML should include V3 presenter mode and preview support.");
  }
  if (!existsSync(join(result.outputDir, "assets", "edit-mode.js"))) {
    throw new Error("Generated output should publish assets/edit-mode.js.");
  }
  if (/createChart\s*\(|getElementById\(["'](?:lineChart|pieChart|barChart|ganttChart)["']\)/i.test(html)) {
    throw new Error("Generated deck should not restore legacy template chart initialization scripts.");
  }
  if (/{{[^}]+}}/.test(html)) throw new Error("Generated HTML should not contain unresolved placeholders.");
  assertHtmlDoesNotContainDisabledPages(html, request);
  if (html.includes("../../../../assets/")) {
    throw new Error("Generated HTML should not contain skill-relative asset refs.");
  }
  const localBaseCssPath = join(result.outputDir, "assets", "base.css");
  if (!existsSync(localBaseCssPath)) {
    throw new Error("Agent should publish local assets/base.css for offline and preview rendering.");
  }
  const localBaseCss = readFileSync(localBaseCssPath, "utf8");
  if (!/\.slide\.is-active\b/.test(localBaseCss) || !/opacity\s*:\s*0/.test(localBaseCss) || !/opacity\s*:\s*1/.test(localBaseCss)) {
    throw new Error("Published assets/base.css should include inactive/active slide visibility rules.");
  }
  for (const requiredEvent of ["00-pool-build:completed", "01-planner:completed", "02-writer:completed", "03-injector:completed", "04-packager:completed"]) {
    if (!events.includes(requiredEvent)) throw new Error(`Missing progress event ${requiredEvent}.`);
  }

  await verifyLegacyNoMediaCase({
    theme: "新能源电车在当前市场上的情况，包括销量、客户来源、价格以及档次和牌子",
    pageCount: 15,
    wordBudget: 2500,
    templateId: "15-future-mobility",
    includeImages: false,
    includeVideo: false
  } as GenerateRequest, "legacy-mobility-no-media");

  await verifyLegacyNoMediaCase({
    theme: "LED镜子在当前市场上的情况，包括销量、客户来源、价格以及档次和牌子",
    pageCount: 15,
    wordBudget: 2500,
    templateId: "18-wellness-zen",
    includeImages: false,
    includeVideo: false
  } as GenerateRequest, "legacy-wellness-no-media");

  await verifyLegacyNoMediaCase({
    theme: "LED镜子在当前市场上的情况，包括销量、客户来源、价格以及档次和牌子",
    pageCount: 20,
    wordBudget: 3000,
    templateId: "23-luxury-ecommerce",
    includeImages: false,
    includeVideo: false
  } as GenerateRequest, "legacy-luxury-no-media");

  await verifyLegacyNoMediaCase({
    theme: "各类手机在当前市场上的情况，包括销量、客户来源、价格以及档次",
    pageCount: 15,
    wordBudget: 2500,
    templateId: "22-quantum-computing",
    includeImages: false,
    includeVideo: false
  } as GenerateRequest, "legacy-quantum-phone-no-media");

  await verifyLegacyNoMediaCase({
    theme: "高端智慧地产的市场趋势、客户画像、节能价值和长期运营收益",
    pageCount: 18,
    wordBudget: 2800,
    templateId: "06-realestate-smart",
    includeImages: false,
    includeVideo: false
  } as GenerateRequest, "legacy-realestate-no-image-background");

  await verifyImageGenerationCase();
  await verifyPromptResidueCase();
  verifyLegacyStage3Rejected();
  await verifyPlannerFallbackDoesNotPublish();
  await verifyWriterFallbackDoesNotPublish();

  console.log("HTML-PPT v3 agent e2e verification passed.");
}

class AlwaysFailingLlm implements HtmlPptV3LLMClient {
  async callStructured<T extends z.ZodTypeAny>(): Promise<z.infer<T>> {
    throw new Error("forced LLM failure");
  }
}

class ValidPlannerFailingWriterLlm implements HtmlPptV3LLMClient {
  private plan: PlanIR | null = null;

  constructor(private readonly request: GenerateRequest) {}

  async callStructured<T extends z.ZodTypeAny>(args: { userPrompt: string; schema: T }): Promise<z.infer<T>> {
    const payload = JSON.parse(args.userPrompt) as Record<string, unknown>;
    if (payload["availableMiddleFragments"]) {
      this.plan = await buildPlan(this.request);
      return args.schema.parse(this.plan);
    }
    if (payload["slideSpecs"]) {
      throw new Error("forced writer failure");
    }
    throw new Error("Unexpected V3 prompt payload.");
  }
}

async function verifyPlannerFallbackDoesNotPublish() {
  const fallbackJobId = "fallback-planner-block";
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", fallbackJobId), { recursive: true, force: true });
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${fallbackJobId}.zip`), { force: true });
  const events: string[] = [];

  let failedMessage = "";
  try {
    await new HtmlPptV3AgentService().generate({
      jobId: fallbackJobId,
      request,
      llm: new AlwaysFailingLlm(),
      llmConfig: {
        id: "1",
        name: "fake",
        providerType: "openai",
        baseUrl: "http://localhost",
        apiKey: "fake",
        model: "fake",
        stageModelOverrides: {},
        enabled: true,
      } satisfies ActiveLlmConfig,
      onProgress: (event) => {
        events.push(`${event.stage}:${event.status}`);
      }
    });
  } catch (error) {
    failedMessage = error instanceof Error ? error.message : String(error);
  }

  if (!/planner/i.test(failedMessage) || !/fallback/i.test(failedMessage)) {
    throw new Error(`Planner fallback should fail the live job before publishing; got '${failedMessage || "no failure"}'.`);
  }
  if (events.some((event) => event.startsWith("03-injector:") || event.startsWith("04-packager:"))) {
    throw new Error("Planner fallback must not continue into injector or packager.");
  }
  if (existsSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", fallbackJobId, "index.html")) ||
      existsSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${fallbackJobId}.zip`))) {
    throw new Error("Planner fallback must not publish final HTML or ZIP.");
  }
}

async function verifyWriterFallbackDoesNotPublish() {
  const fallbackJobId = "fallback-writer-block";
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", fallbackJobId), { recursive: true, force: true });
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${fallbackJobId}.zip`), { force: true });
  const events: string[] = [];

  let failedMessage = "";
  try {
    await new HtmlPptV3AgentService().generate({
      jobId: fallbackJobId,
      request,
      llm: new ValidPlannerFailingWriterLlm(request),
      llmConfig: {
        id: "1",
        name: "fake",
        providerType: "openai",
        baseUrl: "http://localhost",
        apiKey: "fake",
        model: "fake",
        stageModelOverrides: {},
        enabled: true,
      } satisfies ActiveLlmConfig,
      onProgress: (event) => {
        events.push(`${event.stage}:${event.status}`);
      }
    });
  } catch (error) {
    failedMessage = error instanceof Error ? error.message : String(error);
  }

  if (!/writer/i.test(failedMessage) || !/fallback/i.test(failedMessage)) {
    throw new Error(`Writer fallback should fail the live job before publishing; got '${failedMessage || "no failure"}'.`);
  }
  if (events.some((event) => event.startsWith("03-injector:") || event.startsWith("04-packager:"))) {
    throw new Error("Writer fallback must not continue into injector or packager.");
  }
  if (existsSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", fallbackJobId, "index.html")) ||
      existsSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${fallbackJobId}.zip`))) {
    throw new Error("Writer fallback must not publish final HTML or ZIP.");
  }
}

function verifyLegacyStage3Rejected() {
  let rejected = false;
  try {
    runStage3Wrapper({ html: "<html></html>", manifest: {}, content: {} });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("旧模板结构");
  }
  if (!rejected) {
    throw new Error("Legacy Stage3 input must fail instead of returning stale HTML.");
  }
}

async function verifyPromptResidueCase() {
  const parsed = parsePptV3MessageRequest({
    content:
      "制作一个16页HTML PPT，主题为AI Agent在中小企业的落地路线，约2500字，面向企业管理者，包含场景、成本、风险与90天实施计划。模板 01-tech-web3，不要图片，不要视频，不要图表，不要音频。",
    metadata: {
      templateId: "01-tech-web3",
      includeImages: false,
      includeVideo: false,
      includeChart: false,
      includeAudio: false
    },
    projectSelectedTemplateId: null,
    llmParse: {
      schemaVersion: "html-ppt-v3.intent.v1",
      action: "generate_deck",
      status: "complete",
      deck: {
        contentTheme: "AI Agent在中小企业的落地路线",
        title: "AI Agent在中小企业的落地路线",
        pageCount: 16,
        wordBudget: 2500,
        audience: "企业管理者",
        purpose: "包含场景、成本、风险与90天实施计划",
        tone: null,
        mustInclude: [],
        mustAvoid: []
      },
      quality: {
        confidence: 0.95,
        missingFields: [],
        ambiguities: []
      },
      extensions: {}
    }
  });
  if (!parsed.ok) throw new Error(`prompt-residue case should parse: ${parsed.issues.join("; ")}`);
  if (parsed.request.theme !== "AI Agent在中小企业的落地路线") {
    throw new Error(`prompt-residue case should use clean theme, got '${parsed.request.theme}'.`);
  }
  const jobId = "prompt-residue-tech-web3";
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", jobId), { recursive: true, force: true });
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${jobId}.zip`), { force: true });
  const result = await new HtmlPptV3AgentService().generate({
    jobId,
    request: parsed.request,
    llm: new FakeLlm(parsed.request),
    llmConfig: {
      id: "1",
      name: "fake",
      providerType: "openai",
      baseUrl: "http://localhost",
      apiKey: "fake",
      model: "fake",
      stageModelOverrides: {},
      enabled: true,
    } satisfies ActiveLlmConfig
  });
  const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
  for (const forbidden of [
    /制作一个16页HTML\s*报告/i,
    /SYSTEM_SYNC_COMPLETE/i,
    /GITHUB\.COM\/SMART-CITY-DAO/i,
    /0x1234\.\.\.ABCD\s*\/\/\s*PGP_SIGNED/i
  ]) {
    if (forbidden.test(html)) throw new Error(`prompt-residue case still contains ${forbidden}.`);
  }
  assertSlideNumbers(html, parsed.request.pageCount, jobId);
}

async function verifyLegacyNoMediaCase(legacyRequest: GenerateRequest, jobId: string) {
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", jobId), { recursive: true, force: true });
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${jobId}.zip`), { force: true });
  const progressDetails: string[] = [];
  const result = await new HtmlPptV3AgentService().generate({
    jobId,
    request: legacyRequest,
    llm: new FakeLlm(legacyRequest),
    llmConfig: {
      id: "1",
      name: "fake",
      providerType: "openai",
      baseUrl: "http://localhost",
      apiKey: "fake",
      model: "fake",
      stageModelOverrides: {},
      enabled: true,
    } satisfies ActiveLlmConfig,
    onProgress: (event) => {
      progressDetails.push(`${event.stage}:${event.status}:${event.detail}`);
    }
  });
  assertPoolBuildProgressShowsPhysicalPruning(progressDetails, jobId);
  const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
  assertHtmlDoesNotContainDisabledPages(html, legacyRequest);
  assertSlideNumbers(html, legacyRequest.pageCount, jobId);
  if (result.plan.slides.some((slide) => slide.pageType === "chart" || slide.pageType === "audio")) {
    throw new Error(`${jobId}: legacy missing includeChart/includeAudio request should not plan chart/audio slides.`);
  }
}

async function verifyImageGenerationCase() {
  const imageRequest: GenerateRequest = {
    theme: "智慧社区适老化服务路径",
    pageCount: 6,
    wordBudget: 1200,
    templateId: "06-realestate-smart",
    includeImages: true,
    includeVideo: false,
    includeChart: false,
    includeAudio: false,
    includeSpeakerNotes: false
  };
  const jobId = "image-generation-required";
  const generatedPrompts: string[] = [];
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", jobId), { recursive: true, force: true });
  rmSync(join(HTML_PPT_V3_OUTPUT_DIR, "output", `${jobId}.zip`), { force: true });
  const result = await new HtmlPptV3AgentService().generate({
    jobId,
    request: imageRequest,
    llm: new FakeLlm(imageRequest),
    imageClient: fakeImageClient(generatedPrompts),
    llmConfig: {
      id: "1",
      name: "fake",
      providerType: "openai",
      baseUrl: "http://localhost",
      apiKey: "fake",
      model: "fake",
      stageModelOverrides: {},
      enabled: true,
    } satisfies ActiveLlmConfig
  });
  const imagePool = buildAvailablePool(await loadManifestV2(imageRequest.templateId), imageRequest);
  const plannedImageSlides = result.plan.slides.filter((slide) => slide.fragmentId && imagePool.middle[slide.fragmentId]?.isImage);
  if (plannedImageSlides.length !== 3) {
    throw new Error(`includeImages=true should plan exactly three image fragments, got ${plannedImageSlides.length}.`);
  }
  const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
  if (!html.includes("img/generated/slide-")) {
    throw new Error("Generated image paths should be injected before local template image fallback.");
  }
  if (/https?:\/\/.+\.(?:png|jpe?g|webp|gif)/i.test(html)) {
    throw new Error("Generated HTML should not reference remote image URLs.");
  }
  if (!existsSync(join(result.outputDir, "img", "generated"))) {
    throw new Error("Generated image files should be packaged under img/generated.");
  }
  if (!generatedPrompts[0]?.includes("整套 PPT 主题") || !generatedPrompts[0]?.includes("当前页标题")) {
    throw new Error("Agent image generation should pass deck theme and current slide context into Stage 2.5 prompts.");
  }
  if (generatedPrompts[0]?.includes("整套 PPT 大纲")) {
    throw new Error("Agent image generation should not pass the full deck outline into Stage 2.5 prompts.");
  }
  if ((generatedPrompts[0]?.length ?? 0) >= 1500) {
    throw new Error(`Agent image generation prompt should stay below MiniMax limit, got ${generatedPrompts[0]?.length}.`);
  }
}

async function buildPlan(request: GenerateRequest): Promise<PlanIR> {
  const manifest = await loadManifestV2(request.templateId);
  const pool = buildAvailablePool(manifest, request);
  const middleFragments = Object.values(pool.middle);
  const requiredImageSlides = buildRequiredImageSlidePlan(request, pool);
  const requiredImageSlideByIndex = new Map(requiredImageSlides.map((entry) => [entry.slideIndex, entry]));
  const fallbackMiddle = middleFragments.find((summary) => summary.pageType === "grid-2" && !summary.isImage)
    ?? middleFragments.find((summary) => !summary.isImage)
    ?? middleFragments[0];
  const perPage = Math.round(request.wordBudget / request.pageCount);
  const slides: PlanIR["slides"] = [];

  for (let index = 1; index <= request.pageCount; index++) {
    const isMiddle = index > 1 && index < request.pageCount;
    const requiredImageSlide = requiredImageSlideByIndex.get(index);
    const selectedMiddle = requiredImageSlide ? pool.middle[requiredImageSlide.fragmentId] : fallbackMiddle;
    const pageType = index === 1
      ? "cover"
      : index === request.pageCount
        ? "closing"
        : selectedMiddle?.pageType ?? "title-text";
    const summary = pageType === "cover" ? pool.cover : pageType === "closing" ? pool.closing : selectedMiddle;
    slides.push({
      slideIndex: index,
      fragmentId: isMiddle ? selectedMiddle?.fragmentId : undefined,
      pageType: pageType as PlanIR["slides"][number]["pageType"],
      slideTitle: index === 1 ? request.theme.slice(0, 60) : index === request.pageCount ? "总结与行动" : `学习路径模块 ${index - 1}`,
      topicPoints: Array.from({ length: summary?.topicSlots ?? 1 }, (_, pointIndex) => `个性化学习要点 ${pointIndex + 1}`),
      charBudget: perPage
    });
  }

  return {
    templateId: request.templateId,
    totalChars: request.wordBudget,
    pageCount: request.pageCount,
    slides
  };
}

async function buildContent(request: GenerateRequest, plan: PlanIR, slideIndexes?: number[]): Promise<ContentIR> {
  const manifest = await loadManifestV2(request.templateId);
  const allowedIndexes = slideIndexes ? new Set(slideIndexes) : null;
  return {
    templateId: request.templateId,
    slides: plan.slides.filter((slide) => !allowedIndexes || allowedIndexes.has(slide.slideIndex)).map((slide) => {
      const fragment = getFragment(manifest, slide);
      const slotFills: Record<string, string> = {};
      for (const anchor of fragment?.anchors ?? []) {
        slotFills[anchor.slotId] = buildSlotText(anchor.slotId, slide.slideTitle, anchor.maxChars);
      }
      const chartDataBySlot = fragment?.chartSlots.length
        ? Object.fromEntries(fragment.chartSlots.map((slot) => [slot.slotId, {
            type: slot.defaultRenderType,
            labels: ["诊断", "推荐", "反馈"],
            datasets: [{ label: slide.slideTitle, data: [42, 67, 88] }]
          }]))
        : undefined;
      const imageHints = fragment?.imageSlotSelectors.length
        ? fragment.imageSlotSelectors.map((_selector, index) => `${request.theme} 配图 ${index + 1}`)
        : undefined;
      return {
        slideIndex: slide.slideIndex,
        fragmentId: slide.fragmentId,
        pageType: slide.pageType,
        slotFills,
        chartDataBySlot,
        imageHints
      };
    })
  };
}

function fakeImageClient(prompts: string[]): V3ImageGenerationClient {
  return {
    async generateImage(args) {
      prompts.push(args.prompt);
      const absolutePath = join(args.outputDir, `${args.fileBaseName}.png`);
      mkdirSync(args.outputDir, { recursive: true });
      writeFileSync(absolutePath, Buffer.from("fake image"));
      return {
        relativePath: `img/generated/${args.fileBaseName}.png`,
        absolutePath,
        warnings: []
      };
    }
  };
}

function assertPlannerPayloadDoesNotExposeDisabledPages(payload: Record<string, unknown>, request: GenerateRequest) {
  const availableMiddleFragments = Array.isArray(payload["availableMiddleFragments"])
    ? payload["availableMiddleFragments"] as Array<{ pageType?: string; isChart?: boolean; isAudio?: boolean; isImage?: boolean; isVideo?: boolean }>
    : [];
  if (!request.includeChart && (
    availableMiddleFragments.some((entry) => entry.pageType === "chart") ||
    availableMiddleFragments.some((entry) => entry.isChart === true) ||
    Array.isArray(payload["chartTypesAvailable"]) && payload["chartTypesAvailable"].length > 0
  )) {
    throw new Error("Planner prompt should not expose chart options when includeChart is missing/false.");
  }
  if (!request.includeAudio && (
    availableMiddleFragments.some((entry) => entry.pageType === "audio") ||
    availableMiddleFragments.some((entry) => entry.isAudio === true)
  )) {
    throw new Error("Planner prompt should not expose audio options when includeAudio is missing/false.");
  }
  if (!request.includeImages && availableMiddleFragments.some((entry) => entry.isImage === true)) {
    throw new Error("Planner prompt should not expose image fragments when includeImages is missing/false.");
  }
  if (!request.includeVideo && availableMiddleFragments.some((entry) => entry.isVideo === true)) {
    throw new Error("Planner prompt should not expose video fragments when includeVideo is missing/false.");
  }
}

function assertWriterPayloadDoesNotExposeDisabledPages(payload: Record<string, unknown>, request: GenerateRequest) {
  const slideSpecs = Array.isArray(payload["slideSpecs"]) ? payload["slideSpecs"] as Array<{ pageType?: string }> : [];
  const allowedPageTypes = Array.isArray(payload["allowedPageTypes"]) ? payload["allowedPageTypes"] as string[] : [];
  if (!request.includeChart && (
    allowedPageTypes.includes("chart") ||
    slideSpecs.some((spec) => spec.pageType === "chart") ||
    slideSpecs.some((spec) => Array.isArray((spec as { mediaKinds?: string[] }).mediaKinds) && (spec as { mediaKinds?: string[] }).mediaKinds!.includes("chart"))
  )) {
    throw new Error("Writer prompt should not expose chart slide specs when includeChart is missing/false.");
  }
  if (!request.includeAudio && (
    allowedPageTypes.includes("audio") ||
    slideSpecs.some((spec) => spec.pageType === "audio") ||
    slideSpecs.some((spec) => Array.isArray((spec as { mediaKinds?: string[] }).mediaKinds) && (spec as { mediaKinds?: string[] }).mediaKinds!.includes("audio"))
  )) {
    throw new Error("Writer prompt should not expose audio slide specs when includeAudio is missing/false.");
  }
  if (!request.includeImages && slideSpecs.some((spec) =>
    ((spec as { imageSlots?: number }).imageSlots ?? 0) > 0 ||
    (Array.isArray((spec as { mediaKinds?: string[] }).mediaKinds) && (spec as { mediaKinds?: string[] }).mediaKinds!.includes("image"))
  )) {
    throw new Error("Writer prompt should not expose image slide specs when includeImages is missing/false.");
  }
  if (!request.includeVideo && slideSpecs.some((spec) =>
    (spec as { requiresVideoHint?: boolean }).requiresVideoHint === true ||
    (Array.isArray((spec as { mediaKinds?: string[] }).mediaKinds) && (spec as { mediaKinds?: string[] }).mediaKinds!.includes("video"))
  )) {
    throw new Error("Writer prompt should not expose video slide specs when includeVideo is missing/false.");
  }
}

function assertHtmlDoesNotContainDisabledPages(html: string, request: GenerateRequest) {
  if (!request.includeChart && /data-page-type="chart"|canvas\s+data-chart-slot|chart-slide-/i.test(html)) {
    throw new Error("Generated HTML should not contain chart pages when includeChart is missing/false.");
  }
  if (!request.includeAudio && /data-page-type="audio"|<audio\b|audio-frame|audio-player|voice-wave/i.test(html)) {
    throw new Error("Generated HTML should not contain audio pages when includeAudio is missing/false.");
  }
  if (!request.includeImages && /<img\b|data-image-slot|img-wrap|url\(["']?(?:https?:\/\/|img\/)/i.test(html)) {
    throw new Error("Generated HTML should not contain image DOM when includeImages is missing/false.");
  }
  if (!request.includeVideo && /<video\b|data-video-slot|video-player|video-wrap/i.test(html)) {
    throw new Error("Generated HTML should not contain video DOM when includeVideo is missing/false.");
  }
}

function assertPoolBuildProgressShowsPhysicalPruning(progressDetails: string[], jobId: string) {
  const poolDetail = progressDetails.find((detail) => detail.startsWith("00-pool-build:completed:"));
  if (!poolDetail) throw new Error(`${jobId}: missing Stage 0 completed progress detail.`);
  for (const flag of ["includeImages=false", "includeVideo=false", "includeChart=false", "includeAudio=false"]) {
    if (!poolDetail.includes(flag)) {
      throw new Error(`${jobId}: Stage 0 progress should expose normalized media flag ${flag}.`);
    }
  }
  if (!poolDetail.includes("availableMiddleFragments=")) {
    throw new Error(`${jobId}: Stage 0 progress should expose availableMiddleFragments after physical pruning.`);
  }
  for (const mediaMarker of [":image", ":video", ":chart", ":audio"]) {
    if (poolDetail.includes(mediaMarker)) {
      throw new Error(`${jobId}: all-media-off Stage 0 pool should not expose ${mediaMarker} fragments.`);
    }
  }
}

function getFragment(manifest: TemplateManifestV2, slide: Pick<PlanIR["slides"][number], "pageType" | "fragmentId">): PageFragment | undefined {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}

function assertSlideNumbers(html: string, expectedTotal: number, jobId: string) {
  const sections = [...html.matchAll(/<section\b[\s\S]*?<\/section>/gi)].map((match) => match[0]);
  if (sections.length !== expectedTotal) {
    throw new Error(`${jobId}: expected ${expectedTotal} slides, got ${sections.length}.`);
  }
  sections.forEach((section, index) => {
    const expectedCurrent = String(index + 1);
    const expectedCurrentPadded = expectedCurrent.padStart(2, "0");
    const expectedTotalText = String(expectedTotal);
    const expectedTotalPadded = expectedTotalText.padStart(2, "0");
    if (!new RegExp(`data-slide-index="${expectedCurrent}"`, "i").test(section)
      || !new RegExp(`data-slide-total="${expectedTotalText}"`, "i").test(section)) {
      throw new Error(`${jobId}: slide ${index + 1} should store page state on section data-slide-index/data-slide-total.`);
    }
    for (const match of section.matchAll(/class="[^"]*\bslide-number\b[^"]*"[^>]*>/gi)) {
      const tag = match[0];
      if (!new RegExp(`data-current=["']${expectedCurrent}["']`, "i").test(tag)
        || !new RegExp(`data-total=["']${expectedTotalText}["']`, "i").test(tag)) {
        throw new Error(`${jobId}: slide ${index + 1} slide-number should keep actual data-current/data-total attributes for CSS attr() rendering.`);
      }
      if (section.includes(`${expectedCurrentPadded} / ${expectedTotalPadded}`)) {
        throw new Error(`${jobId}: slide ${index + 1} should not duplicate slide numbers as visible text.`);
      }
    }
  });
  if (!html.includes("progress-bar") || !html.includes("updateProgress")) {
    throw new Error(`${jobId}: generated deck should include V3 progress bar runtime support.`);
  }
}

function buildSlotText(slotId: string, title: string, maxChars: number) {
  const text = slotId === "title"
    ? title
    : slotId.includes("heading")
      ? "路径模块"
      : `${title} 围绕学习目标、能力诊断、内容推荐与反馈闭环展开。`;
  return text.slice(0, maxChars);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
