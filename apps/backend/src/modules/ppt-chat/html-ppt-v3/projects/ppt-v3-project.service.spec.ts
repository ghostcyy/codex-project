import type { GenerateRequest } from "../shared";
import { parsePptV3MessageRequest, pptV3NaturalLanguageParseSchema } from "./ppt-v3-message-parser";
import { PptV3ProjectService } from "./ppt-v3-project.service";

type QueryCall = { text: string; values: unknown[] };

class FakeDatabaseService {
  readonly calls: QueryCall[] = [];
  private readonly projects = new Map<string, Record<string, unknown>>();
  private readonly messages = new Map<string, Record<string, unknown>>();

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values });
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();

    if (
      normalized.startsWith("create table") ||
      normalized.startsWith("create index") ||
      normalized.startsWith("alter table")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("insert into ppt_v3_projects")) {
      const row = {
        id: values[0],
        user_id: values[1],
        owner_user_id: values[2],
        title: values[3],
        selected_template_id: values[4],
        created_at: new Date("2026-05-03T08:00:00.000Z"),
        updated_at: new Date("2026-05-03T08:00:00.000Z")
      };
      this.projects.set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.startsWith("select") && normalized.includes("from ppt_v3_projects")) {
      if (normalized.includes("where id = $1")) {
        const row = this.projects.get(String(values[0]));
        const owned = row && (!normalized.includes("owner_user_id = $2") || row.owner_user_id === values[1]);
        return { rows: owned ? [row] : [], rowCount: owned ? 1 : 0 };
      }
      const rows = [...this.projects.values()]
        .filter((row) => !normalized.includes("where owner_user_id = $1") || row.owner_user_id === values[0])
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("update ppt_v3_projects")) {
      if (normalized.includes("set owner_user_id =")) {
        return { rows: [], rowCount: 0 };
      }
      const row = this.projects.get(String(values[2] ?? values[values.length - 1]));
      if (!row) return { rows: [], rowCount: 0 };
      if (normalized.includes("owner_user_id = $4") && row.owner_user_id !== values[3]) return { rows: [], rowCount: 0 };
      if (normalized.includes("title = $1")) row.title = values[0];
      if (normalized.includes("selected_template_id = $2")) row.selected_template_id = values[1];
      else if (normalized.includes("selected_template_id = $1")) row.selected_template_id = values[0];
      row.updated_at = new Date("2026-05-03T08:01:00.000Z");
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.startsWith("insert into ppt_v3_messages")) {
      const row = {
        id: values[0],
        project_id: values[1],
        role: values[2],
        content: values[3],
        kind: values[4],
        metadata: values[5],
        created_at: new Date("2026-05-03T08:02:00.000Z")
      };
      this.messages.set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.startsWith("select") && normalized.includes("from ppt_v3_messages")) {
      const rows = [...this.messages.values()].filter((row) => row.project_id === values[0]);
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith("update ppt_v3_jobs")) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

class FakeJobService {
  readonly createdRequests: GenerateRequest[] = [];
  readonly createdOwnerUserIds: Array<number | string | null> = [];

  async createJob(request: GenerateRequest, ownerUserId: number | string | null = null) {
    this.createdRequests.push(request);
    this.createdOwnerUserIds.push(ownerUserId);
    return {
      id: "job-1",
      request,
      status: "pending",
      templateId: request.templateId,
      userId: null,
      ownerUserId: typeof ownerUserId === "number" ? ownerUserId : null,
      outputDir: null,
      zipPath: null,
      previewPath: null,
      plan: null,
      content: null,
      error: null,
      createdAt: new Date("2026-05-03T08:03:00.000Z"),
      completedAt: null
    };
  }
}

class OfflineLlmConfigService {
  async getActiveConfig() {
    throw new Error("LLM unavailable in verification.");
  }

  async getJsonConfig() {
    throw new Error("JSON LLM unavailable in verification.");
  }
}

class OnlineLlmConfigService {
  jsonConfigCalls = 0;
  activeConfigCalls = 0;

  async getActiveConfig() {
    this.activeConfigCalls++;
    return {
      id: "llm-config-1",
      name: "Mock OpenAI-compatible",
      providerType: "openai",
      baseUrl: "http://mock-llm.local/v1",
      apiKey: "test-key",
      model: "mock-json-model",
      stageModelOverrides: {},
      enabled: true
    };
  }

  async getJsonConfig() {
    this.jsonConfigCalls++;
    return {
      id: "json-config-1",
      name: "Mock JSON Model",
      providerType: "minimax",
      baseUrl: "http://mock-json.local/v1",
      apiKey: "test-key",
      model: "MiniMax-Text-01",
      stageModelOverrides: {},
      enabled: true
    };
  }
}

const gdprIntent = {
  schemaVersion: "html-ppt-v3.intent.v1",
  action: "generate_deck",
  status: "complete",
  deck: {
    contentTheme: "GDPR 数据合规的实操要点清单",
    title: "GDPR 数据合规的实操要点清单",
    pageCount: 14,
    wordBudget: 2000,
    audience: null,
    purpose: null,
    tone: null,
    mustInclude: [],
    mustAvoid: []
  },
  quality: {
    confidence: 0.95,
    missingFields: [],
    ambiguities: []
  },
  extensions: {}
};

async function main() {
  const db = new FakeDatabaseService();
  const jobs = new FakeJobService();
  const service = new PptV3ProjectService(
    db as never,
    jobs as never,
    new OfflineLlmConfigService() as never,
    { logPayload: async () => undefined } as never
  );
  await service.onModuleInit();

  const created = await service.createProject({
    ownerUserId: 1,
    title: "V3 Studio",
    selectedTemplateId: "01-tech-web3"
  });
  if (created.title !== "V3 Studio" || created.selectedTemplateId !== "01-tech-web3") {
    throw new Error("createProject should persist title and selectedTemplateId.");
  }

  const projects = await service.listProjects(1);
  if (projects.length !== 1 || projects[0]?.id !== created.id) {
    throw new Error("listProjects should return created V3 projects.");
  }
  const otherUserProjects = await service.listProjects(2);
  if (otherUserProjects.length !== 0) {
    throw new Error("listProjects should not return another owner's V3 projects.");
  }

  const unavailableIntent = await service.postMessage(created.id, 1, {
    content: "帮我做一份 AI Agent 落地路线图",
    metadata: {}
  });
  if (unavailableIntent.assistantMessage.kind !== "error" || jobs.createdRequests.length !== 0) {
    throw new Error("postMessage should fail clearly and avoid job creation when LLM intent parsing is unavailable.");
  }
  if (!String(unavailableIntent.assistantMessage.content).includes("意图解析失败")) {
    throw new Error("LLM intent parse failure should be reported explicitly instead of as missing fields.");
  }

  const noLlmPromptRequest = parsePptV3MessageRequest({
    content:
      "制作一个16页HTML PPT，主题为AI Agent在中小企业的落地路线，约2500字，面向企业管理者，包含场景、成本、风险与90天实施计划。模板 01-tech-web3，不要图片，不要视频，不要图表，不要音频。",
    metadata: {
      templateId: "01-tech-web3",
      includeImages: false,
      includeVideo: false,
      includeChart: false,
      includeAudio: false
    },
    projectSelectedTemplateId: null,
    llmParse: null
  });
  if (noLlmPromptRequest.ok || !noLlmPromptRequest.missingFields.includes("theme") || !noLlmPromptRequest.missingFields.includes("pageCount") || !noLlmPromptRequest.missingFields.includes("wordBudget")) {
    throw new Error("Project parser should not use regex fallback to derive theme/pageCount/wordBudget without LLM intent.");
  }

  const intentParsedRequest = parsePptV3MessageRequest({
    content: "制作一个html ppt，主题为GDPR 数据合规的实操要点清单，页数14，字数2000",
    metadata: {
      theme: "制作一个html ppt，主题为GDPR 数据合规的实操要点清单，页数14，字数2000",
      pageCount: 8,
      wordBudget: 1800,
      templateId: "04-edu-adaptive",
      includeImages: false,
      includeVideo: false,
      includeChart: false,
      includeAudio: false,
      includeSpeakerNotes: true
    },
    projectSelectedTemplateId: "04-edu-adaptive",
    llmParse: {
      schemaVersion: "html-ppt-v3.intent.v1",
      action: "generate_deck",
      status: "complete",
      deck: {
        contentTheme: "GDPR 数据合规的实操要点清单",
        title: "GDPR 数据合规的实操要点清单",
        pageCount: 14,
        wordBudget: 2000,
        audience: null,
        purpose: null,
        tone: null,
        mustInclude: [],
        mustAvoid: []
      },
      quality: {
        confidence: 0.95,
        missingFields: [],
        ambiguities: []
      },
      extensions: {}
    }
  });
  if (!intentParsedRequest.ok) {
    throw new Error(`intent parser should create a complete request: ${intentParsedRequest.issues.join("; ")}`);
  }
  if (
    intentParsedRequest.request.theme !== "GDPR 数据合规的实操要点清单" ||
    intentParsedRequest.request.pageCount !== 14 ||
    intentParsedRequest.request.wordBudget !== 2000
  ) {
    throw new Error(`intent parser should override frontend defaults, got ${JSON.stringify(intentParsedRequest.request)}.`);
  }
  if (intentParsedRequest.source !== "llm") {
    throw new Error(`intent parser should report llm as the parse source, got '${intentParsedRequest.source}'.`);
  }
  if (
    intentParsedRequest.request.includeImages !== false ||
    intentParsedRequest.request.includeVideo !== false ||
    intentParsedRequest.request.includeChart !== false ||
    intentParsedRequest.request.includeAudio !== false ||
    intentParsedRequest.request.includeSpeakerNotes !== true
  ) {
    throw new Error("intent parser should keep media and speaker notes choices controlled by metadata/UI.");
  }

  const intentWithUiImage = parsePptV3MessageRequest({
    content: "制作一个html ppt，主题为GDPR 数据合规的实操要点清单，页数14，字数2000，不要图片",
    metadata: {
      templateId: "04-edu-adaptive",
      includeImages: true,
      includeVideo: false,
      includeChart: false,
      includeAudio: false
    },
    projectSelectedTemplateId: "04-edu-adaptive",
    llmParse: {
      schemaVersion: "html-ppt-v3.intent.v1",
      action: "generate_deck",
      status: "complete",
      deck: {
        contentTheme: "GDPR 数据合规的实操要点清单",
        title: "GDPR 数据合规的实操要点清单",
        pageCount: 14,
        wordBudget: 2000,
        audience: null,
        purpose: null,
        tone: null,
        mustInclude: [],
        mustAvoid: []
      },
      quality: {
        confidence: 0.95,
        missingFields: [],
        ambiguities: []
      },
      extensions: {}
    }
  });
  if (!intentWithUiImage.ok || intentWithUiImage.request.includeImages !== true) {
    throw new Error("intent parser should not let natural language override UI media toggles.");
  }

  const providerVariantIntent = pptV3NaturalLanguageParseSchema.parse({
    status: "ready",
    schemaVersion: "html-ppt-v3.intent.v1",
    contentTheme: "AI Agent在中小企业的落地路线",
    pageCount: 20,
    totalWordBudget: 4000,
    audience: ["企业管理者"],
    purpose: "为中小企业管理者提供AI Agent落地的系统性指导路线图",
    tone: "专业、务实、可操作",
    missingFields: [],
    mustInclude: ["场景", "成本", "风险"],
    mustAvoid: []
  });
  const providerVariantRequest = parsePptV3MessageRequest({
    content: "制作一个20页HTML PPT，主题为AI Agent在中小企业的落地路线，约4000字。",
    metadata: {
      templateId: "01-tech-web3",
      includeImages: false,
      includeVideo: false,
      includeChart: false,
      includeAudio: false
    },
    projectSelectedTemplateId: "01-tech-web3",
    llmParse: providerVariantIntent
  });
  if (!providerVariantRequest.ok || providerVariantRequest.request.pageCount !== 20 || providerVariantRequest.request.wordBudget !== 4000) {
    throw new Error(`intent parser should normalize provider variant JSON, got ${JSON.stringify(providerVariantRequest)}.`);
  }

  const needsClarification = parsePptV3MessageRequest({
    content: "帮我做一份 GDPR 合规 PPT",
    metadata: {
      templateId: "04-edu-adaptive",
      includeImages: false,
      includeVideo: false,
      includeChart: false,
      includeAudio: false
    },
    projectSelectedTemplateId: "04-edu-adaptive",
    llmParse: {
      schemaVersion: "html-ppt-v3.intent.v1",
      action: "generate_deck",
      status: "needs_clarification",
      deck: {
        contentTheme: "GDPR 合规",
        title: "GDPR 合规",
        pageCount: null,
        wordBudget: null,
        audience: null,
        purpose: null,
        tone: null,
        mustInclude: [],
        mustAvoid: []
      },
      quality: {
        confidence: 0.7,
        missingFields: ["pageCount", "wordBudget"],
        ambiguities: []
      },
      extensions: {}
    }
  });
  if (needsClarification.ok || !needsClarification.missingFields.includes("pageCount") || !needsClarification.missingFields.includes("wordBudget")) {
    throw new Error("intent parser should ask for clarification when model marks required deck fields missing.");
  }

  const completePromptWithoutLlm = await service.postMessage(created.id, 1, {
    content: "主题：AI Agent 落地路线图。请做 6 页，1200 字。",
    metadata: {
      templateId: "01-tech-web3",
      includeImages: true,
      includeVideo: false,
      includeChart: true,
      includeAudio: false
    }
  });
  if (completePromptWithoutLlm.assistantMessage.kind !== "error" || jobs.createdRequests.length !== 0) {
    throw new Error("postMessage should not create a job from regex fallback when LLM intent parse is unavailable.");
  }
  if (!String(completePromptWithoutLlm.assistantMessage.content).includes("意图解析失败")) {
    throw new Error("postMessage should tell the user intent parsing failed when LLM is unavailable.");
  }

  const onlineDb = new FakeDatabaseService();
  const onlineJobs = new FakeJobService();
  const onlineLlmConfig = new OnlineLlmConfigService();
  const onlineService = new PptV3ProjectService(
    onlineDb as never,
    onlineJobs as never,
    onlineLlmConfig as never,
    { logPayload: async () => undefined } as never
  );
  await onlineService.onModuleInit();
  const onlineProject = await onlineService.createProject({
    ownerUserId: 1,
    title: "V3 Online Intent",
    selectedTemplateId: "04-edu-adaptive"
  });
  const originalFetch = globalThis.fetch;
  const intentRequestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    intentRequestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(gdprIntent) } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const jobResult = await onlineService.postMessage(onlineProject.id, 1, {
    content: "制作一个html ppt，主题为GDPR 数据合规的实操要点清单，页数14，字数2000，文本里提到不要图片但按钮打开图片。",
    metadata: {
      templateId: "04-edu-adaptive",
      includeImages: true,
      includeVideo: false,
      includeChart: false,
      includeAudio: false,
      includeSpeakerNotes: true
    }
  });
  globalThis.fetch = originalFetch;
  if (jobResult.assistantMessage.kind !== "job" || jobResult.job?.id !== "job-1") {
    throw new Error("postMessage should create a job assistant message when LLM intent is complete.");
  }
  if (
    onlineJobs.createdRequests[0]?.theme !== "GDPR 数据合规的实操要点清单" ||
    onlineJobs.createdRequests[0]?.pageCount !== 14 ||
    onlineJobs.createdRequests[0]?.wordBudget !== 2000
  ) {
    throw new Error(`postMessage should build request from LLM intent, got ${JSON.stringify(onlineJobs.createdRequests[0])}.`);
  }
  if (
    onlineJobs.createdRequests[0]?.includeImages !== true ||
    onlineJobs.createdRequests[0]?.includeAudio !== false ||
    onlineJobs.createdRequests[0]?.includeSpeakerNotes !== true
  ) {
    throw new Error("postMessage should keep media and speaker notes choices controlled by UI metadata.");
  }
  if (jobResult.assistantMessage.metadata.parseSource !== "llm") {
    throw new Error(`postMessage should expose parseSource=llm, got ${String(jobResult.assistantMessage.metadata.parseSource)}.`);
  }
  if (onlineJobs.createdOwnerUserIds[0] !== 1) {
    throw new Error("postMessage should create jobs under the current owner user id.");
  }
  if (onlineLlmConfig.jsonConfigCalls !== 1 || onlineLlmConfig.activeConfigCalls !== 0) {
    throw new Error(`postMessage intent parsing should use Default JSON Model only; json=${onlineLlmConfig.jsonConfigCalls}, active=${onlineLlmConfig.activeConfigCalls}.`);
  }
  const intentRequestText = JSON.stringify(intentRequestBodies[0] ?? {});
  if (
    !intentRequestText.includes("STRICT OUTPUT SCHEMA") ||
    !intentRequestText.includes("schemaVersion") ||
    !intentRequestText.includes("html-ppt-v3.intent.v1") ||
    !intentRequestText.includes("Never output ready, ok, success")
  ) {
    throw new Error("v3-intent-parse prompt should strongly specify the required IntentJSON schema.");
  }

  const messages = await service.listMessages(created.id, 1);
  if (messages.length !== 4 || messages[0]?.role !== "user" || messages[3]?.kind !== "error") {
    throw new Error("listMessages should return stored user and assistant error messages in chronological order.");
  }

  if (!db.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS ppt_v3_projects"))) {
    throw new Error("Project service should create the V3 projects table.");
  }
  if (!db.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS ppt_v3_messages"))) {
    throw new Error("Project service should create the V3 messages table.");
  }

  console.log("HTML-PPT v3 project/message verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
