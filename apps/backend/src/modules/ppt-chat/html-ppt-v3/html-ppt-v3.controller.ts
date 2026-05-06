import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Patch,
  Delete,
  Body,
  Req,
  Res
} from "@nestjs/common";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";
import { ZodError } from "zod";
import { LlmConfigService } from "../../llm-config/llm-config.service";
import { LlmLoggingService } from "../../llm-logging/llm-logging.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { listAvailableTemplateV2Ids, loadManifestV2, resolveTemplateDir } from "./manifest/manifest-v2.loader";
import { HtmlPptV3AgentService, type V3ProgressEvent } from "./orchestration/html-ppt-v3-agent.service";
import { PptV3JobService } from "./jobs/ppt-v3-job.service";
import { PptV3ProjectService } from "./projects/ppt-v3-project.service";
import type { PostPptV3ProjectMessageInput } from "./projects/ppt-v3-project.types";
import {
  HTML_PPT_V3_STALE_TEMPLATE_MESSAGE,
  isHtmlPptV3StaleTemplateError,
  normalizeGenerateRequest,
  type GenerateRequest,
  type JobStatus,
  type PptV3StageHistoryEntry,
  type RunningJobStatus,
  type SSEEvent
} from "./shared";
import { resolvePreviewFile } from "./preview/preview-static";

type SseClient = {
  write: (event: SSEEvent) => void;
  close: () => void;
};

type StreamResponse = {
  setHeader: (name: string, value: string) => void;
  flushHeaders: () => void;
  write: (chunk: string) => void;
  end: () => void;
  on: (event: "close", listener: () => void) => void;
};

type FileResponse = NodeJS.WritableStream & {
  setHeader: (name: string, value: string) => void;
};

type TemplateAssetRequest = {
  params: Record<string, unknown>;
};

const STAGE_MAP: Record<string, Exclude<JobStatus, "pending" | "done" | "failed"> | null> = {
  "00-pool-build": null,
  "01-planner": "planning",
  "02-writer": "writing",
  "02_5-image-generation": "imaging",
  "03-injector": "injecting",
  "04-packager": "packaging"
};

@Controller("html-ppt-v3")
export class HtmlPptV3Controller {
  private readonly logger = new Logger(HtmlPptV3Controller.name);
  private readonly agentService = new HtmlPptV3AgentService();
  private readonly clients = new Map<string, Set<SseClient>>();

  constructor(
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(PptV3JobService) private readonly jobService: PptV3JobService,
    @Inject(PptV3ProjectService) private readonly projectService: PptV3ProjectService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService
  ) {}

  @Get("templates")
  async listTemplates() {
    const ids = await listAvailableTemplateV2Ids();
    const templates = await Promise.all(
      ids.map(async (id) => {
        try {
          const manifest = await loadManifestV2(id);
          return {
            id,
            label: manifest.label["zh-CN"] || manifest.label.en || id,
            description: manifest.description["zh-CN"] || manifest.description.en || "",
            capabilities: manifest.capabilities,
            deckClass: manifest.deckClass,
            aspectRatio: "16:9",
            rendererProfile: "landscape",
            ...(await buildTemplatePreviewPayload(id, manifest.cssFiles))
          };
        } catch {
          return { id, label: id, description: "", capabilities: null };
        }
      })
    );
    return { templates };
  }

  @Get("templates/:templateId/assets/*path")
  async serveTemplateAsset(@Param("templateId") templateId: string, @Req() req: TemplateAssetRequest, @Res() res: FileResponse) {
    try {
      const rawPath = getWildcardRequestPath(req);
      const file = await resolvePreviewFile(resolveTemplateDir(templateId), rawPath, { requireOutputMarker: false });
      res.setHeader("Content-Type", file.contentType);
      createReadStream(file.absolutePath).pipe(res);
    } catch {
      throw new NotFoundException("Template asset not found.");
    }
  }

  @Post("generate")
  async generate(@Body() rawBody: unknown, @CurrentUser() user: AuthenticatedUser) {
    const request = parseGenerateRequestOrThrow(rawBody);

    const job = await this.jobService.createJob(request, user.id);
    this.emit(job.id, { event: "job-created", data: { jobId: job.id } });
    void this.runJob(job.id, request, { ownerUserId: user.id });
    return { jobId: job.id };
  }

  @Get("projects")
  async listProjects(@CurrentUser() user: AuthenticatedUser) {
    return { projects: await this.projectService.listProjects(user.id) };
  }

  @Post("projects")
  async createProject(
    @Body() body: { title?: string; name?: string; selectedTemplateId?: string; templateId?: string },
    @CurrentUser() user: AuthenticatedUser
  ) {
    return {
      project: await this.projectService.createProject({
        ownerUserId: user.id,
        title: body.title ?? body.name,
        selectedTemplateId: body.selectedTemplateId ?? body.templateId ?? null
      })
    };
  }

  @Patch("projects/:projectId")
  async patchProject(
    @Param("projectId") projectId: string,
    @Body() body: { title?: string; name?: string; selectedTemplateId?: string; templateId?: string | null },
    @CurrentUser() user: AuthenticatedUser
  ) {
    return {
      project: await this.projectService.patchProject(projectId, user.id, {
        title: body.title ?? body.name,
        selectedTemplateId: body.selectedTemplateId ?? body.templateId
      })
    };
  }

  @Delete("projects/:projectId")
  async deleteProject(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.projectService.deleteProject(projectId, user.id);
    return { ok: true };
  }

  @Get("projects/:projectId/messages")
  async listProjectMessages(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const project = await this.projectService.requireProject(projectId, user.id);
    const messages = await this.projectService.listMessages(projectId, user.id);
    return { project, messages };
  }

  @Post("projects/:projectId/messages")
  async postProjectMessage(
    @Param("projectId") projectId: string,
    @Body() body: PostPptV3ProjectMessageInput,
    @CurrentUser() user: AuthenticatedUser
  ) {
    const result = await this.projectService.postMessage(projectId, user.id, body);
    if (result.job) {
      this.emit(result.job.id, { event: "job-created", data: { jobId: result.job.id } });
      void this.runJob(result.job.id, result.job.request, {
        ownerUserId: user.id,
        projectId: result.project.id,
        messageId: result.assistantMessage.id
      });
    }
    return result;
  }

  @Get("projects/:projectId/jobs")
  async listProjectJobs(@Param("projectId") projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return { jobs: await this.projectService.listJobs(projectId, user.id) };
  }

  @Post("projects/:projectId/generate")
  async generateForProject(
    @Param("projectId") projectId: string,
    @Body() rawBody: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    await this.projectService.requireProject(projectId, user.id);
    const request = parseGenerateRequestOrThrow(rawBody);
    const job = await this.jobService.createJob(request, user.id, projectId);
    this.emit(job.id, { event: "job-created", data: { jobId: job.id } });
    void this.runJob(job.id, request, { ownerUserId: user.id, projectId });
    return { jobId: job.id };
  }

  @Get("sse/:jobId")
  async streamEvents(
    @Param("jobId") jobId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: StreamResponse
  ) {
    const job = await this.jobService.requireOwnedJob(jobId, user.id);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const client: SseClient = {
      write: (event) => writeSse(res, event),
      close: () => res.end()
    };
    this.addClient(jobId, client);
    writeSse(res, { event: "job-created", data: { jobId } });
    this.replayCurrentState(job, client);

    res.on("close", () => this.removeClient(jobId, client));
  }

  @Get("download/:jobId")
  async download(
    @Param("jobId") jobId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: FileResponse
  ) {
    const job = await this.jobService.requireOwnedJob(jobId, user.id);
    if (job.status !== "done" || !job.zipPath || !existsSync(job.zipPath)) {
      throw new NotFoundException("Download is not available for this job.");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${basename(job.zipPath)}"`);
    createReadStream(job.zipPath).pipe(res);
  }

  private async runJob(
    jobId: string,
    request: GenerateRequest,
    context: { ownerUserId?: number | null; projectId?: string | null; messageId?: string | null } = {}
  ) {
    try {
      const llmConfig = await this.llmConfigService.getActiveConfig();
      const job = await this.jobService.getJob(jobId).catch(() => null);
      const result = await this.agentService.generate({
        jobId,
        request,
        llmConfig,
        userId: context.ownerUserId ?? job?.ownerUserId ?? undefined,
        logger: this.logger,
        loggingService: this.llmLoggingService,
        projectId: context.projectId ?? job?.projectId ?? null,
        messageId: context.messageId ?? null,
        onPlan: (plan) => this.jobService.savePlan(jobId, plan),
        onContent: (content) => this.jobService.saveContent(jobId, content),
        onProgress: (event) => this.handlePipelineProgress(jobId, event)
      });

      const doneJob = await this.jobService.markDone(jobId, {
        outputDir: result.outputDir,
        previewPath: result.previewPath,
        zipPath: result.zipPath
      });
      const previewUrl = `/html-ppt-v3/preview/${jobId}/index.html`;
      const downloadUrl = `/html-ppt-v3/download/${jobId}`;
      if (context.projectId && context.messageId) {
        await this.projectService.markJobMessageDone(context.projectId, context.messageId, {
          jobId,
          previewUrl,
          downloadUrl,
          warnings: result.warnings,
          modelCallCount: result.trace.modelCallCount
        }).catch((updateError) => {
          this.logger.warn(
            `Failed to update HTML-PPT v3 project message for job ${jobId}: ${formatPipelineError(updateError)}`
          );
        });
      }
      this.emit(jobId, {
        event: "done",
        data: {
          jobId,
          previewUrl,
          downloadUrl,
          warnings: result.warnings,
          modelCallCount: result.trace.modelCallCount,
          stageHistory: doneJob.stageHistory
        }
      });
      this.closeClients(jobId);
    } catch (error) {
      const message = formatPipelineError(error);
      this.logger.error(`HTML-PPT v3 job ${jobId} failed: ${message}`);
      await this.markRunningStageFailed(jobId, message);
      await this.jobService.setStatus(jobId, "failed", message).catch(() => undefined);
      if (context.projectId && context.messageId) {
        await this.projectService.markJobMessageFailed(context.projectId, context.messageId, {
          jobId,
          error: message
        }).catch((updateError) => {
          this.logger.warn(
            `Failed to update failed HTML-PPT v3 project message for job ${jobId}: ${formatPipelineError(updateError)}`
          );
        });
      }
      this.emit(jobId, { event: "error", data: { message } });
      this.closeClients(jobId);
    }
  }

  private async handlePipelineProgress(jobId: string, event: V3ProgressEvent) {
    const stage = STAGE_MAP[event.stage];
    if (!stage) {
      this.emit(jobId, { event: "progress", data: { percent: 5, message: event.detail } });
      return;
    }

    if (event.status === "running") {
      const updatedJob = await this.jobService.recordStageStart(jobId, stage, event.detail).catch(async () => {
        await this.jobService.setStatus(jobId, stage).catch(() => undefined);
        return null;
      });
      const entry = findStageHistoryEntry(updatedJob?.stageHistory, stage);
      this.emit(jobId, {
        event: "stage-start",
        data: {
          stage,
          detail: event.detail,
          ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
          ...(typeof entry?.elapsedMs === "number" ? { elapsedMs: entry.elapsedMs } : {}),
          ...(updatedJob?.stageHistory ? { stageHistory: updatedJob.stageHistory } : {})
        }
      });
      return;
    }

    if (event.status === "completed") {
      const summary = buildStageSummary(event);
      const updatedJob = await this.jobService.recordStageDone(jobId, stage, summary, event.detail).catch(() => null);
      const entry = findStageHistoryEntry(updatedJob?.stageHistory, stage);
      this.emit(jobId, {
        event: "stage-done",
        data: {
          stage,
          summary,
          ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
          ...(entry?.completedAt ? { completedAt: entry.completedAt } : {}),
          ...(typeof entry?.elapsedMs === "number" ? { elapsedMs: entry.elapsedMs } : {}),
          ...(updatedJob?.stageHistory ? { stageHistory: updatedJob.stageHistory } : {})
        }
      });
      return;
    }

    const updatedJob = await this.jobService.recordStageFailed(jobId, stage, event.detail).catch(() => null);
    const entry = findStageHistoryEntry(updatedJob?.stageHistory, stage);
    this.emit(jobId, {
      event: "error",
      data: {
        message: event.detail,
        stage,
        ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
        ...(entry?.completedAt ? { completedAt: entry.completedAt } : {}),
        ...(typeof entry?.elapsedMs === "number" ? { elapsedMs: entry.elapsedMs } : {})
      }
    });
  }

  private replayCurrentState(job: Awaited<ReturnType<PptV3JobService["requireJob"]>>, client: SseClient) {
    if (job.status === "done") {
      client.write({
        event: "done",
        data: {
          jobId: job.id,
          previewUrl: `/html-ppt-v3/preview/${job.id}/index.html`,
          downloadUrl: `/html-ppt-v3/download/${job.id}`,
          warnings: [],
          stageHistory: job.stageHistory
        }
      });
      client.close();
      return;
    }
    if (job.status === "failed") {
      client.write({ event: "error", data: { message: job.error ?? "HTML-PPT v3 job failed." } });
      client.close();
      return;
    }
    for (const entry of job.stageHistory) {
      if (entry.status === "done") {
        client.write({
          event: "stage-done",
          data: {
            stage: entry.stage,
            summary: entry.summary,
            startedAt: entry.startedAt,
            ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
            ...(typeof entry.elapsedMs === "number" ? { elapsedMs: entry.elapsedMs } : {})
          }
        });
      } else if (entry.status === "running") {
        client.write({
          event: "stage-start",
          data: {
            stage: entry.stage,
            startedAt: entry.startedAt,
            ...(entry.detail ? { detail: entry.detail } : {}),
            elapsedMs: Math.max(0, Date.now() - Date.parse(entry.startedAt))
          }
        });
      }
    }
    if (job.status !== "pending") {
      const existing = findStageHistoryEntry(job.stageHistory, job.status);
      if (!existing) client.write({ event: "stage-start", data: { stage: job.status } });
    }
  }

  private async markRunningStageFailed(jobId: string, message: string) {
    const job = await this.jobService.getJob(jobId).catch(() => null);
    if (!job || !isRunningJobStatus(job.status)) return;
    await this.jobService.recordStageFailed(jobId, job.status, message).catch(() => undefined);
  }

  private emit(jobId: string, event: SSEEvent) {
    const clients = this.clients.get(jobId);
    if (!clients) return;
    for (const client of clients) client.write(event);
  }

  private addClient(jobId: string, client: SseClient) {
    const clients = this.clients.get(jobId) ?? new Set<SseClient>();
    clients.add(client);
    this.clients.set(jobId, clients);
  }

  private removeClient(jobId: string, client: SseClient) {
    const clients = this.clients.get(jobId);
    if (!clients) return;
    clients.delete(client);
    if (clients.size === 0) this.clients.delete(jobId);
  }

  private closeClients(jobId: string) {
    const clients = this.clients.get(jobId);
    if (!clients) return;
    for (const client of clients) client.close();
    this.clients.delete(jobId);
  }
}

function buildStageSummary(event: V3ProgressEvent) {
  return {
    detail: event.detail,
    ...(event.source ? { source: event.source } : {}),
    ...(event.warnings?.length ? { warnings: event.warnings } : {}),
    ...(typeof event.modelCallCount === "number" ? { modelCallCount: event.modelCallCount } : {})
  };
}

function findStageHistoryEntry(stageHistory: PptV3StageHistoryEntry[] | undefined, stage: RunningJobStatus) {
  return stageHistory?.find((entry) => entry.stage === stage) ?? null;
}

function isRunningJobStatus(status: JobStatus): status is RunningJobStatus {
  return status === "planning" || status === "writing" || status === "imaging" || status === "injecting" || status === "packaging";
}

async function buildTemplatePreviewPayload(templateId: string, cssFiles: string[]) {
  const templateDir = resolveTemplateDir(templateId);
  const indexHtml = await readFile(posixToNativePath(templateDir, "index.html"), "utf8").catch(() => "");
  const previewSlides = extractSlideSections(indexHtml).map((slide) => rewriteTemplateHtmlAssetUrls(stripScripts(slide), templateId));
  const previewCss = (
    await Promise.all(
      cssFiles.map(async (cssFile) => {
        const css = await readFile(posixToNativePath(templateDir, cssFile), "utf8").catch(() => "");
        return rewriteTemplateCssAssetUrls(css, templateId, dirname(cssFile).replace(/\\/g, "/"));
      })
    )
  ).join("\n\n");

  return {
    previewSlides,
    previewCss
  };
}

function extractSlideSections(html: string) {
  const matches = html.match(/<section\b[^>]*\bslide\b[\s\S]*?<\/section>/gi) ?? [];
  return matches.slice(0, 40);
}

function stripScripts(html: string) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function rewriteTemplateHtmlAssetUrls(html: string, templateId: string) {
  const withAttributes = html.replace(
    /\b(src|href)=["']([^"']+)["']/gi,
    (match, attr: string, rawUrl: string) => {
      if (isExternalOrSpecialUrl(rawUrl)) return match;
      return `${attr}="${templateAssetUrl(templateId, rawUrl)}"`;
    }
  );
  return rewriteTemplateCssAssetUrls(withAttributes, templateId, ".");
}

function rewriteTemplateCssAssetUrls(css: string, templateId: string, cssDir: string) {
  return css.replace(/url\(([^)]+)\)/gi, (match, rawValue: string) => {
    const unquoted = rawValue.trim().replace(/^["']|["']$/g, "");
    if (isExternalOrSpecialUrl(unquoted)) return match;
    const resolved = normalizeRelativeAssetPath(cssDir === "." ? unquoted : posix.join(cssDir, unquoted));
    return `url("${templateAssetUrl(templateId, resolved)}")`;
  });
}

function templateAssetUrl(templateId: string, relativePath: string) {
  const cleanPath = normalizeRelativeAssetPath(relativePath);
  return `/api/html-ppt-v3/templates/${encodeURIComponent(templateId)}/assets/${cleanPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function normalizeRelativeAssetPath(input: string) {
  const normalized = posix.normalize(input.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return "index.html";
  }
  return normalized;
}

function isExternalOrSpecialUrl(url: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
}

function getWildcardRequestPath(req: TemplateAssetRequest) {
  const pathParam = req.params.path ?? req.params[0];
  if (Array.isArray(pathParam)) return pathParam.join("/");
  return String(pathParam ?? "");
}

function posixToNativePath(root: string, relativePath: string) {
  return `${root}/${relativePath}`.replace(/\//g, posix.sep === "/" ? "/" : "\\");
}

function writeSse(res: StreamResponse, event: SSEEvent) {
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function parseGenerateRequestOrThrow(rawBody: unknown): GenerateRequest {
  try {
    return normalizeGenerateRequest(rawBody);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestException(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    throw error;
  }
}

function formatPipelineError(error: unknown) {
  if (isHtmlPptV3StaleTemplateError(error)) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/i.test(message) && /fragments[\\/][^'"()\s]+\.html/i.test(message)) {
    return `${HTML_PPT_V3_STALE_TEMPLATE_MESSAGE} ${message}`;
  }
  return message;
}
