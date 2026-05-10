export type LlmStageModelRole = "research" | "plan" | "visual" | "section" | "css" | "qa";

export type LlmStageModelOverrides = Partial<Record<LlmStageModelRole, string>>;

export interface LlmConfigSummary {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
  stageModelOverrides: LlmStageModelOverrides;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
  callCount?: number;
  tokenConsumption?: number;
}

export interface LlmConfigInput {
  name?: string;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  stageModelOverrides?: unknown;
  enabled?: unknown;
  providerType?: unknown;
}

export interface ActiveLlmConfig {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  imageBaseUrl?: string;
  apiKey: string;
  imageApiKey?: string;
  imageModel?: string;
  model: string;
  stageModelOverrides: LlmStageModelOverrides;
  enabled: boolean;
}

export interface ImageModelConfigSummary {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface ImageModelConfigInput {
  name?: unknown;
  providerType?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

export interface JsonModelConfigSummary {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface JsonModelConfigInput {
  name?: unknown;
  providerType?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}
