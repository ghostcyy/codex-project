import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { ZodError } from "zod";
import { DatabaseService } from "../../../database/database.service";
import { LlmConfigService } from "../../../llm-config/llm-config.service";
import { LlmLoggingService } from "../../../llm-logging/llm-logging.service";
import { PptV3JobService } from "../jobs/ppt-v3-job.service";
import { HtmlPptV3LlmClient } from "../orchestration/html-ppt-v3-llm-client";
import {
  parsePptV3MessageRequest,
  pptV3NaturalLanguageParseSchema,
  type PptV3NaturalLanguageParse
} from "./ppt-v3-message-parser";
import type { PptV3Job } from "../shared";
import type {
  CreatePptV3ProjectInput,
  PostPptV3ProjectMessageInput,
  PptV3Message,
  PptV3MessageKind,
  PptV3MessageRole,
  PptV3PostMessageResult,
  PptV3Project
} from "./ppt-v3-project.types";

type PptV3ProjectRow = QueryResultRow & {
  id: string;
  user_id: string | null;
  owner_user_id: number | string | null;
  title: string;
  selected_template_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PptV3MessageRow = QueryResultRow & {
  id: string;
  project_id: string;
  role: PptV3MessageRole;
  content: string;
  kind: PptV3MessageKind;
  metadata: Record<string, unknown> | string | null;
  created_at: Date | string;
};

const LLM_PARSE_TIMEOUT_MS = 120_000;

type IntentParseResult =
  | { ok: true; parse: PptV3NaturalLanguageParse }
  | { ok: false; reason: string };

@Injectable()
export class PptV3ProjectService implements OnModuleInit {
  private readonly logger = new Logger(PptV3ProjectService.name);
  private ready: Promise<void> | null = null;

  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(PptV3JobService) private readonly jobService: PptV3JobService,
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService
  ) {}

  async onModuleInit() {
    await this.ensureSchema();
  }

  async listProjects(ownerUserId: number): Promise<PptV3Project[]> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3ProjectRow>(
      `
        SELECT *
        FROM ppt_v3_projects
        WHERE owner_user_id = $1
        ORDER BY updated_at DESC
      `,
      [ownerUserId]
    );

    return result.rows.map(mapProjectRow);
  }

  async createProject(input: CreatePptV3ProjectInput = {}): Promise<PptV3Project> {
    await this.ensureSchema();
    const id = randomUUID();
    const userId = normalizeOptionalString(input.userId);
    const ownerUserId = normalizeOwnerUserId(input.ownerUserId);
    const title = normalizeOptionalString(input.title) ?? "Untitled V3 Project";
    const selectedTemplateId = normalizeOptionalString(input.selectedTemplateId) ?? normalizeOptionalString(input.templateId);

    const result = await this.databaseService.query<PptV3ProjectRow>(
      `
        INSERT INTO ppt_v3_projects (id, user_id, owner_user_id, title, selected_template_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [id, userId, ownerUserId, title, selectedTemplateId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create HTML-PPT v3 project.");
    return mapProjectRow(row);
  }

  async getProject(projectId: string, ownerUserId: number): Promise<PptV3Project | null> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3ProjectRow>(
      "SELECT * FROM ppt_v3_projects WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [projectId, ownerUserId]
    );
    return result.rows[0] ? mapProjectRow(result.rows[0]) : null;
  }

  async requireProject(projectId: string, ownerUserId: number): Promise<PptV3Project> {
    const project = await this.getProject(projectId, ownerUserId);
    if (!project) throw new NotFoundException("HTML-PPT v3 project not found.");
    return project;
  }

  async patchProject(
    projectId: string,
    ownerUserId: number,
    input: { title?: unknown; selectedTemplateId?: unknown; templateId?: unknown }
  ): Promise<PptV3Project> {
    const current = await this.requireProject(projectId, ownerUserId);
    const title = normalizeOptionalString(input.title) ?? current.title;
    const selectedTemplateId = normalizeOptionalString(input.selectedTemplateId)
      ?? normalizeOptionalString(input.templateId)
      ?? current.selectedTemplateId;
    const result = await this.databaseService.query<PptV3ProjectRow>(
      `
        UPDATE ppt_v3_projects
        SET title = $1,
            selected_template_id = $2,
            updated_at = NOW()
        WHERE id = $3
          AND owner_user_id = $4
        RETURNING *
      `,
      [title, selectedTemplateId, projectId, ownerUserId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 project not found.");
    return mapProjectRow(row);
  }

  async deleteProject(projectId: string, ownerUserId: number): Promise<void> {
    await this.requireProject(projectId, ownerUserId);
    await this.databaseService.query("UPDATE ppt_v3_jobs SET project_id = NULL WHERE project_id = $1 AND owner_user_id = $2", [projectId, ownerUserId]);
    await this.databaseService.query("DELETE FROM ppt_v3_messages WHERE project_id = $1", [projectId]);
    await this.databaseService.query("DELETE FROM ppt_v3_projects WHERE id = $1 AND owner_user_id = $2", [projectId, ownerUserId]);
  }

  async listMessages(projectId: string, ownerUserId: number): Promise<PptV3Message[]> {
    await this.requireProject(projectId, ownerUserId);
    const result = await this.databaseService.query<PptV3MessageRow>(
      `
        SELECT *
        FROM ppt_v3_messages
        WHERE project_id = $1
        ORDER BY created_at ASC
      `,
      [projectId]
    );
    return result.rows.map(mapMessageRow);
  }

  async listJobs(projectId: string, ownerUserId: number): Promise<PptV3Job[]> {
    await this.requireProject(projectId, ownerUserId);
    return this.jobService.listJobsByProject(projectId, ownerUserId);
  }

  async markJobMessageDone(
    projectId: string,
    messageId: string,
    input: {
      jobId: string;
      previewUrl: string;
      downloadUrl: string;
      warnings?: string[];
      modelCallCount?: number;
    }
  ): Promise<void> {
    await this.updateJobMessage(projectId, messageId, "生成完成，预览和下载已就绪。", {
      jobId: input.jobId,
      status: "done",
      previewUrl: input.previewUrl,
      downloadUrl: input.downloadUrl,
      warnings: input.warnings ?? [],
      modelCallCount: input.modelCallCount ?? null
    });
  }

  async markJobMessageFailed(
    projectId: string,
    messageId: string,
    input: {
      jobId: string;
      error: string;
    }
  ): Promise<void> {
    await this.updateJobMessage(projectId, messageId, input.error, {
      jobId: input.jobId,
      status: "failed",
      error: input.error
    });
  }

  async postMessage(projectId: string, ownerUserId: number, input: PostPptV3ProjectMessageInput = {}): Promise<PptV3PostMessageResult> {
    const project = await this.requireProject(projectId, ownerUserId);
    const content = normalizeRequiredContent(input.content);
    const metadata = normalizeMessageMetadata(input);
    const userMessage = await this.createMessage(project.id, "user", content, "text", metadata);

    const intentParse = await this.tryParseWithLlm(project.id, ownerUserId, userMessage.id, content, metadata);
    if (!intentParse.ok) {
      const assistantMessage = await this.createMessage(
        project.id,
        "assistant",
        "意图解析失败，请重试。",
        "error",
        {
          parseSource: "llm",
          error: intentParse.reason
        }
      );
      await this.touchProject(project.id);
      return {
        project: await this.requireProject(project.id, ownerUserId),
        userMessage,
        assistantMessage
      };
    }

    const parsed = parsePptV3MessageRequest({
      content,
      metadata,
      projectSelectedTemplateId: project.selectedTemplateId,
      llmParse: intentParse.parse
    });

    if (!parsed.ok) {
      const assistantMessage = await this.createMessage(project.id, "assistant", parsed.clarification, "clarification", {
        missingFields: parsed.missingFields,
        issues: parsed.issues,
        partialRequest: parsed.partialRequest,
        parseSource: parsed.source
      });
      await this.touchProject(project.id);
      return {
        project: await this.requireProject(project.id, ownerUserId),
        userMessage,
        assistantMessage
      };
    }

    const job = await this.jobService.createJob(parsed.request, ownerUserId, project.id);
    const updatedProject = await this.setSelectedTemplate(project.id, parsed.request.templateId);
    const assistantMessage = await this.createMessage(
      project.id,
      "assistant",
      `Generation job ${job.id} created.`,
      "job",
      {
        jobId: job.id,
        status: job.status,
        request: parsed.request,
        parseSource: parsed.source,
        previewUrl: `/html-ppt-v3/preview/${job.id}/index.html`,
        downloadUrl: `/html-ppt-v3/download/${job.id}`,
        sseUrl: `/html-ppt-v3/sse/${job.id}`
      }
    );

    return {
      project: updatedProject,
      userMessage,
      assistantMessage,
      request: parsed.request,
      job
    };
  }

  private async createMessage(
    projectId: string,
    role: PptV3MessageRole,
    content: string,
    kind: PptV3MessageKind,
    metadata: Record<string, unknown>
  ): Promise<PptV3Message> {
    await this.ensureSchema();
    const id = randomUUID();
    const result = await this.databaseService.query<PptV3MessageRow>(
      `
        INSERT INTO ppt_v3_messages (id, project_id, role, content, kind, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING *
      `,
      [id, projectId, role, content, kind, JSON.stringify(metadata)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create HTML-PPT v3 message.");
    return mapMessageRow(row);
  }

  private async updateJobMessage(
    projectId: string,
    messageId: string,
    content: string,
    metadataPatch: Record<string, unknown>
  ): Promise<void> {
    await this.ensureSchema();
    await this.databaseService.query(
      `
        UPDATE ppt_v3_messages
        SET content = $1,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $3
          AND project_id = $4
          AND role = 'assistant'
          AND kind = 'job'
      `,
      [content, JSON.stringify(metadataPatch), messageId, projectId]
    );
    await this.touchProject(projectId);
  }

  private async setSelectedTemplate(projectId: string, templateId: string): Promise<PptV3Project> {
    await this.ensureSchema();
    const result = await this.databaseService.query<PptV3ProjectRow>(
      `
        UPDATE ppt_v3_projects
        SET selected_template_id = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `,
      [templateId, projectId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("HTML-PPT v3 project not found.");
    return mapProjectRow(row);
  }

  private async touchProject(projectId: string): Promise<void> {
    await this.ensureSchema();
    await this.databaseService.query(
      `
        UPDATE ppt_v3_projects
        SET updated_at = NOW()
        WHERE id = $1
      `,
      [projectId]
    );
  }

  private async tryParseWithLlm(
    projectId: string,
    ownerUserId: number,
    messageId: string,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<IntentParseResult> {
    try {
      const activeConfig = await this.llmConfigService.getActiveConfig();
      const client = new HtmlPptV3LlmClient(
        activeConfig,
        this.logger,
        this.llmLoggingService,
        ownerUserId,
        projectId,
        messageId
      );
      const parsePromise: Promise<IntentParseResult> = client.callStructured({
        stage: "v3-intent-parse",
        systemPrompt: [
          "You extract only the user's textual HTML-PPT v3 generation intent.",
          "Return strict JSON matching schemaVersion html-ppt-v3.intent.v1.",
          "STRICT OUTPUT SCHEMA: you MUST return exactly this JSON object shape and no other schema type:",
          JSON.stringify({
            schemaVersion: "html-ppt-v3.intent.v1",
            action: "generate_deck",
            status: "complete",
            deck: {
              contentTheme: "string",
              title: "string",
              pageCount: 14,
              wordBudget: 2000,
              audience: null,
              purpose: null,
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
          }, null, 2),
          "Hard schema rules:",
          "- status MUST be exactly one of: complete, needs_clarification, unsupported. Never output ready, ok, success, or any other status.",
          "- contentTheme, title, pageCount, and wordBudget MUST be inside deck. Never put them at the top level.",
          "- pageCount and wordBudget MUST be integers, not strings.",
          "- If contentTheme, pageCount, or wordBudget is missing, status MUST be needs_clarification and quality.missingFields MUST list the missing deck field names.",
          "Only parse content theme, page count, total word budget, audience, purpose, tone, mustInclude, and mustAvoid.",
          "Do not parse or decide templateId or media toggles; those are controlled by UI metadata outside your output.",
          "Do not invent defaults. If contentTheme, pageCount, or wordBudget is missing, return status needs_clarification and list missingFields.",
          "Strip task instructions from contentTheme. Example: '制作一个html ppt，主题为GDPR 数据合规的实操要点清单，页数14，字数2000' => contentTheme 'GDPR 数据合规的实操要点清单', pageCount 14, wordBudget 2000.",
          "Output JSON only. No markdown fence. No prose."
        ].join("\n"),
        userPrompt: JSON.stringify({
          content,
          uiContext: {
            templateId: normalizeOptionalString(metadata.templateId) ?? normalizeOptionalString(metadata.selectedTemplateId) ?? null,
            includeImages: metadata.includeImages ?? null,
            includeVideo: metadata.includeVideo ?? null,
            includeChart: metadata.includeChart ?? null,
            includeAudio: metadata.includeAudio ?? null
          }
        }),
        schema: pptV3NaturalLanguageParseSchema,
        // MiniMax can emit verbose hidden reasoning before the JSON body; keep
        // enough completion budget so the strict IntentJSON object is not cut off.
        maxTokens: 2000,
        temperature: 0,
        retries: 1
      }).then((parse) => ({
        ok: true as const,
        parse
      })).catch((error) => {
        this.logger.warn(`V3 natural-language parse LLM failed: ${formatError(error)}`);
        return {
          ok: false as const,
          reason: formatError(error)
        };
      });

      return await withTimeout(parsePromise, LLM_PARSE_TIMEOUT_MS, () => ({
        ok: false as const,
        reason: `intent parse timed out after ${LLM_PARSE_TIMEOUT_MS}ms`
      }));
    } catch (error) {
      if (!(error instanceof ZodError)) {
        this.logger.debug?.(`V3 natural-language intent parse unavailable: ${formatError(error)}`);
      }
      return {
        ok: false,
        reason: formatError(error)
      };
    }
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
      CREATE TABLE IF NOT EXISTS ppt_v3_projects (
        id UUID PRIMARY KEY,
        user_id UUID NULL,
        owner_user_id BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        selected_template_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.databaseService.query(`
      CREATE TABLE IF NOT EXISTS ppt_v3_messages (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES ppt_v3_projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'clarification', 'job', 'error')),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.databaseService.query("ALTER TABLE ppt_v3_projects ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE");
    await this.backfillLegacyProjectsToAdmin();
    await this.backfillLegacyJobsFromProjects();
    await this.databaseService.query(
      "CREATE INDEX IF NOT EXISTS idx_ppt_v3_projects_user_updated ON ppt_v3_projects(user_id, updated_at DESC)"
    );
    await this.databaseService.query(
      "CREATE INDEX IF NOT EXISTS idx_ppt_v3_projects_owner_updated ON ppt_v3_projects(owner_user_id, updated_at DESC)"
    );
    await this.databaseService.query(
      "CREATE INDEX IF NOT EXISTS idx_ppt_v3_messages_project_created ON ppt_v3_messages(project_id, created_at ASC)"
    );
    this.logger.log("HTML-PPT v3 project/message tables are ready.");
  }

  private async backfillLegacyProjectsToAdmin() {
    await this.databaseService.query(`
      UPDATE ppt_v3_projects
      SET owner_user_id = admin.id
      FROM (
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER('admin')
        LIMIT 1
      ) admin
      WHERE ppt_v3_projects.owner_user_id IS NULL
    `);
  }

  private async backfillLegacyJobsFromProjects() {
    await this.databaseService.query(`
      UPDATE ppt_v3_jobs
      SET owner_user_id = ppt_v3_projects.owner_user_id
      FROM ppt_v3_projects
      WHERE ppt_v3_jobs.project_id = ppt_v3_projects.id
        AND ppt_v3_jobs.owner_user_id IS DISTINCT FROM ppt_v3_projects.owner_user_id
    `);
  }
}

function normalizeRequiredContent(value: unknown): string {
  const content = normalizeOptionalString(value);
  if (!content) throw new BadRequestException("Message content is required.");
  return content;
}

function normalizeMessageMetadata(input: PostPptV3ProjectMessageInput): Record<string, unknown> {
  const rawMetadata = asRecord(input.metadata);
  const metadata = rawMetadata ? { ...rawMetadata } : {};
  for (const key of [
    "theme",
    "topic",
    "pageCount",
    "wordBudget",
    "templateId",
    "selectedTemplateId",
    "includeImages",
    "includeVideo",
    "includeChart",
    "includeAudio"
  ] as const) {
    if (input[key] !== undefined && metadata[key] === undefined) {
      metadata[key] = input[key];
    }
  }
  return metadata;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOwnerUserId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function mapProjectRow(row: PptV3ProjectRow): PptV3Project {
  return {
    id: row.id,
    userId: row.user_id,
    ownerUserId: row.owner_user_id == null ? null : Number(row.owner_user_id),
    title: row.title,
    selectedTemplateId: row.selected_template_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapMessageRow(row: PptV3MessageRow): PptV3Message {
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    content: row.content,
    kind: row.kind,
    metadata: parseMetadata(row.metadata),
    createdAt: new Date(row.created_at)
  };
}

function parseMetadata(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
