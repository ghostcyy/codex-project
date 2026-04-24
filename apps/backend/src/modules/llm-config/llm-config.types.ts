export interface LlmConfigSummary {
  providerType: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface LlmConfigInput {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  enabled?: unknown;
  providerType?: unknown;
}

export interface ActiveLlmConfig {
  providerType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}
