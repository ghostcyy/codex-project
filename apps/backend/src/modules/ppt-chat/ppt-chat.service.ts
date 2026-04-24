import { randomUUID } from "node:crypto";
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
import { HtmlPptRendererService } from "../html-ppt-renderer/html-ppt-renderer.service";
import { LlmConfigService } from "../llm-config/llm-config.service";
import { HtmlPptAgentService } from "./html-ppt-agent.service";
import { HTML_PPT_SKILL_PROMPT } from "./html-ppt-skill.prompt";
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
  PptDeckSlide,
  PptDeckSlideType,
  PptDeckSpec,
  PptDeckVisualSystem,
  PptMessageAttachment,
  PptMessageDto,
  PptMessageTemplate,
  PptProjectSummary,
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
};
type DeckGenerationJob = {
  userId: number;
  projectId: string;
  projectName: string;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  pendingUserMessage: PptMessageDto;
  assistantMessageId: string;
  resume?: {
    checkpoint?: DeckResumeCheckpoint;
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

  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(HtmlPptRendererService) private readonly htmlPptRendererService: HtmlPptRendererService,
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(HtmlPptAgentService) private readonly htmlPptAgentService: HtmlPptAgentService
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
    const shouldGenerateDeckSpec = this.shouldGenerateDeckSpec(content);

    if (shouldGenerateDeckSpec) {
      const orchestration = await this.createQueuedDeckOrchestration();
      await this.insertAssistantMessage(
        projectId,
        assistantMessageId,
        this.formatDeckProgressMessage("已进入后台编排队列，页面会自动刷新进度。", orchestration, "running"),
        {
          orchestration,
          generationStatus: "running",
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
        assistantMessageId
      });

      return {
        project: this.mapProject(await this.getOwnedProject(userId, projectId)),
        messages: await this.listMessages(userId, projectId)
      };
    }

    const assistantContent = await this.generateAssistantMessage(project.name, context, pendingUserMessage);
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
    options?: { name?: string; detail?: string }
  ): Promise<PptGenerationOrchestration> {
    const activeConfig = base ? null : await this.llmConfigService.getActiveConfig();
    const now = new Date().toISOString();
    const previousSteps = (base?.steps ?? []).filter((step) => step.status !== "running");
    return {
      version: base?.version ?? "orchestrator-v1",
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
    let generationCheckpoint = job.resume?.checkpoint ?? this.normalizeStoredGenerationCheckpoint(currentMeta.generationCheckpoint);

    const updateAssistantMessage = async (contentValue: string, metaValue: Record<string, unknown>) => {
      currentMeta = metaValue;
      await this.updateAssistantMessage(job.assistantMessageId, contentValue, metaValue);
    };

    let generatedDeckSpec: PptDeckSpec | null = null;
    let generatedDeckRender: { deckId: string; title: string; previewUrl: string; downloadUrl: string; createdAt: string } | null = null;
    let orchestration: PptGenerationOrchestration | null =
      job.resume?.orchestration ?? this.normalizeStoredOrchestration(currentMeta.orchestration) ?? null;
    let generationError: string | null = null;
    let assistantContent = "";

    try {
      const result = await this.orchestrateDeckGeneration(
        job.projectName,
        job.context,
        job.pendingUserMessage,
        async (progress) => {
          generationCheckpoint = progress.checkpoint ?? generationCheckpoint;
          await updateAssistantMessage(progress.content, {
            ...currentMeta,
            orchestration: progress.orchestration,
            generationStatus: progress.generationStatus,
            generationCheckpoint,
            sourceUserMessageId: job.pendingUserMessage.id
          });
          await this.databaseService.query("UPDATE ppt_projects SET updated_at = NOW() WHERE id = $1", [job.projectId]);
        },
        job.resume
      );
      generatedDeckSpec = result.deckSpec;
      generatedDeckRender = result.deckRender;
      orchestration = result.orchestration;
      generationCheckpoint = result.checkpoint ?? null;
      assistantContent = this.formatDeckSpecAssistantMessage(result.deckSpec, result.deckRender, result.orchestration);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Deck 编排执行失败。";
      if (error instanceof DeckOrchestrationError) {
        orchestration = error.orchestration;
        generationCheckpoint = error.checkpoint ?? generationCheckpoint;
      } else {
        orchestration = this.normalizeStoredOrchestration(currentMeta.orchestration) ?? orchestration;
      }
      generationError = errorMessage;
      assistantContent = this.formatDeckSpecFailureMessage(errorMessage, orchestration);
    }

    const assistantMeta: Record<string, unknown> = {
      ...currentMeta,
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
    if (generationError) {
      assistantMeta.generationError = generationError;
    } else {
      delete assistantMeta.generationError;
    }
    assistantMeta.generationStatus = generationError ? "failed" : "completed";

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

  async resumeMessageGeneration(userId: number, projectId: string, messageId: string) {
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
    const currentStatus = this.normalizeOptionalString(originalMeta.generationStatus);
    const existingOrchestration = this.normalizeStoredOrchestration(originalMeta.orchestration);
    const staleRunning = currentStatus === "running" && this.isStaleRunningOrchestration(existingOrchestration);
    if (currentStatus === "running" && !staleRunning) {
      throw new BadRequestException("当前任务仍在运行中，不能重复继续。");
    }

    if (this.normalizeStoredDeckRender(originalMeta.deckRender)) {
      throw new BadRequestException("该任务已经完成，无需继续生成。");
    }

    if (staleRunning && existingOrchestration) {
      const staleOrchestration = this.markStaleRunningOrchestration(existingOrchestration);
      originalMeta.orchestration = staleOrchestration;
      originalMeta.generationStatus = "failed";
      originalMeta.generationError = this.staleRunningMessage();
    }

    let generationCheckpoint = this.normalizeStoredGenerationCheckpoint(originalMeta.generationCheckpoint);
    const sourceUserMessage = await this.resolveSourceUserMessage(
      projectId,
      assistantRow,
      generationCheckpoint?.sourceUserMessageId ?? this.normalizeOptionalString(originalMeta.sourceUserMessageId)
    );
    const pendingUserMessage = generationCheckpoint?.pendingUserMessage ?? this.mapMessage(sourceUserMessage);
    const context = generationCheckpoint?.context ?? (await this.buildConversationContextBeforeMessage(userId, projectId, sourceUserMessage));
    const orchestration = await this.createQueuedDeckOrchestration(existingOrchestration, {
      name: "00 后台任务恢复排队",
      detail: "已恢复未完成编排任务，等待后台继续执行。"
    });
    const assistantMeta: Record<string, unknown> = {
      ...originalMeta,
      orchestration,
      generationStatus: "running",
      sourceUserMessageId: pendingUserMessage.id
    };
    if (generationCheckpoint) {
      assistantMeta.generationCheckpoint = generationCheckpoint;
    }
    delete assistantMeta.generationError;

    await this.updateAssistantMessage(
      messageId,
      this.formatDeckProgressMessage("已重新进入后台编排队列，页面会自动刷新进度。", orchestration, "running"),
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
      resume: {
        checkpoint: generationCheckpoint ?? undefined,
        orchestration
      }
    });

    return {
      project: this.mapProject(await this.getOwnedProject(userId, projectId)),
      messages: await this.listMessages(userId, projectId)
    };
  }

  private async orchestrateDeckGeneration(
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto,
    onProgress?: (progress: DeckProgressUpdate) => Promise<void>,
    resume?: {
      checkpoint?: DeckResumeCheckpoint;
      orchestration?: PptGenerationOrchestration;
    }
  ) {
    if (process.env.PPT_USE_LEGACY_RENDERER !== "1" && !resume?.checkpoint) {
      const templateId = pendingUserMessage.template?.id ?? "pitch-deck";
      const result = await this.htmlPptAgentService.generateDeck(
        {
          projectName,
          context,
          pendingUserMessage,
          templateId,
          theme: this.defaultThemeForTemplate(templateId)
        },
        onProgress
      );
      return {
        ...result,
        checkpoint: undefined
      };
    }

    const activeConfig = await this.llmConfigService.getActiveConfig();
    const startedAt = resume?.orchestration?.startedAt ?? new Date().toISOString();
    const steps: PptGenerationStep[] = (resume?.orchestration?.steps ?? [])
      .filter((step) => step.status !== "running")
      .map((step, index) => ({ ...step, id: step.id || `step-${index + 1}` }));
    let totalModelCalls = resume?.orchestration?.totalModelCalls ?? 0;
    let currentRunningStep: PptGenerationStep | null = null;
    let templateId = resume?.checkpoint?.templateId ?? pendingUserMessage.template?.id ?? "pitch-deck";
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

          const aiReview = await this.reviewDeckWithModel(activeConfig, deckSpec, localQa, () => {
            totalModelCalls += 1;
          });
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

            const nextReview = await this.reviewDeckWithModel(activeConfig, deckSpec, localQa, () => {
              totalModelCalls += 1;
            });
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
    projectName: string,
    context: { summaryText: string; recentMessages: PptMessageDto[] },
    pendingUserMessage: PptMessageDto
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

    const response = await this.requestChatCompletion(activeConfig, messages, "模型调用失败。");

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
    onModelCall?: () => void
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
    onModelCall?: () => void
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
    onModelCall?: () => void
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
    onModelCall?: () => void
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
    }
  ) {
    const requestModel = async (messages: ChatCompletionRequestMessage[]) => {
      options?.onModelCall?.();
      const response = await this.requestChatCompletion(activeConfig, messages, fallbackErrorMessage);

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
    fallbackErrorMessage: string
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

    try {
      const response = await fetch(`${activeConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeConfig.apiKey}`
        },
        body: JSON.stringify({
          model: activeConfig.model,
          messages
        }),
        cache: "no-store",
        signal: controller.signal
      });
      const elapsedMs = Date.now() - startedAt;

      if (response.ok) {
        this.logger.log(`LLM request ${requestId} completed: status=${response.status}, elapsedMs=${elapsedMs}`);
      } else {
        const errorBody = await response.clone().text().catch(() => "");
        this.logger.warn(
          `LLM request ${requestId} provider error: status=${response.status}, elapsedMs=${elapsedMs}, body=${this.summarizeLogSnippet(errorBody)}`
        );
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.warn(`LLM request ${requestId} local timeout: elapsedMs=${Date.now() - startedAt}, timeoutMs=${timeoutMs}`);
        throw new ServiceUnavailableException(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`);
      }

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
    options?: { safetyRetryOnly?: boolean; plan?: DeckPlan | null; onModelCall?: (stage: string) => void }
  ): Promise<PptDeckSpec> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const templateId = pendingUserMessage.template?.id ?? "pitch-deck";
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
        onModelCall
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
        "DeckSpec 生成失败。"
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
    onModelCall?: (stage: string) => void
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
          repairHint: "必须输出 {\"slides\":[...]}，slides 数量必须与本批 slidePlan 数量一致。"
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

  private formatDeckSpecAssistantMessage(
    deckSpec: PptDeckSpec,
    deckRender: { previewUrl: string; downloadUrl: string } | null,
    orchestration?: PptGenerationOrchestration | null
  ) {
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
      summaryRow?.summary_text ?? "",
      batchResult.rows.map((row) => this.mapMessage(row))
    );

    await this.upsertSummary(projectId, updatedSummary, targetSummarizedCount);
  }

  private async generateConversationSummary(previousSummary: string, messages: PptMessageDto[]) {
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
      "摘要生成失败。"
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
        detail: `${step.detail} ${this.staleRunningMessage()}`
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

  private runningHeartbeatStaleMs() {
    const parsed = Number(process.env.PPT_RUNNING_HEARTBEAT_STALE_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
  }

  private normalizeStoredDeckSpec(input: unknown) {
    if (!input) {
      return undefined;
    }

    try {
      return this.normalizeDeckSpec(input, { templateId: "pitch-deck", theme: "pitch-deck-vc" });
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

    if (!deckId || !title || !previewUrl || !downloadUrl || !createdAt) {
      return undefined;
    }

    return { deckId, title, previewUrl, downloadUrl, createdAt };
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

        return {
          id: this.normalizeOptionalString(value.id) ?? `step-${index + 1}`,
          name: this.normalizeOptionalString(value.name) ?? `步骤 ${index + 1}`,
          status,
          startedAt: this.normalizeOptionalString(value.startedAt) ?? new Date().toISOString(),
          endedAt: this.normalizeOptionalString(value.endedAt) ?? new Date().toISOString(),
          detail: this.normalizeOptionalString(value.detail) ?? ""
        };
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
