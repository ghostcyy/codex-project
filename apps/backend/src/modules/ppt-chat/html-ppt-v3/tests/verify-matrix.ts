import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HtmlPptV3AgentService } from "../orchestration/html-ppt-v3-agent.service";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";
import { listAvailableTemplateV2Ids, loadManifestV2 } from "../manifest/manifest-v2.loader";
import {
  buildAvailablePool,
  CHART_TYPES,
  HTML_PPT_V3_OUTPUT_DIR,
  isImagePageType,
  isVideoPageType,
  type ContentIR,
  type GenerateRequest,
  type PageFragment,
  type PageType,
  type PlanIR,
  type TemplateManifestV2
} from "../shared";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import type { V3ProgressEvent } from "../orchestration/html-ppt-v3-agent.service";
import type { V3ImageGenerationClient } from "../stages/stage2_5-image-generation";

type MatrixCase = {
  templateId: string;
  pageCount: number;
  includeImages: boolean;
  includeVideo: boolean;
  includeChart: boolean;
  includeAudio: boolean;
};

type MatrixCaseReport = MatrixCase & {
  jobId: string;
  status: "success" | "failed";
  plannerSource: "model" | "fallback" | null;
  writerSource: "model" | "fallback" | null;
  warningsCount: number;
  errorMessage: string | null;
  outputDirExists: boolean;
  indexHtmlExists: boolean;
  zipExists: boolean;
  navRuntimePresent: boolean;
  unresolvedPlaceholderCount: number;
};

const PAGE_COUNTS = [6, 12, 20] as const;
const MEDIA_COMBINATIONS = [
  { includeImages: false, includeVideo: false, includeChart: false, includeAudio: false },
  { includeImages: true, includeVideo: false, includeChart: false, includeAudio: false },
  { includeImages: false, includeVideo: true, includeChart: false, includeAudio: false },
  { includeImages: false, includeVideo: false, includeChart: true, includeAudio: false },
  { includeImages: true, includeVideo: true, includeChart: true, includeAudio: false }
] as const;
const REPORT_PATH = join(HTML_PPT_V3_OUTPUT_DIR, "matrix-report.json");
const EXPECTED_TEMPLATE_COUNT = 20;

const fakeLlmConfig = {
  id: "matrix-fake",
  name: "matrix-fake",
  providerType: "openai",
  baseUrl: "http://localhost",
  apiKey: "fake",
  model: "fake",
  stageModelOverrides: {},
  enabled: true
} satisfies ActiveLlmConfig;

class MatrixFakeLlm implements HtmlPptV3LLMClient {
  private plan: PlanIR | null = null;

  constructor(
    private readonly request: GenerateRequest,
    private readonly manifest: TemplateManifestV2,
    private readonly caseOrdinal: number
  ) {}

  async callStructured<T extends z.ZodTypeAny>(args: { userPrompt: string; schema: T }): Promise<z.infer<T>> {
    const payload = JSON.parse(args.userPrompt) as Record<string, unknown>;
    if (payload["availableMiddleFragments"]) {
      if (this.caseOrdinal % 37 === 0) {
        throw new Error("deterministic matrix planner fault");
      }
      this.plan = buildPlan(this.request, this.manifest);
      return args.schema.parse(this.plan);
    }
    if (payload["slideSpecs"]) {
      if (this.caseOrdinal % 41 === 0) {
        throw new Error("deterministic matrix writer fault");
      }
      if (!this.plan) {
        const slideSpecs = payload["slideSpecs"] as PlanIR["slides"] | undefined;
        this.plan = {
          templateId: this.request.templateId,
          totalChars: this.request.wordBudget,
          pageCount: this.request.pageCount,
          slides: slideSpecs ?? buildPlan(this.request, this.manifest).slides
        };
      }
      const batchSlideIndexes = Array.isArray(payload["batchSlideIndexes"])
        ? new Set((payload["batchSlideIndexes"] as unknown[]).map((value) => Number(value)))
        : new Set(((payload["slideSpecs"] as Array<{ slideIndex?: number }> | undefined) ?? []).map((slide) => Number(slide.slideIndex)));
      const batchPlan = {
        ...this.plan,
        slides: batchSlideIndexes.size
          ? this.plan.slides.filter((slide) => batchSlideIndexes.has(slide.slideIndex))
          : this.plan.slides
      };
      const content = buildContent(batchPlan, this.manifest);
      return args.schema.parse(content);
    }
    throw new Error("Unexpected V3 matrix prompt payload.");
  }
}

const matrixImageClient: V3ImageGenerationClient = {
  async generateImage({ outputDir, fileBaseName }) {
    mkdirSync(outputDir, { recursive: true });
    const absolutePath = join(outputDir, `${fileBaseName}.png`);
    writeFileSync(absolutePath, "matrix image");
    return {
      relativePath: `img/generated/${fileBaseName}.png`,
      absolutePath,
      warnings: []
    };
  }
};

async function main() {
  const allTemplateIds = await listAvailableTemplateV2Ids();
  const templateIds = allTemplateIds.slice(0, EXPECTED_TEMPLATE_COUNT);
  const manifestByTemplateId = new Map<string, TemplateManifestV2>();
  for (const templateId of templateIds) {
    manifestByTemplateId.set(templateId, await loadManifestV2(templateId));
  }
  const cases = buildCases(templateIds, manifestByTemplateId);
  const service = new HtmlPptV3AgentService();
  const reports: MatrixCaseReport[] = [];

  await mkdir(HTML_PPT_V3_OUTPUT_DIR, { recursive: true });

  for (const [caseIndex, matrixCase] of cases.entries()) {
    const jobId = buildJobId(caseIndex, matrixCase);
    reports.push(await runCase(service, matrixCase, jobId, caseIndex + 1));
  }

  const successful = reports.filter((entry) => entry.status === "success");
  const warningFree = reports.filter((entry) => entry.warningsCount === 0);
  const artifactFailures = successful.filter((entry) =>
    !entry.outputDirExists ||
    !entry.indexHtmlExists ||
    !entry.zipExists ||
    !entry.navRuntimePresent ||
    entry.unresolvedPlaceholderCount > 0
  );
  const successRate = reports.length === 0 ? 0 : successful.length / reports.length;
  const warningFreeRate = reports.length === 0 ? 0 : warningFree.length / reports.length;
  const summary = {
    generatedAt: new Date().toISOString(),
    reportPath: REPORT_PATH,
    totalCases: reports.length,
    templateCount: templateIds.length,
    availableTemplateCount: allTemplateIds.length,
    templateSelection: allTemplateIds.length > EXPECTED_TEMPLATE_COUNT
      ? `restricted to first ${EXPECTED_TEMPLATE_COUNT} sorted template IDs`
      : "all sorted template IDs",
    successCount: successful.length,
    successRate,
    warningFreeCount: warningFree.length,
    warningFreeRate,
    artifactFailureCount: artifactFailures.length,
    fallbackPlannerCount: reports.filter((entry) => entry.plannerSource === "fallback").length,
    fallbackWriterCount: reports.filter((entry) => entry.writerSource === "fallback").length
  };

  writeFileSync(REPORT_PATH, JSON.stringify({ summary, cases: reports }, null, 2), "utf8");

  console.log([
    "HTML-PPT v3 matrix verification",
    `templates: ${templateIds.length}/${allTemplateIds.length} (${summary.templateSelection})`,
    `cases: ${reports.length}`,
    `success: ${summary.successCount}/${reports.length} (${formatRate(successRate)})`,
    `warning-free: ${summary.warningFreeCount}/${reports.length} (${formatRate(warningFreeRate)})`,
    `fallbacks: planner=${summary.fallbackPlannerCount}, writer=${summary.fallbackWriterCount}`,
    `artifact failures among successes: ${summary.artifactFailureCount}`,
    `report: ${REPORT_PATH}`
  ].join("\n"));

  const gateFailures: string[] = [];
  if (successRate < 0.9) gateFailures.push(`successRate ${formatRate(successRate)} < 90%`);
  if (warningFreeRate < 0.8) gateFailures.push(`warning-free ${formatRate(warningFreeRate)} < 80%`);
  if (artifactFailures.length > 0) gateFailures.push(`${artifactFailures.length} successful case(s) failed artifact gates`);

  if (gateFailures.length) {
    throw new Error(`Matrix gates failed: ${gateFailures.join("; ")}`);
  }
}

async function runCase(
  service: HtmlPptV3AgentService,
  matrixCase: MatrixCase,
  jobId: string,
  caseOrdinal: number
): Promise<MatrixCaseReport> {
  const request: GenerateRequest = {
    theme: `Matrix QA ${matrixCase.templateId}`,
    pageCount: matrixCase.pageCount,
    wordBudget: matrixCase.pageCount * 220,
    templateId: matrixCase.templateId,
    includeImages: matrixCase.includeImages,
    includeVideo: matrixCase.includeVideo,
    includeChart: matrixCase.includeChart,
    includeAudio: matrixCase.includeAudio,
    includeSpeakerNotes: false
  };
  const manifest = await loadManifestV2(matrixCase.templateId);
  const outputDir = join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", jobId);
  const zipPath = join(HTML_PPT_V3_OUTPUT_DIR, "output", `${jobId}.zip`);
  const eventWarnings: string[] = [];

  rmSync(outputDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });

  try {
    const result = await service.generate({
      jobId,
      request,
      llm: new MatrixFakeLlm(request, manifest, caseOrdinal),
      imageClient: matrixImageClient,
      maxGeneratedImages: 999,
      llmConfig: fakeLlmConfig,
      onProgress: (event) => collectWarnings(event, eventWarnings)
    });
    const html = readFileSync(join(result.outputDir, "index.html"), "utf8");
    assertHtmlDoesNotContainDisabledMedia(html, request);
    return buildReport(matrixCase, jobId, "success", result.trace.plannerSource, result.trace.writerSource, [
      ...eventWarnings,
      ...result.warnings
    ], null, result.outputDir, result.zipPath);
  } catch (error) {
    return buildReport(
      matrixCase,
      jobId,
      "failed",
      null,
      null,
      eventWarnings,
      error instanceof Error ? error.message : String(error),
      outputDir,
      zipPath
    );
  }
}

function buildCases(templateIds: string[], manifestByTemplateId: Map<string, TemplateManifestV2>): MatrixCase[] {
  return templateIds.flatMap((templateId) =>
    PAGE_COUNTS.flatMap((pageCount) =>
      MEDIA_COMBINATIONS
        .filter((media) => {
          const manifest = manifestByTemplateId.get(templateId);
          return !media.includeImages || (manifest ? templateHasImageSlots(manifest) : false);
        })
        .map((media) => ({ templateId, pageCount, ...media }))
    )
  );
}

function templateHasImageSlots(manifest: TemplateManifestV2): boolean {
  return Object.values(manifest.pool).some((fragment) =>
    fragment.mediaKinds.includes("image") && (fragment.imageSlotSelectors?.length ?? 0) > 0
  );
}

function buildPlan(request: GenerateRequest, manifest: TemplateManifestV2): PlanIR {
  const pool = buildAvailablePool(manifest, request);
  const middleFragments = Object.values(pool.middle);
  const requiredImage = request.includeImages
    ? middleFragments.find((summary) => summary.isImage && summary.imageSlotCount > 0)
    : undefined;
  const preferred = middleFragments.filter((summary) => {
    return summary?.isChart ||
      (request.includeImages && summary?.isImage) ||
      (request.includeVideo && summary?.isVideo);
  });
  const requiredFirst = requiredImage ? [requiredImage] : [];
  const rotation = [
    ...requiredFirst,
    ...preferred.filter((summary) => summary !== requiredImage),
    ...middleFragments.filter((summary) => summary !== requiredImage && !preferred.includes(summary))
  ];
  const usableMiddle = rotation.length ? rotation : [];
  const perPage = Math.max(50, Math.round(request.wordBudget / request.pageCount));
  const slides: PlanIR["slides"] = [];

  for (let index = 1; index <= request.pageCount; index++) {
    const middle = usableMiddle[(index - 2) % Math.max(usableMiddle.length, 1)];
    const pageType: PageType = index === 1
      ? "cover"
      : index === request.pageCount
        ? "closing"
        : middle?.pageType ?? "title-text";
    slides.push({
      slideIndex: index,
      fragmentId: index > 1 && index < request.pageCount ? middle?.fragmentId : undefined,
      pageType,
      slideTitle: index === 1 ? request.theme.slice(0, 60) : index === request.pageCount ? "Matrix close" : `Matrix slide ${index}`,
      topicPoints: Array.from({ length: middle?.topicSlots ?? 2 }, (_, pointIndex) => `Point ${index}.${pointIndex + 1}`),
      chartType: middle?.isChart ? (middle.chartSlots[0]?.defaultRenderType ?? manifest.capabilities.chartTypes[0] ?? CHART_TYPES[0]) : undefined,
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

function buildContent(plan: PlanIR, manifest: TemplateManifestV2): ContentIR {
  return {
    templateId: plan.templateId,
    slides: plan.slides.map((slide) => {
      const fragment = getFragment(manifest, slide);
      const slotFills: Record<string, string> = {};
      for (const anchor of fragment?.anchors ?? []) {
        slotFills[anchor.slotId] = slotText(anchor.slotId, slide.slideTitle, anchor.maxChars);
      }
      const chartDataBySlot = fragment?.chartSlots.length
        ? Object.fromEntries(fragment.chartSlots.map((slot) => [slot.slotId, {
            type: slot.defaultRenderType,
            labels: ["A", "B", "C", "D"],
            datasets: [{ label: slide.slideTitle, data: [20, 45, 70, 90] }]
          }]))
        : undefined;
      return {
        slideIndex: slide.slideIndex,
        fragmentId: slide.fragmentId,
        pageType: slide.pageType,
        slotFills,
        chartDataBySlot,
        chartData: slide.pageType === "chart" && !chartDataBySlot
          ? {
              type: slide.chartType ?? "bar",
              labels: ["A", "B", "C", "D"],
              datasets: [{ label: slide.slideTitle, data: [20, 45, 70, 90] }]
            }
          : undefined,
        imageHints: fragment?.mediaKinds.includes("image") || isImagePageType(slide.pageType) ? [`Image for ${slide.slideTitle}`] : undefined,
        videoHint: fragment?.mediaKinds.includes("video") || isVideoPageType(slide.pageType) ? `Video for ${slide.slideTitle}` : undefined
      };
    })
  };
}

function slotText(slotId: string, title: string, maxChars: number): string {
  const text = slotId === "title"
    ? title
    : slotId.includes("heading")
      ? "Matrix QA"
      : `${title} validates deterministic content injection, packaging, navigation, and placeholder cleanup.`;
  return text.slice(0, maxChars);
}

function collectWarnings(event: V3ProgressEvent, warnings: string[]) {
  if (event.warnings?.length) warnings.push(...event.warnings);
}

function buildReport(
  matrixCase: MatrixCase,
  jobId: string,
  status: "success" | "failed",
  plannerSource: "model" | "fallback" | null,
  writerSource: "model" | "fallback" | null,
  warnings: string[],
  errorMessage: string | null,
  outputDir: string,
  zipPath: string
): MatrixCaseReport {
  const indexPath = join(outputDir, "index.html");
  const indexHtmlExists = existsSync(indexPath);
  const html = indexHtmlExists ? readFileSync(indexPath, "utf8") : "";
  return {
    ...matrixCase,
    jobId,
    status,
    plannerSource,
    writerSource,
    warningsCount: warnings.length,
    errorMessage,
    outputDirExists: existsSync(outputDir),
    indexHtmlExists,
    zipExists: existsSync(zipPath),
    navRuntimePresent: html.includes("data-html-ppt-v3-nav-runtime"),
    unresolvedPlaceholderCount: (html.match(/{{[^}]+}}/g) ?? []).length
  };
}

function assertHtmlDoesNotContainDisabledMedia(html: string, request: GenerateRequest) {
  if (!request.includeImages && /<img\b|data-image-slot|img-wrap|url\(["']?(?:https?:\/\/|img\/)/i.test(html)) {
    throw new Error("Generated HTML should not contain image DOM when includeImages=false.");
  }
  if (!request.includeVideo && /<video\b|data-video-slot|video-player|video-wrap/i.test(html)) {
    throw new Error("Generated HTML should not contain video DOM when includeVideo=false.");
  }
  if (!request.includeChart && /data-page-type="chart"|canvas\s+data-chart-slot|chart-slide-/i.test(html)) {
    throw new Error("Generated HTML should not contain chart DOM when includeChart=false.");
  }
  if (!request.includeAudio && /data-page-type="audio"|<audio\b|audio-frame|audio-player|voice-wave/i.test(html)) {
    throw new Error("Generated HTML should not contain audio DOM when includeAudio=false.");
  }
}

function getFragment(manifest: TemplateManifestV2, slide: Pick<PlanIR["slides"][number], "pageType" | "fragmentId">): PageFragment | undefined {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}

function buildJobId(caseIndex: number, matrixCase: MatrixCase): string {
  const media = [
    matrixCase.includeImages ? "img" : "noimg",
    matrixCase.includeVideo ? "vid" : "novid",
    matrixCase.includeChart ? "chart" : "nochart",
    matrixCase.includeAudio ? "audio" : "noaudio"
  ].join("-");
  return `matrix-${String(caseIndex + 1).padStart(3, "0")}-${matrixCase.templateId}-${matrixCase.pageCount}-${media}`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
