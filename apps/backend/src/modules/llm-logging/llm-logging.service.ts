import { Inject, Injectable } from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { CallLogStats, CallLogSummary } from "./llm-logging.types";

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

@Injectable()
export class LlmLoggingService {
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
}
