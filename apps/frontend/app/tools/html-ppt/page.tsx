'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type {
  PptDeckRender,
  PptDeckSpec,
  PptGenerationOrchestration,
  PptMessageDto,
  PptProjectSummary,
} from '../../../lib/types';

/* ─── Types ─────────────────────────────────────────────── */
interface Project {
  id: string;
  name: string;
  createdAt: Date;
  messages: Message[];
  template?: string | null;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  files?: AttachedFile[];
  template?: {
    id: string;
    label: string;
    description: string;
  };
  deckSpec?: PptDeckSpec;
  deckRender?: PptDeckRender;
  orchestration?: PptGenerationOrchestration;
  ts: Date;
}

interface AttachedFile {
  name: string;
  type: string;
  size: number;
}

interface PptConversationResponse {
  project: PptProjectSummary;
  messages: PptMessageDto[];
}

/* ─── Template catalog (mirrors skill full-decks) ────────── */
const TEMPLATES = [
  { id: 'pitch-deck',             label: 'Pitch Deck',           emoji: 'VC', desc: '投资人路演 / VC风格' },
  { id: 'product-launch',         label: 'Product Launch',       emoji: 'PL', desc: '产品发布会' },
  { id: 'tech-sharing',           label: 'Tech Sharing',         emoji: 'TS', desc: '技术分享 / 工程师风格' },
  { id: 'weekly-report',          label: 'Weekly Report',        emoji: 'WR', desc: '周报 / 数据汇报' },
  { id: 'xhs-post',               label: '小红书图文',             emoji: 'XHS', desc: '9页 / 3:4比例' },
  { id: 'course-module',          label: 'Course Module',        emoji: 'EDU', desc: '教学模块' },
  { id: 'presenter-mode-reveal',  label: 'Presenter Mode',       emoji: 'PM', desc: '带逐字稿 · 演讲者模式' },
  { id: 'xhs-white-editorial',    label: 'XHS White Editorial',  emoji: 'WE', desc: '小红书白底杂志风' },
  { id: 'graphify-dark-graph',    label: 'Graphify Dark',        emoji: 'GD', desc: '暗底知识图谱' },
  { id: 'knowledge-arch-blueprint', label: 'Blueprint',          emoji: 'BP', desc: '蓝图 / 架构图风' },
  { id: 'hermes-cyber-terminal',  label: 'Cyber Terminal',       emoji: 'CT', desc: '终端 Cyberpunk 风' },
  { id: 'obsidian-claude-gradient', label: 'Obsidian Gradient', emoji: 'OG', desc: '紫色渐变卡' },
  { id: 'xhs-pastel-card',        label: 'XHS Pastel',          emoji: 'XP', desc: '柔和马卡龙图文' },
  { id: 'dir-key-nav-minimal',    label: 'Minimal Nav',         emoji: 'NAV', desc: '方向键极简' },
  { id: 'testing-safety-alert',   label: 'Safety Alert',        emoji: 'SA', desc: '红色警示风格' },
];

const ACCEPTED_TYPES = '.docx,.pptx,.ppt,.txt,.md,.pdf';

/* ─── Helpers ─────────────────────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2); }
function fmt(size: number) {
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtDuration(
  startedAt: string,
  endedAt: string,
  status?: PptGenerationOrchestration['steps'][number]['status']
) {
  const start = new Date(startedAt).getTime();
  const end = status === 'running' ? Date.now() : new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '--';
  }

  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function orchestrationStatusLabel(status: PptGenerationOrchestration['steps'][number]['status']) {
  if (status === 'running') return '进行中';
  if (status === 'completed') return '完成';
  if (status === 'timeout') return '超时';
  if (status === 'failed') return '失败';
  return '跳过';
}

function orchestrationStatusStyle(status: PptGenerationOrchestration['steps'][number]['status']) {
  if (status === 'running') {
    return { background: 'rgba(14,116,144,0.12)', color: '#0e7490' };
  }

  if (status === 'completed') {
    return { background: 'rgba(22,163,74,0.12)', color: '#15803d' };
  }

  if (status === 'timeout') {
    return { background: 'rgba(245,158,11,0.16)', color: '#b45309' };
  }

  if (status === 'failed') {
    return { background: 'rgba(220,38,38,0.12)', color: '#b91c1c' };
  }

  return { background: 'rgba(107,114,128,0.16)', color: '#4b5563' };
}

function canResumeOrchestration(orchestration?: PptGenerationOrchestration) {
  const lastStep = orchestration?.steps.at(-1);
  return Boolean(lastStep && (lastStep.status === 'failed' || lastStep.status === 'timeout'));
}

function visibleMessageContent(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim() || content;
}

function sanitizeProjectName(name: string, fallback = 'HTML-PPT Project') {
  const value = name.trim();
  if (!value || /^\?+$/.test(value)) {
    return fallback;
  }

  return value;
}

function readErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  ) {
    return payload.message;
  }

  return fallback;
}

async function requestJson<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
  }).catch(() => null);

  if (!response) {
    throw new Error('服务暂时不可用。');
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload, '请求失败。'));
  }

  return payload as T;
}

function mapProjectSummary(summary: PptProjectSummary): Project {
  return {
    id: summary.id,
    name: sanitizeProjectName(summary.name),
    createdAt: new Date(summary.createdAt),
    messages: [],
    template: summary.templateId,
  };
}

function mergeProjectSummary(project: Project, summary: PptProjectSummary): Project {
  return {
    ...project,
    name: sanitizeProjectName(summary.name, project.name),
    createdAt: new Date(summary.createdAt),
    template: summary.templateId,
  };
}

function mapMessageDto(message: PptMessageDto): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    files: message.files.length > 0 ? [...message.files] : undefined,
    template: message.template ?? undefined,
    deckSpec: message.deckSpec,
    deckRender: message.deckRender,
    orchestration: message.orchestration,
    ts: new Date(message.createdAt),
  };
}

function nextProjectName(projects: Project[]) {
  const maxProjectNumber = projects.reduce((max, project) => {
    const match = project.name.match(/^Project\s+(\d+)$/i);
    if (!match) {
      return max;
    }

    return Math.max(max, Number.parseInt(match[1] ?? '0', 10));
  }, 0);

  return `Project ${maxProjectNumber + 1}`;
}

/* ─── Component ──────────────────────────────────────────── */
export default function HtmlPptPage() {
  /* Projects */
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [bootstrapping, setBootstrapping] = useState(true);
  const [requestError, setRequestError] = useState('');

  /* Chat */
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [resumingMessageId, setResumingMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* Template selector */
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const templateSectionRef = useRef<HTMLDivElement>(null);

  /* Sidebar */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /* ── Derived ── */
  const active = projects.find(p => p.id === activeId) ?? null;
  const hasLiveAssistantProgress = Boolean(
    active?.messages.some(message => {
      const lastStep = message.orchestration?.steps.at(-1);
      return message.role === 'assistant' && !message.deckRender && lastStep?.status === 'running';
    })
  );

  /* ── Scroll to bottom ── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [active?.messages.length, loading]);

  useEffect(() => {
    const html = document.documentElement;
    const previousHtmlOverflow = html.style.overflow;
    const previousHtmlHeight = html.style.height;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyHeight = document.body.style.height;
    const previousBodyPosition = document.body.style.position;
    const previousBodyInset = document.body.style.inset;
    const previousBodyWidth = document.body.style.width;

    html.style.overflow = 'hidden';
    html.style.height = '100%';
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    document.body.style.position = 'fixed';
    document.body.style.inset = '0';
    document.body.style.width = '100%';
    document.body.classList.add('html-ppt-route');

    return () => {
      html.style.overflow = previousHtmlOverflow;
      html.style.height = previousHtmlHeight;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.height = previousBodyHeight;
      document.body.style.position = previousBodyPosition;
      document.body.style.inset = previousBodyInset;
      document.body.style.width = previousBodyWidth;
      document.body.classList.remove('html-ppt-route');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setBootstrapping(true);
      setRequestError('');

      try {
        let summaries = await requestJson<PptProjectSummary[]>('/api/ppt/projects');
        if (!summaries.length) {
          const initialProject = await requestJson<PptProjectSummary>('/api/ppt/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: 'My First Deck',
              templateId: 'pitch-deck',
            }),
          });
          summaries = [initialProject];
        }

        if (cancelled) return;

        const mapped = summaries.map(mapProjectSummary);
        const nextActiveId = mapped[0]?.id ?? null;
        setProjects(mapped);
        setActiveId(nextActiveId);
        setSelectedTemplate(mapped[0]?.template ?? null);
      } catch (error) {
        if (cancelled) return;
        setRequestError(error instanceof Error ? error.message : '初始化 HTML-PPT 工作台失败。');
      } finally {
        if (!cancelled) {
          setBootstrapping(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeId) {
      return;
    }

    let cancelled = false;

    const loadMessages = async () => {
      try {
        const messages = await requestJson<PptMessageDto[]>(`/api/ppt/projects/${encodeURIComponent(activeId)}/messages`);
        if (cancelled) return;

        setProjects(prev =>
          prev.map(project =>
            project.id === activeId
              ? { ...project, messages: messages.map(mapMessageDto) }
              : project
          )
        );
      } catch (error) {
        if (cancelled) return;
        setRequestError(error instanceof Error ? error.message : '加载项目消息失败。');
      }
    };

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (!activeId || (!loading && !resumingMessageId && !hasLiveAssistantProgress)) {
      return;
    }

    let cancelled = false;

    const pollMessages = async () => {
      try {
        const messages = await requestJson<PptMessageDto[]>(`/api/ppt/projects/${encodeURIComponent(activeId)}/messages`);
        if (cancelled) return;

        setProjects(prev =>
          prev.map(project =>
            project.id === activeId
              ? { ...project, messages: messages.map(mapMessageDto) }
              : project
          )
        );
      } catch {
        // The pending POST owns the user-visible error; polling should stay quiet.
      }
    };

    void pollMessages();
    const interval = window.setInterval(() => void pollMessages(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeId, loading, resumingMessageId, hasLiveAssistantProgress]);

  useEffect(() => {
    setSelectedTemplate(active?.template ?? null);
  }, [active?.id, active?.template]);

  /* ── Auto-grow textarea ── */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [input]);

  /* ── Project ops ── */
  const createProject = useCallback(async () => {
    setRequestError('');

    try {
      const summary = await requestJson<PptProjectSummary>('/api/ppt/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: nextProjectName(projects),
        }),
      });

      const project = mapProjectSummary(summary);
      setProjects(prev => [project, ...prev]);
      setActiveId(project.id);
      setSelectedTemplate(project.template ?? null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '创建项目失败。');
    }
  }, [projects.length]);

  const deleteProject = useCallback(async (id: string) => {
    setRequestError('');

    try {
      await requestJson<{ success: boolean }>(`/api/ppt/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });

      const remaining = projects.filter(project => project.id !== id);
      setProjects(remaining);

      if (!remaining.length) {
        setActiveId(null);
        setSelectedTemplate(null);
        await createProject();
        return;
      }

      if (activeId === id) {
        setActiveId(remaining[0]?.id ?? null);
        setSelectedTemplate(remaining[0]?.template ?? null);
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '删除项目失败。');
    }
  }, [activeId, createProject, projects]);

  const renameProject = useCallback(async (id: string, name: string) => {
    const normalizedName = name.trim();
    setEditingId(null);

    if (!normalizedName) {
      return;
    }

    setRequestError('');

    try {
      const summary = await requestJson<PptProjectSummary>(`/api/ppt/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: normalizedName }),
      });

      setProjects(prev =>
        prev.map(project =>
          project.id === id ? mergeProjectSummary(project, summary) : project
        )
      );
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '重命名项目失败。');
    }
  }, []);

  const applyTemplate = useCallback(async (templateId: string) => {
    if (!activeId) {
      return;
    }

    setRequestError('');
    setSelectedTemplate(templateId);

    try {
      const summary = await requestJson<PptProjectSummary>(`/api/ppt/projects/${encodeURIComponent(activeId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ templateId }),
      });

      setProjects(prev =>
        prev.map(project =>
          project.id === activeId ? mergeProjectSummary(project, summary) : project
        )
      );
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '切换模板失败。');
    }
  }, [activeId]);

  /* ── File attach ── */
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    const newFiles: AttachedFile[] = picked.map(f => ({ name: f.name, type: f.type, size: f.size }));
    setFiles(prev => [...prev, ...newFiles]);
    e.target.value = '';
  };

  const removeFile = (i: number) => setFiles(prev => prev.filter((_, j) => j !== i));

  /* ── Send message ── */
  const send = useCallback(async () => {
    if (!activeId || !active || hasLiveAssistantProgress || (!input.trim() && !files.length)) return;

    const messageText = input.trim();
    const pendingFiles = [...files];
    const template = active.template
      ? TEMPLATES.find(t => t.id === active.template) ?? {
          id: active.template,
          label: active.template,
          emoji: 'TPL',
          desc: '',
        }
      : null;

    const userMsg: Message = {
      id: uid(), role: 'user', content: messageText,
      files: pendingFiles.length ? pendingFiles : undefined,
      template: template
        ? {
            id: template.id,
            label: template.label,
            description: template.desc,
          }
        : undefined,
      ts: new Date(),
    };

    setProjects(prev => prev.map(p => p.id === activeId ? { ...p, messages: [...p.messages, userMsg] } : p));
    setInput('');
    setFiles([]);
    setLoading(true);
    setRequestError('');

    try {
      const response = await requestJson<PptConversationResponse>(`/api/ppt/projects/${encodeURIComponent(activeId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: messageText,
          files: pendingFiles,
          template: template
            ? {
                id: template.id,
                label: template.label,
                description: template.desc,
              }
            : null,
        }),
      });

      setProjects(prev =>
        prev.map(project =>
          project.id === activeId
            ? {
                ...mergeProjectSummary(project, response.project),
                messages: response.messages.map(mapMessageDto),
              }
            : project
        )
      );
      setSelectedTemplate(response.project.templateId ?? null);
    } catch (error) {
      setProjects(prev =>
        prev.map(project =>
          project.id === activeId
            ? {
                ...project,
                messages: project.messages.filter(message => message.id !== userMsg.id),
              }
            : project
        )
      );
      setInput(messageText);
      setFiles(pendingFiles);
      setRequestError(error instanceof Error ? error.message : '发送消息失败。');
    } finally {
      setLoading(false);
    }
  }, [input, files, activeId, active, hasLiveAssistantProgress]);

  const resumeGeneration = useCallback(async (messageId: string) => {
    if (!activeId || resumingMessageId) {
      return;
    }

    setResumingMessageId(messageId);
    setRequestError('');

    try {
      const response = await requestJson<PptConversationResponse>(
        `/api/ppt/projects/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(messageId)}/resume`,
        { method: 'POST' }
      );

      setProjects(prev =>
        prev.map(project =>
          project.id === activeId
            ? {
                ...mergeProjectSummary(project, response.project),
                messages: response.messages.map(mapMessageDto),
              }
            : project
        )
      );
      setSelectedTemplate(response.project.templateId ?? null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '继续生成失败。');
    } finally {
      setResumingMessageId(null);
    }
  }, [activeId, resumingMessageId]);

  const focusTemplateSelector = () => {
    return;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  /* ──────────────────────────────────────────────────────── */
  return (
    <div style={styles.root}>
      {/* ══ LEFT SIDEBAR ══════════════════════════════════════ */}
      <aside style={{ ...styles.sidebar, width: sidebarCollapsed ? 64 : 260 }}>
        {/* Header */}
        <div style={styles.sidebarHeader}>
          {!sidebarCollapsed && (
            <span style={styles.sidebarTitle}>
              <span style={styles.sidebarTitleIcon}>PPT</span> HTML PPT
            </span>
          )}
          <button style={styles.iconBtn} onClick={() => setSidebarCollapsed(c => !c)} title="折叠侧栏">
            {sidebarCollapsed ? '>' : '<'}
          </button>
        </div>

        {/* New project button */}
          <button style={{ ...styles.newProjectBtn, justifyContent: sidebarCollapsed ? 'center' : 'flex-start' }}
            onClick={createProject} title="新建项目">
          <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
          {!sidebarCollapsed && <span>新建项目</span>}
        </button>

        {/* Project list */}
        <div style={styles.projectList}>
          {projects.map(p => (
            <div key={p.id}
              style={{ ...styles.projectItem, background: p.id === activeId ? 'rgba(26,115,232,0.08)' : 'transparent', borderColor: p.id === activeId ? 'rgba(26,115,232,0.2)' : 'transparent' }}
              onClick={() => setActiveId(p.id)}>
              {editingId === p.id ? (
                <input autoFocus style={styles.renameInput}
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onBlur={() => renameProject(p.id, editName || p.name)}
                  onKeyDown={e => { if (e.key === 'Enter') renameProject(p.id, editName || p.name); if (e.key === 'Escape') setEditingId(null); }}
                  onClick={e => e.stopPropagation()} />
              ) : (
                <>
                  <span style={styles.projectIcon}>P</span>
                  {!sidebarCollapsed && (
                    <span style={styles.projectName} title={p.name}>{p.name}</span>
                  )}
                  {!sidebarCollapsed && p.id === activeId && (
                    <div style={styles.projectActions}>
                      <button style={styles.actionBtn} title="重命名"
                        onClick={e => { e.stopPropagation(); setEditingId(p.id); setEditName(p.name); }}>改</button>
                      <button style={{ ...styles.actionBtn, color: '#ea4335' }} title="删除"
                        onClick={e => { e.stopPropagation(); if (confirm('确认删除此项目？')) void deleteProject(p.id); }}>删</button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>

        {/* Template badge */}
        {!sidebarCollapsed && active?.template && (
          <div style={styles.tplBadge}>
            <span>{TEMPLATES.find(t => t.id === active.template)?.emoji}</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {TEMPLATES.find(t => t.id === active.template)?.label}
            </span>
            <button style={{ ...styles.actionBtn, fontSize: 10 }} title="更换模板" onClick={focusTemplateSelector}>换</button>
          </div>
        )}

        {/* Hint */}
        {!sidebarCollapsed && (
          <div style={styles.sidebarHint}>
            模板选择区位于<br />输入框下方
          </div>
        )}
      </aside>

      {/* ══ MAIN ════════════════════════════════════════════════ */}
      <div style={styles.mainWrap}>

        {/* ── Chat header ── */}
        <div style={styles.chatHeader}>
          <div>
            <div style={styles.chatTitle}>{active?.name ?? '-'}</div>
            {active?.template && (
              <span style={styles.chatSubtitle}>
                {TEMPLATES.find(t => t.id === active.template)?.emoji}&nbsp;
                {TEMPLATES.find(t => t.id === active.template)?.label}
              </span>
            )}
          </div>
          <button style={styles.ghostBtn} onClick={focusTemplateSelector}>
            选择模板
          </button>
        </div>

        <div style={styles.mainScrollArea}>
          {requestError ? (
            <div style={styles.errorBanner}>{requestError}</div>
          ) : null}

          {/* ── Messages ── */}
          <div style={styles.messages}>
          {bootstrapping && !active ? (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>⏳</div>
              <div style={styles.emptyTitle}>正在加载 HTML-PPT 项目</div>
              <div style={styles.emptyHint}>稍候，正在同步项目列表和会话记录。</div>
            </div>
          ) : active?.messages.length === 0 ? (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>HTML</div>
              <div style={styles.emptyTitle}>开始创建你的 HTML 幻灯片</div>
              <div style={styles.emptyHint}>
                描述你的 PPT 主题，或上传 docx / pptx / md 文件，\nAI 将为你生成专业的 HTML 演示文稿。
              </div>
              <div style={styles.emptyTips}>
                {['技术分享：介绍 React Server Components 的原理', '投资人路演：新能源汽车 SaaS 平台', '小红书：2026 年春季穿搭指南'].map(tip => (
                  <button key={tip} style={styles.tipBtn} onClick={() => setInput(tip)}>{tip}</button>
                ))}
              </div>
              <div style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)', opacity: 0.6 }}>
                提示：输入区下方可以直接切换模板
              </div>
            </div>
          ) : null}

          {active?.messages.map(msg => (
            <div key={msg.id} style={{ ...styles.msgRow, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
              <div style={{ ...styles.msgAvatar, background: msg.role === 'user' ? 'var(--accent)' : '#f0f4ff' }}>
                {msg.role === 'user' ? '我' : 'AI'}
              </div>
              <div style={{ maxWidth: '70%' }}>
                {msg.template && (
                  <div style={styles.filePillsRow}>
                    <span style={styles.templatePill}>
                      模板：{msg.template.label}
                    </span>
                  </div>
                )}
                {msg.files && msg.files.length > 0 && (
                  <div style={styles.filePillsRow}>
                    {msg.files.map((f, i) => (
                      <span key={i} style={styles.filePill}>文件：{f.name} <span style={{ opacity: 0.6 }}>{fmt(f.size)}</span></span>
                    ))}
                  </div>
                )}
                <div style={{ ...styles.msgBubble, background: msg.role === 'user' ? 'var(--accent)' : 'white', color: msg.role === 'user' ? 'white' : 'var(--ink)', alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  {visibleMessageContent(msg.content).split('\n').map((line, i) => (
                    <span key={i}>{line.replace(/\*\*(.*?)\*\*/g, '$1')}<br /></span>
                  ))}
                </div>
                {msg.role === 'assistant' && msg.deckRender && (
                  <div style={styles.deckPreviewCard}>
                    <div style={styles.deckPreviewHeader}>
                      <div>
                        <div style={styles.deckPreviewTitle}>{msg.deckRender.title}</div>
                        <div style={styles.deckPreviewMeta}>
                          {msg.deckSpec?.template ?? 'HTML-PPT'} · {msg.deckSpec?.theme ?? 'theme'} · {msg.deckSpec?.slides.length ?? 0} 页
                        </div>
                        {msg.orchestration && (
                          <div style={styles.orchestrationMeta}>
                            编排器：{msg.orchestration.model} · {msg.orchestration.totalModelCalls} 次模型调用 · {msg.orchestration.steps.length} 步
                          </div>
                        )}
                      </div>
                      <div style={styles.deckPreviewActions}>
                        <a style={styles.deckActionLink} href={msg.deckRender.previewUrl} target="_blank" rel="noreferrer">预览</a>
                        <a style={styles.deckActionLink} href={msg.deckRender.downloadUrl}>下载</a>
                      </div>
                    </div>
                    {msg.orchestration && msg.orchestration.steps.length > 0 && (
                      <div style={styles.orchestrationPanel}>
                        {msg.orchestration.steps.map((step) => (
                          <div key={step.id} style={styles.orchestrationRow}>
                          <span style={{
                            ...styles.orchestrationStatus,
                              ...orchestrationStatusStyle(step.status),
                          }}>
                              {orchestrationStatusLabel(step.status)}
                            </span>
                            <div style={styles.orchestrationBody}>
                              <div style={styles.orchestrationTitle}>{step.name}</div>
                              <div style={styles.orchestrationDetail}>{step.detail}</div>
                            </div>
                            <span style={styles.orchestrationDuration}>
                              {fmtDuration(step.startedAt, step.endedAt, step.status)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <iframe
                      title={`HTML-PPT Preview ${msg.deckRender.deckId}`}
                      src={msg.deckRender.previewUrl}
                      style={styles.deckPreviewFrame}
                    />
                  </div>
                )}
                {msg.role === 'assistant' && !msg.deckRender && msg.orchestration && msg.orchestration.steps.length > 0 && (
                  <div style={styles.orchestrationStandaloneCard}>
                    <div style={styles.orchestrationStandaloneHeader}>
                      <span>
                        编排器：{msg.orchestration.model} · {msg.orchestration.totalModelCalls} 次模型调用 · {msg.orchestration.steps.length} 步
                      </span>
                      {canResumeOrchestration(msg.orchestration) && (
                        <button
                          style={styles.resumeBtn}
                          disabled={Boolean(resumingMessageId)}
                          onClick={() => void resumeGeneration(msg.id)}>
                          {resumingMessageId === msg.id ? '继续中...' : '继续生成'}
                        </button>
                      )}
                    </div>
                    <div style={styles.orchestrationPanel}>
                      {msg.orchestration.steps.map((step) => (
                        <div key={step.id} style={styles.orchestrationRow}>
                        <span style={{
                          ...styles.orchestrationStatus,
                            ...orchestrationStatusStyle(step.status),
                        }}>
                            {orchestrationStatusLabel(step.status)}
                          </span>
                          <div style={styles.orchestrationBody}>
                            <div style={styles.orchestrationTitle}>{step.name}</div>
                            <div style={styles.orchestrationDetail}>{step.detail}</div>
                          </div>
                          <span style={styles.orchestrationDuration}>
                            {fmtDuration(step.startedAt, step.endedAt, step.status)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ ...styles.msgTs, textAlign: msg.role === 'user' ? 'right' : 'left' }}>
                  {msg.ts.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}

          {loading && !hasLiveAssistantProgress && (
            <div style={{ ...styles.msgRow }}>
              <div style={{ ...styles.msgAvatar, background: '#f0f4ff' }}>AI</div>
              <div style={{ ...styles.msgBubble, background: 'white', padding: '12px 16px' }}>
                <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  <span className="ppt-typing-dot" />
                  <span className="ppt-typing-dot" />
                  <span className="ppt-typing-dot" />
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
          </div>

          {/* ── Input area ── */}
          <div style={styles.inputArea}>
          {/* Attached files */}
          {files.length > 0 && (
            <div style={styles.attachedFiles}>
              {files.map((f, i) => (
                <div key={i} style={styles.attachedPill}>
                  <span>{f.name}</span>
                  <span style={{ opacity: 0.5, fontSize: 11 }}>{fmt(f.size)}</span>
                  <button style={styles.removeFileBtn} onClick={() => removeFile(i)}>x</button>
                </div>
              ))}
            </div>
          )}

          <div style={styles.inputRow}>
            {/* Upload button */}
            <button style={styles.uploadBtn} title="上传文件 (docx/pptx/txt/md/pdf)"
              onClick={() => fileInputRef.current?.click()}>
              +
            </button>
            <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} multiple hidden onChange={onFileChange} />

            {/* Textarea */}
            <textarea ref={textareaRef}
              style={styles.textarea}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="描述你的 PPT 主题...  Shift+Enter 换行，Enter 发送"
              rows={1}
            />

            {/* Send button */}
            <button style={{ ...styles.sendBtn, opacity: (!input.trim() && !files.length) || hasLiveAssistantProgress ? 0.4 : 1 }}
              disabled={!activeId || (!input.trim() && !files.length) || loading || hasLiveAssistantProgress || Boolean(resumingMessageId)}
              onClick={send}>
              {hasLiveAssistantProgress ? '生成中' : 'Send'}
            </button>
          </div>
          <div style={styles.inputHint}>
            支持上传 .docx / .pptx / .txt / .md / .pdf / Shift+Enter 换行
          </div>
          </div>

          <div ref={templateSectionRef} style={styles.templateSection}>
            <div style={styles.templateSectionHeader}>
              <div>
                <div style={styles.drawerTitle}>选择模板</div>
                <div style={styles.drawerSubtitle}>模板选择直接固定在输入区下方，不再通过弹层打开。</div>
              </div>
            </div>

            <div style={styles.tplGrid}>
              {TEMPLATES.map(tpl => (
                <button key={tpl.id}
                  style={{ ...styles.tplCard, outline: selectedTemplate === tpl.id || active?.template === tpl.id ? '2px solid var(--accent)' : 'none', background: selectedTemplate === tpl.id || active?.template === tpl.id ? 'var(--accent-soft)' : 'white' }}
                  onClick={() => applyTemplate(tpl.id)}>
                  <div style={styles.tplEmoji}>{tpl.emoji}</div>
                  <div style={styles.tplLabel}>{tpl.label}</div>
                  <div style={styles.tplDesc}>{tpl.desc}</div>
                  {(selectedTemplate === tpl.id || active?.template === tpl.id) && (
                    <div style={styles.tplCheck}>OK</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Styles ─────────────────────────────────────────────── */
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: 'calc(100vh - 64px)',
    overflow: 'hidden',
    background: '#f8f9fb',
    position: 'relative',
  },

  /* ── Sidebar ── */
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    background: 'white',
    borderRight: '1px solid rgba(0,0,0,0.06)',
    transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)',
    overflow: 'hidden',
    flexShrink: 0,
  },
  sidebarHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 14px 10px',
    borderBottom: '1px solid rgba(0,0,0,0.05)',
  },
  sidebarTitle: {
    fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8,
    whiteSpace: 'nowrap', overflow: 'hidden',
  },
  sidebarTitleIcon: { fontSize: 20 },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 16, color: 'var(--muted)', padding: '4px 6px', borderRadius: 6,
    lineHeight: 1, flexShrink: 0,
  },
  newProjectBtn: {
    display: 'flex', alignItems: 'center', gap: 8,
    margin: '10px 12px',
    padding: '8px 12px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    fontWeight: 600, fontSize: 13,
    transition: 'opacity 0.2s',
  },
  projectList: {
    flex: 1, overflow: 'hidden', padding: '4px 8px',
  },
  projectItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    border: '1px solid transparent',
    marginBottom: 2,
    transition: 'background 0.15s, border-color 0.15s',
    minHeight: 36,
  },
  projectIcon: { fontSize: 14, flexShrink: 0 },
  projectName: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 13, fontWeight: 500,
  },
  projectActions: { display: 'flex', gap: 2, flexShrink: 0 },
  actionBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 13, padding: '2px 4px', borderRadius: 4,
    opacity: 0.65,
  },
  renameInput: {
    flex: 1, border: '1px solid var(--accent)', borderRadius: 6,
    padding: '2px 6px', fontSize: 13, outline: 'none',
  },
  tplBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    margin: '8px 12px 4px',
    padding: '6px 10px',
    background: 'var(--accent-soft)',
    borderRadius: 8, border: '1px solid rgba(26,115,232,0.12)',
    fontSize: 13,
  },
  sidebarHint: {
    textAlign: 'center', fontSize: 11, color: 'var(--muted)',
    opacity: 0.5, padding: '8px 12px 16px', lineHeight: 1.6,
  },

  /* ── Main ── */
  mainWrap: {
    flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  mainScrollArea: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  errorBanner: {
    margin: '18px 24px 0',
    border: '1px solid rgba(220,38,38,0.18)',
    background: 'rgba(254,242,242,0.96)',
    color: '#b91c1c',
    borderRadius: 16,
    padding: '12px 16px',
    fontSize: 13,
    lineHeight: 1.6,
  },
  chatHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 24px',
    background: 'white',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    flexShrink: 0,
  },
  chatTitle: { fontWeight: 700, fontSize: 16 },
  chatSubtitle: { fontSize: 12, color: 'var(--muted)', marginTop: 2, display: 'block' },
  ghostBtn: {
    background: 'transparent', border: '1px solid rgba(0,0,0,0.1)',
    padding: '7px 16px', borderRadius: 999, cursor: 'pointer',
    fontSize: 13, fontWeight: 500, color: 'var(--ink)',
    transition: 'background 0.2s',
  },

  /* ── Messages ── */
  messages: {
    flex: '1 0 auto',
    padding: '24px 28px',
    display: 'flex', flexDirection: 'column', gap: 20,
  },
  emptyState: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', textAlign: 'center', padding: '40px 0',
    gap: 12,
  },
  emptyIcon: { fontSize: 52, marginBottom: 4 },
  emptyTitle: { fontWeight: 700, fontSize: 22, color: 'var(--ink)' },
  emptyHint: { fontSize: 14, color: 'var(--muted)', maxWidth: 420, lineHeight: 1.7 },
  emptyTips: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  tipBtn: {
    background: 'white', border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 10, padding: '10px 18px',
    cursor: 'pointer', fontSize: 13, color: 'var(--ink)',
    textAlign: 'left', boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    transition: 'box-shadow 0.2s, transform 0.2s',
  },
  msgRow: {
    display: 'flex', gap: 12, alignItems: 'flex-end',
  },
  msgAvatar: {
    width: 32, height: 32, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 16, flexShrink: 0,
  },
  msgBubble: {
    padding: '10px 14px',
    borderRadius: 16,
    fontSize: 14, lineHeight: 1.65,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    maxWidth: '100%', wordBreak: 'break-word',
  },
  msgTs: { fontSize: 11, color: 'var(--muted)', opacity: 0.6, marginTop: 4, paddingX: 4 } as React.CSSProperties,
  filePillsRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  filePill: {
    background: 'rgba(26,115,232,0.08)', border: '1px solid rgba(26,115,232,0.15)',
    borderRadius: 6, padding: '3px 9px', fontSize: 12, color: 'var(--accent)',
  },
  templatePill: {
    background: 'rgba(15,118,110,0.08)',
    border: '1px solid rgba(15,118,110,0.18)',
    borderRadius: 999,
    padding: '4px 10px',
    fontSize: 12,
    color: '#0f766e',
    fontWeight: 600,
  },
  deckPreviewCard: {
    marginTop: 10,
    overflow: 'hidden',
    borderRadius: 14,
    border: '1px solid rgba(0,0,0,0.08)',
    background: 'white',
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  },
  deckPreviewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    background: '#fbfcfd',
  },
  deckPreviewTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--ink)',
  },
  deckPreviewMeta: {
    marginTop: 2,
    fontSize: 11,
    color: 'var(--muted)',
  },
  orchestrationMeta: {
    marginTop: 4,
    fontSize: 11,
    color: '#0f766e',
    fontWeight: 600,
  },
  orchestrationStandaloneCard: {
    marginTop: 10,
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 12,
    overflow: 'hidden',
    background: '#ffffff',
  },
  orchestrationStandaloneHeader: {
    padding: '8px 10px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    fontSize: 12,
    fontWeight: 700,
    color: '#0f766e',
    background: '#f8fbff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  resumeBtn: {
    border: '1px solid rgba(180,83,9,0.18)',
    background: 'rgba(245,158,11,0.12)',
    color: '#b45309',
    borderRadius: 999,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    flexShrink: 0,
  },
  orchestrationPanel: {
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    background: '#f7fafc',
    padding: '8px 10px',
    display: 'grid',
    gap: 6,
  },
  orchestrationRow: {
    display: 'grid',
    gridTemplateColumns: '58px 1fr auto',
    gap: 8,
    alignItems: 'start',
    padding: '6px 8px',
    borderRadius: 8,
    background: 'white',
    border: '1px solid rgba(15,23,42,0.06)',
  },
  orchestrationStatus: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 20,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    padding: '0 8px',
  },
  orchestrationBody: {
    minWidth: 0,
  },
  orchestrationTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: '#111827',
    lineHeight: 1.35,
  },
  orchestrationDetail: {
    marginTop: 2,
    fontSize: 11,
    color: '#4b5563',
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  orchestrationDuration: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    whiteSpace: 'nowrap',
    marginTop: 2,
  },
  deckPreviewActions: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  deckActionLink: {
    border: '1px solid rgba(26,115,232,0.16)',
    background: 'rgba(26,115,232,0.08)',
    color: 'var(--accent)',
    borderRadius: 999,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 700,
    textDecoration: 'none',
  },
  deckPreviewFrame: {
    display: 'block',
    width: 540,
    maxWidth: '100%',
    aspectRatio: '16 / 9',
    border: 'none',
    background: '#111',
  },
  typing: {
    display: 'inline-flex', gap: 4, alignItems: 'center',
  },

  /* ── Input ── */
  inputArea: {
    flexShrink: 0,
    padding: '12px 20px 16px',
    background: 'white',
    borderTop: '1px solid rgba(0,0,0,0.06)',
  },
  attachedFiles: {
    display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8,
  },
  attachedPill: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'var(--accent-soft)', borderRadius: 6,
    padding: '4px 10px', fontSize: 12, color: 'var(--accent)',
    border: '1px solid rgba(26,115,232,0.15)',
  },
  removeFileBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 15, lineHeight: 1, color: 'var(--accent)', padding: '0 2px',
  },
  inputRow: {
    display: 'flex', alignItems: 'flex-end', gap: 8,
    background: '#f8f9fb',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 16,
    padding: '8px',
    transition: 'border-color 0.2s, box-shadow 0.2s',
  },
  uploadBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 20, padding: '4px 6px', borderRadius: 8,
    color: 'var(--muted)', flexShrink: 0, lineHeight: 1,
    transition: 'color 0.15s',
  },
  textarea: {
    flex: 1, border: 'none', background: 'transparent',
    resize: 'none', outline: 'none',
    fontSize: 14, color: 'var(--ink)', lineHeight: 1.55,
    padding: '4px 0', minHeight: 28, maxHeight: 200,
    fontFamily: 'inherit',
  },
  sendBtn: {
    width: 36, height: 36, borderRadius: '50%',
    background: 'var(--accent)', color: 'white',
    border: 'none', cursor: 'pointer', flexShrink: 0,
    fontSize: 18, fontWeight: 700, lineHeight: 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'opacity 0.2s, transform 0.15s',
  },
  inputHint: {
    fontSize: 11, color: 'var(--muted)', opacity: 0.55,
    marginTop: 8, textAlign: 'center',
  },

  /* ── Inline template selector ── */
  templateSection: {
    flexShrink: 0,
    padding: '12px 20px 16px',
    background: 'white',
    borderTop: '1px solid rgba(0,0,0,0.06)',
  },
  templateSectionHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    marginBottom: 14,
  },
  drawerTitle: { fontWeight: 700, fontSize: 20 },
  drawerSubtitle: { fontSize: 13, color: 'var(--muted)', marginTop: 4 },
  tplGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: 12,
  },
  tplCard: {
    position: 'relative',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    padding: '14px 14px 12px',
    border: '1px solid rgba(0,0,0,0.08)',
    borderRadius: 14,
    cursor: 'pointer', textAlign: 'left',
    transition: 'box-shadow 0.2s, transform 0.2s, outline 0.15s',
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
  },
  tplEmoji: { fontSize: 26, marginBottom: 8 },
  tplLabel: { fontWeight: 600, fontSize: 13, color: 'var(--ink)', marginBottom: 3 },
  tplDesc: { fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 },
  tplCheck: {
    position: 'absolute', top: 8, right: 10,
    width: 20, height: 20, borderRadius: '50%',
    background: 'var(--accent)', color: 'white',
    fontSize: 11, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
};
