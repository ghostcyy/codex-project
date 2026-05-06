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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
