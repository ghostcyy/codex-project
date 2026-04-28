import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_PROMPTS = [
  {
    name: "Quick Smoke Simple",
    templateId: "knowledge-arch-blueprint",
    content: "制作一个 6 页 HTML-PPT，主题为城市低空经济入门，900 字左右，要求横版 16:9，风格清晰稳重。"
  },
  {
    name: "Quick Smoke Dense",
    templateId: "course-module",
    content: "制作一个 10 页 HTML-PPT，主题为边缘 AI 在工业质检中的应用和未来，1500 字以上，包含背景、架构、案例、挑战和趋势。"
  },
  {
    name: "Quick Smoke Regression",
    templateId: "xhs-white-editorial",
    content: "制作一个 8 页 HTML-PPT，主题为深海鱼油的科学补充指南，1200 字左右，要求色彩温和、卡片统一、不要出现运行说明文字。"
  }
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || process.env.HTML_PPT_SMOKE_DRY_RUN === "1";
const apiBaseUrl = trimTrailingSlash(
  process.env.HTML_PPT_SMOKE_API_BASE_URL ||
  process.env.API_BASE_URL ||
  "http://localhost:4000/api"
);
const username = process.env.HTML_PPT_SMOKE_USERNAME || process.env.DEFAULT_ADMIN_USERNAME || "admin";
const password = process.env.HTML_PPT_SMOKE_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD || "Admin@123456";
const pollMs = numberEnv("HTML_PPT_SMOKE_POLL_MS", 15_000);
const timeoutMs = numberEnv("HTML_PPT_SMOKE_TIMEOUT_MS", 45 * 60_000);
const outputDir = resolve(process.env.HTML_PPT_SMOKE_OUTPUT_DIR || ".local-runtime/logs/smoke");
const prompts = DEFAULT_PROMPTS.slice(0, numberEnv("HTML_PPT_SMOKE_LIMIT", DEFAULT_PROMPTS.length));

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, apiBaseUrl, prompts }, null, 2));
  process.exit(0);
}

const startedAt = new Date();
const records = {
  startedAt: startedAt.toISOString(),
  apiBaseUrl,
  prompts: prompts.map((item) => ({ name: item.name, templateId: item.templateId, content: item.content })),
  results: []
};

try {
  const token = await login();
  await assertLlmConfig(token);

  for (const prompt of prompts) {
    const result = await runSmokeCase(token, prompt);
    records.results.push(result);
    console.log(`[html-ppt-smoke] ${result.status}: ${prompt.name} (${result.projectId ?? "no-project"})`);
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

async function runSmokeCase(token, prompt) {
  const project = await api(token, "/ppt/projects", {
    method: "POST",
    body: {
      name: `${prompt.name} ${stamp(new Date())}`,
      templateId: prompt.templateId
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
      return summarizeResult("completed", prompt, projectId, lastAssistant);
    }

    const lastStep = lastAssistant?.orchestration?.steps?.at?.(-1);
    if (lastStep?.status === "failed") {
      return summarizeResult("failed", prompt, projectId, lastAssistant, lastStep.detail || lastAssistant.content);
    }

    await sleep(pollMs);
  }

  return summarizeResult("timeout", prompt, projectId, lastAssistant, `Timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

function summarizeResult(status, prompt, projectId, assistant, errorMessage = null) {
  return {
    status,
    name: prompt.name,
    projectId,
    templateId: prompt.templateId,
    assistantMessageId: assistant?.id ?? null,
    slideCount: assistant?.deckSpec?.slides?.length ?? null,
    previewUrl: assistant?.deckRender?.previewUrl ?? null,
    downloadUrl: assistant?.deckRender?.downloadUrl ?? null,
    modelCalls: assistant?.orchestration?.totalModelCalls ?? null,
    lastStep: assistant?.orchestration?.steps?.at?.(-1) ?? null,
    errorMessage
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
