"use client";

import type { CSSProperties, FormEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { startTransition, useEffect, useRef, useState } from "react";

type TemplateOption = {
  id: string;
  label?: string;
  name?: string;
  description?: string;
  desc?: string;
  capabilities?: unknown;
  tags?: string[];
  aspectRatio?: string | null;
  rendererProfile?: string | null;
  deckClass?: string;
  previewSlides?: string[];
  previewCss?: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  templateId: string | null;
  status: "draft" | "idle" | "running" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
  localOnly?: boolean;
};

type StageProgress = {
  id: string;
  stage: string;
  label: string;
  detail: string;
  status: "pending" | "running" | "done" | "failed" | "info";
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  isWarning?: boolean;
};

type WorkbenchMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  templateId?: string;
  jobId?: string;
  status?: "queued" | "running" | "done" | "failed" | "info";
  previewUrl?: string;
  downloadUrl?: string;
  stages?: StageProgress[];
  warnings?: string[];
  localOnly?: boolean;
};

type V3JobSummary = {
  id: string;
  status: ProjectSummary["status"] | "planning" | "writing" | "imaging" | "injecting" | "packaging" | "pending";
  templateId?: string;
  previewUrl?: string;
  downloadUrl?: string;
  error?: string;
  stageHistory: StageProgress[];
  createdAt?: string;
  completedAt?: string;
};

type ProjectApiState = "checking" | "ready" | "fallback";

type GenerateRequest = {
  theme: string;
  pageCount: number;
  wordBudget: number;
  templateId: string;
  includeImages: boolean;
  includeVideo: boolean;
  includeChart: boolean;
  includeAudio: boolean;
};

type MediaOptions = Pick<GenerateRequest, "includeImages" | "includeVideo" | "includeChart" | "includeAudio">;

const DEFAULT_PROMPT = "制作一个8页HTML PPT，主题为AI Agent在中小企业的落地路线，约1800字，面向企业管理者，包含场景、成本、风险与90天实施计划。";
const STALE_TEMPLATE_ERROR_CODE = "HTML_PPT_V3_STALE_TEMPLATE";
const STALE_TEMPLATE_ERROR_MESSAGE = "该历史结果使用旧模板结构，无法继续预览，请重新生成。";
const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  includeImages: false,
  includeVideo: false,
  includeChart: false,
  includeAudio: false
};
const MEDIA_OPTION_DEFS: Array<{ key: keyof MediaOptions; label: string }> = [
  { key: "includeImages", label: "图片页" },
  { key: "includeChart", label: "图表页" },
  { key: "includeVideo", label: "视频页" },
  { key: "includeAudio", label: "音频页" }
];
const COLUMN_WIDTH_STORAGE_KEY = "html-ppt-v3-column-widths-v4";
const DEFAULT_COLUMN_WIDTHS = { projects: 260, templates: 532 };
const MIN_PROJECTS_WIDTH = 220;
const MAX_PROJECTS_WIDTH = 360;
const MIN_TEMPLATES_WIDTH = 280;
const MAX_TEMPLATES_WIDTH = 780;
const MIN_CHAT_WIDTH = 460;
const WORKBENCH_RESIZER_SPACE = 24;
const PREVIEW_DECK_WIDTH = 1280;
const PROGRESS_REFRESH_MS = 10_000;

const V3_STAGES = [
  { stage: "planning", label: "规划大纲", detail: "识别主题、页数、素材需求和叙事结构" },
  { stage: "writing", label: "撰写内容", detail: "生成每页内容、讲述节奏和页面文案" },
  { stage: "imaging", label: "生成图片", detail: "为已选择的图片页调用 MiniMax 生成配图" },
  { stage: "injecting", label: "注入页面", detail: "将内容写入选定模板并处理媒体占位" },
  { stage: "packaging", label: "打包输出", detail: "发布预览并生成可下载 zip" }
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function adaptiveDefaultColumnWidths(viewportWidth = 1440) {
  const usableWidth = Math.max(960, viewportWidth - 24);
  return {
    projects: clamp(Math.round(usableWidth * 0.22), MIN_PROJECTS_WIDTH, MAX_PROJECTS_WIDTH),
    templates: clamp(Math.max(DEFAULT_COLUMN_WIDTHS.templates, Math.round(usableWidth * 0.36)), MIN_TEMPLATES_WIDTH, MAX_TEMPLATES_WIDTH)
  };
}

function clampColumnWidths(widths: typeof DEFAULT_COLUMN_WIDTHS, shellWidth: number) {
  const templatesMax = Math.max(MIN_TEMPLATES_WIDTH, Math.min(MAX_TEMPLATES_WIDTH, shellWidth - MIN_PROJECTS_WIDTH - MIN_CHAT_WIDTH - WORKBENCH_RESIZER_SPACE));
  const templates = clamp(widths.templates, MIN_TEMPLATES_WIDTH, templatesMax);
  const projectsMax = Math.max(MIN_PROJECTS_WIDTH, Math.min(MAX_PROJECTS_WIDTH, shellWidth - templates - MIN_CHAT_WIDTH - WORKBENCH_RESIZER_SPACE));
  const projects = clamp(widths.projects, MIN_PROJECTS_WIDTH, projectsMax);
  return { projects, templates };
}

function readColumnWidths() {
  if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS;
  const adaptiveDefaults = adaptiveDefaultColumnWidths(window.innerWidth);
  const estimatedShellWidth = Math.max(860, window.innerWidth - 24);
  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTH_STORAGE_KEY);
    if (!raw) return clampColumnWidths(adaptiveDefaults, estimatedShellWidth);
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_COLUMN_WIDTHS>;
    return clampColumnWidths({
      projects: Number(parsed.projects) || adaptiveDefaults.projects,
      templates: Number(parsed.templates) || adaptiveDefaults.templates
    }, estimatedShellWidth);
  } catch {
    return clampColumnWidths(adaptiveDefaults, estimatedShellWidth);
  }
}

export default function HtmlPptV3Page() {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [projectApiState, setProjectApiState] = useState<ProjectApiState>("checking");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messagesByProject, setMessagesByProject] = useState<Record<string, WorkbenchMessage[]>>({});
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mediaOptions, setMediaOptions] = useState<MediaOptions>(DEFAULT_MEDIA_OPTIONS);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [slideState, setSlideState] = useState({ currentIndex: 0, totalSlides: 0 });
  const [columnWidths, setColumnWidths] = useState(DEFAULT_COLUMN_WIDTHS);
  const [previewScale, setPreviewScale] = useState(1);
  const [progressNow, setProgressNow] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesByProjectRef = useRef<Record<string, WorkbenchMessage[]>>({});
  const columnWidthsHydratedRef = useRef(false);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentMessages = selectedProjectId ? messagesByProject[selectedProjectId] ?? [] : [];
  const selectedTemplate = templates.find((template) => template.id === templateId) ?? null;
  const activeProgressMessage = latestMessage(currentMessages, (message) => message.role === "assistant" && Boolean(message.stages?.length));
  const activePreviewMessage = latestMessage(currentMessages, (message) => message.role === "assistant" && Boolean(message.previewUrl));
  const activePreviewUrl = activePreviewMessage?.previewUrl ?? "";
  const activeDownloadUrl = activePreviewMessage?.downloadUrl ?? "";

  useEffect(() => {
    messagesByProjectRef.current = messagesByProject;
  }, [messagesByProject]);

  useEffect(() => {
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), PROGRESS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame) return;

    const updatePreviewScale = () => {
      const width = frame.getBoundingClientRect().width;
      const nextScale = width ? clamp(width / PREVIEW_DECK_WIDTH, 0.2, 1) : 1;
      setPreviewScale((current) => (Math.abs(current - nextScale) < 0.001 ? current : nextScale));
    };

    updatePreviewScale();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updatePreviewScale);
      return () => window.removeEventListener("resize", updatePreviewScale);
    }

    const observer = new ResizeObserver(updatePreviewScale);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!columnWidthsHydratedRef.current) return;
    try {
      window.localStorage.setItem(COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
    } catch {
      // Persisting the resize preference is best-effort only.
    }
  }, [columnWidths]);

  useEffect(() => {
    function handleResize() {
      const shellWidth = shellRef.current?.getBoundingClientRect().width ?? Math.max(860, window.innerWidth - 24);
      setColumnWidths((current) => clampColumnWidths(current, shellWidth));
    }

    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? Math.max(860, window.innerWidth - 24);
    columnWidthsHydratedRef.current = true;
    setColumnWidths(clampColumnWidths(readColumnWidths(), shellWidth));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadTemplates() {
      try {
        const response = await fetch("/api/html-ppt-v3/templates", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(readPayloadMessage(payload) || "模板列表读取失败。");
        }
        const nextTemplates = normalizeTemplates(payload);
        if (!cancelled) {
          setTemplates(nextTemplates);
          setTemplateId((current) => {
            if (current && nextTemplates.some((template) => template.id === current)) return current;
            return nextTemplates[0]?.id ?? "";
          });
          setTemplateError(nextTemplates.length ? "" : "模板接口未返回可用模板。");
        }
      } catch (err) {
        if (!cancelled) {
          setTemplateError(err instanceof Error ? err.message : "模板列表读取失败，请确认后端已启动。");
        }
      }
    }
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadProjects() {
      setProjectsLoading(true);
      try {
        const response = await fetch("/api/html-ppt-v3/projects", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (isEndpointUnavailableStatus(response.status)) {
            throw new EndpointUnavailableError(readPayloadMessage(payload) || "Project API is unavailable.");
          }
          throw new Error(readPayloadMessage(payload) || "Project 列表读取失败。");
        }

        const nextProjects = normalizeProjects(payload);
        if (cancelled) return;
        setProjectApiState("ready");
        setProjects(nextProjects);
        if (nextProjects[0]) {
          setSelectedProjectId(nextProjects[0].id);
          void loadMessages(nextProjects[0].id);
        } else {
          setSelectedProjectId("");
          setMessagesByProject({});
        }
      } catch (err) {
        if (cancelled) return;
        const draft = createLocalProject("本地 Project", templateId);
        setProjectApiState("fallback");
        setProjects([draft]);
        setSelectedProjectId(draft.id);
        setMessagesByProject({ [draft.id]: [] });
        setNotice(err instanceof Error ? `Project API 不可用，已切换本地 Project：${err.message}` : "Project API 不可用，已切换本地 Project。");
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    }
    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "html-ppt-v3:state") return;
      const currentIndex = typeof data.currentIndex === "number" ? data.currentIndex : 0;
      const totalSlides = typeof data.totalSlides === "number" ? data.totalSlides : 0;
      setSlideState({ currentIndex, totalSlides });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!activePreviewUrl) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      event.preventDefault();
      moveSlide(event.key === "ArrowRight" ? "next" : "prev");
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePreviewUrl]);

  useEffect(() => {
    setSlideState({ currentIndex: 0, totalSlides: 0 });
  }, [activePreviewUrl]);

  useEffect(() => {
    if (!activePreviewUrl) {
      setPreviewError("");
      return;
    }

    let cancelled = false;
    async function checkPreview() {
      try {
        const response = await fetch(activePreviewUrl, { cache: "no-store" });
        if (cancelled) return;
        if (response.ok) {
          setPreviewError("");
          return;
        }
        setPreviewError(await readPreviewResponseMessage(response));
      } catch (err) {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : "预览文件无法加载。");
        }
      }
    }

    void checkPreview();
    return () => {
      cancelled = true;
    };
  }, [activePreviewUrl]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  async function loadMessages(projectId: string) {
    if (isLocalProjectId(projectId)) return;

    setMessagesLoading(true);
    try {
      const response = await fetch(`/api/html-ppt-v3/projects/${encodeURIComponent(projectId)}/messages`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (isEndpointUnavailableStatus(response.status)) {
          throw new EndpointUnavailableError(readPayloadMessage(payload) || "Messages API is unavailable.");
        }
        throw new Error(readPayloadMessage(payload) || "消息列表读取失败。");
      }
      const nextMessages = mergeJobProgressIntoMessages(
        normalizeMessages(payload),
        await loadProjectJobs(projectId)
      );
      setMessagesByProject((current) => ({ ...current, [projectId]: nextMessages }));
      reconnectRunningJob(projectId, nextMessages);
    } catch (err) {
      if (err instanceof EndpointUnavailableError) {
        setProjectApiState("fallback");
        markProjectLocal(projectId);
        setNotice(`Project 消息接口不可用，当前 Project 已转为本地模式：${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : "消息列表读取失败。");
      }
    } finally {
      setMessagesLoading(false);
    }
  }

  async function loadProjectJobs(projectId: string): Promise<V3JobSummary[]> {
    const response = await fetch(`/api/html-ppt-v3/projects/${encodeURIComponent(projectId)}/jobs`, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (isEndpointUnavailableStatus(response.status)) {
        throw new EndpointUnavailableError(readPayloadMessage(payload) || "Jobs API is unavailable.");
      }
      throw new Error(readPayloadMessage(payload) || "Project job 列表读取失败。");
    }
    return normalizeJobs(payload);
  }

  function reconnectRunningJob(projectId: string, messages: WorkbenchMessage[]) {
    const runningMessage = latestMessage(
      messages,
      (message) => message.role === "assistant" && Boolean(message.jobId) && message.status === "running"
    );
    if (!runningMessage?.jobId) return;
    connectSse(runningMessage.jobId, projectId, runningMessage.id);
  }

  async function createNewProject() {
    setError("");
    setNotice("");
    eventSourceRef.current?.close();
    setIsSubmitting(false);

    if (projectApiState !== "fallback") {
      try {
        const project = await postProject({
          name: "新建 HTML-PPT v3 Project",
          templateId
        });
        setProjectApiState("ready");
        setProjects((current) => [project, ...current.filter((item) => !item.localOnly || current.length > 1)]);
        setSelectedProjectId(project.id);
        setMessagesByProject((current) => ({ ...current, [project.id]: [] }));
        setSlideState({ currentIndex: 0, totalSlides: 0 });
        return;
      } catch (err) {
        if (err instanceof EndpointUnavailableError) {
          setProjectApiState("fallback");
          setNotice(`Project API 不可用，新建本地 Project：${err.message}`);
        } else {
          setError(err instanceof Error ? err.message : "新建 Project 失败，已创建本地草稿。");
        }
      }
    }

    const project = createLocalProject("本地 Project", templateId);
    setProjects((current) => [project, ...current]);
    setSelectedProjectId(project.id);
    setMessagesByProject((current) => ({ ...current, [project.id]: [] }));
    setSlideState({ currentIndex: 0, totalSlides: 0 });
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setError("");
    setNotice("");
    setSlideState({ currentIndex: 0, totalSlides: 0 });
    const project = projects.find((item) => item.id === projectId);
    if (project?.templateId && templates.some((template) => template.id === project.templateId)) {
      setTemplateId(project.templateId);
    }
    if (!project?.localOnly && projectApiState !== "fallback" && !messagesByProject[projectId]) {
      void loadMessages(projectId);
    }
  }

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) return;
    if (!templateId) {
      setError("请先从右侧选择一个模板。");
      return;
    }

    setError("");
    setNotice("");
    setPrompt("");
    setIsSubmitting(true);

    const project = await ensureProjectForSubmit(content);
    const userMessage: WorkbenchMessage = {
      id: createClientId("user"),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      templateId
    };
    const assistantMessage: WorkbenchMessage = {
      id: createClientId("assistant"),
      role: "assistant",
      content: "已收到需求，正在创建 HTML-PPT v3 生成任务。",
      createdAt: new Date().toISOString(),
      templateId,
      status: "running",
      stages: initialStages(),
      localOnly: project.localOnly || projectApiState === "fallback"
    };

    appendMessages(project.id, [userMessage, assistantMessage]);
    updateProject(project.id, {
      name: project.localOnly && project.name.includes("草稿") ? promptSummary(content) : project.name,
      templateId,
      status: "running",
      updatedAt: new Date().toISOString()
    });

    if (project.localOnly || projectApiState === "fallback") {
      const request = buildGenerateRequest(content, templateId, mediaOptions);
      await startDirectGenerate(project.id, assistantMessage.id, request);
      return;
    }

    try {
      const response = await fetch(`/api/html-ppt-v3/projects/${encodeURIComponent(project.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          prompt: content,
          templateId,
          includeImages: mediaOptions.includeImages,
          includeVideo: mediaOptions.includeVideo,
          includeChart: mediaOptions.includeChart,
          includeAudio: mediaOptions.includeAudio,
          template: selectedTemplate
            ? {
                id: selectedTemplate.id,
                label: templateLabel(selectedTemplate),
                description: templateDescription(selectedTemplate)
              }
            : { id: templateId },
          metadata: {
            templateId,
            media: mediaOptions,
            includeImages: mediaOptions.includeImages,
            includeVideo: mediaOptions.includeVideo,
            includeChart: mediaOptions.includeChart,
            includeAudio: mediaOptions.includeAudio
          }
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (isEndpointUnavailableStatus(response.status)) {
          throw new EndpointUnavailableError(readPayloadMessage(payload) || "Messages API is unavailable.");
        }
        throw new Error(readPayloadMessage(payload) || "消息提交失败。");
      }

      const returnedMessages = normalizeMessages(payload);
      let targetAssistantId = assistantMessage.id;
      if (returnedMessages.length) {
        const returnedAssistant = latestMessage(returnedMessages, (message) => message.role === "assistant");
        targetAssistantId = returnedAssistant?.id ?? targetAssistantId;
        setMessagesByProject((current) => ({ ...current, [project.id]: returnedMessages }));
      }

      const jobId = extractJobId(payload);
      if (jobId) {
        upsertAssistant(project.id, targetAssistantId, {
          content: "后台任务已创建，正在监听 SSE 进度。",
          status: "running",
          jobId,
          stages: initialStages()
        });
        connectSse(jobId, project.id, targetAssistantId);
        return;
      }

      const artifact = extractArtifact(payload);
      if (artifact.previewUrl || artifact.downloadUrl) {
        upsertAssistant(project.id, targetAssistantId, {
          content: "生成完成，预览和下载已就绪。",
          status: "done",
          previewUrl: artifact.previewUrl,
          downloadUrl: artifact.downloadUrl,
          stages: markAllStagesDone()
        });
        updateProject(project.id, { status: "done", updatedAt: new Date().toISOString() });
        setIsSubmitting(false);
        return;
      }

      if (returnedMessages.length) {
        updateProject(project.id, { status: "idle", updatedAt: new Date().toISOString() });
        setIsSubmitting(false);
        return;
      }

      upsertAssistant(project.id, targetAssistantId, {
        content: "消息已提交到 Project API。后端未返回 jobId；请稍后重新选择该 Project 读取最新消息。",
        status: "info",
        stages: [{ id: "submitted", stage: "submitted", label: "已提交", detail: "等待后端 Project/Message API 返回任务状态", status: "info" }]
      });
      updateProject(project.id, { status: "idle", updatedAt: new Date().toISOString() });
      setIsSubmitting(false);
    } catch (err) {
      if (err instanceof EndpointUnavailableError) {
        setProjectApiState("fallback");
        markProjectLocal(project.id);
        setNotice(`Project 消息接口不可用，改用 direct /generate：${err.message}`);
        const request = buildGenerateRequest(content, templateId, mediaOptions);
        await startDirectGenerate(project.id, assistantMessage.id, request);
        return;
      }

      const message = err instanceof Error ? err.message : "消息提交失败。";
      setError(message);
      upsertAssistant(project.id, assistantMessage.id, {
        content: message,
        status: "failed",
        stages: failPendingStages(initialStages(), message)
      });
      updateProject(project.id, { status: "failed", updatedAt: new Date().toISOString() });
      setIsSubmitting(false);
    }
  }

  async function ensureProjectForSubmit(content: string): Promise<ProjectSummary> {
    const currentProject = selectedProject;
    if (currentProject && (!currentProject.localOnly || projectApiState === "fallback")) {
      return currentProject;
    }

    if (projectApiState !== "fallback") {
      try {
        const project = await postProject({
          name: promptSummary(content),
          templateId
        });
        setProjectApiState("ready");
        const previousId = currentProject?.id;
        setProjects((current) => [project, ...current.filter((item) => item.id !== previousId)]);
        setSelectedProjectId(project.id);
        if (previousId) {
          setMessagesByProject((current) => {
            const previousMessages = current[previousId] ?? [];
            const next = { ...current };
            delete next[previousId];
            next[project.id] = previousMessages;
            return next;
          });
        } else {
          setMessagesByProject((current) => ({ ...current, [project.id]: [] }));
        }
        return project;
      } catch (err) {
        if (err instanceof EndpointUnavailableError) {
          setProjectApiState("fallback");
          setNotice(`Project API 不可用，使用本地 Project：${err.message}`);
        } else {
          setError(err instanceof Error ? err.message : "创建 Project 失败，使用本地 Project。");
        }
      }
    }

    if (currentProject) {
      markProjectLocal(currentProject.id);
      return { ...currentProject, localOnly: true };
    }

    const project = createLocalProject(promptSummary(content), templateId);
    setProjects((current) => [project, ...current]);
    setSelectedProjectId(project.id);
    setMessagesByProject((current) => ({ ...current, [project.id]: [] }));
    return project;
  }

  async function startDirectGenerate(projectId: string, assistantMessageId: string, request: GenerateRequest) {
    upsertAssistant(projectId, assistantMessageId, {
      content: "Project API 不可用，正在使用 direct /api/html-ppt-v3/generate 兼容路径。",
      status: "running",
      stages: initialStages(),
      localOnly: true
    });

    try {
      const response = await fetch("/api/html-ppt-v3/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.jobId !== "string") {
        throw new Error(readPayloadMessage(payload) || "direct /generate 任务创建失败。");
      }

      upsertAssistant(projectId, assistantMessageId, {
        content: "direct /generate 任务已创建，正在监听 SSE 进度。",
        status: "running",
        jobId: payload.jobId
      });
      connectSse(payload.jobId, projectId, assistantMessageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "HTML-PPT v3 任务创建失败。";
      setError(message);
      upsertAssistant(projectId, assistantMessageId, {
        content: message,
        status: "failed",
        stages: failPendingStages(initialStages(), message)
      });
      updateProject(projectId, { status: "failed", updatedAt: new Date().toISOString() });
      setIsSubmitting(false);
    }
  }

  function connectSse(nextJobId: string, projectId: string, assistantMessageId: string) {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/html-ppt-v3/sse/${encodeURIComponent(nextJobId)}`);
    eventSourceRef.current = source;

    source.addEventListener("job-created", () => {
      upsertAssistant(projectId, assistantMessageId, {
        jobId: nextJobId,
        content: `任务 ${nextJobId} 已创建，等待阶段事件。`,
        status: "running"
      });
    });

    source.addEventListener("stage-start", (event) => {
      const data = parseEventData(event);
      const stage = typeof data.stage === "string" ? data.stage : "running";
      const startedAt = stringOrUndefined(data.startedAt) || new Date().toISOString();
      const baseStages = normalizeStages(data.stageHistory) ?? activeStages(projectId, assistantMessageId);
      upsertAssistant(projectId, assistantMessageId, {
        status: "running",
        content: `${stageLabel(stage)}进行中。`,
        stages: updateStage(baseStages, stage, {
          detail: stringOrUndefined(data.detail) || "开始执行",
          status: "running",
          startedAt,
          elapsedMs: numberOrUndefined(data.elapsedMs)
        })
      });
      updateProject(projectId, { status: "running", updatedAt: new Date().toISOString() });
    });

    source.addEventListener("stage-done", (event) => {
      const data = parseEventData(event);
      const stage = typeof data.stage === "string" ? data.stage : "running";
      const detail = formatStageDetail(data.summary, "阶段完成");
      const completedAt = stringOrUndefined(data.completedAt) || new Date().toISOString();
      const baseStages = normalizeStages(data.stageHistory) ?? activeStages(projectId, assistantMessageId);
      upsertAssistant(projectId, assistantMessageId, {
        status: "running",
        content: `${stageLabel(stage)}完成。`,
        stages: updateStage(baseStages, stage, {
          detail,
          status: "done",
          startedAt: stringOrUndefined(data.startedAt),
          completedAt,
          elapsedMs: numberOrUndefined(data.elapsedMs),
          isWarning: hasFallbackSource(data.summary) || hasFallbackSource(detail)
        })
      });
    });

    source.addEventListener("progress", (event) => {
      const data = parseEventData(event);
      upsertAssistant(projectId, assistantMessageId, {
        status: "running",
        content: typeof data.message === "string" ? data.message : "后台处理中。",
        stages: upsertInfoStage(activeStages(projectId, assistantMessageId), typeof data.message === "string" ? data.message : "后台处理中")
      });
    });

    source.addEventListener("done", (event) => {
      const data = parseEventData(event);
      const warnings = normalizeWarnings(data.warnings);
      const previewUrl = normalizeArtifactUrl(data.previewUrl);
      const downloadUrl = normalizeArtifactUrl(data.downloadUrl);
      upsertAssistant(projectId, assistantMessageId, {
        content: warnings.length ? `生成完成，预览和下载已就绪；警告 ${warnings.length} 条。` : "生成完成，预览和下载已就绪。",
        status: "done",
        previewUrl,
        downloadUrl,
        warnings,
        stages: normalizeStages(data.stageHistory) ?? markAllStagesDone(activeStages(projectId, assistantMessageId))
      });
      updateProject(projectId, { status: "done", updatedAt: new Date().toISOString() });
      setIsSubmitting(false);
      closeSource(source);
    });

    source.addEventListener("error", (event) => {
      const data = parseEventData(event);
      const message = typeof data.message === "string" ? data.message : "HTML-PPT v3 生成失败或 SSE 连接中断。";
      const stage = typeof data.stage === "string" ? data.stage : "";
      const currentStages = activeStages(projectId, assistantMessageId);
      setError(message);
      upsertAssistant(projectId, assistantMessageId, {
        content: message,
        status: "failed",
        stages: stage
          ? updateStage(currentStages, stage, {
              detail: message,
              status: "failed",
              startedAt: stringOrUndefined(data.startedAt),
              completedAt: stringOrUndefined(data.completedAt) || new Date().toISOString(),
              elapsedMs: numberOrUndefined(data.elapsedMs)
            })
          : failPendingStages(currentStages, message)
      });
      updateProject(projectId, { status: "failed", updatedAt: new Date().toISOString() });
      setIsSubmitting(false);
      closeSource(source);
    });
  }

  function activeStages(projectId: string, assistantMessageId: string) {
    const message = (messagesByProjectRef.current[projectId] ?? []).find((item) => item.id === assistantMessageId);
    return message?.stages?.length ? message.stages : initialStages();
  }

  function appendMessages(projectId: string, messages: WorkbenchMessage[]) {
    startTransition(() => {
      setMessagesByProject((current) => ({
        ...current,
        [projectId]: [...(current[projectId] ?? []), ...messages]
      }));
    });
  }

  function upsertAssistant(projectId: string, assistantMessageId: string, patch: Partial<WorkbenchMessage>) {
    startTransition(() => {
      setMessagesByProject((current) => {
        const messages = current[projectId] ?? [];
        const index = messages.findIndex((message) => message.id === assistantMessageId);
        const fallback: WorkbenchMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          templateId,
          stages: initialStages()
        };
        const baseMessage: WorkbenchMessage = index >= 0 ? messages[index]! : fallback;
        const nextMessage = { ...baseMessage, ...patch } as WorkbenchMessage;
        const nextMessages = index >= 0
          ? messages.map((message, messageIndex) => messageIndex === index ? nextMessage : message)
          : [...messages, nextMessage];
        return { ...current, [projectId]: nextMessages };
      });
    });
  }

  function updateProject(projectId: string, patch: Partial<ProjectSummary>) {
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, ...patch } : project));
  }

  function markProjectLocal(projectId: string) {
    updateProject(projectId, {
      localOnly: true,
      updatedAt: new Date().toISOString()
    });
  }

  function closeSource(source: EventSource) {
    source.close();
    if (eventSourceRef.current === source) {
      eventSourceRef.current = null;
    }
  }

  function moveSlide(direction: "prev" | "next") {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "html-ppt-v3:navigate", direction }, "*");
  }

  function startColumnResize(column: "projects" | "templates", event: ReactPointerEvent<HTMLButtonElement>) {
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    const rect = shell.getBoundingClientRect();
    const initialWidths = { ...columnWidths };

    function maxProjectsWidth(templateWidth: number) {
      return Math.max(MIN_PROJECTS_WIDTH, Math.min(MAX_PROJECTS_WIDTH, rect.width - templateWidth - MIN_CHAT_WIDTH - WORKBENCH_RESIZER_SPACE));
    }

    function maxTemplatesWidth(projectsWidth: number) {
      return Math.max(MIN_TEMPLATES_WIDTH, Math.min(MAX_TEMPLATES_WIDTH, rect.width - projectsWidth - MIN_CHAT_WIDTH - WORKBENCH_RESIZER_SPACE));
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      if (column === "projects") {
        const nextProjects = clamp(moveEvent.clientX - rect.left, MIN_PROJECTS_WIDTH, maxProjectsWidth(initialWidths.templates));
        setColumnWidths((current) => ({ ...current, projects: nextProjects }));
        return;
      }
      const nextTemplates = clamp(rect.right - moveEvent.clientX, MIN_TEMPLATES_WIDTH, maxTemplatesWidth(initialWidths.projects));
      setColumnWidths((current) => ({ ...current, templates: nextTemplates }));
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.classList.remove("v3-is-resizing-columns");
    }

    document.body.classList.add("v3-is-resizing-columns");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  return (
    <main className="v3-workbench-page">
      <section
        ref={shellRef}
        className="v3-workbench-shell"
        style={{
          "--v3-projects-width": `${columnWidths.projects}px`,
          "--v3-templates-width": `${columnWidths.templates}px`
        } as CSSProperties}
      >
        <aside className="v3-projects-panel">
          <div className="v3-panel-heading">
            <span>Projects</span>
            <strong>HTML-PPT v3</strong>
          </div>
          <button type="button" className="v3-new-project" onClick={() => void createNewProject()}>
            + New Project
          </button>
          <div className={`v3-api-pill is-${projectApiState}`}>
            {projectApiState === "checking" ? "Project API checking" : projectApiState === "ready" ? "Project API ready" : "Local fallback mode"}
          </div>
          <div className="v3-project-list">
            {projectsLoading ? <div className="v3-empty-list">正在读取 Project...</div> : null}
            {!projectsLoading && projects.length === 0 ? <div className="v3-empty-list">暂无 Project。</div> : null}
            {projects.map((project) => {
              const active = project.id === selectedProjectId;
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`v3-project-item${active ? " is-active" : ""}`}
                  onClick={() => selectProject(project.id)}
                >
                  <span className={`v3-project-status is-${project.status}`}>{projectStatusLabel(project)}</span>
                  <strong>{project.name}</strong>
                  <small>{formatDate(project.updatedAt)}{project.templateId ? ` · ${project.templateId}` : ""}</small>
                </button>
              );
            })}
          </div>
        </aside>

        <button
          type="button"
          className="v3-column-resizer is-left"
          aria-label="拖动调整左侧 Project 栏宽度"
          onPointerDown={(event) => startColumnResize("projects", event)}
        />

        <section className="v3-chat-panel">
          <div className="v3-chat-header">
            <div>
              <p className="v3-eyebrow">HTML-PPT v3</p>
              <h1>HTML-PPT</h1>
              <span>项目、对话和模板保持三列并列。</span>
            </div>
            <div className="v3-current-template">
              <span>当前模板</span>
              <strong>{selectedTemplate ? templateLabel(selectedTemplate) : templateId || "未选择"}</strong>
            </div>
          </div>

          <div className="v3-conversation">
            {notice ? <div className="v3-notice">{notice}</div> : null}
            {error ? <div className="v3-error">{error}</div> : null}
            {messagesLoading ? <div className="v3-loading">正在读取消息...</div> : null}

            {currentMessages.length === 0 ? (
              <div className="v3-assistant-message">
                <span className="v3-avatar">AI</span>
                <div className="v3-message-card">
                  <strong>输入一个完整的 PPT 需求开始。</strong>
                  <p>提交时会携带右侧选中的 <b>templateId</b>。如果 Project API 尚未接入，本页会自动使用本地 Project 和 direct generate 兼容路径。</p>
                </div>
              </div>
            ) : null}

            {currentMessages.map((message) => (
              <MessageBubble key={message.id} message={message} templates={templates} />
            ))}

            {activeProgressMessage?.stages?.length ? (
              <div className="v3-stage-card">
                <div className="v3-stage-card-head">
                  <div>
                    <strong>阶段进度</strong>
                    <span>{activeProgressMessage.jobId ? `job ${activeProgressMessage.jobId}` : "等待 jobId"}</span>
                  </div>
                  <em className={`is-${activeProgressMessage.status ?? "info"}`}>{messageStatusLabel(activeProgressMessage.status)}</em>
                </div>
                <div className="v3-stage-list">
                  {activeProgressMessage.stages.map((stage) => (
                    <div key={stage.id} className={`v3-stage-row is-${stage.status}${stage.isWarning ? " is-warning" : ""}`}>
                      <span />
                      <div>
                        <strong>{stage.label}</strong>
                        <p>{stage.detail}</p>
                        {formatStageTiming(stage, progressNow) ? (
                          <small className="v3-stage-time">{formatStageTiming(stage, progressNow)}</small>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="v3-preview-card">
              <div className="v3-preview-toolbar">
                <div>
                  <span>Preview</span>
                  <strong>{previewError ? "预览不可用" : activePreviewUrl ? "已就绪" : "等待生成结果"}</strong>
                </div>
                <div>
                  <span>Slide</span>
                  <strong>{slideState.totalSlides > 0 ? `${slideState.currentIndex + 1} / ${slideState.totalSlides}` : "0 / 0"}</strong>
                </div>
                <div className="v3-preview-actions">
                  <button type="button" onClick={() => moveSlide("prev")} disabled={!activePreviewUrl || Boolean(previewError)}>上一页</button>
                  <button type="button" onClick={() => moveSlide("next")} disabled={!activePreviewUrl || Boolean(previewError)}>下一页</button>
                  <a className={!activeDownloadUrl ? "is-disabled" : ""} href={activeDownloadUrl || undefined}>下载 zip</a>
                </div>
              </div>
              <div ref={previewFrameRef} className="v3-preview-frame" style={{ "--v3-preview-scale": previewScale } as CSSProperties}>
                {previewError ? (
                  <div className="v3-preview-empty is-error">
                    <strong>预览不可用</strong>
                    <span>{previewError}</span>
                  </div>
                ) : activePreviewUrl ? (
                  <iframe ref={iframeRef} src={activePreviewUrl} title="HTML-PPT v3 preview" />
                ) : (
                  <div className="v3-preview-empty">
                    <strong>预览区</strong>
                    <span>SSE done 事件返回后会在这里加载生成的 deck。</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <form className="v3-composer" onSubmit={submitPrompt}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="例如：制作一个10页HTML PPT，主题为新能源车出海策略，约2200字，包含市场对比、风险、路线图和结尾行动清单。"
            />
            <div className="v3-composer-side">
              <span>功能待上线</span>
              <div className="v3-media-toggle-grid" aria-label="媒体页选择">
                {MEDIA_OPTION_DEFS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className="v3-media-toggle is-disabled"
                    aria-disabled="true"
                    aria-pressed="false"
                    title="该功能很快上线！"
                    onClick={(event) => event.preventDefault()}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button type="submit" disabled={isSubmitting || !prompt.trim() || !templateId}>
                {isSubmitting ? "生成中..." : "发送需求"}
              </button>
            </div>
          </form>
        </section>

        <button
          type="button"
          className="v3-column-resizer is-right"
          aria-label="拖动调整右侧模板栏宽度"
          onPointerDown={(event) => startColumnResize("templates", event)}
        />

        <aside className="v3-template-panel">
          <div className="v3-panel-heading">
            <span>Templates</span>
            <strong>选择模板</strong>
          </div>
          <p className="v3-template-note">当前仅支持人工选择模板</p>
          {templateError ? <div className="v3-template-error">{templateError}</div> : null}
          <div className="v3-template-list">
            {templates.map((template) => {
              const selected = template.id === templateId;
              return (
                <V3TemplateCard
                  key={template.id}
                  template={template}
                  selected={selected}
                  onSelect={() => setTemplateId(template.id)}
                />
              );
            })}
            {!templateError && templates.length === 0 ? <div className="v3-empty-list">正在读取模板...</div> : null}
          </div>
        </aside>
      </section>

      <style>{`
        .v3-workbench-page {
          min-height: calc(100vh - 76px);
          padding: 12px;
          background: var(--bg-deep);
          color: var(--ink);
        }
        .v3-workbench-shell {
          --v3-page-border: rgba(99, 102, 241, 0.12);
          --v3-page-border-strong: rgba(99, 102, 241, 0.2);
          --v3-page-muted: rgba(17, 12, 38, 0.62);
          --v3-page-soft: rgba(99, 102, 241, 0.06);
          --v3-page-accent: var(--accent);
          display: grid;
          width: 100%;
          grid-template-columns:
            var(--v3-projects-width, 260px)
            6px
            minmax(0, 1fr)
            6px
            var(--v3-templates-width, 340px);
          gap: 4px;
          height: calc(100dvh - 100px);
          min-height: 720px;
          max-width: none;
          margin: 0;
        }
        .v3-projects-panel,
        .v3-chat-panel,
        .v3-template-panel {
          min-height: 0;
          border: 1px solid var(--v3-page-border);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.94);
          box-shadow: var(--shadow-base);
        }
        .v3-projects-panel,
        .v3-template-panel {
          display: flex;
          flex-direction: column;
          padding: 14px;
        }
        .v3-chat-panel {
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto;
          overflow: hidden;
        }
        .v3-column-resizer {
          position: relative;
          z-index: 8;
          align-self: stretch;
          width: 6px;
          min-width: 6px;
          margin: 18px 0;
          padding: 0;
          border: 0;
          border-radius: 999px;
          background: transparent;
          cursor: col-resize;
          touch-action: none;
        }
        .v3-column-resizer::before {
          content: "";
          position: absolute;
          top: 50%;
          left: 50%;
          width: 2px;
          height: 44px;
          border-radius: 999px;
          background: rgba(99, 102, 241, 0.16);
          transform: translate(-50%, -50%);
          transition: height 0.16s ease, background 0.16s ease;
        }
        .v3-column-resizer:hover::before,
        .v3-column-resizer:focus-visible::before,
        .v3-is-resizing-columns .v3-column-resizer::before {
          height: 72px;
          background: rgba(99, 102, 241, 0.42);
        }
        .v3-column-resizer:focus-visible {
          outline: 2px solid rgba(99, 102, 241, 0.28);
          outline-offset: 2px;
        }
        .v3-is-resizing-columns,
        .v3-is-resizing-columns * {
          cursor: col-resize !important;
          user-select: none;
        }
        .v3-panel-heading {
          display: grid;
          gap: 4px;
          margin-bottom: 12px;
        }
        .v3-panel-heading span,
        .v3-eyebrow {
          margin: 0;
          color: var(--accent);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .v3-panel-heading strong {
          color: var(--ink);
          font-size: 18px;
          font-weight: 650;
          letter-spacing: -0.03em;
        }
        .v3-new-project,
        .v3-composer button,
        .v3-preview-actions a,
        .v3-preview-actions button {
          border: 0;
          border-radius: 10px;
          background: var(--accent);
          color: #fff;
          cursor: pointer;
          font-size: 12px;
          font-weight: 650;
          text-decoration: none;
          transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
        }
        .v3-new-project {
          padding: 10px 12px;
        }
        .v3-new-project:hover,
        .v3-composer button:hover,
        .v3-preview-actions a:hover {
          background: var(--accent-strong);
        }
        .v3-api-pill {
          margin: 10px 0 12px;
          border: 1px solid var(--v3-page-border);
          border-radius: 10px;
          padding: 8px 10px;
          color: var(--v3-page-muted);
          font-size: 11px;
          font-weight: 600;
          text-align: center;
        }
        .v3-api-pill.is-ready {
          border-color: rgba(16, 185, 129, 0.22);
          color: #047857;
        }
        .v3-api-pill.is-fallback {
          border-color: rgba(245, 158, 11, 0.26);
          color: #b45309;
        }
        .v3-project-list,
        .v3-template-list {
          display: grid;
          gap: 8px;
          min-height: 0;
          overflow: auto;
          padding-right: 2px;
        }
        .v3-template-list {
          grid-template-columns: repeat(auto-fill, 240px);
          grid-auto-rows: 135px;
          overflow-x: hidden;
          align-content: start;
          justify-content: start;
        }
        .v3-project-list::-webkit-scrollbar,
        .v3-template-list::-webkit-scrollbar,
        .v3-conversation::-webkit-scrollbar {
          width: 8px;
        }
        .v3-project-list::-webkit-scrollbar-thumb,
        .v3-template-list::-webkit-scrollbar-thumb,
        .v3-conversation::-webkit-scrollbar-thumb {
          border-radius: 999px;
          background: rgba(99, 102, 241, 0.16);
        }
        .v3-project-item,
        .v3-template-card {
          width: 100%;
          border: 1px solid var(--v3-page-border);
          border-radius: 14px;
          background: #fff;
          color: inherit;
          cursor: pointer;
          text-align: left;
          transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
        }
        .v3-project-item {
          display: grid;
          gap: 6px;
          padding: 11px;
        }
        .v3-project-item:hover,
        .v3-template-card:hover {
          border-color: var(--v3-page-border-strong);
          background: #fbfbff;
        }
        .v3-project-item.is-active,
        .v3-template-card.is-active {
          border-color: rgba(99, 102, 241, 0.36);
          background: var(--accent-softer);
          box-shadow: inset 3px 0 0 var(--accent);
        }
        .v3-project-status {
          width: fit-content;
          border-radius: 999px;
          background: var(--v3-page-soft);
          padding: 4px 7px;
          color: var(--v3-page-muted);
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
        }
        .v3-project-status.is-running {
          background: var(--warm-soft);
          color: #b45309;
        }
        .v3-project-status.is-done {
          background: rgba(16, 185, 129, 0.1);
          color: #047857;
        }
        .v3-project-status.is-failed {
          background: var(--danger-soft);
          color: #b91c1c;
        }
        .v3-project-item strong {
          color: var(--ink);
          font-size: 13px;
          font-weight: 650;
          line-height: 1.3;
        }
        .v3-project-item small,
        .v3-template-note,
        .v3-template-card p,
        .v3-message-card p,
        .v3-stage-row p {
          color: var(--v3-page-muted);
          font-size: 12px;
          font-weight: 450;
          line-height: 1.55;
        }
        .v3-empty-list,
        .v3-loading,
        .v3-notice,
        .v3-error,
        .v3-template-error {
          border-radius: 12px;
          padding: 10px;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.5;
        }
        .v3-empty-list,
        .v3-loading {
          background: var(--v3-page-soft);
          color: var(--v3-page-muted);
        }
        .v3-notice {
          border: 1px solid rgba(245, 158, 11, 0.24);
          background: rgba(245, 158, 11, 0.08);
          color: #92400e;
        }
        .v3-error,
        .v3-template-error {
          border: 1px solid rgba(239, 68, 68, 0.2);
          background: var(--danger-soft);
          color: #991b1b;
        }
        .v3-chat-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          border-bottom: 1px solid var(--v3-page-border);
          padding: 16px 18px;
        }
        .v3-chat-header h1 {
          margin: 2px 0 6px;
          color: var(--ink);
          font-size: clamp(24px, 3vw, 36px);
          font-weight: 650;
          line-height: 1;
          letter-spacing: -0.05em;
        }
        .v3-chat-header span {
          color: var(--v3-page-muted);
          font-size: 13px;
          font-weight: 450;
        }
        .v3-current-template {
          min-width: 150px;
          border: 1px solid var(--v3-page-border);
          border-radius: 14px;
          background: #fff;
          padding: 10px;
          text-align: right;
        }
        .v3-current-template span {
          display: block;
          color: var(--muted);
          font-size: 11px;
          font-weight: 650;
        }
        .v3-current-template strong {
          display: block;
          margin-top: 4px;
          color: var(--ink);
          font-size: 12px;
          font-weight: 650;
        }
        .v3-conversation {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-height: 0;
          overflow: auto;
          padding: 16px;
          background: linear-gradient(#fff, #fff) padding-box;
        }
        .v3-user-message,
        .v3-assistant-message {
          display: flex;
          gap: 9px;
        }
        .v3-user-message {
          justify-content: flex-end;
        }
        .v3-avatar {
          display: grid;
          flex: 0 0 32px;
          width: 32px;
          height: 32px;
          place-items: center;
          border-radius: 9px;
          background: var(--ink);
          color: #fff;
          font-size: 10px;
          font-weight: 700;
        }
        .v3-user-message .v3-avatar {
          background: var(--accent);
        }
        .v3-message-card,
        .v3-stage-card,
        .v3-preview-card {
          border: 1px solid var(--v3-page-border);
          border-radius: 14px;
          background: #fff;
          box-shadow: none;
        }
        .v3-message-card {
          max-width: min(720px, 88%);
          padding: 12px 14px;
        }
        .v3-message-card strong {
          display: block;
          margin-bottom: 6px;
          color: var(--ink);
          font-size: 13px;
          font-weight: 650;
        }
        .v3-message-card p {
          margin: 0;
          white-space: pre-wrap;
        }
        .v3-message-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 10px;
        }
        .v3-message-meta span {
          border-radius: 999px;
          background: var(--v3-page-soft);
          padding: 4px 7px;
          color: var(--v3-page-muted);
          font-size: 10px;
          font-weight: 600;
        }
        .v3-stage-card,
        .v3-preview-card {
          padding: 12px;
        }
        .v3-preview-card {
          width: min(100%, 860px);
          max-width: 860px;
          margin: 0 auto;
        }
        .v3-stage-card-head,
        .v3-preview-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .v3-stage-card-head span,
        .v3-preview-toolbar span {
          display: block;
          color: var(--muted);
          font-size: 11px;
          font-weight: 650;
        }
        .v3-stage-card-head strong,
        .v3-preview-toolbar strong {
          color: var(--ink);
          font-size: 13px;
          font-weight: 650;
          word-break: break-word;
        }
        .v3-stage-card-head em {
          border-radius: 999px;
          background: var(--v3-page-soft);
          padding: 6px 9px;
          color: var(--v3-page-muted);
          font-size: 11px;
          font-style: normal;
          font-weight: 650;
        }
        .v3-stage-card-head em.is-running {
          background: var(--warm-soft);
          color: #92400e;
        }
        .v3-stage-card-head em.is-done {
          background: rgba(16, 185, 129, 0.1);
          color: #047857;
        }
        .v3-stage-card-head em.is-failed {
          background: var(--danger-soft);
          color: #b91c1c;
        }
        .v3-stage-list {
          display: grid;
          gap: 7px;
        }
        .v3-stage-row {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 9px;
          border: 1px solid var(--v3-page-border);
          border-radius: 12px;
          padding: 9px;
        }
        .v3-stage-row > span {
          width: 8px;
          height: 8px;
          margin-top: 5px;
          border-radius: 50%;
          background: #94a3b8;
        }
        .v3-stage-row.is-running > span {
          background: var(--warm);
        }
        .v3-stage-row.is-done > span {
          background: var(--success);
        }
        .v3-stage-row.is-failed > span {
          background: var(--danger);
        }
        .v3-stage-row.is-warning {
          border-color: rgba(245, 158, 11, 0.24);
          background: rgba(245, 158, 11, 0.08);
        }
        .v3-stage-row strong {
          display: block;
          color: var(--ink);
          font-size: 12px;
          font-weight: 650;
        }
        .v3-stage-row p {
          margin: 3px 0 0;
        }
        .v3-stage-time {
          display: inline-flex;
          width: fit-content;
          margin-top: 5px;
          border-radius: 999px;
          background: rgba(15, 118, 110, 0.08);
          padding: 3px 7px;
          color: #0f766e;
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
        }
        .v3-stage-row.is-running .v3-stage-time {
          background: rgba(245, 158, 11, 0.12);
          color: #92400e;
        }
        .v3-stage-row.is-failed .v3-stage-time {
          background: var(--danger-soft);
          color: #b91c1c;
        }
        .v3-preview-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
        }
        .v3-preview-actions button {
          border: 1px solid var(--v3-page-border);
          background: #fff;
          color: var(--ink);
          padding: 8px 10px;
        }
        .v3-preview-actions button:hover {
          border-color: var(--v3-page-border-strong);
          background: var(--v3-page-soft);
        }
        .v3-preview-actions a {
          padding: 8px 10px;
        }
        .v3-preview-actions button:disabled,
        .v3-preview-actions a.is-disabled,
        .v3-composer button:disabled {
          cursor: not-allowed;
          opacity: 0.45;
          pointer-events: none;
        }
        .v3-preview-frame {
          aspect-ratio: 16 / 9;
          height: auto;
          overflow: hidden;
          border: 1px solid var(--v3-page-border);
          border-radius: 12px;
          background: #fff;
        }
        .v3-preview-frame iframe {
          display: block;
          width: 1280px;
          height: 720px;
          border: 0;
          border-radius: 8px;
          background: #fff;
          transform: scale(var(--v3-preview-scale));
          transform-origin: top left;
        }
        .v3-preview-empty {
          display: grid;
          min-height: 100%;
          place-content: center;
          gap: 8px;
          text-align: center;
          background: linear-gradient(90deg, rgba(99, 102, 241, 0.06) 1px, transparent 1px),
            linear-gradient(rgba(99, 102, 241, 0.06) 1px, transparent 1px);
          background-size: 28px 28px;
        }
        .v3-preview-empty strong {
          color: var(--ink);
          font-size: 24px;
          font-weight: 650;
          letter-spacing: -0.04em;
        }
        .v3-preview-empty span {
          color: var(--v3-page-muted);
          font-size: 13px;
          font-weight: 450;
        }
        .v3-preview-empty.is-error {
          border: 1px solid rgba(239, 68, 68, 0.18);
          color: #7f1d1d;
          background: var(--danger-soft);
        }
        .v3-preview-empty.is-error span {
          max-width: 520px;
          color: rgba(127, 29, 29, 0.74);
        }
        .v3-composer {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 172px;
          gap: 10px;
          border-top: 1px solid var(--v3-page-border);
          background: #fff;
          padding: 12px;
        }
        .v3-composer textarea {
          width: 100%;
          min-height: 90px;
          resize: vertical;
          border: 1px solid var(--v3-page-border-strong);
          border-radius: 12px;
          background: #fff;
          color: inherit;
          font: inherit;
          font-size: 13px;
          font-weight: 450;
          line-height: 1.55;
          outline: none;
          padding: 12px 13px;
        }
        .v3-composer textarea:focus {
          border-color: rgba(99, 102, 241, 0.46);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
        }
        .v3-composer-side {
          display: grid;
          gap: 8px;
          align-content: stretch;
        }
        .v3-composer-side span {
          display: grid;
          place-items: center;
          border-radius: 10px;
          border: 1px solid rgba(17, 12, 38, 0.08);
          background: #f3f4f6;
          color: #8a879e;
          font-size: 11px;
          font-weight: 600;
          text-align: center;
        }
        .v3-composer button {
          padding: 10px 12px;
        }
        .v3-media-toggle-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
        }
        .v3-media-toggle-grid .v3-media-toggle {
          min-height: 30px;
          border: 1px solid rgba(17, 12, 38, 0.08);
          border-radius: 9px;
          background: #f3f4f6;
          box-shadow: none;
          color: #8a879e;
          cursor: help;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0;
          padding: 6px;
          transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
        }
        .v3-media-toggle-grid .v3-media-toggle:hover {
          border-color: rgba(17, 12, 38, 0.12);
          background: #eef0f6;
        }
        .v3-media-toggle-grid .v3-media-toggle.is-active,
        .v3-media-toggle-grid .v3-media-toggle.is-disabled {
          border-color: rgba(17, 12, 38, 0.08);
          background: #f3f4f6;
          color: #8a879e;
          box-shadow: none;
        }
        .v3-media-toggle-grid .v3-media-toggle:focus-visible {
          outline: 2px solid rgba(99, 102, 241, 0.36);
          outline-offset: 2px;
        }
        .v3-template-note {
          margin: 0 0 12px;
        }
        .v3-template-note code {
          border-radius: 6px;
          background: var(--v3-page-soft);
          padding: 2px 4px;
          font-size: 11px;
        }
        .v3-template-card {
          display: grid;
          gap: 7px;
          padding: 12px;
        }
        .v3-template-card.is-preview {
          position: relative;
          display: block;
          width: 240px;
          max-width: 100%;
          height: 135px;
          min-height: unset;
          overflow: hidden;
          padding: 0;
          background: #fff;
          contain: paint;
        }
        .v3-template-preview-frame {
          position: absolute;
          inset: 0;
          z-index: 1;
          overflow: hidden;
          border-radius: inherit;
          background: #fff;
          contain: strict;
        }
        .v3-template-preview-host {
          position: absolute;
          inset: 0;
          overflow: hidden;
          contain: strict;
        }
        .v3-template-preview-empty {
          display: grid;
          height: 100%;
          place-items: center;
          padding: 20px;
          background: linear-gradient(135deg, #fff, #f7f7ff);
          color: var(--v3-page-muted);
          font-size: 12px;
          font-weight: 600;
          line-height: 1.5;
          text-align: center;
        }
        .v3-template-page-rail {
          position: absolute;
          top: 10px;
          left: 12px;
          right: 12px;
          z-index: 4;
          display: flex;
          gap: 4px;
          pointer-events: none;
        }
        .v3-template-page-dot {
          height: 3px;
          flex: 1 1 0;
          min-width: 2px;
          border-radius: 999px;
          background: rgba(17, 12, 38, 0.18);
        }
        .v3-template-page-dot.is-active {
          background: var(--accent);
        }
        .v3-template-preview-meta {
          position: absolute;
          right: 7px;
          bottom: 7px;
          z-index: 5;
          display: flex;
          max-width: min(150px, calc(100% - 14px));
          align-items: center;
          gap: 5px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.84);
          box-shadow: 0 6px 16px rgba(17, 12, 38, 0.08);
          padding: 4px 6px;
          color: var(--ink);
          font-size: 8px;
          font-weight: 700;
          line-height: 1;
          pointer-events: none;
        }
        .v3-template-preview-meta span {
          overflow: hidden;
          max-width: 92px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .v3-template-preview-meta strong,
        .v3-template-card .v3-template-preview-meta strong {
          flex: 0 0 auto;
          font-size: 8px;
          letter-spacing: 0;
        }
        .v3-template-card > span {
          width: fit-content;
          border-radius: 999px;
          background: var(--v3-page-soft);
          padding: 4px 7px;
          color: var(--v3-page-muted);
          font-size: 10px;
          font-weight: 650;
        }
        .v3-template-card strong {
          color: var(--ink);
          font-size: 15px;
          font-weight: 650;
          letter-spacing: -0.02em;
        }
        .v3-template-card p {
          margin: 0;
        }
        .v3-capability-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 2px;
        }
        .v3-capability-row span {
          border-radius: 999px;
          background: var(--accent-soft);
          padding: 4px 7px;
          color: var(--accent);
          font-size: 10px;
          font-weight: 600;
        }
        @media (max-width: 980px) {
          .v3-workbench-page {
            padding: 8px;
          }
          .v3-workbench-shell {
            grid-template-columns: 1fr;
            height: auto;
            min-height: 0;
          }
          .v3-column-resizer {
            display: none;
          }
          .v3-chat-panel {
            min-height: 820px;
          }
          .v3-chat-header,
          .v3-stage-card-head,
          .v3-preview-toolbar {
            align-items: stretch;
            flex-direction: column;
          }
          .v3-current-template {
            text-align: left;
          }
          .v3-composer {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}

function V3TemplateCard({
  template,
  selected,
  onSelect
}: {
  template: TemplateOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const slides = (template.previewSlides ?? []).filter((slide) => slide.trim().length > 0);
  const [slideIndex, setSlideIndex] = useState(0);
  const activeSlideIndex = slides.length ? Math.min(slideIndex, slides.length - 1) : 0;
  const viewport = templatePreviewViewport(template);

  function handleMouseMove(event: MouseEvent<HTMLButtonElement>) {
    if (!slides.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const progress = Math.min(0.999999, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    setSlideIndex(Math.min(slides.length - 1, Math.floor(progress * slides.length)));
  }

  return (
    <button
      type="button"
      className={`v3-template-card is-preview${selected ? " is-active" : ""}`}
      onClick={onSelect}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setSlideIndex(0)}
      title={template.id}
      aria-label={`${templateLabel(template)} template preview`}
    >
      <div className="v3-template-preview-frame" aria-hidden="true">
        {slides.length ? (
          <V3TemplateSlidePreview
            html={slides[activeSlideIndex] ?? slides[0] ?? ""}
            css={template.previewCss ?? ""}
            deckClass={template.deckClass}
            viewport={viewport}
          />
        ) : (
          <div className="v3-template-preview-empty">模板预览加载中</div>
        )}
      </div>
      {slides.length ? (
        <div className="v3-template-page-rail" aria-hidden="true">
          {slides.map((_, index) => (
            <span
              key={`${template.id}-page-${index}`}
              className={`v3-template-page-dot${index === activeSlideIndex ? " is-active" : ""}`}
            />
          ))}
        </div>
      ) : null}
      <div className="v3-template-preview-meta" aria-hidden="true">
        <span>{template.id}</span>
        <strong>{activeSlideIndex + 1}/{Math.max(1, slides.length)}</strong>
      </div>
    </button>
  );
}

function V3TemplateSlidePreview({
  html,
  css,
  deckClass,
  viewport
}: {
  html: string;
  css: string;
  deckClass?: string;
  viewport: { width: number; height: number };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [scale, setScale] = useState(0.1);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.shadowRoot ?? containerRef.current.attachShadow({ mode: "open" });
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width > 0 && height > 0) {
          setScale(Math.max(0.001, Math.min(width / viewport.width, height / viewport.height)));
        }
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  useEffect(() => {
    if (!shadowRef.current) return;
    const activeHtml = markTemplatePreviewSlideActive(html);
    const previewFx = getTemplatePreviewParticleFx(css, deckClass, html);
    shadowRef.current.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: #fff;
          contain: strict;
        }
        .preview-stage {
          position: absolute;
          top: 50%;
          left: 50%;
          width: ${viewport.width}px;
          height: ${viewport.height}px;
          overflow: hidden;
          background: #fff;
          transform: translate(-50%, -50%) scale(${scale});
          transform-origin: center center;
          pointer-events: none;
        }
        .preview-stage .deck {
          position: relative;
          width: ${viewport.width}px;
          height: ${viewport.height}px;
          overflow: hidden;
          background: #fff;
        }
        .preview-stage .template-preview-particles {
          position: absolute !important;
          inset: 0 !important;
          z-index: 5 !important;
          width: 100% !important;
          height: 100% !important;
          pointer-events: none !important;
        }
        ${css}
        .preview-stage,
        .preview-stage *,
        .preview-stage *::before,
        .preview-stage *::after {
          box-sizing: border-box !important;
        }
        .preview-stage .slide,
        .preview-stage section.slide,
        .preview-stage .slide.full {
          position: relative !important;
          inset: auto !important;
          opacity: 1 !important;
          pointer-events: none !important;
          width: ${viewport.width}px !important;
          height: ${viewport.height}px !important;
          min-width: ${viewport.width}px !important;
          max-width: ${viewport.width}px !important;
          min-height: ${viewport.height}px !important;
          max-height: ${viewport.height}px !important;
          margin: 0 !important;
          overflow: hidden !important;
          transform: none !important;
          z-index: auto !important;
        }
      </style>
      <div class="preview-stage">
        <div class="${deckClass ?? ""}">
          <div class="deck">${previewFx ? `<canvas class="template-preview-particles" data-preview-fx="${previewFx}"></canvas>` : ""}${activeHtml}</div>
        </div>
      </div>
    `;
    const cleanupCanvases = renderTemplatePreviewCanvases(shadowRef.current);
    return cleanupCanvases;
  }, [html, css, deckClass, scale, viewport.height, viewport.width]);

  return <div ref={containerRef} className="v3-template-preview-host" />;
}

function MessageBubble({ message, templates }: { message: WorkbenchMessage; templates: TemplateOption[] }) {
  const isUser = message.role === "user";
  const template = message.templateId ? templates.find((item) => item.id === message.templateId) : null;
  return (
    <div className={isUser ? "v3-user-message" : "v3-assistant-message"}>
      {!isUser ? <span className="v3-avatar">{message.role === "system" ? "SYS" : "AI"}</span> : null}
      <div className="v3-message-card">
        <strong>{isUser ? "用户需求" : message.status === "failed" ? "生成失败" : "助手消息"}</strong>
        <p>{message.content}</p>
        <div className="v3-message-meta">
          {message.status ? <span>{messageStatusLabel(message.status)}</span> : null}
          {message.localOnly ? <span>local-only</span> : null}
          {message.jobId ? <span>job {message.jobId}</span> : null}
          {template ? <span>{templateLabel(template)}</span> : message.templateId ? <span>{message.templateId}</span> : null}
          <span>{formatDate(message.createdAt)}</span>
        </div>
      </div>
      {isUser ? <span className="v3-avatar">You</span> : null}
    </div>
  );
}

function TemplateCapabilities({ capabilities, tags }: { capabilities: unknown; tags?: string[] }) {
  const values = normalizeCapabilityLabels(capabilities, tags);
  if (!values.length) return null;
  return (
    <div className="v3-capability-row">
      {values.slice(0, 5).map((value) => (
        <span key={value}>{value}</span>
      ))}
    </div>
  );
}

async function postProject(input: { name: string; templateId: string }) {
  const response = await fetch("/api/html-ppt-v3/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (isEndpointUnavailableStatus(response.status)) {
      throw new EndpointUnavailableError(readPayloadMessage(payload) || "Projects API is unavailable.");
    }
    throw new Error(readPayloadMessage(payload) || "Project 创建失败。");
  }

  return normalizeProject(payload?.project ?? payload, input);
}

function normalizeTemplates(payload: unknown): TemplateOption[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).templates)
      ? (payload as Record<string, unknown>).templates as unknown[]
      : [];
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string")
    .map((item) => ({
      id: String(item.id),
      label: stringOrUndefined(item.label),
      name: stringOrUndefined(item.name),
      description: stringOrUndefined(item.description),
      desc: stringOrUndefined(item.desc),
      capabilities: item.capabilities,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      aspectRatio: typeof item.aspectRatio === "string" ? item.aspectRatio : null,
      rendererProfile: typeof item.rendererProfile === "string" ? item.rendererProfile : null,
      deckClass: stringOrUndefined(item.deckClass),
      previewSlides: Array.isArray(item.previewSlides) ? item.previewSlides.filter((slide): slide is string => typeof slide === "string") : [],
      previewCss: stringOrUndefined(item.previewCss)
    }));
}

function normalizeProjects(payload: unknown): ProjectSummary[] {
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).projects)
      ? (payload as Record<string, unknown>).projects as unknown[]
      : [];
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string")
    .map((item) => normalizeProject(item))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function normalizeProject(payload: unknown, fallback?: { name?: string; templateId?: string }): ProjectSummary {
  const item = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const id = typeof item.id === "string" ? item.id : createClientId("project");
  return {
    id,
    name: stringOrUndefined(item.name) || stringOrUndefined(item.title) || fallback?.name || "Untitled Project",
    templateId:
      stringOrUndefined(item.templateId) ||
      stringOrUndefined(item.selectedTemplateId) ||
      stringOrUndefined(item.selected_template_id) ||
      fallback?.templateId ||
      null,
    status: normalizeProjectStatus(item.status),
    createdAt: stringOrUndefined(item.createdAt) || stringOrUndefined(item.created_at) || now,
    updatedAt: stringOrUndefined(item.updatedAt) || stringOrUndefined(item.updated_at) || now,
    localOnly: Boolean(item.localOnly)
  };
}

function normalizeMessages(payload: unknown): WorkbenchMessage[] {
  const payloadRecord = readRecord(payload);
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : payloadRecord && Array.isArray(payloadRecord.messages)
      ? payloadRecord.messages as unknown[]
      : payloadRecord?.message
        ? [payloadRecord.message]
        : payloadRecord?.userMessage || payloadRecord?.assistantMessage
          ? [payloadRecord.userMessage, payloadRecord.assistantMessage].filter(Boolean)
        : [];

  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => {
      const meta = readRecord(item.metadata) ?? readRecord(item.meta);
      const deckRender = readRecord(item.deckRender) ?? readRecord(meta?.deckRender);
      const stages = normalizeStages(item.stages) || normalizeOrchestrationStages(item.orchestration ?? meta?.orchestration);
      const content = stringOrUndefined(item.content) || stringOrUndefined(item.text) || stringOrUndefined(deckRender?.title) || "（空消息）";
      const status = normalizeMessageStatus(item.status ?? meta?.generationStatus ?? meta?.status);
      const canUseArtifact = status === "done";
      return {
        id: stringOrUndefined(item.id) || createClientId(`message-${index}`),
        role: normalizeRole(item.role),
        content,
        createdAt: stringOrUndefined(item.createdAt) || stringOrUndefined(item.created_at) || new Date().toISOString(),
        templateId:
          stringOrUndefined(item.templateId) ||
          stringOrUndefined(readRecord(item.template)?.id) ||
          stringOrUndefined(meta?.templateId) ||
          stringOrUndefined(meta?.selectedTemplateId) ||
          stringOrUndefined(readRecord(meta?.template)?.id),
        jobId: stringOrUndefined(item.jobId) || stringOrUndefined(meta?.jobId) || stringOrUndefined(deckRender?.jobId),
        status,
        previewUrl: canUseArtifact ? normalizeArtifactUrl(item.previewUrl ?? deckRender?.previewUrl ?? meta?.previewUrl) : undefined,
        downloadUrl: canUseArtifact ? normalizeArtifactUrl(item.downloadUrl ?? deckRender?.downloadUrl ?? meta?.downloadUrl) : undefined,
        stages,
        warnings: normalizeWarnings(item.warnings ?? meta?.warnings),
        localOnly: Boolean(item.localOnly ?? meta?.localOnly)
      };
    });
}

function normalizeJobs(payload: unknown): V3JobSummary[] {
  const record = readRecord(payload);
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : record && Array.isArray(record.jobs)
      ? record.jobs as unknown[]
      : [];
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const id = stringOrUndefined(item.id) || "";
      const status = normalizeJobStatus(item.status);
      return {
        id,
        status,
        templateId: stringOrUndefined(item.templateId),
        previewUrl: status === "done" ? `/html-ppt-v3/preview/${id}/index.html` : undefined,
        downloadUrl: status === "done" ? `/html-ppt-v3/download/${id}` : undefined,
        error: stringOrUndefined(item.error),
        stageHistory: normalizeStages(item.stageHistory) ?? [],
        createdAt: stringOrUndefined(item.createdAt),
        completedAt: stringOrUndefined(item.completedAt)
      };
    })
    .filter((item) => Boolean(item.id));
}

function mergeJobProgressIntoMessages(messages: WorkbenchMessage[], jobs: V3JobSummary[]): WorkbenchMessage[] {
  if (!jobs.length) return messages;
  return messages.map((message) => {
    if (!message.jobId) return message;
    const job = jobs.find((item) => item.id === message.jobId);
    if (!job) return message;
    const status = jobStatusToMessageStatus(job.status) ?? message.status;
    const canUseArtifact = status === "done";
    return {
      ...message,
      status,
      stages: job.stageHistory.length ? job.stageHistory : message.stages,
      previewUrl: canUseArtifact ? normalizeArtifactUrl(message.previewUrl ?? job.previewUrl) : message.previewUrl,
      downloadUrl: canUseArtifact ? normalizeArtifactUrl(message.downloadUrl ?? job.downloadUrl) : message.downloadUrl,
      content: job.status === "failed" && job.error ? job.error : message.content
    };
  });
}

function normalizeStages(value: unknown): StageProgress[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index) => {
      const stage = stringOrUndefined(item.stage) || stringOrUndefined(item.id) || `stage-${index}`;
      return {
        id: stringOrUndefined(item.id) || stage,
        stage,
        label: stringOrUndefined(item.label) || stringOrUndefined(item.name) || stageLabel(stage),
        detail: stringOrUndefined(item.detail) || stringOrUndefined(item.summary) || "阶段处理中",
        status: normalizeStageStatus(item.status),
        startedAt: stringOrUndefined(item.startedAt),
        completedAt: stringOrUndefined(item.completedAt),
        elapsedMs: numberOrUndefined(item.elapsedMs),
        isWarning: Boolean(item.isWarning)
      };
    });
}

function normalizeOrchestrationStages(value: unknown): StageProgress[] | undefined {
  const record = readRecord(value);
  const steps = Array.isArray(record?.steps) ? record.steps : null;
  if (!steps) return undefined;
  return normalizeStages(steps);
}

function createLocalProject(name: string, templateId: string): ProjectSummary {
  const now = new Date().toISOString();
  return {
    id: createClientId("local-project"),
    name,
    templateId: templateId || null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    localOnly: true
  };
}

function initialStages(): StageProgress[] {
  return [];
}

function updateStage(stages: StageProgress[], stage: string, patch: Partial<StageProgress>): StageProgress[] {
  const next = stages.length ? stages : initialStages();
  const existing = next.find((item) => item.stage === stage);
  const normalizedPatch = normalizeStagePatch(existing, patch);
  const baseline = normalizedPatch.status === "running"
    ? completeEarlierRunningStages(next, stage, normalizedPatch.startedAt)
    : next;
  if (!baseline.some((item) => item.stage === stage)) {
    return [
      ...baseline,
      {
        id: stage,
        stage,
        label: stageLabel(stage),
        detail: normalizedPatch.detail ?? "阶段处理中",
        status: normalizedPatch.status ?? "running",
        startedAt: normalizedPatch.startedAt,
        completedAt: normalizedPatch.completedAt,
        elapsedMs: normalizedPatch.elapsedMs,
        isWarning: normalizedPatch.isWarning
      }
    ];
  }

  return baseline.map((item) => item.stage === stage ? { ...item, ...normalizedPatch } : item);
}

function completeEarlierRunningStages(stages: StageProgress[], nextStage: string, completedAt?: string): StageProgress[] {
  const nextStageIndex = stageOrderIndex(nextStage);
  if (nextStageIndex < 0) return stages;
  const doneAt = completedAt || new Date().toISOString();
  return stages.map((stage) => {
    const currentIndex = stageOrderIndex(stage.stage);
    if (currentIndex < 0 || currentIndex >= nextStageIndex || stage.status !== "running") return stage;
    return {
      ...stage,
      status: "done",
      completedAt: stage.completedAt ?? doneAt,
      elapsedMs: stage.elapsedMs ?? (stage.startedAt ? Math.max(0, Date.parse(doneAt) - Date.parse(stage.startedAt)) : undefined)
    };
  });
}

function stageOrderIndex(stage: string) {
  return V3_STAGES.findIndex((item) => item.stage === stage);
}

function normalizeStagePatch(existing: StageProgress | undefined, patch: Partial<StageProgress>): Partial<StageProgress> {
  const status = patch.status ?? existing?.status;
  const startedAt = patch.startedAt ?? existing?.startedAt ?? (status === "running" ? new Date().toISOString() : undefined);
  const completedAt = patch.completedAt ?? existing?.completedAt ?? (status === "done" || status === "failed" ? new Date().toISOString() : undefined);
  const elapsedMs = typeof patch.elapsedMs === "number"
    ? patch.elapsedMs
    : startedAt && completedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
      : existing?.elapsedMs;
  return {
    ...patch,
    startedAt,
    completedAt,
    elapsedMs
  };
}

function upsertInfoStage(stages: StageProgress[], detail: string): StageProgress[] {
  const current = stages.length ? stages : initialStages();
  const item: StageProgress = {
    id: "progress",
    stage: "progress",
    label: "准备中",
    detail,
    status: "info"
  };
  return current.some((stage) => stage.id === item.id)
    ? current.map((stage) => stage.id === item.id ? item : stage)
    : [item, ...current];
}

function markAllStagesDone(stages: StageProgress[] = initialStages()): StageProgress[] {
  return (stages.length ? stages : initialStages()).map((stage) => ({
    ...stage,
    status: stage.status === "failed" ? "failed" : "done"
  }));
}

function failPendingStages(stages: StageProgress[], detail: string): StageProgress[] {
  return (stages.length ? stages : initialStages()).map((stage) => ({
    ...stage,
    detail: stage.status === "running" || stage.status === "pending" ? detail : stage.detail,
    status: stage.status === "done" ? "done" : "failed"
  }));
}

function buildGenerateRequest(prompt: string, templateId: string, mediaOptions: MediaOptions): GenerateRequest {
  return {
    theme: prompt.slice(0, 500),
    pageCount: clampNumber(extractFirstNumber(prompt, /(\d{1,2})\s*(?:页|slides?|p)/i), 5, 30, 8),
    wordBudget: clampNumber(extractFirstNumber(prompt, /(\d{3,5})\s*(?:字|words?|tokens?)/i), 500, 15000, 1800),
    templateId,
    includeImages: mediaOptions.includeImages,
    includeVideo: mediaOptions.includeVideo,
    includeChart: mediaOptions.includeChart,
    includeAudio: mediaOptions.includeAudio
  };
}

function extractFirstNumber(input: string, pattern: RegExp) {
  const match = input.match(pattern);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function clampNumber(value: number | null, min: number, max: number, fallback: number) {
  if (value === null) return fallback;
  return Math.min(max, Math.max(min, value));
}

function extractJobId(payload: unknown): string | undefined {
  const record = readRecord(payload);
  const message = readRecord(record?.message);
  const assistantMessage = readRecord(record?.assistantMessage);
  const messageMeta = readRecord(message?.metadata) ?? readRecord(message?.meta);
  const assistantMeta = readRecord(assistantMessage?.metadata) ?? readRecord(assistantMessage?.meta);
  return stringOrUndefined(record?.jobId)
    || stringOrUndefined(readRecord(record?.job)?.jobId)
    || stringOrUndefined(readRecord(record?.job)?.id)
    || stringOrUndefined(message?.jobId)
    || stringOrUndefined(assistantMessage?.jobId)
    || stringOrUndefined(messageMeta?.jobId)
    || stringOrUndefined(assistantMeta?.jobId)
    || stringOrUndefined(readRecord(record?.meta)?.jobId);
}

function extractArtifact(payload: unknown) {
  const record = readRecord(payload);
  const message = readRecord(record?.message);
  const assistantMessage = readRecord(record?.assistantMessage);
  const messageMeta = readRecord(message?.metadata) ?? readRecord(message?.meta);
  const assistantMeta = readRecord(assistantMessage?.metadata) ?? readRecord(assistantMessage?.meta);
  const deckRender = readRecord(record?.deckRender) ?? readRecord(message?.deckRender) ?? readRecord(assistantMessage?.deckRender);
  return {
    previewUrl: normalizeArtifactUrl(record?.previewUrl ?? message?.previewUrl ?? assistantMessage?.previewUrl ?? deckRender?.previewUrl ?? messageMeta?.previewUrl ?? assistantMeta?.previewUrl),
    downloadUrl: normalizeArtifactUrl(record?.downloadUrl ?? message?.downloadUrl ?? assistantMessage?.downloadUrl ?? deckRender?.downloadUrl ?? messageMeta?.downloadUrl ?? assistantMeta?.downloadUrl)
  };
}

function normalizeArtifactUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const url = value.trim();
  if (url.startsWith("/api/") || /^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/html-ppt-v3/")) return `/api${url}`;
  return url;
}

async function readPreviewResponseMessage(response: Response) {
  const fallback = `预览文件无法加载（HTTP ${response.status}）。`;
  const text = await response.text().catch(() => "");
  const payload = parseJsonOrNull(text);
  const message = extractPreviewErrorMessage(payload) || text.trim() || fallback;
  if (message.includes(STALE_TEMPLATE_ERROR_CODE) || message.includes("旧模板结构")) {
    return STALE_TEMPLATE_ERROR_MESSAGE;
  }
  return message.length > 240 ? `${message.slice(0, 240)}...` : message;
}

function extractPreviewErrorMessage(payload: unknown): string | undefined {
  const record = readRecord(payload);
  if (!record) return undefined;
  const directMessage = stringOrUndefined(record.message);
  const nestedMessage = readRecord(record.message);
  const nestedError = readRecord(record.error);
  const directCode = stringOrUndefined(record.code);
  const nestedCode = stringOrUndefined(nestedMessage?.code) || stringOrUndefined(nestedError?.code);
  if (directCode === STALE_TEMPLATE_ERROR_CODE || nestedCode === STALE_TEMPLATE_ERROR_CODE) {
    return STALE_TEMPLATE_ERROR_MESSAGE;
  }
  return stringOrUndefined(nestedMessage?.message)
    || stringOrUndefined(nestedError?.message)
    || directMessage
    || stringOrUndefined(record.error)
    || stringOrUndefined(record.detail);
}

function parseJsonOrNull(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function latestMessage(messages: WorkbenchMessage[], predicate: (message: WorkbenchMessage) => boolean) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index]!)) return messages[index]!;
  }
  return null;
}

function normalizeCapabilityLabels(capabilities: unknown, tags?: string[]) {
  if (Array.isArray(tags) && tags.length) return tags.filter(Boolean);
  if (Array.isArray(capabilities)) {
    return capabilities
      .map((item) => typeof item === "string" ? item : stringOrUndefined(readRecord(item)?.label) || stringOrUndefined(readRecord(item)?.id))
      .filter((item): item is string => Boolean(item));
  }
  const record = readRecord(capabilities);
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
}

function parseEventData(event: Event): Record<string, unknown> {
  const message = event as MessageEvent<string>;
  try {
    return JSON.parse(message.data || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    planning: "规划大纲",
    writing: "撰写内容",
    imaging: "生成图片",
    injecting: "注入页面",
    packaging: "打包输出",
    progress: "准备中"
  };
  return labels[stage] ?? stage;
}

function formatStageTiming(stage: StageProgress, now: number | null) {
  const elapsedMs = getStageElapsedMs(stage, now);
  if (elapsedMs == null) return "";
  const duration = formatElapsedSeconds(elapsedMs);
  if (stage.status === "running") return `已等待 ${duration}`;
  if (stage.status === "failed") return `失败前等待 ${duration}`;
  if (stage.status === "done") return `耗时 ${duration}`;
  return "";
}

function getStageElapsedMs(stage: StageProgress, now: number | null) {
  if (typeof stage.elapsedMs === "number" && stage.status !== "running") return stage.elapsedMs;
  if (!stage.startedAt) return undefined;
  const start = Date.parse(stage.startedAt);
  if (!Number.isFinite(start)) return undefined;
  if (stage.status === "running") {
    if (now == null) return typeof stage.elapsedMs === "number" ? stage.elapsedMs : undefined;
    return Math.max(0, now - start);
  }
  if (stage.completedAt) {
    const end = Date.parse(stage.completedAt);
    if (Number.isFinite(end)) return Math.max(0, end - start);
  }
  return typeof stage.elapsedMs === "number" ? stage.elapsedMs : undefined;
}

function formatElapsedSeconds(elapsedMs: number) {
  return `${Math.max(0, Math.floor(elapsedMs / 1000))} 秒`;
}

function formatStageDetail(summary: unknown, fallback: string) {
  if (!summary) return fallback;
  if (typeof summary === "string") return summary;
  if (typeof summary === "object") {
    const record = summary as Record<string, unknown>;
    const source = typeof record.source === "string" ? `source=${record.source}` : "";
    const warnings = normalizeWarnings(record.warnings);
    const detail = typeof record.detail === "string" ? record.detail : fallback;
    return [detail, source, warnings.length ? `warnings=${warnings.join("；")}` : ""].filter(Boolean).join("；");
  }
  try {
    return JSON.stringify(summary);
  } catch {
    return fallback;
  }
}

function hasFallbackSource(value: unknown) {
  const text = typeof value === "string" ? value : safeStringify(value);
  return /source\s*(=|:)\s*["']?fallback\b/i.test(text);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readPayloadMessage(payload: unknown) {
  const record = readRecord(payload);
  return stringOrUndefined(record?.message) || stringOrUndefined(record?.error) || stringOrUndefined(record?.detail);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRole(value: unknown): WorkbenchMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system") return value;
  return "assistant";
}

function normalizeProjectStatus(value: unknown): ProjectSummary["status"] {
  if (value === "running" || value === "done" || value === "failed" || value === "draft" || value === "idle") return value;
  if (value === "completed") return "done";
  return "idle";
}

function normalizeJobStatus(value: unknown): V3JobSummary["status"] {
  if (
    value === "pending" ||
    value === "planning" ||
    value === "writing" ||
    value === "imaging" ||
    value === "injecting" ||
    value === "packaging" ||
    value === "done" ||
    value === "failed" ||
    value === "draft" ||
    value === "idle"
  ) {
    return value;
  }
  if (value === "completed") return "done";
  return "idle";
}

function jobStatusToMessageStatus(status: V3JobSummary["status"]): WorkbenchMessage["status"] | undefined {
  if (status === "done" || status === "failed") return status;
  if (status === "pending") return "queued";
  if (status === "planning" || status === "writing" || status === "imaging" || status === "injecting" || status === "packaging") return "running";
  return normalizeMessageStatus(status);
}

function normalizeMessageStatus(value: unknown): WorkbenchMessage["status"] | undefined {
  if (value === "queued" || value === "running" || value === "done" || value === "failed" || value === "info") return value;
  if (value === "completed") return "done";
  if (value === "pending") return "queued";
  if (value === "planning" || value === "writing" || value === "imaging" || value === "injecting" || value === "packaging") return "running";
  return undefined;
}

function normalizeStageStatus(value: unknown): StageProgress["status"] {
  if (value === "pending" || value === "running" || value === "done" || value === "failed" || value === "info") return value;
  if (value === "completed") return "done";
  return "info";
}

function templateLabel(template: TemplateOption) {
  return template.label || template.name || template.id;
}

function templateDescription(template: TemplateOption) {
  return template.description || template.desc || "";
}

function templatePreviewViewport(template: TemplateOption) {
  if (template.aspectRatio === "3:4" || template.rendererProfile === "social-portrait") {
    return { width: 960, height: 1280 };
  }
  return { width: 1280, height: 720 };
}

function markTemplatePreviewSlideActive(html: string) {
  const withoutActive = html.replace(/\s(?:is-active|active)(?=[\s"])/g, "");
  const sectionClassPattern = /<section\b([^>]*?)\bclass=(["'])([^"']*)\2/i;
  if (sectionClassPattern.test(withoutActive)) {
    return withoutActive.replace(sectionClassPattern, (_match, before, quote, className) => {
      return `<section${before}class=${quote}${className} is-active${quote}`;
    });
  }
  return withoutActive.replace(/<section\b/i, `<section class="slide is-active"`);
}

function getTemplatePreviewParticleFx(css: string, deckClass?: string, html?: string) {
  const signature = `${deckClass ?? ""}\n${css}\n${html ?? ""}`.toLowerCase();
  if (signature.includes("quantum-canvas") || signature.includes("tpl-quantum")) return "quantum-canvas";
  if (signature.includes("ocean-particles") || signature.includes("tpl-ocean")) return "ocean-particles";
  return "";
}

function renderTemplatePreviewCanvases(root: ShadowRoot | null) {
  const cleanups: Array<() => void> = [];
  if (!root) return () => {};
  root.querySelectorAll("canvas").forEach((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const parent = canvas.parentElement;
    const width = Math.max(240, Math.round(parent?.clientWidth || canvas.clientWidth || 520));
    const height = Math.max(140, Math.round(parent?.clientHeight || canvas.clientHeight || 280));
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = width;
    canvas.height = height;
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const computed = getComputedStyle(canvas);
    const primary = computed.getPropertyValue("--primary").trim() || computed.getPropertyValue("--accent").trim() || "#0ea5e9";
    const secondary = computed.getPropertyValue("--secondary").trim() || computed.getPropertyValue("--text-main").trim() || "#0f172a";
    const muted = computed.getPropertyValue("--text-muted").trim() || "rgba(15, 23, 42, 0.42)";
    const id = `${canvas.id} ${canvas.getAttribute("data-chart-slot") ?? ""}`.toLowerCase();

    context.clearRect(0, 0, width, height);
    const previewFx = canvas.getAttribute("data-preview-fx");
    if (previewFx === "ocean-particles" || id.includes("ocean-particles")) {
      cleanups.push(animateTemplatePreviewOceanParticles(context, width, height, primary, secondary));
    } else if (previewFx === "quantum-canvas" || id.includes("quantum-canvas")) {
      cleanups.push(animateTemplatePreviewQuantumNodes(context, width, height, primary, secondary));
    } else if (id.includes("pie") || id.includes("doughnut")) {
      drawTemplatePreviewPie(context, width, height, primary, secondary, muted);
    } else if (id.includes("gantt")) {
      drawTemplatePreviewGantt(context, width, height, primary, secondary, muted);
    } else if (id.includes("bar")) {
      drawTemplatePreviewBars(context, width, height, primary, secondary, muted);
    } else {
      drawTemplatePreviewLine(context, width, height, primary, secondary, muted);
    }
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}

function drawTemplatePreviewAxes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  muted: string
) {
  const padding = Math.max(22, Math.min(width, height) * 0.12);
  context.save();
  context.strokeStyle = toAlphaColor(muted, 0.28);
  context.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = padding + ((height - padding * 1.7) * index) / 3;
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding * 0.7, y);
    context.stroke();
  }
  context.restore();
  return { left: padding, right: width - padding * 0.7, top: padding, bottom: height - padding * 0.7 };
}

function drawTemplatePreviewLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  muted: string
) {
  const chart = drawTemplatePreviewAxes(context, width, height, muted);
  const values = [0.18, 0.34, 0.48, 0.72, 0.86];
  const points = values.map((value, index) => ({
    x: chart.left + ((chart.right - chart.left) * index) / (values.length - 1),
    y: chart.bottom - (chart.bottom - chart.top) * value
  }));

  context.save();
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  const gradient = context.createLinearGradient(chart.left, chart.top, chart.right, chart.bottom);
  gradient.addColorStop(0, primary);
  gradient.addColorStop(1, secondary);
  context.strokeStyle = gradient;
  context.lineWidth = Math.max(3, width * 0.008);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.stroke();

  points.forEach((point) => {
    context.beginPath();
    context.arc(point.x, point.y, Math.max(4, width * 0.011), 0, Math.PI * 2);
    context.fillStyle = primary;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#ffffff";
    context.stroke();
  });
  context.restore();
}

function drawTemplatePreviewBars(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  muted: string
) {
  const chart = drawTemplatePreviewAxes(context, width, height, muted);
  const values = [0.48, 0.62, 0.78, 0.54, 0.88];
  const gap = Math.max(8, width * 0.025);
  const barWidth = Math.max(10, (chart.right - chart.left - gap * (values.length - 1)) / values.length);
  values.forEach((value, index) => {
    const x = chart.left + index * (barWidth + gap);
    const barHeight = (chart.bottom - chart.top) * value;
    const gradient = context.createLinearGradient(0, chart.bottom - barHeight, 0, chart.bottom);
    gradient.addColorStop(0, primary);
    gradient.addColorStop(1, secondary);
    context.fillStyle = gradient;
    roundRect(context, x, chart.bottom - barHeight, barWidth, barHeight, Math.min(10, barWidth / 2));
    context.fill();
  });
}

function drawTemplatePreviewPie(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  muted: string
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.32;
  const slices = [
    { value: 0.36, color: primary },
    { value: 0.28, color: secondary },
    { value: 0.2, color: toAlphaColor(primary, 0.5) },
    { value: 0.16, color: toAlphaColor(muted, 0.55) }
  ];
  let angle = -Math.PI / 2;
  slices.forEach((slice) => {
    const next = angle + Math.PI * 2 * slice.value;
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.arc(centerX, centerY, radius, angle, next);
    context.closePath();
    context.fillStyle = slice.color;
    context.fill();
    angle = next;
  });
  context.globalCompositeOperation = "destination-out";
  context.beginPath();
  context.arc(centerX, centerY, radius * 0.52, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = "source-over";
}

function drawTemplatePreviewGantt(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  muted: string
) {
  const chart = drawTemplatePreviewAxes(context, width, height, muted);
  const rows: Array<[number, number]> = [
    [0.02, 0.34],
    [0.2, 0.46],
    [0.43, 0.78],
    [0.64, 0.96]
  ];
  const rowHeight = Math.max(14, (chart.bottom - chart.top) / 8);
  rows.forEach(([start, end], index) => {
    const x = chart.left + (chart.right - chart.left) * start;
    const barWidth = (chart.right - chart.left) * (end - start);
    const y = chart.top + index * rowHeight * 1.65;
    context.fillStyle = index % 2 === 0 ? primary : secondary;
    roundRect(context, x, y, barWidth, rowHeight, rowHeight / 2);
    context.fill();
  });
}

function animateTemplatePreviewOceanParticles(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string
) {
  const start = window.performance.now();
  let frameId = 0;

  function renderFrame(now: number) {
    drawTemplatePreviewOceanParticles(context, width, height, primary, secondary, (now - start) / 1000);
    frameId = window.requestAnimationFrame(renderFrame);
  }

  renderFrame(start);
  return () => window.cancelAnimationFrame(frameId);
}

function animateTemplatePreviewQuantumNodes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string
) {
  const start = window.performance.now();
  let frameId = 0;

  function renderFrame(now: number) {
    drawTemplatePreviewQuantumNodes(context, width, height, primary, secondary, (now - start) / 1000);
    frameId = window.requestAnimationFrame(renderFrame);
  }

  renderFrame(start);
  return () => window.cancelAnimationFrame(frameId);
}

function drawTemplatePreviewOceanParticles(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  time = 0
) {
  context.save();
  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, toAlphaColor(primary, 0.22));
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.08)");
  gradient.addColorStop(1, toAlphaColor(secondary, 0.16));
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const particleCount = 54;
  for (let index = 0; index < particleCount; index += 1) {
    const baseX = ((index * 97) % 1000) / 1000;
    const baseY = ((index * 53) % 1000) / 1000;
    const speed = 0.035 + (index % 9) * 0.006;
    const drift = Math.sin(time * (0.7 + (index % 5) * 0.12) + index) * width * 0.018;
    const x = baseX * width + drift;
    const y = (1 - ((baseY + time * speed) % 1)) * height;
    const radius = 1.6 + (index % 7) * 0.8;
    const alpha = 0.12 + (index % 5) * 0.045;
    const glowRadius = radius * (2.4 + (index % 3) * 0.6);

    const bubble = context.createRadialGradient(x, y, 0, x, y, glowRadius);
    bubble.addColorStop(0, toAlphaColor(index % 2 === 0 ? primary : secondary, alpha + 0.18));
    bubble.addColorStop(0.35, toAlphaColor(index % 2 === 0 ? primary : secondary, alpha));
    bubble.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = bubble;
    context.beginPath();
    context.arc(x, y, glowRadius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = toAlphaColor("#ffffff", Math.min(0.35, alpha + 0.08));
    context.lineWidth = 0.9;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function drawTemplatePreviewQuantumNodes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  primary: string,
  secondary: string,
  time = 0
) {
  context.save();
  context.clearRect(0, 0, width, height);
  context.globalCompositeOperation = "lighter";

  const nodeCount = 34;
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const baseX = ((index * 137) % 1000) / 1000;
    const baseY = ((index * 271) % 1000) / 1000;
    const speed = 0.28 + (index % 7) * 0.04;
    return {
      x: width * (baseX + Math.sin(time * speed + index * 0.7) * 0.035),
      y: height * (baseY + Math.cos(time * (speed * 0.8) + index * 0.43) * 0.045),
      radius: 1.8 + (index % 5) * 0.65,
      color: index % 2 === 0 ? primary : secondary
    };
  });

  for (let outer = 0; outer < nodes.length; outer += 1) {
    const node = nodes[outer]!;
    for (let inner = outer + 1; inner < nodes.length; inner += 1) {
      const target = nodes[inner]!;
      const dx = node.x - target.x;
      const dy = node.y - target.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.min(width, height) * 0.24;
      if (distance > threshold) continue;
      context.globalAlpha = ((threshold - distance) / threshold) * 0.22;
      context.strokeStyle = outer % 2 === 0 ? primary : secondary;
      context.lineWidth = 0.8;
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(target.x, target.y);
      context.stroke();
    }
  }

  nodes.forEach((node, index) => {
    const pulse = 1 + Math.sin(time * 2.3 + index) * 0.28;
    const glow = context.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 7 * pulse);
    glow.addColorStop(0, toAlphaColor(node.color, 0.68));
    glow.addColorStop(0.28, toAlphaColor(node.color, 0.22));
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.globalAlpha = 1;
    context.fillStyle = glow;
    context.beginPath();
    context.arc(node.x, node.y, node.radius * 7 * pulse, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = node.color;
    context.beginPath();
    context.arc(node.x, node.y, node.radius * pulse, 0, Math.PI * 2);
    context.fill();
  });

  context.globalCompositeOperation = "source-over";
  context.restore();
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function toAlphaColor(color: string, alpha: number) {
  if (!color) return `rgba(15, 23, 42, ${alpha})`;
  if (color.startsWith("#")) {
    const raw = color.slice(1);
    const normalized = raw.length === 3
      ? raw.split("").map((item) => item + item).join("")
      : raw.slice(0, 6);
    const value = Number.parseInt(normalized, 16);
    if (!Number.isNaN(value)) {
      const red = (value >> 16) & 255;
      const green = (value >> 8) & 255;
      const blue = value & 255;
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }
  }
  if (color.startsWith("rgb(")) {
    return color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
  }
  return color;
}

function projectStatusLabel(project: ProjectSummary) {
  if (project.localOnly) return `${project.status} · local`;
  return project.status;
}

function messageStatusLabel(status?: WorkbenchMessage["status"]) {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "生成中",
    done: "完成",
    failed: "失败",
    info: "已提交"
  };
  return status ? labels[status] ?? status : "消息";
}

function promptSummary(input: string) {
  const text = input.replace(/\s+/g, " ").trim();
  return text.length > 34 ? `${text.slice(0, 34)}...` : text || "Untitled Project";
}

function formatDate(input: string) {
  const time = Date.parse(input);
  if (!Number.isFinite(time)) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(time));
}

function isEndpointUnavailableStatus(status: number) {
  return status === 404 || status >= 500;
}

function isLocalProjectId(projectId: string) {
  return projectId.startsWith("local-project-");
}

function createClientId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class EndpointUnavailableError extends Error {}
