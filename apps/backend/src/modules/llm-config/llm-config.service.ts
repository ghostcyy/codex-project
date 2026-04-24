import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { ActiveLlmConfig, LlmConfigInput, LlmConfigSummary } from "./llm-config.types";

interface LlmConfigRow extends QueryResultRow {
  id: number;
  provider_type: string;
  base_url: string;
  api_key_ciphertext: string;
  model: string;
  enabled: boolean;
  updated_at: Date | string;
}

const DEFAULT_PROVIDER_TYPE = "openai-compatible";
const DEFAULT_CONFIG_ID = 1;
const DEFAULT_ENCRYPTION_KEY = "local-dev-llm-config-encryption-key-change-me";

@Injectable()
export class LlmConfigService {
  private readonly logger = new Logger(LlmConfigService.name);

  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async getConfigSummary(): Promise<LlmConfigSummary> {
    const row = await this.getConfigRow();

    if (!row) {
      return {
        providerType: DEFAULT_PROVIDER_TYPE,
        baseUrl: "",
        model: "",
        enabled: false,
        hasApiKey: false,
        apiKeyMasked: null,
        updatedAt: null
      };
    }

    const apiKey = row.api_key_ciphertext.trim().length > 0 ? this.decrypt(row.api_key_ciphertext) : "";

    return {
      providerType: row.provider_type,
      baseUrl: row.base_url,
      model: row.model,
      enabled: row.enabled,
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey ? this.maskApiKey(apiKey) : null,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  async updateConfig(input: LlmConfigInput, updatedBy: number): Promise<LlmConfigSummary> {
    const current = await this.getConfigRow();
    const providerType = this.normalizeProviderType(input.providerType ?? current?.provider_type ?? DEFAULT_PROVIDER_TYPE);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl ?? current?.base_url ?? "");
    const model = this.normalizeRequiredString(input.model ?? current?.model ?? "", "model");
    const enabled = this.normalizeBoolean(input.enabled, current?.enabled ?? false);
    const apiKey =
      typeof input.apiKey === "string" && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : current
          ? this.decrypt(current.api_key_ciphertext)
          : "";

    if (!apiKey) {
      throw new BadRequestException("API Key is required.");
    }

    const apiKeyCiphertext = this.encrypt(apiKey);

    await this.databaseService.query(
      `
        INSERT INTO llm_provider_settings (
          id,
          provider_type,
          base_url,
          api_key_ciphertext,
          model,
          enabled,
          updated_by,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE
        SET
          provider_type = EXCLUDED.provider_type,
          base_url = EXCLUDED.base_url,
          api_key_ciphertext = EXCLUDED.api_key_ciphertext,
          model = EXCLUDED.model,
          enabled = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `,
      [DEFAULT_CONFIG_ID, providerType, baseUrl, apiKeyCiphertext, model, enabled, updatedBy]
    );

    return this.getConfigSummary();
  }

  async getActiveConfig(): Promise<ActiveLlmConfig> {
    const row = await this.getConfigRow();

    if (!row || !row.enabled) {
      throw new ServiceUnavailableException("模型配置尚未启用。");
    }

    const apiKey = this.decrypt(row.api_key_ciphertext);
    if (!apiKey) {
      throw new ServiceUnavailableException("模型 API Key 尚未配置。");
    }

    return {
      providerType: row.provider_type,
      baseUrl: row.base_url,
      apiKey,
      model: row.model,
      enabled: row.enabled
    };
  }

  private async getConfigRow() {
    const result = await this.databaseService.query<LlmConfigRow>(
      `
        SELECT
          id,
          provider_type,
          base_url,
          api_key_ciphertext,
          model,
          enabled,
          updated_at
        FROM llm_provider_settings
        WHERE id = $1
        LIMIT 1
      `,
      [DEFAULT_CONFIG_ID]
    );

    return result.rows[0] ?? null;
  }

  private normalizeProviderType(input: unknown) {
    const value = this.normalizeRequiredString(input, "providerType");
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

  private normalizeRequiredString(input: unknown, field: string) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new BadRequestException(`${field} is required.`);
    }

    return input.trim();
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
    const value = process.env.LLM_CONFIG_ENCRYPTION_KEY?.trim() || DEFAULT_ENCRYPTION_KEY;
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

  private maskApiKey(apiKey: string) {
    if (apiKey.length <= 12) {
      return "*".repeat(apiKey.length);
    }

    return `${apiKey.slice(0, 6)}${"*".repeat(Math.max(apiKey.length - 12, 6))}${apiKey.slice(-6)}`;
  }
}
