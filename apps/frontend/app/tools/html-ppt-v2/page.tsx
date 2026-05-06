"use client";

import type { FormEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type V2TemplateSelection = {
  mode: "pinned" | "auto-deterministic" | "auto-llm";
  chosenTemplateId: string;
  shortlist: string[];
  rationale: string;
  confidence: "high" | "medium" | "low";
};

type V2DeckResponse = {
  deckId: string;
  title: string;
  status: "clean" | "warning" | "failed";
  previewUrl: string;
  downloadUrl: string;
  manifestUrl: string;
  verificationReportUrl: string;
  verification?: {
    mode?: "static" | "playwright";
    reportStatus?: "clean" | "warning" | "failed";
    hardIssueCount: number;
    warningCount: number;
    slideCount: number;
    screenshotCount?: number;
  };
  screenshots?: Array<{ slideIndex: number; url: string }>;
  auxiliaryArtifacts?: Record<string, string>;
  templateSelection?: V2TemplateSelection;
  trace?: {
    intentSource?: string;
    templateSelectionSource?: string;
    templateSelection?: V2TemplateSelection;
    evidenceSource?: string;
    narrativeSource?: string;
    designSource?: string;
    layoutPlanSource?: string;
    slotFillSource?: string;
    renderSource?: string;
    verificationSource?: string;
    auxiliarySource?: string;
  };
};

type V2DeckJobStage = {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  detail: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs: number;
  modelCalls: number;
  retryCount: number;
  failureReason?: string;
};

type V2DeckJob = {
  jobId: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  elapsedMs: number;
  modelCalls: number;
  error?: string;
  stages: V2DeckJobStage[];
  result?: V2DeckResponse;
};

type V2TemplateOption = {
  id: string;
  label: string;
  desc: string;
  emoji: string;
  isAuto?: boolean;
  aspectRatio?: "16:9" | "3:4" | null;
  rendererProfile?: "standard-wide" | "social-portrait" | string | null;
  deckClass?: string;
  thumbnailFile?: string | null;
  previewSlides?: string[];
  previewCss?: string;
};

type V2TemplateCatalogItem = Partial<V2TemplateOption> & {
  id?: string;
  description?: string;
  labelI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
};

const DEFAULT_PROMPT = "制作一个6页HTML PPT，主题为AI Agent在中小企业的应用，约1000字，面向企业管理者，要求包含趋势、场景、风险和落地路线。";

const V2_TEMPLATE_FALLBACKS: V2TemplateOption[] = [
  { id: "auto", label: "Auto", emoji: "AUTO", desc: "自动选择最适合本次主题的模板。", isAuto: true },
  { id: "course-module", label: "课程模块", emoji: "COURSE", desc: "课程、教学、知识拆解和培训材料。" },
  { id: "dir-key-nav-minimal", label: "极简导航", emoji: "MIN", desc: "简洁演示、信息卡片和克制风格汇报。" },
  { id: "graphify-dark-graph", label: "暗色图谱", emoji: "GRAPH", desc: "知识图谱、数据网络、AI 和复杂系统解释。" },
  { id: "hermes-cyber-terminal", label: "赛博终端", emoji: "TERM", desc: "安全、开发者、系统底层和未来科技主题。" },
  { id: "knowledge-arch-blueprint", label: "知识蓝图", emoji: "BLUE", desc: "知识体系、架构图、方法论和学习路径。" },
  { id: "obsidian-claude-gradient", label: "黑曜渐变", emoji: "DARK", desc: "AI、创意科技和高端品牌叙事。" },
  { id: "pitch-deck", label: "投资人路演", emoji: "PITCH", desc: "融资、战略汇报和高层决策。" },
  { id: "presenter-mode-reveal", label: "演讲展示", emoji: "STAGE", desc: "正式演讲、主题分享和舞台展示。" },
  { id: "product-launch", label: "产品发布", emoji: "LAUNCH", desc: "产品发布、功能展示和市场传播。" },
  { id: "tech-sharing", label: "技术分享", emoji: "TECH", desc: "工程团队、架构拆解和技术原理讲解。" },
  { id: "testing-safety-alert", label: "安全警示", emoji: "ALERT", desc: "风险提示、测试复盘、安全事故和应急预案。" },
  { id: "weekly-report", label: "周报汇报", emoji: "WEEK", desc: "周期复盘、经营数据、项目进展和管理层同步。" },
  { id: "xhs-pastel-card", label: "柔和彩卡", emoji: "PASTEL", desc: "消费科普、生活建议和轻内容分享。" },
  { id: "xhs-post", label: "小红书图文", emoji: "XHS", desc: "轻知识、生活方式、消费内容和社媒图文。" },
  { id: "xhs-white-editorial", label: "白底杂志", emoji: "MAG", desc: "知识科普、审美内容和社媒长图。" }
];

const V2_TEMPLATE_ORDER = V2_TEMPLATE_FALLBACKS.map((template) => template.id);
const V2_TEMPLATE_FALLBACK_BY_ID = new Map(V2_TEMPLATE_FALLBACKS.map((template) => [template.id, template]));
const V2_RIGHT_PANEL_TEMPLATE_ID = "product-launch";
const V2_RIGHT_PANEL_TEMPLATE_FALLBACK: V2TemplateOption =
  V2_TEMPLATE_FALLBACK_BY_ID.get(V2_RIGHT_PANEL_TEMPLATE_ID) ?? {
    id: V2_RIGHT_PANEL_TEMPLATE_ID,
    label: "产品发布",
    emoji: "LAUNCH",
    desc: "产品发布、功能展示和市场传播。",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide"
  };

const V2_STAGE_META: Record<string, { purpose: string; usesModel: boolean }> = {
  "01-intent": { purpose: "识别主题、页数、字数和受众", usesModel: true },
  "01b-template-select": { purpose: "选择或确认模板", usesModel: true },
  "02-evidence": { purpose: "提取支撑内容和事实材料", usesModel: true },
  "03-narrative": { purpose: "规划叙事结构和每页内容", usesModel: true },
  "04-design": { purpose: "确定视觉方向和主题约束", usesModel: true },
  "05-layout": { purpose: "为每页选择布局", usesModel: true },
  "06-slots": { purpose: "填充结构化页面槽位", usesModel: true },
  "07-assets": { purpose: "准备图表和静态资源", usesModel: false },
  "08-choreography": { purpose: "编排动效与页面节奏", usesModel: false },
  "09-critic": { purpose: "质量复核与风险拦截", usesModel: true },
  "10-render": { purpose: "本地 renderer 输出 HTML", usesModel: false },
  "11-verify": { purpose: "本地验证和截图检查", usesModel: false },
  "12-artifacts": { purpose: "生成附属文件", usesModel: false },
  "13-publish": { purpose: "发布预览和下载包", usesModel: false }
};

function normalizeV2TemplateCatalog(raw: V2TemplateCatalogItem[]) {
  const merged = new Map<string, V2TemplateOption>(
    V2_TEMPLATE_FALLBACKS.map((template) => [template.id, { ...template }])
  );
  const extras: V2TemplateOption[] = [];

  for (const item of raw) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id === "html-ppt-v2" ? "auto" : item.id;
    const fallback = V2_TEMPLATE_FALLBACK_BY_ID.get(id);
    const template: V2TemplateOption = {
      id,
      label:
        (id === "auto" ? "Auto" : "") ||
        (typeof item.label === "string" && item.label.trim()) ||
        item.labelI18n?.["zh-CN"] ||
        fallback?.label ||
        id,
      desc:
        (id === "auto" ? fallback?.desc : "") ||
        (typeof item.desc === "string" && item.desc.trim()) ||
        (typeof item.description === "string" && item.description.trim()) ||
        item.descriptionI18n?.["zh-CN"] ||
        fallback?.desc ||
        "Skill template",
      emoji:
        (id === "auto" ? "AUTO" : "") ||
        (typeof item.emoji === "string" && item.emoji.trim()) ||
        fallback?.emoji ||
        (id === "auto" ? "AUTO" : "TPL"),
      isAuto: id === "auto" ? true : Boolean(item.isAuto),
      aspectRatio: item.aspectRatio ?? fallback?.aspectRatio ?? null,
      rendererProfile: item.rendererProfile ?? fallback?.rendererProfile ?? null,
      deckClass: item.deckClass ?? fallback?.deckClass,
      thumbnailFile: item.thumbnailFile ?? fallback?.thumbnailFile ?? null,
      previewSlides: Array.isArray(item.previewSlides) ? item.previewSlides : fallback?.previewSlides ?? [],
      previewCss: typeof item.previewCss === "string" ? item.previewCss : fallback?.previewCss
    };

    if (V2_TEMPLATE_FALLBACK_BY_ID.has(id)) {
      merged.set(id, template);
    } else {
      extras.push(template);
    }
  }

  return [
    ...V2_TEMPLATE_ORDER
      .map((id) => merged.get(id))
      .filter((template): template is V2TemplateOption => Boolean(template)),
    ...extras.filter((extra) => !merged.has(extra.id))
  ];
}

export default function HtmlPptV2Page() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [jobs, setJobs] = useState<V2DeckJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [activePollJobId, setActivePollJobId] = useState("");
  const [job, setJob] = useState<V2DeckJob | null>(null);
  const [deck, setDeck] = useState<V2DeckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const [templates, setTemplates] = useState<V2TemplateOption[]>(V2_TEMPLATE_FALLBACKS);
  const [selectedTemplateId, setSelectedTemplateId] = useState(V2_RIGHT_PANEL_TEMPLATE_ID);

  const selectedTemplateLabel = templateLabel(selectedTemplateId, templates);
  const visibleTemplates = useMemo(() => {
    const filtered = templates.filter((template) => !template.isAuto);
    return filtered.length ? filtered : [V2_RIGHT_PANEL_TEMPLATE_FALLBACK];
  }, [templates]);
  const currentJob = job ?? jobs.find((item) => item.jobId === selectedJobId) ?? null;
  const currentDeck = deck ?? currentJob?.result ?? null;
  const hasActiveJob = Boolean(currentJob);

  const stageRows = useMemo(() => {
    const trace = currentDeck?.trace;
    if (!trace) return [];
    return [
      ["01 Intent", trace.intentSource],
      ["01b Template", trace.templateSelectionSource],
      ["02 Evidence", trace.evidenceSource],
      ["03 Narrative", trace.narrativeSource],
      ["04 Design", trace.designSource],
      ["05 Layout", trace.layoutPlanSource],
      ["06 Slots", trace.slotFillSource],
      ["10 Render", trace.renderSource],
      ["11 Verify", trace.verificationSource],
      ["12 Artifacts", trace.auxiliarySource]
    ].filter((row): row is string[] => typeof row[1] === "string" && row[1].length > 0);
  }, [currentDeck]);

  useEffect(() => {
    let cancelled = false;
    const loadTemplates = async () => {
      try {
        const response = await fetch("/api/ppt/projects/templates/catalog", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload)) {
          throw new Error("Template catalog unavailable.");
        }
        if (!cancelled) {
          setTemplates(normalizeV2TemplateCatalog(payload));
        }
      } catch {
        if (!cancelled) {
          setTemplates(V2_TEMPLATE_FALLBACKS);
        }
      }
    };
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await loadJobHistory(cancelled);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activePollJobId) return;
    let cancelled = false;
    const pollJob = async () => {
      try {
        const response = await fetch(`/api/ppt/v2/decks/jobs/${encodeURIComponent(activePollJobId)}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = typeof payload?.message === "string" ? payload.message : "HTML-PPT v2 进度查询失败。";
          const detail = typeof payload?.detail === "string"
            ? payload.detail
            : payload ? JSON.stringify(payload, null, 2) : "";
          throw new Error(detail ? `${message}\n${detail}` : message);
        }
        if (cancelled) return;
        const nextJob = payload as V2DeckJob;
        mergeJob(nextJob);
        setJob(nextJob);
        setDeck(nextJob.result ?? null);
        if (nextJob.status === "completed" || nextJob.status === "failed") {
          setLoading(false);
          setActivePollJobId("");
          void loadJobHistory(false);
        }
        if (nextJob.status === "failed") {
          setError("HTML-PPT v2 生成失败。");
          setErrorDetail(nextJob.error ?? "后台任务失败，但没有返回详细错误。");
        }
      } catch (err) {
        if (cancelled) return;
        setError("HTML-PPT v2 进度查询失败。");
        setErrorDetail(err instanceof Error ? err.message : "无法读取后台任务进度。");
        setLoading(false);
        setActivePollJobId("");
      }
    };
    void pollJob();
    const interval = window.setInterval(() => void pollJob(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePollJobId]);

  async function loadJobHistory(cancelled: boolean) {
    try {
      const response = await fetch("/api/ppt/v2/decks/jobs", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) {
        throw new Error("HTML-PPT v2 历史记录读取失败。");
      }
      if (!cancelled) {
        const nextJobs = payload as V2DeckJob[];
        setJobs(nextJobs);
        if (!selectedJobId && nextJobs[0]) {
          selectJob(nextJobs[0]);
        }
      }
    } catch (err) {
      if (!cancelled) {
        setError("HTML-PPT v2 历史记录读取失败。");
        setErrorDetail(err instanceof Error ? err.message : "无法读取历史记录。");
      }
    } finally {
      if (!cancelled) {
        setHistoryLoading(false);
      }
    }
  }

  function mergeJob(nextJob: V2DeckJob) {
    setJobs((current) => {
      const without = current.filter((item) => item.jobId !== nextJob.jobId);
      return [nextJob, ...without].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    });
  }

  function selectJob(nextJob: V2DeckJob) {
    setSelectedJobId(nextJob.jobId);
    setJob(nextJob);
    setDeck(nextJob.result ?? null);
    setPrompt(nextJob.prompt || DEFAULT_PROMPT);
    const chosenTemplate = nextJob.result?.templateSelection?.chosenTemplateId;
    if (chosenTemplate) {
      setSelectedTemplateId(chosenTemplate);
    }
    if (nextJob.status === "queued" || nextJob.status === "running") {
      setLoading(true);
      setActivePollJobId(nextJob.jobId);
    } else if (activePollJobId === nextJob.jobId) {
      setActivePollJobId("");
    }
  }

  function newProject() {
    setSelectedJobId("");
    setActivePollJobId("");
    setJob(null);
    setDeck(null);
    setPrompt(DEFAULT_PROMPT);
    setError("");
    setErrorDetail("");
    setLoading(false);
    setSelectedTemplateId(V2_RIGHT_PANEL_TEMPLATE_ID);
  }

  async function startDeckJob(input: { prompt: string; templateId: string }) {
    setLoading(true);
    setJob(null);
    setDeck(null);
    setSelectedJobId("");
    setActivePollJobId("");
    setError("");
    setErrorDetail("");
    try {
      const response = await fetch("/api/ppt/v2/decks/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input.prompt, templateId: input.templateId })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof payload?.message === "string" ? payload.message : "HTML-PPT v2 生成失败。";
        const detail = typeof payload?.detail === "string"
          ? payload.detail
          : typeof payload?.error === "string"
            ? payload.error
            : payload ? JSON.stringify(payload, null, 2) : "";
        setErrorDetail(detail);
        throw new Error(message);
      }
      const nextJob = payload as V2DeckJob;
      mergeJob(nextJob);
      setSelectedJobId(nextJob.jobId);
      setJob(nextJob);
      setActivePollJobId(nextJob.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "HTML-PPT v2 生成失败。");
      setLoading(false);
    }
  }

  async function submitPrompt(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    await startDeckJob({ prompt: prompt.trim(), templateId: selectedTemplateId });
  }

  return (
    <main className="v2-page">
      <section className="v2-app-shell">
        <aside className="v2-projects-panel">
          <div className="v2-panel-heading">
            <span>Projects</span>
            <strong>HTML PPT</strong>
          </div>
          <button type="button" className="v2-new-project" onClick={newProject}>
            + 新建项目
          </button>
          <div className="v2-project-list">
            {historyLoading ? <div className="v2-empty-list">正在读取历史记录...</div> : null}
            {!historyLoading && jobs.length === 0 ? <div className="v2-empty-list">暂无历史 Project。</div> : null}
            {jobs.map((item) => {
              const active = item.jobId === selectedJobId;
              return (
                <button
                  key={item.jobId}
                  type="button"
                  className={`v2-project-item${active ? " is-active" : ""}`}
                  onClick={() => selectJob(item)}
                >
                  <span className={`v2-project-status v2-project-status-${item.status}`}>{statusText(item.status)}</span>
                  <strong>{projectTitle(item)}</strong>
                  <small>{formatDate(item.updatedAt)} · {item.modelCalls} calls</small>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="v2-chat-panel">
          <div className="v2-chat-header">
            <div>
              <p className="v2-eyebrow">HTML-PPT v2</p>
              <h1>人机协作生成工作台</h1>
              <span>
                左侧保留历史 Project，中间发送需求并查看 AI 生成进度，右侧选择模板。
              </span>
            </div>
            <div className="v2-current-template">
              <span>当前模板</span>
              <strong>{selectedTemplateLabel}</strong>
            </div>
          </div>

          <div className="v2-conversation">
            {!hasActiveJob ? (
              <div className="v2-assistant-message">
                <span className="v2-avatar">AI</span>
                <div className="v2-message-card">
                  <strong>输入一个 PPT 需求开始生成。</strong>
                  <p>每次提交都会创建一个 Project，并记录到左侧历史列表。生成过程、模型调用次数、失败原因和最终预览都会显示在这里。</p>
                </div>
              </div>
            ) : null}

            {currentJob ? (
              <>
                <div className="v2-user-message">
                  <div className="v2-message-card">
                    <strong>用户需求</strong>
                    <p>{currentJob.prompt}</p>
                  </div>
                  <span className="v2-avatar">You</span>
                </div>
                <div className="v2-assistant-message">
                  <span className="v2-avatar">AI</span>
                  <div className="v2-message-card">
                    <div className="v2-assistant-title">
                      <div>
                        <strong>{currentDeck?.title ?? "后台正在编排 HTML-PPT v2"}</strong>
                        <span>{statusText(currentJob.status)} · {formatDuration(currentJob.elapsedMs)} · {currentJob.modelCalls} model calls</span>
                      </div>
                      {currentDeck ? <span className={`v2-status v2-status-${currentDeck.status}`}>{currentDeck.status}</span> : null}
                    </div>
                    <V2JobProgressPanel job={currentJob} />
                    {currentDeck ? (
                      <>
                        <V2DeckSummary deck={currentDeck} templates={templates} stageRows={stageRows} />
                        <div className="v2-preview-shell">
                          <iframe title="HTML-PPT v2 preview" src={currentDeck.previewUrl} />
                        </div>
                        {currentDeck.screenshots?.length ? (
                          <div className="v2-screenshot-grid">
                            {currentDeck.screenshots.slice(0, 6).map((screenshot) => (
                              <a key={screenshot.url} href={screenshot.url} target="_blank" rel="noreferrer">
                                <img src={screenshot.url} alt={`Slide ${screenshot.slideIndex}`} />
                                <span>Slide {screenshot.slideIndex}</span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    {currentJob.error ? <div className="v2-error-box">{currentJob.error}</div> : null}
                  </div>
                </div>
              </>
            ) : null}

            {error ? (
              <div className="v2-assistant-message">
                <span className="v2-avatar">ERR</span>
                <div className="v2-message-card v2-error-box">
                  <strong>{error}</strong>
                  {errorDetail ? <pre>{errorDetail}</pre> : null}
                </div>
              </div>
            ) : null}
          </div>

          <form className="v2-composer" onSubmit={submitPrompt}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="例如：制作一个8页HTML PPT，主题为可口可乐和百事可乐的品牌竞争，约1200字，使用产品发布模板。"
            />
            <button type="submit" disabled={loading || !prompt.trim()}>
              {loading ? "生成中..." : "发送需求"}
            </button>
          </form>
        </section>

        <aside className="v2-template-panel">
          <div className="v2-panel-heading">
            <span>Templates</span>
            <strong>选择模板</strong>
          </div>
          <p className="v2-template-note">
            横向移动鼠标可预览不同页面，点击卡片即可切换模板。
          </p>
          <div className="v2-template-list">
            {visibleTemplates.map((template) => (
              <V2PinnedTemplateCard
                key={template.id}
                template={template}
                selected={template.id === selectedTemplateId}
                disabled={loading}
                onSelect={() => setSelectedTemplateId(template.id)}
              />
            ))}
          </div>
        </aside>
      </section>

      <style jsx global>{`
        .v2-page {
          min-height: calc(100vh - 76px);
          background:
            radial-gradient(circle at 9% 8%, rgba(8, 116, 107, 0.18), transparent 28%),
            radial-gradient(circle at 85% 12%, rgba(210, 128, 47, 0.15), transparent 30%),
            linear-gradient(135deg, #f6efe2 0%, #f8faf4 48%, #ecf7f4 100%);
          color: #17231f;
          padding: 18px;
        }
        .v2-app-shell {
          display: grid;
          grid-template-columns: 270px minmax(0, 1fr) 390px;
          gap: 16px;
          max-width: 1800px;
          margin: 0 auto;
          height: calc(100vh - 112px);
          min-height: calc(100vh - 112px);
        }
        .v2-projects-panel,
        .v2-chat-panel,
        .v2-template-panel {
          border: 1px solid rgba(23, 35, 31, 0.13);
          border-radius: 28px;
          background: rgba(255, 255, 255, 0.75);
          box-shadow: 0 28px 90px rgba(23, 35, 31, 0.1);
          backdrop-filter: blur(18px);
        }
        .v2-projects-panel,
        .v2-template-panel {
          display: flex;
          flex-direction: column;
          min-height: 0;
          padding: 18px;
        }
        .v2-chat-panel {
          display: grid;
          grid-template-rows: auto 1fr auto;
          min-width: 0;
          min-height: 0;
          height: 100%;
          overflow: hidden;
        }
        .v2-panel-heading {
          display: grid;
          gap: 4px;
          margin-bottom: 14px;
        }
        .v2-panel-heading span,
        .v2-eyebrow {
          margin: 0;
          color: #08746b;
          font-size: 12px;
          font-weight: 950;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        .v2-panel-heading strong {
          font-size: 22px;
          font-weight: 950;
          letter-spacing: -0.04em;
        }
        .v2-new-project,
        .v2-composer button,
        .v2-actions a {
          border: 0;
          border-radius: 999px;
          background: #08746b;
          color: white;
          cursor: pointer;
          font-weight: 950;
          text-decoration: none;
        }
        .v2-new-project {
          padding: 12px 14px;
          margin-bottom: 14px;
          text-align: left;
        }
        .v2-project-list,
        .v2-template-list {
          display: grid;
          align-content: start;
          gap: 10px;
          overflow: auto;
          padding-right: 2px;
        }
        .v2-template-list {
          grid-template-columns: 1fr;
        }
        .v2-project-item,
        .v2-template-card {
          width: 100%;
          border: 1px solid rgba(23, 35, 31, 0.1);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.72);
          color: #17231f;
          cursor: pointer;
          text-align: left;
          transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
        }
        .v2-project-item {
          display: grid;
          gap: 7px;
          padding: 12px;
        }
        .v2-project-item:hover,
        .v2-template-card:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: rgba(8, 116, 107, 0.38);
        }
        .v2-project-item.is-active,
        .v2-template-card.is-active {
          border-color: #08746b;
          background: linear-gradient(180deg, rgba(240, 253, 250, 0.96), rgba(255, 255, 255, 0.82));
          box-shadow: 0 0 0 3px rgba(8, 116, 107, 0.1);
        }
        .v2-project-item strong {
          display: -webkit-box;
          overflow: hidden;
          font-size: 14px;
          line-height: 1.35;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
        }
        .v2-project-item small,
        .v2-template-card small,
        .v2-template-card em,
        .v2-template-note,
        .v2-chat-header span,
        .v2-assistant-title span {
          color: #65746d;
          font-size: 12px;
          font-style: normal;
          font-weight: 750;
          line-height: 1.5;
        }
        .v2-project-status {
          width: max-content;
          border-radius: 999px;
          padding: 4px 8px;
          background: rgba(111, 122, 115, 0.14);
          color: #617069;
          font-size: 11px;
          font-weight: 950;
        }
        .v2-project-status-running,
        .v2-project-status-queued {
          background: rgba(210, 128, 47, 0.16);
          color: #9b5715;
        }
        .v2-project-status-completed {
          background: rgba(8, 116, 107, 0.13);
          color: #08746b;
        }
        .v2-project-status-failed {
          background: rgba(168, 49, 39, 0.14);
          color: #a83127;
        }
        .v2-empty-list {
          border: 1px dashed rgba(23, 35, 31, 0.16);
          border-radius: 18px;
          color: #65746d;
          padding: 14px;
          font-size: 13px;
          font-weight: 800;
          line-height: 1.5;
        }
        .v2-chat-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          border-bottom: 1px solid rgba(23, 35, 31, 0.09);
          padding: 20px 22px;
        }
        .v2-chat-header h1 {
          margin: 3px 0 6px;
          font-size: clamp(26px, 3vw, 42px);
          line-height: 1.02;
          letter-spacing: -0.055em;
        }
        .v2-current-template {
          min-width: 150px;
          border: 1px solid rgba(8, 116, 107, 0.16);
          border-radius: 18px;
          background: rgba(240, 253, 250, 0.72);
          padding: 12px;
          text-align: right;
        }
        .v2-current-template span {
          display: block;
          color: #08746b;
          font-size: 11px;
          font-weight: 950;
        }
        .v2-current-template strong {
          font-size: 16px;
          font-weight: 950;
        }
        .v2-conversation {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
          scrollbar-color: rgba(8, 116, 107, 0.5) rgba(8, 116, 107, 0.08);
          padding: 22px;
        }
        .v2-conversation::-webkit-scrollbar {
          width: 12px;
        }
        .v2-conversation::-webkit-scrollbar-track {
          background: rgba(8, 116, 107, 0.08);
          border-left: 1px solid rgba(23, 35, 31, 0.05);
          border-radius: 999px;
        }
        .v2-conversation::-webkit-scrollbar-thumb {
          border: 3px solid transparent;
          border-radius: 999px;
          background: linear-gradient(180deg, rgba(8, 116, 107, 0.75), rgba(23, 35, 31, 0.55));
          background-clip: padding-box;
          min-height: 56px;
        }
        .v2-conversation::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(8, 116, 107, 0.9), rgba(23, 35, 31, 0.72));
          background-clip: padding-box;
        }
        .v2-user-message,
        .v2-assistant-message {
          display: flex;
          gap: 12px;
          align-items: flex-start;
        }
        .v2-user-message {
          justify-content: flex-end;
        }
        .v2-avatar {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 42px;
          height: 42px;
          flex: 0 0 auto;
          border-radius: 50%;
          background: #17231f;
          color: white;
          font-size: 12px;
          font-weight: 950;
        }
        .v2-user-message .v2-avatar {
          background: #08746b;
        }
        .v2-message-card {
          width: min(100%, 920px);
          border: 1px solid rgba(23, 35, 31, 0.1);
          border-radius: 24px;
          background: rgba(255, 255, 255, 0.78);
          padding: 16px;
          box-shadow: 0 14px 42px rgba(23, 35, 31, 0.08);
        }
        .v2-user-message .v2-message-card {
          max-width: 780px;
          background: rgba(240, 253, 250, 0.9);
        }
        .v2-message-card strong {
          font-weight: 950;
        }
        .v2-message-card p {
          margin: 8px 0 0;
          color: #43524b;
          font-size: 14px;
          font-weight: 700;
          line-height: 1.75;
          white-space: pre-wrap;
        }
        .v2-assistant-title {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        .v2-assistant-title div {
          display: grid;
          gap: 4px;
        }
        .v2-status {
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 950;
          white-space: nowrap;
        }
        .v2-status-clean {
          background: rgba(8, 116, 107, 0.12);
          color: #08746b;
        }
        .v2-status-warning {
          background: rgba(210, 128, 47, 0.16);
          color: #9b5715;
        }
        .v2-status-failed {
          background: rgba(168, 49, 39, 0.14);
          color: #a83127;
        }
        .v2-job-progress {
          border: 1px solid rgba(23, 35, 31, 0.1);
          border-radius: 20px;
          background: rgba(247, 242, 232, 0.52);
          padding: 12px;
        }
        .v2-job-header,
        .v2-job-stage,
        .v2-deck-metrics,
        .v2-stage-row,
        .v2-actions {
          display: flex;
          gap: 10px;
        }
        .v2-job-header {
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
        }
        .v2-job-header h3 {
          margin: 0 0 4px;
          font-size: 15px;
        }
        .v2-job-header p {
          margin: 0;
          color: #65746d;
          font-size: 12px;
          font-weight: 750;
        }
        .v2-job-summary {
          display: grid;
          gap: 4px;
          min-width: 110px;
          color: #08746b;
          font-size: 12px;
          font-weight: 950;
          text-align: right;
        }
        .v2-job-stage-list {
          display: grid;
          gap: 8px;
          max-height: 260px;
          overflow: auto;
          padding-right: 2px;
        }
        .v2-job-stage {
          align-items: flex-start;
          border: 1px solid rgba(23, 35, 31, 0.08);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.62);
          padding: 10px;
        }
        .v2-job-stage-main {
          min-width: 0;
          flex: 1;
        }
        .v2-job-stage-title {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          margin-bottom: 4px;
          font-weight: 950;
        }
        .v2-job-stage-detail,
        .v2-job-stage-failure {
          margin: 0;
          color: #617069;
          font-size: 12px;
          line-height: 1.5;
          word-break: break-word;
        }
        .v2-job-stage-failure {
          margin-top: 6px;
          color: #a83127;
        }
        .v2-job-stage-empty {
          border: 1px dashed rgba(23, 35, 31, 0.14);
          border-radius: 16px;
          color: #65746d;
          padding: 12px;
          font-size: 12px;
          font-weight: 850;
        }
        .v2-job-stage-meta {
          display: grid;
          gap: 4px;
          color: #6f7a73;
          font-size: 11px;
          font-weight: 800;
          text-align: right;
          white-space: nowrap;
        }
        .v2-job-dot {
          width: 10px;
          height: 10px;
          margin-top: 5px;
          border-radius: 999px;
          background: #b9c0bb;
        }
        .v2-job-dot-running {
          background: #d2802f;
          box-shadow: 0 0 0 6px rgba(210, 128, 47, 0.14);
        }
        .v2-job-dot-completed {
          background: #08746b;
        }
        .v2-job-dot-failed {
          background: #a83127;
        }
        .v2-job-badge {
          border-radius: 999px;
          padding: 3px 7px;
          background: rgba(111, 122, 115, 0.12);
          color: #6f7a73;
          font-size: 11px;
          font-weight: 950;
        }
        .v2-job-badge-running {
          background: rgba(210, 128, 47, 0.16);
          color: #9b5715;
        }
        .v2-job-badge-completed {
          background: rgba(8, 116, 107, 0.12);
          color: #08746b;
        }
        .v2-job-badge-failed {
          background: rgba(168, 49, 39, 0.12);
          color: #a83127;
        }
        .v2-deck-summary {
          display: grid;
          gap: 12px;
          margin-top: 14px;
        }
        .v2-deck-metrics {
          flex-wrap: wrap;
        }
        .v2-deck-metrics span,
        .v2-stage-row {
          border: 1px solid rgba(23, 35, 31, 0.09);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.6);
          padding: 9px 10px;
          color: #43524b;
          font-size: 12px;
          font-weight: 850;
        }
        .v2-template-selection {
          border: 1px solid rgba(8, 116, 107, 0.16);
          border-radius: 18px;
          background: rgba(240, 253, 250, 0.72);
          padding: 12px;
        }
        .v2-template-selection-header {
          display: flex;
          justify-content: space-between;
          gap: 10px;
        }
        .v2-template-selection span,
        .v2-template-selection small {
          display: block;
          margin-top: 6px;
          color: #64748b;
          font-size: 12px;
          font-weight: 750;
          line-height: 1.5;
        }
        .v2-template-selection-badge {
          width: max-content;
          border-radius: 999px;
          background: rgba(8, 116, 107, 0.12);
          color: #08746b;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 950;
        }
        .v2-template-shortlist {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }
        .v2-template-shortlist span {
          margin: 0;
          border: 1px solid rgba(8, 116, 107, 0.14);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.72);
          color: #134e4a;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 900;
        }
        .v2-stage-list {
          display: grid;
          gap: 8px;
        }
        .v2-stage-row {
          justify-content: space-between;
        }
        .v2-stage-row strong {
          color: #08746b;
        }
        .v2-actions {
          flex-wrap: wrap;
        }
        .v2-actions a {
          padding: 10px 13px;
          font-size: 13px;
        }
        .v2-actions a:last-child {
          background: #17231f;
        }
        .v2-preview-shell {
          height: min(58vh, 580px);
          overflow: hidden;
          margin-top: 14px;
          border: 1px solid rgba(23, 35, 31, 0.13);
          border-radius: 20px;
          background: white;
          padding: 8px;
        }
        .v2-preview-shell iframe {
          width: 100%;
          height: 100%;
          border: 0;
          border-radius: 14px;
          background: white;
        }
        .v2-screenshot-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 10px;
          margin-top: 14px;
        }
        .v2-screenshot-grid a {
          display: grid;
          gap: 7px;
          border: 1px solid rgba(23, 35, 31, 0.1);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.66);
          padding: 7px;
          color: #17231f;
          text-decoration: none;
          font-size: 12px;
          font-weight: 950;
        }
        .v2-screenshot-grid img {
          width: 100%;
          aspect-ratio: 16 / 9;
          border-radius: 10px;
          object-fit: cover;
          background: #fff;
        }
        .v2-error-box {
          border-color: rgba(168, 49, 39, 0.22);
          background: rgba(168, 49, 39, 0.06);
          color: #8d332c;
        }
        .v2-error-box pre {
          max-height: 220px;
          overflow: auto;
          margin: 10px 0 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 12px;
          line-height: 1.5;
        }
        .v2-composer {
          position: sticky;
          bottom: 0;
          z-index: 5;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          border-top: 1px solid rgba(23, 35, 31, 0.09);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.98));
          box-shadow: 0 -16px 34px rgba(23, 35, 31, 0.08);
          padding: 16px;
          flex-shrink: 0;
        }
        .v2-composer textarea {
          resize: vertical;
          min-height: 82px;
          max-height: 220px;
          border: 1px solid rgba(23, 35, 31, 0.14);
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.9);
          color: #17231f;
          font-size: 14px;
          font-weight: 750;
          line-height: 1.65;
          outline: none;
          padding: 13px 15px;
        }
        .v2-composer textarea:focus {
          border-color: #08746b;
          box-shadow: 0 0 0 3px rgba(8, 116, 107, 0.11);
        }
        .v2-composer button {
          align-self: end;
          padding: 14px 18px;
        }
        .v2-composer button:disabled,
        .v2-template-card:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }
        .v2-template-note {
          margin: -4px 0 14px;
        }
        .v2-template-card {
          display: grid;
          gap: 10px;
          padding: 14px;
        }
        .v2-template-card.is-single {
          position: relative;
          display: block;
          min-height: 180px;
          overflow: hidden;
          padding: 0;
          background: #fff;
        }
        .v2-template-card.is-single::before {
          content: "";
          display: block;
          width: 100%;
          padding-top: 56.25%;
        }
        .v2-template-preview-frame {
          position: absolute;
          inset: 0;
          z-index: 1;
          overflow: hidden;
          border-radius: inherit;
          background: #fff;
          contain: strict;
        }
        .v2-template-preview-empty {
          display: grid;
          height: 100%;
          place-items: center;
          padding: 20px;
          background:
            radial-gradient(circle at 75% 28%, rgba(255, 90, 54, 0.2), transparent 36%),
            linear-gradient(135deg, #fff8f2, #ffffff 52%, #f4fbf8);
          color: rgba(23, 35, 31, 0.62);
          font-size: 12px;
          font-weight: 850;
          line-height: 1.5;
          text-align: center;
        }
        .v2-template-preview-host {
          position: absolute;
          inset: 0;
          overflow: hidden;
          contain: strict;
        }
        .v2-template-page-rail {
          position: absolute;
          top: 10px;
          left: 12px;
          right: 12px;
          z-index: 3;
          display: flex;
          gap: 4px;
          pointer-events: none;
        }
        .v2-template-page-dot {
          height: 3px;
          flex: 1 1 0;
          border-radius: 999px;
          background: rgba(10, 10, 18, 0.2);
          box-shadow: 0 1px 4px rgba(255, 255, 255, 0.3);
        }
        .v2-template-page-dot.is-active {
          background: #ff5a36;
        }
        .v2-template-emoji {
          width: max-content;
          border-radius: 999px;
          background: rgba(8, 116, 107, 0.09);
          color: #08746b;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 950;
          letter-spacing: 0.06em;
        }
        .v2-template-card strong {
          font-size: 15px;
          font-weight: 950;
        }
        .v2-template-card small {
          color: rgba(23, 35, 31, 0.66);
          font-size: 13px;
          font-weight: 720;
          line-height: 1.55;
        }
        .v2-template-card em {
          color: rgba(23, 35, 31, 0.48);
          font-size: 11px;
          font-style: normal;
          font-weight: 850;
        }
        .v2-template-status {
          width: max-content;
          border-radius: 999px;
          background: #08746b;
          color: white;
          padding: 7px 10px;
          font-size: 12px;
          font-weight: 950;
        }
        @media (max-width: 1180px) {
          .v2-app-shell {
            height: auto;
            grid-template-columns: 240px minmax(0, 1fr);
          }
          .v2-template-panel {
            grid-column: 1 / -1;
            max-height: 360px;
          }
          .v2-template-list {
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          }
        }
        @media (max-width: 820px) {
          .v2-page {
            padding: 10px;
          }
          .v2-app-shell {
            height: auto;
            grid-template-columns: 1fr;
          }
          .v2-projects-panel {
            max-height: 320px;
          }
          .v2-chat-header,
          .v2-composer {
            grid-template-columns: 1fr;
            display: grid;
          }
          .v2-current-template {
            text-align: left;
          }
          .v2-preview-shell {
            height: 52vh;
          }
        }
      `}</style>
    </main>
  );
}

function V2DeckSummary({
  deck,
  templates,
  stageRows
}: {
  deck: V2DeckResponse;
  templates: V2TemplateOption[];
  stageRows: string[][];
}) {
  return (
    <div className="v2-deck-summary">
      <div className="v2-deck-metrics">
        <span>{deck.verification?.slideCount ?? "-"} slides</span>
        <span>{deck.verification?.hardIssueCount ?? 0} hard issues</span>
        <span>{deck.verification?.warningCount ?? 0} warnings</span>
        <span>{deck.verification?.mode ?? "static"} verify</span>
      </div>
      <V2TemplateSelectionPanel selection={deck.templateSelection ?? deck.trace?.templateSelection} templates={templates} />
      <div className="v2-stage-list">
        {stageRows.map(([label, value]) => (
          <div key={label} className="v2-stage-row">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="v2-actions">
        <a href={deck.downloadUrl}>下载 zip</a>
        <a href={deck.manifestUrl} target="_blank" rel="noreferrer">查看 manifest</a>
        <a href={deck.verificationReportUrl} target="_blank" rel="noreferrer">校验报告</a>
      </div>
    </div>
  );
}

function V2PinnedTemplateCard({
  template,
  selected,
  disabled,
  onSelect
}: {
  template: V2TemplateOption;
  selected: boolean;
  disabled: boolean;
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
      className={`v2-template-card is-single${selected ? " is-active" : ""}`}
      disabled={disabled}
      onClick={onSelect}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setSlideIndex(0)}
      title={template.label}
      aria-label={`${template.label} template preview`}
    >
      <div className="v2-template-preview-frame" aria-hidden="true">
        {slides.length ? (
          <V2TemplateSlidePreview
            html={slides[activeSlideIndex] ?? slides[0] ?? ""}
            css={template.previewCss ?? ""}
            deckClass={template.deckClass}
            viewport={viewport}
          />
        ) : (
          <div className="v2-template-preview-empty">模板预览加载中</div>
        )}
      </div>
      {slides.length ? (
        <div className="v2-template-page-rail" aria-hidden="true">
          {slides.map((_, index) => (
            <span
              key={`${template.id}-page-${index}`}
              className={`v2-template-page-dot${index === activeSlideIndex ? " is-active" : ""}`}
            />
          ))}
        </div>
      ) : null}
    </button>
  );
}

function V2TemplateSlidePreview({
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
    shadowRef.current.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: white;
          contain: strict;
        }
        .preview-stage {
          position: absolute;
          top: 50%;
          left: 50%;
          width: ${viewport.width}px;
          height: ${viewport.height}px;
          overflow: hidden;
          background: white;
          transform: translate(-50%, -50%) scale(${scale});
          transform-origin: center center;
          pointer-events: none;
        }
        .preview-stage .deck {
          position: relative;
          width: ${viewport.width}px;
          height: ${viewport.height}px;
          overflow: hidden;
          background: white;
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
          width: ${viewport.width}px !important;
          height: ${viewport.height}px !important;
          min-width: ${viewport.width}px !important;
          max-width: ${viewport.width}px !important;
          min-height: ${viewport.height}px !important;
          max-height: ${viewport.height}px !important;
          margin: 0 !important;
          overflow: hidden !important;
          transform: none !important;
        }
      </style>
      <div class="preview-stage">
        <div class="${deckClass ?? ""}">
          <div class="deck">${html}</div>
        </div>
      </div>
    `;
  }, [html, css, deckClass, scale, viewport.height, viewport.width]);

  return <div ref={containerRef} className="v2-template-preview-host" />;
}

function V2TemplateSelectionPanel({
  selection,
  templates
}: {
  selection?: V2TemplateSelection;
  templates: V2TemplateOption[];
}) {
  if (!selection) return null;
  const chosenName = templateLabel(selection.chosenTemplateId, templates);
  const shortlist = selection.shortlist.length ? selection.shortlist : [selection.chosenTemplateId];
  const isAuto = selection.mode !== "pinned";
  return (
    <div className="v2-template-selection">
      <div className="v2-template-selection-header">
        <strong>
          {isAuto ? "Template auto-selected" : "Template pinned"}: {chosenName}
        </strong>
        <span className="v2-template-selection-badge">{templateSelectionModeLabel(selection.mode)}</span>
      </div>
      <span>
        {isAuto
          ? `Template auto-selected: ${chosenName} — ${selection.rationale}`
          : selection.rationale}
      </span>
      <small>confidence={selection.confidence}; chosen={selection.chosenTemplateId}</small>
      <div className="v2-template-shortlist" aria-label="Template shortlist">
        {shortlist.map((id) => (
          <span key={id}>{templateLabel(id, templates)}</span>
        ))}
      </div>
    </div>
  );
}

function V2JobProgressPanel({ job }: { job: V2DeckJob }) {
  const visibleStages = job.stages.filter((stage) => stage.status !== "pending" || Boolean(stage.startedAt));
  return (
    <div className="v2-job-progress">
      <div className="v2-job-header">
        <div>
          <h3>实时生成进度</h3>
          <p>后台任务 {job.jobId.slice(0, 8)} · {statusText(job.status)}</p>
        </div>
        <div className="v2-job-summary">
          <span>{formatDuration(job.elapsedMs)}</span>
          <span>{job.modelCalls} model calls</span>
        </div>
      </div>
      <div className="v2-job-stage-list">
        {visibleStages.length ? (
          visibleStages.map((stage) => {
            const meta = V2_STAGE_META[stage.id] ?? { purpose: stage.detail || "执行生成步骤", usesModel: stage.modelCalls > 0 };
            return (
              <div key={stage.id} className="v2-job-stage">
                <span className={`v2-job-dot v2-job-dot-${stage.status}`} />
                <div className="v2-job-stage-main">
                  <div className="v2-job-stage-title">
                    <span>{stage.name}</span>
                    <span className={`v2-job-badge v2-job-badge-${stage.status}`}>
                      {statusText(stage.status)}
                    </span>
                  </div>
                  <p className="v2-job-stage-detail">
                    {meta.purpose} · {meta.usesModel ? "调用模型" : "本地执行"}
                  </p>
                  {stage.failureReason ? (
                    <div className="v2-job-stage-failure">失败原因：{stage.failureReason}</div>
                  ) : null}
                </div>
                <div className="v2-job-stage-meta">
                  <span>{formatDuration(stage.elapsedMs)}</span>
                  <span>{stage.modelCalls} calls</span>
                </div>
              </div>
            );
          })
        ) : (
          <div className="v2-job-stage-empty">任务已创建，等待第一个阶段开始。</div>
        )}
      </div>
    </div>
  );
}

function templateSelectionModeLabel(mode: V2TemplateSelection["mode"]) {
  if (mode === "pinned") return "pinned";
  if (mode === "auto-llm") return "auto-llm";
  return "auto-deterministic";
}

function templateLabel(id: string, templates: V2TemplateOption[]) {
  return templates.find((template) => template.id === id)?.label ?? id;
}

function templatePreviewViewport(template: V2TemplateOption) {
  if (template.aspectRatio === "3:4" || template.rendererProfile === "social-portrait") {
    return { width: 960, height: 1280 };
  }
  return { width: 1280, height: 720 };
}

function projectTitle(job: V2DeckJob) {
  return job.result?.title ?? promptSummary(job.prompt);
}

function promptSummary(input: string) {
  const text = input.replace(/\s+/g, " ").trim();
  return text.length > 44 ? `${text.slice(0, 44)}...` : text || "Untitled Project";
}

function statusText(status: V2DeckJob["status"] | V2DeckJobStage["status"]) {
  const labels: Record<string, string> = {
    queued: "排队中",
    pending: "等待",
    running: "执行中",
    completed: "完成",
    failed: "失败"
  };
  return labels[status] ?? status;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
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
