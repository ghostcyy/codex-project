import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import { HtmlPptV2JsonModelClient } from "../orchestration/html-ppt-v2-llm-client";

type RecordedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;

async function main() {
  try {
    await verifiesOpenAiJsonObjectMode();
    await verifiesMiniMaxStaysInTextJsonMode();
    await verifiesMiniMaxCliProviderUsesCliJsonOutput();
    await verifiesUnsupportedResponseFormatFallback();
    await verifiesMissingContentEnvelopeRetries();
    await verifiesFetchFailureRetries();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.HTML_PPT_V2_RESPONSE_FORMAT;
    delete process.env.HTML_PPT_V2_MMX_CLI_BIN;
    delete process.env.HTML_PPT_V2_MMX_CLI_PREARGS_JSON;
  }

  console.log("HTML-PPT v2 LLM client structured-output verification passed.");
}

async function verifiesOpenAiJsonObjectMode() {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mockFetch(requests, [
    okResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] })
  ]);

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", providerType: "openai" })
  });
  const content = await client.completeJson(baseRequest({ maxAttempts: 1 }));

  if (content !== "{\"ok\":true}") {
    throw new Error("OpenAI JSON mode test did not return model content.");
  }
  if (JSON.stringify(requests[0]?.body.response_format) !== JSON.stringify({ type: "json_object" })) {
    throw new Error("OpenAI-compatible provider should receive response_format json_object.");
  }
}

async function verifiesMiniMaxStaysInTextJsonMode() {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mockFetch(requests, [
    okResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] })
  ]);

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://api.minimax.chat/v1", model: "abab6.5s-chat", providerType: "minimax" })
  });
  await client.completeJson(baseRequest({ maxAttempts: 1 }));

  if ("response_format" in (requests[0]?.body ?? {})) {
    throw new Error("MiniMax should not receive response_format by default.");
  }
  const messages = requests[0]?.body.messages;
  if (!Array.isArray(messages)) {
    throw new Error("MiniMax request should include chat messages.");
  }
  const systemMessage = messages.find((message) => message?.role === "system")?.content ?? "";
  const userMessage = messages.find((message) => message?.role === "user")?.content ?? "";
  if (!String(systemMessage).includes("MiniMax JSON-only response contract")) {
    throw new Error("MiniMax request should include the injected JSON-only system contract.");
  }
  if (!String(userMessage).includes("Final reminder: return JSON only.")) {
    throw new Error("MiniMax request should include the final JSON-only user reminder.");
  }
}

async function verifiesMiniMaxCliProviderUsesCliJsonOutput() {
  const tempDir = join(process.cwd(), ".local-runtime", "html-ppt-v2-llm-client-tests");
  await mkdir(tempDir, { recursive: true });
  const fakeCliPath = join(tempDir, "fake-mmx-cli.mjs");
  await writeFile(
    fakeCliPath,
    `
import { readFileSync } from "node:fs";

const messagesFileIndex = process.argv.indexOf("--messages-file");
const messagesFile = messagesFileIndex >= 0 ? process.argv[messagesFileIndex + 1] : "";
const input = readFileSync(messagesFile, "utf8");
const messages = JSON.parse(input);
if (!process.argv.includes("--output") || !process.argv.includes("json")) {
  throw new Error("MiniMax CLI adapter must request --output json.");
}
if (!messagesFile || messagesFile === "-") {
  throw new Error("MiniMax CLI adapter must pass a concrete messages file path for Windows compatibility.");
}
const systemMessage = messages.find((message) => message.role === "system")?.content ?? "";
if (!systemMessage.includes("MiniMax JSON-only response contract")) {
  throw new Error("MiniMax CLI adapter should keep the JSON-only prompt contract as a defense-in-depth guard.");
}
process.stdout.write(JSON.stringify({ content: "{\\"ok\\":true,\\"via\\":\\"mmx-cli\\"}" }));
`,
    "utf8"
  );

  process.env.HTML_PPT_V2_MMX_CLI_BIN = process.execPath;
  process.env.HTML_PPT_V2_MMX_CLI_PREARGS_JSON = JSON.stringify([fakeCliPath]);
  globalThis.fetch = async () => {
    throw new Error("MiniMax CLI provider should not use fetch.");
  };

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M2.7-highspeed", providerType: "minimax-cli" })
  });
  const content = await client.completeJson(baseRequest({ maxAttempts: 1 }));
  const parsed = JSON.parse(String(content)) as { ok?: boolean; via?: string };

  if (parsed.ok !== true || parsed.via !== "mmx-cli") {
    throw new Error("MiniMax CLI provider did not return CLI JSON content.");
  }
}

async function verifiesUnsupportedResponseFormatFallback() {
  const requests: RecordedRequest[] = [];
  process.env.HTML_PPT_V2_RESPONSE_FORMAT = "json_object";
  globalThis.fetch = mockFetch(requests, [
    errorResponse(400, { error: { message: "invalid params, invalid chat setting" } }),
    okResponse({ choices: [{ message: { content: "{\"fallback\":true}" } }] })
  ]);

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://example-compat.test/v1", model: "compat-model", providerType: "openai-compatible" })
  });
  const content = await client.completeJson(baseRequest({ maxAttempts: 2 }));

  if (content !== "{\"fallback\":true}") {
    throw new Error("Fallback test did not return second-attempt model content.");
  }
  if (!("response_format" in (requests[0]?.body ?? {}))) {
    throw new Error("Forced structured output should be present on the first request.");
  }
  if ("response_format" in (requests[1]?.body ?? {})) {
    throw new Error("Provider rejection should disable response_format on retry.");
  }
}

async function verifiesMissingContentEnvelopeRetries() {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mockFetch(requests, [
    okResponse({ id: "empty-envelope", choices: [{ message: {} }] }),
    okResponse({ choices: [{ message: { content: "{\"retried\":true}" } }] })
  ]);

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://example-compat.test/v1", model: "compat-model", providerType: "openai-compatible" })
  });
  const content = await client.completeJson(baseRequest({ maxAttempts: 2 }));

  if (content !== "{\"retried\":true}") {
    throw new Error("Missing content retry test did not return second-attempt model content.");
  }
  if (requests.length !== 2) {
    throw new Error(`Missing content retry test expected 2 fetch attempts, got ${requests.length}.`);
  }
}

async function verifiesFetchFailureRetries() {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mockFetch(requests, [
    new TypeError("fetch failed"),
    okResponse({ choices: [{ message: { content: "{\"networkRetried\":true}" } }] })
  ]);

  const client = new HtmlPptV2JsonModelClient({
    config: config({ baseUrl: "https://example-compat.test/v1", model: "compat-model", providerType: "openai-compatible" })
  });
  const content = await client.completeJson(baseRequest({ maxAttempts: 2 }));

  if (content !== "{\"networkRetried\":true}") {
    throw new Error("Fetch failure retry test did not return second-attempt model content.");
  }
  if (requests.length !== 2) {
    throw new Error(`Fetch failure retry test expected 2 fetch attempts, got ${requests.length}.`);
  }
}

function baseRequest(options: { maxAttempts: number }) {
  return {
    stage: "stage-1:intent",
    system: "Return JSON only.",
    user: "Return {\"ok\":true}.",
    maxAttempts: options.maxAttempts,
    timeoutMs: 10_000
  };
}

function config(overrides: Partial<ActiveLlmConfig>): ActiveLlmConfig {
  return {
    id: "test-config",
    name: "Test Config",
    providerType: "openai-compatible",
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    stageModelOverrides: {},
    enabled: true,
    ...overrides
  };
}

function mockFetch(requests: RecordedRequest[], responses: Array<Response | Error>): typeof fetch {
  let index = 0;
  return async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ url: String(url), body });
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error("Unexpected fetch call.");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
