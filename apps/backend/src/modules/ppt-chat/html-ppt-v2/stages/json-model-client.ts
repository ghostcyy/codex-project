export type JsonOnlyModelRequest = {
  stage: string;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
  maxAttempts?: number;
};

export type JsonOnlyModelClient = {
  completeJson(request: JsonOnlyModelRequest): Promise<unknown>;
};
