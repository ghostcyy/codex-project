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
