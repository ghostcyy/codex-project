import type { Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveLlmConfig, LlmStageModelRole } from "../../../llm-config/llm-config.types";
import type { LlmLoggingService } from "../../../llm-logging/llm-logging.service";
import type { JsonOnlyModelClient, JsonOnlyModelRequest } from "../stages";

type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

type StructuredOutputMode = "none" | "json_object";

const MINIMAX_JSON_ONLY_INSTRUCTION = [
  "MiniMax JSON-only response contract:",
  "Return exactly one valid JSON value that can be parsed by JSON.parse.",
  "Do not wrap the JSON in Markdown fences.",
  "Do not add explanations, comments, prefixes, suffixes, or natural-language text.",
  "Use double quotes for all JSON object keys and string values."
].join("\n");

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HTML_PPT_V2_MODEL_TIMEOUT_MS ?? "", 10) || 180_000;
const DEFAULT_MAX_ATTEMPTS = Number.parseInt(process.env.HTML_PPT_V2_MODEL_MAX_ATTEMPTS ?? "", 10) || 3;
const TRANSIENT_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export type HtmlPptV2JsonModelClientInput = {
  config: ActiveLlmConfig;
  userId?: number;
  projectId?: string | null;
  messageId?: string | null;
  logger?: Logger;
  loggingService?: LlmLoggingService;
};

export class HtmlPptV2JsonModelClient implements JsonOnlyModelClient {
  constructor(private readonly input: HtmlPptV2JsonModelClientInput) {}

  async completeJson(request: JsonOnlyModelRequest): Promise<unknown> {
    const config = this.input.config;
    const model = this.modelForStage(request.stage);
    let structuredOutputMode = resolveStructuredOutputMode(config, model);
    const messages = buildJsonOnlyMessages({
      config,
      model,
      request,
      structuredOutputMode
    });
    if (isMiniMaxCliProvider(config)) {
      // MiniMax CLI is the preferred JSON-only path for V2: `mmx text chat --output json`
      // delegates structure enforcement to the official CLI instead of HTTP response_format.
      return this.completeJsonViaMmxCli({
        request,
        model,
        messages,
        timeoutMs: clampInteger(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000, 600_000)
      });
    }

    const requestPayload: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0
    };
    const maxAttempts = clampInteger(request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 5);
    const timeoutMs = clampInteger(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000, 600_000);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Model request timed out after ${timeoutMs}ms.`)), timeoutMs);
      const attemptPayload = withStructuredOutput(requestPayload, structuredOutputMode);

      try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify(attemptPayload),
          cache: "no-store",
          signal: controller.signal
        });
        const rawText = await response.text();
        const parsed = parseJson(rawText) as ChatCompletionResponse | null;
        const latencyMs = Date.now() - startedAt;
        const content = response.ok ? parsed?.choices?.[0]?.message?.content : null;
        const missingContentMessage =
          response.ok && (typeof content !== "string" || !content.trim())
            ? `Model response did not contain choices[0].message.content. Envelope shape: ${describeProviderEnvelopeShape(parsed ?? rawText)}`
            : null;
        const errorMessage = response.ok ? missingContentMessage : (parsed?.error?.message ?? (rawText.slice(0, 500) || `HTTP ${response.status}`));

        await this.logPayload({
          stage: request.stage,
          requestPayload: { ...attemptPayload, attempt, maxAttempts, timeoutMs, structuredOutputMode },
          responsePayload: missingContentMessage ? summarizeProviderEnvelope(parsed ?? rawText) : (parsed ?? rawText),
          status: response.ok && !missingContentMessage ? "success" : "error",
          errorMessage,
          latencyMs
        });

        if (response.ok && parsed?.usage) {
          await this.input.loggingService?.logCall(
            config.id,
            this.input.userId ?? null,
            parsed.usage.prompt_tokens ?? 0,
            parsed.usage.completion_tokens ?? 0,
            parsed.usage.total_tokens ?? 0
          ).catch((error) => {
            this.input.logger?.warn(`Failed to log HTML-PPT v2 usage: ${error instanceof Error ? error.message : String(error)}`);
          });
        }

        if (!response.ok) {
          const error = markLogged(new Error(errorMessage ?? `Model request failed with status ${response.status}.`));
          lastError = error;
          if (structuredOutputMode !== "none" && isUnsupportedStructuredOutput(response.status, errorMessage ?? rawText)) {
            this.input.logger?.warn(`HTML-PPT v2 provider rejected response_format; falling back to text JSON mode for stage ${request.stage}.`);
            structuredOutputMode = "none";
            if (attempt < maxAttempts) {
              continue;
            }
          }
          if (attempt < maxAttempts && TRANSIENT_HTTP_STATUS.has(response.status)) {
            await this.sleepBeforeRetry(attempt, error.message);
            continue;
          }
          throw error;
        }

        if (missingContentMessage) {
          const error = markLogged(new Error(missingContentMessage));
          lastError = error;
          if (attempt < maxAttempts) {
            await this.sleepBeforeRetry(attempt, error.message);
            continue;
          }
          throw error;
        }
        return content;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const timeout = isAbortError(error);
        lastError = error;
        if (!isLoggedError(error)) {
          await this.logPayload({
            stage: request.stage,
            requestPayload: { ...attemptPayload, attempt, maxAttempts, timeoutMs, structuredOutputMode },
            responsePayload: null,
            status: timeout ? "timeout" : "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            latencyMs
          });
        }

        if (attempt < maxAttempts && (timeout || isTransientModelError(error))) {
          await this.sleepBeforeRetry(attempt, error instanceof Error ? error.message : String(error));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Model request failed."));
  }

  private async completeJsonViaMmxCli(input: {
    request: JsonOnlyModelRequest;
    model: string;
    messages: ChatCompletionMessage[];
    timeoutMs: number;
  }): Promise<unknown> {
    const startedAt = Date.now();
    const cli = resolveMmxCliCommand();
    const messagesFile = await prepareMmxMessagesFile(input.messages);
    const args = [
      ...cli.preargs,
      "text",
      "chat",
      "--messages-file",
      messagesFile.path,
      "--output",
      "json",
      "--model",
      input.model
    ];
    if (this.input.config.apiKey.trim()) {
      args.push("--api-key", this.input.config.apiKey.trim());
    }
    const loggedArgs = args.map((arg, index) => (args[index - 1] === "--api-key" ? "[redacted]" : arg));
    const requestPayload = {
      command: cli.command,
      args: loggedArgs,
      messages: input.messages,
      timeoutMs: input.timeoutMs,
      providerType: this.input.config.providerType
    };

    try {
      const output = await runCliProcess({
        command: cli.command,
        args,
        timeoutMs: input.timeoutMs
      });
      const parsed = parseJson(output.stdout);
      const content = extractMmxCliContent(parsed ?? output.stdout);
      const latencyMs = Date.now() - startedAt;
      await this.logPayload({
        stage: input.request.stage,
        requestPayload,
        responsePayload: parsed ?? output.stdout,
        status: "success",
        errorMessage: null,
        latencyMs
      });
      return content;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      await this.logPayload({
        stage: input.request.stage,
        requestPayload,
        responsePayload: null,
        status: isAbortError(error) ? "timeout" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        latencyMs
      });
      throw error;
    } finally {
      await messagesFile.cleanup();
    }
  }

  private modelForStage(stage: string): string {
    const role = roleForStage(stage);
    return this.input.config.stageModelOverrides[role] || this.input.config.model;
  }

  private async logPayload(input: {
    stage: string;
    requestPayload: unknown;
    responsePayload: unknown;
    status: "success" | "error" | "timeout";
    errorMessage: string | null;
    latencyMs: number;
  }) {
    await this.input.loggingService?.logPayload({
      configId: this.input.config.id,
      userId: this.input.userId ?? null,
      projectId: this.input.projectId ?? null,
      messageId: this.input.messageId ?? null,
      source: "html-ppt-v2",
      stage: input.stage,
      requestPayload: input.requestPayload,
      responsePayload: input.responsePayload,
      status: input.status,
      errorMessage: input.errorMessage,
      latencyMs: input.latencyMs
    }).catch((error) => {
      this.input.logger?.warn(`Failed to log HTML-PPT v2 payload: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async sleepBeforeRetry(attempt: number, reason: string) {
    const delayMs = Math.min(12_000, 900 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 450));
    this.input.logger?.warn(`HTML-PPT v2 model request retrying after attempt ${attempt}: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function roleForStage(stage: string): LlmStageModelRole {
  if (stage.includes("evidence")) return "research";
  if (stage.includes("design")) return "visual";
  if (stage.includes("layout")) return "visual";
  if (stage.includes("slot")) return "section";
  if (stage.includes("critic")) return "qa";
  return "plan";
}

function buildJsonOnlyMessages(input: {
  config: ActiveLlmConfig;
  model: string;
  request: JsonOnlyModelRequest;
  structuredOutputMode: StructuredOutputMode;
}): ChatCompletionMessage[] {
  if (!shouldAddPromptOnlyJsonInstruction(input.config, input.model, input.structuredOutputMode)) {
    return [
      { role: "system", content: input.request.system },
      { role: "user", content: input.request.user }
    ];
  }

  // MiniMax HTTP and CLI both keep this prompt-level JSON contract as defense in depth.
  // The CLI provider additionally enforces JSON output with `mmx text chat --output json`.
  return [
    { role: "system", content: `${input.request.system}\n\n${MINIMAX_JSON_ONLY_INSTRUCTION}` },
    { role: "user", content: `${input.request.user}\n\nFinal reminder: return JSON only. No Markdown. No prose.` }
  ];
}

function shouldAddPromptOnlyJsonInstruction(config: ActiveLlmConfig, model: string, structuredOutputMode: StructuredOutputMode): boolean {
  return structuredOutputMode === "none" && isMiniMaxProvider(config, model);
}

function withStructuredOutput(payload: Record<string, unknown>, mode: StructuredOutputMode): Record<string, unknown> {
  if (mode === "json_object") {
    return {
      ...payload,
      response_format: { type: "json_object" }
    };
  }
  return payload;
}

function resolveStructuredOutputMode(config: ActiveLlmConfig, model: string): StructuredOutputMode {
  const override = process.env.HTML_PPT_V2_RESPONSE_FORMAT?.trim().toLowerCase();
  if (override === "off" || override === "false" || override === "none" || override === "0") {
    return "none";
  }
  if (override === "json_object" || override === "json") {
    return "json_object";
  }

  const provider = config.providerType.toLowerCase();
  const host = safeHost(config.baseUrl);
  const modelName = model.toLowerCase();
  if (isMiniMaxProvider(config, model)) {
    return "none";
  }
  if (host.includes("api.openai.com") || host.includes("openrouter.ai") || host.includes("azure.com")) {
    return "json_object";
  }
  if (provider === "openai" || provider === "openrouter" || provider === "azure-openai") {
    return "json_object";
  }
  if (/^(gpt-|o[134]|chatgpt-)/i.test(modelName)) {
    return "json_object";
  }
  return "none";
}

function isMiniMaxCliProvider(config: ActiveLlmConfig): boolean {
  return config.providerType.trim().toLowerCase() === "minimax-cli";
}

function isMiniMaxProvider(config: ActiveLlmConfig, model: string): boolean {
  const provider = config.providerType.toLowerCase();
  const host = safeHost(config.baseUrl);
  const modelName = model.toLowerCase();
  return host.includes("minimax") || provider.includes("minimax") || modelName.includes("minimax");
}

function resolveMmxCliCommand(): { command: string; preargs: string[] } {
  const preargs = parseStringArrayEnv(process.env.HTML_PPT_V2_MMX_CLI_PREARGS_JSON);
  const commandOverride = process.env.HTML_PPT_V2_MMX_CLI_BIN?.trim();
  if (commandOverride) {
    return { command: commandOverride, preargs };
  }
  const windowsGlobalScript = resolveWindowsGlobalMmxScript();
  if (windowsGlobalScript) {
    return { command: process.execPath, preargs: [...preargs, windowsGlobalScript] };
  }
  const command = "mmx";
  return { command, preargs };
}

function resolveWindowsGlobalMmxScript(): string | null {
  if (process.platform !== "win32") return null;
  const appData = process.env.APPDATA?.trim();
  if (!appData) return null;
  const candidate = join(appData, "npm", "node_modules", "mmx-cli", "dist", "mmx.mjs");
  return existsSync(candidate) ? candidate : null;
}

function parseStringArrayEnv(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function prepareMmxMessagesFile(messages: ChatCompletionMessage[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), "html-ppt-v2-mmx");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.messages.json`);
  await writeFile(path, JSON.stringify(messages), "utf8");
  return {
    path,
    cleanup: async () => {
      await unlink(path).catch(() => undefined);
    }
  };
}

function runCliProcess(input: {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: shouldUseShellForCli(input.command)
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`MiniMax CLI request timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`MiniMax CLI failed to start. Install mmx-cli and verify 'mmx auth status'. ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`MiniMax CLI exited with code ${code}. ${stderr || stdout}`.trim()));
    });
    child.stdin.end(input.stdin ?? "");
  });
}

function shouldUseShellForCli(command: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = command.trim().toLowerCase().replace(/\\/g, "/");
  return normalized === "mmx" || normalized.endsWith("/mmx") || normalized.endsWith("/mmx.cmd");
}

function extractMmxCliContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const content = tryExtractMmxCliContent(item);
      if (content) return content;
    }
  }
  const content = tryExtractMmxCliContent(value);
  if (content) return content;
  throw new Error("MiniMax CLI JSON output did not contain a recognizable text content field.");
}

function tryExtractMmxCliContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const directKeys = ["content", "text", "output_text", "output", "response", "result"];
  for (const key of directKeys) {
    if (typeof record[key] === "string") return record[key];
  }
  const message = record.message;
  if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") {
    return (message as Record<string, string>).content;
  }
  const data = record.data;
  if (data && typeof data === "object") {
    const nested = tryExtractMmxCliContent(data);
    if (nested) return nested;
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const nested = tryExtractMmxCliContent(choice);
      if (nested) return nested;
    }
  }
  return undefined;
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

function describeProviderEnvelopeShape(value: unknown): string {
  return JSON.stringify(summarizeProviderEnvelope(value)).slice(0, 600);
}

function summarizeProviderEnvelope(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return `[string:${value.length}]`;
  if (typeof value === "number" || typeof value === "boolean") return `[${typeof value}]`;
  if (depth >= 4) return "[max-depth]";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.length ? summarizeProviderEnvelope(value[0], depth + 1) : null
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record)
      .slice(0, 30)
      .map(([key, item]) => [
        key,
        isSensitiveEnvelopeKey(key) ? "[redacted]" : summarizeProviderEnvelope(item, depth + 1)
      ]);
    return {
      type: "object",
      keys: Object.keys(record).slice(0, 30),
      values: Object.fromEntries(entries)
    };
  }
  return `[${typeof value}]`;
}

function isSensitiveEnvelopeKey(key: string) {
  return /api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret|password|credential/i.test(key);
}

function isUnsupportedStructuredOutput(status: number, message: string): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }
  return /response_format|json_object|json schema|structured output|invalid chat setting|invalid param|unknown parameter|unsupported/i.test(message);
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isAbortError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|timed out|timeout/i.test(error.message);
}

function isTransientModelError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|UND_ERR|terminated|503|502|504|429|rate limit|temporar/i.test(message);
}

function markLogged<T extends Error>(error: T): T {
  (error as T & { htmlPptV2Logged?: boolean }).htmlPptV2Logged = true;
  return error;
}

function isLoggedError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "htmlPptV2Logged" in error);
}
