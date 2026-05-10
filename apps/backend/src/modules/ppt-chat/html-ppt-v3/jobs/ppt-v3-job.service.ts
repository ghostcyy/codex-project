import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../../database/database.service";
import {
  normalizeGenerateRequest,
  type ContentIR,
  type GenerateRequest,
  type JobStatus,
  type PlanIR,
  type PptV3Job,
  type PptV3StageHistoryEntry,
  type RunningJobStatus
} from "../shared";

type PptV3JobRow = {
  id: string;
  user_id: string | null;
  owner_user_id: number | string | null;
  request: GenerateRequest | string;
  template_id: string;
  project_id: string | null;
  status: JobStatus;
  output_dir: string | null;
  zip_path: string | null;
  preview_path: string | null;
  plan: PlanIR | string | null;
  content: ContentIR | string | null;
  error: string | null;
  stage_history: PptV3StageHistoryEntry[] | string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
};

@Injectable()
export class PptV3JobService implements OnModuleInit {
  private readonly logger = new Logger(PptV3JobService.name);
  private ready: Promise<void> | null = null;

  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async onModuleInit() {
    await this.ensureSchema();
  }

  async createJob(request: GenerateRequest, ownerUserId: number | string | null = null, projectId: string | null = null): Promise<PptV3Job> {
    await this.ensureSchema();
    const normalizedRequest = normalizeGenerateRequest(request);
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
    const id = randomUUID();
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        INSERT INTO ppt_v3_jobs (id, owner_user_id, project_id, request, template_id, status)
        VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
        RETURNING *
      `,
      [id, normalizedOwnerUserId, projectId, JSON.stringify(normalizedRequest), normalizedRequest.templateId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create HTML-PPT v3 job.");
    return mapJobRow(row);
  }

  async getJob(jobId: string): Promise<PptV3Job | null> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3JobRow>(
      "SELECT * FROM ppt_v3_jobs WHERE id = $1 LIMIT 1",
      [jobId]
    );
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async requireJob(jobId: string): Promise<PptV3Job> {
    const job = await this.getJob(jobId);
    if (!job) throw new NotFoundException("HTML-PPT v3 job not found.");
    return job;
  }

  async requireOwnedJob(jobId: string, ownerUserId: number): Promise<PptV3Job> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3JobRow>(
      "SELECT * FROM ppt_v3_jobs WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [jobId, ownerUserId]
    );
    const job = result.rows[0] ? mapJobRow(result.rows[0]) : null;
    if (!job) throw new NotFoundException("HTML-PPT v3 job not found.");
    return job;
  }

  async listJobsByProject(projectId: string, ownerUserId: number): Promise<PptV3Job[]> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3JobRow>(
      "SELECT * FROM ppt_v3_jobs WHERE project_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC",
      [projectId, ownerUserId]
    );
    return result.rows.map(mapJobRow);
  }

  async setStatus(jobId: string, status: JobStatus, error: string | null = null): Promise<PptV3Job> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        UPDATE ppt_v3_jobs
        SET status = $1,
            error = $2,
            output_dir = CASE WHEN $1 = 'failed' THEN NULL ELSE output_dir END,
            zip_path = CASE WHEN $1 = 'failed' THEN NULL ELSE zip_path END,
            preview_path = CASE WHEN $1 = 'failed' THEN NULL ELSE preview_path END,
            completed_at = CASE WHEN $1 IN ('done', 'failed') THEN NOW() ELSE completed_at END
        WHERE id = $3
        RETURNING *
      `,
      [status, error, jobId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 job not found.");
    return mapJobRow(row);
  }

  async recordStageStart(jobId: string, stage: RunningJobStatus, detail: string | null = null): Promise<PptV3Job> {
    await this.ensureSchema();
    const job = await this.requireJob(jobId);
    const now = new Date().toISOString();
    const stageHistory = upsertStageHistory(job.stageHistory, {
      stage,
      status: "running",
      startedAt: now,
      completedAt: null,
      elapsedMs: null,
      detail,
      summary: null
    });
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        UPDATE ppt_v3_jobs
        SET status = $1,
            error = NULL,
            stage_history = $2::jsonb
        WHERE id = $3
        RETURNING *
      `,
      [stage, JSON.stringify(stageHistory), jobId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 job not found.");
    return mapJobRow(row);
  }

  async recordStageDone(
    jobId: string,
    stage: RunningJobStatus,
    summary: unknown = null,
    detail: string | null = null
  ): Promise<PptV3Job> {
    await this.ensureSchema();
    const job = await this.requireJob(jobId);
    const now = new Date().toISOString();
    const stageHistory = completeStageHistory(job.stageHistory, stage, "done", now, detail, summary);
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        UPDATE ppt_v3_jobs
        SET stage_history = $1::jsonb
        WHERE id = $2
        RETURNING *
      `,
      [JSON.stringify(stageHistory), jobId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 job not found.");
    return mapJobRow(row);
  }

  async recordStageFailed(jobId: string, stage: RunningJobStatus, detail: string): Promise<PptV3Job> {
    await this.ensureSchema();
    const job = await this.requireJob(jobId);
    const now = new Date().toISOString();
    const stageHistory = completeStageHistory(job.stageHistory, stage, "failed", now, detail, { detail });
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        UPDATE ppt_v3_jobs
        SET stage_history = $1::jsonb
        WHERE id = $2
        RETURNING *
      `,
      [JSON.stringify(stageHistory), jobId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 job not found.");
    return mapJobRow(row);
  }

  async savePlan(jobId: string, plan: PlanIR): Promise<void> {
    await this.ensureSchema();
    await this.databaseService.query("UPDATE ppt_v3_jobs SET plan = $1::jsonb WHERE id = $2", [
      JSON.stringify(plan),
      jobId
    ]);
  }

  async saveContent(jobId: string, content: ContentIR): Promise<void> {
    await this.ensureSchema();
    await this.databaseService.query("UPDATE ppt_v3_jobs SET content = $1::jsonb WHERE id = $2", [
      JSON.stringify(content),
      jobId
    ]);
  }

  async markDone(
    jobId: string,
    paths: { outputDir: string; previewPath: string; zipPath: string }
  ): Promise<PptV3Job> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3JobRow>(
      `
        UPDATE ppt_v3_jobs
        SET status = 'done',
            output_dir = $1,
            zip_path = $2,
            preview_path = $3,
            error = NULL,
            completed_at = NOW()
        WHERE id = $4
        RETURNING *
      `,
      [paths.outputDir, paths.zipPath, paths.previewPath, jobId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 job not found.");
    return mapJobRow(row);
  }

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.createSchema().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async createSchema() {
    await this.databaseService.query(`
      CREATE TABLE IF NOT EXISTS ppt_v3_jobs (
        id UUID PRIMARY KEY,
        user_id UUID NULL,
        owner_user_id BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID NULL,
        request JSONB NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output_dir TEXT NULL,
        zip_path TEXT NULL,
        preview_path TEXT NULL,
        plan JSONB NULL,
        content JSONB NULL,
        error TEXT NULL,
        stage_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ NULL
      )
    `);
    await this.databaseService.query("ALTER TABLE ppt_v3_jobs ADD COLUMN IF NOT EXISTS project_id UUID NULL");
    await this.databaseService.query("ALTER TABLE ppt_v3_jobs ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE");
    await this.databaseService.query("ALTER TABLE ppt_v3_jobs ADD COLUMN IF NOT EXISTS stage_history JSONB NOT NULL DEFAULT '[]'::jsonb");
    await this.backfillLegacyJobsToAdmin();
    await this.failInterruptedRunningJobsOnStartup();
    await this.databaseService.query("CREATE INDEX IF NOT EXISTS idx_ppt_v3_user ON ppt_v3_jobs(user_id, created_at DESC)");
    await this.databaseService.query("CREATE INDEX IF NOT EXISTS idx_ppt_v3_jobs_owner_created ON ppt_v3_jobs(owner_user_id, created_at DESC)");
    await this.databaseService.query("CREATE INDEX IF NOT EXISTS idx_ppt_v3_jobs_owner_project ON ppt_v3_jobs(owner_user_id, project_id, created_at DESC)");
    await this.databaseService.query("CREATE INDEX IF NOT EXISTS idx_ppt_v3_project ON ppt_v3_jobs(project_id, created_at DESC)");
    this.logger.log("HTML-PPT v3 job table is ready.");
  }

  private async backfillLegacyJobsToAdmin() {
    await this.databaseService.query(`
      UPDATE ppt_v3_jobs
      SET owner_user_id = admin.id
      FROM (
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER('admin')
        LIMIT 1
      ) admin
      WHERE ppt_v3_jobs.owner_user_id IS NULL
    `);
  }

  private async failInterruptedRunningJobsOnStartup() {
    const message = "HTML-PPT v3 generation was interrupted by a backend restart. Please regenerate this deck.";
    const completedAt = new Date().toISOString();
    const result = await this.databaseService.query<{ id: string }>(`
      UPDATE ppt_v3_jobs
      SET status = 'failed',
          error = $1,
          output_dir = NULL,
          zip_path = NULL,
          preview_path = NULL,
          completed_at = NOW(),
          stage_history = (
            SELECT COALESCE(jsonb_agg(
              CASE
                WHEN entry->>'status' = 'running' THEN
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(entry, '{status}', '"failed"'::jsonb),
                      '{completedAt}', to_jsonb($2::text)
                    ),
                    '{detail}', to_jsonb($1::text)
                  )
                ELSE entry
              END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(stage_history, '[]'::jsonb)) entry
          )
      WHERE status IN ('planning', 'writing', 'speaking', 'imaging', 'injecting', 'packaging')
      RETURNING id
    `, [message, completedAt]);
    if (result.rowCount) {
      this.logger.warn(`Marked ${result.rowCount} interrupted HTML-PPT v3 job(s) as failed after backend startup.`);
    }
  }
}

function mapJobRow(row: PptV3JobRow): PptV3Job {
  return {
    id: row.id,
    userId: row.user_id,
    ownerUserId: row.owner_user_id == null ? null : Number(row.owner_user_id),
    projectId: row.project_id,
    request: normalizeGenerateRequest(parseJsonField<unknown>(row.request)),
    templateId: row.template_id,
    status: row.status,
    outputDir: row.output_dir,
    zipPath: row.zip_path,
    previewPath: row.preview_path,
    plan: parseNullableJsonField<PlanIR>(row.plan),
    content: parseNullableJsonField<ContentIR>(row.content),
    error: row.error,
    stageHistory: normalizeStageHistory(parseNullableJsonField<unknown>(row.stage_history)),
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null
  };
}

function normalizeOwnerUserId(value: number | string | null): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function parseJsonField<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function parseNullableJsonField<T>(value: T | string | null): T | null {
  if (value === null) return null;
  return parseJsonField<T>(value);
}

function normalizeStageHistory(value: unknown): PptV3StageHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: PptV3StageHistoryEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const stage = record.stage;
    if (!isRunningJobStatus(stage)) continue;
    const status = record.status === "done" || record.status === "failed" ? record.status : "running";
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : new Date().toISOString();
    const completedAt = typeof record.completedAt === "string" ? record.completedAt : null;
    const elapsedMs = typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
      ? Math.max(0, Math.round(record.elapsedMs))
      : completedAt
        ? elapsedMsBetween(startedAt, completedAt)
        : null;
    normalized.push({
      stage,
      status,
      startedAt,
      completedAt,
      elapsedMs,
      detail: typeof record.detail === "string" ? record.detail : null,
      summary: record.summary
    });
  }
  return normalized;
}

function upsertStageHistory(
  current: PptV3StageHistoryEntry[],
  nextEntry: PptV3StageHistoryEntry
): PptV3StageHistoryEntry[] {
  const withoutStage = current.filter((entry) => entry.stage !== nextEntry.stage);
  return [...withoutStage, nextEntry];
}

function completeStageHistory(
  current: PptV3StageHistoryEntry[],
  stage: RunningJobStatus,
  status: "done" | "failed",
  completedAt: string,
  detail: string | null,
  summary: unknown
): PptV3StageHistoryEntry[] {
  const existing = current.find((entry) => entry.stage === stage);
  const startedAt = existing?.startedAt ?? completedAt;
  const nextEntry: PptV3StageHistoryEntry = {
    stage,
    status,
    startedAt,
    completedAt,
    elapsedMs: elapsedMsBetween(startedAt, completedAt),
    detail: detail ?? existing?.detail ?? null,
    summary
  };
  return upsertStageHistory(current, nextEntry);
}

function elapsedMsBetween(startedAt: string, completedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(end - start));
}

function isRunningJobStatus(value: unknown): value is RunningJobStatus {
  return value === "planning" || value === "writing" || value === "speaking" || value === "imaging" || value === "injecting" || value === "packaging";
}
