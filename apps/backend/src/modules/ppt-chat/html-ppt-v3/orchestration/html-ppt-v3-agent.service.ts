import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { loadManifestV2, resolveTemplateDir } from "../manifest/manifest-v2.loader";
import { packageDeck } from "../packager/zip-packager";
import { runStage0PoolBuild } from "../stages/stage0-pool-build";
import { runStage1Planner } from "../stages/stage1-planner";
import { runStage25ImageGeneration, type V3ImageGenerationClient } from "../stages/stage2_5-image-generation";
import { runStage2Writer } from "../stages/stage2-writer";
import { runStage3Injector } from "../stages/stage3-injector";
import { MiniMaxImageClient } from "../image-gen";
import { HTML_PPT_V3_OUTPUT_DIR, normalizeGenerateRequest, type AvailablePool, type ContentIR, type GenerateRequest, type PageTypeSummary, type PlanIR } from "../shared";
import { HtmlPptV3LlmClient, type HtmlPptV3LLMClient } from "./html-ppt-v3-llm-client";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import type { LlmLoggingService } from "../../../llm-logging/llm-logging.service";
import type { Logger } from "@nestjs/common";

export type HtmlPptV3AgentInput = {
  jobId: string;
  request: GenerateRequest;
  llmConfig: ActiveLlmConfig;
  userId?: number;
  projectId?: string | null;
  messageId?: string | null;
  logger?: Logger;
  loggingService?: LlmLoggingService;
  llm?: HtmlPptV3LLMClient;
  allowModelFallback?: boolean;
  imageClient?: V3ImageGenerationClient;
  maxGeneratedImages?: number;
  onProgress?: (event: V3ProgressEvent) => void | Promise<void>;
  onPlan?: (plan: PlanIR) => void | Promise<void>;
  onContent?: (content: ContentIR) => void | Promise<void>;
};

export type V3ProgressEvent = {
  stage: string;
  status: "running" | "completed" | "failed";
  detail: string;
  timestamp: string;
  source?: "model" | "fallback";
  warnings?: string[];
  modelCallCount?: number;
};

export type HtmlPptV3AgentResult = {
  jobId: string;
  outputDir: string;
  previewPath: string;
  zipPath: string;
  warnings: string[];
  plan: PlanIR;
  content: ContentIR;
  trace: {
    templateId: string;
    totalSlides: number;
    plannerSource: "model" | "fallback";
    writerSource: "model" | "fallback";
    modelCallCount: number;
    injectorWarnings: string[];
  };
};

export class HtmlPptV3AgentService {
  async generate(input: HtmlPptV3AgentInput): Promise<HtmlPptV3AgentResult> {
    const request = normalizeGenerateRequest(input.request);
    const warnings: string[] = [];
    const llm = input.llm ?? new HtmlPptV3LlmClient(
      input.llmConfig,
      input.logger,
      input.loggingService,
      input.userId,
      input.projectId,
      input.messageId,
      input.jobId
    );

    try {
      const workdir = join(HTML_PPT_V3_OUTPUT_DIR, "workdirs", input.jobId);
      const zipPath = join(HTML_PPT_V3_OUTPUT_DIR, "output", `${input.jobId}.zip`);
      await rm(workdir, { recursive: true, force: true });
      await rm(zipPath, { force: true });

      await this.emit(input, "00-pool-build", "running", `Loading template '${request.templateId}'`);
      const manifest = await loadManifestV2(request.templateId);
      const templateDir = resolveTemplateDir(request.templateId);
      const poolResult = runStage0PoolBuild({ request, manifest });
      const poolDetail = this.formatPoolBuildDetail(request, poolResult.pool);
      input.logger?.log?.(`[html-ppt-v3] ${poolDetail}`);
      await this.emit(input, "00-pool-build", "completed", poolDetail);

      await this.emit(input, "01-planner", "running", "Planning slide structure");
      const planResult = await runStage1Planner({ request, pool: poolResult.pool, llm });
      if (planResult.source === "fallback" && !input.allowModelFallback) {
        const message = formatModelFallbackError("planner", planResult.validationErrors);
        await this.emit(input, "01-planner", "failed", message, {
          source: "fallback",
          warnings: planResult.validationErrors,
          modelCallCount: getModelCallCount(llm)
        });
        throw new Error(message);
      }
      await input.onPlan?.(planResult.plan);
      await this.emit(input, "01-planner", "completed",
        `Planner source=${planResult.source}; ${planResult.plan.slides.length} slides planned.`,
        { source: planResult.source, warnings: planResult.validationErrors, modelCallCount: getModelCallCount(llm) });

      await this.emit(input, "02-writer", "running", "Writing slide content");
      const writeResult = await runStage2Writer({ plan: planResult.plan, manifest, llm });
      if (writeResult.source === "fallback" && !input.allowModelFallback) {
        const message = formatModelFallbackError("writer", writeResult.validationErrors);
        await this.emit(input, "02-writer", "failed", message, {
          source: "fallback",
          warnings: writeResult.validationErrors,
          modelCallCount: getModelCallCount(llm)
        });
        throw new Error(message);
      }
      await input.onContent?.(writeResult.content);
      await this.emit(input, "02-writer", "completed",
        `Writer source=${writeResult.source}; ${writeResult.content.slides.length} slides written.`,
        { source: writeResult.source, warnings: writeResult.validationErrors, modelCallCount: getModelCallCount(llm) });

      await rm(workdir, { recursive: true, force: true });
      await mkdir(workdir, { recursive: true });

      await this.emit(input, "02_5-image-generation", "running", "Generating image assets for selected image pages");
      const imageResult = await runStage25ImageGeneration({
        request,
        plan: planResult.plan,
        content: writeResult.content,
        manifest,
        workdir,
        imageClient: input.imageClient ?? new MiniMaxImageClient({ config: input.llmConfig }),
        maxImages: input.maxGeneratedImages,
      });
      warnings.push(...imageResult.warnings);
      await this.emit(input, "02_5-image-generation", "completed",
        `Image generation complete; requested=${imageResult.requestedCount}, generated=${imageResult.generatedCount}, skipped=${imageResult.skippedCount}.`,
        { source: imageResult.generatedCount > 0 ? "model" : "fallback", warnings: imageResult.warnings });

      await this.emit(input, "03-injector", "running", "Injecting content into template fragments");
      const injected = runStage3Injector({
        manifest,
        plan: planResult.plan,
        content: writeResult.content,
        templateDir,
        workdir,
        jobId: input.jobId,
        generatedImages: imageResult.generatedImages,
      });
      warnings.push(...injected.warnings);
      await this.emit(input, "03-injector", "completed",
        `Injection complete; ${injected.warnings.length} warnings.`,
        { warnings: injected.warnings });

      await this.emit(input, "04-packager", "running", "Packaging ZIP");
      const packaged = await packageDeck({
        templateDir,
        injectedHtml: injected.html,
        templateId: request.templateId,
        deckTitle: request.theme,
        jobId: input.jobId,
        preparedWorkdir: injected.workdir
      });
      await this.emit(input, "04-packager", "completed", `ZIP ready: ${packaged.zipPath}`);

      return {
        jobId: input.jobId,
        outputDir: packaged.outputDir,
        previewPath: packaged.outputDir,
        zipPath: packaged.zipPath,
        warnings,
        plan: planResult.plan,
        content: writeResult.content,
        trace: {
          templateId: request.templateId,
          totalSlides: planResult.plan.slides.length,
          plannerSource: planResult.source,
          writerSource: writeResult.source,
          modelCallCount: getModelCallCount(llm),
          injectorWarnings: injected.warnings
        }
      };
    } catch (err) {
      await this.emit(input, "pipeline", "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private formatPoolBuildDetail(request: GenerateRequest, pool: AvailablePool) {
    const availableMiddleFragments = Object.values(pool.middle)
      .filter((summary): summary is PageTypeSummary => Boolean(summary))
      .map((summary) => {
        const mediaKinds = [
          summary.isImage ? "image" : "",
          summary.isVideo ? "video" : "",
          summary.isChart ? "chart" : "",
          summary.isAudio ? "audio" : "",
        ].filter(Boolean);
        return `${summary.fragmentId}/${summary.pageType}${mediaKinds.length ? `:${mediaKinds.join("+")}` : ""}`;
      });

    return [
      `Normalized request: templateId=${request.templateId}`,
      `pageCount=${request.pageCount}`,
      `wordBudget=${request.wordBudget}`,
      `includeImages=${request.includeImages}`,
      `includeVideo=${request.includeVideo}`,
      `includeChart=${request.includeChart}`,
      `includeAudio=${request.includeAudio}`,
      `availableMiddleFragments=${availableMiddleFragments.join(", ") || "none"}`,
    ].join("; ");
  }

  private async emit(
    input: HtmlPptV3AgentInput,
    stage: string,
    status: "running" | "completed" | "failed",
    detail: string,
    extra: Pick<V3ProgressEvent, "source" | "warnings" | "modelCallCount"> = {}
  ) {
    await input.onProgress?.({ stage, status, detail, timestamp: new Date().toISOString(), ...extra });
  }
}

function getModelCallCount(llm: HtmlPptV3LLMClient): number {
  const maybeCounting = llm as HtmlPptV3LLMClient & { getModelCallCount?: () => number };
  return typeof maybeCounting.getModelCallCount === "function" ? maybeCounting.getModelCallCount() : 0;
}

function formatModelFallbackError(stage: "planner" | "writer", validationErrors: string[]): string {
  const label = stage === "planner" ? "Stage 1 planner" : "Stage 2 writer";
  const reason = validationErrors.filter(Boolean).slice(-3).join(" | ") || "model output failed validation";
  return `${label} fell back to local fallback and cannot be published in live jobs. Reason: ${reason}`;
}
