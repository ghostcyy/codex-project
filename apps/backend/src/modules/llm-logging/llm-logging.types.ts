export interface CallLogSummary {
  id: string;
  configName: string;
  configId: string;
  username: string;
  userId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
}

export interface CallLogStats {
  totalCalls: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface LlmPayloadLogSummary {
  id: string;
  configName: string;
  configId: string;
  username: string;
  userId: string;
  projectId: string | null;
  messageId: string | null;
  source: string;
  stage: string | null;
  status: "success" | "error" | "timeout";
  errorMessage: string | null;
  latencyMs: number | null;
  requestChars: number;
  responseChars: number;
  createdAt: string;
}

export interface LlmPayloadLogDetail extends LlmPayloadLogSummary {
  requestPayload: unknown;
  responsePayload: unknown;
}
