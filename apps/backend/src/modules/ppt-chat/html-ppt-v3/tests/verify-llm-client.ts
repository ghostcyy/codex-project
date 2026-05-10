import { z } from "zod";
import { HtmlPptV3LlmClient } from "../orchestration/html-ppt-v3-llm-client";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";

type PayloadLog = {
  source?: string;
  stage?: string | null;
  projectId?: string | null;
  messageId?: string | null;
  status: "success" | "error" | "timeout";
  requestPayload?: unknown;
  responsePayload?: unknown;
};

const originalFetch = globalThis.fetch;

async function main() {
  await verifiesMiniMaxJsonSchemaMode();
  await verifiesReasoningContentJsonFallback();
  await verifiesThinkWrappedContentJsonExtraction();
  await verifiesTransientTransportRetries();
  const logs: PayloadLog[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const client = new HtmlPptV3LlmClient(
      {
        id: "llm-config-1",
        name: "mock",
        providerType: "openai-compatible",
        baseUrl: "https://mock.local/v1",
        apiKey: "test-key",
        model: "mock-json-model",
        stageModelOverrides: {},
        enabled: true
      } satisfies ActiveLlmConfig,
      undefined,
      { logPayload: async (input: PayloadLog) => { logs.push(input); } } as never,
      undefined,
      "project-1",
      "message-1",
      "job-1"
    );

    const result = await client.callStructured({
      stage: "v3-stage1-planner",
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      schema: z.object({ ok: z.boolean() }),
      retries: 0
    });

    if (!result.ok) throw new Error("LLM client should parse structured JSON response.");
    if (client.getModelCallCount() !== 1) {
      throw new Error(`LLM client should count provider calls; got ${client.getModelCallCount()}.`);
    }
    const log = logs[0];
    if (!log) throw new Error("LLM client should write a payload log.");
    if (log.source !== "html-ppt-v3") throw new Error(`Payload log source should be html-ppt-v3, got ${log.source}.`);
    if (log.stage !== "v3-stage1-planner") throw new Error(`Payload log stage should be v3-stage1-planner, got ${log.stage ?? "null"}.`);
    if (log.status !== "success") throw new Error(`Payload log should record success, got ${log.status}.`);
    if (log.projectId !== null || log.messageId !== null) {
      throw new Error("V3 payload logs should not write V3 UUIDs into V1 project/message foreign-key columns.");
    }
    const requestPayload = log.requestPayload as { v3Context?: { jobId?: string; projectId?: string; messageId?: string } } | undefined;
    if (
      requestPayload?.v3Context?.jobId !== "job-1" ||
      requestPayload.v3Context.projectId !== "project-1" ||
      requestPayload.v3Context.messageId !== "message-1"
    ) {
      throw new Error("V3 payload logs should preserve job/project/message ids inside requestPayload.v3Context.");
    }

    console.log("HTML-PPT v3 LLM client verification passed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifiesTransientTransportRetries() {
  const previousAttempts = process.env.HTML_PPT_V3_LLM_TRANSPORT_ATTEMPTS;
  const previousBaseMs = process.env.HTML_PPT_V3_LLM_RETRY_BASE_MS;
  process.env.HTML_PPT_V3_LLM_TRANSPORT_ATTEMPTS = "5";
  process.env.HTML_PPT_V3_LLM_RETRY_BASE_MS = "1";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 5) {
      const cause = new Error("Client network socket disconnected before secure TLS connection was established") as Error & { code?: string };
      cause.code = "ECONNRESET";
      throw new TypeError("fetch failed", { cause });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const client = new HtmlPptV3LlmClient({
      id: "transport-config-1",
      name: "mock",
      providerType: "openai-compatible",
      baseUrl: "https://mock.local/v1",
      apiKey: "test-key",
      model: "mock-json-model",
      stageModelOverrides: {},
      enabled: true
    } satisfies ActiveLlmConfig);

    const result = await client.callStructured({
      stage: "v3-stage1-planner",
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      schema: z.object({ ok: z.boolean() }),
      retries: 0
    });

    if (!result.ok) throw new Error("LLM client should recover after transient ECONNRESET retries.");
    if (attempts !== 5) {
      throw new Error(`LLM client should keep retrying transient ECONNRESET until the configured attempt limit, got ${attempts}.`);
    }
  } finally {
    if (previousAttempts === undefined) {
      delete process.env.HTML_PPT_V3_LLM_TRANSPORT_ATTEMPTS;
    } else {
      process.env.HTML_PPT_V3_LLM_TRANSPORT_ATTEMPTS = previousAttempts;
    }
    if (previousBaseMs === undefined) {
      delete process.env.HTML_PPT_V3_LLM_RETRY_BASE_MS;
    } else {
      process.env.HTML_PPT_V3_LLM_RETRY_BASE_MS = previousBaseMs;
    }
    globalThis.fetch = originalFetch;
  }
}

async function verifiesReasoningContentJsonFallback() {
  const logs: PayloadLog[] = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: "",
        reasoning_content: JSON.stringify({ ok: true })
      }
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const client = new HtmlPptV3LlmClient(
      {
        id: "reasoning-config-1",
        name: "mock",
        providerType: "openai-compatible",
        baseUrl: "https://mock.local/v1",
        apiKey: "test-key",
        model: "mock-json-model",
        stageModelOverrides: {},
        enabled: true
      } satisfies ActiveLlmConfig,
      undefined,
      { logPayload: async (input: PayloadLog) => { logs.push(input); } } as never
    );

    const result = await client.callStructured({
      stage: "v3-stage2-writer",
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      schema: z.object({ ok: z.boolean() }),
      retries: 0
    });

    if (!result.ok) throw new Error("LLM client should parse JSON from MiniMax reasoning_content when content is empty.");
    const serializedLog = JSON.stringify(logs[0]?.responsePayload ?? {});
    if (!serializedLog.includes("parsedFromReasoningContent")) {
      throw new Error("LLM client should record a warning/metadata marker when parsing JSON from reasoning_content.");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifiesThinkWrappedContentJsonExtraction() {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: `<think>先分析，但这不是最终 JSON。</think>\n\n${JSON.stringify({ ok: true })}`
      }
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const client = new HtmlPptV3LlmClient({
      id: "think-config-1",
      name: "mock",
      providerType: "openai-compatible",
      baseUrl: "https://mock.local/v1",
      apiKey: "test-key",
      model: "mock-json-model",
      stageModelOverrides: {},
      enabled: true
    } satisfies ActiveLlmConfig);

    const result = await client.callStructured({
      stage: "v3-stage2-writer",
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      schema: z.object({ ok: z.boolean() }),
      retries: 0
    });

    if (!result.ok) throw new Error("LLM client should extract the final JSON object after <think> content.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifiesMiniMaxJsonSchemaMode() {
  const previousFlag = process.env.HTML_PPT_V3_ENABLE_MINIMAX_JSON_SCHEMA;
  process.env.HTML_PPT_V3_ENABLE_MINIMAX_JSON_SCHEMA = "1";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    });
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const client = new HtmlPptV3LlmClient({
      id: "json-config-1",
      name: "Default JSON Model",
      providerType: "minimax",
      baseUrl: "https://api.minimax.io/v1",
      apiKey: "test-key",
      model: "MiniMax-Text-01",
      stageModelOverrides: {},
      enabled: true
    } satisfies ActiveLlmConfig);

    const result = await client.callStructured({
      stage: "v3-intent-parse",
      structuredOutputName: "html_ppt_v3_intent",
      systemPrompt: "Return JSON.",
      userPrompt: "{}",
      schema: z.object({ ok: z.boolean() }),
      retries: 0
    });

    if (!result.ok) throw new Error("MiniMax JSON schema mode should parse structured JSON.");
    const request = requests[0];
    if (!request) throw new Error("MiniMax JSON schema mode should issue one request.");
    if (!request.url.endsWith("/text/chatcompletion_v2")) {
      throw new Error(`MiniMax JSON schema mode should use text/chatcompletion_v2, got ${request.url}.`);
    }
    const responseFormat = request.body.response_format as { type?: string; json_schema?: { name?: string; schema?: unknown } } | undefined;
    if (responseFormat?.type !== "json_schema") {
      throw new Error(`MiniMax JSON schema mode should send response_format.type=json_schema, got ${JSON.stringify(responseFormat)}.`);
    }
    if (responseFormat.json_schema?.name !== "html_ppt_v3_intent") {
      throw new Error(`MiniMax JSON schema mode should send schema name, got ${JSON.stringify(responseFormat.json_schema)}.`);
    }
    if (!responseFormat.json_schema?.schema) {
      throw new Error("MiniMax JSON schema mode should send a concrete JSON schema.");
    }
  } finally {
    if (previousFlag === undefined) {
      delete process.env.HTML_PPT_V3_ENABLE_MINIMAX_JSON_SCHEMA;
    } else {
      process.env.HTML_PPT_V3_ENABLE_MINIMAX_JSON_SCHEMA = previousFlag;
    }
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
