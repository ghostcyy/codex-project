export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  content: string;
  sourceName: string;
  sourceUrl: string;
  publishDate: string;
  status: "draft" | "published" | "archived";
  tags: readonly string[];
}

export interface AdminNewsArticle extends NewsArticle {
  createdAt: string;
  updatedAt: string;
  collectedAt: string;
  createdBy: number | null;
}

export interface TodayNewsResponse {
  generatedAt: string;
  spotlight: NewsArticle;
  articles: NewsArticle[];
}

export interface NewsListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: NewsArticle[];
}

export interface AdminOverviewResponse {
  totalArticles: number;
  publishedArticles: number;
  draftArticles: number;
  plannedModules: string[];
  pendingMilestones: string[];
}

export interface HealthResponse {
  service: string;
  status: string;
  timestamp: string;
  phase: string;
  modules: string[];
  database: string;
}

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: string;
  user: SessionUser;
}

export interface RegisterResponse {
  user: SessionUser;
}

export interface AdminUserSummary {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

export interface NewsMutationResponse {
  article: AdminNewsArticle;
}

export interface LlmConfigSummary {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  model: string;
  stageModelOverrides?: Partial<Record<"research" | "plan" | "visual" | "section" | "css" | "qa", string>>;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
  callCount?: number;
  tokenConsumption?: number;
}

export interface PptProjectSummary {
  id: string;
  name: string;
  templateId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PptMessageAttachment {
  name: string;
  type: string;
  size: number;
}

export interface PptMessageTemplate {
  id: string;
  label: string;
  description: string;
}

export type PptDeckSlideType =
  | "cover"
  | "agenda"
  | "section"
  | "content"
  | "quote"
  | "timeline"
  | "comparison"
  | "data"
  | "summary"
  | "closing";

export type PptDeckLayout =
  | "cover-hero"
  | "toc-grid"
  | "content-cards"
  | "comparison-board"
  | "kpi-grid"
  | "timeline-ribbon"
  | "roadmap"
  | "flow-diagram"
  | "closing-cta";

export type PptDeckBlockType =
  | "pill-row"
  | "card"
  | "metric"
  | "comparison-panel"
  | "timeline-node"
  | "roadmap-column"
  | "flow-node"
  | "bar-progress"
  | "quote"
  | "cta";

export interface PptDeckAnimation {
  preset?: string;
  stagger?: boolean;
  fx?: string;
  intensity?: "none" | "subtle" | "standard" | "high";
}

export interface PptDeckBlock {
  type: PptDeckBlockType;
  title?: string;
  label?: string;
  value?: string;
  subtitle?: string;
  body?: string;
  items?: string[];
  accent?: string;
  meta?: Record<string, unknown>;
}

export interface PptDeckVisualSystem {
  density?: "calm" | "balanced" | "dense";
  tone?: string;
  backupThemes?: string[];
  customStyleHints?: string[];
}

export interface PptDeckCreativeSlideStyle {
  slideId: string;
  pageStyle?: string;
  layout?: PptDeckLayout;
  componentStyle?: string;
  animation?: string;
  effect?: string;
  shape?: string;
  texture?: string;
  density?: "none" | "subtle" | "standard" | "high";
}

export interface PptDeckCreativeStyle {
  theme: string;
  backupThemes: string[];
  deckStyle?: string;
  texture?: string;
  shape?: string;
  slides: PptDeckCreativeSlideStyle[];
}

export interface PptDeckSlide {
  id: string;
  type: PptDeckSlideType;
  layout?: PptDeckLayout;
  title: string;
  subtitle?: string;
  kicker?: string;
  body: string[];
  blocks?: PptDeckBlock[];
  quote?: string;
  visualPrompt?: string;
  animation?: PptDeckAnimation;
  styleHints?: string[];
  notes?: string;
  data?: Record<string, unknown>;
}

export interface PptDeckSpec {
  schemaVersion: "1.0" | "2.0";
  title: string;
  subtitle?: string;
  language: string;
  template: string;
  theme: string;
  visualSystem?: PptDeckVisualSystem;
  creativeStyle?: PptDeckCreativeStyle;
  audience?: string;
  goal?: string;
  slides: PptDeckSlide[];
}

export interface PptDeckRender {
  deckId: string;
  title: string;
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
}

export interface PptGenerationStep {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "skipped" | "timeout";
  startedAt: string;
  endedAt: string;
  detail: string;
}

export interface PptGenerationOrchestration {
  version: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  totalModelCalls: number;
  steps: PptGenerationStep[];
}

export interface PptMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  files: PptMessageAttachment[];
  template: PptMessageTemplate | null;
  deckSpec?: PptDeckSpec;
  deckRender?: PptDeckRender;
  orchestration?: PptGenerationOrchestration;
  createdAt: string;
}
