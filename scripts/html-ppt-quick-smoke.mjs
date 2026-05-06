import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_PROMPTS = [
  {
    name: "Quick Smoke Simple",
    templateId: "knowledge-arch-blueprint",
    expectedSlides: 6,
    content: "制作一个 6 页 HTML-PPT，主题为城市低空经济入门，900 字左右，要求横版 16:9，风格清晰稳重。"
  },
  {
    name: "Quick Smoke Dense",
    templateId: "course-module",
    expectedSlides: 10,
    content: "制作一个 10 页 HTML-PPT，主题为边缘 AI 在工业质检中的应用和未来，1500 字以上，包含背景、架构、案例、挑战和趋势。"
  },
  {
    name: "Quick Smoke Regression",
    templateId: "xhs-white-editorial",
    expectedSlides: 8,
    content: "制作一个 8 页 HTML-PPT，主题为深海鱼油的科学补充指南，1200 字左右，要求色彩温和、卡片统一、不要出现运行说明文字。"
  }
];

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has("--dry-run") || process.env.HTML_PPT_SMOKE_DRY_RUN === "1";
const compareV2 = args.has("--compare-v2") || process.env.HTML_PPT_SMOKE_COMPARE_V2 === "1";
const promptsFile = getArgValue(rawArgs, "--prompts-file") || process.env.HTML_PPT_SMOKE_PROMPTS_FILE || "";
const requestedPipeline = normalizePipeline(
  getArgValue(rawArgs, "--pipeline") || process.env.HTML_PPT_SMOKE_PIPELINE || "v2"
);
const apiBaseUrl = trimTrailingSlash(
  process.env.HTML_PPT_SMOKE_API_BASE_URL ||
  process.env.API_BASE_URL ||
  "http://localhost:4100/api"
);
const username = process.env.HTML_PPT_SMOKE_USERNAME || process.env.DEFAULT_ADMIN_USERNAME || "admin";
const password = process.env.HTML_PPT_SMOKE_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD || "Admin@123456";
const pollMs = numberEnv("HTML_PPT_SMOKE_POLL_MS", 15_000);
const timeoutMs = numberEnv("HTML_PPT_SMOKE_TIMEOUT_MS", 45 * 60_000);
const outputDir = resolve(process.env.HTML_PPT_SMOKE_OUTPUT_DIR || ".local-runtime/logs/smoke");
const promptCorpus = await loadPromptCorpus(promptsFile);
const prompts = promptCorpus.slice(0, numberEnv("HTML_PPT_SMOKE_LIMIT", promptCorpus.length));

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    apiBaseUrl,
    mode: compareV2 ? "v1-v2-comparison" : "single-pipeline",
    pipeline: compareV2 ? null : requestedPipeline,
    promptsFile: promptsFile || null,
    prompts
  }, null, 2));
  process.exit(0);
}

const startedAt = new Date();
const records = {
  startedAt: startedAt.toISOString(),
  apiBaseUrl,
  mode: compareV2 ? "v1-v2-comparison" : "single-pipeline",
  pipeline: compareV2 ? null : requestedPipeline,
  promptsFile: promptsFile || null,
  prompts: prompts.map((item) => ({ name: item.name, templateId: item.templateId, content: item.content })),
  results: []
};

try {
  const token = await login();
  await assertLlmConfig(token);

  for (const prompt of prompts) {
    const result = compareV2
      ? await runSmokeComparisonCase(token, prompt)
      : await runSmokeCase(
          token,
          prompt,
          requestedPipeline,
          requestedPipeline === "v2" ? "html-ppt-v2" : prompt.templateId
        );
    records.results.push(result);
    console.log(`[html-ppt-smoke] ${result.status}: ${prompt.name}`);
  }
} finally {
  records.finishedAt = new Date().toISOString();
  records.durationMs = Date.now() - startedAt.getTime();
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, `html-ppt-quick-smoke-${stamp(startedAt)}.json`);
  await writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
  console.log(`[html-ppt-smoke] records: ${filePath}`);
}

const failed = records.results.filter((item) => item.status !== "completed");
if (failed.length > 0) {
  console.error(`[html-ppt-smoke] failed ${failed.length}/${records.results.length}`);
  process.exit(1);
}

async function runSmokeComparisonCase(token, prompt) {
  const v1 = await runSmokeCase(token, prompt, "v1", prompt.templateId);
  const v2 = await runSmokeCase(token, prompt, "v2", "html-ppt-v2");
  const comparison = compareSmokeResults(prompt, v1, v2);
  return {
    status: comparison.v2GatePassed ? "completed" : "failed",
    name: prompt.name,
    expectedSlides: prompt.expectedSlides ?? null,
    prompt: prompt.content,
    v1,
    v2,
    comparison
  };
}

async function runSmokeCase(token, prompt, pipeline, templateId) {
  const project = await api(token, "/ppt/projects", {
    method: "POST",
    body: {
      name: `${prompt.name} ${pipeline.toUpperCase()} ${stamp(new Date())}`,
      templateId
    }
  });
  const projectId = project.id;

  await api(token, `/ppt/projects/${projectId}/messages`, {
    method: "POST",
    body: { content: prompt.content }
  });

  const deadline = Date.now() + timeoutMs;
  let lastAssistant = null;
  while (Date.now() < deadline) {
    const messages = await api(token, `/ppt/projects/${projectId}/messages`);
    lastAssistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;

    if (lastAssistant?.deckRender?.previewUrl) {
      return await summarizeResult(token, "completed", prompt, projectId, pipeline, templateId, lastAssistant);
    }

    const lastStep = lastAssistant?.orchestration?.steps?.at?.(-1);
    if (lastStep?.status === "failed") {
      return await summarizeResult(token, "failed", prompt, projectId, pipeline, templateId, lastAssistant, lastStep.detail || lastAssistant.content);
    }

    await sleep(pollMs);
  }

  return await summarizeResult(token, "timeout", prompt, projectId, pipeline, templateId, lastAssistant, `Timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

async function summarizeResult(token, status, prompt, projectId, pipeline, templateId, assistant, errorMessage = null) {
  const previewAnalysis = assistant?.deckRender?.previewUrl
    ? await analyzePreview(token, assistant.deckRender.previewUrl).catch((error) => ({ error: error.message }))
    : null;
  const manifestAnalysis = assistant?.deckRender?.manifestUrl
    ? await analyzeManifest(token, assistant.deckRender.manifestUrl).catch((error) => ({ error: error.message }))
    : null;
  const verificationAnalysis = assistant?.deckRender?.verificationReportUrl
    ? await analyzeVerificationReport(token, assistant.deckRender.verificationReportUrl).catch((error) => ({ error: error.message }))
    : null;
  const deckSpecSlideCount = assistant?.deckSpec?.slides?.length ?? null;
  const observedSlideCount =
    previewAnalysis?.sectionCount ??
    manifestAnalysis?.slideCount ??
    verificationAnalysis?.slideCount ??
    deckSpecSlideCount;

  return {
    status,
    name: prompt.name,
    pipeline,
    projectId,
    templateId,
    expectedSlides: prompt.expectedSlides ?? null,
    assistantMessageId: assistant?.id ?? null,
    slideCount: observedSlideCount,
    deckSpecSlideCount,
    slideCountExact: typeof prompt.expectedSlides === "number"
      ? observedSlideCount === prompt.expectedSlides
      : null,
    previewUrl: assistant?.deckRender?.previewUrl ?? null,
    downloadUrl: assistant?.deckRender?.downloadUrl ?? null,
    manifestUrl: assistant?.deckRender?.manifestUrl ?? null,
    verificationReportUrl: assistant?.deckRender?.verificationReportUrl ?? null,
    verificationStatus: assistant?.deckRender?.verificationStatus ?? verificationAnalysis?.status ?? null,
    verificationMode: assistant?.deckRender?.verificationMode ?? verificationAnalysis?.mode ?? null,
    modelCalls: assistant?.orchestration?.totalModelCalls ?? null,
    lastStep: assistant?.orchestration?.steps?.at?.(-1) ?? null,
    stageObservability: Array.isArray(assistant?.orchestration?.steps)
      ? assistant.orchestration.steps.map((step) => ({
        id: step.id,
        name: step.name,
        status: step.status,
        durationMs: step.durationMs ?? durationMsFromRange(step.startedAt, step.endedAt),
        modelCalls: step.modelCalls ?? null,
        retryCount: step.retryCount ?? null,
        failureReason: step.failureReason ?? (step.status === "failed" || step.status === "timeout" ? step.detail : null)
      }))
      : [],
    previewAnalysis,
    manifestAnalysis,
    verificationAnalysis,
    errorMessage
  };
}

function compareSmokeResults(prompt, v1, v2) {
  const expectedSlides = prompt.expectedSlides ?? null;
  const v2ForbiddenTextHits = v2.previewAnalysis?.forbiddenTextHits?.length ?? null;
  const v2HardIssueCount = v2.verificationAnalysis?.hardIssueCount ?? null;
  const v2VerificationFailed =
    v2.verificationStatus === "failed" ||
    v2.verificationAnalysis?.status === "failed" ||
    (typeof v2HardIssueCount === "number" && v2HardIssueCount > 0);
  const v2GateIssues = [
    v2.status === "completed" ? null : `v2 status=${v2.status}`,
    v2.slideCountExact === false ? `v2 slide count ${v2.slideCount} != expected ${expectedSlides}` : null,
    typeof v2ForbiddenTextHits === "number" && v2ForbiddenTextHits > 0 ? `v2 donor/text leakage hits=${v2ForbiddenTextHits}` : null,
    v2.manifestAnalysis?.contrastPassed === false ? "v2 contrast failed" : null,
    v2VerificationFailed ? `v2 verification failed or hard issues=${v2HardIssueCount ?? "unknown"}` : null
  ].filter(Boolean);
  return {
    expectedSlides,
    v1SlideCountExact: v1.slideCountExact,
    v2SlideCountExact: v2.slideCountExact,
    v2WinsSlideCount: Boolean(v2.slideCountExact) && !Boolean(v1.slideCountExact),
    v1ForbiddenTextHits: v1.previewAnalysis?.forbiddenTextHits?.length ?? null,
    v2ForbiddenTextHits,
    v2WinsDonorLeakage: (v2.previewAnalysis?.forbiddenTextHits?.length ?? 99) <= (v1.previewAnalysis?.forbiddenTextHits?.length ?? 99),
    v2ContrastPassed: v2.manifestAnalysis?.contrastPassed ?? null,
    v2HardIssueCount,
    v2WarningCount: v2.verificationAnalysis?.warningCount ?? null,
    v2ObstructionIssueCount: v2.verificationAnalysis?.obstructionIssueCount ?? null,
    v2ScreenshotCount: v2.verificationAnalysis?.screenshotCount ?? null,
    v2GatePassed: v2GateIssues.length === 0,
    v2GateIssues
  };
}

async function login() {
  const response = await rawFetch("/auth/login", {
    method: "POST",
    body: { username, password }
  });
  const token = response.accessToken;
  if (!token) {
    throw new Error("Login succeeded but no accessToken was returned.");
  }
  return token;
}

async function loadPromptCorpus(filePath) {
  if (!filePath) {
    return DEFAULT_PROMPTS;
  }
  const absolutePath = resolve(filePath);
  const raw = (await readFile(absolutePath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  const promptsValue = Array.isArray(parsed) ? parsed : parsed.prompts;
  if (!Array.isArray(promptsValue)) {
    throw new Error(`Prompt corpus must be a JSON array or { "prompts": [...] }: ${absolutePath}`);
  }
  return promptsValue.map((item, index) => normalizePrompt(item, index, absolutePath));
}

function normalizePrompt(item, index, source) {
  const name = String(item?.name || `Smoke Prompt ${index + 1}`).trim();
  const content = String(item?.content || "").trim();
  const templateId = String(item?.templateId || "knowledge-arch-blueprint").trim();
  const expectedSlides = Number(item?.expectedSlides);
  if (!content) {
    throw new Error(`Prompt ${index + 1} in ${source} is missing content.`);
  }
  return {
    name,
    templateId,
    expectedSlides: Number.isFinite(expectedSlides) && expectedSlides > 0 ? Math.floor(expectedSlides) : null,
    content
  };
}

async function assertLlmConfig(token) {
  const configs = await api(token, "/admin/llm-config");
  const active = Array.isArray(configs) ? configs.find((item) => item.enabled) : null;
  if (!active) {
    throw new Error("No enabled LLM config found. Configure /admin/llm before running smoke tests.");
  }
}

async function api(token, path, options = {}) {
  return rawFetch(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${token}`
    }
  });
}

async function fetchApiText(token, urlOrPath) {
  const path = toBackendApiPath(urlOrPath);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${text.slice(0, 300) || response.statusText}`);
  }
  return text;
}

async function analyzePreview(token, previewUrl) {
  const html = await fetchApiText(token, previewUrl);
  const forbiddenPatterns = [
    /(?:^|>)\s*fin\s*(?:<|$)/i,
    /cta\s*[·.]\s*final/i,
    /halo\s*v\d+/i,
    /#ai-[a-z0-9-]+/i,
    /lorem|todo|tbd|xxx/i,
    /方向键|切换|Ctrl\+S|按\s*T|编辑模式|edit mode/i
  ];
  const forbiddenTextHits = forbiddenPatterns
    .map((pattern) => html.match(pattern)?.[0])
    .filter(Boolean);
  return {
    bytes: Buffer.byteLength(html, "utf8"),
    sectionCount: countMatches(html, /<section\b[^>]*class=["'][^"']*\bslide\b/gi),
    activeSlideCount: countMatches(html, /\bis-active\b/g),
    forbiddenTextHits
  };
}

async function analyzeManifest(token, manifestUrl) {
  const manifest = JSON.parse(await fetchApiText(token, manifestUrl));
  const deckIr = manifest.deckIr ?? manifest.deck ?? null;
  return {
    slideCount: manifest.slideCount ?? deckIr?.intent?.derivedSlideCount ?? null,
    themeId: manifest.themeId ?? deckIr?.design?.themeId ?? null,
    donorTemplateId: deckIr?.design?.donorTemplateId ?? null,
    deckClass: manifest.deckClass ?? deckIr?.design?.deckClass ?? null,
    contrastPassed: deckIr?.design?.contrastReport?.passed ?? null,
    minContrastRatio: deckIr?.design?.contrastReport?.minContrastRatio ?? null
  };
}

async function analyzeVerificationReport(token, reportUrl) {
  const report = JSON.parse(await fetchApiText(token, reportUrl));
  return {
    status: report.status ?? null,
    mode: report.mode ?? null,
    hardIssueCount: report.summary?.hardIssueCount ?? null,
    warningCount: report.summary?.warningCount ?? null,
    obstructionIssueCount: countObstructionIssues(report),
    slideCount: report.summary?.slideCount ?? null,
    screenshotCount: report.summary?.screenshotCount ?? null,
    hardIssues: Array.isArray(report.hardIssues) ? report.hardIssues.slice(0, 5) : [],
    warnings: Array.isArray(report.warnings) ? report.warnings.slice(0, 5) : []
  };
}

function countObstructionIssues(report) {
  const issueText = [
    ...(Array.isArray(report.hardIssues) ? report.hardIssues : []),
    ...(Array.isArray(report.warnings) ? report.warnings : [])
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");
  return countMatches(issueText, /overflow|overlap|obstruct|clip|clipped|viewport|遮挡|溢出|重叠|截断|超出/gi);
}

function toBackendApiPath(urlOrPath) {
  const value = String(urlOrPath || "");
  try {
    const url = new URL(value);
    return stripApiPrefix(url.pathname);
  } catch {
    return stripApiPrefix(value);
  }
}

function stripApiPrefix(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.startsWith("/api/") ? normalized.slice(4) : normalized;
}

async function rawFetch(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || payload?.error || response.statusText || "Request failed";
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${message}`);
  }
  return payload;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizePipeline(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "v2" || normalized === "html-ppt-v2" ? "v2" : "v1";
}

function getArgValue(values, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === name) {
      return values[index + 1] && !values[index + 1].startsWith("--") ? values[index + 1] : "";
    }
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return "";
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function countMatches(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function durationMsFromRange(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
