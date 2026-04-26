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
interface Template {
  id: string;
  label: string;
  emoji: string;
  desc: string;
  previewSlides?: string[];
  previewCss?: string;
  deckClass?: string;
}

const TEMPLATE_METADATA: Record<string, { label: string; emoji: string; desc: string }> = {
  'pitch-deck': { label: 'Pitch Deck', emoji: 'VC', desc: '投资人路演 / VC风格' },
  'product-launch': { label: 'Product Launch', emoji: 'PL', desc: '产品发布会' },
  'tech-sharing': { label: 'Tech Sharing', emoji: 'TS', desc: '技术分享 / 工程师风格' },
  'weekly-report': { label: 'Weekly Report', emoji: 'WR', desc: '周报 / 数据汇报' },
  'xhs-post': { label: '小红书图文', emoji: 'XHS', desc: '9页 / 3:4比例' },
  'course-module': { label: 'Course Module', emoji: 'EDU', desc: '教学模块' },
  'presenter-mode-reveal': { label: 'Presenter Mode', emoji: 'PM', desc: '带逐字稿 · 演讲者模式' },
  'xhs-white-editorial': { label: 'XHS White Editorial', emoji: 'WE', desc: '小红书白底杂志风' },
  'graphify-dark-graph': { label: 'Graphify Dark', emoji: 'GD', desc: '暗底知识图谱' },
  'knowledge-arch-blueprint': { label: 'Blueprint', emoji: 'BP', desc: '蓝图 / 架构图风' },
  'hermes-cyber-terminal': { label: 'Cyber Terminal', emoji: 'CT', desc: '终端 Cyberpunk 风' },
  'obsidian-claude-gradient': { label: 'Obsidian Gradient', emoji: 'OG', desc: '紫色渐变卡' },
  'xhs-pastel-card': { label: 'XHS Pastel', emoji: 'XP', desc: '柔和马卡龙图文' },
  'dir-key-nav-minimal': { label: 'Minimal Nav', emoji: 'NAV', desc: '方向键极简' },
  'testing-safety-alert': { label: 'Safety Alert', emoji: 'SA', desc: '红色警示风格' },
};

/* ── Shadow Root Wrapper for Previews ── */
function ShadowPreview({ html, css, deckClass }: { html: string; css: string; deckClass?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [scale, setScale] = useState(0.1);

  useEffect(() => {
    if (containerRef.current && !shadowRef.current) {
      shadowRef.current = containerRef.current.attachShadow({ mode: 'open' });
    }
    
    // Measure actual width and update scale
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (width > 0) {
          setScale(width / 1280);
        }
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (shadowRef.current) {
      shadowRef.current.innerHTML = `
        <style>
          :host { 
            display: block; 
            width: 100%; 
            aspect-ratio: 16/9;
            overflow: hidden; 
            background: white; 
          }
          .scaler {
            transform: scale(${scale});
            transform-origin: top left;
            width: 1280px;
            height: 720px;
            background: white;
          }
          ${css}
        </style>
        <div class="scaler">
          <div class="${deckClass || ''}">
            ${html}
          </div>
        </div>
      `;
    }
  }, [html, css, deckClass, scale]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}

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

function canShowStepActions(
  orchestration: PptGenerationOrchestration | undefined,
  step: PptGenerationOrchestration['steps'][number],
) {
  if (!orchestration || step.status === 'running' || step.status === 'completed' || step.status === 'skipped') {
    return false;
  }

  const lastStep = orchestration.steps.at(-1);
  return Boolean(lastStep && lastStep.id === step.id && (lastStep.status === 'failed' || lastStep.status === 'timeout'));
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
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [hoveredTemplateId, setHoveredTemplateId] = useState<string | null>(null);
  const [hoverProgress, setHoverProgress] = useState(0);
  const templateSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const raw = await requestJson<any[]>('/api/ppt/projects/templates/catalog');
        const enriched = raw.map(tpl => ({
          ...tpl,
          ...(TEMPLATE_METADATA[tpl.id] || { label: tpl.id, emoji: '📄', desc: 'Custom template' })
        }));
        setTemplates(enriched);
      } catch (err) {
        console.error('Failed to fetch template catalog:', err);
      }
    };
    fetchTemplates();
  }, []);

  const handleTemplateMouseMove = (e: React.MouseEvent, id: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setHoverProgress(x / rect.width);
    setHoveredTemplateId(id);
  };

  /* Sidebar */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(280);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const [isResizing, setIsResizing] = useState(false);
  const [isResizingLeft, setIsResizingLeft] = useState(false);

  const startResizing = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const startResizingLeft = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingLeft(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 180 && newWidth < 800) {
          setRightSidebarWidth(newWidth);
        }
      } else if (isResizingLeft) {
        const newWidth = e.clientX;
        if (newWidth > 150 && newWidth < 500) {
          setLeftSidebarWidth(newWidth);
        }
      }
    };
    const handleMouseUp = () => {
      setIsResizing(false);
      setIsResizingLeft(false);
    };

    if (isResizing || isResizingLeft) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isResizingLeft]);

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

    const isCurrentlySelected = active?.template === templateId;
    const finalTemplateId = isCurrentlySelected ? null : templateId;

    setRequestError('');
    setSelectedTemplate(finalTemplateId);

    try {
      const summary = await requestJson<PptProjectSummary>(`/api/ppt/projects/${encodeURIComponent(activeId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ templateId: finalTemplateId }),
      });

      setProjects(prev =>
        prev.map(project =>
          project.id === activeId ? mergeProjectSummary(project, summary) : project
        )
      );
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '切换模板失败。');
    }
  }, [activeId, active?.template]);

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
      ? templates.find(t => t.id === active.template) ?? {
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
  }, [input, files, activeId, active, hasLiveAssistantProgress, templates]);

  const resumeGeneration = useCallback(async (messageId: string, mode: 'resume' | 'adopt' = 'resume') => {
    if (!activeId || resumingMessageId) {
      return;
    }

    setResumingMessageId(messageId);
    setRequestError('');

    try {
      const response = await requestJson<PptConversationResponse>(
        `/api/ppt/projects/${encodeURIComponent(activeId)}/messages/${encodeURIComponent(messageId)}/resume`,
        { method: 'POST', body: JSON.stringify({ mode }) }
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
      setRequestError(error instanceof Error ? error.message : mode === 'adopt' ? '采用失败。' : '继续生成失败。');
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
      <aside style={{ ...styles.sidebar, width: sidebarCollapsed ? 80 : leftSidebarWidth }}>
        {/* Header */}
        <div style={styles.sidebarHeader}>
          {!sidebarCollapsed && (
            <span style={styles.sidebarTitle}>
              <div style={styles.sidebarTitleIcon}>PPT</div>
              Studio
            </span>
          )}
          <button style={styles.iconBtn} onClick={() => setSidebarCollapsed(c => !c)} title="折叠侧栏">
            {sidebarCollapsed ? '→' : '←'}
          </button>
        </div>

        {/* New project button */}
        <button
          style={{
            ...styles.newProjectBtn,
            justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            padding: sidebarCollapsed ? '12px 0' : '12px 16px',
            margin: sidebarCollapsed ? '12px 10px' : '12px 16px',
          }}
          onClick={createProject}
          title="新建项目"
        >
          <span style={{ fontSize: 20 }}>+</span>
          {!sidebarCollapsed && <span>New Project</span>}
        </button>

        {/* Project list */}
        <div style={styles.projectList}>
          {projects.map(p => (
            <div key={p.id}
              className="project-item-row"
              style={{
                ...styles.projectItem,
                background: p.id === activeId ? 'var(--accent-soft)' : 'transparent',
                borderColor: p.id === activeId ? 'var(--accent-softer)' : 'transparent',
                boxShadow: p.id === activeId ? 'var(--shadow-base)' : 'none',
              }}
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
                  <span style={{ ...styles.projectIcon, color: p.id === activeId ? 'var(--accent)' : 'var(--muted)' }}>
                    {p.id === activeId ? '●' : '○'}
                  </span>
                  {!sidebarCollapsed && (
                    <span style={{ ...styles.projectName, color: p.id === activeId ? 'var(--accent)' : 'var(--ink)' }} title={p.name}>
                      {p.name}
                    </span>
                  )}
                  {!sidebarCollapsed && p.id === activeId && (
                    <div style={styles.projectActions} className="actions-group">
                      <button style={styles.actionBtn} title="重命名"
                        onClick={e => { e.stopPropagation(); setEditingId(p.id); setEditName(p.name); }}>Edit</button>
                      <button style={{ ...styles.actionBtn, color: 'var(--danger)' }} title="删除"
                        onClick={e => { e.stopPropagation(); if (confirm('确认删除此项目？')) void deleteProject(p.id); }}>Del</button>
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
            <span style={{ fontSize: 18 }}>{templates.find(t => t.id === active.template)?.emoji}</span>
            <span style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {templates.find(t => t.id === active.template)?.label}
            </span>
          </div>
        )}

        {/* Hint */}
        {!sidebarCollapsed && (
          <div style={styles.sidebarHint}>
            Design with AI Intelligence
          </div>
        )}
      </aside>

      <div 
        onMouseDown={startResizingLeft}
        style={{
          width: '6px',
          cursor: 'col-resize',
          background: isResizingLeft ? 'var(--accent)' : 'transparent',
          zIndex: 100,
          transition: 'background 0.2s',
          marginRight: '-3px',
          marginLeft: '-3px',
          position: 'relative',
        }}
      />

      <div style={styles.mainWrap}>
        
        <div style={styles.chatWrap}>
          {/* ── Chat header ── */}
          <div style={styles.chatHeader}>
            <div>
              <div style={styles.chatTitle}>{active?.name ?? 'Select Project'}</div>
              {active?.template && (
                <span style={styles.chatSubtitle}>
                  <span className="eyebrow" style={{ padding: '2px 8px', fontSize: 10 }}>{templates.find(t => t.id === active.template)?.label}</span>
                  &nbsp;· Active Template
                </span>
              )}
            </div>
            <button style={styles.ghostBtn} onClick={() => templateSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}>
              View Templates
            </button>
          </div>

          <div style={styles.mainScrollArea}>
            {requestError ? (
              <div style={styles.errorBanner}>
                <span style={{ marginRight: 8 }}>⚠️</span>
                {requestError}
              </div>
            ) : null}

            {/* ── Messages ── */}
            <div style={styles.messages}>
              {bootstrapping && !active ? (
                <div style={styles.emptyState}>
                  <div className="ppt-typing-dot" style={{ width: 40, height: 40 }} />
                  <div style={styles.emptyTitle}>Synchronizing...</div>
                  <div style={styles.emptyHint}>Preparing your premium authoring environment.</div>
                </div>
              ) : active?.messages.length === 0 ? (
                <div style={styles.emptyState} className="reveal-up">
                  <div style={styles.emptyIcon}>✦</div>
                  <div style={styles.emptyTitle}>Create Professional Deck</div>
                  <div style={styles.emptyHint}>
                    Describe your topic or drop documents. Our AI agent will orchestrate the layout and content for you.
                  </div>
                  <div style={styles.emptyTips}>
                    {['Product Launch: Vision for 2026 Space Travel', 'Tech Sharing: Exploring Quantum Computing', 'Pitch Deck: Next-gen Sustainable Energy SaaS'].map(tip => (
                      <button key={tip} style={styles.tipBtn} className="antigravity-card" onClick={() => setInput(tip)}>{tip}</button>
                    ))}
                  </div>
                </div>
              ) : null}

              {active?.messages.map(msg => (
                <div key={msg.id} style={{ ...styles.msgRow, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }} className="reveal-up">
                  <div style={{
                    ...styles.msgAvatar,
                    background: msg.role === 'user' ? 'var(--accent)' : 'white',
                    color: msg.role === 'user' ? 'white' : 'var(--accent)',
                    boxShadow: msg.role === 'user' ? '0 4px 12px rgba(26, 115, 232, 0.2)' : 'var(--shadow-base)',
                    border: msg.role === 'user' ? 'none' : '1px solid var(--line)',
                  }}>
                    {msg.role === 'user' ? 'U' : 'AI'}
                  </div>
                  <div style={{ maxWidth: '85%', width: '100%', display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    {msg.template && (
                      <div style={styles.filePillsRow}>
                        <span style={styles.templatePill}>
                          Template: {msg.template.label}
                        </span>
                      </div>
                    )}
                    {msg.files && msg.files.length > 0 && (
                      <div style={styles.filePillsRow}>
                        {msg.files.map((f, i) => (
                          <span key={i} style={styles.filePill}>
                            <span style={{ fontSize: 14 }}>📄</span>
                            {f.name} ({fmt(f.size)})
                          </span>
                        ))}
                      </div>
                    )}
                      <div style={{
                        ...styles.msgBubble,
                        background: msg.role === 'user' ? 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)' : 'white',
                        color: msg.role === 'user' ? 'white' : 'var(--ink)',
                        border: msg.role === 'user' ? 'none' : '1px solid var(--line)',
                        boxShadow: msg.role === 'user' ? '0 8px 24px rgba(99, 102, 241, 0.2)' : 'var(--shadow-base)',
                      }}>
                      {visibleMessageContent(msg.content).split('\n').map((line, i) => (
                        <span key={i}>{line.replace(/\*\*(.*?)\*\*/g, '$1')}<br /></span>
                      ))}
                    </div>
                    {msg.role === 'assistant' && msg.deckRender && (
                      <div style={styles.deckPreviewCard} className="float-effect">
                        <div style={styles.deckPreviewHeader}>
                          <div>
                            <div style={styles.deckPreviewTitle}>{msg.deckRender.title}</div>
                            <div style={styles.deckPreviewMeta}>
                              <span className="eyebrow" style={{ padding: '2px 8px', fontSize: 10, background: 'var(--bg-deep)' }}>{msg.deckSpec?.template ?? 'HTML-PPT'}</span>
                              &nbsp;· {msg.deckSpec?.slides.length ?? 0} Slides Generated
                            </div>
                            {msg.orchestration && (
                              <div style={styles.orchestrationMeta}>
                                ✓ Orchestration Complete: {msg.orchestration.totalModelCalls} Calls · {msg.orchestration.steps.length} Steps
                              </div>
                            )}
                          </div>
                          <div style={styles.deckPreviewActions}>
                            <a style={styles.deckActionLink} className="ghost-button" href={msg.deckRender.previewUrl} target="_blank" rel="noreferrer">Full View</a>
                            <a style={styles.deckActionLink} className="primary-button" href={msg.deckRender.downloadUrl}>Download</a>
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
                                <div style={styles.orchestrationRightRail}>
                                  <span style={styles.orchestrationDuration}>
                                    {fmtDuration(step.startedAt, step.endedAt, step.status)}
                                  </span>
                                  {canShowStepActions(msg.orchestration, step) && (
                                    <div style={styles.stepActionStack}>
                                      <button
                                        style={styles.stepActionBtn}
                                        disabled={Boolean(resumingMessageId)}
                                        onClick={() => void resumeGeneration(msg.id, 'resume')}>
                                        {resumingMessageId === msg.id ? '处理中...' : '重新生成'}
                                      </button>
                                      <button
                                        style={{ ...styles.stepActionBtn, ...styles.stepActionBtnSecondary }}
                                        disabled={Boolean(resumingMessageId)}
                                        onClick={() => void resumeGeneration(msg.id, 'adopt')}>
                                        采用
                                      </button>
                                    </div>
                                  )}
                                </div>
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
                            Orchestrating: {msg.orchestration.model} ({msg.orchestration.steps.length} Steps)
                          </span>
                          {canResumeOrchestration(msg.orchestration) && (
                            <span style={styles.orchestrationHeaderHint}>可在失败步骤右侧使用“重新生成/采用”</span>
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
                              <div style={styles.orchestrationRightRail}>
                                <span style={styles.orchestrationDuration}>
                                  {fmtDuration(step.startedAt, step.endedAt, step.status)}
                                </span>
                                {canShowStepActions(msg.orchestration, step) && (
                                  <div style={styles.stepActionStack}>
                                    <button
                                      style={styles.stepActionBtn}
                                      disabled={Boolean(resumingMessageId)}
                                      onClick={() => void resumeGeneration(msg.id, 'resume')}>
                                      {resumingMessageId === msg.id ? '处理中...' : '重新生成'}
                                    </button>
                                    <button
                                      style={{ ...styles.stepActionBtn, ...styles.stepActionBtnSecondary }}
                                      disabled={Boolean(resumingMessageId)}
                                      onClick={() => void resumeGeneration(msg.id, 'adopt')}>
                                      采用
                                    </button>
                                  </div>
                                )}
                              </div>
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
                <div style={{ ...styles.msgRow }} className="reveal-up">
                  <div style={{ ...styles.msgAvatar, background: 'white', border: '1px solid var(--line)', color: 'var(--accent)' }}>AI</div>
                  <div style={{ ...styles.msgBubble, background: 'white', border: '1px solid var(--line)', padding: '16px 20px' }}>
                    <span style={styles.typing}>
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
              <div style={{ maxWidth: 900, margin: '0 auto', width: '100%' }}>
                {files.length > 0 && (
                  <div style={styles.attachedFiles}>
                    {files.map((f, i) => (
                      <div key={i} style={styles.attachedPill} className="reveal-up">
                        <span>📄 {f.name}</span>
                        <span style={{ opacity: 0.6, fontSize: 11 }}>{fmt(f.size)}</span>
                        <button style={styles.removeFileBtn} onClick={() => removeFile(i)}>×</button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ ...styles.inputRow, borderColor: loading ? 'var(--accent)' : 'var(--line-strong)' }}>
                  {/* Upload button */}
                  <button style={styles.uploadBtn} className="ghost-button" title="Upload files"
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
                    placeholder="Describe your deck content..."
                    rows={1}
                  />

                  {/* Send button */}
                  <button style={{ ...styles.sendBtn, opacity: (!input.trim() && !files.length) || hasLiveAssistantProgress ? 0.5 : 1 }}
                    disabled={!activeId || (!input.trim() && !files.length) || loading || hasLiveAssistantProgress || Boolean(resumingMessageId)}
                    onClick={send}>
                    {hasLiveAssistantProgress ? '⏳' : '↑'}
                  </button>
                </div>
                <div style={styles.inputHint}>
                  AI automatically creates multi-slide HTML presentations from your prompts or documents.
                </div>
              </div>
            </div>
          </div>
        </div>

        <div 
          onMouseDown={startResizing}
          style={{
            width: '6px',
            cursor: 'col-resize',
            background: isResizing ? 'var(--accent)' : 'transparent',
            zIndex: 100,
            transition: 'background 0.2s',
            marginRight: '-3px',
            marginLeft: '-3px',
            position: 'relative',
          }}
        />

        <aside ref={templateSectionRef} style={{ ...styles.templateSection, width: rightSidebarWidth }}>
          <div style={styles.templateSectionHeader}>
            <div style={styles.drawerTitle}>Templates</div>
            <div style={styles.drawerSubtitle}>Select a visual style.</div>
          </div>

          <div style={styles.tplGrid}>
            {templates.map(tpl => {
              const isSelected = selectedTemplate === tpl.id || active?.template === tpl.id;
              const isHovered = hoveredTemplateId === tpl.id;
              const hasPreviews = tpl.previewSlides && tpl.previewSlides.length > 0;

              return (
                <button key={tpl.id}
                  className="antigravity-card"
                  onMouseMove={(e) => handleTemplateMouseMove(e, tpl.id)}
                  onMouseLeave={() => { setHoveredTemplateId(null); setHoverProgress(0); }}
                  style={{
                    ...styles.tplCard,
                    border: isSelected ? '2px solid var(--accent)' : '1px solid var(--line)',
                    background: isSelected ? 'var(--accent-soft)' : 'white',
                    overflow: 'hidden',
                  }}
                  onClick={() => applyTemplate(tpl.id)}>
                  
                  {/* Dynamic Slide Projection with Shadow DOM isolation */}
                  {hasPreviews && (
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: 2,
                      background: 'white',
                      pointerEvents: 'none',
                    }}>
                      <ShadowPreview 
                        html={tpl.previewSlides?.[isHovered ? Math.min(Math.floor(hoverProgress * tpl.previewSlides.length), tpl.previewSlides.length - 1) : 0] ?? ''}
                        css={tpl.previewCss || ''}
                        deckClass={tpl.deckClass}
                      />
                    </div>
                  )}

                   {/* We only show the descriptive Chinese label at the bottom corner now */}
                   <div style={{ ...styles.tplDesc, position: 'absolute', zIndex: 3 }}>
                     {tpl.desc}
                   </div>
                  {isSelected && (
                    <div style={{ ...styles.tplCheck, zIndex: 4 }}>✓</div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>
      </div>

      <style jsx global>{`
        .project-item-row:hover .actions-group {
          opacity: 1 !important;
        }
        .project-item-row:hover {
          background: rgba(0,0,0,0.03) !important;
          transform: translateX(4px);
        }
        .html-ppt-route .main-content {
          background: var(--bg-deep);
        }
        ::-webkit-scrollbar {
          width: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(0,0,0,0.1);
          border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(0,0,0,0.2);
        }
      `}</style>
    </div>
  );
}

/* ─── Styles ─────────────────────────────────────────────── */
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    height: 'calc(100vh - 64px)',
    overflow: 'hidden',
    background: 'var(--bg-deep)',
    position: 'relative',
    fontFamily: 'inherit',
  },

  /* ── Sidebar ── */
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(255, 255, 255, 0.7)',
    backdropFilter: 'blur(16px)',
    borderRight: '1px solid var(--line)',
    transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    overflow: 'hidden',
    flexShrink: 0,
    zIndex: 20,
  },
  sidebarHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 16px 12px',
  },
  sidebarTitle: {
    fontWeight: 600,
    fontSize: 16,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    whiteSpace: 'nowrap',
    color: 'var(--ink)',
    letterSpacing: '-0.02em',
  },
  sidebarTitleIcon: {
    width: 28,
    height: 28,
    background: 'var(--accent)',
    borderRadius: 8,
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
  },
  iconBtn: {
    background: 'rgba(0,0,0,0.04)',
    border: 'none',
    cursor: 'pointer',
    width: 28,
    height: 28,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    color: 'var(--muted)',
    transition: 'background 0.2s',
  },
  newProjectBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    margin: '12px 16px',
    padding: '12px 16px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 14,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: '0 8px 16px rgba(99, 102, 241, 0.2)',
  },
  projectList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
  },
  projectItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 12,
    cursor: 'pointer',
    border: '1px solid transparent',
    marginBottom: 4,
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    minHeight: 44,
  },
  projectIcon: {
    fontSize: 14,
    opacity: 0.6,
    flexShrink: 0,
  },
  projectName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--ink)',
  },
  projectActions: {
    display: 'flex',
    gap: 4,
    flexShrink: 0,
    opacity: 0,
    transition: 'opacity 0.2s',
  },
  actionBtn: {
    background: 'rgba(0,0,0,0.05)',
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    padding: '4px 6px',
    borderRadius: 6,
    color: 'var(--muted)',
    fontWeight: 600,
  },
  renameInput: {
    flex: 1,
    border: '1px solid var(--accent)',
    borderRadius: 8,
    padding: '4px 8px',
    fontSize: 13,
    outline: 'none',
    background: 'white',
  },
  tplBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '12px',
    padding: '10px 12px',
    background: 'var(--accent-softer)',
    borderRadius: 14,
    border: '1px solid var(--line)',
  },
  sidebarHint: {
    textAlign: 'center',
    fontSize: 11,
    color: 'var(--muted)',
    opacity: 0.6,
    padding: '12px 16px 24px',
    lineHeight: 1.6,
  },

  /* ── Main ── */
  mainWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'row',
    overflow: 'hidden',
    position: 'relative',
    background: 'var(--bg-deep)',
  },
  chatWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: 'var(--bg-deep)',
  },
  mainScrollArea: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    paddingBottom: 20,
  },
  errorBanner: {
    margin: '20px 28px 0',
    border: '1px solid rgba(220,38,38,0.1)',
    background: 'rgba(254,242,242,0.8)',
    backdropFilter: 'blur(8px)',
    color: '#b91c1c',
    borderRadius: 20,
    padding: '14px 20px',
    fontSize: 14,
    fontWeight: 500,
    boxShadow: '0 4px 12px rgba(220,38,38,0.05)',
  },
  chatHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 32px',
    background: 'rgba(255, 255, 255, 0.8)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid var(--line)',
    flexShrink: 0,
    zIndex: 10,
  },
  chatTitle: {
    fontWeight: 600,
    fontSize: 18,
    color: 'var(--ink)',
    letterSpacing: '-0.02em',
  },
  chatSubtitle: {
    fontSize: 12,
    color: 'var(--muted)',
    marginTop: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontWeight: 500,
  },
  ghostBtn: {
    background: 'white',
    border: '1px solid var(--line-strong)',
    padding: '8px 18px',
    borderRadius: 999,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--ink)',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: 'var(--shadow-base)',
  },

  /* ── Messages ── */
  messages: {
    flex: '1 0 auto',
    padding: '32px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: 32,
    maxWidth: 900,
    margin: '0 auto',
    width: '100%',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '60px 20px',
    gap: 16,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    background: 'var(--accent-soft)',
    borderRadius: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 32,
    color: 'var(--accent)',
    marginBottom: 8,
  },
  emptyTitle: {
    fontWeight: 600,
    fontSize: 28,
    color: 'var(--ink)',
    letterSpacing: '-0.03em',
  },
  emptyHint: {
    fontSize: 16,
    color: 'var(--muted)',
    maxWidth: 480,
    lineHeight: 1.6,
  },
  emptyTips: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginTop: 24,
    width: '100%',
    maxWidth: 400,
  },
  tipBtn: {
    background: 'white',
    border: '1px solid var(--line)',
    borderRadius: 16,
    padding: '14px 20px',
    cursor: 'pointer',
    fontSize: 14,
    color: 'var(--ink)',
    fontWeight: 500,
    textAlign: 'left',
    boxShadow: 'var(--shadow-base)',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  msgRow: {
    display: 'flex',
    gap: 16,
    alignItems: 'flex-start',
  },
  msgAvatar: {
    width: 36,
    height: 36,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
    marginTop: 4,
  },
  msgBubble: {
    padding: '14px 20px',
    borderRadius: 20,
    fontSize: 15,
    lineHeight: 1.6,
    boxShadow: 'var(--shadow-base)',
    maxWidth: '100%',
    wordBreak: 'break-word',
    position: 'relative',
  },
  msgTs: {
    fontSize: 11,
    color: 'var(--muted)',
    opacity: 0.5,
    marginTop: 6,
    fontWeight: 500,
  },
  filePillsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  filePill: {
    background: 'rgba(255,255,255,0.8)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    padding: '6px 12px',
    fontSize: 12,
    color: 'var(--muted)',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  templatePill: {
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-softer)',
    borderRadius: 999,
    padding: '6px 14px',
    fontSize: 12,
    color: 'var(--accent)',
    fontWeight: 600,
  },
  deckPreviewCard: {
    marginTop: 16,
    overflow: 'hidden',
    borderRadius: 24,
    border: '1px solid var(--line)',
    background: 'white',
    boxShadow: 'var(--shadow-float)',
  },
  deckPreviewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '16px 20px',
    borderBottom: '1px solid var(--line)',
    background: 'rgba(255,255,255,0.5)',
  },
  deckPreviewTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--ink)',
    letterSpacing: '-0.01em',
  },
  deckPreviewMeta: {
    marginTop: 4,
    fontSize: 12,
    color: 'var(--muted)',
    fontWeight: 500,
  },
  orchestrationMeta: {
    marginTop: 6,
    fontSize: 11,
    color: 'var(--success)',
    fontWeight: 600,
    letterSpacing: '0.02em',
  },
  orchestrationStandaloneCard: {
    marginTop: 16,
    border: '1px solid var(--line)',
    borderRadius: 24,
    overflow: 'hidden',
    background: 'white',
    boxShadow: 'var(--shadow-base)',
  },
  orchestrationStandaloneHeader: {
    padding: '14px 20px',
    borderBottom: '1px solid var(--line)',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--muted)',
    background: 'var(--bg-deep)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  orchestrationHeaderHint: {
    fontSize: 11,
    color: 'var(--muted)',
    fontWeight: 600,
  },
  resumeBtn: {
    border: 'none',
    background: 'var(--warm)',
    color: 'white',
    borderRadius: 999,
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    boxShadow: '0 4px 12px rgba(251, 188, 4, 0.3)',
  },
  orchestrationPanel: {
    background: 'white',
    padding: '12px',
    display: 'grid',
    gap: 8,
  },
  orchestrationRow: {
    display: 'grid',
    gridTemplateColumns: '70px 1fr auto',
    gap: 12,
    alignItems: 'center',
    padding: '10px 12px',
    borderRadius: 14,
    background: 'var(--bg-deep)',
    border: '1px solid var(--line)',
  },
  orchestrationStatus: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 22,
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 700,
    padding: '0 10px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  orchestrationBody: {
    minWidth: 0,
  },
  orchestrationTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--ink)',
  },
  orchestrationDetail: {
    marginTop: 2,
    fontSize: 12,
    color: 'var(--muted)',
    lineHeight: 1.5,
  },
  orchestrationDuration: {
    fontSize: 11,
    color: 'var(--muted)',
    fontFamily: 'ui-monospace, monospace',
    fontWeight: 500,
  },
  orchestrationRightRail: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  stepActionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  stepActionBtn: {
    border: '1px solid var(--line-strong)',
    background: 'white',
    color: 'var(--ink)',
    borderRadius: 10,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.2,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  stepActionBtnSecondary: {
    background: 'var(--bg-deep)',
  },
  deckPreviewActions: {
    display: 'flex',
    gap: 10,
    flexShrink: 0,
  },
  deckActionLink: {
    border: '1px solid var(--line-strong)',
    background: 'white',
    color: 'var(--ink)',
    borderRadius: 999,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    transition: 'all 0.2s',
    boxShadow: 'var(--shadow-base)',
    textDecoration: 'none',
  },
  deckPreviewFrame: {
    display: 'block',
    width: '100%',
    aspectRatio: '16 / 9',
    border: 'none',
    background: '#111',
  },
  typing: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
  },

  /* ── Input ── */
  inputArea: {
    flexShrink: 0,
    padding: '16px 32px 32px',
    background: 'rgba(255,255,255,0.7)',
    backdropFilter: 'blur(20px)',
    borderTop: '1px solid var(--line)',
    zIndex: 15,
  },
  attachedFiles: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  attachedPill: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'var(--accent-soft)',
    borderRadius: 12,
    padding: '6px 12px',
    fontSize: 13,
    color: 'var(--accent)',
    border: '1px solid var(--accent-softer)',
    fontWeight: 500,
  },
  removeFileBtn: {
    background: 'rgba(26,115,232,0.1)',
    border: 'none',
    cursor: 'pointer',
    width: 20,
    height: 20,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    color: 'var(--accent)',
    transition: 'background 0.2s',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 12,
    background: 'white',
    border: '1px solid var(--line-strong)',
    borderRadius: 24,
    padding: '10px',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: 'var(--shadow-base)',
  },
  uploadBtn: {
    background: 'var(--bg-deep)',
    border: 'none',
    cursor: 'pointer',
    width: 44,
    height: 44,
    borderRadius: 18,
    color: 'var(--muted)',
    flexShrink: 0,
    fontSize: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s',
  },
  textarea: {
    flex: 1,
    border: 'none',
    background: 'transparent',
    resize: 'none',
    outline: 'none',
    fontSize: 16,
    color: 'var(--ink)',
    lineHeight: 1.6,
    padding: '10px 4px',
    minHeight: 44,
    maxHeight: 240,
    fontFamily: 'inherit',
    fontWeight: 400,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 18,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    fontSize: 14,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: '0 8px 16px rgba(99, 102, 241, 0.2)',
  },
  inputHint: {
    fontSize: 12,
    color: 'var(--muted)',
    opacity: 0.7,
    marginTop: 12,
    textAlign: 'center',
    fontWeight: 500,
  },

  /* ── Inline template selector ── */
  templateSection: {
    width: 320,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'white',
    borderLeft: '1px solid var(--line)',
    overflowY: 'auto',
  },
  templateSectionHeader: {
    padding: '24px 20px 16px',
    background: 'white',
    position: 'sticky',
    top: 0,
    zIndex: 5,
  },
  drawerTitle: {
    fontWeight: 600,
    fontSize: 22,
    color: 'var(--ink)',
    letterSpacing: '-0.02em',
  },
  drawerSubtitle: {
    fontSize: 14,
    color: 'var(--muted)',
    marginTop: 4,
    fontWeight: 500,
  },
  tplGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: 10,
    padding: '0 16px 40px',
  },
  tplCard: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '14px',
    border: '1px solid var(--line)',
    borderRadius: 16,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    background: 'white',
    boxShadow: 'var(--shadow-base)',
    minHeight: 110,
    aspectRatio: '16/10',
  },
  tplEmoji: {
    display: 'none',
  },
  tplLabel: {
    display: 'none',
  },
  tplDesc: {
    bottom: 10,
    right: 10,
    fontSize: 10,
    color: 'var(--ink)',
    fontWeight: 600,
    padding: '4px 10px',
    background: 'rgba(255, 255, 255, 0.85)',
    backdropFilter: 'blur(8px)',
    borderRadius: 10,
    border: '1px solid rgba(255, 255, 255, 0.5)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
    maxWidth: '90%',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  tplCheck: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 24,
    height: 24,
    borderRadius: '50%',
    background: 'var(--accent)',
    color: 'white',
    fontSize: 10,
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
  },
};
