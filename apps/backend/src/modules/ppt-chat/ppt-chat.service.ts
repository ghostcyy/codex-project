import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { HtmlPptRendererService } from "../html-ppt-renderer/html-ppt-renderer.service";
import { LlmConfigService } from "../llm-config/llm-config.service";
import { LlmLoggingService } from "../llm-logging/llm-logging.service";
import type { HtmlPptAgentCheckpoint, HtmlPptAgentFailureRecord, HtmlPptAgentProgress, ResearchPack } from "./html-ppt-agent.types";
import {
  deckIrSchema,
  type AssetIR,
  type ChoreographyIR,
  type DeckIR,
  type DesignSystemIR,
  type EvidencePack,
  type IntentIR,
  type LayoutPlanIR,
  type NarrativeIR,
  type SlotFillIR
} from "./html-ppt-v2/ir";
import {
  compactDeckForRenderVerification,
  HtmlPptV2JsonModelClient,
  type RenderRemediationTrace,
  type HtmlPptV2PublishResult,
  type HtmlPptV2PublishTrace
} from "./html-ppt-v2/orchestration";
import { DeckRendererService } from "./html-ppt-v2/renderer";
import { normalizeTemplatePackageId, resolveTemplatePackageSelection, SkillRegistryService, templatePackageSchema, type SkillRegistry, type TemplatePackage } from "./html-ppt-v2/registry";
import {
  runAssetStage,
  runAuxiliaryArtifactsStage,
  runChoreographyStage,
  runCriticStage,
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  runRenderVerificationStage,
  runSlotFillStage,
  runTemplateSelectionStage,
  type AuxiliaryArtifactsStageResult,
  type RenderVerificationIssue,
  type RenderVerificationReport,
  type TemplateSelectionResult
} from "./html-ppt-v2/stages";
import { HTML_PPT_SKILL_PROMPT } from "./html-ppt-skill.prompt";
import { findWorkspaceRoot } from "./skill-asset-indexer";
import { basename, join, resolve } from "node:path";
import type {
  CreatePptProjectInput,
  PptGenerationOrchestration,
  PptGenerationStep,
  PptDeckAnimation,
  PptDeckBlock,
  PptDeckBlockType,
  PptDeckCreativeStyle,
  PptDeckCreativeSlideStyle,
  PptDeckLayout,
  PptDeckRender,
  PptDeckSlide,
  PptDeckSlideType,
  PptDeckSpec,
  PptDeckVisualSystem,
  PptMessageAttachment,
  PptMessageDto,
  PptMessageTemplate,
  PptProjectSummary,
  ResumePptMessageInput,
  SendPptMessageInput,
  UpdatePptProjectInput
} from "./ppt-chat.types";

interface ProjectRow extends QueryResultRow {
  id: string;
  name: string;
  template_id: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow extends QueryResultRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: Record<string, unknown> | null;
  created_at: Date | string;
}

interface SummaryRow extends QueryResultRow {
  project_id: string;
  summary_text: string;
  summarized_message_count: number;
  updated_at: Date | string;
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type ChatCompletionErrorResponse = {
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  status_code?: number;
  status_msg?: string;
  message?: string;
};

type DeckPlan = {
  objective: string;
  targetAudience: string;
  visualDirection: string;
  slidePlan: Array<{ type: PptDeckSlideType; title: string; focus: string }>;
  qualityChecklist: string[];
};

type DeckReview = {
  pass: boolean;
  score: number;
  summary: string;
  issues: string[];
  actions: string[];
};

type LocalDeckQa = {
  pass: boolean;
  score: number;
  issues: string[];
};
type CreativeStyleCatalog = ReturnType<HtmlPptRendererService["getCreativeStyleCatalog"]>;

type ActiveModelConfig = Awaited<ReturnType<LlmConfigService["getActiveConfig"]>>;
type ChatCompletionRequestMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatCompletionLogContext = {
  projectId?: string;
  messageId?: string;
  stage?: string;
  source?: string;
};
type DeckResumeNextStep = "plan" | "draft" | "localQa" | "style" | "review" | "revise" | "recheck" | "rereview" | "render" | "completed";
type DeckResumeCheckpoint = {
  version: "checkpoint-v1";
  sourceUserMessageId: string;
  projectName: string;
  templateId: string;
  theme: string;
  nextStep: DeckResumeNextStep;
  iteration: number;
  pendingUserMessage: PptMessageDto;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  plan?: DeckPlan;
  deckSpec?: PptDeckSpec;
  localQa?: LocalDeckQa;
  creativeStyle?: PptDeckCreativeStyle;
  review?: DeckReview;
  updatedAt: string;
};
type DeckProgressUpdate = {
  content: string;
  orchestration: PptGenerationOrchestration;
  generationStatus: "running" | "completed" | "failed";
  checkpoint?: DeckResumeCheckpoint;
  agentCheckpoint?: HtmlPptAgentCheckpoint;
  v2Checkpoint?: HtmlPptV2ChatCheckpoint;
};
type DeckPipeline = "v1" | "v2";
type HtmlPptV2ResumeStage =
  | "01-intent"
  | "01b-template-select"
  | "02-evidence"
  | "03-narrative"
  | "04-design"
  | "05-layout"
  | "06-slots"
  | "07-assets"
  | "08-choreography"
  | "09-critic"
  | "10-render"
  | "11-verify"
  | "12-artifacts"
  | "13-publish"
  | "completed";
type HtmlPptV2TraceCheckpoint = Partial<HtmlPptV2PublishTrace> & {
  stageAttempts: Record<string, number>;
  modelCalls: number;
  warnings: string[];
};
type HtmlPptV2ChatCheckpoint = {
  version: "html-ppt-v2-checkpoint-v1";
  sourceUserMessageId: string;
  projectName: string;
  pendingUserMessage: PptMessageDto;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  nextStage: HtmlPptV2ResumeStage;
  deckId: string;
  outputDir: string;
  registryHash?: string;
  intent?: IntentIR;
  templateSelection?: TemplateSelectionResult;
  evidence?: EvidencePack;
  narrative?: NarrativeIR;
  design?: DesignSystemIR;
  layoutPlan?: LayoutPlanIR;
  slots?: SlotFillIR;
  assets?: AssetIR;
  choreography?: ChoreographyIR;
  deckBeforeCritic?: DeckIR;
  deck?: DeckIR;
  verification?: RenderVerificationReport;
  auxiliary?: AuxiliaryArtifactsStageResult;
  trace: HtmlPptV2TraceCheckpoint;
  updatedAt: string;
};
type DeckGenerationJob = {
  userId: number;
  projectId: string;
  projectName: string;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  pendingUserMessage: PptMessageDto;
  assistantMessageId: string;
  pipeline?: DeckPipeline;
  resume?: {
    checkpoint?: DeckResumeCheckpoint;
    agentCheckpoint?: HtmlPptAgentCheckpoint;
    v2Checkpoint?: HtmlPptV2ChatCheckpoint;
    orchestration?: PptGenerationOrchestration;
  };
};

class DeckOrchestrationError extends Error {
  constructor(
    message: string,
    readonly orchestration: PptGenerationOrchestration,
    readonly checkpoint?: DeckResumeCheckpoint
  ) {
    super(message);
    this.name = "DeckOrchestrationError";
  }
}

function extractHtmlSections(html: string): string[] {
  const sections: string[] = [];
  for (const match of html.matchAll(/<section\b[\s\S]*?<\/section>/gi)) {
    const section = match[0]
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/\sdata-notes="[^"]*"/gi, "");
    sections.push(section);
  }
  return sections;
}

function defaultRenderRemediationTrace(): RenderRemediationTrace {
  return {
    attempted: false,
    accepted: false,
    slideIndexes: [],
    before: { hardIssueCount: 0, warningCount: 0 },
    reason: "not-run"
  };
}

function v2VerificationIssueCounts(report: RenderVerificationReport) {
  return {
    hardIssueCount: report.summary.hardIssueCount,
    warningCount: report.summary.warningCount
  };
}

function v2VerificationImproved(
  before: { hardIssueCount: number; warningCount: number },
  after: { hardIssueCount: number; warningCount: number }
) {
  const beforeScore = before.hardIssueCount * 100 + before.warningCount;
  const afterScore = after.hardIssueCount * 100 + after.warningCount;
  return afterScore < beforeScore;
}

class HtmlPptAgentResumeError extends Error {
  constructor(
    message: string,
    readonly orchestration: PptGenerationOrchestration,
    readonly checkpoint: HtmlPptAgentCheckpoint
  ) {
    super(message);
    this.name = "HtmlPptAgentResumeError";
  }
}

const RECENT_MESSAGE_LIMIT = 16;
const ALLOWED_SLIDE_TYPES = new Set<PptDeckSlideType>([
  "cover",
  "agenda",
  "section",
  "content",
  "quote",
  "timeline",
  "comparison",
  "data",
  "summary",
  "closing"
]);
const ALLOWED_DECK_LAYOUTS = new Set<PptDeckLayout>([
  "cover-hero",
  "toc-grid",
  "content-cards",
  "comparison-board",
  "kpi-grid",
  "timeline-ribbon",
  "roadmap",
  "flow-diagram",
  "closing-cta"
]);
const ALLOWED_DECK_BLOCK_TYPES = new Set<PptDeckBlockType>([
  "pill-row",
  "card",
  "metric",
  "comparison-panel",
  "timeline-node",
  "roadmap-column",
  "flow-node",
  "bar-progress",
  "quote",
  "cta"
]);
const ALLOWED_DECK_ANIMATIONS = new Set([
  "fade-up",
  "fade-down",
  "fade-left",
  "fade-right",
  "rise-in",
  "drop-in",
  "zoom-pop",
  "blur-in",
  "glitch-in",
  "typewriter",
  "neon-glow",
  "shimmer-sweep",
  "gradient-flow",
  "stagger-list",
  "path-draw",
  "parallax-tilt",
  "card-flip-3d",
  "cube-rotate-3d",
  "page-turn-3d",
  "perspective-zoom",
  "marquee-scroll",
  "kenburns",
  "confetti-burst",
  "spotlight",
  "morph-shape",
  "ripple-reveal"
]);
const ALLOWED_DECK_FX = new Set([
  "particle-burst",
  "confetti-cannon",
  "firework",
  "starfield",
  "matrix-rain",
  "knowledge-graph",
  "neural-net",
  "constellation",
  "orbit-ring",
  "galaxy-swirl",
  "word-cascade",
  "letter-explode",
  "chain-react",
  "magnetic-field",
  "data-stream",
  "gradient-blob",
  "sparkle-trail",
  "shockwave",
  "typewriter-multi",
  "counter-explosion"
]);

@Injectable()
export class PptChatService {
  private readonly logger = new Logger(PptChatService.name);
  private readonly htmlPptV2Renderer = new DeckRendererService();
  private readonly htmlPptRendererService: Pick<HtmlPptRendererService, "getCreativeStyleCatalog" | "renderDeck"> = {
    getCreativeStyleCatalog: () => {
      throw new ServiceUnavailableException("HTML-PPT legacy v1 renderer is disabled; use the v2 registry and renderer.");
    },
    renderDeck: async () => {
      throw new ServiceUnavailableException("HTML-PPT legacy v1 renderer is disabled; use the v2 registry and renderer.");
    }
  };
  private readonly htmlPptAgentService = {
    generateDeck: async (..._args: unknown[]): Promise<{
      deckSpec: PptDeckSpec;
      deckRender: PptDeckRender;
      orchestration: PptGenerationOrchestration;
      checkpoint?: HtmlPptAgentCheckpoint;
    }> => {
      throw new ServiceUnavailableException("HTML-PPT legacy v1 generation is disabled; new traffic is routed to v2.");
    },
    prepareCheckpointForAdopt: async (_checkpoint: HtmlPptAgentCheckpoint): Promise<HtmlPptAgentCheckpoint> => {
      throw new BadRequestException("HTML-PPT legacy v1 adoption is disabled; resume the v2 generation instead.");
    }
  };

  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService,
    @Inject(SkillRegistryService) private readonly htmlPptV2RegistryService: SkillRegistryService
  ) {}

  async listProjects(userId: number): Promise<PptProjectSummary[]> {
    const result = await this.databaseService.query<ProjectRow>(
      `
        SELECT id, name, template_id, status, created_at, updated_at
        FROM ppt_projects
        WHERE user_id = $1
        ORDER BY updated_at DESC, created_at DESC
      `,
      [userId]
    );

    return result.rows.map((row) => this.mapProject(row));
  }

  async createProject(userId: number, input: CreatePptProjectInput): Promise<PptProjectSummary> {
    const projectId = randomUUID();
    const name = await this.resolveNewProjectName(userId, this.normalizeOptionalString(input.name));
    const templateId = this.normalizeOptionalString(input.templateId);
    await this.assertKnownV2TemplateId(templateId);

    const result = await this.databaseService.query<ProjectRow>(
      `
        INSERT INTO ppt_projects (id, user_id, name, template_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
        RETURNING id, name, template_id, status, created_at, updated_at
      `,
      [projectId, userId, name, templateId]
    );

    const project = result.rows[0];
    if (!project) {
      throw new ServiceUnavailableException("创建 PPT 项目失败。");
    }

    return this.mapProject(project);
  }

  private async resolveNewProjectName(userId: number, requestedName?: string | null) {
    const result = await this.databaseService.query<{ name: string }>(
      "SELECT name FROM ppt_projects WHERE user_id = $1",
      [userId]
    );
    const existingNames = result.rows.map((row) => row.name);
    const existingNameSet = new Set(existingNames);

    if (requestedName && (!existingNameSet.has(requestedName) || !/^Project\s+\d+$/i.test(requestedName))) {
      return requestedName;
    }

    let nextNumber = existingNames.reduce((max, name) => {
      const match = name.match(/^Project\s+(\d+)$/i);
      if (!match) {
        return max;
      }

      return Math.max(max, Number.parseInt(match[1] ?? "0", 10));
    }, 0) + 1;
    let candidate = `Project ${nextNumber}`;

    while (existingNameSet.has(candidate)) {
      nextNumber += 1;
      candidate = `Project ${nextNumber}`;
    }

    return candidate;
  }

  async updateProject(userId: number, projectId: string, input: UpdatePptProjectInput): Promise<PptProjectSummary> {
    const project = await this.getOwnedProject(userId, projectId);
    const nextName = this.normalizeOptionalString(input.name) ?? project.name;
    const nextTemplateId =
      input.templateId === null || input.templateId === ""
        ? null
        : this.normalizeOptionalString(input.templateId) ?? project.template_id;
    await this.assertKnownV2TemplateId(nextTemplateId);

    const result = await this.databaseService.query<ProjectRow>(
      `
        UPDATE ppt_projects
        SET name = $3, template_id = $4, updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, name, template_id, status, created_at, updated_at
      `,
      [projectId, userId, nextName, nextTemplateId]
    );

    const updatedProject = result.rows[0];
    if (!updatedProject) {
      throw new NotFoundException("PPT 项目不存在。");
    }

    return this.mapProject(updatedProject);
  }

  async deleteProject(userId: number, projectId: string) {
    await this.getOwnedProject(userId, projectId);
    await this.databaseService.query("DELETE FROM ppt_projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
    return { success: true };
  }

  async listTemplates() {
    const registry = await this.htmlPptV2RegistryService.hydrate();
    const templateEntries = await Promise.all(registry.templatePackages.map(async (template) => {
      const donor = registry.donors.find((item) => item.id === template.donorTemplateId);
      const previewSlides = donor ? await this.readTemplatePreviewSlides(donor.dir) : [];
      return {
        id: template.id,
        label: template.label["zh-CN"],
        labelI18n: template.label,
        description: template.description["zh-CN"],
        descriptionI18n: template.description,
        emoji: this.templateEmoji(template.id),
        desc: template.description["zh-CN"],
        donorTemplateId: template.donorTemplateId,
        themeId: template.themeId,
        themeAlternates: template.themeAlternates,
        layoutPolicy: template.layoutPolicy,
        audienceFit: template.audienceFit,
        formatFit: template.formatFit,
        toneFit: template.toneFit,
        defaultDensity: template.defaultDensity,
        defaultSlideCount: template.defaultSlideCount,
        thumbnailFile: template.thumbnailFile,
        aspectRatio: template.aspectRatio,
        rendererProfile: template.rendererProfile,
        isAuto: false,
        deckClass: template.deckClass,
        previewCss: donor?.css,
        previewSlides
      };
    }));

    return [
      {
        id: "auto",
        label: "灵活模板",
        labelI18n: { "zh-CN": "灵活模板", en: "Flexible Template" },
        description: "由系统根据主题、受众和格式自动选择最合适的模板。",
        descriptionI18n: {
          "zh-CN": "由系统根据主题、受众和格式自动选择最合适的模板。",
          en: "The system selects the best template from your topic, audience, and format."
        },
        emoji: "AUTO",
        desc: "自动选择最匹配模板",
        donorTemplateId: null,
        themeId: null,
        themeAlternates: [],
        layoutPolicy: null,
        audienceFit: [],
        formatFit: [],
        toneFit: [],
        defaultDensity: "balanced",
        defaultSlideCount: 10,
        thumbnailFile: null,
        aspectRatio: null,
        rendererProfile: null,
        isAuto: true,
        deckClass: undefined,
        previewCss: undefined,
        previewSlides: []
      },
      ...templateEntries
    ];
  }

  private async readTemplatePreviewSlides(templateDir: string) {
    const html = await readFile(resolve(templateDir, "index.html"), "utf8").catch(() => "");
    return extractHtmlSections(html);
  }

  private templateEmoji(templateId: string) {
    const mapping: Record<string, string> = {
      "pitch-deck": "VC",
      "product-launch": "PL",
      "tech-sharing": "TS",
      "weekly-report": "WR",
      "course-module": "EDU",
      "xhs-post": "XHS",
      "presenter-mode-reveal": "PM",
      "xhs-white-editorial": "WE",
      "graphify-dark-graph": "GD",
      "knowledge-arch-blueprint": "BP",
      "hermes-cyber-terminal": "CT",
      "obsidian-claude-gradient": "OG",
      "xhs-pastel-card": "XP",
      "dir-key-nav-minimal": "NAV",
      "testing-safety-alert": "SA"
    };
    return mapping[templateId] ?? "TPL";
  }

  private normalizeV2TemplateId(templateId?: string | null) {
    return normalizeTemplatePackageId(templateId);
  }

  private resolvePinnedV2Template(registry: SkillRegistry, templateId?: string | null): TemplatePackage | undefined {
    const resolution = resolveTemplatePackageSelection(registry, templateId);
    if (resolution.kind === "auto") {
      return undefined;
    }
    if (resolution.kind === "unknown") {
      throw new BadRequestException(`未知的 HTML-PPT v2 模板：${resolution.templateId}。请重新选择模板或使用 Auto。`);
    }
    return resolution.template;
  }

  private async assertKnownV2TemplateId(templateId?: string | null) {
    const normalized = this.normalizeV2TemplateId(templateId);
    if (!normalized) {
      return;
    }
    const registry = await this.htmlPptV2RegistryService.hydrate();
    this.resolvePinnedV2Template(registry, normalized);
  }

  async listMessages(userId: number, projectId: string): Promise<PptMessageDto[]> {
    await this.getOwnedProject(userId, projectId);
    const result = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [projectId]
    );

    return Promise.all(result.rows.map((row) => this.mapMessageForResponse(row)));
  }

  async sendMessage(userId: number, projectId: string, input: SendPptMessageInput) {
    const project = await this.getOwnedProject(userId, projectId);
    const content = this.normalizeRequiredString(input.content, "content");
    const files = this.normalizeFiles(input.files);
    const template = this.normalizeTemplate(input.template, project.template_id);
    const shouldGenerateDeckSpec = this.shouldGenerateDeckSpec(content);
    if (shouldGenerateDeckSpec) {
      await this.assertKnownV2TemplateId(template?.id ?? project.template_id);
    }
    const userMessageId = randomUUID();
    const pendingUserMessage: PptMessageDto = {
      id: userMessageId,
      role: "user",
      content,
      files,
      template,
      createdAt: new Date().toISOString()
    };

    await this.maybeCompressConversation(userId, projectId);
    const context = await this.buildConversationContext(userId, projectId);
    await this.databaseService.query(
      `
        INSERT INTO ppt_messages (id, project_id, role, content, meta, created_at)
        VALUES ($1, $2, 'user', $3, $4::jsonb, NOW())
      `,
      [userMessageId, projectId, content, JSON.stringify({ files, template })]
    );
    await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [projectId]);

    const assistantMessageId = randomUUID();
    const pipeline: DeckPipeline = "v2";

    if (shouldGenerateDeckSpec) {
      const orchestration = await this.createQueuedDeckOrchestration(undefined, {
        version: "orchestrator-v2",
        name: "00 v2 后台任务排队",
        detail: "已创建 HTML-PPT v2 IR 编排任务，等待执行结构化生成。"
      });
      await this.insertAssistantMessage(
        projectId,
        assistantMessageId,
        this.formatDeckProgressMessage("已进入后台编排队列，页面会自动刷新进度。", orchestration, "running"),
        {
          orchestration,
          generationStatus: "running",
          pipeline: "html-ppt-v2",
          sourceUserMessageId: userMessageId
        }
      );
      await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [projectId]);

      this.startDeckGenerationJob({
        userId,
        projectId,
        projectName: project.name,
        context,
        pendingUserMessage,
        assistantMessageId,
        pipeline
      });

      return {
        project: this.mapProject(await this.getOwnedProject(userId, projectId)),
        messages: await this.listMessages(userId, projectId)
      };
    }

    const assistantContent = await this.generateAssistantMessage(
      userId,
      project.name,
      context,
      pendingUserMessage,
      projectId,
      assistantMessageId
    );
    await this.insertAssistantMessage(projectId, assistantMessageId, assistantContent, { generationStatus: "completed" });

    await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [projectId]);
    await this.maybeCompressConversation(userId, projectId);

    return {
      project: this.mapProject(await this.getOwnedProject(userId, projectId)),
      messages: await this.listMessages(userId, projectId)
    };
  }

  private async insertAssistantMessage(
    projectId: string,
    assistantMessageId: string,
    content: string,
    meta: Record<string, unknown>
  ) {
    await this.databaseService.query(
      `
        INSERT INTO ppt_messages (id, project_id, role, content, meta, created_at)
        VALUES ($1, $2, 'assistant', $3, $4::jsonb, NOW())
      `,
      [assistantMessageId, projectId, content, JSON.stringify(meta)]
    );
  }

  private async updateAssistantMessage(
    assistantMessageId: string,
    content: string,
    meta: Record<string, unknown>
  ) {
    await this.databaseService.query(
      "UPDATE ppt_messages SET content = $2, meta = $3::jsonb WHERE id = $1",
      [assistantMessageId, content, JSON.stringify(meta)]
    );
  }

  private async createQueuedDeckOrchestration(
    base?: PptGenerationOrchestration | null,
    options?: { name?: string; detail?: string; version?: string }
  ): Promise<PptGenerationOrchestration> {
    const activeConfig = base ? null : await this.llmConfigService.getActiveConfig();
    const now = new Date().toISOString();
    const previousSteps = (base?.steps ?? []).filter((step) => step.status !== "running");
    return {
      version: base?.version ?? options?.version ?? "orchestrator-v1",
      model: base?.model ?? activeConfig?.model ?? "unknown",
      startedAt: base?.startedAt ?? now,
      finishedAt: now,
      totalModelCalls: base?.totalModelCalls ?? 0,
      steps: [
        ...previousSteps,
        {
          id: `step-${previousSteps.length + 1}`,
          name: options?.name ?? "00 后台任务排队",
          status: "running",
          startedAt: now,
          endedAt: now,
          detail: options?.detail ?? "已创建后台编排任务，等待执行任务规划。"
        }
      ]
    };
  }

  private startDeckGenerationJob(job: DeckGenerationJob) {
    void this.runDeckGenerationJob(job).catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : "Deck 后台编排执行失败。";
      const existing = await this.getMessageMeta(job.assistantMessageId);
      const orchestration = this.normalizeStoredOrchestration(existing?.orchestration);
      await this.updateAssistantMessage(
        job.assistantMessageId,
        this.formatDeckSpecFailureMessage(errorMessage, orchestration),
        {
          ...(existing ?? {}),
          orchestration,
          generationError: errorMessage,
          generationStatus: "failed",
          sourceUserMessageId: job.pendingUserMessage.id
        }
      );
    });
  }

  private async runDeckGenerationJob(job: DeckGenerationJob) {
    let currentMeta: Record<string, unknown> = (await this.getMessageMeta(job.assistantMessageId)) ?? {};
    let generationCheckpoint: DeckResumeCheckpoint | null = null;
    let agentCheckpoint: HtmlPptAgentCheckpoint | null = null;
    let v2Checkpoint = job.resume?.v2Checkpoint ?? this.normalizeStoredV2Checkpoint(currentMeta.v2Checkpoint);
    const pipeline: DeckPipeline = "v2";

    const updateAssistantMessage = async (contentValue: string, metaValue: Record<string, unknown>) => {
      currentMeta = metaValue;
      await this.updateAssistantMessage(job.assistantMessageId, contentValue, metaValue);
    };

    let generatedDeckSpec: PptDeckSpec | null = null;
    let generatedDeckRender: PptDeckRender | null = null;
    let orchestration: PptGenerationOrchestration | null =
      job.resume?.orchestration ?? this.normalizeStoredOrchestration(currentMeta.orchestration) ?? null;
    let generationError: string | null = null;
    let assistantContent = "";

    try {
      const result = await this.orchestrateDeckGenerationV2(
        job.userId,
        job.projectId,
        job.assistantMessageId,
        job.projectName,
        job.context,
        job.pendingUserMessage,
        async (progress) => {
          v2Checkpoint = progress.v2Checkpoint ?? v2Checkpoint;
          await updateAssistantMessage(progress.content, {
            ...currentMeta,
            orchestration: progress.orchestration,
            generationStatus: progress.generationStatus,
            v2Checkpoint,
            pipeline: "html-ppt-v2",
            sourceUserMessageId: job.pendingUserMessage.id
          });
          await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [job.projectId]);
        },
        job.resume
      );
      generatedDeckSpec = result.deckSpec;
      generatedDeckRender = result.deckRender;
      orchestration = result.orchestration;
      assistantContent = this.formatDeckSpecAssistantMessage(result.deckSpec, result.deckRender, result.orchestration);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Deck 编排执行失败。";
      if (error instanceof DeckOrchestrationError) {
        orchestration = error.orchestration;
        generationCheckpoint = error.checkpoint ?? generationCheckpoint;
      } else if (error instanceof HtmlPptAgentResumeError) {
        orchestration = error.orchestration;
        agentCheckpoint = error.checkpoint ?? agentCheckpoint;
      } else {
        orchestration = this.normalizeStoredOrchestration(currentMeta.orchestration) ?? orchestration;
      }
      generationError = errorMessage;
      assistantContent = this.formatDeckSpecFailureMessage(errorMessage, orchestration);
    }

    const assistantMeta: Record<string, unknown> = {
      ...currentMeta,
      pipeline: "html-ppt-v2",
      sourceUserMessageId: job.pendingUserMessage.id
    };
    if (generatedDeckSpec) {
      assistantMeta.deckSpec = generatedDeckSpec;
    }
    if (generatedDeckRender) {
      assistantMeta.deckRender = generatedDeckRender;
    }
    if (orchestration) {
      assistantMeta.orchestration = orchestration;
    }
    if (generationCheckpoint) {
      assistantMeta.generationCheckpoint = generationCheckpoint;
    }
    if (agentCheckpoint) {
      assistantMeta.agentCheckpoint = agentCheckpoint;
    }
    if (v2Checkpoint) {
      assistantMeta.v2Checkpoint = v2Checkpoint;
    }
    if (generationError) {
      assistantMeta.generationError = generationError;
    } else {
      delete assistantMeta.generationError;
    }
    assistantMeta.generationStatus = generationError ? "failed" : "completed";
    if (!generationError) {
      delete assistantMeta.generationCheckpoint;
      delete assistantMeta.agentCheckpoint;
      delete assistantMeta.v2Checkpoint;
    }

    await updateAssistantMessage(assistantContent, assistantMeta);
    await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [job.projectId]);
    await this.maybeCompressConversation(job.userId, job.projectId);
  }

  private async getMessageMeta(messageId: string): Promise<Record<string, unknown> | null> {
    const result = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE id = $1
        LIMIT 1
      `,
      [messageId]
    );
    return result.rows[0]?.meta ?? null;
  }

  async resumeMessageGeneration(
    userId: number,
    projectId: string,
    messageId: string,
    input: ResumePptMessageInput = {}
  ) {
    const project = await this.getOwnedProject(userId, projectId);
    const messageResult = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1 AND id = $2
        LIMIT 1
      `,
      [projectId, messageId]
    );
    const assistantRow = messageResult.rows[0];

    if (!assistantRow || assistantRow.role !== "assistant") {
      throw new NotFoundException("未找到可继续执行的助手消息。");
    }

    const originalMeta = assistantRow.meta ?? {};
    const resumeMode = this.normalizeResumeMode(input.mode);
    const currentStatus = this.normalizeOptionalString(originalMeta.generationStatus);
    const existingOrchestration = this.normalizeStoredOrchestration(originalMeta.orchestration);
    const staleRunning = currentStatus === "running" && this.isStaleRunningOrchestration(existingOrchestration);
    if (currentStatus === "running" && !staleRunning) {
      throw new BadRequestException("当前任务仍在运行中，不能重复继续。");
    }

    const completedDeckRender = this.normalizeStoredDeckRender(originalMeta.deckRender);
    if (completedDeckRender && resumeMode !== "template") {
      throw new BadRequestException("该任务已经完成，无需继续生成。");
    }

    if (staleRunning && existingOrchestration) {
      const staleOrchestration = this.markStaleRunningOrchestration(existingOrchestration);
      originalMeta.orchestration = staleOrchestration;
      originalMeta.generationStatus = "failed";
      originalMeta.generationError = this.staleRunningMessage();
    }

    let v2Checkpoint = this.normalizeStoredV2Checkpoint(originalMeta.v2Checkpoint);
    const pipeline: DeckPipeline = "v2";
    const sourceUserMessage = await this.resolveSourceUserMessage(
      projectId,
      assistantRow,
      v2Checkpoint?.sourceUserMessageId ?? this.normalizeOptionalString(originalMeta.sourceUserMessageId)
    );
    let pendingUserMessage =
      v2Checkpoint?.pendingUserMessage ??
      this.mapMessage(sourceUserMessage);
    let context = v2Checkpoint?.context ?? await this.buildConversationContextBeforeMessage(userId, projectId, sourceUserMessage);
    let queueName = "00 v2 后台任务恢复排队";
    let queueDetail = "已恢复 HTML-PPT v2 编排任务，等待后台重新执行结构化生成。";

    if (resumeMode === "template") {
      if (!completedDeckRender?.outputDir) {
        throw new BadRequestException("该消息缺少可复用的 v2 输出目录，无法按新模板重跑。");
      }
      const registry = await this.htmlPptV2RegistryService.hydrate();
      const templateId = this.normalizeV2TemplateId(this.normalizeOptionalString(input.templateId));
      const pinnedTemplate = this.resolvePinnedV2Template(registry, templateId);
      if (!templateId || !pinnedTemplate) {
        throw new BadRequestException("请先选择一个有效的非 Auto v2 模板。");
      }
      const deck = await this.readV2DeckIrFromRender(completedDeckRender);
      const templateMessage = this.messageTemplateFromPackage(pinnedTemplate);
      pendingUserMessage = {
        ...pendingUserMessage,
        template: templateMessage
      };
      context = await this.buildConversationContextBeforeMessage(userId, projectId, sourceUserMessage);
      v2Checkpoint = this.buildV2TemplateRerunCheckpoint({
        sourceUserMessageId: pendingUserMessage.id,
        projectName: project.name,
        pendingUserMessage,
        context,
        deck,
        registry,
        pinnedTemplate,
        outputRoot: this.htmlPptV2UserDeckRoot(userId)
      });
      queueName = "00 v2 模板重跑排队";
      queueDetail = `已选择模板 ${pinnedTemplate.label["zh-CN"]}，将复用前 3 阶段内容并从 04 Design 重新生成。`;
      await this.databaseService.query("UPDATE ppt_projects SET template_id = $2, updated_at = NOW() WHERE id = $1", [projectId, templateId]);
    }

    const orchestration = await this.createQueuedDeckOrchestration(
      existingOrchestration,
      {
        version: "orchestrator-v2",
        name: queueName,
        detail: queueDetail
      }
    );
    const assistantMeta: Record<string, unknown> = {
      ...originalMeta,
      orchestration,
      generationStatus: "running",
      pipeline: "html-ppt-v2",
      sourceUserMessageId: pendingUserMessage.id
    };
    if (v2Checkpoint) {
      assistantMeta.v2Checkpoint = v2Checkpoint;
    }
    delete assistantMeta.generationError;
    if (resumeMode === "template") {
      delete assistantMeta.deckSpec;
      delete assistantMeta.deckRender;
      delete assistantMeta.generationCheckpoint;
      delete assistantMeta.agentCheckpoint;
      assistantMeta.template = pendingUserMessage.template;
    }

    await this.updateAssistantMessage(
      messageId,
      this.formatDeckProgressMessage(
        resumeMode === "template"
          ? "已进入 HTML-PPT v2 模板重跑队列，页面会自动刷新进度。"
          : "已重新进入 HTML-PPT v2 后台编排队列，页面会自动刷新进度。",
        orchestration,
        "running"
      ),
      assistantMeta
    );
    await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [projectId]);

    this.startDeckGenerationJob({
      userId,
      projectId,
      projectName: project.name,
      context,
      pendingUserMessage,
      assistantMessageId: messageId,
      pipeline,
      resume: {
        v2Checkpoint: v2Checkpoint ?? undefined,
        orchestration
      }
    });

    return {
      project: this.mapProject(await this.getOwnedProject(userId, projectId)),
      messages: await this.listMessages(userId, projectId)
    };
  }

  private async orchestrateDeckGenerationV2(
    userId: number,
    projectId: string,
    assistantMessageId: string,
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    onProgress?: (progress: DeckProgressUpdate) => Promise<void>,
    resume?: {
      v2Checkpoint?: HtmlPptV2ChatCheckpoint;
      orchestration?: PptGenerationOrchestration;
    }
  ): Promise<{
    deckSpec: PptDeckSpec;
    deckRender: PptDeckRender;
    orchestration: PptGenerationOrchestration;
    checkpoint?: undefined;
  }> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const registry = await this.htmlPptV2RegistryService.hydrate();
    const selectedTemplateId = this.normalizeV2TemplateId(pendingUserMessage.template?.id);
    const requestedPinnedTemplate = this.resolvePinnedV2Template(registry, selectedTemplateId);
    const startedAt = resume?.orchestration?.startedAt ?? new Date().toISOString();
    const steps: PptGenerationStep[] = (resume?.orchestration?.steps ?? [])
      .filter((step) => step.status !== "running")
      .map((step, index) => ({ ...step, id: step.id || `step-${index + 1}` }));
    const checkpoint = resume?.v2Checkpoint?.registryHash === registry.hash ? resume.v2Checkpoint : undefined;
    const outputRoot = this.htmlPptV2UserDeckRoot(userId);
    let deckId = checkpoint?.deckId ?? randomUUID();
    let outputDir = checkpoint?.outputDir ?? resolve(outputRoot, deckId);
    let nextStage: HtmlPptV2ResumeStage = checkpoint?.nextStage ?? "01-intent";
    let intent = checkpoint?.intent;
    let templateSelection = checkpoint?.templateSelection;
    let selectedTemplate = templateSelection?.selectedTemplate ?? requestedPinnedTemplate;
    let evidence = checkpoint?.evidence;
    let narrative = checkpoint?.narrative;
    let design = checkpoint?.design;
    let layoutPlan = checkpoint?.layoutPlan;
    let slots = checkpoint?.slots;
    let assets = checkpoint?.assets;
    let choreography = checkpoint?.choreography;
    let deckBeforeCritic = checkpoint?.deckBeforeCritic;
    let deck = checkpoint?.deck;
    let verification = checkpoint?.verification;
    let auxiliary = checkpoint?.auxiliary;
    if (!templateSelection && nextStage !== "01-intent" && selectedTemplate) {
      templateSelection = {
        selectedTemplate,
        source: requestedPinnedTemplate ? "pinned" : "auto-deterministic",
        attempts: 0,
        shortlist: [{
          id: selectedTemplate.id,
          deterministicScore: requestedPinnedTemplate ? 999 : 0,
          reason: requestedPinnedTemplate ? "Recovered explicit pinned template on resume." : "Recovered selected template on resume."
        }],
        rationale: requestedPinnedTemplate ? `Recovered pinned template '${selectedTemplate.id}'.` : `Recovered selected template '${selectedTemplate.id}'.`,
        confidence: requestedPinnedTemplate ? "high" : "medium",
        validationErrors: []
      };
    }
    if (!templateSelection && nextStage !== "01-intent") {
      nextStage = intent ? "01b-template-select" : "01-intent";
    }
    const checkpointTrace = checkpoint?.trace;
    const trace: HtmlPptV2TraceCheckpoint = {
      ...checkpointTrace,
      stageAttempts: {
        intent: 0,
        templateSelection: 0,
        evidence: 0,
        narrative: 0,
        design: 0,
        layoutPlan: 0,
        slotFill: 0,
        critic: 0,
        ...(checkpointTrace?.stageAttempts ?? {})
      },
      modelCalls: checkpointTrace?.modelCalls ?? 0,
      warnings: [...(checkpointTrace?.warnings ?? [])],
      renderRemediation: checkpointTrace?.renderRemediation ?? defaultRenderRemediationTrace()
    };
    let currentRunningStep: PptGenerationStep | null = null;
    let currentRunningStepModelCallStart = trace.modelCalls;

    const stepDurationMs = (startedAtValue: string, endedAtValue: string) => {
      const start = Date.parse(startedAtValue);
      const end = Date.parse(endedAtValue);
      return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    };

    const observedRunningStep = () => {
      if (!currentRunningStep) return null;
      const now = new Date().toISOString();
      const modelCalls = Math.max(0, trace.modelCalls - currentRunningStepModelCallStart);
      return {
        ...currentRunningStep,
        endedAt: now,
        durationMs: stepDurationMs(currentRunningStep.startedAt, now),
        modelCalls,
        retryCount: Math.max(0, modelCalls - 1)
      };
    };

    try {
      const model = new HtmlPptV2JsonModelClient({
        config: activeConfig,
        userId,
        projectId,
        messageId: assistantMessageId,
        logger: this.logger,
        loggingService: this.llmLoggingService
      });

      const buildCheckpoint = (): HtmlPptV2ChatCheckpoint => ({
        version: "html-ppt-v2-checkpoint-v1",
        sourceUserMessageId: pendingUserMessage.id,
        projectName,
        pendingUserMessage,
        context,
        nextStage,
        deckId,
        outputDir,
        registryHash: registry.hash,
        intent,
        templateSelection,
        evidence,
        narrative,
        design,
        layoutPlan,
        slots,
        assets,
        choreography,
        deckBeforeCritic,
        deck,
        verification,
        auxiliary,
        trace,
        updatedAt: new Date().toISOString()
      });
      const progressOrchestration = (): PptGenerationOrchestration => ({
        version: "orchestrator-v2",
        model: activeConfig.model,
        startedAt,
        finishedAt: new Date().toISOString(),
        totalModelCalls: trace.modelCalls,
        steps: currentRunningStep ? [...steps, observedRunningStep()!]
          : steps
      });
      const publishProgress = async (detail: string, status: DeckProgressUpdate["generationStatus"]) => {
        await onProgress?.({
          content: this.formatDeckProgressMessage(detail, progressOrchestration(), status),
          orchestration: progressOrchestration(),
          generationStatus: status,
          v2Checkpoint: buildCheckpoint()
        });
      };

      const runStep = async <T>(
        stage: HtmlPptV2ResumeStage,
        name: string,
        next: HtmlPptV2ResumeStage,
        action: () => Promise<{ value: T; detail: string }>
      ): Promise<T> => {
        const stepStart = new Date().toISOString();
        currentRunningStepModelCallStart = trace.modelCalls;
        currentRunningStep = {
          id: `step-${steps.length + 1}`,
          name,
          status: "running",
          startedAt: stepStart,
          endedAt: stepStart,
          detail: `正在执行 ${name}，完成后会写入 v2 checkpoint。`,
          durationMs: 0,
          modelCalls: 0,
          retryCount: 0
        };
        nextStage = stage;
        await publishProgress(`${name} 进行中。`, "running");
        try {
          const result = await action();
          const endedAt = new Date().toISOString();
          const modelCalls = Math.max(0, trace.modelCalls - currentRunningStepModelCallStart);
          currentRunningStep = null;
          steps.push({
            id: `step-${steps.length + 1}`,
            name,
            status: "completed",
            startedAt: stepStart,
            endedAt,
            detail: result.detail,
            durationMs: stepDurationMs(stepStart, endedAt),
            modelCalls,
            retryCount: Math.max(0, modelCalls - 1)
          });
          nextStage = next;
          await publishProgress(result.detail, "running");
          return result.value;
        } catch (error) {
          const endedAt = new Date().toISOString();
          const modelCalls = Math.max(0, trace.modelCalls - currentRunningStepModelCallStart);
          const failureReason = error instanceof Error ? error.message : `${name} 失败。`;
          currentRunningStep = null;
          steps.push({
            id: `step-${steps.length + 1}`,
            name,
            status: "failed",
            startedAt: stepStart,
            endedAt,
            detail: failureReason,
            durationMs: stepDurationMs(stepStart, endedAt),
            modelCalls,
            retryCount: Math.max(0, modelCalls - 1),
            failureReason
          });
          await publishProgress(failureReason, "failed");
          throw error;
        }
      };

      await publishProgress(
        checkpoint
          ? `已读取 v2 checkpoint，准备从 ${nextStage} 继续。`
          : "v2 IR 编排已启动。",
        "running"
      );

      if (!intent || nextStage === "01-intent") {
        const result = await runStep("01-intent", "01 Intent", "01b-template-select", async () => {
          const value = await runIntentStage({
            userPrompt: pendingUserMessage.content,
            conversationContext: this.v2ConversationContext(context),
            userPreferences: { projectName, templateId: selectedTemplateId ?? "auto" },
            model
          });
          intent = value.intent;
          trace.intentSource = value.source;
          trace.stageAttempts.intent = value.attempts;
          trace.modelCalls += value.attempts;
          return { value: value.intent, detail: `Intent 完成：${value.intent.topic}，${value.intent.derivedSlideCount} 页。` };
        });
        intent = result;
      }

      if (!templateSelection || nextStage === "01b-template-select") {
        if (!intent) throw new ServiceUnavailableException("缺少 IntentIR，无法执行 Template Select。");
        const result = await runStep("01b-template-select", "01b Template Select", "02-evidence", async () => {
          const value = await runTemplateSelectionStage({
            intent: intent!,
            registry,
            rawPrompt: pendingUserMessage.content,
            pinnedTemplate: requestedPinnedTemplate,
            model
          });
          templateSelection = value;
          selectedTemplate = value.selectedTemplate;
          trace.templateSelectionSource = value.source;
          trace.templateSelection = this.v2TemplateSelectionTrace(value);
          trace.stageAttempts.templateSelection = value.attempts;
          trace.modelCalls += value.attempts;
          trace.warnings.push(...value.validationErrors.map((issue) => `template-select: ${issue}`));
          return {
            value,
            detail: `Template Select 完成：source=${value.source}，template=${value.selectedTemplate.id}，shortlist=${value.shortlist.map((item) => item.id).join(", ")}。`
          };
        });
        templateSelection = result;
        selectedTemplate = result.selectedTemplate;
      }

      if (!evidence || nextStage === "02-evidence") {
        if (!intent) throw new ServiceUnavailableException("缺少 IntentIR，无法执行 Evidence。");
        const result = await runStep("02-evidence", "02 Evidence", "03-narrative", async () => {
          const value = await runEvidenceStage({ intent: intent!, model });
          evidence = value.evidence;
          trace.evidenceSource = value.source;
          trace.stageAttempts.evidence = value.attempts;
          trace.modelCalls += value.attempts;
          trace.warnings.push(...value.researchErrors);
          return { value: value.evidence, detail: `Evidence 完成：${value.evidence.facts.length} facts，${value.evidence.dataPoints.length} data points。` };
        });
        evidence = result;
      }

      if (!narrative || nextStage === "03-narrative") {
        if (!intent || !evidence) throw new ServiceUnavailableException("缺少 Intent/Evidence，无法执行 Narrative。");
        const result = await runStep("03-narrative", "03 Narrative", "04-design", async () => {
          const value = await runNarrativeStage({ intent: intent!, evidence: evidence!, model });
          narrative = value.narrative;
          trace.narrativeSource = value.source;
          trace.stageAttempts.narrative = value.attempts;
          trace.modelCalls += value.attempts;
          return { value: value.narrative, detail: `Narrative 完成：${value.narrative.slides.length} slides，${value.narrative.totalEstimatedChars} chars。` };
        });
        narrative = result;
      }

      if (!design || nextStage === "04-design") {
        if (!intent || !evidence || !narrative) throw new ServiceUnavailableException("缺少 Intent/Evidence/Narrative，无法执行 Design。");
        const result = await runStep("04-design", "04 Design", "05-layout", async () => {
          const value = await runDesignStage({ intent: intent!, evidence: evidence!, narrative: narrative!, registry, pinnedTemplate: selectedTemplate, model });
          design = value.design;
          trace.designSource = value.source;
          trace.stageAttempts.design = value.attempts;
          trace.modelCalls += value.attempts;
          return { value: value.design, detail: `Design 完成：theme=${value.design.themeId}，donor=${value.design.donorTemplateId}。` };
        });
        design = result;
      }

      if (!layoutPlan || nextStage === "05-layout") {
        if (!intent || !narrative || !design) throw new ServiceUnavailableException("缺少 Intent/Narrative/Design，无法执行 Layout。");
        const result = await runStep("05-layout", "05 Layout", "06-slots", async () => {
          const value = await runLayoutPlanStage({ intent: intent!, narrative: narrative!, design: design!, registry, pinnedTemplate: selectedTemplate, model });
          layoutPlan = value.layoutPlan;
          trace.layoutPlanSource = value.source;
          trace.stageAttempts.layoutPlan = value.attempts;
          trace.modelCalls += value.attempts;
          return { value: value.layoutPlan, detail: `Layout 完成：${value.layoutPlan.map((item) => item.layoutId).join(", ")}。` };
        });
        layoutPlan = result;
      }

      if (!slots || nextStage === "06-slots") {
        if (!intent || !evidence || !narrative || !design || !layoutPlan) throw new ServiceUnavailableException("缺少前置 IR，无法执行 Slots。");
        const result = await runStep("06-slots", "06 Slots", "07-assets", async () => {
          const value = await runSlotFillStage({ intent: intent!, evidence: evidence!, narrative: narrative!, design: design!, layoutPlan: layoutPlan!, model });
          slots = value.slots;
          trace.slotFillSource = value.source;
          trace.stageAttempts.slotFill = value.attempts;
          trace.modelCalls += value.attempts;
          return { value: value.slots, detail: `Slots 完成：${value.slots.length} 个结构化页面填槽。` };
        });
        slots = result;
      }

      if (!assets || nextStage === "07-assets") {
        if (!slots || !design || !evidence) throw new ServiceUnavailableException("缺少 Slots/Design/Evidence，无法执行 Assets。");
        const result = await runStep("07-assets", "07 Assets", "08-choreography", async () => {
          const value = await runAssetStage({ slots: slots!, design: design!, evidence: evidence! });
          assets = value.assets;
          trace.assetSource = value.source;
          trace.warnings.push(...value.warnings);
          return { value: value.assets, detail: `Assets 完成：${Object.keys(value.assets).length} 个资产。` };
        });
        assets = result;
      }

      if (!choreography || nextStage === "08-choreography") {
        if (!narrative || !design || !slots) throw new ServiceUnavailableException("缺少 Narrative/Design/Slots，无法执行 Choreography。");
        const result = await runStep("08-choreography", "08 Choreography", "09-critic", async () => {
          const value = await runChoreographyStage({ narrative: narrative!, design: design!, slots: slots! });
          choreography = value.choreography;
          trace.choreographySource = value.source;
          trace.warnings.push(...value.warnings);
          return { value: value.choreography, detail: `Choreography 完成：${value.choreography.length} 个动画条目。` };
        });
        choreography = result;
      }

      if (!deck || nextStage === "09-critic") {
        if (!intent || !evidence || !narrative || !design || !layoutPlan || !slots || !assets || !choreography) {
          throw new ServiceUnavailableException("缺少完整 IR，无法执行 Critic。");
        }
        const result = await runStep("09-critic", "09 Critic", "10-render", async () => {
          deckBeforeCritic = deckIrSchema.parse({
            intent,
            evidence,
            narrative,
            design,
            layoutPlan,
            slots,
            assets,
            choreography,
            meta: {
              irVersion: "v1",
              revisionRound: 0,
              qualityScores: {
                // Stage 9 Critic owns real scoring. Keep pre-critic values neutral so
                // checkpoint/debug artifacts never imply an unevaluated quality score.
                factual: 0,
                narrative: 0,
                visual: 0,
                density: 0,
                accessibility: 0,
                overall: 0
              },
              generatedAt: new Date().toISOString(),
              checkpoints: this.v2DeckCheckpoints(trace, intent!, evidence!, narrative!, design!, layoutPlan!, slots!, assets!, choreography!)
            }
          });
          const value = await runCriticStage({ deck: deckBeforeCritic, model });
          deck = value.deck;
          trace.criticSource = value.source;
          trace.criticRounds = value.reports.length;
          trace.stageAttempts.critic = value.attempts;
          trace.modelCalls += value.attempts;
          trace.warnings.push(...value.warnings);
          return { value: value.deck, detail: `Critic 完成：rounds=${value.reports.length}，score=${value.deck.meta.qualityScores.overall}。` };
        });
        deck = result;
      }

      if (!trace.renderSource || nextStage === "10-render" || !existsSync(join(outputDir, "index.html"))) {
        if (!deck) throw new ServiceUnavailableException("缺少 DeckIR，无法执行 Render。");
        await runStep("10-render", "10 Render", "11-verify", async () => {
          await mkdir(outputDir, { recursive: true });
          await this.htmlPptV2Renderer.renderToDirectory(deck!, { outputDir, registryHash: registry.hash, registry });
          trace.renderSource = "deterministic";
          trace.outputDir = outputDir;
          return { value: outputDir, detail: `Render 完成：${outputDir}` };
        });
      }

      if (!verification || nextStage === "11-verify") {
        if (!deck) throw new ServiceUnavailableException("缺少 DeckIR，无法执行 Verify。");
        const verifiedDeck = deck;
        const result = await runStep("11-verify", "11 Verify", "12-artifacts", async () => {
          const value = await runRenderVerificationStage({ outputDir, deck: verifiedDeck, registryHash: registry.hash });
          const remediation = await this.remediateV2RenderVerification({
            deck: verifiedDeck,
            verification: value,
            outputDir,
            registryHash: registry.hash,
            registry
          });
          deck = remediation.deck;
          verification = remediation.verification;
          trace.renderRemediation = remediation.trace;
          trace.verificationSource = remediation.verification.mode;
          if (remediation.verification.status === "failed") {
            throw new ServiceUnavailableException(`v2 render verification failed: ${remediation.verification.hardIssues.map((issue) => issue.message).join("；")}`);
          }
          const detail = remediation.trace.attempted
            ? `Verify 完成：status=${remediation.verification.status}，mode=${remediation.verification.mode}，render remediation=${remediation.trace.accepted ? "accepted" : "rejected"}，slides=${remediation.trace.slideIndexes.join(",") || "none"}。`
            : `Verify 完成：status=${remediation.verification.status}，mode=${remediation.verification.mode}，screenshots=${remediation.verification.screenshots.length}。`;
          return { value: remediation.verification, detail };
        });
        verification = result;
      }

      if (!auxiliary || nextStage === "12-artifacts") {
        if (!deck) throw new ServiceUnavailableException("缺少 DeckIR，无法执行 Artifacts。");
        const artifactDeck = deck;
        const result = await runStep("12-artifacts", "12 Artifacts", "13-publish", async () => {
          const value = await runAuxiliaryArtifactsStage({ deck: artifactDeck, outputDir });
          auxiliary = value;
          trace.auxiliarySource = value.source;
          trace.warnings.push(...value.warnings);
          return { value, detail: `Artifacts 完成：${Object.keys(value.artifacts).length} 个交付辅助文件。` };
        });
        auxiliary = result;
      }

      if (!deck || !verification || !auxiliary) {
        throw new ServiceUnavailableException("v2 publish 缺少必要结果。");
      }
      const finalStepStart = new Date().toISOString();
      const completedAt = new Date().toISOString();
      const finalTrace: HtmlPptV2PublishTrace = {
        intentSource: trace.intentSource ?? "fallback",
        templateSelectionSource: trace.templateSelectionSource ?? templateSelection?.source ?? "auto-deterministic",
        templateSelection: trace.templateSelection ?? (templateSelection ? this.v2TemplateSelectionTrace(templateSelection) : {
          chosenTemplateId: design?.donorTemplateId ?? "unknown",
          shortlist: [],
          rationale: "Template selection trace was not available.",
          confidence: "medium"
        }),
        evidenceSource: trace.evidenceSource ?? "fallback",
        narrativeSource: trace.narrativeSource ?? "fallback",
        designSource: trace.designSource ?? "fallback",
        layoutPlanSource: trace.layoutPlanSource ?? "fallback",
        slotFillSource: trace.slotFillSource ?? "fallback",
        assetSource: trace.assetSource ?? "deterministic",
        choreographySource: trace.choreographySource ?? "deterministic",
        criticSource: trace.criticSource ?? "deterministic",
        criticRounds: trace.criticRounds ?? 0,
        stageAttempts: trace.stageAttempts,
        modelCalls: trace.modelCalls,
        warnings: trace.warnings,
        renderSource: "deterministic",
        verificationSource: verification.mode,
        auxiliarySource: auxiliary.source,
        renderRemediation: trace.renderRemediation ?? defaultRenderRemediationTrace(),
        outputDir,
        files: this.v2PublishedFiles(outputDir, auxiliary)
      };
      const result: HtmlPptV2PublishResult = {
        deckId,
        deck,
        outputDir,
        verification,
        auxiliary,
        trace: finalTrace
      };
      steps.push({
        id: `step-${steps.length + 1}`,
        name: "13 Publish",
        status: "completed",
        startedAt: finalStepStart,
        endedAt: completedAt,
        detail: `Publish 完成：deckId=${deckId}，zip=${finalTrace.files.zip}。`,
        durationMs: stepDurationMs(finalStepStart, completedAt),
        modelCalls: 0,
        retryCount: 0
      });
      nextStage = "completed";
      trace.files = finalTrace.files;
      trace.outputDir = outputDir;
      const orchestration: PptGenerationOrchestration = {
        version: "orchestrator-v2",
        model: activeConfig.model,
        startedAt,
        finishedAt: completedAt,
        totalModelCalls: finalTrace.modelCalls,
        steps
      };
      const deckSpec = this.deckSpecFromV2Deck(result.deck);
      const deckRender = this.deckRenderFromV2Result(result);

      await onProgress?.({
        content: this.formatDeckSpecAssistantMessage(deckSpec, deckRender, orchestration),
        orchestration,
        generationStatus: "completed",
        v2Checkpoint: buildCheckpoint()
      });

      return { deckSpec, deckRender, orchestration, checkpoint: undefined };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const orchestration: PptGenerationOrchestration = {
        version: "orchestrator-v2",
        model: activeConfig.model,
        startedAt,
        finishedAt: failedAt,
        totalModelCalls: trace.modelCalls,
        steps
      };
      const message = error instanceof Error ? error.message : "HTML-PPT v2 编排失败。";
      throw new DeckOrchestrationError(message, orchestration);
    }
  }

  private async orchestrateDeckGeneration(
    userId: number,
    projectId: string,
    assistantMessageId: string,
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    onProgress?: (progress: DeckProgressUpdate) => Promise<void>,
    resume?: {
      checkpoint?: DeckResumeCheckpoint;
      agentCheckpoint?: HtmlPptAgentCheckpoint;
      orchestration?: PptGenerationOrchestration;
    }
  ) {
    if (process.env.PPT_USE_LEGACY_RENDERER !== "1") {
      const templateId = pendingUserMessage.template?.id ?? "auto";
      try {
        const result = await this.htmlPptAgentService.generateDeck(
          {
            userId,
            projectId,
            assistantMessageId,
            projectName,
            context,
            pendingUserMessage,
            templateId,
            theme: this.defaultThemeForTemplate(templateId)
          },
          async (progress: HtmlPptAgentProgress) => {
            await onProgress?.({
              content: progress.content,
              orchestration: progress.orchestration,
              generationStatus: progress.generationStatus,
              agentCheckpoint: progress.checkpoint
            });
          },
          {
            checkpoint: resume?.agentCheckpoint,
            orchestration: resume?.orchestration
          }
        );
        return {
          ...result,
          checkpoint: undefined
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "HtmlPptAgentError" &&
          "checkpoint" in error &&
          "orchestration" in error
        ) {
          const checkpoint = (error as Error & { checkpoint?: HtmlPptAgentCheckpoint }).checkpoint;
          const orchestration = (error as Error & { orchestration?: PptGenerationOrchestration }).orchestration;
          if (checkpoint && orchestration) {
            throw new HtmlPptAgentResumeError(error.message, orchestration, checkpoint);
          }
        }
        throw error;
      }
    }

    const activeConfig = await this.llmConfigService.getActiveConfig();
    const startedAt = resume?.orchestration?.startedAt ?? new Date().toISOString();
    const steps: PptGenerationStep[] = (resume?.orchestration?.steps ?? [])
      .filter((step) => step.status !== "running")
      .map((step, index) => ({ ...step, id: step.id || `step-${index + 1}` }));
    let totalModelCalls = resume?.orchestration?.totalModelCalls ?? 0;
    let currentRunningStep: PptGenerationStep | null = null;
    let templateId = resume?.checkpoint?.templateId ?? pendingUserMessage.template?.id ?? "auto";
    let theme = resume?.checkpoint?.theme ?? this.defaultThemeForTemplate(templateId);
    let nextStep: DeckResumeNextStep = resume?.checkpoint?.nextStep ?? "plan";
    let iteration = resume?.checkpoint?.iteration ?? 0;
    let plan: DeckPlan | undefined = resume?.checkpoint?.plan;
    let deckSpec: PptDeckSpec | undefined = resume?.checkpoint?.deckSpec;
    let localQa: LocalDeckQa | undefined = resume?.checkpoint?.localQa;
    let creativeStyle: PptDeckCreativeStyle | undefined = resume?.checkpoint?.creativeStyle;
    let review: DeckReview | undefined = resume?.checkpoint?.review;
    const modelTimeoutSeconds = Math.round(this.modelRequestTimeoutMs() / 1000);

    const buildCheckpoint = (): DeckResumeCheckpoint => ({
      version: "checkpoint-v1",
      sourceUserMessageId: pendingUserMessage.id,
      projectName,
      templateId,
      theme,
      nextStep,
      iteration,
      pendingUserMessage,
      context,
      plan,
      deckSpec,
      localQa,
      creativeStyle,
      review,
      updatedAt: new Date().toISOString()
    });

    const runStep = async <T>(
      name: string,
      action: () => Promise<{ value: T; detail: string }>
    ): Promise<T> => {
      let timeoutRetryCount = 0;

      while (true) {
        const stepStart = new Date().toISOString();
        const attemptName = timeoutRetryCount === 0 ? name : `${name}（超时续跑 #${timeoutRetryCount}）`;
        const runningDetail = timeoutRetryCount === 0
          ? `正在执行，等待 MiniMax 返回结果；单次模型请求上限 ${modelTimeoutSeconds} 秒。`
          : "上一轮请求已超时中断，正在基于上一阶段已完成结果重新发起本步骤。";
        currentRunningStep = {
          id: `step-${steps.length + 1}`,
          name: attemptName,
          status: "running",
          startedAt: stepStart,
          endedAt: stepStart,
          detail: runningDetail
        };
        await publishProgress(`${attemptName} 进行中。${runningDetail}`, "running");

        let heartbeatBusy = false;
        const publishHeartbeat = async () => {
          if (!currentRunningStep || heartbeatBusy) {
            return;
          }

          heartbeatBusy = true;
          try {
            const elapsedSeconds = Math.max(
              1,
              Math.round((Date.now() - new Date(stepStart).getTime()) / 1000)
            );
            const heartbeatDetail = [
              runningDetail,
              `已等待 ${elapsedSeconds} 秒，仍在等待 MiniMax 返回；后台任务未停止。`
            ].join(" ");
            currentRunningStep = {
              ...currentRunningStep,
              endedAt: new Date().toISOString(),
              detail: heartbeatDetail
            };
            await publishProgress(`${attemptName} 进行中。${heartbeatDetail}`, "running");
          } finally {
            heartbeatBusy = false;
          }
        };
        const heartbeat = setInterval(() => {
          void publishHeartbeat().catch(() => undefined);
        }, 15_000);

        try {
          const result = await action();
          clearInterval(heartbeat);
          currentRunningStep = null;
          steps.push({
            id: `step-${steps.length + 1}`,
            name: attemptName,
            status: "completed",
            startedAt: stepStart,
            endedAt: new Date().toISOString(),
            detail: result.detail
          });
          await publishProgress(result.detail, "running");
          return result.value;
        } catch (error) {
          clearInterval(heartbeat);
          currentRunningStep = null;
          if (this.isModelRequestTimeout(error) && timeoutRetryCount < 1) {
            timeoutRetryCount += 1;
            const timeoutDetail = [
              error instanceof Error ? error.message : "模型请求超时。",
              "已中断本次请求。由于 MiniMax 当前接口不是流式返回，无法读取超时请求的半成品；系统将基于上一阶段已完成结果自动续跑本步骤。"
            ].join(" ");
            steps.push({
              id: `step-${steps.length + 1}`,
              name: `${name}（超时中断 #${timeoutRetryCount}）`,
              status: "timeout",
              startedAt: stepStart,
              endedAt: new Date().toISOString(),
              detail: timeoutDetail
            });
            await publishProgress(timeoutDetail, "running");
            continue;
          }

          steps.push({
            id: `step-${steps.length + 1}`,
            name: attemptName,
            status: "failed",
            startedAt: stepStart,
            endedAt: new Date().toISOString(),
            detail: error instanceof Error ? error.message : "步骤失败。"
          });
          await publishProgress(error instanceof Error ? error.message : "步骤失败。", "failed");
          throw error;
        }
      }
    };

    const appendSkippedStep = (name: string, detail: string) => {
      const now = new Date().toISOString();
      steps.push({
        id: `step-${steps.length + 1}`,
        name,
        status: "skipped",
        startedAt: now,
        endedAt: now,
        detail
      });
    };

    const finalizeOrchestration = (): PptGenerationOrchestration => ({
      version: "orchestrator-v1",
      model: activeConfig.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalModelCalls,
      steps
    });

    const progressOrchestration = (): PptGenerationOrchestration => ({
      version: "orchestrator-v1",
      model: activeConfig.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalModelCalls,
      steps: currentRunningStep
        ? [...steps, { ...currentRunningStep, endedAt: new Date().toISOString() }]
        : steps
    });

    const publishProgress = async (detail: string, status: DeckProgressUpdate["generationStatus"]) => {
      if (!onProgress) {
        return;
      }

      const orchestration = progressOrchestration();
      await onProgress({
        content: this.formatDeckProgressMessage(detail, orchestration, status),
        orchestration,
        generationStatus: status,
        checkpoint: buildCheckpoint()
      });
    };

    try {
      await publishProgress(
        resume?.checkpoint
          ? `已恢复上次未完成任务，准备从 ${this.describeDeckResumeNextStep(nextStep, iteration)} 继续。`
          : "已接收提示词，正在启动 HTML-PPT 编排器。",
        "running"
      );

      if (!plan || nextStep === "plan") {
        plan = await runStep("01 任务规划", async () => {
          const generatedPlan = await this.generateDeckPlan(
            activeConfig,
            projectName,
            context,
            pendingUserMessage,
            templateId,
            theme,
            () => {
              totalModelCalls += 1;
            },
            {
              projectId,
              messageId: assistantMessageId,
              stage: "plan",
              source: "ppt-chat"
            }
          );
          nextStep = "draft";
          return {
            value: generatedPlan,
            detail: `规划完成：${generatedPlan.slidePlan.length} 个页面节点，视觉方向 ${generatedPlan.visualDirection}。`
          };
        });
      }

      if (!deckSpec || nextStep === "draft") {
        deckSpec = await runStep("02 生成初稿 DeckSpec", async () => {
          if (!plan) {
            throw new ServiceUnavailableException("缺少任务规划，无法生成 DeckSpec。");
          }

          const spec = await this.generateDeckSpec(projectName, context, pendingUserMessage, {
            plan,
            userId,
            logContext: {
              projectId,
              messageId: assistantMessageId,
              stage: "deckspec-draft",
              source: "ppt-chat"
            },
            onModelCall: (stage) => {
              totalModelCalls += 1;
              if (currentRunningStep) {
                const stageDetail = this.describeDeckSpecModelStage(stage);
                currentRunningStep = {
                  ...currentRunningStep,
                  endedAt: new Date().toISOString(),
                  detail: stageDetail
                };
                void publishProgress(`${currentRunningStep.name} 进行中。${stageDetail}`, "running").catch(() => undefined);
              }
            }
          });
          nextStep = "localQa";
          return {
            value: spec,
            detail: `初稿完成：${spec.slides.length} 页，模板 ${spec.template}，主题 ${spec.theme}。`
          };
        });
      }

      if (!localQa || nextStep === "localQa") {
        localQa = await runStep("03 本地结构质检", async () => {
          if (!deckSpec) {
            throw new ServiceUnavailableException("缺少 DeckSpec，无法执行本地质检。");
          }

          const qa = this.evaluateDeckLocally(deckSpec);
          nextStep = "style";
          return {
            value: qa,
            detail: qa.pass
              ? `本地质检通过，质量分 ${qa.score}。`
              : `本地质检未通过，质量分 ${qa.score}，问题：${qa.issues.join("；")}`
          };
        });
      }

      if (!creativeStyle || nextStep === "style") {
        creativeStyle = await runStep("04 AI创作样式", async () => {
          if (!plan || !deckSpec || !localQa) {
            throw new ServiceUnavailableException("缺少规划、DeckSpec 或本地质检结果，无法创作样式。");
          }

          const stylePlan = await this.generateDeckCreativeStyle(
            activeConfig,
            plan,
            deckSpec,
            localQa,
            () => {
              totalModelCalls += 1;
            },
            {
              projectId,
              messageId: assistantMessageId,
              stage: "style",
              source: "ppt-chat"
            }
          );
          deckSpec = this.applyCreativeStyleToDeckSpec(deckSpec, stylePlan);
          theme = deckSpec.theme;
          nextStep = "review";
          return {
            value: stylePlan,
            detail: `样式创作完成：主题 ${stylePlan.theme}，Deck 风格 ${stylePlan.deckStyle ?? "默认"}，已为 ${stylePlan.slides.length} 页选择页面样式、动画、效果和形状。`
          };
        });
      } else if (deckSpec && creativeStyle) {
        deckSpec = this.applyCreativeStyleToDeckSpec(deckSpec, creativeStyle);
        theme = deckSpec.theme;
      }

      if (!review || nextStep === "review") {
        review = await runStep("05 AI 质检评审", async () => {
          if (!deckSpec || !localQa) {
            throw new ServiceUnavailableException("缺少 DeckSpec 或本地质检结果，无法执行 AI 评审。");
          }

          const aiReview = await this.reviewDeckWithModel(
            activeConfig,
            deckSpec,
            localQa,
            () => {
              totalModelCalls += 1;
            },
            {
              projectId,
              messageId: assistantMessageId,
              stage: "review",
              source: "ppt-chat"
            }
          );
          nextStep = this.shouldIterateDeck(localQa, aiReview, iteration) ? "revise" : "render";
          if (nextStep === "revise") {
            iteration += 1;
          }
          return {
            value: aiReview,
            detail: aiReview.pass
              ? `AI 评审通过，评分 ${aiReview.score}。`
              : `AI 评审建议修正，评分 ${aiReview.score}，问题：${aiReview.issues.join("；")}`
          };
        });
      }

      while (nextStep !== "render" && nextStep !== "completed") {
        if (nextStep === "revise") {
          deckSpec = await runStep(`06 迭代修正 #${iteration}`, async () => {
            if (!deckSpec || !localQa || !review) {
              throw new ServiceUnavailableException("缺少修正上下文，无法迭代 DeckSpec。");
            }

            const refined = await this.reviseDeckWithModel(
              activeConfig,
              deckSpec,
              localQa,
              review,
              templateId,
              theme,
              () => {
                totalModelCalls += 1;
              },
              {
                projectId,
                messageId: assistantMessageId,
                stage: "revise",
                source: "ppt-chat"
              }
            );
            const styledRefined = creativeStyle
              ? this.applyCreativeStyleToDeckSpec(refined, creativeStyle)
              : refined;
            nextStep = "recheck";
            return {
              value: styledRefined,
              detail: `迭代修正完成：${styledRefined.slides.length} 页，已应用 ${review.actions.length} 条动作建议。`
            };
          });
        }

        if (nextStep === "recheck") {
          localQa = await runStep(`07 本地复检 #${iteration}`, async () => {
            if (!deckSpec) {
              throw new ServiceUnavailableException("缺少 DeckSpec，无法执行本地复检。");
            }

            const nextQa = this.evaluateDeckLocally(deckSpec);
            nextStep = "rereview";
            return {
              value: nextQa,
              detail: nextQa.pass
                ? `复检通过，质量分 ${nextQa.score}。`
                : `复检未通过，质量分 ${nextQa.score}，问题：${nextQa.issues.join("；")}`
            };
          });
        }

        if (nextStep === "rereview") {
          review = await runStep(`08 AI 复评 #${iteration}`, async () => {
            if (!deckSpec || !localQa) {
              throw new ServiceUnavailableException("缺少 DeckSpec 或本地复检结果，无法执行 AI 复评。");
            }

            const nextReview = await this.reviewDeckWithModel(
              activeConfig,
              deckSpec,
              localQa,
              () => {
                totalModelCalls += 1;
              },
              {
                projectId,
                messageId: assistantMessageId,
                stage: "rereview",
                source: "ppt-chat"
              }
            );
            nextStep = this.shouldIterateDeck(localQa, nextReview, iteration) ? "revise" : "render";
            if (nextStep === "revise") {
              iteration += 1;
            }
            return {
              value: nextReview,
              detail: nextReview.pass
                ? `AI 复评通过，评分 ${nextReview.score}。`
                : `AI 复评仍建议修正，评分 ${nextReview.score}，问题：${nextReview.issues.join("；")}`
            };
          });
        }

        if (nextStep !== "revise" && nextStep !== "recheck" && nextStep !== "rereview") {
          break;
        }
      }

      if (iteration === 0 && !steps.some((step) => step.name === "06 迭代修正")) {
        appendSkippedStep("06 迭代修正", "首轮质检已通过，无需额外修正。");
      }

      if (!deckSpec) {
        throw new ServiceUnavailableException("缺少 DeckSpec，无法渲染导出。");
      }

      const finalDeckSpec = deckSpec;
      const deckRender = await runStep("09 渲染与导出", async () => {
        const render = await this.htmlPptRendererService.renderDeck(finalDeckSpec);
        nextStep = "completed";
        return {
          value: render,
          detail: `渲染完成：预览 ${render.previewUrl}，导出 ${render.downloadUrl}。`
        };
      });

      return { deckSpec: finalDeckSpec, deckRender, orchestration: finalizeOrchestration(), checkpoint: buildCheckpoint() };
    } catch (error) {
      throw new DeckOrchestrationError(
        error instanceof Error ? error.message : "编排执行失败。",
        finalizeOrchestration(),
        buildCheckpoint()
      );
    }
  }

  private async generateAssistantMessage(
    userId: number,
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    projectId?: string,
    assistantMessageId?: string
  ) {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const systemPrompt = this.getHtmlPptSkillPrompt();

    const messages: ChatCompletionRequestMessage[] = [
      {
        role: "system",
        content: [
          systemPrompt,
          `当前项目名称：${projectName}`,
          `当前后端模型配置：provider=${activeConfig.providerType}，model=${activeConfig.model}。`,
          "当用户询问你是否为某个模型、当前使用什么模型、或底层模型身份时，应回答当前后端配置正在调用的模型名称；不要否认当前后端配置。",
          context.summaryText.trim().length > 0 ? `历史摘要：\n${context.summaryText}` : "历史摘要：无。"
        ].join("\n\n")
      },
      ...context.recentMessages.map((item) => ({
        role: item.role,
        content: this.formatMessageForModel(item)
      })),
      {
        role: "user",
        content: this.formatMessageForModel(pendingUserMessage)
      }
    ];

    const response = await this.requestChatCompletion(activeConfig, messages, "模型调用失败。", userId, {
      projectId,
      messageId: assistantMessageId,
      stage: "chat-reply",
      source: "ppt-chat"
    });

    const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | { error?: { message?: string } } | null;

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error?.message
          ? payload.error.message
          : "模型调用失败。";
      throw new ServiceUnavailableException(message);
    }

    const content = payload && "choices" in payload ? this.extractAssistantContent(payload) : null;

    if (!content) {
      throw new ServiceUnavailableException("模型没有返回有效内容。");
    }

    return content;
  }

  private async generateDeckPlan(
    activeConfig: ActiveModelConfig,
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    templateId: string,
    theme: string,
    onModelCall?: () => void,
    logContext?: ChatCompletionLogContext
  ): Promise<DeckPlan> {
    const systemPrompt = [
      this.getHtmlPptSkillPrompt(),
      "你是 HTML-PPT 编排规划器。",
      "请输出严格 JSON object（不要 markdown）。",
      "目标：给出可执行的页面规划和质量清单，为后续 DeckSpec 生成做准备。",
      "JSON schema：",
      JSON.stringify(
        {
          objective: "string",
          targetAudience: "string",
          visualDirection: "string",
          slidePlan: [{ type: "cover|agenda|section|content|quote|timeline|comparison|data|summary|closing", title: "string", focus: "string" }],
          qualityChecklist: ["string"]
        },
        null,
        2
      )
    ].join("\n\n");

    const userPrompt = [
      `项目：${projectName}`,
      `模板：${templateId}`,
      `主题：${theme}`,
      context.summaryText.trim().length > 0 ? `历史摘要：\n${context.summaryText}` : "历史摘要：无。",
      `用户请求：${this.formatMessageForModel(pendingUserMessage)}`
    ].join("\n\n");

    const payload = await this.callModelForJson(
      activeConfig,
      systemPrompt,
      userPrompt,
      "编排规划生成失败。",
      {
        onModelCall,
        logContext,
        repairHint:
          "必须满足 objective/targetAudience/visualDirection/slidePlan/qualityChecklist 字段，slidePlan 为数组且每项包含 type/title/focus。"
      }
    );
    return this.normalizeDeckPlan(payload, templateId);
  }

  private async reviewDeckWithModel(
    activeConfig: ActiveModelConfig,
    deckSpec: PptDeckSpec,
    localQa: LocalDeckQa,
    onModelCall?: () => void,
    logContext?: ChatCompletionLogContext
  ): Promise<DeckReview> {
    const systemPrompt = [
      "你是 HTML-PPT 质量评审器。",
      "请输出严格 JSON object（不要 markdown）。",
      "任务：基于 deckSpec 和本地 QA 结果给出通过与否、评分、问题与改进动作。",
      "JSON schema：",
      JSON.stringify(
        {
          pass: true,
          score: 85,
          summary: "string",
          issues: ["string"],
          actions: ["string"]
        },
        null,
        2
      )
    ].join("\n\n");

    const userPrompt = [
      "本地 QA：",
      JSON.stringify(localQa, null, 2),
      "DeckSpec：",
      JSON.stringify(deckSpec, null, 2),
      "要求：关注版式多样性、信息层次、演讲可读性、每页信息密度。"
    ].join("\n\n");

    const payload = await this.callModelForJson(activeConfig, systemPrompt, userPrompt, "AI 质检失败。", {
      onModelCall,
      logContext,
      repairHint: "必须满足 pass/score/summary/issues/actions 字段。"
    });
    return this.normalizeDeckReview(payload);
  }

  private async reviseDeckWithModel(
    activeConfig: ActiveModelConfig,
    deckSpec: PptDeckSpec,
    localQa: LocalDeckQa,
    review: DeckReview,
    templateId: string,
    theme: string,
    onModelCall?: () => void,
    logContext?: ChatCompletionLogContext
  ): Promise<PptDeckSpec> {
    const systemPrompt = [
      this.getHtmlPptSkillPrompt(),
      "你是 HTML-PPT 修订器。",
      "请根据问题列表修订 DeckSpec，并输出严格 JSON object（不要 markdown）。",
      "必须保持 schemaVersion=2.0，模板与主题不变。",
      "优先处理：版式重复、每页信息过载、结构单一、缺少 blocks、缺少 data-anim 或 data-fx。"
    ].join("\n\n");

    const userPrompt = [
      `模板：${templateId}`,
      `主题：${theme}`,
      "本地 QA：",
      JSON.stringify(localQa, null, 2),
      "AI 评审：",
      JSON.stringify(review, null, 2),
      "当前 DeckSpec：",
      JSON.stringify(deckSpec, null, 2),
      "输出要求：返回修订后的 DeckSpec JSON。"
    ].join("\n\n");

    const payload = await this.callModelForJson(activeConfig, systemPrompt, userPrompt, "DeckSpec 修订失败。", {
      onModelCall,
      logContext,
      repairHint: "必须返回符合 DeckSpec schemaVersion=2.0 的 JSON object，且 template/theme 不变。"
    });
    const v2Issues = this.validateDeckSpecV2Contract(payload);
    if (v2Issues.length > 0) {
      throw new ServiceUnavailableException(`修订后的 DeckSpec 未通过 v2 硬门槛：${v2Issues.join("；")}`);
    }

    return this.normalizeDeckSpec(payload, { templateId, theme });
  }

  private async generateDeckCreativeStyle(
    activeConfig: ActiveModelConfig,
    plan: DeckPlan,
    deckSpec: PptDeckSpec,
    localQa: LocalDeckQa,
    onModelCall?: () => void,
    logContext?: ChatCompletionLogContext
  ): Promise<PptDeckCreativeStyle> {
    const catalog = this.htmlPptRendererService.getCreativeStyleCatalog();
    const slideInputs = deckSpec.slides.map((slide, index) => ({
      key: slide.id,
      index: index + 1,
      type: slide.type,
      currentLayout: slide.layout,
      title: slide.title,
      subtitle: slide.subtitle,
      bodyCount: slide.body.length,
      blockTypes: (slide.blocks ?? []).map((block) => block.type)
    }));
    const systemPrompt = [
      "你是 HTML-PPT 视觉创作总监。",
      "你的任务不是写 HTML/CSS，而是从 renderer 提供的 key-value 样式库中为本次 PPT 选择最合适的主题、每页样式、动画、效果和形状。",
      "必须输出严格 JSON object。禁止 markdown，禁止解释文字，禁止输出不在 catalog 里的 key。",
      "所有字段值都必须是 catalog 中存在的 key；如果不需要纹理、形状或特效，只能使用 none。",
      "输出 schema：",
      JSON.stringify(
        {
          theme: "themes.key",
          backupThemes: ["themes.key"],
          deckStyle: "deckStyles.key",
          texture: "textures.key",
          shape: "shapes.key",
          slides: {
            "slide-id": {
              pageStyle: "pageStyles.key",
              layout: "DeckSpec layout key",
              composition: "compositionPresets.key",
              componentStyle: "componentStyles.key",
              animation: "animations.key",
              effect: "effects.key 或 none",
              shape: "shapes.key",
              texture: "textures.key",
              density: "none | subtle | standard | high"
            }
          }
        },
        null,
        2
      ),
      "选择原则：",
      "主题必须服务内容气质；不要所有页面使用同一种 pageStyle、animation、shape。",
      "composition 是页面构图主控，负责标题位置、主视觉比例、卡片排列、装饰分布、背景光效和信息密度；不要所有页面使用同一种 composition。",
      "封面页优先使用强视觉主题、shape 和 effect；数据页优先 kpi-grid/stat-highlight/chart；技术页优先 blueprint/terminal/flow/arch；结尾页优先 cta/thanks/confetti。",
      "每页 effect 最多一个，只有适合时使用；shape/texture 可以更频繁，但要和主题一致。"
    ].join("\n\n");
    const userPrompt = [
      "plannedPageCount:",
      String(plan.slidePlan.length),
      "plan:",
      JSON.stringify(plan, null, 2),
      "localQa:",
      JSON.stringify(localQa, null, 2),
      "currentDeck:",
      JSON.stringify(
        {
          title: deckSpec.title,
          template: deckSpec.template,
          theme: deckSpec.theme,
          visualSystem: deckSpec.visualSystem,
          slides: slideInputs
        },
        null,
        2
      ),
      "rendererStyleCatalog:",
      JSON.stringify(catalog, null, 2)
    ].join("\n\n");

    const payload = await this.callModelForJson(activeConfig, systemPrompt, userPrompt, "AI 样式创作失败。", {
      onModelCall,
      logContext,
      repairHint: "必须返回 theme/backupThemes/deckStyle/texture/shape/slides。每页必须包含 composition。slides 必须以 slideId 为 key，所有 value 必须来自 rendererStyleCatalog。"
    });

    return this.normalizeDeckCreativeStyle(payload, deckSpec, catalog);
  }

  private normalizeDeckCreativeStyle(
    input: unknown,
    deckSpec: PptDeckSpec,
    catalog: CreativeStyleCatalog
  ): PptDeckCreativeStyle {
    const candidate = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
    const fallbackTheme = this.keyOrFallback(candidate.theme, catalog.themes, deckSpec.theme);
    const backupThemes = this.coerceStringArray(candidate.backupThemes)
      .filter((item) => Boolean(catalog.themes[item]) && item !== fallbackTheme)
      .slice(0, 5);
    const deckStyle = this.keyOrFallback(candidate.deckStyle, catalog.deckStyles, "technical");
    const texture = this.keyOrFallback(candidate.texture, catalog.textures, "none");
    const shape = this.keyOrFallback(candidate.shape, catalog.shapes, "none");
    const slidesSource = candidate.slides && typeof candidate.slides === "object" && !Array.isArray(candidate.slides)
      ? (candidate.slides as Record<string, unknown>)
      : {};
    const slideStyles = deckSpec.slides.map((slide, index) => {
      const byId = slidesSource[slide.id];
      const byIndex = slidesSource[`slide-${index + 1}`];
      return this.normalizeCreativeSlideStyle(byId ?? byIndex, slide, index, catalog);
    });

    return {
      theme: fallbackTheme,
      backupThemes: backupThemes.length > 0 ? backupThemes : this.defaultCreativeBackupThemes(fallbackTheme, catalog),
      deckStyle,
      texture,
      shape,
      slides: slideStyles
    };
  }

  private normalizeCreativeSlideStyle(
    input: unknown,
    slide: PptDeckSlide,
    index: number,
    catalog: CreativeStyleCatalog
  ): PptDeckCreativeSlideStyle {
    const candidate = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
    const densityRaw = this.coerceOptionalString(candidate.density);
    const density = densityRaw === "none" || densityRaw === "subtle" || densityRaw === "standard" || densityRaw === "high"
      ? densityRaw
      : "standard";

    return {
      slideId: slide.id,
      pageStyle: this.keyOrFallback(candidate.pageStyle, catalog.pageStyles, this.defaultPageStyleForSlide(slide, index)),
      layout: this.normalizeDeckLayout(candidate.layout, slide.type),
      composition: this.keyOrFallback(candidate.composition, catalog.compositionPresets, this.defaultCompositionForSlide(slide, index)),
      componentStyle: this.keyOrFallback(candidate.componentStyle, catalog.componentStyles, "soft-depth"),
      animation: this.keyOrFallback(candidate.animation, catalog.animations, this.defaultAnimationForSlide(slide, index)),
      effect: this.keyOrFallback(candidate.effect, { none: "none", ...catalog.effects }, index === 0 ? "gradient-blob" : "none"),
      shape: this.keyOrFallback(candidate.shape, catalog.shapes, this.defaultShapeForSlide(slide, index)),
      texture: this.keyOrFallback(candidate.texture, catalog.textures, this.defaultTextureForSlide(slide)),
      density
    };
  }

  private applyCreativeStyleToDeckSpec(deckSpec: PptDeckSpec, creativeStyle: PptDeckCreativeStyle): PptDeckSpec {
    const slideStyles = creativeStyle.slides;
    const styledSlides = deckSpec.slides.map((slide, index) => {
      const style = slideStyles.find((item) => item.slideId === slide.id) ?? slideStyles[index];
      if (!style) {
        return slide;
      }

      return {
        ...slide,
        layout: style.layout ?? slide.layout,
        animation: {
          ...(slide.animation ?? {}),
          preset: style.animation ?? slide.animation?.preset,
          fx: style.effect && style.effect !== "none" ? style.effect : slide.animation?.fx,
          intensity: style.density ?? slide.animation?.intensity
        }
      };
    });

    return {
      ...deckSpec,
      theme: creativeStyle.theme,
      visualSystem: {
        ...(deckSpec.visualSystem ?? {}),
        backupThemes: Array.from(new Set([
          ...creativeStyle.backupThemes,
          ...(deckSpec.visualSystem?.backupThemes ?? [])
        ])).slice(0, 8),
        customStyleHints: Array.from(new Set([
          ...(deckSpec.visualSystem?.customStyleHints ?? []),
          creativeStyle.deckStyle ? `deckStyle:${creativeStyle.deckStyle}` : "",
          creativeStyle.texture ? `texture:${creativeStyle.texture}` : "",
          creativeStyle.shape ? `shape:${creativeStyle.shape}` : "",
          ...creativeStyle.slides.map((style) => style.composition ? `composition:${style.composition}` : "")
        ].filter(Boolean))).slice(0, 8)
      },
      creativeStyle,
      slides: styledSlides
    };
  }

  private keyOrFallback(input: unknown, catalog: Record<string, string>, fallback: string) {
    const value = this.coerceOptionalString(input);
    if (value && catalog[value]) {
      return value;
    }

    return catalog[fallback] ? fallback : Object.keys(catalog)[0] ?? fallback;
  }

  private defaultCreativeBackupThemes(theme: string, catalog: CreativeStyleCatalog) {
    const defaults = ["corporate-clean", "tokyo-night", "blueprint", "aurora", "pitch-deck-vc"]
      .filter((item) => item !== theme && Boolean(catalog.themes[item]));
    return defaults.slice(0, 4);
  }

  private defaultPageStyleForSlide(slide: PptDeckSlide, index: number) {
    if (slide.type === "cover") return "cover";
    if (slide.type === "agenda") return "toc";
    if (slide.type === "timeline") return "timeline";
    if (slide.type === "comparison") return "comparison";
    if (slide.type === "data") return "kpi-grid";
    if (slide.type === "closing") return "cta";
    if (slide.type === "summary") return "roadmap";
    return index % 3 === 0 ? "two-column" : "bullets";
  }

  private defaultAnimationForSlide(slide: PptDeckSlide, index: number) {
    if (slide.type === "cover") return "rise-in";
    if (slide.type === "data") return "counter-up";
    if (slide.type === "closing") return "zoom-pop";
    return index % 2 === 0 ? "stagger-list" : "fade-up";
  }

  private defaultShapeForSlide(slide: PptDeckSlide, index: number) {
    if (slide.type === "cover") return "orbit-rings";
    if (slide.type === "data") return "data-nodes";
    if (slide.type === "timeline" || slide.type === "summary") return "ribbon-lines";
    if (slide.type === "closing") return "signal-waves";
    return index % 2 === 0 ? "corner-frames" : "none";
  }

  private defaultTextureForSlide(slide: PptDeckSlide) {
    if (slide.type === "data") return "dot-matrix";
    if (slide.type === "timeline" || slide.type === "summary") return "diagonal-rules";
    return "none";
  }

  private defaultCompositionForSlide(slide: PptDeckSlide, index: number) {
    if (slide.type === "cover") return "hero-split-diagonal";
    if (slide.type === "agenda") return "bento-dashboard";
    if (slide.type === "timeline" || slide.type === "summary") return "timeline-map";
    if (slide.type === "comparison") return "comparison-arena";
    if (slide.type === "data") return "data-command-center";
    if (slide.type === "closing" || slide.type === "quote") return "cinematic-spotlight";
    if (slide.type === "section") return "editorial-poster-stack";
    return ["blueprint-lab", "magazine-collage", "process-river", "radial-orbit", "minimal-focus"][index % 5] ?? "minimal-focus";
  }

  private evaluateDeckLocally(deckSpec: PptDeckSpec): LocalDeckQa {
    const issues: string[] = [];
    let score = 100;
    const slideCount = deckSpec.slides.length;
    const typeCount = new Set(deckSpec.slides.map((slide) => slide.type)).size;
    const layoutSet = new Set(deckSpec.slides.map((slide) => slide.layout ?? this.defaultLayoutForType(slide.type)));
    const blockCount = deckSpec.slides.reduce((total, slide) => total + (slide.blocks?.length ?? 0), 0);
    const animatedCount = deckSpec.slides.filter((slide) => Boolean(slide.animation?.preset)).length;
    const fxCount = deckSpec.slides.filter((slide) => Boolean(slide.animation?.fx)).length;
    const missingBodyCount = deckSpec.slides.filter((slide) => {
      const hasLegacyBody = slide.body.length > 0;
      const hasBlocks = (slide.blocks?.length ?? 0) > 0;
      return !hasLegacyBody && !hasBlocks && slide.type !== "cover";
    }).length;

    if (slideCount < 5) {
      issues.push(`页数偏少（当前 ${slideCount} 页，建议至少 5 页）。`);
      score -= 20;
    }

    if (typeCount < 3) {
      issues.push(`版式类型偏单一（当前 ${typeCount} 类，建议至少 3 类）。`);
      score -= 18;
    }

    if (slideCount >= 5 && layoutSet.size < 4) {
      issues.push(`DeckSpec v2 布局偏单一（当前 ${layoutSet.size} 类，建议至少 4 类）。`);
      score -= 18;
    }

    if (slideCount >= 5 && !layoutSet.has("comparison-board")) {
      issues.push("缺少对比布局 comparison-board。");
      score -= 10;
    }

    if (slideCount >= 5 && !layoutSet.has("kpi-grid")) {
      issues.push("缺少指标卡布局 kpi-grid。");
      score -= 10;
    }

    if (slideCount >= 5 && !layoutSet.has("timeline-ribbon") && !layoutSet.has("roadmap")) {
      issues.push("缺少时间轴或路线图布局。");
      score -= 10;
    }

    if (slideCount >= 5 && blockCount < slideCount * 2) {
      issues.push(`结构化组件不足（当前 ${blockCount} 个 blocks，建议至少每页 2 个）。`);
      score -= 14;
    }

    if (slideCount >= 5 && animatedCount < Math.min(4, slideCount)) {
      issues.push(`动画标记不足（当前 ${animatedCount} 页，建议至少 ${Math.min(4, slideCount)} 页使用 data-anim）。`);
      score -= 10;
    }

    if (slideCount >= 5 && fxCount < 1) {
      issues.push("缺少 data-fx 光效层，封面或数据页至少需要 1 个 canvas FX。");
      score -= 8;
    }

    if (missingBodyCount > 0) {
      issues.push(`${missingBodyCount} 页缺少正文要点。`);
      score -= 15;
    }

    if (deckSpec.template === "presenter-mode-reveal") {
      const shortNotes = deckSpec.slides.filter((slide) => (slide.notes?.trim().length ?? 0) < 120).length;
      if (shortNotes > 0) {
        issues.push(`演讲者模式下有 ${shortNotes} 页 notes 过短（建议 >= 120 字）。`);
        score -= 12;
      }
    }

    return {
      pass: issues.length === 0,
      score: Math.max(0, score),
      issues
    };
  }

  private shouldIterateDeck(localQa: LocalDeckQa, review: DeckReview, iteration: number) {
    return iteration < 2 && (!localQa.pass || !review.pass || review.score < 82);
  }

  private describeDeckResumeNextStep(nextStep: DeckResumeNextStep, iteration: number) {
    const iterationLabel = iteration > 0 ? ` #${iteration}` : "";
    const labels: Record<DeckResumeNextStep, string> = {
      plan: "任务规划",
      draft: "生成初稿 DeckSpec",
      localQa: "本地结构质检",
      style: "AI创作样式",
      review: "AI 质检评审",
      revise: `迭代修正${iterationLabel}`,
      recheck: `本地复检${iterationLabel}`,
      rereview: `AI 复评${iterationLabel}`,
      render: "渲染与导出",
      completed: "已完成"
    };

    return labels[nextStep];
  }

  private describeDeckSpecModelStage(stage: string) {
    const batchMatch = stage.match(/^deckspec-batch-(\d+)-(\d+)$/);
    if (batchMatch) {
      return `正在分批生成第 ${batchMatch[1]}-${batchMatch[2]} 页 DeckSpec，等待 MiniMax 返回本批 slides。`;
    }

    if (stage === "deckspec-retry") {
      return "正在进行 DeckSpec 安全重试，等待 MiniMax 返回修正版。";
    }

    return "正在生成完整 DeckSpec 初稿，等待 MiniMax 返回。";
  }

  private async callModelForJson(
    activeConfig: ActiveModelConfig,
    systemPrompt: string,
    userPrompt: string,
    fallbackErrorMessage: string,
    options?: {
      onModelCall?: () => void;
      repairHint?: string;
      userId?: number;
      logContext?: ChatCompletionLogContext;
    }
  ) {
    const requestModel = async (messages: ChatCompletionRequestMessage[]) => {
      options?.onModelCall?.();
      const response = await this.requestChatCompletion(
        activeConfig,
        messages,
        fallbackErrorMessage,
        options?.userId,
        options?.logContext
      );

      const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | ChatCompletionErrorResponse | null;
      if (!response.ok) {
        throw new ServiceUnavailableException(this.extractProviderErrorMessage(payload, fallbackErrorMessage));
      }

      const rawContent = payload && "choices" in payload ? this.extractAssistantContent(payload) : "";
      return { rawContent };
    };

    const initial = await requestModel([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);
    const initialParsed = this.parseJsonObject(initial.rawContent);
    if (initialParsed) {
      return initialParsed;
    }

    const repairInstruction = [
      "你上一条输出不是有效 JSON。",
      "现在请把上一条输出改写为严格 JSON object。",
      "禁止 markdown，禁止解释文字，禁止 ```json 代码块。",
      options?.repairHint ? `约束：${options.repairHint}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const repaired = await requestModel([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      { role: "assistant", content: initial.rawContent || "（空输出）" },
      { role: "user", content: repairInstruction }
    ]);
    const repairedParsed = this.parseJsonObject(repaired.rawContent);
    if (repairedParsed) {
      return repairedParsed;
    }

    const snippet = this.summarizeModelOutputSnippet(repaired.rawContent || initial.rawContent);
    throw new ServiceUnavailableException(
      `${fallbackErrorMessage}（模型未返回有效 JSON）${snippet ? `；输出片段：${snippet}` : ""}`
    );
  }

  private async requestChatCompletion(
    activeConfig: ActiveModelConfig,
    messages: ChatCompletionRequestMessage[],
    fallbackErrorMessage: string,
    userId?: number,
    logContext?: ChatCompletionLogContext
  ) {
    const timeoutMs = this.modelRequestTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const requestId = randomUUID().slice(0, 8);
    const requestSize = messages.reduce((sum, message) => sum + message.content.length, 0);
    const providerHost = this.safeProviderHost(activeConfig.baseUrl);

    this.logger.log(
      `LLM request ${requestId} started: model=${activeConfig.model}, host=${providerHost}, messages=${messages.length}, chars=${requestSize}, timeoutMs=${timeoutMs}`
    );
    const requestPayload = {
      model: activeConfig.model,
      messages
    };
    const resolvedSource = logContext?.source ?? "ppt-chat";
    const resolvedStage = logContext?.stage ?? "unspecified";

    try {
      const response = await fetch(`${activeConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeConfig.apiKey}`
        },
        body: JSON.stringify(requestPayload),
        cache: "no-store",
        signal: controller.signal
      });
      const elapsedMs = Date.now() - startedAt;
      const rawResponseText = await response.clone().text().catch(() => "");
      let parsedPayload: ChatCompletionResponse | ChatCompletionErrorResponse | null = null;
      if (rawResponseText.trim().length > 0) {
        try {
          parsedPayload = JSON.parse(rawResponseText) as ChatCompletionResponse | ChatCompletionErrorResponse;
        } catch {
          parsedPayload = null;
        }
      }

      if (response.ok) {
        this.logger.log(`LLM request ${requestId} completed: status=${response.status}, elapsedMs=${elapsedMs}`);
        const usage = parsedPayload && "usage" in parsedPayload ? (parsedPayload as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage : undefined;
        if (userId && usage) {
          this.llmLoggingService.logCall(
            activeConfig.id,
            userId,
            usage.prompt_tokens || 0,
            usage.completion_tokens || 0,
            usage.total_tokens || 0
          ).catch((err) => this.logger.warn(`Failed to log usage: ${err.message}`));
        }
      } else {
        this.logger.warn(
          `LLM request ${requestId} provider error: status=${response.status}, elapsedMs=${elapsedMs}, body=${this.summarizeLogSnippet(rawResponseText)}`
        );
      }
      this.llmLoggingService.logPayload({
        configId: activeConfig.id,
        userId: userId ?? null,
        projectId: logContext?.projectId ?? null,
        messageId: logContext?.messageId ?? null,
        source: resolvedSource,
        stage: resolvedStage,
        requestPayload,
        responsePayload: parsedPayload ?? (rawResponseText || null),
        status: response.ok ? "success" : "error",
        errorMessage: response.ok ? null : this.extractProviderErrorMessage(parsedPayload, fallbackErrorMessage),
        latencyMs: elapsedMs
      }).catch((error) => {
        this.logger.warn(`Failed to log llm payload: ${error instanceof Error ? error.message : String(error)}`);
      });

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.llmLoggingService.logPayload({
          configId: activeConfig.id,
          userId: userId ?? null,
          projectId: logContext?.projectId ?? null,
          messageId: logContext?.messageId ?? null,
          source: resolvedSource,
          stage: resolvedStage,
          requestPayload,
          responsePayload: null,
          status: "timeout",
          errorMessage: `模型请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`,
          latencyMs: Date.now() - startedAt
        }).catch((payloadError) => {
          this.logger.warn(`Failed to log timeout payload: ${payloadError instanceof Error ? payloadError.message : String(payloadError)}`);
        });
        this.logger.warn(`LLM request ${requestId} local timeout: elapsedMs=${Date.now() - startedAt}, timeoutMs=${timeoutMs}`);
        throw new ServiceUnavailableException(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`);
      }
      this.llmLoggingService.logPayload({
        configId: activeConfig.id,
        userId: userId ?? null,
        projectId: logContext?.projectId ?? null,
        messageId: logContext?.messageId ?? null,
        source: resolvedSource,
        stage: resolvedStage,
        requestPayload,
        responsePayload: null,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt
      }).catch((payloadError) => {
        this.logger.warn(`Failed to log error payload: ${payloadError instanceof Error ? payloadError.message : String(payloadError)}`);
      });

      this.logger.warn(
        `LLM request ${requestId} transport error: elapsedMs=${Date.now() - startedAt}, error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw new ServiceUnavailableException(`${fallbackErrorMessage}（模型服务暂时不可用）。`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private safeProviderHost(baseUrl: string) {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "unknown";
    }
  }

  private summarizeLogSnippet(input: string) {
    return input.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  private modelRequestTimeoutMs() {
    const parsed = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
  }

  private isModelRequestTimeout(error: unknown) {
    return error instanceof Error && /模型请求超过\s+\d+\s+秒未返回/.test(error.message);
  }

  private summarizeModelOutputSnippet(content: string) {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "";
    }

    const short = normalized.slice(0, 120);
    return short.length < normalized.length ? `${short}...` : short;
  }

  private validateDeckSpecV2Contract(input: unknown) {
    const issues: string[] = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return ["DeckSpec 必须是 JSON object"];
    }

    const candidate = input as Record<string, unknown>;
    if (candidate.schemaVersion !== "2.0") {
      issues.push("schemaVersion 必须等于 2.0");
    }

    const slides = Array.isArray(candidate.slides) ? candidate.slides : [];
    if (slides.length === 0) {
      issues.push("slides 至少需要 1 页");
      return issues;
    }

    let fxCount = 0;
    const layoutSet = new Set<string>();
    slides.forEach((slideInput, index) => {
      const label = `第 ${index + 1} 页`;
      if (!slideInput || typeof slideInput !== "object" || Array.isArray(slideInput)) {
        issues.push(`${label} 必须是 slide object`);
        return;
      }

      const slide = slideInput as Record<string, unknown>;
      if (typeof slide.layout !== "string" || !ALLOWED_DECK_LAYOUTS.has(slide.layout as PptDeckLayout)) {
        issues.push(`${label} 必须显式提供有效 layout`);
      } else {
        layoutSet.add(slide.layout);
      }

      const blocks = Array.isArray(slide.blocks) ? slide.blocks : [];
      const validBlockCount = blocks.filter((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
          return false;
        }

        const type = (block as Record<string, unknown>).type;
        return typeof type === "string" && ALLOWED_DECK_BLOCK_TYPES.has(type as PptDeckBlockType);
      }).length;
      if (validBlockCount < 2) {
        issues.push(`${label} 至少需要 2 个有效 blocks`);
      }

      if (!slide.animation || typeof slide.animation !== "object" || Array.isArray(slide.animation)) {
        issues.push(`${label} 必须提供 animation`);
      } else {
        const animation = slide.animation as Record<string, unknown>;
        const preset = this.coerceOptionalString(animation.preset);
        const fx = this.coerceOptionalString(animation.fx);
        const hasPreset = Boolean(preset && ALLOWED_DECK_ANIMATIONS.has(preset));
        const hasFx = Boolean(fx && ALLOWED_DECK_FX.has(fx));
        const hasStagger = typeof animation.stagger === "boolean";
        const hasIntensity =
          animation.intensity === "none" ||
          animation.intensity === "subtle" ||
          animation.intensity === "standard" ||
          animation.intensity === "high";
        if (!hasPreset && !hasFx && !hasStagger && !hasIntensity) {
          issues.push(`${label} 的 animation 至少需要有效 preset、fx、stagger 或 intensity`);
        }

        if (hasFx) {
          fxCount += 1;
        }
      }
    });

    if (fxCount < 1) {
      issues.push("整份 deck 至少需要 1 个有效 animation.fx");
    }

    if (slides.length >= 5) {
      if (layoutSet.size < 4) {
        issues.push(`5 页以上 deck 至少需要 4 种 layout，当前 ${layoutSet.size} 种`);
      }

      if (!layoutSet.has("comparison-board")) {
        issues.push("5 页以上 deck 必须包含 comparison-board");
      }

      if (!layoutSet.has("kpi-grid")) {
        issues.push("5 页以上 deck 必须包含 kpi-grid");
      }

      if (!layoutSet.has("timeline-ribbon") && !layoutSet.has("roadmap")) {
        issues.push("5 页以上 deck 必须包含 timeline-ribbon 或 roadmap");
      }
    }

    return issues.slice(0, 10);
  }

  private normalizeDeckPlan(input: unknown, templateId: string): DeckPlan {
    const candidate = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const slidePlanRaw = Array.isArray(candidate.slidePlan) ? candidate.slidePlan : [];
    const slidePlan = slidePlanRaw
      .map((item, index) => {
        const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        return {
          type: this.normalizeSlideType(value.type),
          title: this.coerceString(value.title, `页面 ${index + 1}`),
          focus: this.coerceString(value.focus, "待补充")
        };
      })
      .slice(0, 12);

    return {
      objective: this.coerceString(candidate.objective, "输出结构清晰、可演讲的 HTML-PPT。"),
      targetAudience: this.coerceString(candidate.targetAudience, "普通观众"),
      visualDirection: this.coerceString(candidate.visualDirection, templateId),
      slidePlan: slidePlan.length > 0 ? slidePlan : [{ type: "cover", title: "封面", focus: "主题导入" }],
      qualityChecklist: this.coerceStringArray(candidate.qualityChecklist).slice(0, 8)
    };
  }

  private normalizeDeckReview(input: unknown): DeckReview {
    const candidate = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const scoreRaw = Number(candidate.score);
    const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 75;
    const issues = this.coerceStringArray(candidate.issues);
    const actions = this.coerceStringArray(candidate.actions);

    return {
      pass: Boolean(candidate.pass),
      score,
      summary: this.coerceString(candidate.summary, "已完成质量评审。"),
      issues,
      actions
    };
  }

  private async generateDeckSpec(
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    options?: {
      safetyRetryOnly?: boolean;
      plan?: DeckPlan | null;
      onModelCall?: (stage: string) => void;
      userId?: number;
      logContext?: ChatCompletionLogContext;
    }
  ): Promise<PptDeckSpec> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const templateId = pendingUserMessage.template?.id ?? "auto";
    const theme = this.defaultThemeForTemplate(templateId);
    const onModelCall = options?.onModelCall;
    const plan = options?.plan ?? null;

    if (!options?.safetyRetryOnly && this.shouldUseBatchedDeckSpec(plan)) {
      return this.generateDeckSpecByBatches(
        activeConfig,
        projectName,
        context,
        pendingUserMessage,
        templateId,
        theme,
        plan,
        onModelCall,
        options?.userId,
        options?.logContext
      );
    }

    const callModel = async (safetyRetry: boolean) => {
      const systemPrompt = this.buildDeckSpecSystemPrompt(templateId, theme, safetyRetry);
      const userPrompt = this.buildDeckSpecUserPrompt(
        projectName,
        context,
        pendingUserMessage,
        templateId,
        theme,
        safetyRetry,
        plan
      );
      onModelCall?.(safetyRetry ? "deckspec-retry" : "deckspec-draft");

      const response = await this.requestChatCompletion(
        activeConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        "DeckSpec 生成失败。",
        options?.userId,
        {
          ...(options?.logContext ?? {}),
          source: options?.logContext?.source ?? "ppt-chat",
          stage: safetyRetry
            ? `${options?.logContext?.stage ?? "deckspec-draft"}-safety-retry`
            : options?.logContext?.stage ?? "deckspec-draft"
        }
      );

      const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | ChatCompletionErrorResponse | null;

      if (!response.ok) {
        const message = this.extractProviderErrorMessage(payload, "DeckSpec 生成失败。");
        return { ok: false as const, message, payload };
      }

      const rawContent = payload && "choices" in payload ? this.extractAssistantContent(payload) : "";
      const parsed = this.parseJsonObject(rawContent);
      if (!parsed) {
        return { ok: false as const, message: "模型没有返回有效 DeckSpec JSON。", payload };
      }

      const v2Issues = this.validateDeckSpecV2Contract(parsed);
      if (v2Issues.length > 0) {
        return {
          ok: false as const,
          message: `模型返回的 DeckSpec 未通过 v2 硬门槛：${v2Issues.join("；")}`,
          payload
        };
      }

      return { ok: true as const, deckSpec: this.normalizeDeckSpec(parsed, { templateId, theme }) };
    };

    const firstResult = await callModel(false);
    if (firstResult.ok) {
      return firstResult.deckSpec;
    }

    if (!options?.safetyRetryOnly && this.isProviderSensitiveOutput(firstResult.message, firstResult.payload)) {
      const retryResult = await callModel(true);
      if (retryResult.ok) {
        return retryResult.deckSpec;
      }

      throw new ServiceUnavailableException(
        this.isProviderSensitiveOutput(retryResult.message, retryResult.payload)
          ? "模型输出被内容安全策略拦截。请尝试把主题描述改得更中性，或减少容易触发安全策略的历史冲突、暴力、政治动员类措辞。"
          : retryResult.message
      );
    }

    throw new ServiceUnavailableException(firstResult.message);
  }

  private shouldUseBatchedDeckSpec(plan?: DeckPlan | null) {
    if (process.env.PPT_FORCE_SINGLE_DECKSPEC === "1") {
      return false;
    }

    const slideCount = plan?.slidePlan.length ?? 0;
    return slideCount >= 5 || process.env.PPT_FORCE_BATCHED_DECKSPEC === "1";
  }

  private async generateDeckSpecByBatches(
    activeConfig: ActiveModelConfig,
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    templateId: string,
    theme: string,
    plan: DeckPlan | null,
    onModelCall?: (stage: string) => void,
    userId?: number,
    logContext?: ChatCompletionLogContext
  ): Promise<PptDeckSpec> {
    if (!plan) {
      throw new ServiceUnavailableException("缺少任务规划，无法分批生成 DeckSpec。");
    }

    const slidePlan = plan.slidePlan.slice(0, 12);
    const batches = this.chunkArray(slidePlan.map((slide, index) => ({ ...slide, index })), 2);
    const slides: PptDeckSlide[] = [];

    for (const batch of batches) {
      const first = batch[0];
      const last = batch[batch.length - 1];
      if (!first || !last) {
        continue;
      }

      onModelCall?.(`deckspec-batch-${first.index + 1}-${last.index + 1}`);
      const payload = await this.callModelForJson(
        activeConfig,
        this.buildDeckSlideBatchSystemPrompt(templateId, theme),
        this.buildDeckSlideBatchUserPrompt(projectName, context, pendingUserMessage, plan, batch),
        "DeckSpec 分批页面生成失败。",
        {
          repairHint: "必须输出 {\"slides\":[...]}，slides 数量必须与本批 slidePlan 数量一致。",
          userId,
          logContext: {
            ...(logContext ?? {}),
            source: logContext?.source ?? "ppt-chat",
            stage: `deckspec-batch-${first.index + 1}-${last.index + 1}`
          }
        }
      );

      const candidate = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const rawSlides = Array.isArray(candidate.slides) ? candidate.slides : [];
      if (rawSlides.length === 0) {
        throw new ServiceUnavailableException("DeckSpec 分批页面生成失败：模型未返回 slides。");
      }

      rawSlides.slice(0, batch.length).forEach((slide, offset) => {
        const expected = batch[offset];
        if (!expected) {
          return;
        }
        slides.push(this.normalizeDeckSlide({ ...(slide as Record<string, unknown>), id: `slide-${expected.index + 1}` }, expected.index));
      });
    }

    const deckSpec = this.normalizeDeckSpec(
      {
        schemaVersion: "2.0",
        title: this.deckTitleFromPlan(projectName, pendingUserMessage, plan),
        subtitle: plan.objective,
        language: "zh-CN",
        template: templateId,
        theme,
        visualSystem: {
          density: "balanced",
          tone: plan.visualDirection,
          backupThemes: [theme],
          customStyleHints: [plan.visualDirection]
        },
        audience: plan.targetAudience,
        goal: plan.objective,
        slides
      },
      { templateId, theme }
    );

    return this.ensureDeckSpecV2Contract(deckSpec);
  }

  private buildDeckSlideBatchSystemPrompt(templateId: string, theme: string) {
    return [
      this.getHtmlPptSkillPrompt(),
      "你是 HTML-PPT DeckSpec 分页写作者。",
      "当前任务：只为指定的 1-2 页生成 slides JSON，不输出完整 deck，不输出 HTML/CSS/Markdown。",
      "必须输出严格 JSON object，格式为 {\"slides\":[...]}。",
      `目标模板：${templateId}；默认主题：${theme}。`,
      "每个 slide 必须包含：id、type、layout、title、subtitle/kicker 可选、body 字符串数组、至少 2 个 blocks、visualPrompt、animation、notes。",
      "可用 layout：cover-hero, toc-grid, content-cards, comparison-board, kpi-grid, timeline-ribbon, roadmap, flow-diagram, closing-cta。",
      "可用 block.type：pill-row, card, metric, comparison-panel, timeline-node, roadmap-column, flow-node, bar-progress, quote, cta。",
      "可用 animation.preset：fade-up, rise-in, zoom-pop, stagger-list, path-draw, spotlight, gradient-flow, card-flip-3d, perspective-zoom。",
      "可用 animation.fx：gradient-blob, particle-burst, data-stream, sparkle-trail, orbit-ring, counter-explosion。",
      "notes 使用中文，单页 120-220 字；内容要可演讲，不要只写标题。"
    ].join("\n\n");
  }

  private buildDeckSlideBatchUserPrompt(
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    plan: DeckPlan,
    batch: Array<{ index: number; type: PptDeckSlideType; title: string; focus: string }>
  ) {
    return [
      `项目名称：${projectName}`,
      `整体目标：${plan.objective}`,
      `目标观众：${plan.targetAudience}`,
      `视觉方向：${plan.visualDirection}`,
      "当前用户请求：",
      this.formatMessageForModel(pendingUserMessage),
      context.summaryText.trim().length > 0 ? `历史摘要：${context.summaryText}` : "",
      "本批页面计划：",
      JSON.stringify(
        batch.map((slide) => ({
          id: `slide-${slide.index + 1}`,
          page: slide.index + 1,
          type: slide.type,
          title: slide.title,
          focus: slide.focus
        })),
        null,
        2
      ),
      "生成要求：",
      [
        "1. 只输出本批 slides，不要输出 deck 外层字段。",
        "2. 每页至少 2 个结构化 blocks；不要用纯文本堆叠。",
        "3. 五大神技、对比、训练路径、风险提示等内容要具体，适合渲染成卡片、指标、流程或对比布局。",
        "4. 不知道真实数据时用“示例”或“训练建议”表述，不要伪造真实统计。",
        "5. 输出 JSON 中 slides 顺序必须与本批页面计划一致。"
      ].join("\n")
    ].filter(Boolean).join("\n\n");
  }

  private ensureDeckSpecV2Contract(deckSpec: PptDeckSpec): PptDeckSpec {
    const requiredLayouts: PptDeckLayout[] = ["comparison-board", "kpi-grid", "roadmap"];
    const slides: PptDeckSlide[] = deckSpec.slides.map((slide, index): PptDeckSlide => {
      const blocks = [...(slide.blocks ?? [])];
      while (blocks.length < 2) {
        blocks.push({
          type: "card",
          title: index === 0 ? "核心看点" : `关键要点 ${blocks.length + 1}`,
          body: (slide.body[blocks.length] ?? slide.body[0] ?? slide.title).slice(0, 120),
          items: []
        });
      }
      const body = slide.body.length > 0 ? slide.body : [slide.title];
      const layout = slide.layout ?? this.defaultLayoutForType(slide.type);
      const animation = slide.animation ?? {
        preset: index === 0 ? "rise-in" : "fade-up",
        stagger: true,
        fx: index === 0 ? "gradient-blob" : undefined,
        intensity: "standard" as const
      };

      return {
        ...slide,
        layout,
        body,
        blocks,
        animation
      };
    });

    if (slides.length >= 5) {
      requiredLayouts.forEach((layout, offset) => {
        const targetIndex = Math.min(offset + 2, slides.length - 1);
        const target = slides[targetIndex];
        if (target && !slides.some((slide) => slide.layout === layout)) {
          slides[targetIndex] = { ...target, layout };
        }
      });
    }

    const firstSlide = slides[0];
    if (firstSlide && !slides.some((slide) => slide.animation?.fx)) {
      slides[0] = {
        ...firstSlide,
        animation: {
          ...(firstSlide.animation ?? {}),
          preset: firstSlide.animation?.preset ?? "rise-in",
          stagger: firstSlide.animation?.stagger ?? true,
          fx: "gradient-blob",
          intensity: firstSlide.animation?.intensity ?? "standard"
        }
      };
    }

    return {
      ...deckSpec,
      schemaVersion: "2.0",
      slides
    };
  }

  private deckTitleFromPlan(projectName: string, pendingUserMessage: PptMessageDto, plan: DeckPlan) {
    const request = this.stripModelReasoning(pendingUserMessage.content).replace(/\s+/g, " ").trim();
    const match = request.match(/内容为([^，。,；;]+)/);
    return match?.[1]?.trim() || plan.slidePlan[0]?.title || projectName || "HTML-PPT";
  }

  private chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private buildDeckSpecSystemPrompt(templateId: string, theme: string, safetyRetry: boolean) {
    const layoutCatalog = {
      "cover-hero": "封面英雄页：大标题、kicker、导语、封面网格、光效层。",
      "toc-grid": "目录网格：3-6 个章节卡片，适合开场导航。",
      "content-cards": "内容卡片：2-4 张信息卡，适合概念拆解。",
      "comparison-board": "左右对比：两组 comparison-panel，适合过去/未来、方案A/B、优势/风险。",
      "kpi-grid": "指标卡：metric 与 bar-progress 组合，适合数据、趋势、能力指标。",
      "timeline-ribbon": "横向时间轴：timeline-node，适合阶段演进。",
      roadmap: "路线图：roadmap-column，适合分阶段计划。",
      "flow-diagram": "流程图：flow-node 串联，适合架构、链路、工作流。",
      "closing-cta": "结尾行动页：quote 与 cta，适合总结与行动号召。"
    };

    return [
      this.getHtmlPptSkillPrompt(),
      "当前任务：只生成 DeckSpec v2 JSON，供后端 HTML-PPT Renderer 渲染成最终 HTML。",
      "禁止输出 Markdown、禁止输出 HTML、禁止输出解释说明、禁止声称文件已生成。",
      "输出必须是一个严格 JSON object，不能包裹在 ```json 代码块里。",
      "你不是在写普通大纲，而是在为 html-ppt-skill 生成可渲染的结构化前端规格。必须显式使用 layout、blocks、animation、data-fx 等字段。",
      "硬性校验：schemaVersion 必须等于 2.0；每页必须显式提供有效 layout；每页至少 2 个 blocks；每页必须提供 animation；整份 deck 至少 1 页使用 animation.fx。",
      "可用布局目录：",
      JSON.stringify(layoutCatalog, null, 2),
      "可用 block.type：pill-row, card, metric, comparison-panel, timeline-node, roadmap-column, flow-node, bar-progress, quote, cta。",
      "可用 data-anim preset：fade-up, fade-down, fade-left, fade-right, rise-in, drop-in, zoom-pop, blur-in, glitch-in, typewriter, neon-glow, shimmer-sweep, gradient-flow, stagger-list, path-draw, parallax-tilt, card-flip-3d, cube-rotate-3d, page-turn-3d, perspective-zoom, marquee-scroll, kenburns, confetti-burst, spotlight, morph-shape, ripple-reveal。",
      "可用 data-fx：particle-burst, confetti-cannon, firework, starfield, matrix-rain, knowledge-graph, neural-net, constellation, orbit-ring, galaxy-swirl, word-cascade, letter-explode, chain-react, magnetic-field, data-stream, gradient-blob, sparkle-trail, shockwave, typewriter-multi, counter-explosion。",
      "DeckSpec schema:",
      JSON.stringify(
        {
          schemaVersion: "2.0",
          title: "string",
          subtitle: "string optional",
          language: "zh-CN",
          template: templateId,
          theme,
          visualSystem: {
            density: "calm | balanced | dense",
            tone: "visual tone string",
            backupThemes: ["theme id"],
            customStyleHints: ["style direction string"]
          },
          audience: "string optional",
          goal: "string optional",
          slides: [
            {
              id: "slide-1",
              type: "cover | agenda | section | content | quote | timeline | comparison | data | summary | closing",
              layout: "cover-hero | toc-grid | content-cards | comparison-board | kpi-grid | timeline-ribbon | roadmap | flow-diagram | closing-cta",
              title: "string",
              subtitle: "string optional",
              kicker: "string optional",
              body: ["string"],
              blocks: [
                {
                  type: "card | metric | comparison-panel | timeline-node | roadmap-column | flow-node | bar-progress | quote | cta | pill-row",
                  title: "string optional",
                  label: "string optional",
                  value: "string optional",
                  subtitle: "string optional",
                  body: "string optional",
                  items: ["string optional"],
                  accent: "string optional",
                  meta: {}
                }
              ],
              quote: "string optional",
              visualPrompt: "string optional",
              animation: {
                preset: "data-anim preset optional",
                stagger: true,
                fx: "data-fx optional",
                intensity: "none | subtle | standard | high"
              },
              styleHints: ["slide style hint optional"],
              notes: "speaker notes string optional",
              data: {}
            }
          ]
        },
        null,
        2
      ),
      "slides 至少 1 页。每页 body 必须是字符串数组；blocks 必须是结构化对象数组。",
      "如果用户要求 5 页以上：至少使用 4 种不同 layout；必须包含 comparison-board、kpi-grid、timeline-ribbon 或 roadmap；封面或数据页至少 1 个 animation.fx。",
      "每页必须至少有 2 个 blocks，封面和结尾页也要有 pill-row/quote/cta 等结构化块。",
      "不要把所有页面都写成 content-cards；要主动使用对比布局、指标卡、进度条、时间轴、封面网格、光效层。",
      "metric.value 和 bar-progress.meta.percent 可以使用示例值，但必须标注为示例或趋势表达，不能伪造真实数据。",
      "如果模板是 presenter-mode-reveal，每页必须提供 150-300 字中文 notes。",
      "如果缺少事实数据，用“待补充”或“示例数据”标识，不能编造真实数字。",
      "不要使用 emoji 或特殊图标字符，职业、动作和视觉元素都用普通文字描述。",
      "template 和 theme 字段优先使用系统给定值。",
      safetyRetry
        ? "安全重试模式：必须使用中性、教育性、非煽动性的措辞；避免细节化描写冲突、暴力、政治动员、仇恨或违法内容；必要时用“历史背景”“社会议题”“待补充资料”进行概括。"
        : ""
    ].filter(Boolean).join("\n\n");
  }

  private buildDeckSpecUserPrompt(
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    templateId: string,
    theme: string,
    safetyRetry: boolean,
    plan?: DeckPlan | null
  ) {
    return [
      `项目名称：${projectName}`,
      `目标模板：${templateId}`,
      `默认主题：${theme}`,
      plan ? `编排计划：\n${JSON.stringify(plan, null, 2)}` : "",
      "结构化渲染要求：",
      [
        "1. 输出 DeckSpec v2，不输出 HTML/CSS。",
        "2. 每页都要给 layout、blocks、animation；让 renderer 能生成真实前端版式。",
        "3. 优先使用 cover-hero、comparison-board、kpi-grid、timeline-ribbon、roadmap、flow-diagram、closing-cta 组合，避免纯文字堆叠。",
        "4. blocks 里要包含指标卡、进度条、对比面板、时间轴节点、路线图列或流程节点等明确组件。",
        "5. 至少在封面或关键数据页设置 animation.fx，至少 4 页设置 animation.preset。"
      ].join("\n"),
      context.summaryText.trim().length > 0 ? `历史摘要：\n${context.summaryText}` : "历史摘要：无。",
      "最近对话：",
      ...context.recentMessages.map((message, index) => {
        const label = message.role === "user" ? "用户" : "助手";
        return `${index + 1}. ${label}：${this.formatMessageForModel(message)}`;
      }),
      "当前用户请求：",
      this.formatMessageForModel(pendingUserMessage),
      safetyRetry
        ? "请在不改变用户主题目标的前提下，用更中性的表达生成 DeckSpec；如果原文包含容易触发内容安全策略的表述，只保留教育性背景和正向总结。"
        : ""
    ].filter(Boolean).join("\n\n");
  }

  private v2ConversationContext(context: { summaryText: string; recentMessages: PptMessageDto[] }) {
    return [
      context.summaryText.trim() ? `历史摘要：${context.summaryText.trim()}` : "",
      ...context.recentMessages.slice(-8).map((message) => `${message.role}: ${this.formatMessageForModel(message)}`)
    ].filter(Boolean);
  }

  private v2DeckCheckpoints(
    trace: HtmlPptV2TraceCheckpoint,
    intent: IntentIR,
    evidence: EvidencePack,
    narrative: NarrativeIR,
    design: DesignSystemIR,
    layoutPlan: LayoutPlanIR,
    slots: SlotFillIR,
    assets: AssetIR,
    choreography: ChoreographyIR
  ): DeckIR["meta"]["checkpoints"] {
    const now = new Date().toISOString();
    return [
      { stage: "stage-1:intent" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Intent source: ${trace.intentSource ?? "fallback"}; slides=${intent.derivedSlideCount}` },
      { stage: "stage-2:template-select" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Template source: ${trace.templateSelectionSource ?? "auto-deterministic"}; selected=${trace.templateSelection?.chosenTemplateId ?? design.donorTemplateId}` },
      { stage: "stage-3:evidence" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Evidence source: ${trace.evidenceSource ?? "fallback"}; facts=${evidence.facts.length}` },
      { stage: "stage-4:narrative" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Narrative source: ${trace.narrativeSource ?? "fallback"}; slides=${narrative.slides.length}` },
      { stage: "stage-5:design" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Design source: ${trace.designSource ?? "fallback"}; theme=${design.themeId}` },
      { stage: "stage-6:layout" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Layout source: ${trace.layoutPlanSource ?? "fallback"}; layouts=${layoutPlan.length}` },
      { stage: "stage-7:slots" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Slot source: ${trace.slotFillSource ?? "fallback"}; slots=${slots.length}` },
      { stage: "stage-8:assets" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Asset source: deterministic; assets=${Object.keys(assets).length}` },
      { stage: "stage-9:choreography" as const, status: "completed" as const, startedAt: now, completedAt: now, summary: `Choreography source: deterministic; entries=${choreography.length}` }
    ];
  }

  private v2TemplateSelectionTrace(result: TemplateSelectionResult) {
    return {
      chosenTemplateId: result.selectedTemplate.id,
      shortlist: result.shortlist.map((candidate) => candidate.id),
      rationale: result.rationale,
      confidence: result.confidence
    };
  }

  private async remediateV2RenderVerification(input: {
    deck: DeckIR;
    verification: RenderVerificationReport;
    outputDir: string;
    registryHash: string;
    registry: SkillRegistry;
  }): Promise<{ deck: DeckIR; verification: RenderVerificationReport; trace: RenderRemediationTrace }> {
    const slideIndexes = this.v2RemediableSlideIndexes(input.verification);
    const before = v2VerificationIssueCounts(input.verification);
    if (!slideIndexes.length) {
      return {
        deck: input.deck,
        verification: input.verification,
        trace: {
          attempted: false,
          accepted: false,
          slideIndexes: [],
          before,
          reason: input.verification.status === "clean"
            ? "verification-clean"
            : "no-slide-scoped-remediable-issues"
        }
      };
    }

    const candidateDeck = compactDeckForRenderVerification(input.deck, slideIndexes);
    await this.htmlPptV2Renderer.renderToDirectory(candidateDeck, {
      outputDir: input.outputDir,
      registryHash: input.registryHash,
      registry: input.registry
    });
    const candidateVerification = await runRenderVerificationStage({
      outputDir: input.outputDir,
      deck: candidateDeck,
      registryHash: input.registryHash
    });
    const after = v2VerificationIssueCounts(candidateVerification);
    if (v2VerificationImproved(before, after)) {
      return {
        deck: candidateDeck,
        verification: candidateVerification,
        trace: {
          attempted: true,
          accepted: true,
          slideIndexes,
          before,
          after,
          reason: "stage-11-feedback-compacted-stage-6-slots"
        }
      };
    }

    await this.htmlPptV2Renderer.renderToDirectory(input.deck, {
      outputDir: input.outputDir,
      registryHash: input.registryHash,
      registry: input.registry
    });
    const restoredVerification = await runRenderVerificationStage({
      outputDir: input.outputDir,
      deck: input.deck,
      registryHash: input.registryHash
    });

    return {
      deck: input.deck,
      verification: restoredVerification,
      trace: {
        attempted: true,
        accepted: false,
        slideIndexes,
        before,
        after,
        reason: "stage-11-feedback-did-not-improve-verification"
      }
    };
  }

  private v2RemediableSlideIndexes(report: RenderVerificationReport): number[] {
    const fixableCodes = new Set(["browser-element-overflow", "browser-slide-viewport-mismatch"]);
    const issues: RenderVerificationIssue[] = [...report.hardIssues, ...report.warnings];
    return [...new Set(
      issues
        .filter((issue) => typeof issue.slideIndex === "number" && issue.signal === "browser" && fixableCodes.has(issue.code))
        .map((issue) => issue.slideIndex!)
        .filter((slideIndex) => Number.isInteger(slideIndex) && slideIndex > 0)
    )].sort((a, b) => a - b);
  }

  private v2PublishedFiles(outputDir: string, auxiliary: AuxiliaryArtifactsStageResult): HtmlPptV2PublishTrace["files"] {
    return {
      indexHtml: join(outputDir, "index.html"),
      previewHtml: join(outputDir, "preview.html"),
      standaloneHtml: join(outputDir, "standalone.html"),
      styleCss: join(outputDir, "style.css"),
      manifest: join(outputDir, "manifest.json"),
      zip: join(outputDir, "html-ppt-deck.zip"),
      verificationReport: join(outputDir, "verification-report.json"),
      speakerNotes: join(outputDir, auxiliary.artifacts.speakerNotes),
      agendaPdf: join(outputDir, auxiliary.artifacts.agendaPdf),
      talkingPoints: join(outputDir, auxiliary.artifacts.talkingPoints),
      qaPrep: join(outputDir, auxiliary.artifacts.qaPrep),
      accessibilityReport: join(outputDir, auxiliary.artifacts.accessibilityReport)
    };
  }

  private htmlPptV2UserDeckRoot(userId: number) {
    return resolve(findWorkspaceRoot(), ".local-runtime", "html-ppt-v2", "published", String(userId));
  }

  private async readV2DeckIrFromRender(render: PptDeckRender): Promise<DeckIR> {
    if (!render.outputDir) {
      throw new BadRequestException("该 v2 deck 缺少 outputDir，无法恢复结构化 IR。");
    }
    const manifestPath = join(render.outputDir, "manifest.json");
    const raw = await readFile(manifestPath, "utf8").catch(() => "");
    if (!raw) {
      throw new BadRequestException("该 v2 deck 的 manifest.json 不存在，无法按模板重跑。");
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return deckIrSchema.parse(parsed.deckIr);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "manifest deckIr parse failed";
      throw new BadRequestException(`该 v2 deck 的结构化 IR 无法读取：${reason}`);
    }
  }

  private buildV2TemplateRerunCheckpoint(input: {
    sourceUserMessageId: string;
    projectName: string;
    pendingUserMessage: PptMessageDto;
    context: { summaryText: string; recentMessages: PptMessageDto[] };
    deck: DeckIR;
    registry: SkillRegistry;
    pinnedTemplate: TemplatePackage;
    outputRoot: string;
  }): HtmlPptV2ChatCheckpoint {
    const deckId = randomUUID();
    const outputDir = resolve(input.outputRoot, deckId);
    const templateSelection: TemplateSelectionResult = {
      selectedTemplate: input.pinnedTemplate,
      source: "pinned",
      attempts: 0,
      shortlist: [{
        id: input.pinnedTemplate.id,
        deterministicScore: 999,
        reason: "User requested a completed-deck template rerun."
      }],
      rationale: `User switched the completed deck to template '${input.pinnedTemplate.id}'.`,
      confidence: "high",
      validationErrors: []
    };
    const traceSelection = this.v2TemplateSelectionTrace(templateSelection);
    return {
      version: "html-ppt-v2-checkpoint-v1",
      sourceUserMessageId: input.sourceUserMessageId,
      projectName: input.projectName,
      pendingUserMessage: input.pendingUserMessage,
      context: input.context,
      nextStage: "04-design",
      deckId,
      outputDir,
      registryHash: input.registry.hash,
      intent: input.deck.intent,
      evidence: input.deck.evidence,
      narrative: input.deck.narrative,
      templateSelection,
      trace: {
        intentSource: "fallback",
        evidenceSource: "fallback",
        narrativeSource: "fallback",
        templateSelectionSource: "pinned",
        templateSelection: traceSelection,
        stageAttempts: {
          intent: 0,
          templateSelection: 0,
          evidence: 0,
          narrative: 0,
          design: 0,
          layoutPlan: 0,
          slotFill: 0,
          critic: 0
        },
        modelCalls: 0,
        warnings: [`Template rerun reused Stage 1-3 IR from deck '${input.deck.design.donorTemplateId}'.`],
        renderRemediation: defaultRenderRemediationTrace()
      },
      updatedAt: new Date().toISOString()
    };
  }

  private messageTemplateFromPackage(template: TemplatePackage): PptMessageTemplate {
    return {
      id: template.id,
      label: template.label["zh-CN"],
      description: template.description["zh-CN"]
    };
  }

  private deckSpecFromV2Deck(deck: DeckIR): PptDeckSpec {
    const layoutBySlide = new Map(deck.layoutPlan.map((item) => [item.slideIndex, item.layoutId]));
    return {
      schemaVersion: "2.0",
      title: deck.narrative.slides[0]?.contentBrief.headline ?? deck.intent.topic,
      subtitle: deck.narrative.slides[0]?.contentBrief.subhead,
      language: deck.intent.language,
      template: "html-ppt-v2",
      theme: deck.design.themeId,
      visualSystem: {
        density: "balanced",
        tone: deck.intent.tone,
        backupThemes: [deck.design.donorTemplateId],
        customStyleHints: [
          `deckClass=${deck.design.deckClass}`,
          `donor=${deck.design.donorTemplateId}`,
          `registry=${deck.meta.irVersion}`
        ]
      },
      audience: deck.intent.audience,
      goal: deck.intent.topic,
      slides: deck.narrative.slides.map((slide): PptDeckSlide => {
        const layoutId = layoutBySlide.get(slide.index);
        return {
          id: `v2-slide-${slide.index}`,
          type: this.v2SlideRoleToDeckType(slide.role),
          layout: this.v2LayoutToDeckLayout(layoutId),
          title: slide.contentBrief.headline,
          subtitle: slide.contentBrief.subhead,
          kicker: slide.beat,
          body: slide.contentBrief.supportingPoints,
          blocks: (slide.contentBrief.keyMetrics ?? []).map((metric) => ({
            type: "metric",
            label: metric
          })),
          data: {
            v2SlideIndex: slide.index,
            v2Role: slide.role,
            v2LayoutId: layoutId,
            densityBudget: slide.densityBudget,
            estimatedNarrativeChars: slide.estimatedNarrativeChars
          }
        };
      })
    };
  }

  private deckRenderFromV2Result(result: HtmlPptV2PublishResult): PptDeckRender {
    const deckId = encodeURIComponent(result.deckId);
    const title = result.deck.narrative.slides[0]?.contentBrief.headline ?? result.deck.intent.topic;
    return {
      deckId: result.deckId,
      title,
      previewUrl: `/api/ppt/v2/decks/${deckId}/preview.html`,
      downloadUrl: `/api/ppt/v2/decks/${deckId}/download.zip`,
      manifestUrl: `/api/ppt/v2/decks/${deckId}/manifest.json`,
      verificationReportUrl: `/api/ppt/v2/decks/${deckId}/verification-report.json`,
      verificationMode: result.verification.mode,
      verificationStatus: result.verification.status,
      screenshotCount: result.verification.screenshots.length,
      screenshots: result.verification.screenshots.map((screenshot) => ({
        slideIndex: screenshot.slideIndex,
        url: `/api/ppt/v2/decks/${deckId}/screenshots/${encodeURIComponent(basename(screenshot.file))}`
      })),
      auxiliaryArtifacts: Object.fromEntries(
        Object.entries(result.auxiliary.artifacts).map(([key, file]) => [
          key,
          `/api/ppt/v2/decks/${deckId}/artifacts/${encodeURIComponent(file)}`
        ])
      ),
      pipeline: "html-ppt-v2",
      outputDir: result.outputDir,
      templateSelection: {
        mode: result.trace.templateSelectionSource,
        chosenTemplateId: result.trace.templateSelection.chosenTemplateId,
        shortlist: result.trace.templateSelection.shortlist,
        rationale: result.trace.templateSelection.rationale,
        confidence: result.trace.templateSelection.confidence
      },
      createdAt: new Date().toISOString()
    };
  }

  private v2CompletedSteps(
    result: HtmlPptV2PublishResult,
    startedAt: string,
    endedAt: string,
    offset: number
  ): PptGenerationStep[] {
    const trace = result.trace;
    const stages: Array<[string, string]> = [
      ["01 Intent", `source=${trace.intentSource}; attempts=${trace.stageAttempts.intent}`],
      ["01b Template Select", `source=${trace.templateSelectionSource}; attempts=${trace.stageAttempts.templateSelection ?? 0}; selected=${trace.templateSelection.chosenTemplateId}`],
      ["02 Evidence", `source=${trace.evidenceSource}; attempts=${trace.stageAttempts.evidence}; facts=${result.deck.evidence.facts.length}`],
      ["03 Narrative", `source=${trace.narrativeSource}; attempts=${trace.stageAttempts.narrative}; slides=${result.deck.narrative.slides.length}`],
      ["04 Design", `source=${trace.designSource}; attempts=${trace.stageAttempts.design}; theme=${result.deck.design.themeId}; donor=${result.deck.design.donorTemplateId}`],
      ["05 Layout", `source=${trace.layoutPlanSource}; attempts=${trace.stageAttempts.layoutPlan}; layouts=${result.deck.layoutPlan.map((item) => item.layoutId).join(", ")}`],
      ["06 Slots", `source=${trace.slotFillSource}; attempts=${trace.stageAttempts.slotFill}; slots=${result.deck.slots.length}`],
      ["07 Assets", `source=${trace.assetSource}; assets=${Object.keys(result.deck.assets).length}`],
      ["08 Choreography", `source=${trace.choreographySource}; entries=${result.deck.choreography.length}`],
      ["09 Critic", `source=${trace.criticSource}; rounds=${trace.criticRounds}; warnings=${trace.warnings.length}`],
      ["10 Render", `source=${trace.renderSource}; output=${trace.files.indexHtml}`],
      ["11 Verify", `source=${trace.verificationSource}; status=${result.verification.status}; screenshots=${result.verification.screenshots.length}`],
      ["12 Artifacts", `source=${trace.auxiliarySource}; files=${Object.keys(result.auxiliary.artifacts).length}`],
      ["13 Publish", `deckId=${result.deckId}; zip=${trace.files.zip}`]
    ];

    return stages.map(([name, detail], index) => ({
      id: `step-${offset + index + 1}`,
      name,
      status: "completed" as const,
      startedAt,
      endedAt,
      detail
    }));
  }

  private v2SlideRoleToDeckType(role: string): PptDeckSlideType {
    if (role === "cover") return "cover";
    if (role === "toc") return "agenda";
    if (role === "transition-divider") return "section";
    if (role === "comparison") return "comparison";
    if (role === "data-highlight") return "data";
    if (role === "synthesis") return "summary";
    if (role === "cta" || role === "thanks") return "closing";
    if (role === "process") return "timeline";
    return "content";
  }

  private v2LayoutToDeckLayout(layoutId?: string): PptDeckLayout | undefined {
    if (!layoutId) return undefined;
    if (layoutId === "cover") return "cover-hero";
    if (layoutId === "toc") return "toc-grid";
    if (layoutId === "kpi-grid" || layoutId === "stat-highlight") return "kpi-grid";
    if (layoutId === "timeline") return "timeline-ribbon";
    if (layoutId === "comparison") return "comparison-board";
    if (layoutId === "process") return "flow-diagram";
    if (layoutId === "cta") return "closing-cta";
    return "content-cards";
  }

  private shouldUseV2Pipeline(projectTemplateId: string | null, content: string, template: PptMessageTemplate | null) {
    void projectTemplateId;
    void content;
    void template;
    return true;
  }

  private resolvePipelineFromMeta(meta: Record<string, unknown>): DeckPipeline {
    void meta;
    return "v2";
  }

  private formatDeckSpecAssistantMessage(
    deckSpec: PptDeckSpec,
    deckRender: PptDeckRender | null,
    orchestration?: PptGenerationOrchestration | null
  ) {
    if (deckSpec.template === "html-ppt-v2") {
      return [
        "已通过 HTML-PPT v2 结构化 IR 编排生成独立 HTML-PPT。",
        "",
        `标题：${deckSpec.title}`,
        `主题：${deckSpec.theme}`,
        `页数：${deckSpec.slides.length}`,
        `管线：模型 JSON IR → 确定性渲染 → Playwright 验证 → 辅助文件 → 打包发布`,
        deckRender?.verificationStatus ? `校验：${deckRender.verificationStatus} / ${deckRender.verificationMode ?? "unknown"}` : "",
        deckRender?.screenshotCount !== undefined ? `浏览器截图：${deckRender.screenshotCount} 张` : "",
        orchestration ? `编排调用：${orchestration.totalModelCalls} 次模型调用 / ${orchestration.steps.length} 个步骤` : "",
        deckRender ? `预览：${deckRender.previewUrl}` : "",
        deckRender ? `下载：${deckRender.downloadUrl}` : "",
        deckRender?.verificationReportUrl ? `校验报告：${deckRender.verificationReportUrl}` : "",
        "",
        "本次输出不由模型直接编写 HTML/CSS；HTML、CSS、运行时和交付包均由 v2 renderer 确定性生成。"
      ].filter(Boolean).join("\n");
    }

    if (deckSpec.template === "html-ppt-agent") {
      return [
        "已按照 html-ppt-skill 直写编排生成独立 HTML-PPT 项目。",
        "",
        `标题：${deckSpec.title}`,
        `主题：${deckSpec.theme}`,
        `页数：${deckSpec.slides.length}`,
        deckSpec.visualSystem?.tone ? `视觉方向：${deckSpec.visualSystem.tone}` : "",
        orchestration ? `编排调用：${orchestration.totalModelCalls} 次模型调用 / ${orchestration.steps.length} 个步骤` : "",
        deckRender ? `预览：${deckRender.previewUrl}` : "",
        deckRender ? `下载：${deckRender.downloadUrl}` : "",
        "",
        "本次输出由模型直接生成 index.html 与 style.css，后端固定脚本已复制 assets、内联主题并打包。"
      ].filter(Boolean).join("\n");
    }

    return [
      "已生成 DeckSpec JSON，并已渲染为统一 HTML-PPT 项目。",
      "",
      `标题：${deckSpec.title}`,
      `模板：${deckSpec.template}`,
      `主题：${deckSpec.theme}`,
      `页数：${deckSpec.slides.length}`,
      orchestration ? `编排调用：${orchestration.totalModelCalls} 次模型调用 / ${orchestration.steps.length} 个步骤` : "",
      deckRender ? `预览：${deckRender.previewUrl}` : "",
      deckRender ? `下载：${deckRender.downloadUrl}` : "",
      "",
      "```json",
      JSON.stringify(deckSpec, null, 2),
      "```"
    ].join("\n");
  }

  private formatDeckProgressMessage(
    detail: string,
    orchestration: PptGenerationOrchestration,
    status: DeckProgressUpdate["generationStatus"]
  ) {
    const activeStep = orchestration.steps.at(-1);
    const statusLabel = status === "failed" ? "编排遇到问题" : "正在生成 HTML-PPT";
    return [
      statusLabel,
      "",
      activeStep ? `当前步骤：${activeStep.name}` : "",
      `进度说明：${detail}`,
      `模型调用：${orchestration.totalModelCalls} 次`,
      `超时策略：单次 MiniMax 请求超过 ${Math.round(this.modelRequestTimeoutMs() / 1000)} 秒会中断；完整编排包含多次调用，总耗时可能超过该数值。`,
      "页面会自动刷新进度，请不要重复提交。"
    ].filter(Boolean).join("\n");
  }

  private formatDeckSpecFailureMessage(
    errorMessage: string,
    orchestration?: PptGenerationOrchestration | null
  ) {
    return [
      "Deck 编排未完成。",
      "",
      `失败原因：${errorMessage}`,
      orchestration ? `编排调用：${orchestration.totalModelCalls} 次模型调用 / ${orchestration.steps.length} 个步骤` : "",
      "你可以根据下方步骤日志调整提示词后重试。"
    ].filter(Boolean).join("\n");
  }

  private formatMessageForModel(message: PptMessageDto) {
    if (message.role !== "user") {
      if (message.deckSpec) {
        return [
          this.stripModelReasoning(message.content),
          `DeckSpec：${message.deckSpec.title} / ${message.deckSpec.template} / ${message.deckSpec.slides.length} pages`
        ].join("\n");
      }

      return this.stripModelReasoning(message.content);
    }

    const parts: string[] = [];
    if (message.template) {
      parts.push(`当前模板：${message.template.label}（${message.template.description}）`);
    }

    if (message.files.length > 0) {
      parts.push(
        `附件信息：${message.files
          .map((file) => `${file.name} [${file.type || "unknown"} / ${file.size} bytes]`)
          .join("；")}`
      );
    }

    parts.push(`用户输入：${message.content}`);
    return parts.join("\n");
  }

  private shouldGenerateDeckSpec(content: string) {
    const value = content.toLowerCase();
    const hasDeckTarget =
      /ppt|html-ppt|htmlppt|幻灯片|演示文稿|slides?|deck|presentation/.test(value);
    const hasGenerateAction =
      /生成|生产|创建|制作|设计|写|整理|产出|做一份|做成|输出|渲染|新增|添加|修改|更新|改成|generate|produce|create|make|build|design|write|add|update|revise/.test(value);
    const mentionsHtmlPptSkill = value.includes("html-ppt") && value.includes("skill");
    const containsSlideOutline = /幻灯片\s*\d+|第\s*\d+\s*页|slide\s*\d+/i.test(content);

    return hasDeckTarget && (hasGenerateAction || mentionsHtmlPptSkill || containsSlideOutline);
  }

  private parseJsonObject(content: string) {
    const cleaned = this.stripModelReasoning(content);
    const fencedMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fencedMatch?.[1]?.trim() ?? this.extractBalancedJson(cleaned);

    if (!candidate) {
      return null;
    }

    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }

  private extractBalancedJson(content: string) {
    const start = content.indexOf("{");
    if (start < 0) {
      return "";
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < content.length; index++) {
      const char = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return content.slice(start, index + 1);
        }
      }
    }

    return "";
  }

  private normalizeDeckSpec(
    input: unknown,
    fallback: { templateId: string; theme: string }
  ): PptDeckSpec {
    if (!input || typeof input !== "object") {
      throw new ServiceUnavailableException("DeckSpec 必须是 JSON object。");
    }

    const candidate = input as Record<string, unknown>;
    const slidesInput = Array.isArray(candidate.slides) ? candidate.slides : [];
    if (slidesInput.length === 0) {
      throw new ServiceUnavailableException("DeckSpec 至少需要 1 页 slide。");
    }

    const title = this.coerceString(candidate.title, "Untitled Deck");
    const template = this.coerceString(candidate.template, fallback.templateId);
    const theme = this.coerceString(candidate.theme, fallback.theme);
    const slides = slidesInput.map((slide, index) => this.normalizeDeckSlide(slide, index));
    const schemaVersion = candidate.schemaVersion === "2.0" ? "2.0" : "1.0";

    const deckSpec: PptDeckSpec = {
      schemaVersion,
      title,
      subtitle: this.coerceOptionalString(candidate.subtitle),
      language: this.coerceString(candidate.language, "zh-CN"),
      template,
      theme,
      visualSystem: this.normalizeVisualSystem(candidate.visualSystem),
      audience: this.coerceOptionalString(candidate.audience),
      goal: this.coerceOptionalString(candidate.goal),
      slides
    };

    if (candidate.creativeStyle) {
      deckSpec.creativeStyle = this.normalizeDeckCreativeStyle(
        candidate.creativeStyle,
        deckSpec,
        this.htmlPptRendererService.getCreativeStyleCatalog()
      );
    }

    return deckSpec;
  }

  private normalizeDeckSlide(input: unknown, index: number): PptDeckSlide {
    const candidate = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const type = this.normalizeSlideType(candidate.type);
    const layout = this.normalizeDeckLayout(candidate.layout, type);
    const title = this.coerceString(candidate.title, `Slide ${index + 1}`);
    const body = this.coerceStringArray(candidate.body);
    const blocks = this.normalizeDeckBlocks(candidate.blocks);

    return {
      id: this.coerceString(candidate.id, `slide-${index + 1}`),
      type,
      layout,
      title,
      subtitle: this.coerceOptionalString(candidate.subtitle),
      kicker: this.coerceOptionalString(candidate.kicker),
      body,
      blocks,
      quote: this.coerceOptionalString(candidate.quote),
      visualPrompt: this.coerceOptionalString(candidate.visualPrompt),
      animation: this.normalizeDeckAnimation(candidate.animation),
      styleHints: this.coerceStringArray(candidate.styleHints).slice(0, 6),
      notes: this.coerceOptionalString(candidate.notes),
      data: candidate.data && typeof candidate.data === "object" && !Array.isArray(candidate.data)
        ? (candidate.data as Record<string, unknown>)
        : undefined
    };
  }

  private normalizeVisualSystem(input: unknown): PptDeckVisualSystem | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const densityRaw = this.coerceOptionalString(candidate.density);
    const density = densityRaw === "calm" || densityRaw === "balanced" || densityRaw === "dense"
      ? densityRaw
      : undefined;

    return {
      density,
      tone: this.coerceOptionalString(candidate.tone),
      backupThemes: this.coerceStringArray(candidate.backupThemes).slice(0, 8),
      customStyleHints: this.coerceStringArray(candidate.customStyleHints).slice(0, 8)
    };
  }

  private normalizeDeckLayout(input: unknown, type: PptDeckSlideType): PptDeckLayout {
    if (typeof input === "string" && ALLOWED_DECK_LAYOUTS.has(input as PptDeckLayout)) {
      return input as PptDeckLayout;
    }

    return this.defaultLayoutForType(type);
  }

  private defaultLayoutForType(type: PptDeckSlideType): PptDeckLayout {
    const mapping: Record<PptDeckSlideType, PptDeckLayout> = {
      cover: "cover-hero",
      agenda: "toc-grid",
      section: "content-cards",
      content: "content-cards",
      quote: "closing-cta",
      timeline: "timeline-ribbon",
      comparison: "comparison-board",
      data: "kpi-grid",
      summary: "roadmap",
      closing: "closing-cta"
    };

    return mapping[type] ?? "content-cards";
  }

  private normalizeDeckBlocks(input: unknown): PptDeckBlock[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const blocks = input
      .map((item, index) => this.normalizeDeckBlock(item, index))
      .filter((block): block is PptDeckBlock => Boolean(block))
      .slice(0, 12);

    return blocks.length > 0 ? blocks : undefined;
  }

  private normalizeDeckBlock(input: unknown, index: number): PptDeckBlock | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const rawType = typeof candidate.type === "string" ? candidate.type : "";
    const type = ALLOWED_DECK_BLOCK_TYPES.has(rawType as PptDeckBlockType)
      ? (rawType as PptDeckBlockType)
      : "card";
    const meta = candidate.meta && typeof candidate.meta === "object" && !Array.isArray(candidate.meta)
      ? (candidate.meta as Record<string, unknown>)
      : undefined;

    return {
      type,
      title: this.coerceOptionalString(candidate.title),
      label: this.coerceOptionalString(candidate.label) ?? (type === "card" ? `模块 ${index + 1}` : undefined),
      value: this.coerceOptionalString(candidate.value),
      subtitle: this.coerceOptionalString(candidate.subtitle),
      body: this.coerceOptionalString(candidate.body),
      items: this.coerceStringArray(candidate.items).slice(0, 8),
      accent: this.coerceOptionalString(candidate.accent),
      meta
    };
  }

  private normalizeDeckAnimation(input: unknown): PptDeckAnimation | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const presetRaw = this.coerceOptionalString(candidate.preset);
    const fxRaw = this.coerceOptionalString(candidate.fx);
    const intensityRaw = this.coerceOptionalString(candidate.intensity);
    const preset = presetRaw && ALLOWED_DECK_ANIMATIONS.has(presetRaw) ? presetRaw : undefined;
    const fx = fxRaw && ALLOWED_DECK_FX.has(fxRaw) ? fxRaw : undefined;
    const intensity = intensityRaw === "none" || intensityRaw === "subtle" || intensityRaw === "standard" || intensityRaw === "high"
      ? intensityRaw
      : undefined;

    if (!preset && !fx && typeof candidate.stagger !== "boolean" && !intensity) {
      return undefined;
    }

    return {
      preset,
      stagger: typeof candidate.stagger === "boolean" ? candidate.stagger : undefined,
      fx,
      intensity
    };
  }

  private normalizeSlideType(input: unknown): PptDeckSlideType {
    if (typeof input === "string" && ALLOWED_SLIDE_TYPES.has(input as PptDeckSlideType)) {
      return input as PptDeckSlideType;
    }

    return "content";
  }

  private coerceString(input: unknown, fallback: string) {
    if (typeof input === "string" && input.trim().length > 0) {
      return this.sanitizeDeckText(input.trim());
    }

    return fallback;
  }

  private coerceOptionalString(input: unknown) {
    if (typeof input === "string" && input.trim().length > 0) {
      return this.sanitizeDeckText(input.trim());
    }

    return undefined;
  }

  private coerceStringArray(input: unknown) {
    if (Array.isArray(input)) {
      return input
        .map((item) => (typeof item === "string" ? this.sanitizeDeckText(item.trim()) : ""))
        .filter((item) => item.length > 0);
    }

    if (typeof input === "string" && input.trim().length > 0) {
      return [this.sanitizeDeckText(input.trim())];
    }

    return [];
  }

  private coerceNumberArray(input: unknown) {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .map((item) => {
        const value = typeof item === "number" ? item : Number(item);
        return Number.isFinite(value) ? Math.round(value) : null;
      })
      .filter((item): item is number => item !== null);
  }

  private sanitizeDeckText(input: string) {
    return input.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim();
  }

  private defaultThemeForTemplate(templateId: string) {
    const mapping: Record<string, string> = {
      "pitch-deck": "pitch-deck-vc",
      "product-launch": "corporate-clean",
      "tech-sharing": "tokyo-night",
      "weekly-report": "swiss-grid",
      "xhs-post": "xiaohongshu-white",
      "xhs-white-editorial": "xiaohongshu-white",
      "xhs-pastel-card": "soft-pastel",
      "course-module": "academic-paper",
      "presenter-mode-reveal": "retro-tv",
      "graphify-dark-graph": "tokyo-night",
      "knowledge-arch-blueprint": "blueprint",
      "hermes-cyber-terminal": "cyberpunk-neon",
      "obsidian-claude-gradient": "aurora",
      "dir-key-nav-minimal": "minimal-white",
      "testing-safety-alert": "news-broadcast"
    };

    return mapping[templateId] ?? "corporate-clean";
  }

  private extractAssistantContent(payload: ChatCompletionResponse) {
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return this.stripModelReasoning(content);
    }

    if (Array.isArray(content)) {
      return this.stripModelReasoning(
        content
        .map((item) => item.text ?? "")
        .join("\n")
      );
    }

    return "";
  }

  private extractProviderErrorMessage(payload: ChatCompletionResponse | ChatCompletionErrorResponse | null, fallback: string) {
    if (!payload || typeof payload !== "object") {
      return fallback;
    }

    if ("error" in payload && payload.error?.message) {
      const code = payload.error.code ? ` (${payload.error.code})` : "";
      return `${payload.error.message}${code}`;
    }

    if ("base_resp" in payload && payload.base_resp?.status_msg) {
      const code = payload.base_resp.status_code ? ` (${payload.base_resp.status_code})` : "";
      return `${payload.base_resp.status_msg}${code}`;
    }

    if ("status_msg" in payload && payload.status_msg) {
      const code = payload.status_code ? ` (${payload.status_code})` : "";
      return `${payload.status_msg}${code}`;
    }

    if ("message" in payload && payload.message) {
      return payload.message;
    }

    return fallback;
  }

  private isProviderSensitiveOutput(message: string, payload?: ChatCompletionResponse | ChatCompletionErrorResponse | null) {
    const serializedPayload = payload ? JSON.stringify(payload) : "";
    const value = `${message} ${serializedPayload}`.toLowerCase();
    return value.includes("new_sensitive") || value.includes("sensitive") || value.includes("1027");
  }

  private stripModelReasoning(content: string) {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  private getHtmlPptSkillPrompt() {
    return HTML_PPT_SKILL_PROMPT;
  }

  private async buildConversationContext(userId: number, projectId: string) {
    await this.getOwnedProject(userId, projectId);
    const totalCount = await this.getMessageCount(projectId);
    const summaryRow = await this.getSummaryRow(projectId);
    const summarizedMessageCount = summaryRow?.summarized_message_count ?? 0;
    const summaryText = summaryRow?.summary_text ?? "";
    const startOffset = Math.max(summarizedMessageCount, Math.max(0, totalCount - RECENT_MESSAGE_LIMIT));

    const recentResult = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1
        ORDER BY created_at ASC, id ASC
        OFFSET $2
        LIMIT $3
      `,
      [projectId, startOffset, RECENT_MESSAGE_LIMIT]
    );

    return {
      summaryText,
      recentMessages: recentResult.rows.map((row) => this.mapMessage(row))
    };
  }

  private async buildConversationContextBeforeMessage(userId: number, projectId: string, beforeMessage: MessageRow) {
    await this.getOwnedProject(userId, projectId);
    const summaryRow = await this.getSummaryRow(projectId);
    const summaryText = summaryRow?.summary_text ?? "";
    const recentResult = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1
          AND (
            created_at < $2
            OR (created_at = $2 AND id < $3)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [projectId, beforeMessage.created_at, beforeMessage.id, RECENT_MESSAGE_LIMIT]
    );

    return {
      summaryText,
      recentMessages: recentResult.rows.reverse().map((row) => this.mapMessage(row))
    };
  }

  private async resolveSourceUserMessage(
    projectId: string,
    assistantRow: MessageRow,
    sourceUserMessageId?: string | null
  ) {
    if (sourceUserMessageId) {
      const sourceResult = await this.databaseService.query<MessageRow>(
        `
          SELECT id, role, content, meta, created_at
          FROM ppt_messages
          WHERE project_id = $1 AND id = $2 AND role = 'user'
          LIMIT 1
        `,
        [projectId, sourceUserMessageId]
      );
      const sourceRow = sourceResult.rows[0];
      if (sourceRow) {
        return sourceRow;
      }
    }

    const fallbackResult = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1
          AND role = 'user'
          AND (
            created_at < $2
            OR (created_at = $2 AND id < $3)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [projectId, assistantRow.created_at, assistantRow.id]
    );
    const fallbackRow = fallbackResult.rows[0];
    if (!fallbackRow) {
      throw new BadRequestException("无法定位原始用户请求，不能继续生成。");
    }

    return fallbackRow;
  }

  private async maybeCompressConversation(userId: number, projectId: string) {
    await this.getOwnedProject(userId, projectId);

    const totalCount = await this.getMessageCount(projectId);
    if (totalCount <= RECENT_MESSAGE_LIMIT) {
      return;
    }

    const targetSummarizedCount = totalCount - RECENT_MESSAGE_LIMIT;
    const summaryRow = await this.getSummaryRow(projectId);
    const currentSummarizedCount = summaryRow?.summarized_message_count ?? 0;

    if (currentSummarizedCount >= targetSummarizedCount) {
      return;
    }

    const batchResult = await this.databaseService.query<MessageRow>(
      `
        SELECT id, role, content, meta, created_at
        FROM ppt_messages
        WHERE project_id = $1
        ORDER BY created_at ASC, id ASC
        OFFSET $2
        LIMIT $3
      `,
      [projectId, currentSummarizedCount, targetSummarizedCount - currentSummarizedCount]
    );

    if (batchResult.rows.length === 0) {
      return;
    }

    const updatedSummary = await this.generateConversationSummary(
      userId,
      projectId,
      summaryRow?.summary_text ?? "",
      batchResult.rows.map((row) => this.mapMessage(row))
    );

    await this.upsertSummary(projectId, updatedSummary, targetSummarizedCount);
  }

  private async generateConversationSummary(
    userId: number,
    projectId: string,
    previousSummary: string,
    messages: PptMessageDto[]
  ) {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const systemPrompt = [
      "你是一个 HTML-PPT 会话摘要器。",
      "你的任务是把旧对话压缩成结构化摘要，供后续对话继续使用。",
      "必须保留：项目目标、已选模板、风格偏好、已确认内容、约束条件、待办事项、重要事实、附件线索。",
      "不要包含 HTML-PPT skill 原文，不要输出无关寒暄，不要编造事实。",
      "输出要简洁、稳定、可直接继续喂给模型。",
      "推荐格式：项目目标 / 模板 / 风格 / 已确认 / 约束 / 待办 / 重要事实 / 附件线索。"
    ].join("\n");

    const userPrompt = [
      previousSummary.trim().length > 0 ? `已有摘要：\n${previousSummary.trim()}` : "已有摘要：无。",
      "待压缩对话：",
      ...messages.map((message, index) => {
        const label = message.role === "user" ? "用户" : "助手";
        return `${index + 1}. ${label}：${this.formatMessageForModel(message)}`;
      })
    ].join("\n");

    const response = await this.requestChatCompletion(
      activeConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      "摘要生成失败。",
      userId,
      {
        projectId,
        stage: "conversation-summary",
        source: "ppt-chat"
      }
    );

    const payload = (await response.json().catch(() => null)) as ChatCompletionResponse | { error?: { message?: string } } | null;

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        payload.error?.message
          ? payload.error.message
          : "摘要生成失败。";
      throw new ServiceUnavailableException(message);
    }

    const content = payload && "choices" in payload ? this.extractAssistantContent(payload) : null;
    if (!content) {
      throw new ServiceUnavailableException("摘要没有返回有效内容。");
    }

    return content;
  }

  private async getMessageCount(projectId: string) {
    const result = await this.databaseService.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM ppt_messages
        WHERE project_id = $1
      `,
      [projectId]
    );

    return Number(result.rows[0]?.count ?? "0");
  }

  private async getSummaryRow(projectId: string) {
    const result = await this.databaseService.query<SummaryRow>(
      `
        SELECT project_id, summary_text, summarized_message_count, updated_at
        FROM ppt_project_summaries
        WHERE project_id = $1
        LIMIT 1
      `,
      [projectId]
    );

    return result.rows[0] ?? null;
  }

  private async upsertSummary(projectId: string, summaryText: string, summarizedMessageCount: number) {
    await this.databaseService.query(
      `
        INSERT INTO ppt_project_summaries (
          project_id,
          summary_text,
          summarized_message_count,
          updated_at
        )
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (project_id) DO UPDATE
        SET
          summary_text = EXCLUDED.summary_text,
          summarized_message_count = EXCLUDED.summarized_message_count,
          updated_at = NOW()
      `,
      [projectId, summaryText, summarizedMessageCount]
    );
  }

  private async getOwnedProject(userId: number, projectId: string) {
    const result = await this.databaseService.query<ProjectRow>(
      `
        SELECT id, name, template_id, status, created_at, updated_at
        FROM ppt_projects
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [projectId, userId]
    );

    const project = result.rows[0];
    if (!project) {
      throw new NotFoundException("PPT 项目不存在。");
    }

    return project;
  }

  private mapProject(row: ProjectRow): PptProjectSummary {
    return {
      id: row.id,
      name: row.name,
      templateId: row.template_id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private mapMessage(row: MessageRow): PptMessageDto {
    const meta = row.meta ?? {};
    const deckSpec = this.normalizeStoredDeckSpec(meta.deckSpec);
    const deckRender = this.normalizeStoredDeckRender(meta.deckRender);
    const orchestration = this.normalizeStoredOrchestration(meta.orchestration);
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      files: this.normalizeFiles(meta.files),
      template: this.normalizeTemplate(meta.template),
      deckSpec,
      deckRender,
      orchestration,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private async mapMessageForResponse(row: MessageRow): Promise<PptMessageDto> {
    const meta = row.meta ?? {};
    const deckSpec = this.normalizeStoredDeckSpec(meta.deckSpec);
    const deckRender = this.normalizeStoredDeckRender(meta.deckRender);
    const orchestration = this.normalizeStoredOrchestration(meta.orchestration);
    const generationStatus = this.normalizeOptionalString(meta.generationStatus);

    if (row.role === "assistant" && deckSpec && !deckRender) {
      const render = await this.htmlPptRendererService.renderDeck(deckSpec);
      const nextMeta = {
        ...meta,
        deckRender: render
      };
      await this.databaseService.query("UPDATE ppt_messages SET meta = $2::jsonb WHERE id = $1", [
        row.id,
        JSON.stringify(nextMeta)
      ]);

      return this.mapMessage({
        ...row,
        meta: nextMeta
      });
    }

    if (
      row.role === "assistant" &&
      !deckRender &&
      generationStatus === "running" &&
      orchestration &&
      this.isStaleRunningOrchestration(orchestration)
    ) {
      const staleOrchestration = this.markStaleRunningOrchestration(orchestration);
      const errorMessage = this.staleRunningMessage();
      const nextMeta = {
        ...meta,
        orchestration: staleOrchestration,
        generationStatus: "failed",
        generationError: errorMessage
      };
      const nextContent = this.formatDeckSpecFailureMessage(errorMessage, staleOrchestration);
      await this.databaseService.query("UPDATE ppt_messages SET content = $2, meta = $3::jsonb WHERE id = $1", [
        row.id,
        nextContent,
        JSON.stringify(nextMeta)
      ]);

      return this.mapMessage({
        ...row,
        content: nextContent,
        meta: nextMeta
      });
    }

    return this.mapMessage(row);
  }

  private isStaleRunningOrchestration(orchestration?: PptGenerationOrchestration | null) {
    const lastStep = orchestration?.steps.at(-1);
    if (!lastStep || lastStep.status !== "running") {
      return false;
    }

    const heartbeatAt = Date.parse(lastStep.endedAt || lastStep.startedAt);
    if (!Number.isFinite(heartbeatAt)) {
      return false;
    }

    return Date.now() - heartbeatAt > this.runningHeartbeatStaleMs();
  }

  private markStaleRunningOrchestration(orchestration: PptGenerationOrchestration) {
    const now = new Date().toISOString();
    const steps = orchestration.steps.map((step, index) => {
      if (index !== orchestration.steps.length - 1 || step.status !== "running") {
        return step;
      }

      return {
        ...step,
        status: "timeout" as const,
        endedAt: now,
        detail: `${step.detail} ${this.staleRunningMessage()}`,
        durationMs: this.durationMsBetween(step.startedAt, now),
        failureReason: this.staleRunningMessage()
      };
    });

    return {
      ...orchestration,
      finishedAt: now,
      steps
    };
  }

  private staleRunningMessage() {
    return `后台任务心跳超过 ${Math.round(this.runningHeartbeatStaleMs() / 1000)} 秒未更新，可能因服务重启或模型请求中断而失联；可以点击继续生成。`;
  }

  private durationMsBetween(startedAt: string, endedAt: string) {
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  }

  private runningHeartbeatStaleMs() {
    const parsed = Number(process.env.PPT_RUNNING_HEARTBEAT_STALE_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
  }

  private normalizeStoredDeckSpec(input: unknown) {
    if (!input) {
      return undefined;
    }

    try {
      return this.normalizeDeckSpec(input, { templateId: "auto", theme: this.defaultThemeForTemplate("auto") });
    } catch {
      return undefined;
    }
  }

  private normalizeStoredDeckRender(input: unknown) {
    if (!input || typeof input !== "object") {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const deckId = this.normalizeOptionalString(candidate.deckId);
    const title = this.normalizeOptionalString(candidate.title);
    const previewUrl = this.normalizeOptionalString(candidate.previewUrl);
    const downloadUrl = this.normalizeOptionalString(candidate.downloadUrl);
    const createdAt = this.normalizeOptionalString(candidate.createdAt);
    const outputDir = this.normalizeOptionalString(candidate.outputDir);
    const manifestUrl = this.normalizeOptionalString(candidate.manifestUrl);
    const verificationReportUrl = this.normalizeOptionalString(candidate.verificationReportUrl);
    const verificationModeValue = this.normalizeOptionalString(candidate.verificationMode);
    const verificationStatusValue = this.normalizeOptionalString(candidate.verificationStatus);
    const pipelineValue = this.normalizeOptionalString(candidate.pipeline);
    const screenshotCount = typeof candidate.screenshotCount === "number" && Number.isFinite(candidate.screenshotCount)
      ? Math.max(0, Math.round(candidate.screenshotCount))
      : undefined;

    if (!deckId || !title || !previewUrl || !downloadUrl || !createdAt) {
      return undefined;
    }

    const screenshots = Array.isArray(candidate.screenshots)
      ? candidate.screenshots
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const value = item as Record<string, unknown>;
            const slideIndex = typeof value.slideIndex === "number" && Number.isFinite(value.slideIndex)
              ? Math.round(value.slideIndex)
              : null;
            const url = this.normalizeOptionalString(value.url);
            return slideIndex && url ? { slideIndex, url } : null;
          })
          .filter((item): item is { slideIndex: number; url: string } => Boolean(item))
      : undefined;
    const auxiliaryArtifacts = candidate.auxiliaryArtifacts && typeof candidate.auxiliaryArtifacts === "object"
      ? Object.fromEntries(
          Object.entries(candidate.auxiliaryArtifacts as Record<string, unknown>)
            .map(([key, value]) => [key, this.normalizeOptionalString(value)])
            .filter((entry): entry is [string, string] => Boolean(entry[1]))
        )
      : undefined;
    const render: PptDeckRender = {
      deckId,
      title,
      previewUrl,
      downloadUrl,
      createdAt
    };
    if (pipelineValue === "html-ppt-v1" || pipelineValue === "html-ppt-v2") render.pipeline = pipelineValue;
    if (manifestUrl) render.manifestUrl = manifestUrl;
    if (verificationReportUrl) render.verificationReportUrl = verificationReportUrl;
    if (verificationModeValue === "static" || verificationModeValue === "playwright") render.verificationMode = verificationModeValue;
    if (verificationStatusValue === "clean" || verificationStatusValue === "warning" || verificationStatusValue === "failed") {
      render.verificationStatus = verificationStatusValue;
    }
    if (screenshotCount !== undefined) render.screenshotCount = screenshotCount;
    if (screenshots?.length) render.screenshots = screenshots;
    if (auxiliaryArtifacts && Object.keys(auxiliaryArtifacts).length > 0) render.auxiliaryArtifacts = auxiliaryArtifacts;
    if (outputDir) render.outputDir = outputDir;
    const templateSelection = this.normalizeStoredV2TemplateSelectionTrace(candidate.templateSelection);
    if (templateSelection) render.templateSelection = templateSelection;
    return render;
  }

  private normalizeStoredV2TemplateSelectionTrace(input: unknown): PptDeckRender["templateSelection"] | undefined {
    if (!input || typeof input !== "object") {
      return undefined;
    }
    const candidate = input as Record<string, unknown>;
    const mode = candidate.mode === "pinned" || candidate.mode === "auto-deterministic" || candidate.mode === "auto-llm"
      ? candidate.mode
      : undefined;
    const chosenTemplateId = this.normalizeOptionalString(candidate.chosenTemplateId);
    const rationale = this.normalizeOptionalString(candidate.rationale);
    const confidence = candidate.confidence === "high" || candidate.confidence === "medium" || candidate.confidence === "low"
      ? candidate.confidence
      : undefined;
    if (!mode || !chosenTemplateId || !rationale || !confidence) {
      return undefined;
    }
    return {
      mode,
      chosenTemplateId,
      shortlist: this.coerceStringArray(candidate.shortlist),
      rationale,
      confidence
    };
  }

  private normalizeStoredOrchestration(input: unknown): PptGenerationOrchestration | undefined {
    if (!input || typeof input !== "object") {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const stepsRaw = Array.isArray(candidate.steps) ? candidate.steps : [];
    const steps: PptGenerationStep[] = stepsRaw
      .map((item, index) => {
        const value = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const status = value.status;
        if (status !== "running" && status !== "completed" && status !== "failed" && status !== "skipped" && status !== "timeout") {
          return null;
        }

        const startedAt = this.normalizeOptionalString(value.startedAt) ?? new Date().toISOString();
        const endedAt = this.normalizeOptionalString(value.endedAt) ?? new Date().toISOString();
        const durationMs = Number(value.durationMs);
        const modelCalls = Number(value.modelCalls);
        const retryCount = Number(value.retryCount);
        const failureReason = this.normalizeOptionalString(value.failureReason);
        const step: PptGenerationStep = {
          id: this.normalizeOptionalString(value.id) ?? `step-${index + 1}`,
          name: this.normalizeOptionalString(value.name) ?? `步骤 ${index + 1}`,
          status,
          startedAt,
          endedAt,
          detail: this.normalizeOptionalString(value.detail) ?? ""
        };
        if (Number.isFinite(durationMs) && durationMs >= 0) step.durationMs = Math.round(durationMs);
        if (Number.isFinite(modelCalls) && modelCalls >= 0) step.modelCalls = Math.round(modelCalls);
        if (Number.isFinite(retryCount) && retryCount >= 0) step.retryCount = Math.round(retryCount);
        if (failureReason) step.failureReason = failureReason;
        return step;
      })
      .filter((item): item is PptGenerationStep => Boolean(item));

    const version = this.normalizeOptionalString(candidate.version);
    const model = this.normalizeOptionalString(candidate.model);
    const startedAt = this.normalizeOptionalString(candidate.startedAt);
    const finishedAt = this.normalizeOptionalString(candidate.finishedAt);
    const totalModelCalls = Number(candidate.totalModelCalls);

    if (!version || !model || !startedAt || !finishedAt || !Number.isFinite(totalModelCalls)) {
      return undefined;
    }

    return {
      version,
      model,
      startedAt,
      finishedAt,
      totalModelCalls,
      steps
    };
  }

  private normalizeStoredGenerationCheckpoint(input: unknown): DeckResumeCheckpoint | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const sourceUserMessageId = this.normalizeOptionalString(candidate.sourceUserMessageId);
    const projectName = this.normalizeOptionalString(candidate.projectName);
    const templateId = this.normalizeOptionalString(candidate.templateId);
    const theme = this.normalizeOptionalString(candidate.theme);
    const nextStep = this.normalizeDeckResumeNextStep(candidate.nextStep);
    const iterationRaw = Number(candidate.iteration);
    const iteration = Number.isFinite(iterationRaw) ? Math.max(0, Math.min(2, Math.round(iterationRaw))) : 0;
    const pendingUserMessage = this.normalizeStoredPptMessage(candidate.pendingUserMessage);
    const context = this.normalizeStoredPptContext(candidate.context);

    if (!sourceUserMessageId || !projectName || !templateId || !theme || !nextStep || !pendingUserMessage || !context) {
      return null;
    }

    let plan: DeckPlan | undefined;
    if (candidate.plan) {
      plan = this.normalizeDeckPlan(candidate.plan, templateId);
    }

    let deckSpec: PptDeckSpec | undefined;
    if (candidate.deckSpec) {
      try {
        deckSpec = this.normalizeDeckSpec(candidate.deckSpec, { templateId, theme });
      } catch {
        deckSpec = undefined;
      }
    }

    const localQa = this.normalizeStoredLocalQa(candidate.localQa);
    const creativeStyle = deckSpec && candidate.creativeStyle
      ? this.normalizeDeckCreativeStyle(
        candidate.creativeStyle,
        deckSpec,
        this.htmlPptRendererService.getCreativeStyleCatalog()
      )
      : undefined;
    const review = candidate.review ? this.normalizeDeckReview(candidate.review) : undefined;

    return {
      version: "checkpoint-v1",
      sourceUserMessageId,
      projectName,
      templateId,
      theme,
      nextStep,
      iteration,
      pendingUserMessage,
      context,
      plan,
      deckSpec,
      localQa,
      creativeStyle,
      review,
      updatedAt: this.normalizeOptionalString(candidate.updatedAt) ?? new Date().toISOString()
    };
  }

  private normalizeStoredV2Checkpoint(input: unknown): HtmlPptV2ChatCheckpoint | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const version = this.normalizeOptionalString(candidate.version);
    const sourceUserMessageId = this.normalizeOptionalString(candidate.sourceUserMessageId);
    const projectName = this.normalizeOptionalString(candidate.projectName);
    const nextStage = this.normalizeHtmlPptV2Stage(candidate.nextStage);
    const deckId = this.normalizeOptionalString(candidate.deckId);
    const outputDir = this.normalizeOptionalString(candidate.outputDir);
    const pendingUserMessage = this.normalizeStoredPptMessage(candidate.pendingUserMessage);
    const context = this.normalizeStoredPptContext(candidate.context);

    if (
      version !== "html-ppt-v2-checkpoint-v1" ||
      !sourceUserMessageId ||
      !projectName ||
      !nextStage ||
      !deckId ||
      !outputDir ||
      !pendingUserMessage ||
      !context
    ) {
      return null;
    }

    const traceCandidate = candidate.trace && typeof candidate.trace === "object"
      ? candidate.trace as Record<string, unknown>
      : {};
    const attemptsCandidate = traceCandidate.stageAttempts && typeof traceCandidate.stageAttempts === "object"
      ? traceCandidate.stageAttempts as Record<string, unknown>
      : {};
    const trace: HtmlPptV2TraceCheckpoint = {
      ...(traceCandidate as Partial<HtmlPptV2PublishTrace>),
      stageAttempts: {
        intent: Number(attemptsCandidate.intent) || 0,
        templateSelection: Number(attemptsCandidate.templateSelection) || 0,
        evidence: Number(attemptsCandidate.evidence) || 0,
        narrative: Number(attemptsCandidate.narrative) || 0,
        design: Number(attemptsCandidate.design) || 0,
        layoutPlan: Number(attemptsCandidate.layoutPlan) || 0,
        slotFill: Number(attemptsCandidate.slotFill) || 0,
        critic: Number(attemptsCandidate.critic) || 0
      },
      modelCalls: Number(traceCandidate.modelCalls) || 0,
      warnings: this.coerceStringArray(traceCandidate.warnings)
    };

    let deck: DeckIR | undefined;
    if (candidate.deck) {
      const parsed = deckIrSchema.safeParse(candidate.deck);
      deck = parsed.success ? parsed.data : undefined;
    }
    let deckBeforeCritic: DeckIR | undefined;
    if (candidate.deckBeforeCritic) {
      const parsed = deckIrSchema.safeParse(candidate.deckBeforeCritic);
      deckBeforeCritic = parsed.success ? parsed.data : undefined;
    }

    return {
      version: "html-ppt-v2-checkpoint-v1",
      sourceUserMessageId,
      projectName,
      pendingUserMessage,
      context,
      nextStage,
      deckId,
      outputDir,
      registryHash: this.normalizeOptionalString(candidate.registryHash) ?? undefined,
      intent: candidate.intent as IntentIR | undefined,
      templateSelection: this.normalizeStoredV2TemplateSelection(candidate.templateSelection, candidate.intent as IntentIR | undefined),
      evidence: candidate.evidence as EvidencePack | undefined,
      narrative: candidate.narrative as NarrativeIR | undefined,
      design: candidate.design as DesignSystemIR | undefined,
      layoutPlan: candidate.layoutPlan as LayoutPlanIR | undefined,
      slots: candidate.slots as SlotFillIR | undefined,
      assets: candidate.assets as AssetIR | undefined,
      choreography: candidate.choreography as ChoreographyIR | undefined,
      deckBeforeCritic,
      deck,
      verification: candidate.verification as RenderVerificationReport | undefined,
      auxiliary: candidate.auxiliary as AuxiliaryArtifactsStageResult | undefined,
      trace,
      updatedAt: this.normalizeOptionalString(candidate.updatedAt) ?? new Date().toISOString()
    };
  }

  private normalizeStoredV2TemplateSelection(input: unknown, intent?: IntentIR): TemplateSelectionResult | undefined {
    if (!input || typeof input !== "object") {
      return undefined;
    }
    const candidate = input as Record<string, unknown>;
    const selectedTemplate = templatePackageSchema.safeParse(candidate.selectedTemplate);
    if (!selectedTemplate.success) {
      return undefined;
    }
    const source = candidate.source === "pinned" || candidate.source === "auto-llm" || candidate.source === "auto-deterministic"
      ? candidate.source
      : "auto-deterministic";
    const confidence = candidate.confidence === "high" || candidate.confidence === "medium" || candidate.confidence === "low"
      ? candidate.confidence
      : source === "pinned" ? "high" : "medium";
    const shortlist = Array.isArray(candidate.shortlist)
      ? candidate.shortlist
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            id: this.normalizeOptionalString(item.id) ?? selectedTemplate.data.id,
            deterministicScore: Number(item.deterministicScore) || 0,
            reason: this.normalizeOptionalString(item.reason) ?? "Recovered checkpoint candidate."
          }))
          .slice(0, 8)
      : [{
          id: selectedTemplate.data.id,
          deterministicScore: source === "pinned" ? 999 : 0,
          reason: intent ? `Recovered checkpoint candidate for ${intent.topic}.` : "Recovered checkpoint candidate."
        }];
    return {
      selectedTemplate: selectedTemplate.data,
      source,
      attempts: Number(candidate.attempts) || 0,
      shortlist,
      rationale: this.normalizeOptionalString(candidate.rationale) ?? `Recovered selected template '${selectedTemplate.data.id}'.`,
      confidence,
      validationErrors: this.coerceStringArray(candidate.validationErrors)
    };
  }

  private normalizeHtmlPptV2Stage(input: unknown): HtmlPptV2ResumeStage | null {
    const value = this.normalizeOptionalString(input);
    if (
      value === "01-intent" ||
      value === "01b-template-select" ||
      value === "02-evidence" ||
      value === "03-narrative" ||
      value === "04-design" ||
      value === "05-layout" ||
      value === "06-slots" ||
      value === "07-assets" ||
      value === "08-choreography" ||
      value === "09-critic" ||
      value === "10-render" ||
      value === "11-verify" ||
      value === "12-artifacts" ||
      value === "13-publish" ||
      value === "completed"
    ) {
      return value;
    }
    return null;
  }

  private normalizeStoredAgentCheckpoint(input: unknown): HtmlPptAgentCheckpoint | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const version = this.normalizeOptionalString(candidate.version);
    const sourceUserMessageId = this.normalizeOptionalString(candidate.sourceUserMessageId);
    const projectName = this.normalizeOptionalString(candidate.projectName);
    const templateId = this.normalizeOptionalString(candidate.templateId);
    const theme = this.normalizeOptionalString(candidate.theme);
    const nextStage = this.normalizeHtmlPptAgentStage(candidate.nextStage);
    const pendingUserMessage = this.normalizeStoredPptMessage(candidate.pendingUserMessage);
    const context = this.normalizeStoredPptContext(candidate.context);

    if (
      version !== "html-ppt-agent-checkpoint-v1" ||
      !sourceUserMessageId ||
      !projectName ||
      !templateId ||
      !theme ||
      !nextStage ||
      !pendingUserMessage ||
      !context
    ) {
      return null;
    }

    let research: ResearchPack | undefined;
    if (candidate.research && typeof candidate.research === "object") {
      const value = candidate.research as Record<string, unknown>;
      const nextResearch: ResearchPack = {
        topicSummary: this.coerceString(value.topicSummary, ""),
        keyFacts: this.coerceStringArray(value.keyFacts),
        narrativeAngles: this.coerceStringArray(value.narrativeAngles),
        suggestedSections: this.coerceStringArray(value.suggestedSections),
        needVerification: this.coerceStringArray(value.needVerification),
        suggestedSlideCount: Number(value.suggestedSlideCount) || 8,
        perSlideLengthTargets: Array.isArray(value.perSlideLengthTargets)
          ? value.perSlideLengthTargets
              .map((item, index) => {
                const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return {
                  index: Number(entry.index) || index + 1,
                  targetLength: Number(entry.targetLength) || 80,
                  purpose: this.coerceString(entry.purpose, "core body content")
                };
              })
              .filter((item) => item.targetLength > 0)
          : []
      };
      if (nextResearch.perSlideLengthTargets.length === 0) {
        nextResearch.perSlideLengthTargets = Array.from({ length: nextResearch.suggestedSlideCount }, (_, index) => ({
          index: index + 1,
          targetLength: 80,
          purpose: index === 0 ? "opening hook" : index === nextResearch.suggestedSlideCount - 1 ? "closing takeaway" : "core body content"
        }));
      }
      research = nextResearch;
    }

    let plan;
    if (candidate.plan && typeof candidate.plan === "object") {
      const value = candidate.plan as Record<string, unknown>;
      const rawSlides = Array.isArray(value.slides) ? value.slides : [];
      plan = {
        title: this.coerceString(value.title, pendingUserMessage.content.slice(0, 80) || "HTML-PPT"),
        subtitle: this.coerceOptionalString(value.subtitle),
        slideCount: Number(value.slideCount) || rawSlides.length || 1,
        audience: this.coerceString(value.audience, "普通观众"),
        objective: this.coerceString(value.objective, "生成 HTML-PPT"),
        slides: rawSlides
          .map((item, index) => {
            const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
            const rawLayoutId = this.coerceOptionalString(entry.layoutId);
            if (!rawLayoutId) {
              this.logger.warn(`HTML-PPT agent checkpoint slide ${index + 1} is missing layoutId; falling back to two-column.`);
            }
            return {
              index: Number(entry.index) || index + 1,
              title: this.coerceString(entry.title, `第 ${index + 1} 页`),
              type: this.coerceString(entry.type, "content"),
              layoutId: rawLayoutId ?? "two-column",
              goal: this.coerceString(entry.goal, ""),
              keyPoints: this.coerceStringArray(entry.keyPoints)
            };
          })
          .filter((item) => item.title)
      };
    }

    let visual;
    if (candidate.visual && typeof candidate.visual === "object") {
      const value = candidate.visual as Record<string, unknown>;
      visual = {
        primaryTheme: this.coerceString(value.primaryTheme, theme),
        backupThemes: this.coerceStringArray(value.backupThemes),
        referenceTemplates: this.coerceStringArray(value.referenceTemplates),
        deckClass: this.coerceString(value.deckClass, "tpl-html-ppt-agent"),
        visualLanguage: this.coerceString(value.visualLanguage, ""),
        slideVisuals: Array.isArray(value.slideVisuals)
          ? value.slideVisuals
              .map((item, index) => {
                const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return {
                  index: Number(entry.index) || index + 1,
                  composition: this.coerceString(entry.composition, ""),
                  animation: this.coerceOptionalString(entry.animation),
                  fx: this.coerceOptionalString(entry.fx)
                };
              })
              .filter((item) => item.composition)
          : []
      };
    }

    let indexResult;
    if (candidate.indexResult && typeof candidate.indexResult === "object") {
      const value = candidate.indexResult as Record<string, unknown>;
      const html = this.coerceString(value.html, "");
      if (html) {
        indexResult = {
          html,
          batchCount: Number(value.batchCount) || 0,
          concurrency: Number(value.concurrency) || 0,
          repairCalls: Number(value.repairCalls) || 0,
          localRepairCount: Number(value.localRepairCount) || 0,
          stats: Array.isArray(value.stats)
            ? value.stats
                .map((item) => {
                  const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
                  return {
                    batchIndex: Number(entry.batchIndex) || 0,
                    slideIndexes: this.coerceNumberArray(entry.slideIndexes),
                    layoutIds: this.coerceStringArray(entry.layoutIds),
                    densityBudget: Number(entry.densityBudget) || 0,
                    modelRepairCalls: Number(entry.modelRepairCalls) || 0,
                    localRepairCount: Number(entry.localRepairCount) || 0
                  };
                })
                .filter((item) => item.layoutIds.length > 0 || item.slideIndexes.length > 0)
            : []
        };
      }
    }

    let failedIndexState;
    if (candidate.failedIndexState && typeof candidate.failedIndexState === "object") {
      const value = candidate.failedIndexState as Record<string, unknown>;
      const batchSnapshots = Array.isArray(value.batchSnapshots)
        ? value.batchSnapshots
            .map((item) => this.normalizeStoredAgentBatchSnapshot(item))
            .filter((item): item is NonNullable<ReturnType<PptChatService["normalizeStoredAgentBatchSnapshot"]>> => Boolean(item))
        : [];
      const failedBatches = Array.isArray(value.failedBatches)
        ? value.failedBatches
            .map((item) => this.normalizeStoredAgentBatchSnapshot(item))
            .filter((item): item is NonNullable<ReturnType<PptChatService["normalizeStoredAgentBatchSnapshot"]>> => Boolean(item))
        : [];
      const failedBatch = this.normalizeStoredAgentBatchSnapshot(value.failedBatch);
      if (batchSnapshots.length > 0 || failedBatches.length > 0 || failedBatch) {
        failedIndexState = {
          batchSnapshots,
          failedBatches,
          failedBatch: failedBatch ?? undefined
        };
      }
    }

    const failureHistory = Array.isArray(candidate.failureHistory)
      ? candidate.failureHistory
          .map((item) => this.normalizeStoredAgentFailureRecord(item))
          .filter((item): item is HtmlPptAgentFailureRecord => Boolean(item))
          .slice(-16)
      : undefined;

    const styleCss = this.normalizeOptionalString(candidate.styleCss) ?? undefined;
    const deckRender = this.normalizeStoredAgentDeckRender(candidate.deckRender) ?? undefined;

    return {
      version: "html-ppt-agent-checkpoint-v1",
      sourceUserMessageId,
      projectName,
      templateId,
      theme,
      nextStage,
      pendingUserMessage,
      context,
      research,
      plan,
      visual,
      indexResult,
      failedIndexState,
      styleCss,
      deckRender,
      failureHistory,
      updatedAt: this.normalizeOptionalString(candidate.updatedAt) ?? new Date().toISOString()
    };
  }

  private normalizeDeckResumeNextStep(input: unknown): DeckResumeNextStep | null {
    const value = this.normalizeOptionalString(input);
    if (
      value === "plan" ||
      value === "draft" ||
      value === "localQa" ||
      value === "style" ||
      value === "review" ||
      value === "revise" ||
      value === "recheck" ||
      value === "rereview" ||
      value === "render" ||
      value === "completed"
    ) {
      return value;
    }

    return null;
  }

  private normalizeHtmlPptAgentStage(input: unknown) {
    const value = this.normalizeOptionalString(input);
    if (
      value === "01-read-skill" ||
      value === "02-research" ||
      value === "03-content-plan" ||
      value === "04-visual-plan" ||
      value === "05-generate-index" ||
      value === "06-generate-style" ||
      value === "07-publish" ||
      value === "08-qa" ||
      value === "completed"
    ) {
      return value;
    }

    return null;
  }

  private normalizeStoredAgentDeckRender(input: unknown) {
    const deckRender = this.normalizeStoredDeckRender(input);
    if (!deckRender || !("outputDir" in deckRender) || typeof deckRender.outputDir !== "string" || deckRender.outputDir.trim().length === 0) {
      return undefined;
    }

    return {
      ...deckRender,
      outputDir: deckRender.outputDir
    };
  }

  private normalizeStoredAgentFailureRecord(input: unknown) {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const stage = this.normalizeHtmlPptAgentStage(candidate.stage);
    const stepName = this.normalizeOptionalString(candidate.stepName);
    const reason = this.normalizeOptionalString(candidate.reason);
    if (!stage || !stepName || !reason) {
      return null;
    }

    return {
      stage,
      stepName,
      reason,
      issues: this.coerceStringArray(candidate.issues).slice(0, 8),
      occurredAt: this.normalizeOptionalString(candidate.occurredAt) ?? new Date().toISOString()
    };
  }

  private normalizeStoredAgentBatchSnapshot(input: unknown) {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const sections = this.normalizeOptionalString(candidate.sections);
    if (!sections) {
      return null;
    }

    return {
      batchIndex: Number(candidate.batchIndex) || 0,
      slideIndexes: this.coerceNumberArray(candidate.slideIndexes),
      layoutIds: this.coerceStringArray(candidate.layoutIds),
      densityBudget: Number(candidate.densityBudget) || 0,
      sections,
      qaIssues: this.coerceStringArray(candidate.qaIssues),
      slideIssues: Array.isArray(candidate.slideIssues)
        ? candidate.slideIssues
            .map((item) => {
              const value = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
              if (!value) return null;
              return {
                slideIndex: Number(value.slideIndex) || 0,
                batchOffset: Number(value.batchOffset) || 0,
                issues: this.coerceStringArray(value.issues)
              };
            })
            .filter((item): item is { slideIndex: number; batchOffset: number; issues: string[] } => Boolean(item))
        : []
    };
  }

  private normalizeStoredPptContext(input: unknown): { summaryText: string; recentMessages: PptMessageDto[] } | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const recentRaw = Array.isArray(candidate.recentMessages) ? candidate.recentMessages : [];
    return {
      summaryText: this.normalizeOptionalString(candidate.summaryText) ?? "",
      recentMessages: recentRaw
        .map((item) => this.normalizeStoredPptMessage(item))
        .filter((item): item is PptMessageDto => Boolean(item))
    };
  }

  private normalizeStoredPptMessage(input: unknown): PptMessageDto | null {
    if (!input || typeof input !== "object") {
      return null;
    }

    const candidate = input as Record<string, unknown>;
    const id = this.normalizeOptionalString(candidate.id);
    const role = candidate.role;
    const content = this.normalizeOptionalString(candidate.content);
    const createdAt = this.normalizeOptionalString(candidate.createdAt);
    if (!id || (role !== "user" && role !== "assistant") || !content || !createdAt) {
      return null;
    }

    return {
      id,
      role,
      content,
      files: this.normalizeFiles(candidate.files),
      template: this.normalizeTemplate(candidate.template),
      deckSpec: this.normalizeStoredDeckSpec(candidate.deckSpec),
      deckRender: this.normalizeStoredDeckRender(candidate.deckRender),
      orchestration: this.normalizeStoredOrchestration(candidate.orchestration),
      createdAt
    };
  }

  private normalizeStoredLocalQa(input: unknown): LocalDeckQa | undefined {
    if (!input || typeof input !== "object") {
      return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const scoreRaw = Number(candidate.score);
    return {
      pass: Boolean(candidate.pass),
      score: Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0,
      issues: this.coerceStringArray(candidate.issues)
    };
  }

  private normalizeRequiredString(input: unknown, field: string) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new BadRequestException(`${field} is required.`);
    }

    return input.trim();
  }

  private normalizeOptionalString(input: unknown) {
    if (typeof input !== "string") {
      return null;
    }

    const value = input.trim();
    return value.length > 0 ? value : null;
  }

  private normalizeResumeMode(input: unknown): "resume" | "adopt" | "template" {
    const value = this.normalizeOptionalString(input);
    if (value === "adopt" || value === "template") {
      return value;
    }
    return "resume";
  }

  private normalizeFiles(input: unknown): PptMessageAttachment[] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "unknown",
        type: typeof item.type === "string" ? item.type : "",
        size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0
      }));
  }

  private normalizeTemplate(input: unknown, fallbackTemplateId?: string | null): PptMessageTemplate | null {
    if (input && typeof input === "object") {
      const candidate = input as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id : fallbackTemplateId ?? null;
      const label = typeof candidate.label === "string" ? candidate.label : null;
      const description = typeof candidate.description === "string" ? candidate.description : null;

      if (id && label && description) {
        return { id, label, description };
      }
    }

    if (fallbackTemplateId) {
      return {
        id: fallbackTemplateId,
        label: fallbackTemplateId,
        description: ""
      };
    }

    return null;
  }
}
