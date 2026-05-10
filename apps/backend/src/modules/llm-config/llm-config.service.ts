import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type {
  ActiveLlmConfig,
  ImageModelConfigInput,
  ImageModelConfigSummary,
  JsonModelConfigInput,
  JsonModelConfigSummary,
  LlmConfigInput,
  LlmConfigSummary,
  LlmStageModelOverrides,
  LlmStageModelRole
} from "./llm-config.types";

const STAGE_MODEL_ROLES = ["research", "plan", "visual", "section", "css", "qa"] as const satisfies readonly LlmStageModelRole[];

interface LlmConfigRow extends QueryResultRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  image_base_url: string | null;
  api_key_ciphertext: string;
  image_api_key_ciphertext: string | null;
  model: string;
  stage_model_overrides?: unknown;
  enabled: boolean;
  updated_at: Date | string;
  call_count?: string;
  total_tokens?: string;
}

interface ImageModelConfigRow extends QueryResultRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key_ciphertext: string;
  model: string;
  updated_at: Date | string;
}

interface JsonModelConfigRow extends QueryResultRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key_ciphertext: string;
  model: string;
  updated_at: Date | string;
}

const DEFAULT_PROVIDER_TYPE = "minimax-cli";
const DEFAULT_ENCRYPTION_KEY = "local-dev-llm-config-encryption-key-change-me";
const SUPPORTED_PROVIDER_TYPES = new Set([
  "minimax-cli",
  "minimax",
  "openai-compatible",
  "openai",
  "openrouter",
  "azure-openai"
]);

@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);

  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async getConfigList(): Promise<LlmConfigSummary[]> {
    const result = await this.databaseService.query<LlmConfigRow>(
      `
        SELECT
          c.id,
          c.name,
          c.provider_type,
          c.base_url,
          c.api_key_ciphertext,
          c.image_api_key_ciphertext,
          c.model,
          c.stage_model_overrides,
          c.enabled,
          c.updated_at,
          COUNT(l.id) as call_count,
          SUM(l.total_tokens) as total_tokens
        FROM llm_provider_settings c
        LEFT JOIN llm_call_logs l ON c.id = l.config_id
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `
    );

    return result.rows.map((row) => {
      const apiKey = this.decryptOptionalApiKey(row.api_key_ciphertext);
      return {
        id: row.id,
        name: row.name,
        providerType: row.provider_type,
        baseUrl: row.base_url,
        model: row.model,
        stageModelOverrides: this.normalizeStageModelOverrides(row.stage_model_overrides),
        enabled: row.enabled,
        hasApiKey: apiKey.length > 0,
        apiKeyMasked: apiKey ? this.maskApiKey(apiKey) : null,
        updatedAt: new Date(row.updated_at).toISOString(),
        callCount: Number(row.call_count ?? 0),
        tokenConsumption: Number(row.total_tokens ?? 0)
      };
    });
  }

  async createConfig(input: LlmConfigInput, updatedBy: number): Promise<LlmConfigSummary> {
    const name = this.normalizeRequiredString(input.name ?? "New Model", "name");
    const providerType = this.normalizeProviderType(input.providerType ?? DEFAULT_PROVIDER_TYPE);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? "");
    const model = this.normalizeRequiredString(input.model ?? "", "model");
    const stageModelOverrides = this.normalizeStageModelOverrides(input.stageModelOverrides);
    const enabled = this.normalizeBoolean(input.enabled, false);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";

    if (!apiKey) {
      throw new BadRequestException("API Key is required for new configurations.");
    }

    if (enabled) {
      await this.databaseService.query(`UPDATE llm_provider_settings SET enabled = FALSE`);
    }

    const apiKeyCiphertext = this.encrypt(apiKey);

    const result = await this.databaseService.query<{ id: string }>(
      `
        INSERT INTO llm_provider_settings (
          name,
          provider_type,
          base_url,
          api_key_ciphertext,
          model,
          stage_model_overrides,
          enabled,
          updated_by,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW())
        RETURNING id
      `,
      [
        name,
        providerType,
        baseUrl,
        apiKeyCiphertext,
        model,
        JSON.stringify(stageModelOverrides),
        enabled,
        updatedBy
      ]
    );

    const newId = result.rows[0]?.id;
    if (!newId) throw new BadRequestException("Failed to create config.");
    return this.getConfigSummaryById(newId) as Promise<LlmConfigSummary>;
  }

  async updateConfig(id: string, input: LlmConfigInput, updatedBy: number): Promise<LlmConfigSummary> {
    const current = await this.getConfigRowById(id);
    if (!current) {
      throw new BadRequestException("Config not found.");
    }

    const name = this.normalizeRequiredString(input.name ?? current.name, "name");
    const providerType = this.normalizeProviderType(input.providerType ?? current.provider_type);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current.base_url);
    const model = this.normalizeRequiredString(input.model ?? current.model, "model");
    const stageModelOverrides = this.normalizeStageModelOverrides(input.stageModelOverrides ?? current.stage_model_overrides);
    const enabled = this.normalizeBoolean(input.enabled, current.enabled);
    const apiKey =
      typeof input.apiKey === "string" && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : this.decrypt(current.api_key_ciphertext);

    if (!apiKey) {
      throw new BadRequestException("API Key is required.");
    }

    if (enabled && !current.enabled) {
      await this.databaseService.query(`UPDATE llm_provider_settings SET enabled = FALSE`);
    }

    const apiKeyCiphertext = this.encrypt(apiKey);

    await this.databaseService.query(
      `
        UPDATE llm_provider_settings
        SET
          name = $1,
          provider_type = $2,
          base_url = $3,
          api_key_ciphertext = $4,
          model = $5,
          stage_model_overrides = $6::jsonb,
          enabled = $7,
          updated_by = $8,
          updated_at = NOW()
        WHERE id = $9
      `,
      [
        name,
        providerType,
        baseUrl,
        apiKeyCiphertext,
        model,
        JSON.stringify(stageModelOverrides),
        enabled,
        updatedBy,
        id
      ]
    );

    return this.getConfigSummaryById(id);
  }

  async deleteConfig(id: string): Promise<void> {
    await this.databaseService.query("DELETE FROM llm_provider_settings WHERE id = $1", [id]);
  }

  async getImageConfig(): Promise<ImageModelConfigSummary> {
    const row = await this.getImageConfigRow();
    return this.mapImageConfigSummary(row);
  }

  async getJsonModelConfig(): Promise<JsonModelConfigSummary> {
    const row = await this.getJsonConfigRow();
    return this.mapJsonConfigSummary(row);
  }

  async updateImageConfig(input: ImageModelConfigInput, updatedBy: number): Promise<ImageModelConfigSummary> {
    const current = await this.getImageConfigRow();
    const name = this.normalizeRequiredString(input.name ?? current.name, "name");
    const providerType = this.normalizeProviderType(input.providerType ?? current.provider_type);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current.base_url);
    const model = this.normalizeRequiredString(input.model ?? current.model, "model");
    const apiKey =
      typeof input.apiKey === "string" && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : this.decryptOptionalApiKey(current.api_key_ciphertext);
    const apiKeyCiphertext = apiKey ? this.encrypt(apiKey) : "";

    await this.databaseService.query(
      `
        UPDATE llm_image_provider_settings
        SET
          name = $1,
          provider_type = $2,
          base_url = $3,
          api_key_ciphertext = $4,
          model = $5,
          updated_by = $6,
          updated_at = NOW()
        WHERE id = 1
      `,
      [name, providerType, baseUrl, apiKeyCiphertext, model, updatedBy]
    );

    return this.getImageConfig();
  }

  async updateJsonModelConfig(input: JsonModelConfigInput, updatedBy: number): Promise<JsonModelConfigSummary> {
    const current = await this.getJsonConfigRow();
    const name = this.normalizeRequiredString(input.name ?? current.name, "name");
    const providerType = this.normalizeProviderType(input.providerType ?? current.provider_type);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current.base_url);
    const model = this.normalizeRequiredString(input.model ?? current.model, "model");
    const apiKey =
      typeof input.apiKey === "string" && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : this.decryptOptionalApiKey(current.api_key_ciphertext);
    const apiKeyCiphertext = apiKey ? this.encrypt(apiKey) : "";

    await this.databaseService.query(
      `
        UPDATE llm_json_provider_settings
        SET
          name = $1,
          provider_type = $2,
          base_url = $3,
          api_key_ciphertext = $4,
          model = $5,
          updated_by = $6,
          updated_at = NOW()
        WHERE id = 1
      `,
      [name, providerType, baseUrl, apiKeyCiphertext, model, updatedBy]
    );

    return this.getJsonModelConfig();
  }

  async getActiveConfig(): Promise<ActiveLlmConfig> {
    const result = await this.databaseService.query<LlmConfigRow>(
      `
        SELECT
          id,
          name,
          provider_type,
          base_url,
          image_base_url,
          api_key_ciphertext,
          image_api_key_ciphertext,
          model,
          stage_model_overrides,
          enabled,
          updated_at
        FROM llm_provider_settings
        WHERE enabled = TRUE
        LIMIT 1
      `
    );
    const row = result.rows[0] ?? null;

    if (!row) {
      throw new ServiceUnavailableException("模型配置尚未启用或不存在。");
    }

    const apiKey = this.decrypt(row.api_key_ciphertext);
    if (!apiKey) {
      throw new ServiceUnavailableException("模型 API Key 尚未配置。");
    }
    const imageConfig = await this.getImageConfigRow();
    const imageApiKey = this.decryptOptionalApiKey(imageConfig.api_key_ciphertext) || this.decryptOptionalApiKey(row.image_api_key_ciphertext);

    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      imageBaseUrl: imageConfig.base_url || this.normalizeOptionalBaseUrl(row.image_base_url) || undefined,
      apiKey,
      imageApiKey: imageApiKey || undefined,
      imageModel: imageConfig.model,
      model: row.model,
      stageModelOverrides: this.normalizeStageModelOverrides(row.stage_model_overrides),
      enabled: row.enabled
    };
  }

  async getJsonConfig(): Promise<ActiveLlmConfig> {
    const active = await this.getActiveConfig();
    // Default back to the normal text model for prompt-level JSON. The dedicated
    // JSON model is kept as an opt-in path for providers that truly support JSON
    // schema mode, e.g. MiniMax-Text-01 with a compatible official token plan.
    if (process.env.HTML_PPT_V3_USE_DEDICATED_JSON_MODEL !== "1") {
      return active;
    }

    const jsonConfig = await this.getJsonConfigRow();
    const jsonApiKey = this.decryptOptionalApiKey(jsonConfig.api_key_ciphertext) || active.apiKey;
    if (!jsonApiKey) {
      throw new ServiceUnavailableException("JSON 模型 API Key 尚未配置。");
    }

    return {
      ...active,
      // Keep the active text config id so existing llm_call_payloads foreign-key logging remains valid.
      name: jsonConfig.name,
      providerType: jsonConfig.provider_type,
      baseUrl: jsonConfig.base_url,
      apiKey: jsonApiKey,
      model: jsonConfig.model
    };
  }

  private async getConfigRowById(id: string) {
    const result = await this.databaseService.query<LlmConfigRow>(
      `
        SELECT
          id,
          name,
          provider_type,
          base_url,
          api_key_ciphertext,
          image_api_key_ciphertext,
          model,
          stage_model_overrides,
          enabled,
          updated_at
        FROM llm_provider_settings
        WHERE id = $1
      `,
      [id]
    );

    return result.rows[0] ?? null;
  }

  private async getImageConfigRow(): Promise<ImageModelConfigRow> {
    await this.databaseService.query(`
      INSERT INTO llm_image_provider_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);

    const result = await this.databaseService.query<ImageModelConfigRow>(
      `
        SELECT
          id,
          name,
          provider_type,
          base_url,
          api_key_ciphertext,
          model,
          updated_at
        FROM llm_image_provider_settings
        WHERE id = 1
      `
    );
    const row = result.rows[0];
    if (!row) throw new BadRequestException("Image model config not found.");
    return row;
  }

  private async getJsonConfigRow(): Promise<JsonModelConfigRow> {
    await this.databaseService.query(`
      CREATE TABLE IF NOT EXISTS llm_json_provider_settings (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        name VARCHAR(128) NOT NULL DEFAULT 'Default JSON Model',
        provider_type VARCHAR(64) NOT NULL DEFAULT 'minimax',
        base_url TEXT NOT NULL DEFAULT 'https://api.minimax.io/v1',
        api_key_ciphertext TEXT NOT NULL DEFAULT '',
        model VARCHAR(128) NOT NULL DEFAULT 'MiniMax-Text-01',
        updated_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.databaseService.query(`
      INSERT INTO llm_json_provider_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);

    const result = await this.databaseService.query<JsonModelConfigRow>(
      `
        SELECT
          id,
          name,
          provider_type,
          base_url,
          api_key_ciphertext,
          model,
          updated_at
        FROM llm_json_provider_settings
        WHERE id = 1
      `
    );
    const row = result.rows[0];
    if (!row) throw new BadRequestException("JSON model config not found.");
    return row;
  }

  private mapImageConfigSummary(row: ImageModelConfigRow): ImageModelConfigSummary {
    const apiKey = this.decryptOptionalApiKey(row.api_key_ciphertext);
    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      model: row.model,
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey ? this.maskApiKey(apiKey) : null,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private mapJsonConfigSummary(row: JsonModelConfigRow): JsonModelConfigSummary {
    const apiKey = this.decryptOptionalApiKey(row.api_key_ciphertext);
    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      model: row.model,
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey ? this.maskApiKey(apiKey) : null,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private async getConfigSummaryById(id: string): Promise<LlmConfigSummary> {
    const row = await this.getConfigRowById(id);
    if (!row) throw new BadRequestException("Config not found.");

    const apiKey = this.decryptOptionalApiKey(row.api_key_ciphertext);
    return {
      id: row.id,
      name: row.name,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      model: row.model,
      stageModelOverrides: this.normalizeStageModelOverrides(row.stage_model_overrides),
      enabled: row.enabled,
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey ? this.maskApiKey(apiKey) : null,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private normalizeProviderType(input: unknown) {
    const value = this.normalizeRequiredString(input, "providerType").toLowerCase();
    if (!SUPPORTED_PROVIDER_TYPES.has(value)) {
      throw new BadRequestException(`Provider type ${value} is not supported.`);
    }
    return value;
  }

  private normalizeBaseUrl(input: unknown) {
    const value = this.normalizeRequiredString(input, "baseUrl");

    try {
      const parsed = new URL(value);
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new BadRequestException("Base URL format is invalid.");
    }
  }

  private normalizeOptionalBaseUrl(input: unknown) {
    if (typeof input !== "string" || input.trim().length === 0) {
      return null;
    }

    try {
      const parsed = new URL(input.trim());
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new BadRequestException("Text-to-Image Base URL format is invalid.");
    }
  }

  private normalizeRequiredString(input: unknown, field: string) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new BadRequestException(`${field} is required.`);
    }

    return input.trim();
  }

  private normalizeStageModelOverrides(input: unknown): LlmStageModelOverrides {
    const source = this.parseStageModelOverrideInput(input);
    const result: LlmStageModelOverrides = {};

    for (const role of STAGE_MODEL_ROLES) {
      const value = source[role];
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        result[role] = trimmed;
      }
    }

    return result;
  }

  private parseStageModelOverrideInput(input: unknown): Record<string, unknown> {
    if (!input) {
      return {};
    }

    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    }

    if (typeof input === "object" && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }

    return {};
  }

  private normalizeBoolean(input: unknown, fallback: boolean) {
    if (typeof input === "boolean") {
      return input;
    }

    if (typeof input === "string") {
      return input === "true";
    }

    return fallback;
  }

  private getEncryptionKey() {
    const raw = process.env.LLM_CONFIG_ENCRYPTION_KEY?.trim();
    if (!raw && process.env.NODE_ENV === "production") {
      throw new Error(
        "LLM_CONFIG_ENCRYPTION_KEY environment variable is required in production. Refusing to encrypt LLM credentials with the development default."
      );
    }
    const value = raw || DEFAULT_ENCRYPTION_KEY;
    if (value === DEFAULT_ENCRYPTION_KEY) {
      this.logger.warn("LLM_CONFIG_ENCRYPTION_KEY is using the development default.");
    }

    return createHash("sha256").update(value).digest();
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  private decrypt(ciphertext: string) {
    if (!ciphertext) {
      return "";
    }

    const [ivPart, authTagPart, payloadPart] = ciphertext.split(":");
    if (!ivPart || !authTagPart || !payloadPart) {
      throw new ServiceUnavailableException("模型配置解密失败。");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.getEncryptionKey(),
      Buffer.from(ivPart, "base64")
    );
    decipher.setAuthTag(Buffer.from(authTagPart, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payloadPart, "base64")),
      decipher.final()
    ]);

    return decrypted.toString("utf8");
  }

  private decryptOptionalApiKey(ciphertext?: string | null) {
    return ciphertext && ciphertext.trim().length > 0 ? this.decrypt(ciphertext) : "";
  }

  private maskApiKey(apiKey: string) {
    if (apiKey.length <= 12) {
      return "*".repeat(apiKey.length);
    }

    return `${apiKey.slice(0, 6)}${"*".repeat(Math.max(apiKey.length - 12, 6))}${apiKey.slice(-6)}`;
  }
}
