/**
 * html-ppt-v3 :: orchestration/html-ppt-v3-llm-client.ts
 *
 * Thin LLM client for V3. Wraps the standard fetch-based OpenAI-compatible
 * API, identical in structure to V2's client but without the MiniMax-CLI
 * complexity (V3 uses the same provider configured in llm-config).
 */

import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import type { LlmLoggingService } from "../../../llm-logging/llm-logging.service";
import type { Logger } from "@nestjs/common";
import { z } from "zod";

export type V3JsonRequest = {
  stage:       string;
  system:      string;
  user:        string;
  temperature?: number;
  timeoutMs?:  number;
};

export interface HtmlPptV3LLMClient {
  callStructured<T extends z.ZodTypeAny>(args: {
    stage?: string;
    structuredOutputName?: string;
    systemPrompt: string;
    userPrompt: string;
    schema: T;
    maxTokens?: number;
    temperature?: number;
    retries?: number;
  }): Promise<z.infer<T>>;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const TRANSIENT_STATUS   = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_TRANSPORT_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 900;

export class HtmlPptV3LlmClient implements HtmlPptV3LLMClient {
  private modelCallCount = 0;

  constructor(
    private readonly config:          ActiveLlmConfig,
    private readonly logger?:         Logger,
    private readonly loggingService?: LlmLoggingService,
    private readonly userId?:         number,
    private readonly projectId?:      string | null,
    private readonly messageId?:      string | null,
    private readonly jobId?:          string | null,
  ) {}

  async callStructured<T extends z.ZodTypeAny>(args: {
    stage?: string;
    structuredOutputName?: string;
    systemPrompt: string;
    userPrompt: string;
    schema: T;
    maxTokens?: number;
    temperature?: number;
    retries?: number;
  }): Promise<z.infer<T>> {
    const maxAttempts = Math.max(1, (args.retries ?? 1) + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await this.completeJson({
          stage: args.stage ?? "v3-structured-output",
          system: args.systemPrompt,
          user: attempt === 1
            ? args.userPrompt
            : `${args.userPrompt}\n\n上一次输出未通过 JSON schema 校验，请只返回修正后的严格 JSON。错误：${formatError(lastError)}`,
          temperature: args.temperature
        }, args.maxTokens, {
          name: sanitizeStructuredOutputName(args.structuredOutputName ?? args.stage ?? "html_ppt_v3_structured_output"),
          schema: args.schema
        });
        const parsed = typeof raw === "string" ? safeJsonParse(raw) ?? raw : raw;
        return args.schema.parse(parsed);
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts) break;
        await sleep(500 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Structured LLM call failed."));
  }

  getModelCallCount(): number {
    return this.modelCallCount;
  }

  async completeJson(req: V3JsonRequest, maxTokens?: number, structuredOutput?: { name: string; schema: z.ZodTypeAny }): Promise<unknown> {
    const timeoutMs  = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const useJsonMode = this.shouldUseJsonMode();
    const useMiniMaxJsonSchema = this.shouldUseMiniMaxJsonSchema();
    const requestUrl = useMiniMaxJsonSchema
      ? normalizeMiniMaxTextGenerationEndpoint(this.config.baseUrl)
      : `${this.config.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model:       this.config.model,
      temperature: req.temperature ?? 0,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user",   content: req.user },
      ],
    };

    if (useMiniMaxJsonSchema && structuredOutput) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: structuredOutput.name,
          schema: z.toJSONSchema(structuredOutput.schema)
        }
      };
    } else if (useJsonMode) {
      body["response_format"] = { type: "json_object" };
    } else {
      // Prompt-level JSON instruction as fallback
      (body.messages as Array<{ role: string; content: string }>)[0]!.content +=
        "\n\nIMPORTANT: Output ONLY valid JSON. No markdown. No prose.";
    }

    const maxAttempts = readPositiveIntEnv("HTML_PPT_V3_LLM_TRANSPORT_ATTEMPTS", DEFAULT_TRANSPORT_ATTEMPTS);
    const retryBaseMs = readPositiveIntEnv("HTML_PPT_V3_LLM_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      this.modelCallCount += 1;

      try {
        const res = await fetch(requestUrl, {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization:  `Bearer ${this.config.apiKey}`,
          },
          body:   JSON.stringify(body),
          signal: controller.signal,
        });

        const rawText  = await res.text();
        const latencyMs = Date.now() - startedAt;
        const envelope = safeJsonParse(rawText) as Record<string, unknown> | null;
        const choice = res.ok
          ? (envelope?.["choices"] as Array<{ message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }> | undefined)?.[0]
          : undefined;
        const message = choice?.message;
        const content = message?.content ?? null;
        const parsedMessage = parseStructuredMessageJson(message);
        const finishReason = choice?.finish_reason ?? null;
        const truncated = res.ok && finishReason === "length";
        const completionError = truncated
          ? `LLM response was truncated by max token limit. Stage: ${req.stage}`
          : rawText.slice(0, 400);
        const responsePayload = parsedMessage?.warning
          ? {
              raw: envelope ?? rawText,
              structuredOutput: {
                parsedFrom: parsedMessage.source,
                warning: parsedMessage.warning
              }
            }
          : envelope ?? rawText;

        await this.log({
          stage:           req.stage,
          requestPayload:  body,
          responsePayload,
          status:          res.ok && (content || parsedMessage) && !truncated ? "success" : "error",
          errorMessage:    res.ok && (content || parsedMessage) && !truncated ? null : completionError,
          latencyMs,
        });

        if (!res.ok) {
          const error = new Error(`LLM API error (${res.status}): ${rawText.slice(0, 300)}`);
          lastError = error;
          if (attempt < maxAttempts && TRANSIENT_STATUS.has(res.status)) {
            await sleep(computeTransportBackoffMs(attempt, retryBaseMs));
            continue;
          }
          throw error;
        }

        if (truncated) {
          throw markLogged(new Error(completionError));
        }

        if (parsedMessage) {
          return parsedMessage.value;
        }

        if (!content) {
          throw markLogged(new Error(`LLM response missing content field. Stage: ${req.stage}`));
        }

        // Return raw content if not parseable; schema parsing in callStructured
        // will produce the retry error context.
        return content;

      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const normalizedError = normalizeTransportError(err);
        if (!isLogged(err)) {
          await this.log({
            stage:           req.stage,
            requestPayload:  body,
            responsePayload: null,
            status:          isAbort(err) ? "timeout" : "error",
            errorMessage:    formatTransportError(err),
            latencyMs,
          });
        }
        lastError = normalizedError;
        if (attempt < maxAttempts && (isAbort(err) || isTransient(err))) {
          await sleep(computeTransportBackoffMs(attempt, retryBaseMs));
          continue;
        }
        throw normalizedError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "LLM request failed."));
  }

  private shouldUseJsonMode(): boolean {
    const host  = safeHost(this.config.baseUrl);
    const model = this.config.model.toLowerCase();
    const type  = this.config.providerType.toLowerCase();
    return (
      host.includes("api.openai.com") ||
      host.includes("openrouter.ai") ||
      host.includes("azure.com") ||
      type === "openai" ||
      /^(gpt-|o[134]|chatgpt-)/.test(model)
    );
  }

  private shouldUseMiniMaxJsonSchema(): boolean {
    // MiniMax official JSON schema mode is intentionally opt-in. Most configured
    // MiniMax-compatible keys are relay keys or plans that do not support
    // MiniMax-Text-01 JSON schema; the default V3 path remains prompt-level JSON.
    if (process.env.HTML_PPT_V3_ENABLE_MINIMAX_JSON_SCHEMA !== "1") return false;
    const type = this.config.providerType.toLowerCase();
    const model = this.config.model.toLowerCase();
    return type === "minimax" && model === "minimax-text-01";
  }

  private async log(input: {
    stage:           string;
    requestPayload:  unknown;
    responsePayload: unknown;
    status:          "success" | "error" | "timeout";
    errorMessage:    string | null;
    latencyMs:       number;
  }) {
    const requestPayload = {
      v3Context: {
        jobId: this.jobId ?? null,
        projectId: this.projectId ?? null,
        messageId: this.messageId ?? null
      },
      request: input.requestPayload
    };
    const responsePayload = {
      v3Context: {
        jobId: this.jobId ?? null,
        projectId: this.projectId ?? null,
        messageId: this.messageId ?? null
      },
      response: input.responsePayload
    };
    await this.loggingService?.logPayload({
      configId:        this.config.id,
      userId:          this.userId ?? null,
      // llm_call_payloads.project_id/message_id reference the V1 ppt tables.
      // V3 project/message UUIDs are stored inside payload.v3Context instead.
      projectId:       null,
      messageId:       null,
      source:          "html-ppt-v3",
      stage:           input.stage,
      requestPayload,
      responsePayload,
      status:          input.status,
      errorMessage:    input.errorMessage,
      latencyMs:       input.latencyMs,
    }).catch((err) => {
      this.logger?.warn(`V3 log error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function safeJsonParse(s: string): unknown {
  const parsed = tryJsonParse(s);
  return parsed.ok ? parsed.value : null;
}

function parseStructuredMessageJson(message?: { content?: string | null; reasoning_content?: string | null }): {
  value: unknown;
  source: "content" | "content_extracted_json" | "reasoning_content" | "reasoning_content_extracted_json";
  warning?: string;
} | null {
  const contentParsed = parseJsonText(message?.content ?? "");
  if (contentParsed) {
    return {
      value: contentParsed.value,
      source: contentParsed.extracted ? "content_extracted_json" : "content",
      warning: contentParsed.extracted ? "parsedJsonFromThinkWrappedContent" : undefined
    };
  }

  const reasoningParsed = parseJsonText(message?.reasoning_content ?? "");
  if (reasoningParsed) {
    return {
      value: reasoningParsed.value,
      source: reasoningParsed.extracted ? "reasoning_content_extracted_json" : "reasoning_content",
      warning: "parsedFromReasoningContent"
    };
  }

  return null;
}

function parseJsonText(text: string): { value: unknown; extracted: boolean } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryJsonParse(trimmed);
  if (direct.ok) return { value: direct.value, extracted: false };

  const extracted = extractFinalJsonObject(trimmed);
  if (extracted.ok) return { value: extracted.value, extracted: true };

  return null;
}

function tryJsonParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(s.trim()) }; } catch { return { ok: false }; }
}

function extractFinalJsonObject(text: string): { ok: true; value: unknown } | { ok: false } {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    const end = findMatchingJsonObjectEnd(text, start);
    if (end < 0) continue;
    if (text.slice(end + 1).trim()) continue;
    const parsed = tryJsonParse(text.slice(start, end + 1));
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}

function findMatchingJsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function safeHost(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function normalizeMiniMaxTextGenerationEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/text\/chatcompletion_v2$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/text/chatcompletion_v2`;
  return `${trimmed}/v1/text/chatcompletion_v2`;
}

function sanitizeStructuredOutputName(value: string): string {
  const sanitized = value.trim().replace(/\W+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return sanitized || "html_ppt_v3_structured_output";
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort|timeout/i.test(err.message));
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket/i.test(msg);
}

function normalizeTransportError(err: unknown): Error {
  if (err instanceof Error && err.message === "fetch failed") {
    return new Error(formatTransportError(err), { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function formatTransportError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { name?: string; code?: string; message?: string } }).cause;
  if (!cause) return err.message;
  const code = cause.code ? ` code=${cause.code}` : "";
  const name = cause.name ? ` cause=${cause.name}` : "";
  const message = cause.message ? ` message=${cause.message}` : "";
  return `${err.message}${name}${code}${message}`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeTransportBackoffMs(attempt: number, baseMs: number): number {
  return Math.min(15_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

// Prevent double-logging via a sentinel property
const LOGGED = Symbol("logged");
function markLogged(error: Error): Error {
  (error as unknown as Record<symbol, unknown>)[LOGGED] = true;
  return error;
}

function isLogged(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as Record<symbol, unknown>)[LOGGED]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
