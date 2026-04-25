export interface LlmConfigSummary {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
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
  enabled: boolean;
}
