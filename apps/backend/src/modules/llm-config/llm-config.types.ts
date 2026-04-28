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
  apiKey: string;
  model: string;
  stageModelOverrides: LlmStageModelOverrides;
  enabled: boolean;
}
