import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { BadRequestException, Body, Controller, Get, Inject, Logger, Param, Post, Query, Res, StreamableFile, UnauthorizedException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { DatabaseService } from "../../database/database.service";
import { LlmConfigService } from "../../llm-config/llm-config.service";
import { LlmLoggingService } from "../../llm-logging/llm-logging.service";
import { normalizeTemplatePackageId, resolveTemplatePackageSelection, SkillRegistryService, type SkillRegistry, type TemplatePackage } from "./registry";
import { HtmlPptV2JsonModelClient, HtmlPptV2PublishService, type HtmlPptV2ProgressEvent, type HtmlPptV2PublishResult } from "./orchestration";
import { CriticBlockedError } from "./stages";

type GenerateV2DeckBody = {
  prompt?: unknown;
  templateId?: unknown;
};

type V2DeckJobStatus = "queued" | "running" | "completed" | "failed";
type V2DeckJobStageStatus = "pending" | HtmlPptV2ProgressEvent["status"];

type V2DeckJobStage = {
  id: string;
  name: string;
  status: V2DeckJobStageStatus;
  detail: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs: number;
  modelCalls: number;
  retryCount: number;
  failureReason?: string;
};

type V2DeckResponse = {
  deckId: string;
  title: string;
  status: string;
  previewUrl: string;
  downloadUrl: string;
  manifestUrl: string;
  verificationReportUrl: string;
  verification: Record<string, unknown>;
  screenshots: Array<{ slideIndex: number; url: string }>;
  auxiliaryArtifacts: Record<string, string>;
  templateSelection: {
    mode: string;
    chosenTemplateId: string;
    shortlist: string[];
    rationale: string;
    confidence: string;
  };
  trace: unknown;
};

type V2DeckJob = {
  jobId: string;
  userId: number;
  prompt: string;
  status: V2DeckJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs: number;
  modelCalls: number;
  error?: string;
  stages: V2DeckJobStage[];
  result?: V2DeckResponse;
};

interface V2DeckJobRow extends QueryResultRow {
  id: string;
  user_id: number | string;
  prompt: string;
  status: string;
  stages: unknown;
  result: unknown | null;
  error: string | null;
  model_calls: number | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const V2_JOB_STAGE_DEFINITIONS = [
  ["01-intent", "01 Intent"],
  ["01b-template-select", "01b Template Select"],
  ["02-evidence", "02 Evidence"],
  ["03-narrative", "03 Narrative"],
  ["04-design", "04 Design"],
  ["05-layout", "05 Layout"],
  ["06-slots", "06 Slots"],
  ["07-assets", "07 Assets"],
  ["08-choreography", "08 Choreography"],
  ["09-critic", "09 Critic"],
  ["10-render", "10 Render"],
  ["11-verify", "11 Verify"],
  ["12-artifacts", "12 Artifacts"],
  ["13-publish", "13 Publish"]
] as const;

@Controller("ppt/v2/decks")
export class HtmlPptV2Controller {
  private readonly logger = new Logger(HtmlPptV2Controller.name);
  private readonly jobs = new Map<string, V2DeckJob>();

  constructor(
    @Inject(HtmlPptV2PublishService) private readonly publishService: HtmlPptV2PublishService,
    @Inject(SkillRegistryService) private readonly registryService: SkillRegistryService,
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService
  ) {}

  @Post()
  async generateDeck(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body?: GenerateV2DeckBody,
    @Query("allowFailures") allowFailures?: string
  ) {
    const currentUser = this.requireUser(user);
    const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "";
    if (!prompt) {
      throw new BadRequestException("请先输入 HTML-PPT v2 生成需求。");
    }

    const registry = await this.registryService.hydrate();
    const pinnedTemplate = this.resolvePinnedTemplate(registry, body?.templateId);
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const model = new HtmlPptV2JsonModelClient({
      config: activeConfig,
      userId: currentUser.id,
      logger: this.logger,
      loggingService: this.llmLoggingService
    });
    let result;
    try {
      result = await this.publishService.generateAndPublish({
        userPrompt: prompt,
        registry,
        model,
        pinnedTemplate,
        userPreferences: {
          templateId: this.normalizeTemplateId(body?.templateId) ?? "auto"
        },
        outputRoot: this.userDeckRoot(currentUser.id),
        projectSlug: "html-ppt-v2",
        allowVerificationFailure: allowFailures === "true" || allowFailures === "1"
      });
    } catch (error) {
      if (error instanceof CriticBlockedError) {
        const payload = this.formatCriticBlockedPayload(error);
        this.logger.warn(`HTML-PPT v2 critic blocked publication: ${payload.summary}`);
        throw new UnprocessableEntityException(payload);
      }
      const detail = formatErrorDetail(error);
      this.logger.error(`HTML-PPT v2 generation failed: ${detail}`);
      throw new ServiceUnavailableException({
        message: "HTML-PPT v2 生成失败。"
      });
    }

    return this.formatDeckResponse(result);
  }

  @Post("jobs")
  async createDeckJob(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body?: GenerateV2DeckBody,
    @Query("allowFailures") allowFailures?: string
  ) {
    const currentUser = this.requireUser(user);
    const prompt = typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : "";
    if (!prompt) {
      throw new BadRequestException("请先输入 HTML-PPT v2 生成需求。");
    }
    await this.cleanupJobs();
    const registry = await this.registryService.hydrate();
    this.resolvePinnedTemplate(registry, body?.templateId);
    const now = new Date().toISOString();
    const job: V2DeckJob = {
      jobId: randomUUID(),
      userId: currentUser.id,
      prompt,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      elapsedMs: 0,
      modelCalls: 0,
      stages: V2_JOB_STAGE_DEFINITIONS.map(([id, name]) => ({
        id,
        name,
        status: "pending",
        detail: "Waiting.",
        elapsedMs: 0,
        modelCalls: 0,
        retryCount: 0
      }))
    };
    this.jobs.set(job.jobId, job);
    await this.insertDeckJob(job, allowFailures === "true" || allowFailures === "1");
    void this.runDeckJob(currentUser.id, prompt, job, allowFailures === "true" || allowFailures === "1", body?.templateId);
    return this.serializeJob(job);
  }

  @Get("jobs")
  async listDeckJobs(@CurrentUser() user: AuthenticatedUser | undefined) {
    const currentUser = this.requireUser(user);
    await this.cleanupJobs();
    const result = await this.databaseService.query<V2DeckJobRow>(
      `
        SELECT id,
               user_id,
               prompt,
               status,
               stages,
               result,
               error,
               model_calls,
               started_at,
               ended_at,
               created_at,
               updated_at
        FROM ppt_v2_deck_jobs
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 100
      `,
      [currentUser.id]
    );
    return result.rows.map((row) => {
      const cached = this.jobs.get(row.id);
      const job = cached?.userId === currentUser.id ? cached : this.deckJobFromRow(row);
      return this.serializeJob(job);
    });
  }

  @Get("jobs/:jobId")
  async getDeckJob(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("jobId") jobId: string
  ) {
    const currentUser = this.requireUser(user);
    const cachedJob = this.jobs.get(jobId);
    const job = cachedJob?.userId === currentUser.id ? cachedJob : await this.findDeckJob(currentUser.id, jobId);
    if (!job || job.userId !== currentUser.id) {
      throw new NotFoundException("HTML-PPT v2 job 不存在。");
    }
    return this.serializeJob(job);
  }

  @Get(":deckId/preview.html")
  getPreview(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    return this.streamDeckFile(user, deckId, "preview.html", "inline", response);
  }

  @Get(":deckId/style.css")
  getStyle(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    return this.streamDeckFile(user, deckId, "style.css", "inline", response);
  }

  @Get(":deckId/assets/:file")
  getAsset(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Param("file") file: string,
    @Res({ passthrough: true }) response: any
  ) {
    const safeFile = this.safeSimpleFileName(file);
    return this.streamDeckFile(user, deckId, join("assets", safeFile), "inline", response);
  }

  @Get(":deckId/manifest.json")
  getManifest(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    return this.streamDeckFile(user, deckId, "manifest.json", "inline", response);
  }

  @Get(":deckId/verification-report.json")
  getVerificationReport(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    return this.streamDeckFile(user, deckId, "verification-report.json", "inline", response);
  }

  @Get(":deckId/screenshots/:file")
  getScreenshot(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Param("file") file: string,
    @Res({ passthrough: true }) response: any
  ) {
    const safeFile = this.safeSimpleFileName(file);
    return this.streamDeckFile(user, deckId, join("screenshots", safeFile), "inline", response);
  }

  @Get(":deckId/artifacts/:file")
  getArtifact(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Param("file") file: string,
    @Res({ passthrough: true }) response: any
  ) {
    const safeFile = this.safeSimpleFileName(file);
    return this.streamDeckFile(user, deckId, safeFile, "inline", response);
  }

  @Get(":deckId/download.zip")
  downloadZip(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    return this.streamDeckFile(user, deckId, "html-ppt-deck.zip", "attachment", response);
  }

  private streamDeckFile(
    user: AuthenticatedUser | undefined,
    deckId: string,
    fileName: string,
    disposition: "inline" | "attachment",
    response: any
  ) {
    const currentUser = this.requireUser(user);
    const fullPath = this.resolveDeckFile(currentUser.id, deckId, fileName);
    response.setHeader("Content-Type", contentTypeFor(fullPath));
    response.setHeader("Content-Disposition", `${disposition}; filename="${basename(fullPath)}"`);
    return new StreamableFile(createReadStream(fullPath));
  }

  private resolveDeckFile(userId: number, deckId: string, fileName: string) {
    const root = this.userDeckRoot(userId);
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(deckId)) {
      throw new NotFoundException("HTML-PPT v2 deck 不存在。");
    }
    const deckRoot = resolve(root, deckId);
    const fullPath = resolve(deckRoot, fileName);
    const safeRoot = deckRoot.endsWith(sep) ? deckRoot : `${deckRoot}${sep}`;
    if (!fullPath.startsWith(safeRoot) || !existsSync(fullPath)) {
      throw new NotFoundException("HTML-PPT v2 deck 文件不存在。");
    }
    return fullPath;
  }

  private userDeckRoot(userId: number) {
    return resolve(findWorkspaceRoot(process.cwd()), ".local-runtime", "html-ppt-v2", "published", String(userId));
  }

  private safeSimpleFileName(value: string) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
      throw new NotFoundException("HTML-PPT v2 asset 不存在。");
    }
    return value;
  }

  private normalizeTemplateId(value: unknown) {
    return normalizeTemplatePackageId(value);
  }

  private resolvePinnedTemplate(registry: SkillRegistry, value: unknown): TemplatePackage | undefined {
    const resolution = resolveTemplatePackageSelection(registry, value);
    if (resolution.kind === "auto") {
      return undefined;
    }
    if (resolution.kind === "unknown") {
      throw new BadRequestException(`未知的 HTML-PPT v2 模板：${resolution.templateId}。请重新选择模板或使用 Auto。`);
    }
    return resolution.template;
  }

  private requireUser(user?: AuthenticatedUser) {
    if (!user) {
      throw new UnauthorizedException("Authenticated user context is unavailable.");
    }
    return user;
  }

  private async runDeckJob(userId: number, prompt: string, job: V2DeckJob, allowVerificationFailure: boolean, templateId?: unknown) {
    const startedAt = new Date().toISOString();
    job.status = "running";
    job.startedAt = startedAt;
    job.updatedAt = startedAt;
    await this.persistDeckJob(job, allowVerificationFailure);
    try {
      const registry = await this.registryService.hydrate();
      const pinnedTemplate = this.resolvePinnedTemplate(registry, templateId);
      const activeConfig = await this.llmConfigService.getActiveConfig();
      const model = new HtmlPptV2JsonModelClient({
        config: activeConfig,
        userId,
        logger: this.logger,
        loggingService: this.llmLoggingService
      });
      const result = await this.publishService.generateAndPublish({
        userPrompt: prompt,
        registry,
        model,
        pinnedTemplate,
        userPreferences: {
          templateId: this.normalizeTemplateId(templateId) ?? "auto"
        },
        outputRoot: this.userDeckRoot(userId),
        projectSlug: "html-ppt-v2",
        allowVerificationFailure,
        onProgress: async (event) => {
          this.applyProgress(job, event);
          await this.persistDeckJob(job, allowVerificationFailure);
        }
      });
      const endedAt = new Date().toISOString();
      job.result = this.formatDeckResponse(result);
      job.status = "completed";
      job.endedAt = endedAt;
      job.updatedAt = endedAt;
      job.modelCalls = result.trace.modelCalls;
      await this.persistDeckJob(job, allowVerificationFailure);
    } catch (error) {
      const endedAt = new Date().toISOString();
      const detail = formatErrorDetail(error);
      this.logger.error(`HTML-PPT v2 job failed: ${detail}`);
      job.status = "failed";
      job.error = error instanceof CriticBlockedError
        ? this.formatCriticBlockedPayload(error).summary
        : "HTML-PPT v2 生成失败。请查看后端日志定位详细原因。";
      job.endedAt = endedAt;
      job.updatedAt = endedAt;
      const runningStage = job.stages.find((stage) => stage.status === "running");
      if (runningStage) {
        runningStage.status = "failed";
        runningStage.endedAt = endedAt;
        runningStage.failureReason = job.error;
        runningStage.detail = job.error;
      }
      await this.persistDeckJob(job, allowVerificationFailure);
    }
  }

  private applyProgress(job: V2DeckJob, event: HtmlPptV2ProgressEvent) {
    const stage = job.stages.find((item) => item.id === event.stageId);
    if (!stage) {
      return;
    }
    stage.status = event.status;
    stage.detail = event.detail;
    stage.startedAt = stage.startedAt ?? event.startedAt;
    stage.endedAt = event.endedAt ?? stage.endedAt;
    stage.modelCalls = event.stageModelCalls ?? event.modelCalls;
    stage.retryCount = event.retryCount ?? stage.retryCount;
    stage.failureReason = event.status === "failed" ? event.detail : stage.failureReason;
    job.modelCalls = event.modelCalls;
    job.updatedAt = new Date().toISOString();
  }

  private serializeJob(job: V2DeckJob) {
    const nowMs = Date.now();
    const elapsed = (startedAt?: string, endedAt?: string) => {
      if (!startedAt) return 0;
      const startMs = Date.parse(startedAt);
      const endMs = endedAt ? Date.parse(endedAt) : nowMs;
      return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
    };
    return {
      ...job,
      elapsedMs: elapsed(job.startedAt, job.endedAt),
      stages: job.stages.map((stage) => ({
        ...stage,
        elapsedMs: elapsed(stage.startedAt, stage.endedAt)
      }))
    };
  }

  private async cleanupJobs() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [jobId, job] of this.jobs) {
      if (Date.parse(job.updatedAt) < cutoff) {
        this.jobs.delete(jobId);
      }
    }
  }

  private async insertDeckJob(job: V2DeckJob, allowVerificationFailure: boolean) {
    await this.databaseService.query(
      `
        INSERT INTO ppt_v2_deck_jobs (
          id,
          user_id,
          prompt,
          status,
          stages,
          result,
          error,
          model_calls,
          allow_verification_failure,
          started_at,
          ended_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        job.jobId,
        job.userId,
        job.prompt,
        job.status,
        JSON.stringify(job.stages),
        job.result ? JSON.stringify(job.result) : null,
        job.error ?? null,
        job.modelCalls,
        allowVerificationFailure,
        job.startedAt ?? null,
        job.endedAt ?? null,
        job.createdAt,
        job.updatedAt
      ]
    );
  }

  private async persistDeckJob(job: V2DeckJob, allowVerificationFailure: boolean) {
    await this.databaseService.query(
      `
        UPDATE ppt_v2_deck_jobs
        SET status = $2,
            stages = $3::jsonb,
            result = $4::jsonb,
            error = $5,
            model_calls = $6,
            allow_verification_failure = $7,
            started_at = $8,
            ended_at = $9,
            updated_at = $10
        WHERE id = $1
          AND user_id = $11
      `,
      [
        job.jobId,
        job.status,
        JSON.stringify(job.stages),
        job.result ? JSON.stringify(job.result) : null,
        job.error ?? null,
        job.modelCalls,
        allowVerificationFailure,
        job.startedAt ?? null,
        job.endedAt ?? null,
        job.updatedAt,
        job.userId
      ]
    );
  }

  private async findDeckJob(userId: number, jobId: string) {
    const result = await this.databaseService.query<V2DeckJobRow>(
      `
        SELECT id,
               user_id,
               prompt,
               status,
               stages,
               result,
               error,
               model_calls,
               started_at,
               ended_at,
               created_at,
               updated_at
        FROM ppt_v2_deck_jobs
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
      `,
      [jobId, userId]
    );
    const row = result.rows[0];
    return row ? this.deckJobFromRow(row) : null;
  }

  private deckJobFromRow(row: V2DeckJobRow): V2DeckJob {
    return {
      jobId: row.id,
      userId: Number(row.user_id),
      prompt: row.prompt,
      status: normalizeJobStatus(row.status),
      createdAt: dateishToIso(row.created_at),
      updatedAt: dateishToIso(row.updated_at),
      startedAt: row.started_at ? dateishToIso(row.started_at) : undefined,
      endedAt: row.ended_at ? dateishToIso(row.ended_at) : undefined,
      elapsedMs: 0,
      modelCalls: Number(row.model_calls ?? 0),
      error: row.error ?? undefined,
      stages: parseJobStages(row.stages),
      result: parseJobResult(row.result)
    };
  }

  private formatDeckResponse(result: HtmlPptV2PublishResult): V2DeckResponse {
    const title = result.deck.narrative.slides[0]?.contentBrief.headline ?? result.deck.intent.topic;
    return {
      deckId: result.deckId,
      title,
      status: result.verification.status,
      previewUrl: `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/preview.html`,
      downloadUrl: `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/download.zip`,
      manifestUrl: `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/manifest.json`,
      verificationReportUrl: `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/verification-report.json`,
      verification: {
        ...result.verification.summary,
        mode: result.verification.mode,
        reportStatus: result.verification.status
      },
      screenshots: result.verification.screenshots.map((screenshot) => ({
        slideIndex: screenshot.slideIndex,
        url: `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/screenshots/${encodeURIComponent(basename(screenshot.file))}`
      })),
      auxiliaryArtifacts: Object.fromEntries(
        Object.entries(result.auxiliary.artifacts).map(([key, file]) => [
          key,
          `/api/ppt/v2/decks/${encodeURIComponent(result.deckId)}/artifacts/${encodeURIComponent(file)}`
        ])
      ),
      templateSelection: {
        mode: result.trace.templateSelectionSource,
        chosenTemplateId: result.trace.templateSelection.chosenTemplateId,
        shortlist: result.trace.templateSelection.shortlist,
        rationale: result.trace.templateSelection.rationale,
        confidence: result.trace.templateSelection.confidence
      },
      trace: result.trace
    };
  }

  private formatCriticBlockedPayload(error: CriticBlockedError) {
    const summary = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.slideIndex ? `Slide ${issue.slideIndex}: ` : ""}${issue.issue}`)
      .join("；");
    return {
      message: "HTML-PPT v2 critic blocked publication.",
      blockingIssueCount: error.issues.length,
      summary
    };
  }
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error && error.cause ? ` cause=${String(error.cause)}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

function contentTypeFor(filePath: string) {
  const mapping: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip",
    ".pdf": "application/pdf",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png"
  };
  return mapping[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function normalizeJobStatus(value: string): V2DeckJobStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" ? value : "failed";
}

function normalizeStageStatus(value: unknown): V2DeckJobStageStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "pending" ? value : "pending";
}

function dateishToIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJobStages(value: unknown): V2DeckJobStage[] {
  const parsed = parseJsonValue(value);
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.id === "string") {
        byId.set(record.id, record);
      }
    }
  }

  return V2_JOB_STAGE_DEFINITIONS.map(([id, name]) => {
    const stored = byId.get(id);
    return {
      id,
      name,
      status: normalizeStageStatus(stored?.status),
      detail: typeof stored?.detail === "string" ? stored.detail : "Waiting.",
      startedAt: typeof stored?.startedAt === "string" ? stored.startedAt : undefined,
      endedAt: typeof stored?.endedAt === "string" ? stored.endedAt : undefined,
      elapsedMs: typeof stored?.elapsedMs === "number" ? stored.elapsedMs : 0,
      modelCalls: typeof stored?.modelCalls === "number" ? stored.modelCalls : 0,
      retryCount: typeof stored?.retryCount === "number" ? stored.retryCount : 0,
      failureReason: typeof stored?.failureReason === "string" ? stored.failureReason : undefined
    };
  });
}

function parseJobResult(value: unknown): V2DeckResponse | undefined {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.deckId !== "string" || typeof record.previewUrl !== "string") {
    return undefined;
  }
  return record as V2DeckResponse;
}

function findWorkspaceRoot(start: string) {
  let current = resolve(start);
  for (let depth = 0; depth < 7; depth += 1) {
    if (existsSync(resolve(current, ".agents", "skills", "html-ppt"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(start, "..", "..");
}
