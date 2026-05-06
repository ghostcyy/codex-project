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
        }, args.maxTokens);
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

  async completeJson(req: V3JsonRequest, maxTokens?: number): Promise<unknown> {
    const timeoutMs  = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const useJsonMode = this.shouldUseJsonMode();

    const body: Record<string, unknown> = {
      model:       this.config.model,
      temperature: req.temperature ?? 0,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user",   content: req.user },
      ],
    };

    if (useJsonMode) {
      body["response_format"] = { type: "json_object" };
    } else {
      // Prompt-level JSON instruction as fallback
      (body.messages as Array<{ role: string; content: string }>)[0]!.content +=
        "\n\nIMPORTANT: Output ONLY valid JSON. No markdown. No prose.";
    }

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      this.modelCallCount += 1;

      try {
        const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
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
          ? (envelope?.["choices"] as Array<{ message?: { content?: string }; finish_reason?: string | null }> | undefined)?.[0]
          : undefined;
        const content = choice?.message?.content ?? null;
        const finishReason = choice?.finish_reason ?? null;
        const truncated = res.ok && finishReason === "length";
        const completionError = truncated
          ? `LLM response was truncated by max token limit. Stage: ${req.stage}`
          : rawText.slice(0, 400);

        await this.log({
          stage:           req.stage,
          requestPayload:  body,
          responsePayload: envelope ?? rawText,
          status:          res.ok && content && !truncated ? "success" : "error",
          errorMessage:    res.ok && content && !truncated ? null : completionError,
          latencyMs,
        });

        if (!res.ok) {
          const error = new Error(`LLM API error (${res.status}): ${rawText.slice(0, 300)}`);
          lastError = error;
          if (attempt < maxAttempts && TRANSIENT_STATUS.has(res.status)) {
            await sleep(1000 * attempt);
            continue;
          }
          throw error;
        }

        if (!content) {
          throw new Error(`LLM response missing content field. Stage: ${req.stage}`);
        }

        if (truncated) {
          throw markLogged(new Error(completionError));
        }

        // Try to parse the content as JSON; return raw string if not parseable
        return safeJsonParse(content) ?? content;

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
          await sleep(900 * attempt);
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
  try { return JSON.parse(s.trim()); } catch { return null; }
}

function safeHost(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
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
