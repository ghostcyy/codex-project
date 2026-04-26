import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { CallLogStats, CallLogSummary, LlmPayloadLogDetail, LlmPayloadLogSummary } from "./llm-logging.types";

interface LogRow extends QueryResultRow {
  id: string;
  config_name: string;
  config_id: string;
  username: string;
  user_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: Date;
}

interface PayloadLogRow extends QueryResultRow {
  id: string;
  config_name: string | null;
  config_id: string | null;
  username: string | null;
  user_id: string | null;
  project_id: string | null;
  message_id: string | null;
  source: string;
  stage: string | null;
  status: "success" | "error" | "timeout";
  error_message: string | null;
  latency_ms: number | null;
  request_chars: number;
  response_chars: number;
  request_payload?: unknown;
  response_payload?: unknown;
  created_at: Date;
}

type PayloadLogInput = {
  configId: string;
  userId?: number | null;
  projectId?: string | null;
  messageId?: string | null;
  source?: string;
  stage?: string | null;
  requestPayload?: unknown;
  responsePayload?: unknown;
  status: "success" | "error" | "timeout";
  errorMessage?: string | null;
  latencyMs?: number | null;
};

@Injectable()
export class LlmLoggingService {
  private readonly logger = new Logger(LlmLoggingService.name);
  private lastPayloadCleanupAt = 0;

  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async logCall(
    configId: string,
    userId: number | null,
    promptTokens: number,
    completionTokens: number,
    totalTokens: number
  ): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO llm_call_logs (
          config_id,
          user_id,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
      `,
      [configId, userId, promptTokens, completionTokens, totalTokens]
    );
  }

  async logPayload(input: PayloadLogInput): Promise<void> {
    if (!this.isPayloadLoggingEnabled()) {
      return;
    }

    const requestPayload = this.shouldLogPromptContent()
      ? this.sanitizeForStorage(input.requestPayload)
      : null;
    const responsePayload = this.shouldLogResponseContent()
      ? this.sanitizeForStorage(input.responsePayload)
      : null;

    await this.databaseService.query(
      `
        INSERT INTO llm_call_payloads (
          config_id,
          user_id,
          project_id,
          message_id,
          source,
          stage,
          request_payload,
          response_payload,
          status,
          error_message,
          latency_ms,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, NOW())
      `,
      [
        input.configId,
        input.userId ?? null,
        input.projectId ?? null,
        input.messageId ?? null,
        input.source ?? "unknown",
        input.stage ?? null,
        JSON.stringify(requestPayload),
        JSON.stringify(responsePayload),
        input.status,
        this.clipText(input.errorMessage ?? null),
        input.latencyMs ?? null
      ]
    );

    this.maybeCleanupPayloadLogs().catch((error) => {
      this.logger.warn(`Failed to cleanup llm_call_payloads: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async getRecentLogs(limit = 50): Promise<CallLogSummary[]> {
    const result = await this.databaseService.query<LogRow>(
      `
        SELECT
          l.id,
          c.name as config_name,
          l.config_id,
          u.username,
          l.user_id,
          l.prompt_tokens,
          l.completion_tokens,
          l.total_tokens,
          l.created_at
        FROM llm_call_logs l
        LEFT JOIN llm_provider_settings c ON l.config_id = c.id
        LEFT JOIN users u ON l.user_id = u.id
        ORDER BY l.created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      configName: row.config_name ?? "Unknown Model",
      configId: row.config_id,
      username: row.username ?? "System/Unknown",
      userId: row.user_id,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async getRecentPayloadLogs(limit = 50, projectId?: string): Promise<LlmPayloadLogSummary[]> {
    const sanitizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
    const hasProjectFilter = Boolean(projectId && projectId.trim().length > 0);

    const result = await this.databaseService.query<PayloadLogRow>(
      `
        SELECT
          l.id,
          c.name AS config_name,
          l.config_id::text AS config_id,
          u.username,
          l.user_id::text AS user_id,
          l.project_id,
          l.message_id,
          l.source,
          l.stage,
          l.status,
          l.error_message,
          l.latency_ms,
          COALESCE(length(l.request_payload::text), 0) AS request_chars,
          COALESCE(length(l.response_payload::text), 0) AS response_chars,
          l.created_at
        FROM llm_call_payloads l
        LEFT JOIN llm_provider_settings c ON l.config_id = c.id
        LEFT JOIN users u ON l.user_id = u.id
        WHERE ($1::boolean = false OR l.project_id = $2)
        ORDER BY l.created_at DESC
        LIMIT $3
      `,
      [hasProjectFilter, projectId ?? null, sanitizedLimit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      configName: row.config_name ?? "Unknown Model",
      configId: row.config_id ?? "",
      username: row.username ?? "System/Unknown",
      userId: row.user_id ?? "",
      projectId: row.project_id ?? null,
      messageId: row.message_id ?? null,
      source: row.source,
      stage: row.stage ?? null,
      status: row.status,
      errorMessage: row.error_message ?? null,
      latencyMs: row.latency_ms ?? null,
      requestChars: Number(row.request_chars ?? 0),
      responseChars: Number(row.response_chars ?? 0),
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async getPayloadLogDetail(id: string): Promise<LlmPayloadLogDetail> {
    const result = await this.databaseService.query<PayloadLogRow>(
      `
        SELECT
          l.id,
          c.name AS config_name,
          l.config_id::text AS config_id,
          u.username,
          l.user_id::text AS user_id,
          l.project_id,
          l.message_id,
          l.source,
          l.stage,
          l.status,
          l.error_message,
          l.latency_ms,
          COALESCE(length(l.request_payload::text), 0) AS request_chars,
          COALESCE(length(l.response_payload::text), 0) AS response_chars,
          l.request_payload,
          l.response_payload,
          l.created_at
        FROM llm_call_payloads l
        LEFT JOIN llm_provider_settings c ON l.config_id = c.id
        LEFT JOIN users u ON l.user_id = u.id
        WHERE l.id = $1
        LIMIT 1
      `,
      [id]
    );

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException("日志不存在。");
    }

    return {
      id: row.id,
      configName: row.config_name ?? "Unknown Model",
      configId: row.config_id ?? "",
      username: row.username ?? "System/Unknown",
      userId: row.user_id ?? "",
      projectId: row.project_id ?? null,
      messageId: row.message_id ?? null,
      source: row.source,
      stage: row.stage ?? null,
      status: row.status,
      errorMessage: row.error_message ?? null,
      latencyMs: row.latency_ms ?? null,
      requestChars: Number(row.request_chars ?? 0),
      responseChars: Number(row.response_chars ?? 0),
      requestPayload: row.request_payload ?? null,
      responsePayload: row.response_payload ?? null,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  async getStats(): Promise<CallLogStats & { todayCalls: number; todayTokens: number }> {
    const totalResult = await this.databaseService.query<{
      total_calls: string;
      total_tokens: string;
      total_prompt: string;
      total_completion: string;
    }>(
      `
        SELECT
          COUNT(id) as total_calls,
          SUM(total_tokens) as total_tokens,
          SUM(prompt_tokens) as total_prompt,
          SUM(completion_tokens) as total_completion
        FROM llm_call_logs
      `
    );

    const todayResult = await this.databaseService.query<{
      today_calls: string;
      today_tokens: string;
    }>(
      `
        SELECT
          COUNT(id) as today_calls,
          SUM(total_tokens) as today_tokens
        FROM llm_call_logs
        WHERE created_at >= CURRENT_DATE
      `
    );

    const totalRow = totalResult.rows[0];
    const todayRow = todayResult.rows[0];

    return {
      totalCalls: Number(totalRow?.total_calls ?? 0),
      totalTokens: Number(totalRow?.total_tokens ?? 0),
      totalPromptTokens: Number(totalRow?.total_prompt ?? 0),
      totalCompletionTokens: Number(totalRow?.total_completion ?? 0),
      todayCalls: Number(todayRow?.today_calls ?? 0),
      todayTokens: Number(todayRow?.today_tokens ?? 0),
    };
  }

  private isPayloadLoggingEnabled() {
    return this.shouldLogPromptContent() || this.shouldLogResponseContent();
  }

  private shouldLogPromptContent() {
    return this.readBooleanEnv("LLM_LOG_PROMPT_CONTENT", process.env.NODE_ENV !== "production");
  }

  private shouldLogResponseContent() {
    return this.readBooleanEnv("LLM_LOG_RESPONSE_CONTENT", process.env.NODE_ENV !== "production");
  }

  private payloadRetentionDays() {
    const parsed = Number(process.env.LLM_LOG_RETENTION_DAYS);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, Math.floor(parsed));
    }
    return 7;
  }

  private payloadMaxChars() {
    const parsed = Number(process.env.LLM_LOG_MAX_TEXT_CHARS);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(5_000, Math.floor(parsed));
    }
    return 200_000;
  }

  private readBooleanEnv(name: string, fallback: boolean) {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = raw.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  }

  private sanitizeForStorage(input: unknown): unknown {
    return this.redactValue(input, new WeakSet<object>());
  }

  private redactValue(input: unknown, seen: WeakSet<object>): unknown {
    if (input === null || input === undefined) return input ?? null;

    if (typeof input === "string") {
      return this.redactString(input);
    }

    if (typeof input === "number" || typeof input === "boolean") {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((item) => this.redactValue(item, seen));
    }

    if (typeof input === "object") {
      const value = input as Record<string, unknown>;
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);

      const output: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value)) {
        if (this.isSensitiveKey(key)) {
          output[key] = "***REDACTED***";
        } else {
          output[key] = this.redactValue(raw, seen);
        }
      }
      return output;
    }

    return this.clipText(String(input));
  }

  private redactString(value: string) {
    const clipped = this.clipText(value) ?? "";
    return clipped
      .replace(/(Bearer\s+)[^\s"']+/gi, "$1***REDACTED***")
      .replace(/(["']?(?:api[_-]?key|token|secret|password|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1***REDACTED***")
      .replace(/(ghp_)[A-Za-z0-9]+/g, "$1***REDACTED***")
      .replace(/(sk-)[A-Za-z0-9]+/g, "$1***REDACTED***");
  }

  private isSensitiveKey(key: string) {
    return /(api[_-]?key|token|secret|password|authorization|cookie|set-cookie|apikey|access[_-]?key)/i.test(key);
  }

  private clipText(value: string | null) {
    if (value === null) return null;
    const max = this.payloadMaxChars();
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
  }

  private async maybeCleanupPayloadLogs() {
    const now = Date.now();
    if (now - this.lastPayloadCleanupAt < 30 * 60 * 1000) {
      return;
    }
    this.lastPayloadCleanupAt = now;
    const retentionDays = this.payloadRetentionDays();
    await this.databaseService.query(
      `DELETE FROM llm_call_payloads WHERE created_at < NOW() - ($1::text || ' days')::interval`,
      [String(retentionDays)]
    );
  }
}
