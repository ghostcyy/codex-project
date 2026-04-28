import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { ZodType } from "zod";
import { HtmlPptRendererService } from "../html-ppt-renderer/html-ppt-renderer.service";
import type { HtmlPptRenderResult } from "../html-ppt-renderer/html-ppt-renderer.types";
import { LlmConfigService } from "../llm-config/llm-config.service";
import type { ActiveLlmConfig, LlmStageModelRole } from "../llm-config/llm-config.types";
import { LlmLoggingService } from "../llm-logging/llm-logging.service";
import { PLAN_FORMATS, PLAN_TONES, planSchema, researchSchema, sectionContentSchema, structuredOutputSchemaHints, visualSchema } from "./html-ppt-agent.schemas";
import type {
  AgentPlan,
  DeckRequestRequirements,
  HtmlPptAgentCheckpoint,
  HtmlPptAgentBatchSnapshot,
  HtmlPptAgentFailedIndexState,
  HtmlPptAgentFailedSlideIssue,
  HtmlPptAgentFailureRecord,
  HtmlPptAgentIndexResult,
  HtmlPptAgentInput,
  HtmlPptAgentProgress,
  HtmlPptAgentStage,
  ReferenceComponentContract,
  ReferenceFullDeckSnippet,
  ResearchPack,
  SectionContentPlan,
  SkillPack,
  VisualPlan
} from "./html-ppt-agent.types";
import type { PptDeckLayout, PptDeckSpec, PptGenerationOrchestration, PptGenerationStep, PptMessageDto } from "./ppt-chat.types";
import { buildPrompt } from "./prompt-builder";
import { buildSlideCascade } from "./qa/css-cascade";
import { buildLedger, detectOutliers } from "./qa/consistency-ledger";
import { appendCssPatch, buildCssPatchInstructions, validateCssPatchOutput } from "./qa/css-patch-repair";
import type { CssPatchInstruction } from "./qa/css-patch-repair";
import { estimateGeometryIssues } from "./qa/geometry-estimator";
import type { ConsistencyFinding } from "./qa/qa-types";
import { indexSkillAssets } from "./skill-asset-indexer";
import type { DonorTemplateContract, LayoutSanityContract, SkillAssetManifest } from "./skill-asset-indexer";

type ActiveModelConfig = ActiveLlmConfig;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatResponse = { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
type QaSignalStatus = "passed" | "healed" | "failed" | "warn";
type QaSignalReport = { status: QaSignalStatus; issues: string[]; details?: Record<string, unknown> };
type QaSlideFitIssue = { slideIndex: number; planOffset: number; layoutId: string; issues: string[] };
type DeckStyleProfile = "academic" | "product" | "balanced";
type BatchQaResult = { issues: string[]; hardIssues: string[]; softIssues: string[] };
type HtmlPptGenerationTraceStage = {
  id: string;
  stage: HtmlPptAgentStage;
  name: string;
  status: PptGenerationStep["status"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detail: string;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  qaIssueCount?: number;
};
type QaQualityScore = {
  score: number;
  grade: "A" | "B" | "C" | "D";
  blockingIssues: number;
  warnings: number;
  healedSignals: number;
  failedSignals: number;
  warnSignals: number;
  slideFitIssues: number;
  classCoverageRate?: number;
};
type ClassCoverageReport = {
  htmlMatchedByDeckCss: number;
  htmlMatchedByAnyCss: number;
  htmlTotal: number;
  cssMatchedToHtml: number;
  cssTotal: number;
  unmatchedHtmlClasses: string[];
  orphanHtmlClasses: string[];
  unusedCssClasses: string[];
};
type LayoutRulePresenceIssue = {
  slideIndex: number;
  className: string;
  selector: string;
  message: string;
};
type ModelLogContext = {
  userId?: number;
  projectId?: string;
  messageId?: string;
  stage?: string;
  source?: string;
};
type QaReport = {
  generatedAt: string;
  repairedSlides: number[];
  truncatedSlides: number[];
  warnings: string[];
  quality?: QaQualityScore;
  signals: {
    structure: QaSignalReport;
    assets: QaSignalReport;
      runtime: QaSignalReport;
      fit: QaSignalReport;
      classCoverage: QaSignalReport;
      consistency: QaSignalReport;
      geometry: QaSignalReport;
      themeContrast: QaSignalReport;
      portability: QaSignalReport;
    };
  issues: string[];
};

class HtmlPptAgentError extends Error {
  constructor(
    message: string,
    readonly orchestration: PptGenerationOrchestration,
    readonly checkpoint: HtmlPptAgentCheckpoint
  ) {
    super(message);
    this.name = "HtmlPptAgentError";
  }
}

class HtmlPptAgentBatchError extends Error {
  constructor(message: string, readonly snapshot: HtmlPptAgentBatchSnapshot) {
    super(message);
    this.name = "HtmlPptAgentBatchError";
  }
}

@Injectable()
export class HtmlPptAgentService {
  private readonly logger = new Logger(HtmlPptAgentService.name);
  private static readonly BLOCKED_FX = new Set(["knowledge-graph", "gradient-blob"]);

  constructor(
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(HtmlPptRendererService) private readonly rendererService: HtmlPptRendererService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService
  ) {}

  private modelConfigForRole(activeConfig: ActiveModelConfig, role: LlmStageModelRole): ActiveModelConfig {
    const override = activeConfig.stageModelOverrides?.[role]?.trim();
    return override ? { ...activeConfig, model: override } : activeConfig;
  }

  private modelRoutingSummary(activeConfig: ActiveModelConfig) {
    const roles: LlmStageModelRole[] = ["research", "plan", "visual", "section", "css", "qa"];
    return {
      default: activeConfig.model,
      roles: Object.fromEntries(roles.map((role) => [role, this.modelConfigForRole(activeConfig, role).model]))
    };
  }

  private formatModelRouting(activeConfig: ActiveModelConfig) {
    const routing = this.modelRoutingSummary(activeConfig);
    const overrides = Object.entries(routing.roles)
      .filter(([, model]) => model !== routing.default)
      .map(([role, model]) => `${role}:${model}`);
    return overrides.length ? `${routing.default} (${overrides.join(", ")})` : routing.default;
  }

  async generateDeck(
    input: HtmlPptAgentInput,
    onProgress?: (progress: HtmlPptAgentProgress) => Promise<void>,
    resume?: {
      checkpoint?: HtmlPptAgentCheckpoint;
      orchestration?: PptGenerationOrchestration;
    }
  ): Promise<{ deckSpec: PptDeckSpec; deckRender: HtmlPptRenderResult; orchestration: PptGenerationOrchestration }> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const modelConfig = (role: LlmStageModelRole) => this.modelConfigForRole(activeConfig, role);
    const modelRouting = this.modelRoutingSummary(activeConfig);
    const agentInput = {
      ...input,
      templateId: resume?.checkpoint?.templateId ?? input.templateId,
      theme: resume?.checkpoint?.theme ?? input.theme
    };
    const startedAt = resume?.orchestration?.startedAt ?? new Date().toISOString();
    const steps: PptGenerationStep[] = (resume?.orchestration?.steps ?? [])
      .filter((step) => step.status !== "running")
      .map((step, index) => ({ ...step, id: step.id || `step-${index + 1}` }));
    let running: PptGenerationStep | null = null;
    let modelCalls = resume?.orchestration?.totalModelCalls ?? 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    const traceStages: HtmlPptGenerationTraceStage[] = [];
    let skill: SkillPack | undefined;
    let research = resume?.checkpoint?.research;
    let plan = resume?.checkpoint?.plan;
    let visual = resume?.checkpoint?.visual;
    let indexResult = resume?.checkpoint?.indexResult;
    let failedIndexState = resume?.checkpoint?.failedIndexState;
    let styleCss = resume?.checkpoint?.styleCss;
    let deckRender = resume?.checkpoint?.deckRender;
    let failureHistory = resume?.checkpoint?.failureHistory ?? [];
    let nextStage = this.normalizeAgentResumeStage(resume?.checkpoint?.nextStage ?? "01-read-skill", {
      research,
      plan,
      visual,
      indexResult,
      styleCss,
      deckRender
    });
    const userContextText = this.userContext(agentInput);
    const requestRequirements = this.extractDeckRequestRequirements(agentInput.pendingUserMessage.content);
    const modelLogBase = {
      userId: agentInput.userId,
      projectId: agentInput.projectId,
      messageId: agentInput.assistantMessageId,
      source: "html-ppt-agent"
    } as const;

    const makeOrchestration = (): PptGenerationOrchestration => ({
      version: "html-ppt-agent-v1",
      model: this.formatModelRouting(activeConfig),
      startedAt,
      finishedAt: new Date().toISOString(),
      totalModelCalls: modelCalls,
      steps: running ? [...steps, running] : steps
    });
    const buildCheckpoint = (): HtmlPptAgentCheckpoint =>
      this.compactAgentCheckpoint({
        version: "html-ppt-agent-checkpoint-v1",
        sourceUserMessageId: agentInput.pendingUserMessage.id,
        projectName: agentInput.projectName,
        templateId: agentInput.templateId,
        theme: visual?.primaryTheme ?? agentInput.theme,
        nextStage,
        pendingUserMessage: agentInput.pendingUserMessage,
        context: agentInput.context,
        research,
        plan,
        visual,
        indexResult,
        failedIndexState,
        styleCss,
        deckRender,
        failureHistory,
        updatedAt: new Date().toISOString()
      });
    const publish = async (detail: string, status: "running" | "completed" | "failed") => {
      if (!onProgress) return;
      const orchestration = makeOrchestration();
      await onProgress({
        content: this.formatProgress(detail, orchestration, status),
        orchestration,
        generationStatus: status,
        checkpoint: buildCheckpoint()
      });
    };
    const ensureSkill = async () => {
      if (!skill) {
        skill = await this.readSkillPack(agentInput.templateId);
      }
      return skill;
    };
    const stageFailureHints = (stage: HtmlPptAgentStage) =>
      failureHistory
        .filter((item) => item.stage === stage)
        .slice(-4)
        .map((item) => [item.reason, ...item.issues].filter(Boolean).join(" | "));
    const runStep = async <T>(
      stage: HtmlPptAgentStage,
      name: string,
      nextOnSuccess: HtmlPptAgentStage,
      action: () => Promise<{ value: T; detail: string }>,
      onSuccess?: (value: T) => void
    ) => {
      nextStage = stage;
      const started = new Date().toISOString();
      const runningDetail = this.stageRunningDetail(stage);
      running = { id: `step-${steps.length + 1}`, name, status: "running", startedAt: started, endedAt: started, detail: runningDetail };
      await publish(`${name} 进行中。${runningDetail}`, "running");
      const startedMs = Date.now();
      const modelCallsBefore = modelCalls;
      const promptTokensBefore = promptTokens;
      const completionTokensBefore = completionTokens;
      const totalTokensBefore = totalTokens;
      let heartbeatBusy = false;
      const publishHeartbeat = async () => {
        if (!running || heartbeatBusy) return;
        heartbeatBusy = true;
        try {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - new Date(started).getTime()) / 1000));
          const heartbeatDetail = this.stageHeartbeatDetail(stage, elapsedSeconds);
          running = { ...running, endedAt: new Date().toISOString(), detail: heartbeatDetail };
          await publish(`${name} 进行中。${heartbeatDetail}`, "running");
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
        const completedStep = running;
        if (!completedStep) {
          throw new ServiceUnavailableException("编排步骤状态丢失。");
        }
        onSuccess?.(result.value);
        failureHistory = failureHistory.filter((item) => item.stage !== stage);
        if (stage === "05-generate-index") {
          failedIndexState = undefined;
        }
        nextStage = nextOnSuccess;
        const endedAt = new Date().toISOString();
        steps.push({ ...completedStep, status: "completed", endedAt, detail: result.detail });
        traceStages.push({
          id: completedStep.id,
          stage,
          name,
          status: "completed",
          startedAt: started,
          endedAt,
          durationMs: Math.max(0, Date.now() - startedMs),
          detail: result.detail,
          modelCalls: modelCalls - modelCallsBefore,
          promptTokens: promptTokens - promptTokensBefore,
          completionTokens: completionTokens - completionTokensBefore,
          totalTokens: totalTokens - totalTokensBefore,
          qaIssueCount: this.estimateStepIssueCount(result.value)
        });
        running = null;
        await publish(result.detail, "running");
        return result.value;
      } catch (error) {
        clearInterval(heartbeat);
        const failedStep = running ?? {
          id: `step-${steps.length + 1}`,
          name,
          status: "running" as const,
          startedAt: started,
          endedAt: started,
          detail: runningDetail
        };
        failureHistory = this.recordAgentFailure(failureHistory, {
          stage,
          stepName: name,
          reason: error instanceof Error ? error.message : "步骤失败。",
          issues: this.extractFailureIssues(error),
          occurredAt: new Date().toISOString()
        });
        const endedAt = new Date().toISOString();
        const detail = error instanceof Error ? error.message : "步骤失败。";
        steps.push({ ...failedStep, status: "failed", endedAt, detail });
        traceStages.push({
          id: failedStep.id,
          stage,
          name,
          status: "failed",
          startedAt: started,
          endedAt,
          durationMs: Math.max(0, Date.now() - startedMs),
          detail,
          modelCalls: modelCalls - modelCallsBefore,
          promptTokens: promptTokens - promptTokensBefore,
          completionTokens: completionTokens - completionTokensBefore,
          totalTokens: totalTokens - totalTokensBefore,
          qaIssueCount: this.extractFailureIssues(error).length
        });
        running = null;
        await publish(error instanceof Error ? error.message : "步骤失败。", "failed");
        throw new HtmlPptAgentError(error instanceof Error ? error.message : "步骤失败。", makeOrchestration(), buildCheckpoint());
      }
    };
    const countCall = (usage?: any) => {
      modelCalls += 1;
      if (usage) {
        promptTokens += usage.prompt_tokens || 0;
        completionTokens += usage.completion_tokens || 0;
        totalTokens += usage.total_tokens || 0;
      }
    };

    await publish(
      resume?.checkpoint
        ? `已恢复上次未完成任务，准备从 ${this.describeAgentStage(nextStage)} 继续。`
        : "已启动 html-ppt-skill 直写编排，旧 DeckSpec renderer 不再作为主路径。",
      "running"
    );

    if (!skill && nextStage !== "01-read-skill") {
      await ensureSkill();
    }

    if (nextStage === "01-read-skill") {
      await runStep("01-read-skill", "01 读取 skill 与模板目录", "02-research", async () => {
        const value = await this.readSkillPack(agentInput.templateId);
        const m: SkillAssetManifest | undefined = value.manifest;
        const detail = m
          ? `读取完成：${m.layouts.length} 个布局、${m.fullDecks.length} 个模板、${m.themes.length} 个主题、${m.animations.length} 个动效（manifest hash ${m.hash}）。`
          : `读取完成：${value.layoutNames.length} 个布局、${value.templateNames.length} 个模板、${value.themeNames.length} 个主题。`;
        return { value, detail };
      }, (value) => {
        skill = value;
      });
    }

    if (nextStage === "02-research") {
      await runStep("02-research", "02 主题资料整理", "03-content-plan", async () => {
        const skillPack = await ensureSkill();
        try {
          const prompt = buildPrompt("research", { input: agentInput, userContextText, skill: skillPack, requestRequirements });
          const value = await this.modelStructured(
            modelConfig("research"),
            researchSchema,
            this.researchSchemaHint(requestRequirements),
            prompt.system,
            prompt.user,
            countCall,
            { ...modelLogBase, stage: "02-research" }
          );
          return { value, detail: `资料包已整理：建议 ${value.suggestedSlideCount} 页，并给出逐页字数规划。第一阶段使用模型通用知识，不执行真实外部搜索。` };
        } catch (error) {
          const value = this.fallbackResearch(agentInput.pendingUserMessage.content, requestRequirements);
          const reason = error instanceof Error ? error.message : "模型资料整理失败。";
          return { value, detail: `资料整理模型调用失败，已使用本地 fallback 资料包继续编排。原因：${reason}` };
        }
      }, (value) => {
        research = value;
      });
    }

    if (nextStage === "03-content-plan") {
      await runStep("03-content-plan", "03 内容规划", "04-visual-plan", async () => {
        const skillPack = await ensureSkill();
        if (!research) {
          throw new ServiceUnavailableException("缺少资料包，无法继续执行内容规划。");
        }
        const prompt = buildPrompt("content-plan", { input: agentInput, userContextText, skill: skillPack, research, assetManifest: skillPack.manifest, requestRequirements });
        const planned = await this.modelStructured(
          modelConfig("plan"),
          planSchema,
          this.planSchemaHint(requestRequirements, research),
          prompt.system,
          prompt.user,
          countCall,
          { ...modelLogBase, stage: "03-content-plan" }
        );
        const value = this.normalizePlan(planned, agentInput.pendingUserMessage.content, skillPack, requestRequirements);
        return { value, detail: `内容规划完成：${value.slideCount} 页，已绑定布局：${value.slides.map((slide) => `${slide.index}.${slide.layoutId}`).join(" / ")}。` };
      }, (value) => {
        plan = value;
      });
    }

    if (nextStage === "04-visual-plan") {
      await runStep("04-visual-plan", "04 视觉方案", "05-generate-index", async () => {
        const skillPack = await ensureSkill();
        if (!plan) {
          throw new ServiceUnavailableException("缺少内容规划，无法继续执行视觉方案。");
        }
        const lockedTemplateId = this.selectedTemplateId(agentInput, skillPack);
        const prompt = buildPrompt("visual-plan", { input: agentInput, userContextText, skill: skillPack, plan, assetManifest: skillPack.manifest });
        let normalized: VisualPlan;
        let fallbackReason = "";
        try {
          const visuals = await this.modelStructured(
            modelConfig("visual"),
            visualSchema,
            structuredOutputSchemaHints.visual,
            prompt.system,
            prompt.user,
            countCall,
            { ...modelLogBase, stage: "04-visual-plan" }
          );
          normalized = this.normalizeVisual(visuals, skillPack, {
            templateId: agentInput.templateId,
            theme: agentInput.theme,
            lockedTemplateId
          }, plan);
        } catch (error) {
          fallbackReason = this.describeError(error);
          normalized = this.fallbackVisualPlan(plan, skillPack, {
            templateId: agentInput.templateId,
            theme: agentInput.theme,
            lockedTemplateId
          });
        }
        const value = this.enrichVisualPlan(normalized, plan, skillPack);
        const animationKinds = new Set(value.slideVisuals.map((item) => item.animation).filter(Boolean)).size;
        const fxCount = value.slideVisuals.filter((item) => Boolean(item.fx)).length;
        const refs = value.referenceTemplates.join(", ") || "none";
        return {
          value,
          detail: `视觉方案完成：${value.primaryTheme} / ${value.visualLanguage}（deckClass=${value.deckClass}; refs=${refs}; 动画 ${animationKinds} 种，FX ${fxCount} 页）${fallbackReason ? `；视觉方案模型输出失效，已使用本地 fallback。原因：${fallbackReason}` : ""}`
        };
      }, (value) => {
        visual = value;
      });
    }

    if (nextStage === "05-generate-index") {
      await runStep("05-generate-index", "05 生成 index.html", "06-generate-style", async () => {
        const skillPack = await ensureSkill();
        if (!plan || !visual || !research) {
          throw new ServiceUnavailableException("缺少资料包、内容规划或视觉方案，无法继续生成 index.html。");
        }
        const value = await this.generateIndexHtml(
          modelConfig("section"),
          agentInput,
          plan,
          visual,
          research,
          skillPack,
          countCall,
          stageFailureHints("05-generate-index"),
          modelLogBase,
          failedIndexState,
          (state) => {
            failedIndexState = state;
          }
        );
        if (!/<!doctype html/i.test(value.html) || !/<section\s+class=["']slide\b/i.test(value.html)) {
          throw new ServiceUnavailableException("index.html 缺少 DOCTYPE 或 slide。");
        }
        return {
          value,
          detail: [
            `index.html 生成完成：${value.html.length} 字符；${value.batchCount} 个批次，并发 ${value.concurrency}，模型修复 ${value.repairCalls} 次，本地修复 ${value.localRepairCount} 次。`,
            value.narrativeTargetChineseChars
              ? `正文规划 ${value.narrativeActualChineseChars ?? 0}/${value.narrativeTargetChineseChars} 中文字` +
                (value.narrativeExpandedChars && value.narrativeExpandedChars > 0
                  ? `，补量 +${value.narrativeExpandedChars}（第 ${value.narrativeExpandedSlides?.join(",") ?? ""} 页）`
                  : "")
              : ""
          ].filter(Boolean).join("；")
        };
      }, (value) => {
        indexResult = value;
      });
    }

    if (nextStage === "06-generate-style") {
      await runStep("06-generate-style", "06 生成 style.css", "07-publish", async () => {
        const skillPack = await ensureSkill();
        if (!plan || !visual || !indexResult) {
          throw new ServiceUnavailableException("缺少内容规划、视觉方案或 index.html，无法继续生成 style.css。");
        }
        return this.generateStyleCss(
          modelConfig("css"),
          plan,
          visual,
          indexResult.html,
          skillPack,
          countCall,
          stageFailureHints("06-generate-style"),
          modelLogBase
        );
      }, (value) => {
        styleCss = value;
      });
    }

    if (nextStage === "07-publish") {
      await runStep("07-publish", "07 复制 assets 与便携化打包", "08-qa", async () => {
        const skillPack = await ensureSkill();
        if (!plan || !visual || !indexResult || !styleCss) {
          throw new ServiceUnavailableException("缺少规划、视觉方案、index.html 或 style.css，无法继续导出。");
        }
        const renderResult = await this.rendererService.publishStaticDeck({
          title: plan.title,
          indexHtml: indexResult.html,
          styleCss,
          skillRoot: skillPack.root,
          manifest: { generator: "html-ppt-agent-v1", plan, visual, sectionBatchStats: indexResult.stats }
        });
        return { value: renderResult, detail: `导出完成：预览 ${renderResult.previewUrl}，下载 ${renderResult.downloadUrl}。` };
      }, (value) => {
        deckRender = value;
      });
    }

    let qa:
      | Awaited<ReturnType<HtmlPptAgentService["qaPublishedDeck"]>>
      | undefined;
    if (nextStage !== "completed") {
      qa = await runStep("08-qa", "08 本地 HTML 质检", "completed", async () => {
        const skillPack = await ensureSkill();
        if (!plan || !visual || !research || !deckRender) {
          throw new ServiceUnavailableException("缺少质检所需的规划、视觉方案、资料包或导出结果。");
        }
        const value = await this.qaPublishedDeck({
          outputDir: deckRender.outputDir,
          expectedSlides: plan.slides.length || plan.slideCount,
          plan,
          visual,
          skill: skillPack,
          activeConfig: modelConfig("qa"),
          agentInput,
          research,
          onCall: countCall
        });
        if (value.issues.length > 0) {
          throw new ServiceUnavailableException(`本地 HTML 质检未通过：${value.issues.join("；")}`);
        }

        return {
          value,
          detail: `质检通过：${value.slides} 页，index/preview/standalone 均仅 1 个初始 active，中文 ${value.chineseChars} 字，主题内联 ${value.inlineThemes ? "完成" : "未检测到"}；结构自愈 ${value.qaReport.signals.structure.status === "healed" ? "已执行" : "未触发"}，横版适配 ${value.qaReport.signals.fit.status === "healed" ? "已修复" : "通过"}；类名覆盖 HTML ${this.classCoverageSummary(value.qaReport).htmlSummary}，CSS ${this.classCoverageSummary(value.qaReport).cssSummary}。`
        };
      });
    } else if (deckRender) {
      const indexHtml = await readFile(join(deckRender.outputDir, "index.html"), "utf8").catch(() => "");
      const stats = this.htmlDeckStats(indexHtml);
      qa = {
        slides: stats.slides,
        activeSlides: stats.activeSlides,
        chineseChars: stats.chineseChars,
        inlineThemes: stats.inlineThemes,
        issues: [],
        qaReport: {
          generatedAt: new Date().toISOString(),
          repairedSlides: [],
          truncatedSlides: [],
          warnings: [],
          quality: this.scoreQaReport({
            generatedAt: new Date().toISOString(),
            repairedSlides: [],
            truncatedSlides: [],
            warnings: [],
            signals: {
              structure: { status: "passed", issues: [] },
              assets: { status: "passed", issues: [] },
              runtime: { status: "passed", issues: [] },
              fit: { status: "passed", issues: [] },
              classCoverage: { status: "passed", issues: [], details: { htmlMatchedByDeckCss: 0, htmlMatchedByAnyCss: 0, htmlTotal: 0, cssMatchedToHtml: 0, cssTotal: 0, unmatchedHtmlClasses: [], unusedCssClasses: [] } },
              consistency: { status: "passed", issues: [] },
              geometry: { status: "passed", issues: [] },
              themeContrast: { status: "passed", issues: [] },
              portability: { status: "passed", issues: [] }
            },
            issues: []
          }),
          signals: {
            structure: { status: "passed", issues: [] },
            assets: { status: "passed", issues: [] },
            runtime: { status: "passed", issues: [] },
            fit: { status: "passed", issues: [] },
            classCoverage: { status: "passed", issues: [], details: { htmlMatchedByDeckCss: 0, htmlMatchedByAnyCss: 0, htmlTotal: 0, cssMatchedToHtml: 0, cssTotal: 0, unmatchedHtmlClasses: [], unusedCssClasses: [] } },
            consistency: { status: "passed", issues: [] },
            geometry: { status: "passed", issues: [] },
            themeContrast: { status: "passed", issues: [] },
            portability: { status: "passed", issues: [] }
          },
          issues: []
        }
      };
    }

    if (!plan || !visual || !deckRender || !qa) {
      throw new ServiceUnavailableException("HTML-PPT Agent 编排状态不完整，缺少总结阶段所需结果。");
    }
    const deckSpec = this.summarySpec(plan, visual, qa.slides, qa.chineseChars);
    await publish("HTML-PPT Agent 编排完成。", "completed");
    await this.writeGenerationTrace(deckRender.outputDir, {
      traceVersion: "html-ppt-generation-trace-v1",
      generatedAt: new Date().toISOString(),
      projectId: agentInput.projectId,
      messageId: agentInput.assistantMessageId,
      sourceUserMessageId: agentInput.pendingUserMessage.id,
      projectName: agentInput.projectName,
      model: this.formatModelRouting(activeConfig),
      modelRouting,
      templateId: agentInput.templateId,
      theme: visual.primaryTheme,
      requested: this.extractDeckRequestRequirements(agentInput.pendingUserMessage.content),
      totals: {
        modelCalls,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs: Math.max(0, Date.now() - new Date(startedAt).getTime())
      },
      stages: traceStages,
      orchestration: makeOrchestration(),
      deck: {
        slides: qa.slides,
        chineseChars: qa.chineseChars,
        inlineThemes: qa.inlineThemes,
        previewUrl: deckRender.previewUrl,
        downloadUrl: deckRender.downloadUrl
      },
      qa: {
        issues: qa.issues,
        warnings: qa.qaReport.warnings,
        quality: qa.qaReport.quality,
        signalSummary: this.summarizeQaSignals(qa.qaReport)
      }
    });
    
    if (agentInput.userId && totalTokens > 0) {
      this.llmLoggingService.logCall(
        activeConfig.id,
        agentInput.userId,
        promptTokens,
        completionTokens,
        totalTokens
      ).catch(err => this.logger.warn(`Failed to log HTML-PPT Agent usage: ${err.message}`));
    }
    
    return { deckSpec, deckRender, orchestration: makeOrchestration() };
  }

  private stageRunningDetail(stage: HtmlPptAgentStage) {
    const modelTimeoutSeconds = Math.round(this.modelRequestTimeoutMs() / 1000);
    switch (stage) {
      case "01-read-skill":
        return "正在读取本地 skill、模板目录和素材清单。";
      case "02-research":
      case "03-content-plan":
      case "04-visual-plan":
      case "05-generate-index":
      case "06-generate-style":
        return `正在执行，等待 MiniMax 返回结果；单次模型请求上限 ${modelTimeoutSeconds} 秒。`;
      case "07-publish":
        return "正在执行本地便携化打包、复制 assets 与输出静态文件。";
      case "08-qa":
        return `正在执行本地 HTML 质检与启发式自愈；只有命中少量异常页或样式离群时，才会调用 MiniMax 定点修复；单次模型请求上限 ${modelTimeoutSeconds} 秒。`;
      case "completed":
        return "编排已完成。";
      default:
        return "正在执行当前阶段。";
    }
  }

  private stageHeartbeatDetail(stage: HtmlPptAgentStage, elapsedSeconds: number) {
    const modelTimeoutSeconds = Math.round(this.modelRequestTimeoutMs() / 1000);
    switch (stage) {
      case "01-read-skill":
        return `正在读取本地 skill、模板目录和素材清单。已持续 ${elapsedSeconds} 秒；后台任务未停止。`;
      case "02-research":
      case "03-content-plan":
      case "04-visual-plan":
      case "05-generate-index":
      case "06-generate-style":
        return `正在执行，等待 MiniMax 返回结果；单次模型请求上限 ${modelTimeoutSeconds} 秒。已等待 ${elapsedSeconds} 秒，仍在等待 MiniMax 返回；后台任务未停止。`;
      case "07-publish":
        return `正在执行本地便携化打包、复制 assets 与输出静态文件。已持续 ${elapsedSeconds} 秒；后台任务未停止。`;
      case "08-qa":
        return `正在执行本地 HTML 质检与启发式自愈。仅当命中少量异常页或样式离群时，才会调用 MiniMax 定点修复；单次模型请求上限 ${modelTimeoutSeconds} 秒。已持续 ${elapsedSeconds} 秒；后台任务未停止。`;
      case "completed":
        return "编排已完成。";
      default:
        return `当前阶段已持续 ${elapsedSeconds} 秒；后台任务未停止。`;
    }
  }

  private async readSkillPack(templateId: string): Promise<SkillPack> {
    const root = this.resolveSkillRoot();
    const fullDeckRoot = join(root, "templates", "full-decks");
    const singlePageRoot = join(root, "templates", "single-page");
    const [templateNames, layoutFileNames, themeFileNames, rules, layouts, fullDecks, manifest] = await Promise.all([
      this.listDirs(fullDeckRoot),
      this.listFiles(singlePageRoot, ".html"),
      this.listFiles(join(root, "assets", "themes"), ".css"),
      this.readSnippet(join(root, "SKILL.md"), 12000),
      this.readSnippet(join(root, "references", "layouts.md"), 8000),
      this.readSnippet(join(root, "references", "full-decks.md"), 8000),
      indexSkillAssets(root).catch(() => undefined)
    ]);
    const layoutNames = layoutFileNames.map((name) => basename(name, ".html"));
    const themeNames = themeFileNames.map((name) => basename(name, ".css"));
    const referenceNames = Array.from(new Set([templateId, "tech-sharing", "knowledge-arch-blueprint", "pitch-deck"])).filter((name) => templateNames.includes(name)).slice(0, 3);
    const referenceSources = await Promise.all(referenceNames.map(async (name) => ({
      name,
      index: await this.readSnippet(join(fullDeckRoot, name, "index.html"), 8000),
      css: await this.readSnippet(join(fullDeckRoot, name, "style.css"), 8000)
    })));
    return {
      root,
      rules,
      layouts,
      fullDecks,
      templateNames,
      layoutNames,
      themeNames,
      referenceSources,
      manifest
    };
  }

  async prepareCheckpointForAdopt(checkpoint: HtmlPptAgentCheckpoint): Promise<HtmlPptAgentCheckpoint> {
    const updatedAt = new Date().toISOString();

    if (checkpoint.nextStage === "08-qa") {
      if (!checkpoint.deckRender || !checkpoint.plan || !checkpoint.visual) {
        throw new ServiceUnavailableException("当前 08 阶段 checkpoint 不完整，无法采用。");
      }
      return {
        ...checkpoint,
        nextStage: "completed",
        updatedAt
      };
    }

    if (checkpoint.nextStage === "05-generate-index") {
      if (!checkpoint.plan || !checkpoint.visual || !checkpoint.failedIndexState) {
        throw new ServiceUnavailableException("当前 05 阶段缺少可采用的 index.html 批次快照。");
      }

      const adoptedIndexResult = await this.buildAdoptedIndexResultFromFailedState(
        checkpoint.templateId,
        checkpoint.plan,
        checkpoint.visual,
        checkpoint.failedIndexState
      );

      return {
        ...checkpoint,
        indexResult: adoptedIndexResult,
        failedIndexState: undefined,
        nextStage: "06-generate-style",
        updatedAt
      };
    }

    throw new ServiceUnavailableException("当前仅支持在 05 生成 index.html 或 08 本地 HTML 质检失败时使用“采用”。");
  }

  private normalizeAgentResumeStage(
    stage: HtmlPptAgentStage,
    state: {
      research?: ResearchPack;
      plan?: AgentPlan;
      visual?: VisualPlan;
      indexResult?: HtmlPptAgentIndexResult;
      styleCss?: string;
      deckRender?: HtmlPptRenderResult;
    }
  ): HtmlPptAgentStage {
    if (stage === "01-read-skill") return "01-read-skill";
    if (stage === "02-research") return "02-research";
    if (!state.research) return "02-research";
    if (stage === "03-content-plan") return "03-content-plan";
    if (!state.plan) return "03-content-plan";
    if (stage === "04-visual-plan") return "04-visual-plan";
    if (!state.visual) return "04-visual-plan";
    if (stage === "08-qa" || stage === "completed") {
      if (!state.deckRender) return "07-publish";
      if (!existsSync(state.deckRender.outputDir)) return "07-publish";
      return stage === "completed" ? "completed" : "08-qa";
    }
    if (stage === "05-generate-index") return "05-generate-index";
    if (!state.indexResult) return "05-generate-index";
    if (stage === "06-generate-style") return "06-generate-style";
    if (!state.styleCss) return "06-generate-style";
    if (stage === "07-publish") return "07-publish";
    if (!state.deckRender) return "07-publish";
    if (!existsSync(state.deckRender.outputDir)) return "07-publish";
    return stage === "completed" ? "completed" : "08-qa";
  }

  private async buildAdoptedIndexResultFromFailedState(
    templateId: string,
    plan: AgentPlan,
    visual: VisualPlan,
    failedIndexState: HtmlPptAgentFailedIndexState
  ): Promise<HtmlPptAgentIndexResult> {
    const skill = await this.readSkillPack(templateId);
    const slides = plan.slides.length
      ? plan.slides
      : [{ index: 1, title: plan.title, type: "cover", layoutId: "cover", goal: plan.objective, keyPoints: [] }];
    const expectedBatches = this.buildSectionBatches(slides, skill);
    const failedBatchCandidates = failedIndexState.failedBatches?.length
      ? failedIndexState.failedBatches
      : failedIndexState.failedBatch
        ? [failedIndexState.failedBatch]
        : [];
    const snapshotMap = new Map<number, HtmlPptAgentBatchSnapshot>();

    for (const snapshot of [...failedIndexState.batchSnapshots, ...failedBatchCandidates]) {
      if (!snapshotMap.has(snapshot.batchIndex)) {
        snapshotMap.set(snapshot.batchIndex, snapshot);
      }
    }

    const orderedSnapshots = expectedBatches.map((batch, batchIndex) => {
      const snapshot = snapshotMap.get(batchIndex);
      if (!snapshot) {
        throw new ServiceUnavailableException(`当前 05 阶段缺少批次 ${batchIndex + 1} 的快照，无法采用。`);
      }
      if (!this.isCompatibleBatchSnapshot(snapshot, batch)) {
        throw new ServiceUnavailableException(`当前 05 阶段批次 ${batchIndex + 1} 的快照与内容规划不一致，无法采用。`);
      }
      if (!snapshot.sections.trim()) {
        throw new ServiceUnavailableException(`当前 05 阶段批次 ${batchIndex + 1} 没有可用 section，无法采用。`);
      }
      return snapshot;
    });

    return {
      html: this.composeIndexHtml(plan, visual, orderedSnapshots.map((item) => item.sections).join("\n\n")),
      batchCount: expectedBatches.length,
      concurrency: failedBatchCandidates.length > 0 ? 1 : Math.min(this.sectionBatchConcurrency(), Math.max(1, expectedBatches.length)),
      repairCalls: 0,
      localRepairCount: 0,
      stats: orderedSnapshots.map((snapshot) => ({
        batchIndex: snapshot.batchIndex,
        slideIndexes: snapshot.slideIndexes,
        layoutIds: snapshot.layoutIds,
        densityBudget: snapshot.densityBudget,
        modelRepairCalls: 0,
        localRepairCount: 0
      }))
    };
  }

  private describeAgentStage(stage: HtmlPptAgentStage) {
    const labels: Record<HtmlPptAgentStage, string> = {
      "01-read-skill": "01 读取 skill 与模板目录",
      "02-research": "02 主题资料整理",
      "03-content-plan": "03 内容规划",
      "04-visual-plan": "04 视觉方案",
      "05-generate-index": "05 生成 index.html",
      "06-generate-style": "06 生成 style.css",
      "07-publish": "07 复制 assets 与便携化打包",
      "08-qa": "08 本地 HTML 质检",
      completed: "完成态"
    };
    return labels[stage];
  }

  private recordAgentFailure(history: HtmlPptAgentFailureRecord[], record: HtmlPptAgentFailureRecord) {
    const next = [...history, record];
    return next.slice(-16);
  }

  private extractFailureIssues(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const parts = message
      .split(/[；;\n]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
    return Array.from(new Set(parts)).slice(0, 8);
  }

  private compactAgentCheckpoint(checkpoint: HtmlPptAgentCheckpoint) {
    const compacted: HtmlPptAgentCheckpoint = {
      ...checkpoint,
      context: {
        summaryText: checkpoint.context.summaryText,
        recentMessages: []
      }
    };

    if (compacted.deckRender && (compacted.nextStage === "08-qa" || compacted.nextStage === "completed")) {
      compacted.indexResult = compacted.indexResult
        ? {
            ...compacted.indexResult,
            html: ""
          }
        : undefined;
      compacted.styleCss = undefined;
    }

    const serialized = JSON.stringify(compacted);
    if (serialized.length > 300_000) {
      this.logger.warn(`HTML-PPT checkpoint too large: ${serialized.length} bytes; stripping large fields.`);
      compacted.indexResult = compacted.indexResult
        ? {
            ...compacted.indexResult,
            html: ""
          }
        : undefined;
      compacted.styleCss = undefined;
    }

    return compacted;
  }

  private resolveSkillRoot() {
    const candidates = [
      process.env.HTML_PPT_SKILL_ROOT,
      process.env.USERPROFILE ? join(process.env.USERPROFILE, ".codex", "skills", "html-ppt") : "",
      resolve(process.cwd(), ".agents", "skills", "html-ppt"),
      resolve(process.cwd(), "..", "..", ".agents", "skills", "html-ppt")
    ].filter(Boolean) as string[];
    const found = candidates.map((item) => resolve(item)).find((item) => existsSync(join(item, "SKILL.md")) && existsSync(join(item, "assets")));
    if (!found) throw new ServiceUnavailableException("未找到 html-ppt skill，请设置 HTML_PPT_SKILL_ROOT。");
    return found;
  }

  private async modelStructured<T>(
    activeConfig: ActiveModelConfig,
    schema: ZodType<T>,
    schemaHint: string,
    system: string,
    user: string,
    onCall: (usage?: unknown) => void,
    logContext?: ModelLogContext
  ) {
    const raw = await this.modelText(activeConfig, system, user, onCall, logContext);
    const parsed = this.validateStructuredOutput(raw, schema);
    if (parsed.success) return parsed.data;

    this.logger.warn(`HTML-PPT Agent structured output validation failed, requesting repair. snippet=${this.summarizeOutput(raw)}`);
    const repaired = await this.modelText(
      activeConfig,
      system,
      [
        user,
        "",
        "Your previous output was not valid JSON or did not match the required schema.",
        "Rewrite the previous output as one strict JSON object only.",
        "No markdown. No prose. No code fence. No comments.",
        "All field names must use double quotes.",
        "",
        `Schema requirements:\n${schemaHint}`,
        "",
        `Validation issues:\n${parsed.issues.join("\n")}`,
        "",
        `Previous output:\n${raw || "(empty output)"}`
      ].join("\n"),
      onCall,
      logContext
    );
    const repairedParsed = this.validateStructuredOutput(repaired, schema);
    if (repairedParsed.success) return repairedParsed.data;

    throw new ServiceUnavailableException(`模型未返回有效 JSON。输出片段：${this.summarizeOutput(repaired || raw)}`);
  }

  private validateStructuredOutput<T>(raw: string, schema: ZodType<T>) {
    const parsed = this.parseJson(raw);
    if (!parsed) {
      return { success: false as const, issues: ["Output is not valid JSON."] };
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return { success: true as const, data: result.data };
    }

    return {
      success: false as const,
      issues: result.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    };
  }

  private isTransientModelError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === "AbortError") return false; // server-side abort/timeout — do not retry blindly
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
    if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "EPIPE"].includes(code)) return true;
    const message = `${error.message ?? ""} ${cause instanceof Error ? cause.message ?? "" : ""}`.toLowerCase();
    if (message.includes("fetch failed")) return true;
    if (message.includes("socket hang up")) return true;
    if (message.includes("und_err_socket") || message.includes("und_err_connect")) return true;
    if (/\b(?:502|503|504|429)\b/.test(message)) return true;
    return false;
  }

  private async modelText(
    activeConfig: ActiveModelConfig,
    system: string,
    user: string,
    onCall: (usage?: unknown) => void,
    logContext?: ModelLogContext
  ) {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.modelTextOnce(activeConfig, system, user, onCall, logContext);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || !this.isTransientModelError(error)) {
          throw error;
        }
        const backoffMs = Math.round(2000 * Math.pow(3, attempt - 1) * (0.7 + Math.random() * 0.6));
        this.logger.warn(
          `HTML-PPT Agent transient model error on attempt ${attempt}/${maxAttempts}, retrying in ${backoffMs}ms: ${this.describeError(error)}`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("model retry exhausted");
  }

  private async modelTextOnce(
    activeConfig: ActiveModelConfig,
    system: string,
    user: string,
    onCall: (usage?: unknown) => void,
    logContext?: ModelLogContext
  ) {
    const controller = new AbortController();
    const timeoutMs = this.modelRequestTimeoutMs();
    const transportTimeoutMs = this.modelTransportTimeoutMs(timeoutMs);
    const dispatcher = this.createModelDispatcher(transportTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const id = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    const requestPayload = {
      model: activeConfig.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] satisfies ChatMessage[]
    };
    const resolvedSource = logContext?.source ?? "html-ppt-agent";
    const resolvedStage = logContext?.stage ?? "unspecified";
    this.logger.log(`HTML-PPT Agent model ${id} started: chars=${system.length + user.length}, modelTimeoutMs=${timeoutMs}, transportTimeoutMs=${transportTimeoutMs}`);
    try {
      const response = await undiciFetch(`${activeConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeConfig.apiKey}` },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
        dispatcher
      });
      const payload = await response.json().catch(() => null) as
        | (ChatResponse & { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })
        | { error?: { message?: string }; message?: string }
        | null;
      if (!response.ok) throw new ServiceUnavailableException(this.providerError(payload));
      const content = payload && "choices" in payload ? this.extractContent(payload) : "";
      const cleaned = this.stripFence(content.replace(/<think>[\s\S]*?<\/think>/gi, "")).trim();
      
      const usage = payload && "usage" in payload ? payload.usage : undefined;
      onCall(usage);
      this.llmLoggingService.logPayload({
        configId: activeConfig.id,
        userId: logContext?.userId ?? null,
        projectId: logContext?.projectId ?? null,
        messageId: logContext?.messageId ?? null,
        source: resolvedSource,
        stage: resolvedStage,
        requestPayload,
        responsePayload: payload ?? null,
        status: "success",
        latencyMs: Date.now() - startedAt
      }).catch((error) => {
        this.logger.warn(`Failed to log html-ppt-agent payload: ${error instanceof Error ? error.message : String(error)}`);
      });
      
      this.logger.log(`HTML-PPT Agent model ${id} completed: elapsedMs=${Date.now() - startedAt}, outputChars=${cleaned.length}`);
      return cleaned;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.llmLoggingService.logPayload({
          configId: activeConfig.id,
          userId: logContext?.userId ?? null,
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
          this.logger.warn(`Failed to log html-ppt-agent timeout payload: ${payloadError instanceof Error ? payloadError.message : String(payloadError)}`);
        });
        this.logger.warn(`HTML-PPT Agent model ${id} timeout: elapsedMs=${Date.now() - startedAt}, timeoutMs=${timeoutMs}`);
        throw new ServiceUnavailableException(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`);
      }
      this.llmLoggingService.logPayload({
        configId: activeConfig.id,
        userId: logContext?.userId ?? null,
        projectId: logContext?.projectId ?? null,
        messageId: logContext?.messageId ?? null,
        source: resolvedSource,
        stage: resolvedStage,
        requestPayload,
        responsePayload: null,
        status: "error",
        errorMessage: this.describeError(error),
        latencyMs: Date.now() - startedAt
      }).catch((payloadError) => {
        this.logger.warn(`Failed to log html-ppt-agent error payload: ${payloadError instanceof Error ? payloadError.message : String(payloadError)}`);
      });
      this.logger.warn(`HTML-PPT Agent model ${id} failed: elapsedMs=${Date.now() - startedAt}, error=${this.describeError(error)}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      void dispatcher.close().catch(() => undefined);
    }
  }

  private createModelDispatcher(timeoutMs: number) {
    return new UndiciAgent({
      connect: { timeout: 30_000 },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
  }

  private modelTransportTimeoutMs(modelTimeoutMs: number) {
    const configured = Number(process.env.LLM_TRANSPORT_TIMEOUT_MS);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return Math.max(modelTimeoutMs + 60_000, 660_000);
  }

  private describeError(error: unknown) {
    if (!(error instanceof Error)) return String(error);
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error) return `${error.message}; cause=${cause.name}: ${cause.message}`;
    if (cause) return `${error.message}; cause=${String(cause)}`;
    return error.message;
  }

  private modelRequestTimeoutMs() {
    const agentTimeout = Number(process.env.PPT_MODEL_TIMEOUT_MS);
    if (Number.isFinite(agentTimeout) && agentTimeout > 0) return agentTimeout;
    const sharedTimeout = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
    if (Number.isFinite(sharedTimeout) && sharedTimeout > 0) return sharedTimeout;
    return 600_000;
  }

  private async generateIndexHtml(
    activeConfig: ActiveModelConfig,
    input: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    },
    plan: AgentPlan,
    visual: VisualPlan,
    research: ResearchPack,
    skill: SkillPack,
    onCall: () => void,
    priorFailures: string[] = [],
    logContextBase?: ModelLogContext,
    failedIndexState?: HtmlPptAgentFailedIndexState,
    onFailureState?: (state: HtmlPptAgentFailedIndexState | undefined) => void
  ) {
    const slides = plan.slides.length ? plan.slides : [{ index: 1, title: plan.title, type: "cover", layoutId: "cover", goal: plan.objective, keyPoints: [] }];
    const deckStyle = this.classifyDeckStyle(plan);
    const batches = this.buildSectionBatches(slides, skill);
    // Load the visual-DNA donor exactly once per generateIndexHtml call so
    // every batch (and any per-slide repair) sees the same reference template.
    const referenceFullDeckName = this.pickReferenceFullDeckName(visual, skill);
    const referenceFullDeck = referenceFullDeckName
      ? await this.readReferenceFullDeck(skill, referenceFullDeckName)
      : undefined;
    const snapshotMap = new Map((failedIndexState?.batchSnapshots ?? []).map((item) => [item.batchIndex, item]));
    const failedBatchCandidates = failedIndexState?.failedBatches?.length
      ? failedIndexState.failedBatches
      : failedIndexState?.failedBatch
        ? [failedIndexState.failedBatch]
        : [];
    const failedSnapshotMap = new Map(
      failedBatchCandidates
        .filter((item): item is HtmlPptAgentBatchSnapshot => Boolean(item))
        .map((item) => [item.batchIndex, item])
    );
    const hasFailedSnapshots = failedSnapshotMap.size > 0;
    const concurrency = hasFailedSnapshots ? 1 : Math.min(this.sectionBatchConcurrency(), Math.max(1, batches.length));
    let reservedRepairCalls = 0;
    const maxRepairCalls = Math.max(2, slides.length * 2);
    const reserveRepairCall = (label: string, issues: string[]) => {
      if (reservedRepairCalls >= maxRepairCalls) {
        throw new ServiceUnavailableException(`index.html ${label}超过最大修复次数 ${maxRepairCalls}，终止继续修复。当前问题：${issues.join("；")}`);
      }
      reservedRepairCalls += 1;
    };
    const processBatch = async (batch: AgentPlan["slides"], batchIndex: number) => {
      let resumeSnapshot = failedSnapshotMap.get(batchIndex);
      const cachedSnapshot = snapshotMap.get(batchIndex);
      if (
        cachedSnapshot &&
        !resumeSnapshot &&
        this.isCompatibleBatchSnapshot(cachedSnapshot, batch)
      ) {
        const cachedSanitized = this.sanitizeSectionBatchMarkup(
          cachedSnapshot.sections,
          batch,
          undefined,
          referenceFullDeck?.contract,
          referenceFullDeck?.donorContract
        );
        const cachedQa = this.validateSectionBatch(cachedSanitized.html, batch, skill, plan, deckStyle, referenceFullDeck?.donorContract);
        if (cachedQa.issues.length === 0) {
          return {
            ok: true as const,
            value: {
              ...cachedSnapshot,
              sections: cachedSanitized.html,
              modelRepairCalls: 0,
              localRepairCount: cachedSanitized.localRepairCount
            }
          };
        }

        resumeSnapshot = this.toFailedBatchSnapshot({
          batchIndex,
          batch,
          skill,
          sections: cachedSanitized.html,
          qaIssues: cachedQa.issues
        });
      }

      try {
        const result = await this.processSectionBatch({
          batch,
          batchIndex,
          activeConfig,
          input,
          plan,
          deckStyle,
          visual,
          research,
          skill,
          referenceFullDeck,
          onCall,
          reserveRepairCall,
          priorFailures,
          logContextBase,
          resumeSnapshot: resumeSnapshot && this.isCompatibleBatchSnapshot(resumeSnapshot, batch) ? resumeSnapshot : undefined
        });
        return {
          ok: true as const,
          value: result
        };
      } catch (error) {
        if (error instanceof HtmlPptAgentBatchError) {
          return {
            ok: false as const,
            snapshot: error.snapshot
          };
        }

        throw error;
      }
    };

    const batchOutcomes = await this.mapWithConcurrency(
      batches.map((batch, batchIndex) => ({ batch, batchIndex })),
      concurrency,
      async ({ batch, batchIndex }) => processBatch(batch, batchIndex)
    );

    const succeeded = batchOutcomes
      .filter((item) => item.ok)
      .map((item) => item.value);
    const failed = batchOutcomes
      .filter((item) => !item.ok)
      .map((item) => item.snapshot);

    if (failed.length > 0) {
      const sortedSucceeded = succeeded
        .map((item) => this.toBatchSnapshot(item))
        .sort((a, b) => a.batchIndex - b.batchIndex);
      const sortedFailed = failed.sort((a, b) => a.batchIndex - b.batchIndex);
      onFailureState?.({
        batchSnapshots: sortedSucceeded,
        failedBatches: sortedFailed,
        failedBatch: sortedFailed[0]
      });

      const issues = Array.from(
        new Set(
          sortedFailed.flatMap((snapshot) => {
            const prefix = `批次${snapshot.batchIndex + 1}[第${snapshot.slideIndexes.join(",")}页]`;
            const batchIssues = snapshot.qaIssues?.length ? snapshot.qaIssues : ["批次生成失败，未返回可用 section"];
            return batchIssues.map((issue) => `${prefix} ${issue}`);
          })
        )
      );
      throw new ServiceUnavailableException(`index.html 分批生成 QA 未通过：${issues.join("；")}`);
    }

    const ordered = succeeded.sort((a, b) => a.batchIndex - b.batchIndex);
    onFailureState?.(undefined);
    const requestedChineseChars = this.requestedChineseCharTarget(this.extractDeckRequestRequirements(input.pendingUserMessage.content));
    let sections = this.extractSectionList(ordered.map((item) => item.sections).join("\n\n"));
    let narrativeActualChineseChars = this.sumSectionsChineseChars(sections);
    let narrativeExpandedChars = 0;
    let narrativeExpandedSlides: number[] = [];

    if (requestedChineseChars && narrativeActualChineseChars < requestedChineseChars) {
      const expanded = await this.expandDeckNarrativeIfNeeded({
        activeConfig,
        agentInput: input,
        plan,
        deckStyle,
        visual,
        research,
        skill,
        referenceFullDeck,
        sections,
        requestedChineseChars,
        onCall,
        logContextBase
      });
      sections = expanded.sections;
      narrativeActualChineseChars = expanded.actualChineseChars;
      narrativeExpandedChars = expanded.addedChineseChars;
      narrativeExpandedSlides = expanded.expandedSlides;
    }
    sections = this.sanitizeFinalSectionsForTemplateDecorations(sections, slides, referenceFullDeck?.donorContract);

    // Hard slide-count guard: if Stage 05 emitted more <section>s than the
    // plan called for (typically because the model split a slide into two),
    // collapse adjacent duplicate-titled sections and finally trim to length.
    // The plan is authoritative on slide count once we entered Stage 05.
    if (sections.length !== slides.length) {
      const beforeCount = sections.length;
      sections = this.reconcileSectionCountToPlan(sections, slides);
      this.logger.warn(
        `HTML-PPT Agent slide-count drift in Stage 05: emitted=${beforeCount}, plan=${slides.length}, reconciled=${sections.length}`
      );
    }

    return {
      html: this.composeIndexHtml(plan, visual, sections.join("\n\n")),
      batchCount: batches.length,
      concurrency,
      repairCalls: ordered.reduce((sum, item) => sum + item.modelRepairCalls, 0),
      localRepairCount: ordered.reduce((sum, item) => sum + item.localRepairCount, 0),
      ...(requestedChineseChars ? { narrativeTargetChineseChars: requestedChineseChars } : {}),
      ...(requestedChineseChars ? { narrativeActualChineseChars } : {}),
      ...(narrativeExpandedChars > 0 ? { narrativeExpandedChars } : {}),
      ...(narrativeExpandedSlides.length > 0 ? { narrativeExpandedSlides } : {}),
      stats: ordered.map((item) => ({
        batchIndex: item.batchIndex,
        slideIndexes: item.slideIndexes,
        layoutIds: item.layoutIds,
        densityBudget: item.densityBudget,
        modelRepairCalls: item.modelRepairCalls,
        localRepairCount: item.localRepairCount
      }))
    };
  }

  private extractSlideSections(content: string) {
    const cleaned = this.stripFence(content.replace(/<think>[\s\S]*?<\/think>/gi, "")).trim();
    const sections = cleaned.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    return sections.join("\n\n").trim();
  }

  private extractSectionList(content: string): string[] {
    return Array.from(content.match(/<section\b[\s\S]*?<\/section>/gi) ?? []);
  }

  /**
   * Deterministic tag-balance auto-repair. Counts opening vs. closing
   * `<div>` tags inside a single `<section>` and appends or prepends closers
   * when the imbalance is small (≤ 3). This catches the majority of "HTML
   * 标签嵌套异常" failures (model emitted one stray `</div>` or forgot one)
   * without spending a model round-trip on repair.
   */
  private autoBalanceSectionTags(section: string): string {
    if (!section) return section;
    // Operate on the inner contents between the outermost <section ...> and
    // </section> so we don't accidentally close the outer section itself.
    const sectionOpenMatch = section.match(/<section\b[^>]*>/i);
    if (!sectionOpenMatch) return section;
    const innerStart = (sectionOpenMatch.index ?? 0) + sectionOpenMatch[0].length;
    const innerEnd = section.lastIndexOf("</section>");
    if (innerEnd <= innerStart) return section;
    const head = section.slice(0, innerStart);
    const inner = section.slice(innerStart, innerEnd);
    const tail = section.slice(innerEnd);

    let depth = 0;
    let stripLeadingClosers = 0;
    const openMatches = inner.match(/<div\b[^>]*?(?<!\/)>/gi)?.length ?? 0;
    const closeMatches = inner.match(/<\/div\s*>/gi)?.length ?? 0;
    let next = inner;

    if (closeMatches > openMatches && closeMatches - openMatches <= 3) {
      // Strip up to N stray leading </div> tokens that close nothing.
      const stray = closeMatches - openMatches;
      const tagPattern = /<\/?div\b[^>]*>/gi;
      let removed = 0;
      let cursor = 0;
      const parts: string[] = [];
      let lastEnd = 0;
      for (let match = tagPattern.exec(inner); match; match = tagPattern.exec(inner)) {
        const tag = match[0];
        const isOpen = /^<div\b/i.test(tag) && !/\/>$/.test(tag);
        if (isOpen) depth += 1;
        else {
          if (depth === 0 && removed < stray) {
            parts.push(inner.slice(lastEnd, match.index));
            lastEnd = match.index + tag.length;
            removed += 1;
            continue;
          }
          if (depth > 0) depth -= 1;
        }
      }
      if (removed > 0) {
        parts.push(inner.slice(lastEnd));
        next = parts.join("");
      }
      stripLeadingClosers = removed;
    } else if (openMatches > closeMatches && openMatches - closeMatches <= 3) {
      // Append missing </div> tokens just before </section>.
      next = inner + "\n" + "</div>".repeat(openMatches - closeMatches);
    }

    if (next === inner && stripLeadingClosers === 0) return section;
    return `${head}${next}${tail}`;
  }

  private sanitizeSectionBatchMarkup(
    sectionsHtml: string,
    batch: AgentPlan["slides"],
    allowedClasses?: Set<string>,
    referenceContract?: ReferenceComponentContract,
    donorContract?: DonorTemplateContract
  ) {
    let localRepairCount = 0;
    const sections = this.extractSectionList(sectionsHtml)
      .map((section, index) => {
        const balanced = this.autoBalanceSectionTags(section);
        if (balanced !== section) localRepairCount += 1;
        const repaired = this.locallyRepairSectionMarkup(balanced, batch[index], allowedClasses, referenceContract, donorContract);
        if (repaired !== balanced.trim()) localRepairCount += 1;
        return repaired;
      })
      .join("\n\n")
      .trim();

    return { html: sections, localRepairCount };
  }

  private locallyRepairSectionMarkup(
    section: string,
    slide?: AgentPlan["slides"][number],
    allowedClasses?: Set<string>,
    referenceContract?: ReferenceComponentContract,
    donorContract?: DonorTemplateContract
  ) {
    let next = section;
    next = this.stripNotesBlocks(next);
    next = this.stripUnsafeMetricFx(next);
    next = this.stripSectionRootAnimations(next);
    next = this.stripBlockedFx(next);
    next = this.normalizeNonNumericNumClasses(next);
    next = this.stripEmptyLeafPlaceholderNodes(next);
    next = this.normalizeHeadingStyledSpans(next);
    next = this.stripVisibleRuntimeInstructionHints(next);
    next = this.normalizeTemplateHeadingClasses(next, slide, allowedClasses, referenceContract);
    next = this.normalizeTemplateCardClasses(next, slide, allowedClasses, referenceContract);
    next = this.sanitizeDonorSection(next, { slide, donorContract });
    next = this.normalizeSiblingCardInlineStyles(next);
    next = this.stripUnknownSectionClasses(next, allowedClasses);
    next = this.ensureSectionDataTitle(next, slide?.title);
    next = this.ensureSectionPlanIdentity(next, slide);
    return next.trim();
  }

  private normalizeHeadingStyledSpans(section: string) {
    return section.replace(/<(h1|h2|h3|h4)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_match, tag: string, attrs: string, inner: string) => {
      const normalizedInner = inner
        .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1")
        .replace(/<(strong|em|b|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "$2");
      return `<${tag}${attrs}>${normalizedInner}</${tag}>`;
    });
  }

  private stripVisibleRuntimeInstructionHints(section: string) {
    let next = section;
    const hintClasses = [
      "dk-keyhint",
      "keyhint",
      "key-hint",
      "keyboard-hint",
      "shortcut-hint",
      "nav-hint",
      "runtime-hint"
    ];

    for (const token of hintClasses) {
      const escaped = this.escapeRegex(token);
      next = next.replace(
        new RegExp(`<(?:div|p|span|small)\\b(?=[^>]*\\bclass=(["'])[^"']*\\b${escaped}\\b[^"']*\\1)[^>]*>[\\s\\S]*?<\\/(?:div|p|span|small)>`, "gi"),
        ""
      );
    }

    const instructionElementPattern =
      /<(div|p|span|small)\b([^>]*)>([\s\S]*?(?:方向键|切换页面|<kbd\b|navigate|press\s*(?:←|&larr;|left)|presenter|fullscreen)[\s\S]*?)<\/\1>/gi;
    next = next.replace(instructionElementPattern, (match, tagName: string, attrs: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const hasRuntimeSignal =
        /方向键/.test(text) ||
        /切换页面/.test(text) ||
        /navigate/.test(text) ||
        /press\s*(?:←|left)/i.test(text) ||
        (/<kbd\b/i.test(inner) && /(←|→|space|enter|presenter|fullscreen|navigate|切换)/i.test(text)) ||
        /(presenter|fullscreen)/i.test(text);
      return hasRuntimeSignal ? "" : match;
    });

    return next;
  }

  private buildSectionClassProtocol(input: {
    layoutTemplates: string;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    skill: SkillPack;
  }) {
    const sources = [
      input.layoutTemplates,
      input.referenceFullDeck?.sections.join("\n") ?? "",
      input.referenceFullDeck?.cssExcerpt ?? "",
      ...input.skill.referenceSources.flatMap((item) => [item.index, item.css])
    ];
    const allowedClasses = new Set<string>([
      ...this.sectionClassDefaults(),
      ...sources.flatMap((source) => this.extractClassTokensFromMarkup(source)),
      ...sources.flatMap((source) => this.extractClassTokensFromCss(source))
    ]);
    return {
      allowedClasses,
      promptCatalog: this.renderClassCatalog(allowedClasses),
      referenceContract: input.referenceFullDeck?.contract,
      donorContract: input.referenceFullDeck?.donorContract
    };
  }

  private sectionClassDefaults() {
    return [
      "slide",
      "cover",
      "section-divider",
      "content",
      "content-grid",
      "content-main",
      "content-side",
      "grid",
      "g2",
      "g3",
      "g4",
      "card",
      "card-soft",
      "card-outline",
      "card-accent",
      "panel",
      "metric",
      "metric-large",
      "metric-number",
      "metric-sm",
      "metric-label",
      "metric-meta",
      "delta",
      "number",
      "kicker",
      "eyebrow",
      "lede",
      "h1",
      "h2",
      "h3",
      "pill",
      "badge",
      "tag",
      "caption",
      "meta",
      "timeline",
      "process-steps",
      "roadmap",
      "comparison",
      "pros-cons",
      "gantt",
      "quote",
      "quote-mark",
      "hero",
      "hero-copy",
      "hero-art",
      "visual",
      "visual-frame",
      "stat",
      "stat-grid",
      "kpi-grid",
      "callout",
      "stack",
      "cluster"
    ];
  }

  private renderClassCatalog(classNames: Set<string>, limit = 180) {
    const values = Array.from(classNames).filter(Boolean).sort((a, b) => a.localeCompare(b)).slice(0, limit);
    return values.join(", ");
  }

  private normalizeTemplateHeadingClasses(
    section: string,
    slide?: AgentPlan["slides"][number],
    allowedClasses?: Set<string>,
    referenceContract?: ReferenceComponentContract
  ) {
    if (!allowedClasses || allowedClasses.size === 0) return section;

    const preferredCoverTitle =
      referenceContract?.coverTitleClass && allowedClasses.has(referenceContract.coverTitleClass)
        ? referenceContract.coverTitleClass
        : allowedClasses.has("xw-title")
          ? "xw-title"
          : undefined;
    const preferredBodyTitle =
      referenceContract?.bodyTitleClass && allowedClasses.has(referenceContract.bodyTitleClass)
        ? referenceContract.bodyTitleClass
        : allowedClasses.has("xw-title-md")
          ? "xw-title-md"
          : undefined;
    const preferredKicker =
      referenceContract?.kickerClass && allowedClasses.has(referenceContract.kickerClass)
        ? referenceContract.kickerClass
        : allowedClasses.has("xw-kicker")
          ? "xw-kicker"
          : undefined;
    const preferredSectionLabel =
      referenceContract?.sectionLabelClass && allowedClasses.has(referenceContract.sectionLabelClass)
        ? referenceContract.sectionLabelClass
        : undefined;

    let next = section;
    if (preferredKicker) {
      next = this.rewriteClassAttributes(next, ({ tagName, classes }) => {
        if (!["p", "div", "span"].includes(tagName)) return classes;
        if (!classes.some((item) => item === "kicker" || item === "eyebrow")) return classes;
        return this.prependClassToken(classes.filter((item) => item !== "kicker" && item !== "eyebrow"), preferredKicker);
      });
    }

    if (preferredSectionLabel) {
      next = this.rewriteClassAttributes(next, ({ classes }) => {
        if (!classes.some((item) => item === "section-label" || item === "section_label")) return classes;
        return this.prependClassToken(
          classes.filter((item) => item !== "section-label" && item !== "section_label"),
          preferredSectionLabel
        );
      });
    }

    const preferredTitleClass = slide?.layoutId === "cover" ? preferredCoverTitle : preferredBodyTitle;
    if (!preferredTitleClass) return next;

    return this.rewriteClassAttributes(next, ({ tagName, classes }) => {
      if (!["h1", "h2"].includes(tagName)) return classes;
      if (classes.includes(preferredTitleClass)) return classes;
      const hasAnyContractTitle =
        (referenceContract?.coverTitleClass && classes.includes(referenceContract.coverTitleClass)) ||
        (referenceContract?.bodyTitleClass && classes.includes(referenceContract.bodyTitleClass));
      if (hasAnyContractTitle) return classes;
      const nextClasses = classes.filter((item) => item !== "h1" && item !== "h2");
      return this.prependClassToken(nextClasses, preferredTitleClass);
    });
  }

  private normalizeTemplateCardClasses(
    section: string,
    _slide?: AgentPlan["slides"][number],
    allowedClasses?: Set<string>,
    referenceContract?: ReferenceComponentContract
  ) {
    const preferredCardClass =
      referenceContract?.cardClass && allowedClasses?.has(referenceContract.cardClass)
        ? referenceContract.cardClass
        : undefined;
    if (!preferredCardClass) return section;

    return this.rewriteClassAttributes(section, ({ classes }) => {
      if (classes.includes(preferredCardClass)) return classes;
      const genericCardLike = classes.some((item) =>
        ["card", "card-soft", "card-outline", "card-accent", "panel", "side"].includes(item)
      );
      if (!genericCardLike) return classes;
      return this.prependClassToken(classes, preferredCardClass);
    });
  }

  private stripDonorForbiddenClasses(
    section: string,
    slide?: AgentPlan["slides"][number],
    donorContract?: DonorTemplateContract
  ) {
    const alwaysForbidden = new Set((donorContract?.forbiddenClasses ?? []).filter(Boolean));
    const scopedDecorative = new Set([
      ...(donorContract?.coverOnlyClasses ?? []),
      ...(donorContract?.decorativeOnlyClasses ?? [])
    ].filter(Boolean));
    if (alwaysForbidden.size === 0 && scopedDecorative.size === 0) return section;

    const isOrnamentalSlide = slide
      ? ["cover", "section-divider", "cta", "thanks"].includes(slide.layoutId)
      : false;

    let next = section;
    if (!isOrnamentalSlide && scopedDecorative.size > 0) {
      next = this.stripEmptyDecorativeNodes(next, scopedDecorative);
    }

    return this.rewriteClassAttributes(next, ({ classes }) =>
      classes.filter((token) => {
        if (alwaysForbidden.has(token)) return false;
        if (!isOrnamentalSlide && scopedDecorative.has(token)) return false;
        return true;
      })
    );
  }

  private sanitizeDonorSection(
    section: string,
    options: {
      slide?: AgentPlan["slides"][number];
      donorContract?: DonorTemplateContract;
      maskText?: boolean;
    } = {}
  ) {
    let next = this.stripDonorForbiddenClasses(section, options.slide, options.donorContract);
    if (options.maskText) {
      next = this.maskDonorLeafText(next);
      next = next.replace(/>([^<>{}\n][^<>]*?)</g, (match, text: string) => {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized) return match;
        if (/^\[[A-Z0-9_-]+\]$/.test(normalized)) return match;
        return `>${this.semanticDonorToken("", "", normalized)}<`;
      });
    }
    return next.trim();
  }

  private sanitizeFinalSectionsForTemplateDecorations(
    sections: string[],
    slides: AgentPlan["slides"],
    donorContract?: DonorTemplateContract
  ) {
    if (!donorContract) return sections;
    return sections.map((section, index) => this.sanitizeDonorSection(section, { slide: slides[index], donorContract }));
  }

  /**
   * Hard reconciliation of emitted section count to the plan's slide count.
   * The most common drift mode is: model split one body slide into two
   * adjacent sections with the same data-title (observed in multiple smoke
   * decks). Collapse those first; if still over, drop the lowest-priority
   * extras (closer-style or near-duplicates). If still under, this method
   * leaves it as-is — Stage 05 already pads from the plan.
   */
  private reconcileSectionCountToPlan(sections: string[], slides: AgentPlan["slides"]): string[] {
    if (sections.length === slides.length) return sections;
    const titleOf = (section: string): string => {
      const m = section.match(/data-title=["']([^"']*)["']/i);
      return (m?.[1] ?? "").trim();
    };
    const dataTitleNorm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const next = [...sections];

    // 1) Collapse adjacent duplicate-title sections (common model split).
    while (next.length > slides.length) {
      let mergedAny = false;
      for (let i = next.length - 1; i > 0; i -= 1) {
        const a = next[i - 1];
        const b = next[i];
        if (!a || !b) continue;
        const ta = dataTitleNorm(titleOf(a));
        const tb = dataTitleNorm(titleOf(b));
        if (ta && tb && ta === tb) {
          // Keep the longer one (more content) when collapsing duplicates.
          next[i - 1] = a.length >= b.length ? a : b;
          next.splice(i, 1);
          mergedAny = true;
          if (next.length === slides.length) break;
        }
      }
      if (!mergedAny) break;
    }

    // 2) Still over budget — trim from the lowest-priority tail. We prefer
    // dropping near-duplicate consecutive sections; failing that, drop
    // closer-shaped extras (cta / thanks / fin patterns) before body slides.
    if (next.length > slides.length) {
      const isClosingShaped = (section: string) => {
        const t = titleOf(section).toLowerCase();
        return /(?:thanks|cta|结语|收尾|the end|致谢|q\s*&\s*a)/.test(t);
      };
      // Drop trailing closing-shaped surplus first.
      for (let i = next.length - 1; i >= 0 && next.length > slides.length; i -= 1) {
        const candidate = next[i];
        if (i === next.length - 1 && candidate && isClosingShaped(candidate) && i !== slides.length - 1) {
          next.splice(i, 1);
        }
      }
      // Final fallback: trim the tail to length.
      while (next.length > slides.length) next.pop();
    }

    return next;
  }

  private stripEmptyDecorativeNodes(markup: string, decorativeClasses: Set<string>) {
    let next = markup;
    for (const token of decorativeClasses) {
      const escaped = this.escapeRegex(token);
      const pattern = new RegExp(
        `<(div|span)\\b(?=[^>]*\\bclass=(["'])[^"']*\\b${escaped}\\b[^"']*\\2)[^>]*>\\s*<\\/\\1>`,
        "gi"
      );
      next = next.replace(pattern, "");
    }
    return next;
  }

  private normalizeSiblingCardInlineStyles(section: string) {
    return this.rewriteCardContainers(section, (containerInner) => {
      const cards = this.findDirectCardBlocks(containerInner);
      if (cards.length < 2) return containerInner;

      const styleKeys = cards.map((card) => this.inlineCardVisualStyleKey(card.openTag));
      const nonEmptyKeys = Array.from(new Set(styleKeys.filter(Boolean)));
      if (nonEmptyKeys.length <= 1) return containerInner;

      let next = containerInner;
      for (let index = cards.length - 1; index >= 0; index -= 1) {
        const card = cards[index];
        if (!card || !styleKeys[index]) continue;
        if (this.cardHasDifferentiatorClass(card.className)) continue;
        const cleanedOpenTag = this.stripInlineCardVisualDeclarations(card.openTag);
        next = `${next.slice(0, card.start)}${cleanedOpenTag}${next.slice(card.start + card.openTag.length)}`;
      }
      return next;
    });
  }

  private rewriteCardContainers(section: string, transform: (inner: string) => string) {
    const containerPattern = /<div\b[^>]*class=["'][^"']*\b(?:row|grid|g2|g3|g4|comparison|pros-cons|kpi-grid)\b[^"']*["'][^>]*>/gi;
    let next = "";
    let cursor = 0;
    for (const match of section.matchAll(containerPattern)) {
      const openTag = match[0];
      const start = match.index ?? 0;
      const innerStart = start + openTag.length;
      const end = this.findMatchingDivEnd(section, innerStart);
      if (end.openStart <= innerStart) continue;
      next += section.slice(cursor, innerStart);
      next += transform(section.slice(innerStart, end.openStart));
      cursor = end.openStart;
    }
    if (cursor === 0) return section;
    return next + section.slice(cursor);
  }

  private findDirectCardBlocks(innerHtml: string) {
    const cards: Array<{ start: number; openTag: string; className: string }> = [];
    const openTagPattern = /<div\b[^>]*class=["']([^"']*\b(?:card|panel|side|feature-card)\b[^"']*)["'][^>]*>/gi;
    for (const match of innerHtml.matchAll(openTagPattern)) {
      const start = match.index ?? 0;
      const before = innerHtml.slice(0, start);
      const opens = (before.match(/<div\b/gi) ?? []).length;
      const closes = (before.match(/<\/div>/gi) ?? []).length;
      if (opens !== closes) continue;
      cards.push({ start, openTag: match[0], className: match[1] ?? "" });
    }
    return cards;
  }

  private inlineCardVisualStyleKey(openTag: string) {
    const style = openTag.match(/\sstyle=(["'])([^"']*)\1/i)?.[2] ?? "";
    if (!style) return "";
    const declarations = this.parseInlineStyle(style);
    return ["background", "background-color", "border", "border-color"]
      .map((key) => `${key}:${declarations[key] ?? ""}`)
      .filter((item) => !item.endsWith(":"))
      .join(";");
  }

  private parseInlineStyle(style: string) {
    const entries = style
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const colon = item.indexOf(":");
        if (colon < 0) return undefined;
        return [item.slice(0, colon).trim().toLowerCase(), item.slice(colon + 1).trim()] as const;
      })
      .filter((item): item is readonly [string, string] => Boolean(item));
    return Object.fromEntries(entries);
  }

  private cardHasDifferentiatorClass(className: string) {
    return /\b(?:card-accent|card-warning|card-danger|card-good|good-side|bad-side|pro|con|positive|negative|success|warning|danger|accent)\b/i.test(className);
  }

  private stripInlineCardVisualDeclarations(openTag: string) {
    return openTag.replace(/\sstyle=(["'])([^"']*)\1/i, (_match, quote: string, style: string) => {
      const kept = style
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
        .filter((item) => !/^(?:background|background-color|border|border-color)\s*:/i.test(item));
      return kept.length ? ` style=${quote}${kept.join("; ")}${quote}` : "";
    });
  }

  private rewriteClassAttributes(
    markup: string,
    transform: (input: { tagName: string; classes: string[] }) => string[]
  ) {
    return markup.replace(/<([a-z0-9:-]+)\b([^>]*?)class=(["'])([^"']+)\3([^>]*)>/gi, (match, tagName: string, before: string, quote: string, classValue: string, after: string) => {
      const classes = classValue.split(/\s+/).filter(Boolean);
      const nextClasses = Array.from(new Set(transform({ tagName: tagName.toLowerCase(), classes }))).filter(Boolean);
      if (nextClasses.join(" ") === classes.join(" ")) return match;
      return `<${tagName}${before}class=${quote}${nextClasses.join(" ")}${quote}${after}>`;
    });
  }

  private prependClassToken(classTokens: string[], token: string) {
    return [token, ...classTokens.filter((item) => item !== token)];
  }

  private stripUnknownSectionClasses(section: string, allowedClasses?: Set<string>) {
    if (!allowedClasses || allowedClasses.size === 0) return section;
    return section.replace(/\bclass=(["'])([^"']+)\1/gi, (match, quote: string, classValue: string) => {
      const originalTokens = classValue.split(/\s+/).filter(Boolean);
      const filteredTokens = originalTokens.filter((token, index) => {
        if (allowedClasses.has(token)) return true;
        if (this.runtimeClassTokens().has(token)) return true;
        return index === 0 && token === "slide";
      });
      if (filteredTokens.length === 0) return match;
      return `class=${quote}${Array.from(new Set(filteredTokens)).join(" ")}${quote}`;
    });
  }

  private ensureSectionDataTitle(section: string, title?: string) {
    if (/\bdata-title=/.test(section)) return section;
    return section.replace(/<section\b/i, (match) => `${match} data-title="${this.escapeAttr(title?.trim() || "Slide")}"`);
  }

  private ensureSectionPlanIdentity(section: string, slide?: AgentPlan["slides"][number]) {
    if (!slide) return section;
    return section.replace(/<section\b([^>]*)>/i, (match, attrs: string) => {
      let nextAttrs = attrs;
      if (/\bdata-slide-index=/.test(nextAttrs)) {
        nextAttrs = nextAttrs.replace(/\bdata-slide-index=(["'])[^"']*\1/i, `data-slide-index="${slide.index}"`);
      } else {
        nextAttrs += ` data-slide-index="${slide.index}"`;
      }
      if (/\bdata-layoutid=/.test(nextAttrs)) {
        nextAttrs = nextAttrs.replace(/\bdata-layoutid=(["'])[^"']*\1/i, `data-layoutid="${this.escapeAttr(slide.layoutId)}"`);
      } else {
        nextAttrs += ` data-layoutid="${this.escapeAttr(slide.layoutId)}"`;
      }
      return `<section${nextAttrs}>`;
    });
  }

  private buildSectionBatches(slides: AgentPlan["slides"], skill: SkillPack) {
    const layoutMap = new Map((skill.manifest?.layouts ?? []).map((layout) => [layout.id, layout]));
    const batches: AgentPlan["slides"][] = [];
    let current: AgentPlan["slides"] = [];
    let budgetSum = 0;

    for (const slide of slides) {
      const layout = layoutMap.get(slide.layoutId);
      const densityBudget = layout?.densityBudget?.maxBodyCharsTotal ?? 420;
      const isLightweight = ["cover", "toc", "section-divider", "cta", "thanks", "stat-highlight", "big-quote"].includes(slide.layoutId);
      const slideBudget = Math.max(180, densityBudget);
      const maxSlidesPerBatch = isLightweight ? 6 : 4;
      const maxBudgetPerBatch = 1500;

      if (current.length > 0 && (current.length >= maxSlidesPerBatch || budgetSum + slideBudget > maxBudgetPerBatch)) {
        batches.push(current);
        current = [];
        budgetSum = 0;
      }

      current.push(slide);
      budgetSum += slideBudget;
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  }

  private isCompatibleBatchSnapshot(snapshot: HtmlPptAgentBatchSnapshot, batch: AgentPlan["slides"]) {
    if (snapshot.slideIndexes.length !== batch.length || snapshot.layoutIds.length !== batch.length) {
      return false;
    }

    return batch.every((slide, index) => snapshot.slideIndexes[index] === slide.index && snapshot.layoutIds[index] === slide.layoutId);
  }

  private toBatchSnapshot(result: {
    batchIndex: number;
    slideIndexes: number[];
    layoutIds: string[];
    densityBudget: number;
    sections: string;
  }): HtmlPptAgentBatchSnapshot {
    return {
      batchIndex: result.batchIndex,
      slideIndexes: result.slideIndexes,
      layoutIds: result.layoutIds,
      densityBudget: result.densityBudget,
      sections: result.sections
    };
  }

  private toFailedBatchSnapshot(input: {
    batchIndex: number;
    batch: AgentPlan["slides"];
    skill: SkillPack;
    sections: string;
    qaIssues: string[];
  }): HtmlPptAgentBatchSnapshot {
    const { batchIndex, batch, skill, sections, qaIssues } = input;
    return {
      batchIndex,
      slideIndexes: batch.map((slide) => slide.index),
      layoutIds: batch.map((slide) => slide.layoutId),
      densityBudget: batch.reduce((sum, slide) => sum + this.slideDensityBudget(slide, skill), 0),
      sections,
      qaIssues,
      slideIssues: this.groupIssuesBySlide(qaIssues, batch).map((item) => ({
        slideIndex: item.slideIndex,
        batchOffset: item.batchOffset,
        issues: item.issues
      }))
    };
  }

  private async writeHtmlPptDebugArtifact(
    input: {
      projectName: string;
      projectId?: string;
      assistantMessageId?: string;
      pendingUserMessage?: { id?: string; content?: string };
    },
    stem: string,
    payload: Record<string, unknown> & { rawHtml?: string; sectionsHtml?: string }
  ) {
    const runId = this.safePathSegment(
      input.projectId
        ?? input.assistantMessageId
        ?? input.pendingUserMessage?.id
        ?? input.projectName
        ?? randomUUID()
    );
    const safeStem = this.safePathSegment(stem);
    const debugDir = resolve(process.cwd(), ".local-runtime", "html-ppt-debug", runId);
    const { rawHtml, sectionsHtml, ...meta } = payload;
    const metadata = {
      ...meta,
      projectId: input.projectId,
      projectName: input.projectName,
      assistantMessageId: input.assistantMessageId,
      sourceUserMessageId: input.pendingUserMessage?.id,
      userPrompt: input.pendingUserMessage?.content,
      recordedAt: new Date().toISOString()
    };

    try {
      await mkdir(debugDir, { recursive: true });
      await writeFile(join(debugDir, `${safeStem}.json`), JSON.stringify(metadata, null, 2), "utf8");
      if (typeof rawHtml === "string" && rawHtml.trim()) {
        await writeFile(join(debugDir, `${safeStem}.raw.html`), rawHtml, "utf8");
      }
      if (typeof sectionsHtml === "string" && sectionsHtml.trim()) {
        await writeFile(join(debugDir, `${safeStem}.sections.html`), sectionsHtml, "utf8");
      }
    } catch (error) {
      this.logger.warn(`Failed to write HTML-PPT debug artifact ${safeStem}: ${this.describeError(error)}`);
    }
  }

  private safePathSegment(value: string) {
    return (value || "unknown")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "unknown";
  }

  private sectionBatchConcurrency() {
    const configured = Number(process.env.HTML_PPT_BATCH_CONCURRENCY);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.min(3, Math.max(1, Math.floor(configured)));
    }
    return 2;
  }

  private async mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const limit = Math.max(1, Math.min(concurrency, items.length || 1));

    await Promise.all(
      Array.from({ length: limit }, async () => {
        while (nextIndex < items.length) {
          const current = nextIndex;
          nextIndex += 1;
          const item = items[current];
          if (item === undefined) break;
          results[current] = await worker(item, current);
        }
      })
    );

    return results;
  }

  private async generateSectionContentForBatch(input: {
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    visual: VisualPlan;
    research: ResearchPack;
    batch: AgentPlan["slides"];
    batchVisuals: VisualPlan["slideVisuals"];
    skill: SkillPack;
    onCall: () => void;
    priorFailures?: string[];
    logContextBase?: ModelLogContext;
    batchIndex: number;
  }): Promise<SectionContentPlan> {
    const { activeConfig, agentInput, plan, visual, research, batch, batchVisuals, skill, onCall, priorFailures = [], logContextBase, batchIndex } = input;
    const prompt = buildPrompt("section-content", {
      input: agentInput,
      userContextText: this.userContext(agentInput),
      skill,
      assetManifest: skill.manifest,
      plan,
      visual,
      research,
      batch,
      batchVisuals,
      priorFailures
    });

    try {
      const drafted = await this.modelStructured(
        activeConfig,
        sectionContentSchema,
        structuredOutputSchemaHints.sectionContent,
        prompt.system,
        prompt.user,
        onCall,
        {
          ...(logContextBase ?? {}),
          source: logContextBase?.source ?? "html-ppt-agent",
          stage: `05-generate-index:batch-${batchIndex + 1}-content`
        }
      );
      return this.normalizeSectionContentPlan(drafted, batch);
    } catch (error) {
      this.logger.warn(`HTML-PPT section content drafting failed for batch ${batchIndex + 1}; using plan fallback. error=${this.describeError(error)}`);
      await this.writeHtmlPptDebugArtifact(agentInput, `batch-${batchIndex + 1}-content-fallback`, {
        stage: "05-generate-index",
        attempt: "section-content-fallback",
        batchIndex,
        slideIndexes: batch.map((slide) => slide.index),
        layoutIds: batch.map((slide) => slide.layoutId),
        qaIssues: [`section-content failed: ${this.describeError(error)}`],
        hardIssues: [],
        softIssues: []
      });
      return this.fallbackSectionContentPlan(batch);
    }
  }

  private normalizeSectionContentPlan(input: SectionContentPlan, batch: AgentPlan["slides"]): SectionContentPlan {
    const byIndex = new Map((input.slides ?? []).map((slide) => [slide.index, slide]));
    return {
      slides: batch.map((planned) => {
        const current = byIndex.get(planned.index);
        if (!current) return this.fallbackSectionContentSlide(planned);
        return {
          index: planned.index,
          title: planned.title,
          layoutId: planned.layoutId,
          kicker: this.trimOptionalText(current.kicker, 80),
          h1: this.trimOptionalText(current.h1, 120) ?? planned.title,
          h2: this.trimOptionalText(current.h2, 120) ?? planned.title,
          lede: this.trimOptionalText(current.lede, 260),
          bullets: this.normalizeTextList(current.bullets, 10, 180),
          cards: (current.cards ?? [])
            .map((card) => ({
              title: this.str(card.title, "").slice(0, 80),
              body: this.str(card.body, "").slice(0, 220),
              ...(this.opt(card.tag) ? { tag: this.opt(card.tag)?.slice(0, 40) } : {})
            }))
            .filter((card) => card.title && card.body)
            .slice(0, 8),
          metrics: (current.metrics ?? [])
            .map((metric) => ({
              label: this.str(metric.label, "").slice(0, 60),
              value: this.str(metric.value, "").slice(0, 40),
              ...(this.opt(metric.note) ? { note: this.opt(metric.note)?.slice(0, 120) } : {})
            }))
            .filter((metric) => metric.label && metric.value)
            .slice(0, 8),
          footer: this.trimOptionalText(current.footer, 100)
        };
      })
    };
  }

  private fallbackSectionContentPlan(batch: AgentPlan["slides"]): SectionContentPlan {
    return { slides: batch.map((slide) => this.fallbackSectionContentSlide(slide)) };
  }

  private fallbackSectionContentSlide(slide: AgentPlan["slides"][number]): SectionContentPlan["slides"][number] {
    const points = slide.keyPoints.length ? slide.keyPoints : [slide.goal || slide.title];
    return {
      index: slide.index,
      title: slide.title,
      layoutId: slide.layoutId,
      kicker: `${String(slide.index).padStart(2, "0")} · ${slide.type}`,
      h1: slide.title,
      h2: slide.title,
      lede: slide.goal || points[0],
      bullets: points.slice(0, 6),
      cards: points.slice(0, 4).map((point, index) => ({
        title: point.length > 28 ? `${point.slice(0, 26)}…` : point,
        body: point,
        tag: String(index + 1).padStart(2, "0")
      })),
      metrics: [],
      footer: ""
    };
  }

  private normalizeTextList(items: string[] | undefined, maxItems: number, maxLength: number) {
    return (items ?? [])
      .map((item) => this.str(item, "").replace(/\s+/g, " ").trim().slice(0, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  private trimOptionalText(value: string | undefined, maxLength: number) {
    const text = this.str(value, "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, maxLength) : undefined;
  }

  private async processSectionBatch(input: {
    batch: AgentPlan["slides"];
    batchIndex: number;
    activeConfig: ActiveModelConfig;
    input: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    deckStyle: DeckStyleProfile;
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    onCall: () => void;
    reserveRepairCall: (label: string, issues: string[]) => void;
    priorFailures?: string[];
    logContextBase?: ModelLogContext;
    resumeSnapshot?: HtmlPptAgentBatchSnapshot;
  }) {
    const { batch, batchIndex, activeConfig, input: agentInput, plan, deckStyle, visual, research, skill, referenceFullDeck, onCall, reserveRepairCall, priorFailures = [], logContextBase, resumeSnapshot } = input;
    const batchIndexes = new Set(batch.map((slide) => slide.index));
    const batchVisuals = visual.slideVisuals.filter((item) => batchIndexes.has(item.index));
    const layoutTemplates = await this.readLayoutTemplates(skill.root, batch.map((slide) => slide.layoutId));
    const sectionClassProtocol = this.buildSectionClassProtocol({
      layoutTemplates,
      referenceFullDeck,
      skill
    });
    const sectionContent = await this.generateSectionContentForBatch({
      activeConfig,
      agentInput,
      plan,
      visual,
      research,
      batch,
      batchVisuals,
      skill,
      onCall,
      priorFailures,
      logContextBase,
      batchIndex
    });
    const prompt = buildPrompt("section-batch", {
      input: agentInput,
      userContextText: this.userContext(agentInput),
      skill,
      assetManifest: skill.manifest,
      plan,
      visual,
      research,
      batch,
      batchVisuals,
      sectionContent,
      layoutTemplates,
      referenceFullDeck,
      allowedClassCatalog: sectionClassProtocol.promptCatalog,
      priorFailures
    });

    let sections = "";
    let localRepairCount = 0;
    let qa: BatchQaResult;
    let modelRepairCalls = 0;
    const resumeSlideIssues = resumeSnapshot?.slideIssues?.length ? resumeSnapshot.slideIssues : [];
    if (resumeSnapshot && this.isCompatibleBatchSnapshot(resumeSnapshot, batch) && resumeSnapshot.sections.trim()) {
      const resumedSanitized = this.sanitizeSectionBatchMarkup(
        resumeSnapshot.sections,
        batch,
        sectionClassProtocol.allowedClasses,
        sectionClassProtocol.referenceContract,
        sectionClassProtocol.donorContract
      );
      sections = resumedSanitized.html;
      localRepairCount = resumedSanitized.localRepairCount;
      qa = this.validateSectionBatch(sections, batch, skill, plan, deckStyle, sectionClassProtocol.donorContract);
    } else {
      const raw = await this.modelText(activeConfig, prompt.system, prompt.user, onCall, {
        ...(logContextBase ?? {}),
        source: logContextBase?.source ?? "html-ppt-agent",
        stage: `05-generate-index:batch-${batchIndex + 1}-draft`
      });
      const initialSanitized = this.sanitizeSectionBatchMarkup(
        this.extractSlideSections(raw),
        batch,
        sectionClassProtocol.allowedClasses,
        sectionClassProtocol.referenceContract,
        sectionClassProtocol.donorContract
      );
      sections = initialSanitized.html;
      localRepairCount = initialSanitized.localRepairCount;
      qa = this.validateSectionBatch(sections, batch, skill, plan, deckStyle, sectionClassProtocol.donorContract);
      if (qa.issues.length > 0) {
        await this.writeHtmlPptDebugArtifact(agentInput, `batch-${batchIndex + 1}-attempt-1-draft`, {
          stage: "05-generate-index",
          attempt: "draft",
          batchIndex,
          slideIndexes: batch.map((slide) => slide.index),
          layoutIds: batch.map((slide) => slide.layoutId),
          qaIssues: qa.issues,
          hardIssues: qa.hardIssues,
          softIssues: qa.softIssues,
          rawHtml: raw,
          sectionsHtml: sections
        });
      }
    }

    if (qa.issues.length > 0) {
      if (qa.hardIssues.length > 0 && resumeSlideIssues.length > 0) {
        const targeted = await this.repairIssueSlidesInBatch({
          activeConfig,
          agentInput,
          plan,
          visual,
          research,
          skill,
          referenceFullDeck,
          batch,
          batchVisuals,
          sections,
          issueGroups: this.mergeSlideIssueGroups(batch, resumeSlideIssues, this.groupIssuesBySlide(qa.hardIssues, batch)),
          sectionClassProtocol,
          deckStyle,
          onCall,
          reserveRepairCall,
          priorFailures,
          logContextBase
        });
        sections = targeted.sections;
        localRepairCount += targeted.localRepairCount;
        modelRepairCalls += targeted.modelRepairCalls;
        qa = targeted.qa;
      }

      if (qa.hardIssues.length === 0) {
        const softened = this.applySoftDensityRepair({
          sections,
          batch,
          skill,
          plan,
          deckStyle,
          donorContract: sectionClassProtocol.donorContract,
          qa
        });
        sections = softened.sections;
        localRepairCount += softened.changedCount;
        qa = softened.qa;
      }

      if (qa.hardIssues.length > 0) {
        reserveRepairCall("分批生成", qa.hardIssues);
        modelRepairCalls += 1;
        const repairRaw = await this.modelText(
          activeConfig,
          prompt.system,
          [
            prompt.user,
            "",
            "上一版 section 没有通过本地 QA，请按问题重写这一批 section。",
            "只输出修复后的 <section class=\"slide\"> 片段，页数和顺序必须不变。",
            "如果某个 metric-label / metric-sm / caption / meta 节点没有内容，就直接删除该节点，不要保留空占位符。",
            "QA 问题：",
            qa.issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n"),
            "",
            `上一版 section:\n${sections}`
          ].join("\n"),
          onCall,
          {
            ...(logContextBase ?? {}),
            source: logContextBase?.source ?? "html-ppt-agent",
            stage: `05-generate-index:batch-${batchIndex + 1}-repair`
          }
        );
        const repairedSanitized = this.sanitizeSectionBatchMarkup(
          this.extractSlideSections(repairRaw),
          batch,
          sectionClassProtocol.allowedClasses,
          sectionClassProtocol.referenceContract,
          sectionClassProtocol.donorContract
        );
        let repaired = repairedSanitized.html;
        localRepairCount += repairedSanitized.localRepairCount;
        let repairedQa = this.validateSectionBatch(repaired, batch, skill, plan, deckStyle, sectionClassProtocol.donorContract);
        let issuesBySlide = this.groupIssuesBySlide(
          repairedQa.hardIssues.length > 0 ? repairedQa.hardIssues : repairedQa.issues,
          batch
        );
        if (repairedQa.issues.length > 0) {
          await this.writeHtmlPptDebugArtifact(agentInput, `batch-${batchIndex + 1}-attempt-2-repair`, {
            stage: "05-generate-index",
            attempt: "repair",
            batchIndex,
            slideIndexes: batch.map((slide) => slide.index),
            layoutIds: batch.map((slide) => slide.layoutId),
            qaIssues: repairedQa.issues,
            hardIssues: repairedQa.hardIssues,
            softIssues: repairedQa.softIssues,
            rawHtml: repairRaw,
            sectionsHtml: repaired
          });
        }

        if (repairedQa.hardIssues.length > 0) {
          issuesBySlide = this.groupIssuesBySlide(repairedQa.hardIssues, batch);
          const targeted = await this.repairIssueSlidesInBatch({
            activeConfig,
            agentInput,
            plan,
            visual,
            research,
            skill,
            referenceFullDeck,
            batch,
            batchVisuals,
            sections: repaired,
            issueGroups: issuesBySlide,
            sectionClassProtocol,
            deckStyle,
            onCall,
            reserveRepairCall,
            priorFailures,
            logContextBase
          });
          repaired = targeted.sections;
          repairedQa = targeted.qa;
          localRepairCount += targeted.localRepairCount;
          modelRepairCalls += targeted.modelRepairCalls;
        }

        if (repairedQa.hardIssues.length === 0 && repairedQa.softIssues.length > 0) {
          const softened = this.applySoftDensityRepair({
            sections: repaired,
            batch,
            skill,
            plan,
            deckStyle,
            donorContract: sectionClassProtocol.donorContract,
            qa: repairedQa
          });
          repaired = softened.sections;
          localRepairCount += softened.changedCount;
          repairedQa = softened.qa;
          issuesBySlide = this.groupIssuesBySlide(repairedQa.issues, batch);
        }

        if (repairedQa.hardIssues.length > 0) {
          await this.writeHtmlPptDebugArtifact(agentInput, `batch-${batchIndex + 1}-final-failure`, {
            stage: "05-generate-index",
            attempt: "final-failure",
            batchIndex,
            slideIndexes: batch.map((slide) => slide.index),
            layoutIds: batch.map((slide) => slide.layoutId),
            qaIssues: repairedQa.issues,
            hardIssues: repairedQa.hardIssues,
            softIssues: repairedQa.softIssues,
            sectionsHtml: repaired
          });
          throw new HtmlPptAgentBatchError(`index.html 分批生成 QA 未通过：${repairedQa.issues.join("；")}`, {
            batchIndex,
            slideIndexes: batch.map((slide) => slide.index),
            layoutIds: batch.map((slide) => slide.layoutId),
            densityBudget: batch.reduce((sum, slide) => sum + this.slideDensityBudget(slide, skill), 0),
            sections: repaired,
            qaIssues: repairedQa.issues,
            slideIssues: issuesBySlide.map((item) => ({
              slideIndex: item.slideIndex,
              batchOffset: item.batchOffset,
              issues: item.issues
            }))
          });
        }
        sections = repaired;
      }
    }

    return {
      batchIndex,
      sections,
      slideIndexes: batch.map((slide) => slide.index),
      layoutIds: batch.map((slide) => slide.layoutId),
      densityBudget: batch.reduce((sum, slide) => sum + this.slideDensityBudget(slide, skill), 0),
      modelRepairCalls,
      localRepairCount
    };
  }

  private mergeSlideIssueGroups(
    batch: AgentPlan["slides"],
    primary: HtmlPptAgentFailedSlideIssue[],
    secondary: HtmlPptAgentFailedSlideIssue[]
  ): HtmlPptAgentFailedSlideIssue[] {
    const merged = new Map<number, HtmlPptAgentFailedSlideIssue>();
    for (const issueGroup of [...primary, ...secondary]) {
      const batchOffset =
        Number.isInteger(issueGroup.batchOffset) && issueGroup.batchOffset >= 0
          ? issueGroup.batchOffset
          : batch.findIndex((slide) => slide.index === issueGroup.slideIndex);
      if (batchOffset < 0) continue;
      const existing = merged.get(issueGroup.slideIndex);
      if (!existing) {
        merged.set(issueGroup.slideIndex, {
          slideIndex: issueGroup.slideIndex,
          batchOffset,
          issues: Array.from(new Set(issueGroup.issues))
        });
        continue;
      }
      existing.batchOffset = batchOffset;
      existing.issues = Array.from(new Set([...existing.issues, ...issueGroup.issues]));
    }
    return Array.from(merged.values()).sort((a, b) => a.batchOffset - b.batchOffset);
  }

  private async repairIssueSlidesInBatch(input: {
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    batch: AgentPlan["slides"];
    batchVisuals: VisualPlan["slideVisuals"];
    sections: string;
    issueGroups: HtmlPptAgentFailedSlideIssue[];
    sectionClassProtocol: {
      allowedClasses: Set<string>;
      promptCatalog: string;
      referenceContract?: ReferenceComponentContract;
      donorContract?: DonorTemplateContract;
    };
    deckStyle: DeckStyleProfile;
    onCall: () => void;
    reserveRepairCall: (label: string, issues: string[]) => void;
    priorFailures?: string[];
    logContextBase?: ModelLogContext;
  }) {
    const {
      activeConfig,
      agentInput,
      plan,
      visual,
      research,
      skill,
      referenceFullDeck,
      batch,
      batchVisuals,
      sections,
      issueGroups,
      sectionClassProtocol,
      deckStyle,
      onCall,
      reserveRepairCall,
      priorFailures = [],
      logContextBase
    } = input;
    const repairedSections = this.extractSectionList(sections);
    let localRepairCount = 0;
    let modelRepairCalls = 0;

    for (const issueGroup of issueGroups) {
      const slide = batch.find((item) => item.index === issueGroup.slideIndex);
      if (!slide) continue;

      modelRepairCalls += 1;
      const singleRaw = await this.repairSingleSlideFromSkeleton({
        activeConfig,
        agentInput,
        plan,
        visual,
        research,
        skill,
        referenceFullDeck,
        slide,
        slideVisual: batchVisuals.find((item) => item.index === slide.index),
        previousSection: repairedSections[issueGroup.batchOffset] ?? "",
        issues: issueGroup.issues,
        allowedClassCatalog: sectionClassProtocol.promptCatalog,
        onCall,
        reserveRepairCall,
        priorFailures,
        logContextBase
      });
      const sanitizedSingle = this.sanitizeSectionBatchMarkup(
        this.extractSlideSections(singleRaw),
        [slide],
        sectionClassProtocol.allowedClasses,
        sectionClassProtocol.referenceContract,
        sectionClassProtocol.donorContract
      );
      localRepairCount += sanitizedSingle.localRepairCount;
      const singleSections = this.extractSectionList(sanitizedSingle.html);
      const repairedSection = singleSections[0];
      if (singleSections.length !== 1 || !repairedSection) continue;
      const singleQa = this.validateSectionBatch(repairedSection, [slide], skill, plan, deckStyle, sectionClassProtocol.donorContract);
      if (singleQa.hardIssues.length === 0) {
        repairedSections[issueGroup.batchOffset] = repairedSection;
      }
    }

    const nextSections = repairedSections.join("\n\n");
    return {
      sections: nextSections,
      qa: this.validateSectionBatch(nextSections, batch, skill, plan, deckStyle, sectionClassProtocol.donorContract),
      localRepairCount,
      modelRepairCalls
    };
  }

  private truncateBatchSectionsToDensityBudget(
    sectionsHtml: string,
    batch: AgentPlan["slides"],
    skill: SkillPack,
    plan?: AgentPlan,
    deckStyle: DeckStyleProfile = "balanced"
  ) {
    const sections = this.extractSectionList(sectionsHtml);
    let changedCount = 0;
    const nextSections = sections.map((section, index) => {
      const slide = batch[index];
      if (!slide) return section;
      const truncated = this.truncateSectionToDensityBudget(section, slide, skill, plan, deckStyle);
      if (truncated !== section) {
        changedCount += 1;
      }
      return truncated;
    });
    return {
      sections: nextSections.join("\n\n"),
      changedCount
    };
  }

  private applySoftDensityRepair(input: {
    sections: string;
    batch: AgentPlan["slides"];
    skill: SkillPack;
    plan?: AgentPlan;
    deckStyle: DeckStyleProfile;
    donorContract?: DonorTemplateContract;
    qa: BatchQaResult;
  }) {
    if (
      input.qa.hardIssues.length > 0 ||
      input.qa.softIssues.length === 0 ||
      !this.shouldTruncateForSoftIssues(input.qa.softIssues)
    ) {
      return { sections: input.sections, qa: input.qa, changedCount: 0 };
    }

    const truncated = this.truncateBatchSectionsToDensityBudget(
      input.sections,
      input.batch,
      input.skill,
      input.plan,
      input.deckStyle
    );

    if (truncated.changedCount === 0) {
      return { sections: input.sections, qa: input.qa, changedCount: 0 };
    }

    const nextQa = this.validateSectionBatch(
      truncated.sections,
      input.batch,
      input.skill,
      input.plan,
      input.deckStyle,
      input.donorContract
    );

    if (nextQa.hardIssues.length > 0) {
      this.logger.warn(`Soft density truncation introduced hard issues; keeping original sections. issues=${nextQa.hardIssues.join(" | ")}`);
      return { sections: input.sections, qa: input.qa, changedCount: 0 };
    }

    return { sections: truncated.sections, qa: nextQa, changedCount: truncated.changedCount };
  }

  private shouldTruncateForSoftIssues(issues: string[]) {
    if (issues.length === 0) return false;
    const densitySignals = issues.filter((issue) =>
      /(可见文字|横版预算|估算会超出|正文|文本|字数|标题.*超过|line-height|overflow)/i.test(issue)
    );
    if (densitySignals.length === 0) return false;

    const structureOnlySignals = issues.every((issue) =>
      /(卡片\/面板|指标元素|布局声明为横向结构|少于布局建议下限|超过布局健全性上限)/.test(issue)
    );
    return !structureOnlySignals;
  }

  private async repairSingleSlideFromSkeleton(input: {
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    slide: AgentPlan["slides"][number];
    slideVisual?: VisualPlan["slideVisuals"][number];
    previousSection: string;
    issues: string[];
    allowedClassCatalog?: string;
    onCall: () => void;
    reserveRepairCall: (label: string, issues: string[]) => void;
    priorFailures?: string[];
    logContextBase?: ModelLogContext;
  }) {
    const { activeConfig, agentInput, plan, visual, research, skill, referenceFullDeck, slide, slideVisual, previousSection, issues, allowedClassCatalog, onCall, reserveRepairCall, priorFailures = [], logContextBase } = input;
    const layoutTemplate = await this.readSingleLayoutTemplate(skill.root, slide.layoutId);
    const singlePrompt = buildPrompt("section-batch", {
      input: agentInput,
      userContextText: this.userContext(agentInput),
      skill,
      plan,
      visual,
      research,
      batch: [slide],
      batchVisuals: slideVisual ? [slideVisual] : [],
      layoutTemplates: `--- layoutId: ${slide.layoutId} ---\n${layoutTemplate}`,
      referenceFullDeck,
      allowedClassCatalog,
      priorFailures
    });
    const missingContent = this.describeMissingSlideContent(slide, previousSection);
    reserveRepairCall("单页骨架修复", issues);
    return this.modelText(
      activeConfig,
      singlePrompt.system,
      [
        singlePrompt.user,
        "",
        "只重写这一页，不要输出其它页。",
        "这不是自由创作，而是模板骨架修复。",
        "必须严格复用下面 layout template 的根节点、主要 class 名和层级骨架，只能在骨架内重填内容。",
        "不要新造 wrapper、不要新造指标占位结构、不要保留空白节点。",
        "",
        "layout template skeleton:",
        layoutTemplate,
        "",
        "上一版失败的 section:",
        previousSection || "(empty)",
        "",
        "缺失或偏离的内容要点：",
        missingContent.map((item, index) => `${index + 1}. ${item}`).join("\n"),
        "",
        "当前 QA 问题：",
        issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")
      ].join("\n"),
      onCall,
      {
        ...(logContextBase ?? {}),
        source: logContextBase?.source ?? "html-ppt-agent",
        stage: `05-generate-index:slide-${slide.index}-repair`
      }
    );
  }

  private async expandDeckNarrativeIfNeeded(input: {
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    deckStyle: DeckStyleProfile;
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    sections: string[];
    requestedChineseChars: number;
    onCall: () => void;
    logContextBase?: ModelLogContext;
  }) {
    const { activeConfig, agentInput, plan, deckStyle, visual, research, skill, referenceFullDeck, requestedChineseChars, onCall, logContextBase } = input;
    const sections = [...input.sections];
    let actualChineseChars = this.sumSectionsChineseChars(sections);
    const minGapToExpand = Math.max(60, Math.round(requestedChineseChars * 0.08));
    if (actualChineseChars >= requestedChineseChars - minGapToExpand) {
      return { sections, actualChineseChars, addedChineseChars: 0, expandedSlides: [] as number[] };
    }

    const perSlideTargets = new Map(research.perSlideLengthTargets.map((item) => [item.index, item.targetLength]));
    const candidates = plan.slides
      .map((slide, index) => {
        const section = sections[index] ?? "";
        const currentChineseChars = this.visibleSectionChineseChars(section);
        const targetChineseChars = Math.max(currentChineseChars + 40, perSlideTargets.get(slide.index) ?? currentChineseChars);
        return {
          slide,
          index,
          section,
          currentChineseChars,
          targetChineseChars,
          gap: Math.max(0, targetChineseChars - currentChineseChars)
        };
      })
      .filter((item) => item.section && !this.isNarrativeLightLayout(item.slide.layoutId))
      .filter((item) => item.gap >= 40)
      .sort((a, b) => b.gap - a.gap || a.currentChineseChars - b.currentChineseChars);

    const expandedSlides: number[] = [];
    let addedChineseChars = 0;
    for (const candidate of candidates.slice(0, 4)) {
      const remainingGap = requestedChineseChars - actualChineseChars;
      if (remainingGap <= 30) break;

      const layoutTemplate = await this.readSingleLayoutTemplate(skill.root, candidate.slide.layoutId);
      const sectionClassProtocol = this.buildSectionClassProtocol({
        layoutTemplates: `--- layoutId: ${candidate.slide.layoutId} ---\n${layoutTemplate}`,
        referenceFullDeck,
        skill
      });
      const desiredExtraChineseChars = Math.max(40, Math.min(140, remainingGap, candidate.gap));
      const expandedRaw = await this.expandSingleSlideNarrativeFromSkeleton({
        activeConfig,
        agentInput,
        plan,
        visual,
        research,
        skill,
        referenceFullDeck,
        slide: candidate.slide,
        slideVisual: visual.slideVisuals.find((item) => item.index === candidate.slide.index),
        previousSection: candidate.section,
        currentChineseChars: candidate.currentChineseChars,
        targetChineseChars: candidate.targetChineseChars,
        desiredExtraChineseChars,
        allowedClassCatalog: sectionClassProtocol.promptCatalog,
        onCall,
        logContextBase
      }).catch(() => "");
      if (!expandedRaw) continue;

      const sanitized = this.sanitizeSectionBatchMarkup(
        this.extractSlideSections(expandedRaw),
        [candidate.slide],
        sectionClassProtocol.allowedClasses,
        sectionClassProtocol.referenceContract,
        sectionClassProtocol.donorContract
      );
      const singleSections = this.extractSectionList(sanitized.html);
      const nextSection = singleSections[0];
      if (singleSections.length !== 1 || !nextSection) continue;
      const nextQa = this.validateSectionBatch(nextSection, [candidate.slide], skill, plan, deckStyle, sectionClassProtocol.donorContract);
      if (nextQa.issues.length > 0) continue;
      if (this.estimateLandscapeFitIssues(nextSection, candidate.slide, skill, plan, deckStyle).length > 0) continue;

      const nextChineseChars = this.visibleSectionChineseChars(nextSection);
      const gained = nextChineseChars - candidate.currentChineseChars;
      if (gained < 24) continue;

      sections[candidate.index] = nextSection;
      actualChineseChars += gained;
      addedChineseChars += gained;
      expandedSlides.push(candidate.slide.index);
    }

    return { sections, actualChineseChars, addedChineseChars, expandedSlides };
  }

  private async expandSingleSlideNarrativeFromSkeleton(input: {
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    plan: AgentPlan;
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    referenceFullDeck?: ReferenceFullDeckSnippet;
    slide: AgentPlan["slides"][number];
    slideVisual?: VisualPlan["slideVisuals"][number];
    previousSection: string;
    currentChineseChars: number;
    targetChineseChars: number;
    desiredExtraChineseChars: number;
    allowedClassCatalog?: string;
    onCall: () => void;
    logContextBase?: ModelLogContext;
  }) {
    const {
      activeConfig,
      agentInput,
      plan,
      visual,
      research,
      skill,
      referenceFullDeck,
      slide,
      slideVisual,
      previousSection,
      currentChineseChars,
      targetChineseChars,
      desiredExtraChineseChars,
      allowedClassCatalog,
      onCall,
      logContextBase
    } = input;
    const layoutTemplate = await this.readSingleLayoutTemplate(skill.root, slide.layoutId);
    const singlePrompt = buildPrompt("section-batch", {
      input: agentInput,
      userContextText: this.userContext(agentInput),
      skill,
      plan,
      visual,
      research,
      batch: [slide],
      batchVisuals: slideVisual ? [slideVisual] : [],
      layoutTemplates: `--- layoutId: ${slide.layoutId} ---\n${layoutTemplate}`,
      referenceFullDeck,
      allowedClassCatalog
    });

    return this.modelText(
      activeConfig,
      singlePrompt.system,
      [
        singlePrompt.user,
        "",
        "这是非阻塞正文补量任务，只重写这一页。",
        "严格保留现有 layout skeleton、主要 class 名、卡片数量和顶层层级；不要新造 wrapper，不要改变标题，不要加入 notes。",
        `当前这一页可见中文约 ${currentChineseChars} 字；目标约 ${targetChineseChars} 字；请新增约 ${desiredExtraChineseChars} 字的可见中文正文。`,
        "优先扩写现有段落、列表句子、说明文字、对比解释或图注，不要把短语堆成更多碎片词组。",
        "如果页面空间有限，优先补足已有要点的解释深度，而不是增加新的装饰组件。",
        "",
        "当前页面 HTML:",
        previousSection
      ].join("\n"),
      onCall,
      {
        ...(logContextBase ?? {}),
        source: logContextBase?.source ?? "html-ppt-agent",
        stage: `05-generate-index:slide-${slide.index}-expand`
      }
    );
  }

  private describeMissingSlideContent(slide: AgentPlan["slides"][number], previousSection: string) {
    const visibleText = this.normalizeComparableText(this.visibleSlideText(previousSection));
    const missing = slide.keyPoints
      .map((point) => point.trim())
      .filter(Boolean)
      .filter((point) => !visibleText.includes(this.normalizeComparableText(point)));
    const guidance = [
      slide.goal?.trim() ? `Preserve the page goal: ${slide.goal.trim()}` : "",
      missing.length > 0 ? `Reintroduce these missing key points: ${missing.join(" | ")}` : "Keep all key points visible within the 16:9 viewport.",
      `Keep page title aligned with: ${slide.title}`
    ].filter(Boolean);
    return guidance;
  }

  private normalizeComparableText(value: string) {
    return value
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .trim();
  }

  private slideDensityBudget(slide: AgentPlan["slides"][number], skill: SkillPack) {
    const layout = (skill.manifest?.layouts ?? []).find((item) => item.id === slide.layoutId);
    return Math.max(180, layout?.densityBudget?.maxBodyCharsTotal ?? 420);
  }

  private stripEmptyLeafPlaceholderNodes(section: string) {
    return section.replace(
      /<(div|span|p|li)\b([^>]*class=["'][^"']*\b(?:metric-label|metric-sm|metric-sub|metric-meta|kpi-label|kpi-meta|caption|sub-label|meta)\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi,
      (match, _tag: string, _attrs: string, inner: string) => {
        if (/<[a-z][^>]*>/i.test(inner)) return match;
        const text = inner.replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
        return text ? match : "";
      }
    );
  }

  private groupIssuesBySlide(issues: string[], batch: AgentPlan["slides"]) {
    const grouped = new Map<number, { slideIndex: number; batchOffset: number; issues: string[] }>();
    for (const issue of issues) {
      const match = issue.match(/^第\s+(\d+)\s+页/);
      if (!match) continue;
      const slideIndex = Number(match[1]);
      const batchOffset = batch.findIndex((item) => item.index === slideIndex);
      if (batchOffset < 0) continue;
      const existing = grouped.get(slideIndex);
      if (existing) {
        existing.issues.push(issue);
        continue;
      }
      grouped.set(slideIndex, { slideIndex, batchOffset, issues: [issue] });
    }
    return Array.from(grouped.values()).sort((a, b) => a.batchOffset - b.batchOffset);
  }

  private validateSectionBatch(
    sectionsHtml: string,
    batch: AgentPlan["slides"],
    skill?: SkillPack,
    plan?: AgentPlan,
    deckStyle: DeckStyleProfile = "balanced",
    donorContract?: DonorTemplateContract
  ): BatchQaResult {
    const sections = sectionsHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    const hardIssues: string[] = [];
    const softIssues: string[] = [];
    const pushHard = (message: string) => hardIssues.push(message);
    const pushSoft = (message: string) => softIssues.push(message);

    if (sections.length !== batch.length) {
      pushHard(`本批应返回 ${batch.length} 页，实际返回 ${sections.length} 页`);
    }

    sections.forEach((section, index) => {
      const slide = batch[index];
      const label = slide ? `第 ${slide.index} 页(${slide.layoutId})` : `第 ${index + 1} 个 section`;
      const layout = slide ? (skill?.manifest?.layouts ?? []).find((item) => item.id === slide.layoutId) : undefined;
      const visibleText = this.visibleSlideText(section);
      const styleCount = (section.match(/\sstyle=/gi) ?? []).length;
      const sectionChars = section.length;
      const isClosing = slide ? ["cta", "thanks"].includes(slide.layoutId) : false;
      const maxVisibleChars = isClosing ? 620 : 820;
      const maxSectionChars = isClosing ? 7200 : 9500;

      if (!/\bdata-title=/.test(section)) pushHard(`${label} 缺少 data-title`);
      if (/<section\b[^>]*\sdata-anim=/i.test(section)) pushHard(`${label} data-anim 不应写在 slide 根节点，会导致非当前页可见`);
      if (/<(?:div|aside)\b[^>]*class=["'][^"']*\bnotes\b/i.test(section)) pushHard(`${label} 含 notes/逐字稿，请删除 notes 并只保留观众可见内容`);
      if (visibleText.length > maxVisibleChars) pushSoft(`${label} 可见文字 ${visibleText.length} 字，超过 ${maxVisibleChars}，请压缩为短标题、指标、卡片和对比关系`);
      if (sectionChars > maxSectionChars) pushSoft(`${label} HTML ${sectionChars} 字符，超过 ${maxSectionChars}，页面结构过重，容易纵向溢出`);
      if (styleCount > 12) pushSoft(`${label} inline style 数量 ${styleCount}，超过 12，说明偏离模板骨架`);
      if (/<[^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*\sdata-fx=/i.test(section)) pushHard(`${label} 指标数字不应使用 data-fx，会产生数字层遮挡`);
      const blockedFx = this.findBlockedFxValues(section);
      if (blockedFx.length > 0) pushHard(`${label} 使用了黑名单特效：${blockedFx.join(", ")}`);
      const badNumLabels = this.findNonNumericNumLabels(section);
      if (badNumLabels.length > 0) pushHard(`${label} .num 数字徽标被用于非数字文本：${badNumLabels.slice(0, 3).join(", ")}`);
      if (/<script\b/gi.test(section) && !/<canvas\b/i.test(section)) pushHard(`${label} 含 script 但不是 chart canvas 场景，请移除脚本`);
      if (/<canvas\b/i.test(section) && slide && !slide.layoutId.startsWith("chart-")) pushHard(`${label} 非 chart layout 不应使用 canvas`);

      const emptyBlocks = this.findEmptyContentBlocks(section);
      if (emptyBlocks.length > 0) {
        pushHard(`${label} 存在空白内容块：${emptyBlocks.slice(0, 3).join(", ")}`);
      }

      const nestingIssues = this.findSectionNestingIssues(section);
      if (nestingIssues.length > 0) {
        pushHard(`${label} HTML 标签嵌套异常：${nestingIssues.slice(0, 3).join("；")}`);
      }

      const incompleteCards = layout?.sanity?.wantsCardBody === false ? [] : this.findIncompleteSiblingCards(section);
      if (incompleteCards.length > 0) {
        pushHard(`${label} 存在缺少说明正文的卡片：${incompleteCards.slice(0, 3).join(", ")}`);
      }

      if (layout?.sanity) {
        const sanityIssues = this.findLayoutSanityIssues(section, layout.sanity);
        for (const issue of sanityIssues.hardIssues) pushHard(`${label} ${issue}`);
        for (const issue of sanityIssues.softIssues) pushSoft(`${label} ${issue}`);
      }

      const runtimeHints = this.findVisibleRuntimeInstructionHints(section);
      if (runtimeHints.length > 0) {
        pushHard(`${label} 含可见运行时/快捷键说明：${runtimeHints.slice(0, 3).join(", ")}`);
      }

      const forbiddenText = this.findForbiddenDonorText(section, donorContract);
      if (forbiddenText.length > 0) {
        pushHard(`${label} 含 donor 模板占位文本：${forbiddenText.slice(0, 4).join(", ")}`);
      }

      if (slide && skill) {
        const fitIssues = this.estimateLandscapeFitIssues(section, slide, skill, plan, deckStyle);
        for (const issue of fitIssues) {
          pushSoft(`${label} ${issue}`);
        }
      }
    });

    const uniqueHard = Array.from(new Set(hardIssues));
    const uniqueSoft = Array.from(new Set(softIssues.map((item) => item.trim()).filter(Boolean)));
    return {
      issues: [...uniqueHard, ...uniqueSoft],
      hardIssues: uniqueHard,
      softIssues: uniqueSoft
    };
  }

  private visibleSlideText(section: string) {
    return this.stripNotesBlocks(section)
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private findForbiddenDonorText(section: string, donorContract?: DonorTemplateContract) {
    const text = this.visibleSlideText(section);
    if (!text) return [];
    const hits: string[] = [];
    const universalPatterns: Array<[RegExp, string]> = [
      [/\[(?:KICKER|H1|H2|H3|BODY|BULLET|FOOTER|LABEL|TITLE|SUBTITLE|METRIC)\]/iu, "semantic placeholder"]
    ];
    for (const [pattern, label] of universalPatterns) {
      const match = text.match(pattern)?.[0];
      if (match) hits.push(`${label}:${match}`);
    }
    if (!donorContract?.forbiddenTextPatterns?.length) return Array.from(new Set(hits));
    for (const pattern of donorContract.forbiddenTextPatterns) {
      try {
        const re = new RegExp(pattern, "iu");
        const match = text.match(re)?.[0];
        if (match) hits.push(match);
      } catch {
        if (text.toLowerCase().includes(pattern.toLowerCase())) {
          hits.push(pattern);
        }
      }
    }
    return Array.from(new Set(hits));
  }

  private findVisibleRuntimeInstructionHints(section: string) {
    const hits: string[] = [];
    const text = this.visibleSlideText(section);
    const patterns: Array<[RegExp, string]> = [
      [/方向键\s*[←→\s]*\s*切换/u, "方向键切换"],
      [/切换页面/u, "切换页面"],
      [/\bnavigate\b/iu, "navigate"],
      [/\bpress\s*(?:←|left)\b/iu, "press left"],
      [/\bpresenter\b/iu, "presenter"],
      [/\bfullscreen\b/iu, "fullscreen"]
    ];
    for (const [pattern, label] of patterns) {
      if (pattern.test(text)) hits.push(label);
    }
    if (/<(?:div|p|span|small)\b[^>]*class=["'][^"']*\b(?:dk-keyhint|keyhint|key-hint|keyboard-hint|shortcut-hint|nav-hint|runtime-hint)\b/i.test(section)) {
      hits.push("hint class");
    }
    if (/<kbd\b/i.test(section) && /(←|→|space|enter|navigate|presenter|fullscreen|方向键|切换)/i.test(text)) {
      hits.push("kbd shortcut");
    }
    return Array.from(new Set(hits));
  }

  private findSectionNestingIssues(section: string) {
    const issues: string[] = [];
    const stack: string[] = [];
    const structuralTags = new Set(["section", "div", "article", "header", "footer", "main", "nav", "aside", "ul", "ol"]);
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    const tagPattern = /<\/?([a-z0-9-]+)\b[^>]*>/gi;
    for (const match of section.matchAll(tagPattern)) {
      const raw = match[0] ?? "";
      const tag = (match[1] ?? "").toLowerCase();
      if (!tag || voidTags.has(tag) || !structuralTags.has(tag)) continue;
      if (/\/\s*>$/.test(raw)) continue;
      if (!raw.startsWith("</")) {
        stack.push(tag);
        continue;
      }

      const expected = stack.pop();
      if (expected !== tag) {
        issues.push(`遇到 </${tag}>，但当前期望关闭 ${expected ? `<${expected}>` : "空栈"}`);
        if (issues.length >= 5) break;
      }
    }
    if (stack.length > 0) {
      issues.push(`未闭合标签：${stack.slice(-5).map((tag) => `<${tag}>`).join(", ")}`);
    }
    return issues;
  }

  private stripNotesBlocks(html: string) {
    return html
      .replace(/<(?:div|aside)\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|aside)>/gi, "")
      .replace(/<!--\s*notes?[\s\S]*?-->/gi, "");
  }

  private stripUnsafeMetricFx(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*)>/gi,
      (_match, tag: string, attrs: string) => {
        const safeAttrs = attrs
          .replace(/\sdata-fx=["'][^"']+["']/gi, "")
          .replace(/\sdata-fx-to=["'][^"']+["']/gi, "");
        return `<${tag}${safeAttrs}>`;
      }
    );
  }

  private stripSectionRootAnimations(html: string) {
    return html.replace(
      /<section\b([^>]*)>/gi,
      (match, attrs: string) => {
        if (!/\bclass=(["'])[^"']*\bslide\b[^"']*\1/i.test(attrs) || !/\sdata-anim=/i.test(attrs)) return match;
        return `<section${attrs.replace(/\sdata-anim=(["'])[^"']+\1/gi, "")}>`;
      }
    );
  }

  private isBlockedFx(value: string) {
    return HtmlPptAgentService.BLOCKED_FX.has(value.trim().toLowerCase());
  }

  private findBlockedFxValues(html: string) {
    return Array.from(new Set(this.extractAttrValues(html, "data-fx").filter((value) => this.isBlockedFx(value))));
  }

  private stripBlockedFx(html: string) {
    let next = html.replace(
      /<div\b([^>]*class=(["'])[^"']*\bdeck-fx-layer\b[^"']*\2[^>]*)>\s*<\/div>/gi,
      (match, attrs: string) => {
        const fx = attrs.match(/\sdata-fx=(["'])([^"']+)\1/i)?.[2] ?? "";
        return this.isBlockedFx(fx) ? "" : match;
      }
    );

    next = next.replace(
      /\sdata-fx=(["'])([^"']+)\1/gi,
      (match, _quote: string, value: string) => (this.isBlockedFx(value) ? "" : match)
    );
    next = next.replace(
      /\sdata-fx-to=(["'])([^"']+)\1/gi,
      (match, _quote: string, value: string) => (this.isBlockedFx(value) ? "" : match)
    );
    return next;
  }

  private normalizeNonNumericNumClasses(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*\bclass=(["'])([^"']*\bnum\b[^"']*)\3[^>]*)>([\s\S]*?)<\/\1>/gi,
      (match, tag: string, attrs: string, _quote: string, classValue: string, inner: string) => {
        const text = this.visibleSlideText(inner);
        if (this.isNumericBadgeText(text)) return match;
        const nextClassValue = classValue
          .split(/\s+/)
          .filter((token) => token && token !== "num")
          .join(" ");
        const nextAttrs = nextClassValue
          ? attrs.replace(/\bclass=(["'])[^"']+\1/i, `class="${nextClassValue}"`)
          : attrs.replace(/\sclass=(["'])[^"']+\1/i, "");
        return `<${tag}${nextAttrs}>${inner}</${tag}>`;
      }
    );
  }

  private findNonNumericNumLabels(html: string) {
    const hits: string[] = [];
    html.replace(
      /<([a-z0-9-]+)\b[^>]*\bclass=(["'])[^"']*\bnum\b[^"']*\2[^>]*>([\s\S]*?)<\/\1>/gi,
      (_match, _tag: string, _quote: string, inner: string) => {
        const text = this.visibleSlideText(inner);
        if (text && !this.isNumericBadgeText(text)) hits.push(text.slice(0, 20));
        return "";
      }
    );
    return Array.from(new Set(hits));
  }

  private isNumericBadgeText(text: string) {
    const value = text.trim();
    if (!value) return true;
    return /^(?:\d{1,4}|[０-９]{1,4}|[一二三四五六七八九十百千万零〇]{1,6}|[IVXLCDM]{1,6}|[A-Z]{1,3})(?:[.)、])?$/iu.test(value);
  }

  private normalizeSectionFxLayers(html: string) {
    return html.replace(
      /<section\b([^>]*?)class=(["'])([^"']*\bslide\b[^"']*)\2([^>]*)>/gi,
      (match, before: string, quote: string, className: string, after: string) => {
        const attrs = `${before}class=${quote}${className}${quote}${after}`;
        const fxMatch = attrs.match(/\sdata-fx=(["'])([^"']+)\1/i);
        if (!fxMatch) return match;
        const fx = fxMatch[2] ?? "";
        if (this.isBlockedFx(fx)) {
          const cleanAttrs = attrs
            .replace(/\sdata-fx=(["'])[^"']+\1/gi, "")
            .replace(/\sdata-fx-to=(["'])[^"']+\1/gi, "");
          return `<section${cleanAttrs}>`;
        }
        const fxToMatch = attrs.match(/\sdata-fx-to=(["'])([^"']+)\1/i);
        const cleanAttrs = attrs
          .replace(/\sdata-fx=(["'])[^"']+\1/gi, "")
          .replace(/\sdata-fx-to=(["'])[^"']+\1/gi, "");
        const fxToAttr = fxToMatch?.[2] ? ` data-fx-to="${this.escapeAttr(fxToMatch[2])}"` : "";
        return `<section${cleanAttrs}><div class="deck-fx-layer" data-fx="${this.escapeAttr(fx)}"${fxToAttr} aria-hidden="true"></div>`;
      }
    );
  }

  private normalizeLargeStatNumberClasses(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*\bclass=(["'])([^"']*\bxw-num\b[^"']*)\3[^>]*\bstyle=(["'])([^"']*font-size\s*:\s*(\d+(?:\.\d+)?)px[^"']*)\5[^>]*)>/gi,
      (match, tag: string, attrs: string, _classQuote: string, classValue: string, _styleQuote: string, _styleValue: string, rawPx: string) => {
        const fontSize = Number(rawPx);
        if (!Number.isFinite(fontSize) || fontSize < 32) return match;
        const nextClassValue = classValue
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => (token === "xw-num" ? "xw-stat-num" : token))
          .join(" ");
        const nextAttrs = attrs.replace(/\bclass=(["'])[^"']+\1/i, `class="${nextClassValue}"`);
        return `<${tag}${nextAttrs}>`;
      }
    );
  }

  private normalizeInitialActiveSlide(html: string) {
    let firstSlide = true;
    return html.replace(
      /<section\b([^>]*?)class=(["'])([^"']*\bslide\b[^"']*)\2([^>]*)>/gi,
      (_match, before: string, quote: string, className: string, after: string) => {
        const classes = className
          .split(/\s+/)
          .filter(Boolean)
          .filter((name) => name !== "is-active" && name !== "is-prev" && name !== "is-next");
        if (firstSlide) {
          classes.push("is-active");
          firstSlide = false;
        }

        return `<section${before}class=${quote}${Array.from(new Set(classes)).join(" ")}${quote}${after}>`;
      }
    );
  }

  private ensureRuntimeProgressBar(html: string) {
    const bodyMatch = /<body\b[^>]*>/i.exec(html);
    const deckMatch = /<div\b[^>]*class=(["'])[^"']*\bdeck\b[^"']*\1[^>]*>/i.exec(html);
    if (!bodyMatch || !deckMatch || bodyMatch.index === undefined || deckMatch.index === undefined) {
      return html;
    }

    const bodyEnd = bodyMatch.index + bodyMatch[0].length;
    const bodyPrefix = html.slice(bodyEnd, deckMatch.index);
    if (/^\s*<div\b[^>]*class=(["'])[^"']*\bprogress-bar\b[^"']*\1[^>]*>\s*<span\b[^>]*>\s*<\/span>\s*<\/div>/i.test(bodyPrefix)) {
      return html;
    }

    return `${html.slice(0, bodyEnd)}\n  <div class="progress-bar"><span></span></div>${html.slice(bodyEnd)}`;
  }

  private findEmptyContentBlocks(section: string) {
    const empty: string[] = [];
    const blocks = this.findDivBlocksByClass(section, /\b(?:card|panel|metric|kpi|box)\b/);
    for (const block of blocks) {
      const inner = block.inner;
      const hasVisualPayload = /<(?:canvas|svg|img|ul|ol|li|h[1-6]|p|strong|span)\b/i.test(inner);
      const text = inner.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!hasVisualPayload && text.length < 8) {
        empty.push(block.className.split(/\s+/).slice(0, 3).join("."));
      }
    }
    return empty;
  }

  private findIncompleteSiblingCards(section: string) {
    const incomplete: string[] = [];
    this.rewriteCardContainers(section, (containerInner) => {
      const cards = this.findDirectCardBlocks(containerInner);
      if (cards.length < 2) return containerInner;
      for (const card of cards) {
        const innerStart = card.start + card.openTag.length;
        const end = this.findMatchingDivEnd(containerInner, innerStart);
        if (end.openStart <= innerStart) continue;
        const inner = containerInner.slice(innerStart, end.openStart);
        const hasHeading = /<(?:h2|h3|h4|h5|h6)\b[\s\S]*?<\/(?:h2|h3|h4|h5|h6)>/i.test(inner);
        const hasBody =
          /<(?:p|li|small)\b[\s\S]*?<\/(?:p|li|small)>/i.test(inner) ||
          /\bclass=["'][^"']*\b(?:dim|desc|txt|body|copy|lede|caption)\b[^"']*["']/i.test(inner);
        const text = this.visibleSlideText(inner);
        if (hasHeading && !hasBody && text.length < 24) {
          incomplete.push(card.className.split(/\s+/).slice(0, 4).join("."));
        }
      }
      return containerInner;
    });
    return Array.from(new Set(incomplete));
  }

  private findLayoutSanityIssues(section: string, sanity: LayoutSanityContract) {
    const hardIssues: string[] = [];
    const softIssues: string[] = [];
    const cardCount = (section.match(/<(?:div|article)\b[^>]*class=["'][^"']*\b(?:card|panel|metric-card|kpi-card|comparison-panel)\b[^"']*["'][^>]*>/gi) ?? []).length;
    const bulletCount = (section.match(/<li\b/gi) ?? []).length;
    const metricCount = (section.match(/\b(?:metric|counter|kpi|metric-large|metric-number|number)\b/gi) ?? []).length;

    if (typeof sanity.requiresCanvas === "boolean" && sanity.requiresCanvas && !/<canvas\b/i.test(section)) {
      hardIssues.push("布局约束要求 canvas，但页面缺少 canvas");
    }
    if (typeof sanity.minCards === "number" && cardCount < sanity.minCards) {
      hardIssues.push(`卡片/面板 ${cardCount} 个，少于布局最低要求 ${sanity.minCards}`);
    }
    if (typeof sanity.maxCards === "number" && cardCount > sanity.maxCards) {
      softIssues.push(`卡片/面板 ${cardCount} 个，超过布局健全性上限 ${sanity.maxCards}`);
    }
    if (typeof sanity.minBullets === "number" && bulletCount < sanity.minBullets && sanity.minBullets > 0) {
      softIssues.push(`列表项 ${bulletCount} 个，少于布局建议下限 ${sanity.minBullets}`);
    }
    if (typeof sanity.maxBullets === "number" && bulletCount > sanity.maxBullets) {
      softIssues.push(`列表项 ${bulletCount} 个，超过布局健全性上限 ${sanity.maxBullets}`);
    }
    if (typeof sanity.minMetrics === "number" && metricCount < sanity.minMetrics && sanity.minMetrics > 0) {
      softIssues.push(`指标元素 ${metricCount} 个，少于布局建议下限 ${sanity.minMetrics}`);
    }
    if (typeof sanity.maxMetrics === "number" && metricCount > sanity.maxMetrics) {
      softIssues.push(`指标元素 ${metricCount} 个，超过布局健全性上限 ${sanity.maxMetrics}`);
    }

    if (sanity.horizontal && cardCount >= 2) {
      const hasHorizontalShell =
        /\b(?:grid|row|comparison|pros-cons|g2|g3|g4|kpi-grid|roadmap|timeline|process|flow|arch)\b/i.test(section) ||
        /display\s*:\s*(?:grid|flex)/i.test(section);
      if (!hasHorizontalShell) {
        softIssues.push("布局声明为横向结构，但未检测到 grid/row/flex/comparison 等横向容器");
      }
    }

    return {
      hardIssues: Array.from(new Set(hardIssues)),
      softIssues: Array.from(new Set(softIssues))
    };
  }

  private findDivBlocksByClass(html: string, classPattern: RegExp) {
    const blocks: Array<{ className: string; inner: string }> = [];
    const openTagPattern = /<div\b[^>]*class=["']([^"']+)["'][^>]*>/gi;
    for (const match of html.matchAll(openTagPattern)) {
      const className = match[1] ?? "";
      if (!classPattern.test(className)) continue;
      const openTag = match[0];
      const start = match.index ?? 0;
      const innerStart = start + openTag.length;
      const divEnd = this.findMatchingDivEnd(html, innerStart);
      if (divEnd.openStart <= innerStart) continue;
      blocks.push({ className, inner: html.slice(innerStart, divEnd.openStart) });
    }
    return blocks;
  }

  private findMatchingDivEnd(html: string, fromIndex: number) {
    const divTagPattern = /<\/?div\b[^>]*>/gi;
    divTagPattern.lastIndex = fromIndex;
    let depth = 1;
    for (let match = divTagPattern.exec(html); match; match = divTagPattern.exec(html)) {
      const tag = match[0];
      if (/^<div\b/i.test(tag) && !/\/>$/.test(tag)) depth += 1;
      if (/^<\/div/i.test(tag)) depth -= 1;
      if (depth === 0) return { openStart: match.index, closeEnd: divTagPattern.lastIndex };
    }
    return { openStart: fromIndex, closeEnd: fromIndex };
  }

  private composeIndexHtml(plan: AgentPlan, visual: VisualPlan, sections: string) {
    const cleanSections = this.normalizeInitialActiveSlide(
      this.normalizeLargeStatNumberClasses(
        this.normalizeNonNumericNumClasses(
          this.normalizeSectionFxLayers(this.stripBlockedFx(this.stripSectionRootAnimations(this.stripUnsafeMetricFx(this.stripNotesBlocks(sections)))))
        )
      )
    );
    const themes = Array.from(new Set([visual.primaryTheme, ...visual.backupThemes].filter(Boolean)));
    const title = this.escapeHtml(plan.title);
    const subtitle = plan.subtitle ? `<meta name="description" content="${this.escapeAttr(plan.subtitle)}">` : "";
    const needsChartJs = /new\s+Chart\s*\(/i.test(cleanSections) || /<canvas\b/i.test(cleanSections);
    const html = [
      "<!DOCTYPE html>",
      `<html lang="zh-CN" data-theme="${this.escapeAttr(visual.primaryTheme)}" data-themes="${this.escapeAttr(themes.join(","))}">`,
      "<head>",
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${title}</title>`,
      subtitle ? `  ${subtitle}` : "",
      '  <link rel="stylesheet" href="./assets/base.css">',
      `  <link rel="stylesheet" id="theme-link" href="./assets/themes/${this.escapeAttr(visual.primaryTheme)}.css">`,
      '  <link rel="stylesheet" href="./assets/animations/animations.css">',
      needsChartJs ? '  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>' : "",
      '  <link rel="stylesheet" href="./style.css">',
      "</head>",
      `<body class="${this.escapeAttr(visual.deckClass)}">`,
      '  <div class="deck">',
      cleanSections,
      "  </div>",
      '  <script src="./assets/runtime.js"></script>',
      '  <script src="./assets/edit-mode.js"></script>',
      '  <script src="./assets/animations/fx-runtime.js"></script>',
      "</body>",
      "</html>"
    ].filter((line) => line !== "").join("\n");

    return this.ensureRuntimeProgressBar(html);
  }

  private async qaPublishedDeck(input: {
    outputDir: string;
    expectedSlides: number;
    plan: AgentPlan;
    visual: VisualPlan;
    skill: SkillPack;
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    research: ResearchPack;
    onCall: (usage?: any) => void;
  }) {
    const { outputDir, expectedSlides, plan, visual, skill, activeConfig, agentInput, research, onCall } = input;
    const htmlFileNames = ["index.html", "preview.html", "standalone.html"] as const;
    const baseCss = await readFile(join(outputDir, "assets", "base.css"), "utf8").catch(() => "");
    let files = await Promise.all(htmlFileNames.map(async (name) => ({
      name,
      html: await readFile(join(outputDir, name), "utf8").catch(() => ""),
    })));
    let styleCss = await readFile(join(outputDir, "style.css"), "utf8").catch(() => "");
    let structureHealed = false;
    let fitHealed = false;
    let themeContrastHealed = false;
    let repairedSlides: number[] = [];
    let truncatedSlides: number[] = [];

    const healedFiles = files.map((file) => {
      const healed = this.healPublishedHtml(file.html);
      if (healed !== file.html) structureHealed = true;
      return { ...file, html: healed };
    });
    files = healedFiles;
    const healedStyleCss = this.stripSlidePositionOverride(styleCss);
    if (healedStyleCss !== styleCss) {
      structureHealed = true;
      styleCss = healedStyleCss;
    }
    if (structureHealed) {
      await Promise.all(files.map((file) => writeFile(join(outputDir, file.name), file.html, "utf8")));
      await writeFile(join(outputDir, "style.css"), styleCss, "utf8");
    }

    const contrastPatch = this.buildThemeContrastPatch(visual, skill);
    if (contrastPatch) {
      styleCss = `${styleCss.trimEnd()}\n\n${contrastPatch}\n`;
      await writeFile(join(outputDir, "style.css"), styleCss, "utf8");
      themeContrastHealed = true;
    }

    let evaluation = await this.evaluatePublishedDeckQa({
      outputDir,
      expectedSlides,
      plan,
      visual,
      skill,
      baseCss,
      files,
      styleCss,
      structureHealed,
      fitHealed,
      themeContrastHealed,
      repairedSlides,
      truncatedSlides
    });

    const fitSlideIssues = evaluation.qaReport.signals.fit.details?.slideIssues;
    const failingFitSlides = Array.isArray(fitSlideIssues) ? fitSlideIssues as QaSlideFitIssue[] : [];

    if (failingFitSlides.length > 0 && failingFitSlides.length <= 2) {
      const repaired = await this.repairPublishedDeckFit({
        outputDir,
        plan,
        visual,
        skill,
        files,
        activeConfig,
        agentInput,
        research,
        onCall,
        slideIssues: failingFitSlides
      });
      if (repaired.applied) {
        fitHealed = true;
        repairedSlides = repaired.repairedSlides;
        files = repaired.files;
        evaluation = await this.evaluatePublishedDeckQa({
          outputDir,
          expectedSlides,
          plan,
          visual,
          skill,
          baseCss,
          files,
          styleCss,
          structureHealed,
          fitHealed,
          themeContrastHealed,
          repairedSlides,
          truncatedSlides
        });
      }
    }

    const consistencyBeforePatch = this.extractConsistencyFindings(evaluation.qaReport.signals.consistency.details?.outliers);
    const structuralCssPatchInstructions = this.extractCssPatchInstructions(evaluation.qaReport.signals.classCoverage.details?.cssPatchInstructions);
    if (consistencyBeforePatch.length > 0 || structuralCssPatchInstructions.length > 0) {
      const patched = await this.repairPublishedDeckCssConsistency({
        outputDir,
        plan,
        visual,
        skill,
        activeConfig,
        styleCss,
        consistencyFindings: consistencyBeforePatch,
        extraInstructions: structuralCssPatchInstructions,
        onCall
      });
      if (patched.applied) {
        styleCss = patched.styleCss;
        const previousOutlierCount = this.countConsistencyOutliers(consistencyBeforePatch);
        const patchedEvaluation = await this.evaluatePublishedDeckQa({
          outputDir,
          expectedSlides,
          plan,
          visual,
          skill,
          baseCss,
          files,
          styleCss,
          structureHealed,
          fitHealed,
          themeContrastHealed,
          repairedSlides,
          truncatedSlides
        });
        const nextFindings = this.extractConsistencyFindings(patchedEvaluation.qaReport.signals.consistency.details?.outliers);
        if (this.countConsistencyOutliers(nextFindings) > previousOutlierCount) {
          styleCss = patched.previousStyleCss;
          await writeFile(join(outputDir, "style.css"), styleCss, "utf8");
          evaluation = await this.evaluatePublishedDeckQa({
            outputDir,
            expectedSlides,
            plan,
            visual,
            skill,
            baseCss,
            files,
            styleCss,
            structureHealed,
            fitHealed,
            themeContrastHealed,
            repairedSlides,
            truncatedSlides
          });
        } else {
          evaluation = patchedEvaluation;
        }
      }
    }

    const remainingFitIssues = evaluation.qaReport.signals.fit.details?.slideIssues;
    const slidesForTruncation = Array.isArray(remainingFitIssues) ? remainingFitIssues as QaSlideFitIssue[] : [];
    if (slidesForTruncation.length > 0) {
      const truncated = await this.truncatePublishedDeckFit({
        outputDir,
        plan,
        visual,
        skill,
        files,
        slideIssues: slidesForTruncation
      });
      if (truncated.applied) {
        fitHealed = true;
        truncatedSlides = truncated.truncatedSlides;
        files = truncated.files;
        evaluation = await this.evaluatePublishedDeckQa({
          outputDir,
          expectedSlides,
          plan,
          visual,
          skill,
          baseCss,
          files,
          styleCss,
          structureHealed,
          fitHealed,
          themeContrastHealed,
          repairedSlides,
          truncatedSlides
        });
      }
    }

    await this.writeQaReportToManifest(outputDir, evaluation.qaReport);
    return evaluation;
  }

  private extractConsistencyFindings(value: unknown): ConsistencyFinding[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ConsistencyFinding => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<ConsistencyFinding>;
      return typeof candidate.property === "string" && Array.isArray(candidate.outliers);
    });
  }

  private extractCssPatchInstructions(value: unknown): CssPatchInstruction[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is CssPatchInstruction => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<CssPatchInstruction>;
      return Number.isInteger(candidate.slideIndex) &&
        typeof candidate.role === "string" &&
        typeof candidate.property === "string" &&
        typeof candidate.selector === "string" &&
        typeof candidate.message === "string";
    });
  }

  private countConsistencyOutliers(findings: ConsistencyFinding[]) {
    return findings.reduce((sum, finding) => sum + finding.outliers.length, 0);
  }

  private async repairPublishedDeckCssConsistency(input: {
    outputDir: string;
    plan: AgentPlan;
    visual: VisualPlan;
    skill: SkillPack;
    activeConfig: ActiveModelConfig;
    styleCss: string;
    consistencyFindings: ConsistencyFinding[];
    extraInstructions?: CssPatchInstruction[];
    onCall: (usage?: unknown) => void;
  }) {
    const instructions = [
      ...(input.extraInstructions ?? []),
      ...buildCssPatchInstructions(input.consistencyFindings)
    ].slice(0, 14);
    if (instructions.length === 0) {
      return { applied: false as const, previousStyleCss: input.styleCss, styleCss: input.styleCss };
    }

    const selectedThemePalette = await this.readThemePalettePrompt(input.skill, input.visual.primaryTheme);
    const prompt = buildPrompt("css-patch", {
      userContextText: "",
      skill: input.skill,
      plan: input.plan,
      visual: input.visual,
      selectedThemePalette,
      instructions,
      currentStyleCssLength: input.styleCss.length
    });

    try {
      const raw = await this.modelText(input.activeConfig, prompt.system, prompt.user, input.onCall, {
        source: "html-ppt-agent",
        stage: "08-qa-css-patch"
      });
      const validated = validateCssPatchOutput({
        css: raw,
        deckClass: input.visual.deckClass,
        maxRuleCount: Math.max(1, Math.ceil(instructions.length * 1.2)),
        sanitize: (css) => this.sanitizeGeneratedCss(css)
      });
      if (!validated.ok) {
        this.logger.warn(`HTML-PPT CSS patch skipped: ${validated.reason}`);
        return { applied: false as const, previousStyleCss: input.styleCss, styleCss: input.styleCss };
      }

      const nextStyleCss = appendCssPatch(input.styleCss, validated.css);
      await writeFile(join(input.outputDir, "style.css"), nextStyleCss, "utf8");
      return { applied: true as const, previousStyleCss: input.styleCss, styleCss: nextStyleCss };
    } catch (error) {
      this.logger.warn(`HTML-PPT CSS patch repair failed: ${this.describeError(error)}`);
      return { applied: false as const, previousStyleCss: input.styleCss, styleCss: input.styleCss };
    }
  }

  private healPublishedHtml(html: string) {
    return this.ensureRuntimeProgressBar(
      this.normalizeMetricCountPlaceholders(
        this.normalizeInitialActiveSlide(
          this.normalizeLargeStatNumberClasses(
            this.normalizeNonNumericNumClasses(
              this.normalizeSectionFxLayers(this.stripBlockedFx(this.stripSectionRootAnimations(this.stripUnsafeMetricFx(this.stripNotesBlocks(html)))))
            )
          )
        )
      )
    );
  }

  private normalizeMetricCountPlaceholders(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*\sdata-count=(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi,
      (match, tag: string, attrs: string, _quote: string, rawCount: string, inner: string) => {
        if (!/\bclass=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["']/i.test(attrs)) return match;
        if (/<[a-z][^>]*>/i.test(inner)) return match;

        const text = inner.replace(/\s+/g, " ").trim();
        const count = rawCount.trim();
        if (!count) return match;
        if (text && !/^0(?:[.,]0+)?$/.test(text)) return match;
        if (/^0(?:[.,]0+)?$/.test(count)) return match;

        const nextAttrs = attrs.replace(/\sdata-count=(["'])[^"']+\1/i, "");
        return `<${tag}${nextAttrs}>${count}</${tag}>`;
      }
    );
  }

  private async evaluatePublishedDeckQa(input: {
    outputDir: string;
    expectedSlides: number;
    plan: AgentPlan;
    visual: VisualPlan;
    skill: SkillPack;
    baseCss: string;
    files: Array<{ name: "index.html" | "preview.html" | "standalone.html"; html: string }>;
    styleCss: string;
    structureHealed: boolean;
    fitHealed: boolean;
    themeContrastHealed: boolean;
    repairedSlides: number[];
    truncatedSlides: number[];
  }) {
    const { outputDir, expectedSlides, plan, visual, skill, baseCss, files, styleCss, structureHealed, fitHealed, themeContrastHealed, repairedSlides, truncatedSlides } = input;
    const deckStyle = this.classifyDeckStyle(plan);
    const filesWithStats = files.map((file) => ({ ...file, stats: this.htmlDeckStats(file.html) }));
    const indexFile = filesWithStats.find((file) => file.name === "index.html");
    const indexStats = indexFile?.stats ?? this.htmlDeckStats("");
    const structureIssues: string[] = [];
    const blockingAssetIssues: string[] = [];
    const advisoryAssetIssues: string[] = [];
    const runtimeIssues: string[] = [];
    const fitIssues: string[] = [];
    const fitSlideIssues: QaSlideFitIssue[] = [];
    const layoutRuleIssues: LayoutRulePresenceIssue[] = [];
    const consistencyIssues: string[] = [];
    const geometryBlockingIssues: string[] = [];
    const geometryWarningIssues: string[] = [];
    const themeContrastIssues: string[] = [];
    const blockingPortabilityIssues: string[] = [];
    const advisoryPortabilityIssues: string[] = [];
    const classCoverage = this.collectClassCoverage(indexFile?.html ?? "", baseCss, styleCss);

    if (this.detectSlidePositionOverride(styleCss)) {
      structureIssues.push("style.css 包含 .slide { position: relative/static/fixed }，会覆盖 runtime position:absolute 导致幻灯片导航失效");
    }

    for (const file of filesWithStats) {
      if (file.stats.slides !== expectedSlides) {
        structureIssues.push(`${file.name} 页数 ${file.stats.slides}，预期 ${expectedSlides}`);
      }
      if (file.stats.activeSlides !== 1) {
        structureIssues.push(`${file.name} 初始 active 页数 ${file.stats.activeSlides}，必须为 1`);
      }
      if (file.stats.notes > 0) {
        structureIssues.push(`${file.name} 仍包含 notes ${file.stats.notes} 个`);
      }
      if (file.stats.unsafeMetricFx > 0) {
        structureIssues.push(`${file.name} 指标数字仍包含危险 data-fx ${file.stats.unsafeMetricFx} 个`);
      }
      if (file.stats.unresolvedMetricCounts > 0) {
        structureIssues.push(`${file.name} 存在 ${file.stats.unresolvedMetricCounts} 个 data-count 指标仍显示为 0，占位数字未被归一化`);
      }
      if (!file.stats.runtimeProgressBeforeDeck || !file.stats.firstProgressIsRuntime) {
        structureIssues.push(`${file.name} 运行时 progress-bar 缺失或被业务 progress-bar 抢占，runtime.js 会崩溃`);
      }
      if (file.stats.slides !== indexStats.slides) {
        structureIssues.push(`${file.name} 页数与 index.html 不一致`);
      }
      blockingAssetIssues.push(...this.collectAssetReferenceIssues(file.name, file.html, outputDir));
      runtimeIssues.push(...this.collectRuntimeContractIssues(file.name, file.html, plan));
    }

    const dataFxValues = Array.from(new Set(filesWithStats.flatMap((file) => this.extractAttrValues(file.html, "data-fx"))));
    for (const effectId of dataFxValues) {
      if (effectId.startsWith("to:")) continue;
      const effectFile = join(outputDir, "assets", "animations", "fx", `${effectId}.js`);
      if (!existsSync(effectFile)) {
        advisoryAssetIssues.push(`data-fx=${effectId} 缺少对应文件 assets/animations/fx/${effectId}.js`);
      }
    }

    const animationsCss = await readFile(join(outputDir, "assets", "animations", "animations.css"), "utf8").catch(() => "");
    const dataAnimValues = Array.from(new Set(filesWithStats.flatMap((file) => this.extractAttrValues(file.html, "data-anim"))));
    for (const animationId of dataAnimValues) {
      if (!animationsCss.includes(`.anim-${animationId}`)) {
        advisoryAssetIssues.push(`data-anim=${animationId} 未在 animations.css 中声明`);
      }
    }

    const inlineThemeIssues = this.collectInlineThemeRegistryIssues(indexFile?.html ?? "", visual);
    blockingAssetIssues.push(...inlineThemeIssues);

    const sections = this.extractSectionList(indexFile?.html ?? "");
    layoutRuleIssues.push(...this.collectLayoutRulePresenceIssues(indexFile?.html ?? "", `${baseCss}\n${styleCss}`));
    const structuralCssPatchInstructions = this.buildStructuralCssPatchInstructions({
      indexHtml: indexFile?.html ?? "",
      deckClass: visual.deckClass,
      classCoverage,
      layoutRuleIssues
    });
    plan.slides.forEach((slide, index) => {
      const section = sections[index];
      if (!section) return;
      const issues = this.estimateLandscapeFitIssues(section, slide, skill, plan, deckStyle);
      if (issues.length === 0) return;
      fitSlideIssues.push({ slideIndex: slide.index, planOffset: index, layoutId: slide.layoutId, issues });
      fitIssues.push(...issues.map((issue) => `第 ${slide.index} 页(${slide.layoutId}) ${issue}`));
    });

    themeContrastIssues.push(...this.collectThemeContrastIssues(visual, skill, themeContrastHealed));
    const portability = await this.collectPortabilityIssues(outputDir, filesWithStats);
    blockingPortabilityIssues.push(...portability.blocking);
    advisoryPortabilityIssues.push(...portability.advisory);
    const referenceContract = (await this.readReferenceFullDeck(skill, this.pickReferenceFullDeckName(visual, skill) ?? ""))?.contract;
    const coverCloserParityIssues = this.collectCoverCloserParityIssues(indexFile?.html ?? "", plan, visual);

    const cascades = buildSlideCascade(indexFile?.html ?? "", styleCss, {
      baseCss,
      slideLayouts: plan.slides.map((slide) => ({ slideIndex: slide.index, layoutId: slide.layoutId }))
    });
    const ledger = buildLedger(cascades, plan);
    const consistencyFindings = detectOutliers(ledger);
    const geometryFindings = estimateGeometryIssues(cascades, plan);

    for (const finding of consistencyFindings) {
      const sampleLabels = finding.outliers
        .slice(0, 3)
        .map((item) => `第 ${item.slideIndex} 页 ${item.role} -> ${String(item.value)}`)
        .join("；");
      consistencyIssues.push(`${finding.property} 与 deck 其他同层页面不一致，建议回归 ${String(finding.canonical)}。${sampleLabels}`);
    }
    consistencyIssues.push(...this.collectReferenceContractContinuityIssues(indexFile?.html ?? "", plan, referenceContract));
    consistencyIssues.push(...coverCloserParityIssues);
    for (const finding of geometryFindings) {
      if (finding.severity === "block") {
        geometryBlockingIssues.push(`第 ${finding.slideIndex} 页(${finding.layoutId}) ${finding.message}`);
      } else {
        geometryWarningIssues.push(`第 ${finding.slideIndex} 页(${finding.layoutId}) ${finding.message}`);
      }
    }

    const blockingIssues = [...structureIssues, ...blockingAssetIssues, ...runtimeIssues, ...geometryBlockingIssues, ...blockingPortabilityIssues];
    const warnings = [
      ...advisoryAssetIssues,
      ...fitIssues,
      ...consistencyIssues,
      ...geometryWarningIssues,
      ...themeContrastIssues,
      ...advisoryPortabilityIssues
    ];

    const qaReport: QaReport = {
      generatedAt: new Date().toISOString(),
      repairedSlides,
      truncatedSlides,
      warnings,
      signals: {
        structure: this.makeQaSignal(structureIssues, structureHealed, { files: filesWithStats.map((file) => ({ name: file.name, ...file.stats })) }),
        assets: this.makeQaSignal([...blockingAssetIssues, ...advisoryAssetIssues], false, { dataFxValues, dataAnimValues }),
        runtime: this.makeQaSignal(runtimeIssues, false),
        fit: this.makeQaSignal(fitIssues, fitHealed, { slideIssues: fitSlideIssues }),
        classCoverage: this.makeQaSignal([], false, {
          ...classCoverage,
          layoutRuleIssues,
          cssPatchInstructions: structuralCssPatchInstructions
        }),
        consistency: this.makeQaSignal(
          consistencyIssues,
          false,
          { outliers: consistencyFindings, groups: Object.keys(ledger.groups).length, referenceContract, coverCloserParityIssues },
          consistencyIssues.length > 0 ? "warn" : undefined
        ),
        geometry: this.makeQaSignal(
          [...geometryBlockingIssues, ...geometryWarningIssues],
          false,
          { findings: geometryFindings },
          geometryBlockingIssues.length > 0 ? "failed" : geometryWarningIssues.length > 0 ? "warn" : undefined
        ),
        themeContrast: this.makeQaSignal(
          themeContrastIssues,
          themeContrastHealed,
          { primaryTheme: visual.primaryTheme, autoPatchApplied: themeContrastHealed },
          themeContrastIssues.length > 0 ? "warn" : undefined
        ),
        portability: this.makeQaSignal([...blockingPortabilityIssues, ...advisoryPortabilityIssues], false)
      },
      issues: blockingIssues
    };
    qaReport.quality = this.scoreQaReport(qaReport);

    return {
      slides: indexStats.slides,
      activeSlides: indexStats.activeSlides,
      chineseChars: indexStats.chineseChars,
      inlineThemes: indexStats.inlineThemes,
      issues: blockingIssues,
      qaReport
    };
  }

  private makeQaSignal(
    issues: string[],
    healed: boolean,
    details?: Record<string, unknown>,
    statusOverride?: QaSignalStatus
  ): QaSignalReport {
    return {
      status: statusOverride ?? (issues.length > 0 ? "failed" : healed ? "healed" : "passed"),
      issues,
      ...(details ? { details } : {})
    };
  }

  private classCoverageSummary(qaReport: QaReport) {
    const details = qaReport.signals.classCoverage.details;
    const htmlMatchedByDeckCss = typeof details?.htmlMatchedByDeckCss === "number" ? details.htmlMatchedByDeckCss : 0;
    const htmlTotal = typeof details?.htmlTotal === "number" ? details.htmlTotal : 0;
    const cssMatchedToHtml = typeof details?.cssMatchedToHtml === "number" ? details.cssMatchedToHtml : 0;
    const cssTotal = typeof details?.cssTotal === "number" ? details.cssTotal : 0;
    return {
      htmlSummary: `${htmlMatchedByDeckCss}/${htmlTotal}`,
      cssSummary: `${cssMatchedToHtml}/${cssTotal}`
    };
  }

  private estimateStepIssueCount(value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const issues = Array.isArray(record.issues) ? record.issues.length : 0;
    const qaReport = record.qaReport && typeof record.qaReport === "object" ? record.qaReport as QaReport : undefined;
    const qaIssues = qaReport ? qaReport.issues.length + qaReport.warnings.length : 0;
    if (issues || qaIssues) return issues + qaIssues;
    if (Array.isArray(record.stats)) {
      return record.stats.reduce((sum, item) => {
        if (!item || typeof item !== "object") return sum;
        const stat = item as Record<string, unknown>;
        return sum + Number(stat.modelRepairCalls ?? 0) + Number(stat.localRepairCount ?? 0);
      }, 0);
    }
    return undefined;
  }

  private summarizeQaSignals(qaReport: QaReport) {
    return Object.fromEntries(
      Object.entries(qaReport.signals).map(([key, signal]) => [
        key,
        {
          status: signal.status,
          issues: signal.issues.length
        }
      ])
    );
  }

  private scoreQaReport(qaReport: QaReport): QaQualityScore {
    const signals = Object.values(qaReport.signals);
    const failedSignals = signals.filter((signal) => signal.status === "failed").length;
    const warnSignals = signals.filter((signal) => signal.status === "warn").length;
    const healedSignals = signals.filter((signal) => signal.status === "healed").length;
    const blockingIssues = qaReport.issues.length;
    const warnings = qaReport.warnings.length;
    const fitDetails = qaReport.signals.fit.details;
    const slideFitIssues = Array.isArray(fitDetails?.slideIssues) ? fitDetails.slideIssues.length : qaReport.signals.fit.issues.length;
    const classCoverageDetails = qaReport.signals.classCoverage.details;
    const htmlTotal = Number(classCoverageDetails?.htmlTotal ?? 0);
    const htmlMatched = Number(classCoverageDetails?.htmlMatchedByDeckCss ?? classCoverageDetails?.htmlMatchedByAnyCss ?? 0);
    const classCoverageRate = htmlTotal > 0 ? Number((htmlMatched / htmlTotal).toFixed(4)) : undefined;
    const classCoveragePenalty = classCoverageRate === undefined ? 0 : Math.max(0, Math.round((1 - classCoverageRate) * 20));

    const rawScore =
      100
      - blockingIssues * 18
      - failedSignals * 14
      - warnings * 3
      - warnSignals * 5
      - healedSignals * 2
      - slideFitIssues * 3
      - classCoveragePenalty;
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
    return {
      score,
      grade,
      blockingIssues,
      warnings,
      healedSignals,
      failedSignals,
      warnSignals,
      slideFitIssues,
      ...(classCoverageRate !== undefined ? { classCoverageRate } : {})
    };
  }

  private collectReferenceContractContinuityIssues(
    indexHtml: string,
    plan: AgentPlan,
    contract?: ReferenceComponentContract
  ) {
    if (!contract) return [];
    const issues: string[] = [];
    const sections = this.extractSectionList(indexHtml);
    const skipLayouts = new Set(["cover", "toc", "section-divider", "thanks", "cta", "big-quote"]);
    for (const [index, slide] of plan.slides.entries()) {
      if (skipLayouts.has(slide.layoutId)) continue;
      const section = sections[index] ?? "";
      if (!section) continue;
      if (contract.bodyTitleClass && /<(h1|h2)\b/i.test(section) && !this.sectionHasClassToken(section, contract.bodyTitleClass)) {
        issues.push(`第 ${slide.index} 页(${slide.layoutId}) 没有沿用 donor 标题类 ${contract.bodyTitleClass}，中段页容易与封面/结尾脱节`);
      }
      if (contract.kickerClass && /\bclass=["'][^"']*\b(kicker|eyebrow)\b/i.test(section) && !this.sectionHasClassToken(section, contract.kickerClass)) {
        issues.push(`第 ${slide.index} 页(${slide.layoutId}) 顶部标签没有沿用 donor kicker 类 ${contract.kickerClass}`);
      }
      if (contract.sectionLabelClass && /\bclass=["'][^"']*\b(section-label|section_label)\b/i.test(section) && !this.sectionHasClassToken(section, contract.sectionLabelClass)) {
        issues.push(`第 ${slide.index} 页(${slide.layoutId}) section label 没有沿用 donor 类 ${contract.sectionLabelClass}`);
      }
      if (contract.footerClass && !this.sectionHasClassToken(section, contract.footerClass)) {
        issues.push(`第 ${slide.index} 页(${slide.layoutId}) 缺少 donor footer 类 ${contract.footerClass}`);
      }
      if (contract.cardClass) {
        const genericCardLikeCount = Array.from(section.matchAll(/\bclass=["'][^"']*\b(card|card-soft|card-outline|card-accent|panel|side)\b[^"']*["']/gi)).length;
        if (genericCardLikeCount >= 2 && !this.sectionHasClassToken(section, contract.cardClass)) {
          issues.push(`第 ${slide.index} 页(${slide.layoutId}) 使用了 ${genericCardLikeCount} 个通用卡片壳，但没有沿用 donor card 类 ${contract.cardClass}`);
        }
      }
    }
    return issues;
  }

  private collectClassCoverage(indexHtml: string, baseCss: string, styleCss: string): ClassCoverageReport {
    const htmlClasses = this.filterCoverageClasses(this.extractClassTokensFromMarkup(indexHtml));
    const deckCssClasses = this.filterCoverageClasses(this.extractClassTokensFromCss(styleCss));
    const anyCssClasses = this.filterCoverageClasses([
      ...this.extractClassTokensFromCss(baseCss),
      ...deckCssClasses
    ]);
    const htmlClassSet = new Set(htmlClasses);
    const deckCssClassSet = new Set(deckCssClasses);
    const anyCssClassSet = new Set(anyCssClasses);

    const htmlMatchedByDeckCss = htmlClasses.filter((token) => deckCssClassSet.has(token)).length;
    const htmlMatchedByAnyCss = htmlClasses.filter((token) => anyCssClassSet.has(token)).length;
    const cssMatchedToHtml = deckCssClasses.filter((token) => htmlClassSet.has(token)).length;

    return {
      htmlMatchedByDeckCss,
      htmlMatchedByAnyCss,
      htmlTotal: htmlClasses.length,
      cssMatchedToHtml,
      cssTotal: deckCssClasses.length,
      unmatchedHtmlClasses: htmlClasses.filter((token) => !deckCssClassSet.has(token)).slice(0, 20),
      orphanHtmlClasses: htmlClasses.filter((token) => !anyCssClassSet.has(token)).slice(0, 20),
      unusedCssClasses: deckCssClasses.filter((token) => !htmlClassSet.has(token)).slice(0, 20)
    };
  }

  private collectLayoutRulePresenceIssues(indexHtml: string, cssText: string): LayoutRulePresenceIssue[] {
    const issues: LayoutRulePresenceIssue[] = [];
    const targetClasses = new Set(["row", "comparison", "grid-2", "grid-3", "grid-4", "g2", "g3", "g4", "kpi-grid", "pros-cons"]);
    const sections = this.extractSectionList(indexHtml);
    sections.forEach((section, index) => {
      const classTokens = new Set(this.extractClassTokensFromMarkup(section));
      for (const className of targetClasses) {
        if (!classTokens.has(className)) continue;
        if (this.hasLayoutDisplayRule(className, cssText, classTokens)) continue;
        issues.push({
          slideIndex: index + 1,
          className,
          selector: `.${className}`,
          message: `第 ${index + 1} 页 .${className} 缺少 display:flex/grid 规则，横向结构可能退化为纵向堆叠`
        });
      }
    });
    return issues;
  }

  private hasLayoutDisplayRule(className: string, cssText: string, sectionClassTokens: Set<string>) {
    const acceptableClasses = new Set<string>([className]);
    if (["g2", "g3", "g4", "grid-2", "grid-3", "grid-4"].includes(className) && sectionClassTokens.has("grid")) {
      acceptableClasses.add("grid");
    }
    for (const rule of this.findCssRules(cssText)) {
      if (!/\bdisplay\s*:\s*(?:flex|grid)\b/i.test(rule.body)) continue;
      const selectorClasses = this.extractClassTokensFromSelector(rule.selector);
      if (selectorClasses.some((token) => acceptableClasses.has(token))) return true;
    }
    return false;
  }

  private buildStructuralCssPatchInstructions(input: {
    indexHtml: string;
    deckClass: string;
    classCoverage: ClassCoverageReport;
    layoutRuleIssues: LayoutRulePresenceIssue[];
  }): CssPatchInstruction[] {
    const instructions: CssPatchInstruction[] = [];
    const seen = new Set<string>();
    const add = (instruction: CssPatchInstruction) => {
      const key = `${instruction.slideIndex}:${instruction.property}:${instruction.selector}`;
      if (seen.has(key)) return;
      seen.add(key);
      instructions.push(instruction);
    };

    for (const issue of input.layoutRuleIssues.slice(0, 8)) {
      add({
        slideIndex: issue.slideIndex,
        role: "layout-rule",
        property: "layout.display",
        currentValue: "missing display:flex/grid",
        canonicalValue: issue.className.includes("grid") || issue.className.startsWith("g") ? "display:grid" : "display:flex",
        selector: issue.selector,
        message: issue.message
      });
    }

    const sections = this.extractSectionList(input.indexHtml);
    for (const className of input.classCoverage.orphanHtmlClasses.slice(0, 8)) {
      const slideIndex = Math.max(1, sections.findIndex((section) => this.sectionHasClassToken(section, className)) + 1);
      add({
        slideIndex,
        role: "orphan-class",
        property: "orphan-class.css-rule",
        currentValue: `.${className} has no CSS rule`,
        canonicalValue: "add a scoped rule using existing theme tokens",
        selector: `.${className}`,
        message: `HTML 使用 .${className}，但 base.css/style.css 没有对应选择器；补一个最小视觉规则或继承相关组件风格`
      });
    }

    void input.deckClass;
    return instructions.slice(0, 12);
  }

  private filterCoverageClasses(classNames: Iterable<string>) {
    const ignored = this.coverageIgnoredClassTokens();
    return Array.from(new Set(Array.from(classNames).filter((token) => token && !ignored.has(token)))).sort((a, b) => a.localeCompare(b));
  }

  private coverageIgnoredClassTokens() {
    return new Set(["slide", "deck", "progress-bar", "is-active", "is-prev", "is-next"]);
  }

  private runtimeClassTokens() {
    return new Set(["slide", "deck", "progress-bar", "is-active", "is-prev", "is-next"]);
  }

  private extractClassTokensFromMarkup(markup: string) {
    return Array.from(
      new Set(
        Array.from(markup.matchAll(/\bclass=["']([^"']+)["']/gi))
          .flatMap((match) => (match[1] ?? "").split(/\s+/))
          .map((token) => token.trim())
          .filter(Boolean)
      )
    );
  }

  private extractClassTokensFromCss(css: string) {
    return Array.from(
      new Set(
        this.findCssRules(css).flatMap(({ selector }) =>
          this.extractClassTokensFromSelector(selector)
        ).filter(Boolean)
      )
    );
  }

  private extractClassTokensFromSelector(selector: string) {
    return Array.from(selector.matchAll(/\.([_a-zA-Z][\w-]*)/g)).map((match) => match[1] ?? "");
  }

  private sectionHasClassToken(section: string, token: string) {
    const escaped = token.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    return new RegExp(`\\bclass=["'][^"']*\\b${escaped}\\b[^"']*["']`, "i").test(section);
  }

  private collectAssetReferenceIssues(fileName: string, html: string, outputDir: string) {
    const issues: string[] = [];
    for (const ref of this.extractRelativeRefs(html)) {
      const resolved = this.resolveHtmlRefToOutputPath(outputDir, ref);
      if (!resolved) {
        issues.push(`${fileName} 无法解析相对资源 ${ref}`);
        continue;
      }
      if (!existsSync(resolved)) {
        issues.push(`${fileName} 资源缺失：${ref}`);
      }
    }
    return issues;
  }

  private collectRuntimeContractIssues(fileName: string, html: string, plan: AgentPlan) {
    const issues: string[] = [];
    if (fileName !== "preview.html") {
      const baseIndex = html.indexOf("./assets/base.css");
      const animationsIndex = html.indexOf("./assets/animations/animations.css");
      const styleIndex = html.indexOf("./style.css");
      if (baseIndex < 0) issues.push(`${fileName} 缺少 base.css`);
      if (animationsIndex < 0) issues.push(`${fileName} 缺少 animations.css`);
      if (styleIndex < 0) issues.push(`${fileName} 缺少 style.css`);
      if (baseIndex >= 0 && animationsIndex >= 0 && baseIndex > animationsIndex) issues.push(`${fileName} base.css 必须先于 animations.css`);
      if (animationsIndex >= 0 && styleIndex >= 0 && animationsIndex > styleIndex) issues.push(`${fileName} animations.css 必须先于 style.css`);
    } else {
      const previewBaseIndex = html.indexOf("./asset?path=base.css");
      const previewAnimationsIndex = html.indexOf("./asset?path=animations%2Fanimations.css");
      if (previewBaseIndex < 0) issues.push(`${fileName} 缺少预览 base.css 代理引用`);
      if (previewAnimationsIndex < 0) issues.push(`${fileName} 缺少预览 animations.css 代理引用`);
    }

    const runtimeNeedle = fileName === "preview.html" ? "./asset?path=runtime.js" : "./assets/runtime.js";
    const editModeNeedle = fileName === "preview.html" ? "./asset?path=edit-mode.js" : "./assets/edit-mode.js";
    const fxRuntimeNeedle = fileName === "preview.html" ? "./asset?path=animations%2Ffx-runtime.js" : "./assets/animations/fx-runtime.js";
    const runtimeIndex = html.indexOf(runtimeNeedle);
    const editModeIndex = html.indexOf(editModeNeedle);
    const fxRuntimeIndex = html.indexOf(fxRuntimeNeedle);
    if (runtimeIndex < 0) issues.push(`${fileName} 缺少 runtime.js`);
    if (editModeIndex < 0) issues.push(`${fileName} 缺少 edit-mode.js`);
    if (fxRuntimeIndex < 0) issues.push(`${fileName} 缺少 fx-runtime.js`);
    if (runtimeIndex >= 0 && editModeIndex >= 0 && runtimeIndex > editModeIndex) issues.push(`${fileName} runtime.js 必须先于 edit-mode.js`);
    if (editModeIndex >= 0 && fxRuntimeIndex >= 0 && editModeIndex > fxRuntimeIndex) issues.push(`${fileName} edit-mode.js 必须先于 fx-runtime.js`);

    const requiresChartJs = plan.slides.some((slide) => slide.layoutId.startsWith("chart-"));
    const hasChartJs = /chart\.umd\.min\.js/i.test(html);
    if (requiresChartJs && !hasChartJs) {
      issues.push(`${fileName} 缺少 Chart.js，但存在 chart-* 布局`);
    }
    if (!requiresChartJs && hasChartJs) {
      issues.push(`${fileName} 不应加载 Chart.js，因为当前 deck 没有 chart-* 布局`);
    }
    if (!requiresChartJs && /<canvas\b/i.test(html)) {
      issues.push(`${fileName} 存在孤立 canvas，但当前 deck 没有 chart-* 布局`);
    }
    return issues;
  }

  private collectInlineThemeRegistryIssues(html: string, visual: VisualPlan) {
    const issues: string[] = [];
    if (!html.includes("inline-theme-registry")) {
      issues.push("index.html 未检测到 inline-theme-registry");
      return issues;
    }
    const themeIds = Array.from(new Set([visual.primaryTheme, ...visual.backupThemes].filter(Boolean)));
    for (const themeId of themeIds) {
      if (!html.includes(`html[data-theme="${themeId}"]`)) {
        issues.push(`inline-theme-registry 未包含主题 ${themeId}`);
      }
    }
    return issues;
  }

  private estimateLandscapeFitIssues(
    section: string,
    slide: AgentPlan["slides"][number],
    skill: SkillPack,
    plan?: AgentPlan,
    deckStyle: DeckStyleProfile = "balanced"
  ) {
    const layout = (skill.manifest?.layouts ?? []).find((item) => item.id === slide.layoutId);
    if (!layout?.densityBudget) return [];

    const issues: string[] = [];
    const titleText = this.extractFirstHeadingText(section);
    const visibleTextLength = this.visibleSlideText(section).length;
    const liCount = (section.match(/<li\b/gi) ?? []).length;
    const cardCount = (section.match(/<(?:div|article)\b[^>]*class=["'][^"']*\b(?:card|panel|metric-card|kpi-card|comparison-panel)\b[^"']*["'][^>]*>/gi) ?? []).length;
    const topicCount = Math.max(1, slide.keyPoints.length);
    const budgetProfile = this.computeDynamicLandscapeBudget({
      slide,
      titleText,
      visibleTextLength,
      liCount,
      cardCount,
      densityBudget: layout.densityBudget,
      sanity: layout.sanity,
      plan,
      deckStyle
    });
    const textBudget = budgetProfile.textBudget;
    const titleBudget = budgetProfile.titleBudget;
    const itemBudget = budgetProfile.itemBudget;
    const cardBudget = budgetProfile.cardBudget;
    const pressureThreshold = budgetProfile.pressureThreshold;

    if (titleText.length > titleBudget) {
      issues.push(`标题 ${titleText.length} 字，超过横版预算 ${titleBudget}，1280x720 下高概率换行溢出`);
    }
    if (visibleTextLength > Math.round(textBudget * 1.12)) {
      issues.push(`可见文字 ${visibleTextLength} 字，超过横版预算 ${textBudget}，估算会超出 1280x720 视口`);
    }
    if (liCount > itemBudget) {
      issues.push(`列表项 ${liCount} 个，超过布局预算 ${itemBudget}`);
    }
    if (cardCount > cardBudget) {
      issues.push(`卡片/面板 ${cardCount} 个，超过动态布局预算 ${cardBudget}（当前主题点 ${topicCount} 个，标题 ${titleText.length} 字，可见正文 ${visibleTextLength} 字）`);
    }

    const pressureComponents = [
      visibleTextLength / Math.max(1, textBudget),
      liCount / Math.max(1, itemBudget),
      cardCount / Math.max(1, cardBudget),
      titleText.length / Math.max(1, titleBudget)
    ];
    const pressureScore = pressureComponents.reduce((sum, value) => sum + value, 0) / pressureComponents.length;
    if (pressureScore > pressureThreshold) {
      issues.push(`密度压力分 ${pressureScore.toFixed(2)}，超过阈值 ${pressureThreshold.toFixed(2)}，估算在 16:9 横版下会发生拥挤或遮挡`);
    }
    return issues;
  }

  private computeDynamicLandscapeBudget(input: {
    slide: AgentPlan["slides"][number];
    titleText: string;
    visibleTextLength: number;
    liCount: number;
    cardCount: number;
    densityBudget: { maxTitleChars: number; maxBodyCharsTotal: number; maxItems: number; maxCardCount: number };
    sanity?: LayoutSanityContract;
    plan?: AgentPlan;
    deckStyle?: DeckStyleProfile;
  }) {
    const { slide, titleText, visibleTextLength, densityBudget, sanity, plan, deckStyle = "balanced" } = input;
    const layoutId = slide.layoutId.toLowerCase();
    const topicCount = Math.max(1, slide.keyPoints.length);
    const avgPointLength =
      slide.keyPoints.length > 0
        ? Math.round(slide.keyPoints.reduce((sum, item) => sum + item.trim().length, 0) / slide.keyPoints.length)
        : 0;
    const plannedItemCount = Math.max(1, slide.keyPoints.length);
    const columnCount =
      sanity?.columns && sanity.columns > 0
        ? sanity.columns
        : layoutId.startsWith("three-column") || layoutId === "three-col"
        ? 3
        : layoutId.startsWith("two-column") || layoutId === "two-col"
          ? 2
          : 1;
    const isTocLayout = layoutId === "toc" || /(?:toc|agenda|目录)/i.test(slide.type);
    const compactTopicSet = topicCount <= 3 && avgPointLength <= 18;
    const compactTitle = titleText.length > 0 && titleText.length <= Math.max(10, densityBudget.maxTitleChars * 0.72);
    const compactText = visibleTextLength <= Math.round(densityBudget.maxBodyCharsTotal * 0.78);
    const longTitlePenalty = titleText.length > densityBudget.maxTitleChars ? 1 : 0;
    const longPointPenalty = avgPointLength >= 30 ? 1 : 0;

    let cardBudget = Math.max(1, densityBudget.maxCardCount || 1);
    if (compactTopicSet && compactTitle && compactText) {
      cardBudget += 1;
    }
    cardBudget = Math.max(1, cardBudget - longTitlePenalty);
    if (typeof sanity?.maxCards === "number") {
      cardBudget = Math.max(cardBudget, sanity.maxCards);
    }

    let titleBudget = Math.max(10, densityBudget.maxTitleChars - longTitlePenalty * 2);
    let itemBudget = Math.max(
      1,
      densityBudget.maxItems * columnCount + (compactTopicSet ? columnCount : 0) - longPointPenalty
    );
    if (typeof sanity?.maxBullets === "number") {
      itemBudget = Math.max(itemBudget, sanity.maxBullets);
    }
    let textBudget = Math.max(
      140,
      densityBudget.maxBodyCharsTotal + (compactTopicSet ? 60 : 0) - longTitlePenalty * 40 - longPointPenalty * 30
    );
    let pressureThreshold = 0.94;

    if (deckStyle === "academic") {
      textBudget = Math.round(textBudget * 1.5);
      pressureThreshold = Number((pressureThreshold * 1.18).toFixed(2));
    } else if (deckStyle === "product") {
      textBudget = Math.round(textBudget * 0.85);
      pressureThreshold = Number((pressureThreshold * 0.9).toFixed(2));
    }

    // Let plan intent drive density: if plan asked for N key points, budget should at least hold N.
    itemBudget = Math.max(itemBudget, plannedItemCount);

    if (isTocLayout) {
      // TOC budget should track the deck's actual body-slide count, not a
      // hard 6-cap. An 11-slide deck has 9 entries in its TOC and that's
      // correct, not "over budget".
      const realTocEntries = Math.max(
        1,
        plan?.slides.filter((entry) => entry.index !== slide.index && !this.isSparsePlanSlide(entry)).length ?? plannedItemCount
      );
      const tocCeiling = Math.max(realTocEntries, 6);
      itemBudget = Math.max(itemBudget, tocCeiling);
      cardBudget = Math.max(cardBudget, tocCeiling);
      titleBudget = Math.max(titleBudget, 14);
      textBudget = Math.max(textBudget, 260 + Math.max(0, realTocEntries - 6) * 30);
      pressureThreshold = Math.max(pressureThreshold, 1.05);
    }

    if (layoutId.startsWith("two-column") || layoutId === "two-col") {
      // Two-column layouts naturally hold 2 cards per row, often 2 rows = 4.
      // The floor must cover this so we don't reject 3-4 card legitimate decks.
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 4);
    }
    if (layoutId.startsWith("three-column") || layoutId === "three-col") {
      itemBudget = Math.max(itemBudget, 9);
      cardBudget = Math.max(cardBudget, 6);
    }
    if (layoutId === "comparison" || layoutId === "pros-cons") {
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 3);
    }
    if (layoutId === "stat-highlight" || layoutId === "kpi-grid" || layoutId === "metrics") {
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 4);
    }
    if (layoutId === "timeline" || layoutId === "roadmap" || layoutId === "process" || layoutId === "process-steps") {
      // Timelines / roadmaps / process flows are fundamentally multi-node;
      // a 1-card timeline is not a timeline. Floor to a realistic minimum.
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 4);
    }
    if (layoutId === "bullets" || layoutId === "bullet-list" || layoutId === "bullet-cards") {
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 4);
    }
    if (layoutId === "feature-cards" || layoutId === "card-grid" || layoutId === "icon-grid") {
      itemBudget = Math.max(itemBudget, 6);
      cardBudget = Math.max(cardBudget, 4);
    }

    if (["cover", "cta", "thanks"].includes(layoutId)) {
      titleBudget = Math.max(titleBudget, 16);
      textBudget = Math.max(textBudget, 220);
      pressureThreshold = Math.max(pressureThreshold, deckStyle === "product" ? 0.96 : 1.06);
    }

    return {
      cardBudget: Math.max(1, Math.round(cardBudget)),
      titleBudget: Math.max(10, Math.round(titleBudget)),
      itemBudget: Math.max(1, Math.round(itemBudget)),
      textBudget: Math.max(140, Math.round(textBudget)),
      pressureThreshold: Number(pressureThreshold.toFixed(2))
    };
  }

  private classifyDeckStyle(plan: AgentPlan): DeckStyleProfile {
    const corpus = [
      plan.objective,
      plan.objective,
      plan.audience,
      plan.audience,
      plan.title,
      ...plan.slides.map((slide) => `${slide.type} ${slide.goal}`)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const academicKeywords = [
      "explain", "research", "analyze", "analysis", "compare", "methodology", "finding", "evidence", "review", "academic",
      "survey", "discussion", "abstract", "introduction", "conclusion", "hypothesis", "literature", "framework", "theory",
      "解释", "研究", "分析", "比较", "理论", "方法", "结论", "证据", "综述", "学术",
      "教学", "课程", "讲解", "论述", "探讨", "概述", "假设", "文献", "框架"
    ];
    const productKeywords = [
      "customer", "investor", "demo", "launch", "sales", "pitch", "revenue", "convert", "feature", "go-to-market",
      "roadmap", "pricing", "competitor", "market fit", "adoption", "retention", "growth", "gtm",
      "客户", "投资人", "演示", "发布", "销售", "路演", "营收", "转化", "功能", "产品",
      "路线图", "定价", "竞品", "市场契合", "增长", "留存"
    ];

    const score = (keywords: string[]) => keywords.reduce((sum, word) => (corpus.includes(word) ? sum + 1 : sum), 0);
    const academicScore = score(academicKeywords);
    const productScore = score(productKeywords);

    if (academicScore - productScore >= 2) return "academic";
    if (productScore - academicScore >= 2) return "product";
    return "balanced";
  }

  private isSparsePlanSlide(slide: AgentPlan["slides"][number]) {
    const value = `${slide.layoutId} ${slide.type}`.toLowerCase();
    return /(cover|封面|cta|thanks|closing|结尾|ending|summary|总结)/i.test(value);
  }

  private isNarrativeLightLayout(layoutId: string) {
    return ["cover", "toc", "section-divider", "cta", "thanks", "big-quote"].includes(layoutId);
  }

  private preferredNarrativeDenseLayout(skill: SkillPack) {
    const preferred = ["bullets", "two-column", "timeline", "comparison", "roadmap", "process-steps", "kpi-grid", "three-column"];
    return preferred.find((layoutId) => skill.layoutNames.includes(layoutId))
      ?? skill.layoutNames.find((layoutId) => !this.isNarrativeLightLayout(layoutId))
      ?? "bullets";
  }

  private convertNarrativeLightSlide(
    slides: AgentPlan["slides"],
    index: number,
    skill: SkillPack
  ): AgentPlan["slides"][number] {
    const slide = slides[index];
    if (!slide) {
      return {
        index: index + 1,
        title: `第 ${index + 1} 页`,
        type: "content",
        layoutId: this.preferredNarrativeDenseLayout(skill),
        goal: "补充这一页的正文信息",
        keyPoints: ["补充关键背景、判断与承接信息。"]
      };
    }
    const nextContent = slides.slice(index + 1).find((item) => !this.isNarrativeLightLayout(item.layoutId));
    const prevContent = [...slides.slice(0, index)].reverse().find((item) => !this.isNarrativeLightLayout(item.layoutId));
    const cleanedTitle = slide.title.replace(/^\s*\d+\s*[·:：\-]\s*/u, "").trim();
    const title = /(下一节|章节|section|chapter)/i.test(cleanedTitle)
      ? (nextContent?.title || prevContent?.title || cleanedTitle || `第 ${index + 1} 页`)
      : (cleanedTitle || nextContent?.title || prevContent?.title || `第 ${index + 1} 页`);
    const borrowedPoints = [
      ...slide.keyPoints,
      ...(nextContent?.keyPoints ?? []).slice(0, 2),
      ...(prevContent?.keyPoints ?? []).slice(0, 1)
    ]
      .map((item) => item.trim())
      .filter(Boolean);
    const uniquePoints = Array.from(new Set(borrowedPoints)).slice(0, 4);
    const keyPoints = uniquePoints.length > 0
      ? uniquePoints
      : [
        `补充 ${title} 的背景信息与关键判断。`,
        `用完整句说明这一页与前后内容的承接关系。`
      ];
    return {
      ...slide,
      type: "content",
      layoutId: this.preferredNarrativeDenseLayout(skill),
      title,
      goal: slide.goal?.trim() || `展开 ${title} 的关键信息`,
      keyPoints
    };
  }

  private extractFirstHeadingText(section: string) {
    const raw = section.match(/<(?:h1|h2|h3)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|h3)>/i)?.[1] ?? "";
    return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  private async repairPublishedDeckFit(input: {
    outputDir: string;
    plan: AgentPlan;
    visual: VisualPlan;
    skill: SkillPack;
    files: Array<{ name: "index.html" | "preview.html" | "standalone.html"; html: string }>;
    activeConfig: ActiveModelConfig;
    agentInput: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    };
    research: ResearchPack;
    onCall: (usage?: any) => void;
    slideIssues: QaSlideFitIssue[];
  }) {
    const { outputDir, plan, visual, skill, files: currentFiles, activeConfig, agentInput, research, onCall, slideIssues } = input;
    const deckStyle = this.classifyDeckStyle(plan);
    let files = currentFiles;
    const indexFile = files.find((file) => file.name === "index.html");
    if (!indexFile) return { applied: false, files, repairedSlides: [] as number[] };

    const sections = this.extractSectionList(indexFile.html);
    const repairedSlides: number[] = [];
    // Same visual-DNA donor as Stage 05 so the repaired slide stays consistent
    // with the rest of the deck.
    const referenceFullDeckName = this.pickReferenceFullDeckName(visual, skill);
    const referenceFullDeck = referenceFullDeckName
      ? await this.readReferenceFullDeck(skill, referenceFullDeckName)
      : undefined;
    for (const slideIssue of slideIssues.slice(0, 2)) {
      const slide = plan.slides.find((item) => item.index === slideIssue.slideIndex);
      if (!slide) continue;
      const previousSection = sections[slideIssue.planOffset] ?? "";
      const layoutTemplate = await this.readSingleLayoutTemplate(skill.root, slide.layoutId);
      const sectionClassProtocol = this.buildSectionClassProtocol({
        layoutTemplates: `--- layoutId: ${slide.layoutId} ---\n${layoutTemplate}`,
        referenceFullDeck,
        skill
      });
      const singleRaw = await this.repairSingleSlideFromSkeleton({
        activeConfig,
        agentInput,
        plan,
        visual,
        research,
        skill,
        referenceFullDeck,
        slide,
        slideVisual: visual.slideVisuals.find((item) => item.index === slide.index),
        previousSection,
        issues: slideIssue.issues,
        allowedClassCatalog: sectionClassProtocol.promptCatalog,
        onCall,
        reserveRepairCall: () => undefined
      });
    const sanitizedSingle = this.sanitizeSectionBatchMarkup(
      this.extractSlideSections(singleRaw),
      [slide],
      sectionClassProtocol.allowedClasses,
      sectionClassProtocol.referenceContract,
      sectionClassProtocol.donorContract
    );
      const singleSections = this.extractSectionList(sanitizedSingle.html);
      const candidate = singleSections[0];
      if (singleSections.length !== 1 || !candidate) continue;
        const candidateQa = this.validateSectionBatch(candidate, [slide], skill, plan, deckStyle, sectionClassProtocol.donorContract);
        if (candidateQa.issues.length > 0) continue;
        if (this.estimateLandscapeFitIssues(candidate, slide, skill, plan, deckStyle).length > 0) continue;
      sections[slideIssue.planOffset] = candidate;
      repairedSlides.push(slide.index);
    }

    if (repairedSlides.length === 0) {
      return { applied: false, files, repairedSlides };
    }

    files = files.map((file) => ({
      ...file,
      html: this.healPublishedHtml(this.replaceSectionList(file.html, sections))
    }));
    await Promise.all(files.map((file) => writeFile(join(outputDir, file.name), file.html, "utf8")));
    return { applied: true, files, repairedSlides };
  }

  private async truncatePublishedDeckFit(input: {
    outputDir: string;
    plan: AgentPlan;
    visual: VisualPlan;
    skill: SkillPack;
    files: Array<{ name: "index.html" | "preview.html" | "standalone.html"; html: string }>;
    slideIssues: QaSlideFitIssue[];
  }) {
    const { outputDir, plan, skill, files: currentFiles, slideIssues } = input;
    const deckStyle = this.classifyDeckStyle(plan);
    const indexFile = currentFiles.find((file) => file.name === "index.html");
    if (!indexFile) {
      return { applied: false, files: currentFiles, truncatedSlides: [] as number[] };
    }

    const sections = this.extractSectionList(indexFile.html);
    const truncatedSlides: number[] = [];
    for (const slideIssue of slideIssues) {
      const slide = plan.slides.find((item) => item.index === slideIssue.slideIndex);
      if (!slide) continue;
      const currentSection = sections[slideIssue.planOffset];
      if (!currentSection) continue;
      const truncated = this.truncateSectionToDensityBudget(currentSection, slide, skill, plan, deckStyle);
      if (truncated !== currentSection) {
        sections[slideIssue.planOffset] = truncated;
        truncatedSlides.push(slide.index);
      }
    }

    if (truncatedSlides.length === 0) {
      return { applied: false, files: currentFiles, truncatedSlides };
    }

    const files = currentFiles.map((file) => ({
      ...file,
      html: this.healPublishedHtml(this.replaceSectionList(file.html, sections))
    }));
    await Promise.all(files.map((file) => writeFile(join(outputDir, file.name), file.html, "utf8")));
    return { applied: true, files, truncatedSlides };
  }

  private truncateSectionToDensityBudget(
    section: string,
    slide: AgentPlan["slides"][number],
    skill: SkillPack,
    plan?: AgentPlan,
    deckStyle: DeckStyleProfile = "balanced"
  ) {
    const layout = (skill.manifest?.layouts ?? []).find((item) => item.id === slide.layoutId);
    if (!layout?.densityBudget) return section;
    const titleText = this.extractFirstHeadingText(section);
    const visibleTextLength = this.visibleSlideText(section).length;
    const liCount = (section.match(/<li\b/gi) ?? []).length;
    const cardCount = (section.match(/<(?:div|article)\b[^>]*class=["'][^"']*\b(?:card|panel|metric-card|kpi-card|comparison-panel)\b[^"']*["'][^>]*>/gi) ?? []).length;
    const budget = this.computeDynamicLandscapeBudget({
      slide,
      titleText,
      visibleTextLength,
      liCount,
      cardCount,
      densityBudget: layout.densityBudget,
      sanity: layout.sanity,
      plan,
      deckStyle
    });

    let next = section;
    next = this.limitSectionListItems(next, budget.itemBudget);
    next = this.trimHeadingText(next, budget.titleBudget);
    next = this.trimLeafTextBudget(next, budget.textBudget);
    return next;
  }

  private limitSectionListItems(section: string, maxItems: number) {
    if (maxItems <= 0) return section;
    let seen = 0;
    return section.replace(/<li\b[\s\S]*?<\/li>/gi, (match) => {
      seen += 1;
      return seen <= maxItems ? match : "";
    });
  }

  private trimHeadingText(section: string, maxChars: number) {
    if (maxChars <= 0) return section;
    return section.replace(/<(h1|h2|h3)\b([^>]*)>([^<]*)<\/\1>/i, (_match, tag: string, attrs: string, text: string) => {
      const nextText = this.truncatePlainText(text, maxChars);
      return `<${tag}${attrs}>${nextText}</${tag}>`;
    });
  }

  private trimLeafTextBudget(section: string, maxBodyChars: number) {
    if (maxBodyChars <= 0) return section;
    let remaining = maxBodyChars;
    return section.replace(/<(p|li|span|small|strong)\b([^>]*)>([^<]*)<\/\1>/gi, (_match, tag: string, attrs: string, text: string) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return `<${tag}${attrs}>${text}</${tag}>`;
      const nextText = this.truncatePlainText(normalized, remaining);
      remaining = Math.max(0, remaining - nextText.length);
      return `<${tag}${attrs}>${nextText}</${tag}>`;
    });
  }

  private truncatePlainText(text: string, maxChars: number) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    if (maxChars <= 1) return normalized.slice(0, Math.max(0, maxChars));
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
  }

  private replaceSectionList(html: string, sections: string[]) {
    let index = 0;
    return html.replace(/<section\b[\s\S]*?<\/section>/gi, () => {
      const replacement = sections[index];
      index += 1;
      return replacement ?? "";
    });
  }

  private extractRelativeRefs(html: string) {
    const refs = new Set<string>();
    for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
      const ref = (match[1] ?? "").trim();
      if (!ref || /^https?:\/\//i.test(ref) || /^data:/i.test(ref) || /^javascript:/i.test(ref) || ref.startsWith("#")) continue;
      refs.add(ref);
    }
    return Array.from(refs);
  }

  private resolveHtmlRefToOutputPath(outputDir: string, ref: string) {
    if (ref.startsWith("./asset?path=")) {
      const encoded = ref.slice("./asset?path=".length);
      const assetPath = decodeURIComponent(encoded);
      return join(outputDir, "assets", assetPath);
    }
    if (ref.startsWith("./assets/")) {
      return join(outputDir, ref.slice(2));
    }
    if (ref.startsWith("./")) {
      return join(outputDir, ref.slice(2));
    }
    return null;
  }

  private extractAttrValues(html: string, attr: string) {
    return Array.from(html.matchAll(new RegExp(`\\s${attr}=["']([^"']+)["']`, "gi")))
      .map((match) => (match[1] ?? "").trim())
      .filter(Boolean);
  }

  private buildThemeContrastPatch(visual: VisualPlan, skill: SkillPack) {
    const theme = (skill.manifest?.themes ?? []).find((item) => item.id === visual.primaryTheme);
    if (!theme) return "";
    const palette = theme.palette;
    const surface2 = palette.surface2 || palette.surface;
    const declarations: string[] = [];
    const text1Ratio = this.contrastRatio(palette.text1, palette.bg);
    if (text1Ratio !== null && text1Ratio < 4.5) {
      declarations.push(`--text-1: ${this.bestReadableTextColor([palette.bg])};`);
    }

    const accentRatio = this.contrastRatio(palette.accent, palette.bg);
    if (accentRatio !== null && accentRatio < 4.5) {
      declarations.push(`--accent: ${this.bestReadableAccentColor(palette.bg)};`);
    }

    const uniqueDeclarations = Array.from(new Set(declarations));
    if (uniqueDeclarations.length === 0) return "";
    const deckClass = (visual.deckClass || "tpl-html-ppt-agent").replace(/[^a-z0-9_-]/gi, "-");
    return [
      "/* phase-3 theme contrast patch v1 */",
      `body.${deckClass}{`,
      ...uniqueDeclarations.map((declaration) => `  ${declaration}`),
      "}"
    ].join("\n");
  }

  private collectThemeContrastIssues(visual: VisualPlan, skill: SkillPack, healed = false) {
    if (healed) return [];
    const issues: string[] = [];
    const theme = (skill.manifest?.themes ?? []).find((item) => item.id === visual.primaryTheme);
    if (!theme) return issues;
    const palette = theme.palette;
    const surface2 = palette.surface2 || palette.surface;
    const checks = [
      { label: "--text-1 与 --bg", foreground: palette.text1, background: palette.bg, required: 4.5 },
      { label: "--text-2 与 --surface", foreground: palette.text2, background: palette.surface, required: 4.5 },
      { label: "--text-2 与 --surface-2", foreground: palette.text2, background: surface2, required: 4.5 },
      { label: "--accent 与 --bg", foreground: palette.accent, background: palette.bg, required: 4.5 }
    ].filter((check) => check.foreground && check.background);

    for (const check of checks) {
      const ratio = this.contrastRatio(check.foreground, check.background);
      if (ratio === null) {
        issues.push(`主题 ${visual.primaryTheme} 的 ${check.label} 无法解析，无法验证 WCAG 对比度`);
      } else if (ratio < check.required) {
        issues.push(`主题 ${visual.primaryTheme} 的 ${check.label} 对比度仅 ${ratio.toFixed(2)}，低于 WCAG AA ${check.required}`);
      }
    }
    return issues;
  }

  private bestReadableTextColor(backgrounds: string[]) {
    const candidates = ["#0b1220", "#f8fafc"];
    return this.pickHighestMinimumContrast(candidates, backgrounds) ?? "#0b1220";
  }

  private bestReadableAccentColor(background: string) {
    const candidates = ["#0f766e", "#2563eb", "#b91c1c", "#7c3aed", "#0369a1", "#f8fafc", "#0b1220"];
    return this.pickHighestMinimumContrast(candidates, [background]) ?? this.bestReadableTextColor([background]);
  }

  private pickHighestMinimumContrast(candidates: string[], backgrounds: string[]) {
    let best: { color: string; ratio: number } | null = null;
    for (const color of candidates) {
      const ratios = backgrounds
        .map((background) => this.contrastRatio(color, background))
        .filter((ratio): ratio is number => ratio !== null);
      if (ratios.length === 0) continue;
      const ratio = Math.min(...ratios);
      if (!best || ratio > best.ratio) best = { color, ratio };
    }
    return best?.color;
  }

  private collectCoverCloserParityIssues(indexHtml: string, plan: AgentPlan, visual: VisualPlan) {
    const issues: string[] = [];
    const sections = this.extractSectionList(indexHtml);
    if (sections.length < 2) return issues;
    const cover = sections[0] ?? "";
    const closer = sections[sections.length - 1] ?? "";
    if (!cover || !closer) return issues;

    const coverTreatment = this.extractHeadlineTreatment(cover);
    const closerTreatment = this.extractHeadlineTreatment(closer);
    if (coverTreatment !== "unknown" && closerTreatment !== "unknown" && coverTreatment !== closerTreatment) {
      issues.push(`封面与结尾标题风格不一致：封面 ${coverTreatment}，结尾 ${closerTreatment}；结尾页应沿用封面 headline treatment`);
    }

    const coverAnim = this.extractAnimationFamily(cover);
    const closerAnim = this.extractAnimationFamily(closer);
    if (coverAnim !== "none" && closerAnim !== "none" && coverAnim !== closerAnim) {
      issues.push(`封面与结尾入场动画家族不一致：封面 ${coverAnim}，结尾 ${closerAnim}`);
    }

    const coverFx = this.extractFxFamily(cover);
    const closerFx = this.extractFxFamily(closer);
    if (coverFx !== "none" && closerFx !== "none" && coverFx !== closerFx) {
      issues.push(`封面与结尾背景特效家族不一致：封面 ${coverFx}，结尾 ${closerFx}`);
    }

    const lastSlide = plan.slides[plan.slides.length - 1];
    if (lastSlide && /(?:thanks|cta|clos|结尾|总结)/i.test(`${lastSlide.layoutId} ${lastSlide.type}`) && !closer.includes(visual.deckClass)) {
      // The body carries deckClass, so this usually stays silent. It catches accidental
      // full-section donor pastes that inject a different tpl-* class onto the closer.
      const tplClass = closer.match(/\btpl-[a-z0-9_-]+\b/i)?.[0];
      if (tplClass && tplClass !== visual.deckClass) {
        issues.push(`结尾页混入了不同模板类 ${tplClass}，当前 deckClass 为 ${visual.deckClass}`);
      }
    }
    return issues;
  }

  private extractHeadlineTreatment(section: string) {
    const heading = section.match(/<(h1|h2)\b[^>]*>[\s\S]*?<\/\1>/i)?.[0] ?? "";
    if (!heading) return "unknown";
    if (/\b(?:gradient-text|xw-grad|grad|mega|text-gradient|clip-text)\b|background-clip|-webkit-text-fill-color/i.test(heading)) {
      return "gradient";
    }
    if (/\b(?:accent|highlight|mark|emphasis)\b/i.test(heading)) {
      return "accent";
    }
    return "solid";
  }

  private extractAnimationFamily(section: string) {
    const values = this.extractAttrValues(section, "data-anim");
    const value = (values[0] ?? "").toLowerCase();
    if (!value) return "none";
    if (/(?:fade|rise|zoom|slide|blur|reveal|pop|type)/.test(value)) return "entry";
    if (/(?:stagger|list)/.test(value)) return "stagger";
    if (/(?:float|pulse|loop|spin)/.test(value)) return "loop";
    return value;
  }

  private extractFxFamily(section: string) {
    const values = this.extractAttrValues(section, "data-fx");
    const value = (values.find((item) => !item.startsWith("to:")) ?? "").toLowerCase();
    if (!value) return "none";
    if (/(?:particle|spark|confetti|firework|star|snow)/.test(value)) return "particles";
    if (/(?:gradient|aurora|blob|glow|halo|mesh|light)/.test(value)) return "glow";
    if (/(?:grid|matrix|terminal|code|scan)/.test(value)) return "technical";
    return value;
  }

  private contrastRatio(foreground: string, background: string) {
    const fg = this.parseColor(foreground);
    const bg = this.parseColor(background);
    if (!fg || !bg) return null;
    const l1 = this.relativeLuminance(fg);
    const l2 = this.relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  private parseColor(color: string) {
    const value = color.trim().toLowerCase();
    const hex = value.replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      const [r = "0", g = "0", b = "0"] = hex.split("");
      return {
        r: parseInt(r + r, 16),
        g: parseInt(g + g, 16),
        b: parseInt(b + b, 16)
      };
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16)
      };
    }
    const rgb = value.match(/^rgba?\(([^)]+)\)$/i)?.[1]?.split(",").map((item) => Number(item.trim()));
    if (rgb && rgb.length >= 3 && rgb.slice(0, 3).every((item) => Number.isFinite(item))) {
      return { r: rgb[0] ?? 0, g: rgb[1] ?? 0, b: rgb[2] ?? 0 };
    }
    return null;
  }

  private relativeLuminance(color: { r: number; g: number; b: number }) {
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  private async collectPortabilityIssues(
    outputDir: string,
    files: Array<{ name: "index.html" | "preview.html" | "standalone.html"; html: string; stats: ReturnType<HtmlPptAgentService["htmlDeckStats"]> }>
  ) {
    const blocking: string[] = [];
    const advisory: string[] = [];
    const zipPath = join(outputDir, "html-ppt-deck.zip");
    const zipBuffer = await readFile(zipPath).catch(() => null);
    if (!zipBuffer || zipBuffer.length === 0) {
      blocking.push("html-ppt-deck.zip 不存在或为空");
      return { blocking, advisory };
    }
    const entryNames = new Set(this.readZipEntryNames(zipBuffer));
    if (entryNames.size === 0) {
      blocking.push("html-ppt-deck.zip 无法解析出任何 entry");
      return { blocking, advisory };
    }
    for (const expected of ["index.html", "style.css", "assets/base.css", "assets/runtime.js", "assets/edit-mode.js"]) {
      if (!entryNames.has(expected)) {
        blocking.push(`zip 缺少 ${expected}`);
      }
    }
    for (const file of files.filter((item) => item.name !== "preview.html")) {
      for (const ref of this.extractRelativeRefs(file.html)) {
        const resolved = this.resolveHtmlRefToOutputPath(outputDir, ref);
        if (!resolved) continue;
        const relativeRef = resolved.slice(outputDir.length + 1).replace(/\\/g, "/");
        if (!entryNames.has(relativeRef)) {
          if (/\.(?:html|css|js)$/i.test(relativeRef) || /assets\/(?:base|runtime|edit-mode)\.js$/i.test(relativeRef)) {
            blocking.push(`${file.name} 依赖 ${relativeRef}，但 zip 未包含该文件`);
          } else {
            advisory.push(`${file.name} 依赖 ${relativeRef}，但 zip 未包含该文件`);
          }
        }
      }
    }
    return { blocking, advisory };
  }

  private readZipEntryNames(buffer: Buffer) {
    const entries: string[] = [];
    let offset = 0;
    while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const nameEnd = nameStart + fileNameLength;
      entries.push(buffer.slice(nameStart, nameEnd).toString("utf8"));
      offset = nameEnd + extraLength + compressedSize;
    }
    return entries;
  }

  private async writeQaReportToManifest(outputDir: string, qaReport: QaReport) {
    const manifestPath = join(outputDir, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8")
      .then((content) => JSON.parse(content) as Record<string, unknown>)
      .catch(() => ({}));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, qaReport }, null, 2), "utf8");
  }

  private async writeGenerationTrace(outputDir: string, trace: Record<string, unknown>) {
    try {
      await writeFile(join(outputDir, "generation-trace.json"), JSON.stringify(trace, null, 2), "utf8");
    } catch (error) {
      this.logger.warn(`Failed to write HTML-PPT generation trace: ${this.describeError(error)}`);
    }
  }

  /**
   * Returns true if the CSS string contains a rule that sets position:relative/static/fixed
   * on a selector ending in .slide (e.g. `body.foo .slide { position: relative }`), which
   * would override the runtime's required `position: absolute` and break navigation.
   */
  private detectSlidePositionOverride(css: string): boolean {
    return this.findCssRules(css).some(({ selector, body }) =>
      this.selectorListTargetsSlideSelf(selector) && /\bposition\s*:\s*(relative|static|fixed)\b/i.test(body)
    );
  }

  private sanitizeGeneratedCss(css: string, allowedHtmlClasses?: Set<string>, protectedDonorClasses?: Set<string>) {
    const withoutUnsupportedAtRules = this.stripUnsupportedCssAtRules(css);
    return withoutUnsupportedAtRules.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector: string, body: string) => {
      if (this.selectorListTargetsProgressBar(selector)) return "";
      if (this.selectorListTargetsSlideDirectChild(selector)) return "";
      if (this.selectorListTargetsUnapprovedSlideSelf(selector)) return "";
      if (allowedHtmlClasses && this.selectorListTargetsUnknownHtmlClasses(selector, allowedHtmlClasses)) return "";

      let sanitizedBody = body;
      sanitizedBody = this.stripThemeOwnedTokenDeclarations(sanitizedBody);
      if (this.selectorListTargetsTemplateRoot(selector)) {
        sanitizedBody = this.stripTemplateRootThemeOverrides(sanitizedBody);
      }
      if (this.selectorListTargetsSlideSelf(selector)) {
        sanitizedBody = this.stripDisallowedSlideDeclarations(sanitizedBody);
      }
      if (protectedDonorClasses?.size && this.selectorListTargetsProtectedDonorClasses(selector, protectedDonorClasses)) {
        sanitizedBody = this.stripProtectedDonorStructureDeclarations(sanitizedBody);
      }

      const compactBody = sanitizedBody
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "")
        .replace(/^;+|;+$|\{\s*\}/g, "");

      if (!compactBody) return "";
      return `${selector}{${compactBody}}`;
    }).trim();
  }

  /**
   * Strips `position: relative/static/fixed` from any rule whose selector contains `.slide`.
   * Applied to model-generated CSS before the runtime guard is appended, as a defense layer.
   */
  private stripSlidePositionOverride(css: string): string {
    const normalized = this.stripRuntimeGuardCommentBlock(css).replace(/\/\*[\s\S]*?\*\//g, "");
    return normalized.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector: string, body: string) => {
      if (!this.selectorListTargetsSlideSelf(selector)) return match;
      const sanitized = body
        .replace(/\bposition\s*:\s*(relative|static|fixed)\s*(!important)?\s*;?/gi, "")
        .replace(/\s+/g, " ")
        .replace(/^\s+|\s+$/g, "")
        .replace(/^;+|;+$|\{\s*\}/g, "");
      return sanitized ? `${selector}{${sanitized}}` : "";
    });
  }

  private stripRuntimeGuardCommentBlock(css: string) {
    const start = css.indexOf("/* Runtime guard:");
    if (start < 0) return css;
    const importantAnchor = css.indexOf("position: absolute !important;", start);
    const ruleStart = importantAnchor >= 0 ? css.lastIndexOf(".deck > .slide {", importantAnchor) : css.indexOf(".deck > .slide {", start);
    if (ruleStart < 0) {
      return css.slice(0, start);
    }
    return `${css.slice(0, start)}${css.slice(ruleStart)}`;
  }

  private stripUnsupportedCssAtRules(css: string) {
    let next = css;
    for (const atRuleName of ["media", "supports"]) {
      next = this.stripAtRuleBlocks(next, atRuleName);
    }
    return next;
  }

  private stripAtRuleBlocks(css: string, atRuleName: string) {
    const pattern = new RegExp(`@${atRuleName}\\b`, "i");
    let next = css;
    let offset = 0;

    while (offset < next.length) {
      const match = pattern.exec(next.slice(offset));
      if (!match || match.index === undefined) break;
      const start = offset + match.index;
      const openBrace = next.indexOf("{", start);
      if (openBrace < 0) break;

      let depth = 1;
      let cursor = openBrace + 1;
      while (cursor < next.length && depth > 0) {
        const char = next[cursor];
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        cursor += 1;
      }

      const commentText = `\n/* @${atRuleName} removed by CSS sanitizer */\n`;
      next = `${next.slice(0, start)}${commentText}${next.slice(cursor)}`;
      offset = start + commentText.length;
    }

    return next;
  }

  private stripDisallowedSlideDeclarations(body: string) {
    return this.stripCssDeclarations(body, new Set(["position", "overflow", "overflow-x", "overflow-y"]));
  }

  private stripProtectedDonorStructureDeclarations(body: string) {
    return this.stripCssDeclarations(body, new Set([
      "position",
      "display",
      "width",
      "height",
      "min-width",
      "min-height",
      "max-width",
      "max-height",
      "top",
      "right",
      "bottom",
      "left",
      "inset",
      "inset-block",
      "inset-inline",
      "inset-block-start",
      "inset-block-end",
      "inset-inline-start",
      "inset-inline-end",
      "flex",
      "flex-basis",
      "flex-direction",
      "flex-grow",
      "flex-shrink",
      "flex-wrap",
      "grid-template-columns",
      "grid-template-rows",
      "grid-auto-flow",
      "grid-auto-columns",
      "grid-auto-rows",
      "justify-content",
      "align-items",
      "align-content",
      "place-items",
      "place-content",
      "padding",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "padding-inline",
      "padding-inline-start",
      "padding-inline-end",
      "padding-block",
      "padding-block-start",
      "padding-block-end",
      "margin",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "margin-inline",
      "margin-inline-start",
      "margin-inline-end",
      "margin-block",
      "margin-block-start",
      "margin-block-end",
      "gap",
      "row-gap",
      "column-gap"
    ]));
  }

  private stripThemeOwnedTokenDeclarations(body: string) {
    return this.stripCssDeclarations(body, new Set(this.themeOwnedCssVars().map((item) => item.toLowerCase())));
  }

  private stripTemplateRootThemeOverrides(body: string) {
    return this.stripCssDeclarations(
      this.stripThemeOwnedTokenDeclarations(body),
      new Set(["font-family"])
    );
  }

  private stripCssDeclarations(body: string, blockedProperties: Set<string>) {
    const declarations = this.splitCssDeclarations(body);
    const kept = declarations.filter((declaration) => {
      const property = this.extractCssDeclarationProperty(declaration);
      return !property || !blockedProperties.has(property);
    });
    return kept
      .join("; ")
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "")
      .replace(/^;+|;+$|\{\s*\}/g, "");
  }

  private splitCssDeclarations(body: string) {
    const declarations: string[] = [];
    let current = "";
    let depth = 0;
    let quote: "'" | "\"" | "" = "";

    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      const previous = index > 0 ? body[index - 1] : "";

      if (quote) {
        current += char;
        if (char === quote && previous !== "\\") {
          quote = "";
        }
        continue;
      }

      if (char === "'" || char === "\"") {
        quote = char as "'" | "\"";
        current += char;
        continue;
      }

      if (char === "(") {
        depth += 1;
        current += char;
        continue;
      }

      if (char === ")") {
        depth = Math.max(0, depth - 1);
        current += char;
        continue;
      }

      if (char === ";" && depth === 0) {
        if (current.trim()) declarations.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    if (current.trim()) declarations.push(current.trim());
    return declarations;
  }

  private extractCssDeclarationProperty(declaration: string) {
    const colonIndex = declaration.indexOf(":");
    if (colonIndex < 0) return "";
    return declaration.slice(0, colonIndex).trim().toLowerCase();
  }

  private findCssRules(css: string) {
    const rules: Array<{ selector: string; body: string }> = [];
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ selector: match[1] ?? "", body: match[2] ?? "" });
    }
    return rules;
  }

  private selectorListTargetsSlideSelf(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => this.selectorTargetsSlideSelf(selector));
  }

  private selectorListTargetsProgressBar(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => /\.progress-bar\b/i.test(selector));
  }

  private selectorListTargetsSlideDirectChild(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => this.selectorTargetsSlideDirectChild(selector));
  }

  private selectorListTargetsUnapprovedSlideSelf(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => this.selectorTargetsSlideSelf(selector) && !this.selectorTargetsApprovedSlideSelf(selector));
  }

  private selectorListTargetsUnknownHtmlClasses(selectorList: string, allowedHtmlClasses: Set<string>) {
    const runtimeClasses = this.runtimeClassTokens();
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) =>
        this.extractClassTokensFromSelector(selector).some((token) => !allowedHtmlClasses.has(token) && !runtimeClasses.has(token))
      );
  }

  private selectorListTargetsProtectedDonorClasses(selectorList: string, protectedDonorClasses: Set<string>) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) =>
        this.extractClassTokensFromSelector(selector).some((token) => protectedDonorClasses.has(token))
      );
  }

  private selectorListTargetsTemplateRoot(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => this.selectorTargetsTemplateRoot(selector));
  }

  private selectorTargetsTemplateRoot(selector: string) {
    const normalized = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return /^body\.tpl-[\w-]+(?:::[\w-]+)?$/i.test(normalized) || /^\.tpl-[\w-]+(?:::[\w-]+)?$/i.test(normalized);
  }

  private selectorTargetsSlideSelf(selector: string) {
    const normalized = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const slideMatch = /\.slide\b/gi;
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = slideMatch.exec(normalized))) {
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < 0) return false;

    const afterSlide = normalized.slice(lastIndex).trim();
    if (!afterSlide) return true;
    if (/^(?:::(?:before|after|marker|selection|backdrop|first-line|first-letter)|:(?:before|after|marker|selection|backdrop|first-line|first-letter)\b)/i.test(afterSlide)) {
      return false;
    }

    // Allow only same-element modifiers after `.slide`: `.is-active`, `[data-x]`, `:hover`.
    // Descendant/combinator selectors like `.slide > *` or `.slide .card` are not slide-self rules.
    return /^(?:\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*$/.test(afterSlide);
  }

  private selectorTargetsSlideDirectChild(selector: string) {
    const normalized = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return /\.slide\b(?:\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*\s*>\s*/i.test(normalized);
  }

  private selectorTargetsApprovedSlideSelf(selector: string) {
    const normalized = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return /\.slide\b(?=[^,{]*\.cover\b)[^,{]*(?:::(?:before|after))?$/i.test(normalized);
  }

  private htmlDeckStats(html: string) {
    const deckMatch = /<div\b[^>]*class=(["'])[^"']*\bdeck\b[^"']*\1[^>]*>/i.exec(html);
    const firstProgressMatch = /<div\b[^>]*class=(["'])[^"']*\bprogress-bar\b[^"']*\1[^>]*>/i.exec(html);
    const runtimeProgressMatch = /<div\b[^>]*class=(["'])[^"']*\bprogress-bar\b[^"']*\1[^>]*>\s*<span\b[^>]*>\s*<\/span>\s*<\/div>/i.exec(html);
    return {
      slides: (html.match(/<section\b[^>]*class=["'][^"']*\bslide\b[^"']*["'][^>]*>/gi) ?? []).length,
      activeSlides: (html.match(/<section\b[^>]*class=["'][^"']*\bslide\b[^"']*\bis-active\b[^"']*["'][^>]*>/gi) ?? []).length,
      notes: (html.match(/<(?:div|aside)\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>/gi) ?? []).length,
      unsafeMetricFx: (html.match(/<[^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*\sdata-fx=/gi) ?? []).length,
      unresolvedMetricCounts: (html.match(/<([a-z0-9-]+)\b[^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*\sdata-count=["'][^"']+["'][^>]*>\s*0(?:[.,]0+)?\s*<\/\1>/gi) ?? []).length,
      chineseChars: (html.match(/[\u4e00-\u9fff]/g) ?? []).length,
      inlineThemes: html.includes("inline-theme-registry"),
      runtimeProgressBeforeDeck: Boolean(runtimeProgressMatch && deckMatch && runtimeProgressMatch.index < deckMatch.index),
      firstProgressIsRuntime: Boolean(firstProgressMatch && runtimeProgressMatch && firstProgressMatch.index === runtimeProgressMatch.index)
    };
  }

  private async generateStyleCss(
    activeConfig: ActiveModelConfig,
    plan: AgentPlan,
    visual: VisualPlan,
    indexHtml: string,
    skill: SkillPack,
    onCall: () => void,
    priorFailures: string[] = [],
    logContextBase?: ModelLogContext
  ) {
    const selectedThemePalette = await this.readThemePalettePrompt(skill, visual.primaryTheme);
    const htmlClassCatalog = this.htmlClassCatalogForPrompt(indexHtml);
    const allowedHtmlClasses = new Set(this.extractClassTokensFromMarkup(indexHtml));
    const referenceSemanticBaseline = await this.buildReferenceSemanticBaselineCss(skill, visual, allowedHtmlClasses);
    const prompt = buildPrompt("css", {
      userContextText: "",
      skill,
      plan,
      visual,
      indexHtmlSummary: this.indexSummaryForCss(indexHtml),
      existingClassCatalog: htmlClassCatalog,
      layoutContract: this.layoutContract(),
      selectedThemePalette,
      priorFailures
    });

    try {
      const value = await this.modelText(activeConfig, prompt.system, prompt.user, onCall, {
        ...(logContextBase ?? {}),
        source: logContextBase?.source ?? "html-ppt-agent",
        stage: "06-generate-style"
      });
      if (!value.includes("{") || !value.includes("}")) throw new ServiceUnavailableException("style.css 内容不完整。");
      const sanitized = this.sanitizeGeneratedCss(value, allowedHtmlClasses, referenceSemanticBaseline.protectedClassTokens);
      const stabilized = this.appendReferenceSemanticBaseline(sanitized, referenceSemanticBaseline.css);
      const guarded = this.appendRuntimeCssGuard(stabilized);
      return { value: guarded, detail: `style.css 生成完成：${guarded.length} 字符。` };
    } catch (error) {
      const stabilized = this.appendReferenceSemanticBaseline(this.fallbackStyleCss(visual), referenceSemanticBaseline.css);
      const guarded = this.appendRuntimeCssGuard(stabilized);
      return {
        value: guarded,
        detail: `style.css 模型调用失败，已使用本地稳定样式继续打包。原因：${this.describeError(error)}`
      };
    }
  }

  private appendReferenceSemanticBaseline(css: string, baselineCss: string) {
    if (!baselineCss.trim()) return css;
    return `${css.trim()}\n\n/* reference semantic baseline */\n${baselineCss.trim()}`;
  }

  private async buildReferenceSemanticBaselineCss(skill: SkillPack, visual: VisualPlan, htmlClasses: Set<string>) {
    const referenceFullDeckName = this.pickReferenceFullDeckName(visual, skill);
    if (!referenceFullDeckName) return { css: "", protectedClassTokens: new Set<string>() };
    const referenceCss = await readFile(join(skill.root, "templates", "full-decks", referenceFullDeckName, "style.css"), "utf8").catch(() => "");
    if (!referenceCss.trim()) return { css: "", protectedClassTokens: new Set<string>() };

    const rules = this.findCssRules(referenceCss);
    const selectedRules: string[] = [];
    const protectedClassTokens = new Set<string>();
    for (const { selector, body } of rules) {
      const selectorClasses = this.extractClassTokensFromSelector(selector);
      if (selectorClasses.length === 0) continue;
      if (selectorClasses.some((token) => this.runtimeClassTokens().has(token))) continue;
      if (/\.slide\b|\.deck\b|\.progress-bar\b/i.test(selector)) continue;
      if (selectorClasses.every((token) => !htmlClasses.has(token))) continue;
      selectorClasses
        .filter((token) => htmlClasses.has(token) && token !== visual.deckClass)
        .forEach((token) => protectedClassTokens.add(token));
      const normalizedSelector = this.normalizeReferenceBaselineSelector(selector, visual.deckClass);
      let compactBody = this.stripThemeOwnedTokenDeclarations(body.replace(/\s+/g, " ").trim());
      if (this.selectorListTargetsTemplateRoot(normalizedSelector)) {
        compactBody = this.stripTemplateRootThemeOverrides(compactBody);
      }
      if (!compactBody) continue;
      selectedRules.push(`${normalizedSelector}{${compactBody}}`);
    }

    return {
      css: Array.from(new Set(selectedRules)).join("\n"),
      protectedClassTokens
    };
  }

  private normalizeReferenceBaselineSelector(selector: string, deckClass: string) {
    return selector
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        if (trimmed.startsWith(`body.${deckClass}`)) return trimmed;
        if (trimmed.startsWith(`.${deckClass}`)) return `body${trimmed}`;
        return trimmed;
      })
      .join(", ");
  }

  private indexSummaryForCss(indexHtml: string) {
    const sections = indexHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    return sections.map((section, index) => {
      const title = section.match(/\bdata-title=["']([^"']+)["']/i)?.[1] ?? `Slide ${index + 1}`;
      const sectionClass = section.match(/<section\b[^>]*class=["']([^"']+)["']/i)?.[1] ?? "slide";
      const classes = Array.from(new Set([...section.matchAll(/\bclass=["']([^"']+)["']/gi)].flatMap((match) => (match[1] ?? "").split(/\s+/)))).filter(Boolean).slice(0, 30);
      const textLength = this.visibleSlideText(section).length;
      const styleCount = (section.match(/\sstyle=/gi) ?? []).length;
      return `${index + 1}. title=${title}; sectionClass=${sectionClass}; text=${textLength}; inlineStyle=${styleCount}; classes=${classes.join(",")}`;
    }).join("\n").slice(0, 9000);
  }

  private htmlClassCatalogForPrompt(indexHtml: string) {
    const classCounts = new Map<string, number>();
    for (const match of indexHtml.matchAll(/\bclass=["']([^"']+)["']/gi)) {
      for (const token of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
        classCounts.set(token, (classCounts.get(token) ?? 0) + 1);
      }
    }
    return Array.from(classCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([token, count]) => `${token} x${count}`)
      .join(", ")
      .slice(0, 4000);
  }

  private async readThemePalettePrompt(skill: SkillPack, theme: string) {
    const palette = skill.manifest?.themes.find((item) => item.id === theme)?.palette;
    if (palette) {
      const values = [
        `bg=${palette.bg}`,
        `surface=${palette.surface}`,
        `accent=${palette.accent}`,
        `text1=${palette.text1}`,
        `text2=${palette.text2}`,
        `border=${palette.border}`
      ].filter((item) => !item.endsWith("="));
      return values.length > 0 ? `${theme}: ${values.join(", ")}` : "";
    }

    const css = await readFile(join(skill.root, "assets", "themes", `${theme}.css`), "utf8").catch(() => "");
    if (!css) return "";
    const vars = Object.fromEntries(
      Array.from(css.matchAll(/(--[\w-]+)\s*:\s*([^;}\n]+)/g))
        .map((match) => [match[1] ?? "", (match[2] ?? "").trim()])
        .filter(([key, value]) => Boolean(key) && Boolean(value))
    );
    const fallbackValues = [
      `bg=${vars["--bg"] ?? ""}`,
      `surface=${vars["--surface"] ?? ""}`,
      `accent=${vars["--accent"] ?? ""}`,
      `text1=${vars["--text-1"] ?? ""}`,
      `text2=${vars["--text-2"] ?? ""}`,
      `border=${vars["--border"] ?? ""}`
    ].filter((item) => !item.endsWith("="));
    return fallbackValues.length > 0 ? `${theme}: ${fallbackValues.join(", ")}` : "";
  }

  private fallbackStyleCss(visual: VisualPlan) {
    const deckClass = visual.deckClass || "tpl-html-ppt-agent";
    return [
      `body.${deckClass} {`,
      "  --yy-glow: color-mix(in srgb, var(--accent) 24%, transparent);",
      "  font-family: var(--font-sans);",
      "  color: var(--text-1);",
      "}",
      `body.${deckClass} .deck {`,
      "  background:",
      "    radial-gradient(circle at 12% 18%, var(--yy-glow), transparent 30%),",
      "    radial-gradient(circle at 86% 12%, color-mix(in srgb, var(--accent-2, var(--accent)) 18%, transparent), transparent 32%),",
      "    linear-gradient(135deg, var(--bg), color-mix(in srgb, var(--surface) 46%, var(--bg)));",
      "}",
      `body.${deckClass} .slide {`,
      "  padding: clamp(38px, 5vw, 72px);",
      "}",
      `body.${deckClass} .slide::before {`,
      "  content: '';",
      "  position: absolute;",
      "  inset: 24px;",
      "  border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--border));",
      "  border-radius: 34px;",
      "  pointer-events: none;",
      "  opacity: .7;",
      "}",
      `body.${deckClass} .kicker, body.${deckClass} .eyebrow {`,
      "  color: var(--accent);",
      "  font-weight: 900;",
      "  letter-spacing: .12em;",
      "  text-transform: uppercase;",
      "}",
      `body.${deckClass} .h1 { font-size: clamp(54px, 7vw, 94px); line-height: .98; letter-spacing: -.06em; }`,
      `body.${deckClass} .h2 { font-size: clamp(34px, 4vw, 56px); line-height: 1.08; letter-spacing: -.04em; }`,
      `body.${deckClass} .h3, body.${deckClass} h3 { font-size: clamp(22px, 2.4vw, 32px); line-height: 1.18; }`,
      `body.${deckClass} .lede { max-width: 820px; color: var(--text-2); font-size: clamp(18px, 1.8vw, 24px); line-height: 1.55; }`,
      `body.${deckClass} .card, body.${deckClass} .panel, body.${deckClass} .metric-card, body.${deckClass} .kpi-card {`,
      "  border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border));",
      "  background: color-mix(in srgb, var(--surface) 86%, transparent);",
      "  box-shadow: 0 22px 70px rgba(15, 23, 42, .12);",
      "  border-radius: 24px;",
      "}",
      `body.${deckClass} .grid { display: grid; gap: clamp(14px, 1.6vw, 24px); }`,
      `body.${deckClass} .grid.g2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }`,
      `body.${deckClass} .grid.g3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }`,
      `body.${deckClass} .grid.g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }`,
      `body.${deckClass} .card { padding: clamp(18px, 2vw, 30px); }`,
      `body.${deckClass} .card p, body.${deckClass} li { color: var(--text-2); font-size: clamp(15px, 1.25vw, 18px); line-height: 1.46; }`,
      `body.${deckClass} .timeline, body.${deckClass} .tl, body.${deckClass} .roadmap, body.${deckClass} .flow { max-height: 66vh; }`,
      `body.${deckClass} canvas { width: 100% !important; height: 100% !important; }`,
      `body.${deckClass} .notes { display: none; }`
    ].join("\n");
  }

  private themeOwnedCssVars() {
    return [
      "--bg",
      "--bg-soft",
      "--surface",
      "--surface-2",
      "--border",
      "--border-strong",
      "--text-1",
      "--text-2",
      "--text-3",
      "--accent",
      "--accent-2",
      "--accent-3",
      "--good",
      "--warn",
      "--bad",
      "--grad",
      "--grad-soft",
      "--radius",
      "--radius-sm",
      "--radius-lg",
      "--shadow",
      "--shadow-lg",
      "--font-sans",
      "--font-serif",
      "--font-display"
    ];
  }

  private escapeHtml(input: string) {
    return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapeAttr(input: string) {
    return this.escapeHtml(input).replace(/"/g, "&quot;");
  }

  private escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private appendRuntimeCssGuard(css: string) {
    return [
      css.trim(),
      "",
      "/* Runtime guard: keep html-ppt slide navigation functional.",
      "   !important on position/opacity/pointer-events prevents model-generated",
      "   slide-position overrides from breaking deck navigation. */",
      ".deck > .slide {",
      "  position: absolute !important;",
      "  inset: 0;",
      "  width: 100vw;",
      "  height: 100vh;",
      "  opacity: 0 !important;",
      "  visibility: hidden !important;",
      "  animation: none !important;",
      "  pointer-events: none !important;",
      "  transform: translateX(30px);",
      "}",
      ".deck > .slide.is-active {",
      "  opacity: 1 !important;",
      "  visibility: visible !important;",
      "  pointer-events: auto !important;",
      "  transform: translateX(0);",
      "  z-index: 2;",
      "}",
      ".deck > .slide:not(.is-active) {",
      "  opacity: 0 !important;",
      "  visibility: hidden !important;",
      "  animation: none !important;",
      "}",
      ".deck > .slide.is-prev {",
      "  transform: translateX(-30px);",
      "}",
      "body > .progress-bar {",
      "  position: fixed !important;",
      "  left: 0 !important;",
      "  right: 0 !important;",
      "  bottom: 0 !important;",
      "  width: 100vw !important;",
      "  height: 3px !important;",
      "  z-index: 10000 !important;",
      "  background: transparent !important;",
      "  border: 0 !important;",
      "  border-radius: 0 !important;",
      "  padding: 0 !important;",
      "  overflow: hidden !important;",
      "  pointer-events: none !important;",
      "}",
      "body > .progress-bar > span {",
      "  display: block !important;",
      "  width: 0;",
      "  height: 100% !important;",
      "  background: var(--accent) !important;",
      "  border-radius: 0 !important;",
      "  transition: width .3s var(--ease, ease) !important;",
      "}",
      "",
      "/* Fit guard: reduce accidental document-flow overflow inside generated slides. */",
      ".deck > .slide {",
      "  box-sizing: border-box;",
      "  overflow: hidden;",
      "}",
      ".deck > .slide > :where(.deck-header, .deck-footer, .slide-number) {",
      "  min-height: 0 !important;",
      "  height: auto !important;",
      "}",
      ".deck > .slide *,",
      ".deck > .slide *::before,",
      ".deck > .slide *::after {",
      "  box-sizing: border-box;",
      "}",
      ".deck > .slide :where(.grid, .card, .panel, .metric-card, .kpi-card, .insight-card, .outlook-item, .metrics-dashboard, .core-insights, .future-outlook) {",
      "  min-width: 0;",
      "  min-height: 0;",
      "}",
      ".deck > .slide :where(h1, h2, h3, h4, p, li, strong, span) {",
      "  overflow-wrap: anywhere;",
      "}",
      ".deck > .slide :where(.notes) {",
      "  display: none !important;",
      "}",
      ".deck > .slide :where(.comp-table) {",
      "  table-layout: fixed;",
      "  font-size: clamp(10px, .88vw, 14px);",
      "  max-height: min(60vh, 470px);",
      "  overflow: hidden;",
      "}",
      ".deck > .slide :where(.comp-header-row, .comp-data-row) {",
      "  display: grid;",
      "  grid-template-columns: minmax(78px, .65fr) repeat(4, minmax(0, 1fr));",
      "  align-items: stretch;",
      "}",
      ".deck > .slide :where(.comp-table th, .comp-table td, .comp-header-row th, .comp-header-cell, .comp-label-cell, .comp-data-cell) {",
      "  min-width: 0;",
      "  padding: clamp(6px, .75vw, 12px);",
      "  line-height: 1.24;",
      "}",
      ".deck > .slide :where(.comp-primary, .comp-sub) {",
      "  display: block;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "}",
      ".deck > .slide :where(.comp-sub) {",
      "  font-size: .82em;",
      "  line-height: 1.18;",
      "}",
      ".deck > .slide :where(.grid.g3, .grid.g4) {",
      "  gap: clamp(10px, 1.1vw, 18px);",
      "}",
      ".deck > .slide :where(.metrics-row) {",
      "  display: grid;",
      "  grid-template-columns: repeat(2, minmax(0, 1fr));",
      "  gap: clamp(8px, 1vw, 14px);",
      "  align-items: start;",
      "}",
      ".deck > .slide :where(.metric-large, .metric-number) {",
      "  display: inline-flex;",
      "  align-items: baseline;",
      "  gap: .06em;",
      "  max-width: 100%;",
      "  font-size: clamp(34px, 4.3vw, 58px);",
      "  line-height: .92;",
      "}",
      ".deck > .slide :where(.metric-large .dim, .metric-number .dim, .metric-unit) {",
      "  flex: 0 0 auto;",
      "  font-size: .42em;",
      "  line-height: 1;",
      "}",
      ".deck > .slide :where(.card, .panel, .metric-card, .kpi-card) {",
      "  overflow: hidden;",
      "}",
      ".deck > .slide :where(.highlight-bar) {",
      "  max-height: 62px;",
      "  overflow: hidden;",
      "  padding: clamp(7px, .8vw, 11px);",
      "  margin-top: clamp(10px, 1vw, 16px);",
      "}",
      ".deck > .slide :where(.highlight-bar h4) {",
      "  font-size: clamp(14px, 1.05vw, 18px);",
      "  line-height: 1.15;",
      "}",
      ".deck > .slide :where(.highlight-bar h4, .highlight-bar p) {",
      "  margin-top: 0;",
      "  margin-bottom: 0;",
      "}",
      ".deck > .slide :where(.highlight-bar p) {",
      "  font-size: clamp(11px, .85vw, 13px);",
      "  line-height: 1.15;",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "}",
      ".deck > .slide :where(.highlight-bar .badge) {",
      "  transform: scale(.88);",
      "  transform-origin: right center;",
      "}",
      ".deck > .slide :where(.small, .dim.small) {",
      "  font-size: clamp(11px, .9vw, 13px);",
      "  line-height: 1.25;",
      "}",
      ".deck > .slide:has(.arch) {",
      "  justify-content: flex-start !important;",
      "  padding-top: clamp(28px, 4vh, 48px) !important;",
      "}",
      ".deck > .slide:has(.arch) > [style*=\"margin:auto\"] {",
      "  margin: 0 !important;",
      "}",
      ".deck > .slide:has(.arch) :where(.dk-keyhint) {",
      "  display: none !important;",
      "}",
      ".deck > .slide :where(.arch) {",
      "  overflow: visible !important;",
      "  gap: clamp(7px, .8vw, 12px) !important;",
      "  padding: clamp(4px, .55vw, 8px) 0 !important;",
      "  will-change: transform;",
      "}",
      ".deck > .slide :where(.arch .tier:has(.tname):has(.cells)) {",
      "  display: grid !important;",
      "  grid-template-columns: minmax(96px, 12vw) 1fr !important;",
      "  gap: clamp(8px, .75vw, 12px) !important;",
      "  align-items: stretch !important;",
      "  min-height: 0 !important;",
      "}",
      ".deck > .slide :where(.arch .tname) {",
      "  min-width: 0 !important;",
      "  padding: clamp(6px, .62vw, 10px) !important;",
      "  font-size: clamp(10px, .82vw, 13px) !important;",
      "  line-height: 1.16 !important;",
      "}",
      ".deck > .slide :where(.arch .cells) {",
      "  gap: clamp(6px, .65vw, 9px) !important;",
      "  min-height: 0 !important;",
      "  align-items: stretch !important;",
      "}",
      ".deck > .slide :where(.arch .cell) {",
      "  display: flex !important;",
      "  flex-direction: column !important;",
      "  align-items: center !important;",
      "  justify-content: center !important;",
      "  min-height: 0 !important;",
      "  padding: clamp(7px, .7vw, 10px) !important;",
      "  overflow: visible !important;",
      "}",
      ".deck > .slide :where(.arch .ic) {",
      "  width: clamp(22px, 2vw, 30px) !important;",
      "  height: clamp(22px, 2vw, 30px) !important;",
      "  font-size: clamp(11px, .95vw, 15px) !important;",
      "  margin-bottom: clamp(2px, .28vw, 4px) !important;",
      "}",
      ".deck > .slide :where(.arch h4) {",
      "  font-size: clamp(10px, .95vw, 14px) !important;",
      "  line-height: 1.12 !important;",
      "  margin: 0 0 clamp(2px, .28vw, 4px) !important;",
      "}",
      ".deck > .slide :where(.arch p) {",
      "  font-size: clamp(9px, .78vw, 11px) !important;",
      "  line-height: 1.12 !important;",
      "  margin: 0 !important;",
      "}",
      ".deck > .slide :where(.cta-tagline.gradient-text, .cta-lede.gradient-text) {",
      "  background: none !important;",
      "  -webkit-background-clip: border-box !important;",
      "  background-clip: border-box !important;",
      "  -webkit-text-fill-color: currentColor !important;",
      "  color: var(--text-1) !important;",
      "}",
      ".deck > .slide :where(.xw-title:not(.xw-grad), .xw-title-md:not(.xw-grad)) {",
      "  background: none !important;",
      "  -webkit-background-clip: border-box !important;",
      "  background-clip: border-box !important;",
      "  -webkit-text-fill-color: currentColor !important;",
      "  color: var(--xw-ink, var(--text-1, inherit)) !important;",
      "}"
    ].join("\n");
  }

  private summarySpec(plan: AgentPlan, visual: VisualPlan, slideCount: number, chineseChars: number): PptDeckSpec {
    return {
      schemaVersion: "2.0",
      title: plan.title,
      subtitle: plan.subtitle,
      language: "zh-CN",
      template: "html-ppt-agent",
      theme: visual.primaryTheme,
      audience: plan.audience,
      goal: plan.objective,
      visualSystem: {
        density: "dense",
        tone: visual.visualLanguage,
        backupThemes: visual.backupThemes,
        customStyleHints: [`deckClass:${visual.deckClass}`, `agentSlides:${slideCount}`, `chineseChars:${chineseChars}`]
      },
      slides: plan.slides.map((slide, index) => ({
        id: `slide-${index + 1}`,
        type: index === 0 ? "cover" : index === plan.slides.length - 1 ? "closing" : "content",
        layout: this.toSpecLayout(slide.layoutId, index, plan.slides.length),
        title: slide.title,
        body: slide.keyPoints,
        blocks: [],
        visualPrompt: visual.slideVisuals.find((item) => item.index === slide.index)?.composition,
        animation: { preset: visual.slideVisuals.find((item) => item.index === slide.index)?.animation ?? "fade-up", intensity: "standard" }
      }))
    };
  }

  private normalizePlan(
    input: unknown,
    fallbackTitle: string,
    skill: SkillPack,
    requestRequirements?: DeckRequestRequirements
  ): AgentPlan {
    const c = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const rawSlides = Array.isArray(c.slides) ? c.slides : [];
    const slides = rawSlides.map((item, index) => {
      const s = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const type = this.str(s.type, "content");
      return {
        index: this.num(s.index, index + 1),
        title: this.str(s.title, `第 ${index + 1} 页`),
        type,
        layoutId: this.normalizeLayoutId(this.str(s.layoutId, ""), type, index, rawSlides.length, skill.layoutNames),
        goal: this.str(s.goal, ""),
        keyPoints: this.strings(s.keyPoints)
      };
    });
    const tone = this.normalizePlanTone(this.opt(c.tone), fallbackTitle);
    const format = this.normalizePlanFormat(this.opt(c.format), requestRequirements);
    const finalSlides = this.finalizePlanSlides(
      slides.length ? slides : [{ index: 1, title: this.str(c.title, fallbackTitle), type: "cover", layoutId: "cover", goal: "封面", keyPoints: [] }],
      skill,
      requestRequirements
    );
    return {
      title: this.str(c.title, fallbackTitle).slice(0, 80),
      subtitle: this.opt(c.subtitle),
      slideCount: finalSlides.length,
      audience: this.str(c.audience, "普通观众"),
      tone,
      format,
      objective: this.str(c.objective, "生成 HTML-PPT"),
      slides: finalSlides
    };
  }

  private normalizePlanTone(rawTone?: string, fallbackText = "") {
    const value = (rawTone ?? "").trim().toLowerCase();
    if ((PLAN_TONES as readonly string[]).includes(value)) return value;
    const signal = `${value} ${fallbackText}`.toLowerCase();
    const chineseSignal = `${rawTone ?? ""} ${fallbackText}`;
    if (/cyber|sci-fi|gaming|game|neon|terminal|hacker|nightlife|赛博|科幻|游戏|电竞|霓虹|终端|黑客/i.test(signal) || /赛博|科幻|游戏|电竞|霓虹|终端|黑客/.test(chineseSignal)) return "cyber";
    if (/academic|research|paper|methodology|scientific|theory|教学|课程|研究|学术|论文|方法论|理论|讲解|探讨/.test(signal) || /教学|课程|研究|学术|论文|方法论|理论|讲解|探讨/.test(chineseSignal)) return "academic";
    if (/enterprise|strategy|executive|corporate|board|investor|b2b|企业|战略|高管|管理层|董事会|商业汇报/.test(signal) || /企业|战略|高管|管理层|董事会|商业汇报/.test(chineseSignal)) return "enterprise";
    if (/documentary|history|news|journalism|reportage|纪实|历史|新闻|纪录|调查|观察/.test(signal) || /纪实|历史|新闻|纪录|调查|观察/.test(chineseSignal)) return "documentary";
    if (/lifestyle|wellbeing|consumer|travel|food|home|小红书|生活方式|消费|健康|旅行|美食|家居/.test(signal) || /小红书|生活方式|消费|健康|旅行|美食|家居/.test(chineseSignal)) return "lifestyle";
    if (/playful|fun|kids|toy|culture|meme|趣味|儿童|玩具|潮流|梗|轻松/.test(signal) || /趣味|儿童|玩具|潮流|轻松/.test(chineseSignal)) return "playful";
    if (/energetic|launch|pitch|vc|sales|growth|campaign|发布|路演|融资|增长|营销|动员/.test(signal) || /发布|路演|融资|增长|营销|动员/.test(chineseSignal)) return "energetic";
    if (/clinical|medical|healthcare|risk|compliance|policy|医疗|临床|合规|风控|政策|严肃/.test(signal) || /医疗|临床|合规|风控|政策|严肃/.test(chineseSignal)) return "clinical";
    if (/friendly|onboarding|guide|tutorial|intro|入门|指南|教程|说明|介绍/.test(signal) || /入门|指南|教程|说明|介绍/.test(chineseSignal)) return "friendly";
    return "editorial";
  }

  private normalizePlanFormat(rawFormat?: string, requestRequirements?: DeckRequestRequirements) {
    const value = (rawFormat ?? "").trim().toLowerCase();
    if ((PLAN_FORMATS as readonly string[]).includes(value)) return value;
    const signal = value;
    if (/xhs|xiaohongshu|小红书|图文/.test(signal)) return "xhs-image";
    if (/handout|pdf|document|文档|资料/.test(signal)) return "pdf-handout";
    if (/internal|memo|内部|备忘/.test(signal)) return "internal-memo";
    if (/keynote|launch|发布会/.test(signal)) return "keynote";
    if (/web|share|网页|分享/.test(signal)) return "web-share";
    if (requestRequirements?.requestedNarrativeLength && requestRequirements.requestedNarrativeLength >= 1600) return "pdf-handout";
    return "live-talk";
  }

  private finalizePlanSlides(
    slides: AgentPlan["slides"],
    skill: SkillPack,
    requestRequirements?: DeckRequestRequirements
  ): AgentPlan["slides"] {
    const withSectionRhythm = this.applySectionDividerPolicy(slides, skill, requestRequirements);
    const densityBalanced = this.applyNarrativeDensityPolicy(withSectionRhythm, skill, requestRequirements);
    return densityBalanced.map((slide, index) => ({ ...slide, index: index + 1 }));
  }

  /**
   * Safety net for the skill authoring guide rule "decks with > 6 body slides
   * need section-divider breaks." If the model produced a long deck without
   * any divider, inject 1-2 dividers between body partitions and renumber.
   *
   * - "Body slides" means anything that is not cover/toc/cta/thanks/section-divider.
   * - 5-8 body slides -> 1 divider at the midpoint.
   * - 9-12 body slides -> 2 dividers at thirds.
   * - 13+ body slides -> 3 dividers at quarters.
   * - Existing dividers are preserved; we only add when none exist.
   */
  private applySectionDividerPolicy(
    slides: AgentPlan["slides"],
    skill: SkillPack,
    requestRequirements?: DeckRequestRequirements
  ): AgentPlan["slides"] {
    if (requestRequirements?.requestedSlideCount) {
      return slides;
    }
    if (!skill.layoutNames.includes("section-divider")) return slides;

    const sparseLayouts = new Set(["cover", "toc", "cta", "thanks", "section-divider"]);
    const isBody = (slide: AgentPlan["slides"][number]) => !sparseLayouts.has(slide.layoutId);
    const hasDivider = slides.some((slide) => slide.layoutId === "section-divider");
    if (hasDivider) return slides;

    const bodyCount = slides.filter(isBody).length;
    if (bodyCount < 5) return slides;

    const dividerCount = bodyCount >= 13 ? 3 : bodyCount >= 9 ? 2 : 1;
    // Insert dividers at evenly-spaced body positions (after the Nth body slide).
    const insertAfterBodyOrdinals = Array.from({ length: dividerCount }, (_, i) =>
      Math.max(1, Math.round(((i + 1) * bodyCount) / (dividerCount + 1)))
    );
    const ordinalSet = new Set(insertAfterBodyOrdinals);

    const next: AgentPlan["slides"] = [];
    let bodyOrdinal = 0;
    let nextDividerNumber = 1;
    for (const slide of slides) {
      next.push(slide);
      if (isBody(slide)) {
        bodyOrdinal += 1;
        if (ordinalSet.has(bodyOrdinal)) {
          const sectionNumber = String(nextDividerNumber + 1).padStart(2, "0");
          nextDividerNumber += 1;
          next.push({
            index: 0,
            title: `${sectionNumber} · 下一节`,
            type: "section-divider",
            layoutId: "section-divider",
            goal: "标记下一段叙事节奏",
            keyPoints: []
          });
        }
      }
    }

    // When the user did not specify a hard slide count, we still try to keep
    // the deck length close to the original plan so audience expectations
    // (e.g. "10-page deck") aren't silently violated by injected dividers.
    // Drop the lowest-priority body slides (light layouts) to compensate.
    const targetLength = slides.length;
    if (next.length > targetLength) {
      const lightPriority: Record<string, number> = {
        "big-quote": 1,
        "section-divider": 0, // never drop dividers we just added
        toc: 3,
        cta: 4,
        thanks: 5
      };
      const isOriginalLight = (slide: AgentPlan["slides"][number]) =>
        slide.layoutId in lightPriority && lightPriority[slide.layoutId] !== 0;
      const dropOrder = next
        .map((slide, idx) => ({ slide, idx }))
        .filter((entry) => isOriginalLight(entry.slide))
        .sort((a, b) => (lightPriority[a.slide.layoutId] ?? 99) - (lightPriority[b.slide.layoutId] ?? 99));
      while (next.length > targetLength && dropOrder.length > 0) {
        const drop = dropOrder.shift();
        if (!drop) break;
        const liveIndex = next.indexOf(drop.slide);
        if (liveIndex >= 0) next.splice(liveIndex, 1);
      }
    }

    return next.map((slide, i) => ({ ...slide, index: i + 1 }));
  }

  private applyNarrativeDensityPolicy(
    slides: AgentPlan["slides"],
    skill: SkillPack,
    requestRequirements?: DeckRequestRequirements
  ) {
    const requestedChineseChars = this.requestedChineseCharTarget(requestRequirements);
    const requestedSlideCount = requestRequirements?.requestedSlideCount ?? slides.length;
    if (!requestedChineseChars || requestedSlideCount < 6) {
      return slides.map((slide, index) => ({ ...slide, index: index + 1 }));
    }

    const avgPerSlide = requestedChineseChars / Math.max(1, requestedSlideCount);
    const maxLightSlides = avgPerSlide >= 160 ? 3 : avgPerSlide >= 120 ? 4 : 5;
    const next = slides.map((slide) => ({ ...slide, keyPoints: [...slide.keyPoints] }));
    let lightCount = next.filter((slide) => this.isNarrativeLightLayout(slide.layoutId)).length;
    if (lightCount <= maxLightSlides) {
      return next.map((slide, index) => ({ ...slide, index: index + 1 }));
    }

    const candidates = next
      .map((slide, index) => ({
        index,
        priority:
          slide.layoutId === "section-divider"
            ? 0
            : slide.layoutId === "big-quote"
              ? 1
              : slide.layoutId === "toc"
                ? 2
                : slide.layoutId === "cta"
                  ? 5
                  : 99
      }))
      .filter((item) => item.priority < 99)
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    for (const candidate of candidates) {
      if (lightCount <= maxLightSlides) break;
      const current = next[candidate.index];
      if (!current || !this.isNarrativeLightLayout(current.layoutId)) continue;
      next[candidate.index] = this.convertNarrativeLightSlide(next, candidate.index, skill);
      lightCount -= 1;
    }

    return next.map((slide, index) => ({ ...slide, index: index + 1 }));
  }

  private normalizeVisual(
    input: unknown,
    skill: SkillPack,
    fallback: { templateId: string; theme: string; lockedTemplateId?: string },
    plan?: AgentPlan
  ): VisualPlan {
    const c = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const allowedThemes = plan ? this.themeShortlistForPlan(plan, skill) : [];
    const modelPrimaryTheme = this.str(c.primaryTheme, "");
    const fallbackTheme = skill.themeNames.includes(fallback.theme) ? fallback.theme : "";
    const firstAllowedTheme = allowedThemes[0] ?? "";
    const primaryTheme =
      (modelPrimaryTheme && skill.themeNames.includes(modelPrimaryTheme) && (allowedThemes.length === 0 || allowedThemes.includes(modelPrimaryTheme)) ? modelPrimaryTheme : "")
      || (fallbackTheme && (allowedThemes.length === 0 || allowedThemes.includes(fallbackTheme)) ? fallbackTheme : "")
      || firstAllowedTheme
      || (skill.themeNames.includes(modelPrimaryTheme) ? modelPrimaryTheme : "")
      || fallbackTheme
      || skill.themeNames[0]
      || "gruvbox-dark";
    const lockedTemplateId = fallback.lockedTemplateId && skill.templateNames.includes(fallback.lockedTemplateId)
      ? fallback.lockedTemplateId
      : undefined;
    const modelReferenceTemplates = this.strings(c.referenceTemplates).filter((item) => skill.templateNames.includes(item)).slice(0, 4);
    const referenceTemplates = lockedTemplateId ? [lockedTemplateId] : modelReferenceTemplates;
    const rawDeckClass = this.str(c.deckClass, "tpl-html-ppt-agent").replace(/[^a-z0-9_-]/gi, "-");
    const deckClass = this.resolveDeckClass(
      lockedTemplateId ? "" : rawDeckClass,
      referenceTemplates,
      primaryTheme,
      skill,
      lockedTemplateId ?? fallback.templateId
    );
    return {
      primaryTheme,
      backupThemes: this.normalizeBackupThemes(this.strings(c.backupThemes), primaryTheme, skill, allowedThemes),
      referenceTemplates,
      deckClass,
      visualLanguage: this.str(c.visualLanguage, "高质量 HTML-PPT 视觉系统"),
      slideVisuals: (Array.isArray(c.slideVisuals) ? c.slideVisuals : []).map((item, index) => {
        const s = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { index: this.num(s.index, index + 1), composition: this.str(s.composition, "强标题与卡片组合"), animation: this.opt(s.animation), fx: this.opt(s.fx) };
      })
    };
  }

  private normalizeBackupThemes(modelThemes: string[], primaryTheme: string, skill: SkillPack, allowedThemes: string[]) {
    const pool = allowedThemes.length > 0 ? allowedThemes : skill.themeNames;
    const seen = new Set<string>([primaryTheme]);
    const ordered = [
      ...modelThemes.filter((item) => pool.includes(item)),
      ...pool
    ];
    const result: string[] = [];
    for (const theme of ordered) {
      if (!skill.themeNames.includes(theme) || seen.has(theme)) continue;
      seen.add(theme);
      result.push(theme);
      if (result.length >= 8) break;
    }
    return result;
  }

  private themeShortlistForPlan(plan: AgentPlan, skill: SkillPack) {
    const tone = (plan.tone ?? "editorial").toLowerCase();
    const toneBindings: Record<string, string[]> = {
      clinical: ["minimal-white", "arctic-cool", "swiss-grid", "corporate-clean", "academic-paper", "engineering-whiteprint"],
      playful: ["memphis-pop", "soft-pastel", "midcentury", "xiaohongshu-white", "sunset-warm", "bauhaus"],
      editorial: ["editorial-serif", "magazine-bold", "news-broadcast", "swiss-grid", "japanese-minimal", "xiaohongshu-white"],
      cyber: ["cyberpunk-neon", "tokyo-night", "dracula", "vaporwave", "y2k-chrome", "terminal-green", "retro-tv"],
      enterprise: ["minimal-white", "corporate-clean", "arctic-cool", "swiss-grid", "sharp-mono", "blueprint"],
      documentary: ["news-broadcast", "academic-paper", "blueprint", "engineering-whiteprint", "magazine-bold", "swiss-grid"],
      lifestyle: ["xiaohongshu-white", "sunset-warm", "soft-pastel", "japanese-minimal", "midcentury", "editorial-serif"],
      energetic: ["neo-brutalism", "sharp-mono", "bauhaus", "memphis-pop", "pitch-deck-vc", "aurora"],
      academic: ["academic-paper", "engineering-whiteprint", "blueprint", "swiss-grid", "minimal-white", "magazine-bold"],
      friendly: ["soft-pastel", "sunset-warm", "japanese-minimal", "xiaohongshu-white", "midcentury", "minimal-white"]
    };
    const candidates = toneBindings[tone] ?? toneBindings.editorial ?? [];
    return candidates.filter((theme) => skill.themeNames.includes(theme));
  }

  private fallbackVisualPlan(
    plan: AgentPlan,
    skill: SkillPack,
    fallback: { templateId: string; theme: string; lockedTemplateId?: string }
  ): VisualPlan {
    const audienceSignal = `${plan.audience} ${plan.tone ?? ""} ${plan.format ?? ""}`.toLowerCase();
    const themePool = this.themeShortlistForPlan(plan, skill);
    const preferredTheme =
      themePool.find((name) => name === fallback.theme)
      ?? themePool[0]
      ?? skill.themeNames.find((name) => name === fallback.theme)
      ?? skill.themeNames.find((name) => audienceSignal.includes("academic") && /academic|blueprint|whiteprint|swiss/i.test(name))
      ?? skill.themeNames.find((name) => audienceSignal.includes("editorial") && /editorial|magazine|xiaohongshu|white/i.test(name))
      ?? skill.themeNames[0]
      ?? "editorial-serif";
    const backupThemes = this.normalizeBackupThemes([], preferredTheme, skill, themePool).slice(0, 3);
    const referenceTemplates = fallback.lockedTemplateId && skill.templateNames.includes(fallback.lockedTemplateId)
      ? [fallback.lockedTemplateId]
      : skill.templateNames.includes(fallback.templateId)
      ? [fallback.templateId]
      : skill.referenceSources.map((item) => item.name).filter((name) => skill.templateNames.includes(name)).slice(0, 2);
    const rawVisual = {
      primaryTheme: preferredTheme,
      backupThemes,
      referenceTemplates,
      deckClass: "",
      visualLanguage: `${plan.tone ?? "editorial"} visual system for ${plan.audience}`,
      slideVisuals: plan.slides.map((slide) => ({
        index: slide.index,
        composition: this.defaultCompositionForLayout(slide.layoutId, slide.title)
      }))
    };
    return this.normalizeVisual(rawVisual, skill, fallback, plan);
  }

  private selectedTemplateId(input: { pendingUserMessage: PptMessageDto; templateId: string }, skill: SkillPack) {
    const selected = this.str(input.pendingUserMessage.template?.id, "");
    return selected && skill.templateNames.includes(selected) ? selected : undefined;
  }

  private resolveDeckClass(
    rawDeckClass: string,
    referenceTemplates: string[],
    primaryTheme: string,
    skill: SkillPack,
    fallbackTemplateId: string
  ) {
    const fullDecks = skill.manifest?.fullDecks ?? [];
    const knownDeckClasses = new Set(fullDecks.map((deck) => this.str(deck.deckClass, "").toLowerCase()).filter(Boolean));

    // 1) Primary source of truth: first valid reference template selected in stage 04.
    const explicitTemplate = referenceTemplates.find((name) => skill.templateNames.includes(name));
    if (explicitTemplate) {
      const fromTemplate = fullDecks.find((deck) => deck.id === explicitTemplate && this.str(deck.deckClass, ""));
      if (fromTemplate?.deckClass) {
        return fromTemplate.deckClass;
      }
    }

    // 2) Accept raw deck class only when it is a known full-deck class.
    if (rawDeckClass && knownDeckClasses.has(rawDeckClass.toLowerCase())) {
      return rawDeckClass;
    }

    // 3) If theme has an explicit full-deck mapping, use that.
    const byTheme = fullDecks.find((deck) =>
      (deck.themesReferenced ?? []).some((theme) => theme.toLowerCase().trim() === primaryTheme.toLowerCase().trim())
    );
    if (byTheme?.deckClass) {
      return byTheme.deckClass;
    }

    // 4) Last fallback: templateId -> deckClass if present.
    const byTemplateId = fullDecks.find((deck) => deck.id === fallbackTemplateId && this.str(deck.deckClass, ""));
    if (byTemplateId?.deckClass) {
      return byTemplateId.deckClass;
    }

    return rawDeckClass || "tpl-html-ppt-agent";
  }

  private enrichVisualPlan(visual: VisualPlan, plan: AgentPlan, skill: SkillPack): VisualPlan {
    const animationCatalog = Array.from(new Set((skill.manifest?.animations ?? []).map((item) => item.id))).filter(Boolean);
    const fxCatalog = Array.from(new Set((skill.manifest?.fxEffects ?? []).map((item) => item.id))).filter(Boolean);
    const fallbackAnimations = ["fade-up", "fade-left", "fade-right", "rise-in", "zoom-pop", "stagger-list"];
    const fallbackFx = ["data-stream", "orbit-ring", "sparkle-trail"];
    const availableAnimations = animationCatalog.length > 0 ? animationCatalog : fallbackAnimations;
    const availableFx = this.filterAllowedFx(fxCatalog.length > 0 ? fxCatalog : fallbackFx);
    const existingByIndex = new Map(visual.slideVisuals.map((item) => [item.index, item]));

    const slideVisuals = plan.slides.map((slide, order) => {
      const current = existingByIndex.get(slide.index);
      const composition = this.str(current?.composition, this.defaultCompositionForLayout(slide.layoutId, slide.title));
      const animation =
        this.pickAllowedVisualValue(this.str(current?.animation, ""), availableAnimations) ??
        this.defaultAnimationForLayout(slide.layoutId, order, availableAnimations);
      const fx = this.pickAllowedVisualValue(this.str(current?.fx, ""), availableFx) ?? "";
      return {
        index: slide.index,
        composition,
        animation,
        ...(fx ? { fx } : {})
      };
    });

    this.ensureAnimationDiversity(slideVisuals, plan.slides, availableAnimations);
    this.ensureFxCoverage(slideVisuals, plan.slides, availableFx, visual.primaryTheme);
    this.limitFxCoverage(slideVisuals, plan.slides, visual.primaryTheme);

    return { ...visual, slideVisuals };
  }

  private pickAllowedVisualValue(value: string, allowedValues: string[]) {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (HtmlPptAgentService.BLOCKED_FX.has(normalized)) return null;
    return allowedValues.find((item) => item.toLowerCase() === normalized) ?? null;
  }

  private filterAllowedFx(values: string[]) {
    return values.filter((value) => value && !this.isBlockedFx(value));
  }

  private defaultCompositionForLayout(layoutId: string, title: string) {
    const label = title.trim() || "主题内容";
    const mapping: Record<string, string> = {
      cover: `强视觉封面：大标题 + 副标题 + 背景光效层，突出“${label}”`,
      toc: `目录信息卡布局：左侧章节编号，右侧重点导读，突出“${label}”`,
      "section-divider": `章节分隔页：超大标题 + 装饰线 + 章节标签，强化“${label}”`,
      comparison: `对比布局：双列或三列对照卡片 + 指标标签，突出“${label}”`,
      "two-column": `双栏布局：左侧叙事，右侧图表/指标卡，围绕“${label}”`,
      "three-column": `三栏卡片布局：等宽信息卡 + 图标标签，围绕“${label}”`,
      "stat-highlight": `数据高亮布局：大数字主视觉 + 指标矩阵，围绕“${label}”`,
      timeline: `时间轴布局：节点分层 + 关键里程碑，围绕“${label}”`,
      thanks: `结尾页：总结条目 + 行动号召按钮，收束“${label}”`
    };
    return mapping[layoutId] ?? `信息密度平衡布局：标题 + 内容卡 + 装饰层，围绕“${label}”`;
  }

  /**
   * Layout-aware accent animation map, anchored to the skill's
   * `references/animations.md` and `references/authoring-guide.md` step 6.
   * The picker walks each layout's preferred list in order and returns the
   * first animation that exists in the runtime catalog. Adding entries here
   * is preferable to relying on model creativity.
   */
  private static readonly LAYOUT_ANIMATION_MAP: Record<string, string[]> = {
    // Openers & transitions
    cover: ["blur-in", "rise-in", "perspective-zoom", "zoom-pop", "fade-up"],
    toc: ["stagger-list", "fade-up", "fade-left"],
    "section-divider": ["cube-rotate-3d", "perspective-zoom", "ripple-reveal", "zoom-pop", "fade-down"],
    // Text-centric
    bullets: ["stagger-list", "fade-up", "fade-left"],
    "two-column": ["fade-left", "fade-right", "fade-up"],
    "three-column": ["stagger-list", "fade-up", "rise-in"],
    "big-quote": ["typewriter", "fade-up", "rise-in"],
    // Numbers & data
    "stat-highlight": ["counter-up", "zoom-pop", "rise-in"],
    "kpi-grid": ["counter-up", "stagger-list", "fade-up"],
    table: ["stagger-list", "fade-up"],
    "chart-bar": ["fade-up", "stagger-list", "shimmer-sweep"],
    "chart-line": ["path-draw", "fade-up", "shimmer-sweep"],
    "chart-pie": ["zoom-pop", "fade-up", "stagger-list"],
    "chart-radar": ["path-draw", "fade-up", "rise-in"],
    // Code & terminal
    code: ["typewriter", "fade-up", "glitch-in"],
    diff: ["fade-left", "fade-right", "stagger-list"],
    terminal: ["typewriter", "neon-glow", "glitch-in"],
    // Diagrams & flows
    "flow-diagram": ["path-draw", "stagger-list", "fade-up"],
    "arch-diagram": ["path-draw", "stagger-list", "fade-up"],
    "process-steps": ["stagger-list", "fade-up", "rise-in"],
    mindmap: ["path-draw", "stagger-list", "fade-up"],
    // Plans & comparisons
    timeline: ["path-draw", "shimmer-sweep", "stagger-list", "fade-right"],
    roadmap: ["stagger-list", "fade-up", "fade-right"],
    gantt: ["path-draw", "stagger-list", "fade-right"],
    comparison: ["fade-left", "fade-right", "card-flip-3d"],
    "pros-cons": ["fade-left", "fade-right", "stagger-list"],
    "todo-checklist": ["stagger-list", "fade-up"],
    // Visuals
    "image-hero": ["kenburns", "blur-in", "fade-up"],
    "image-grid": ["stagger-list", "fade-up", "rise-in"],
    // Closers
    cta: ["zoom-pop", "shimmer-sweep", "rise-in", "fade-up"],
    thanks: ["confetti-burst", "spotlight", "rise-in", "fade-up"]
  };

  private defaultAnimationForLayout(layoutId: string, order: number, availableAnimations: string[]) {
    const globalFallback = ["fade-up", "fade-left", "fade-right", "rise-in", "zoom-pop", "stagger-list"];
    const preferred = [...(HtmlPptAgentService.LAYOUT_ANIMATION_MAP[layoutId] ?? []), ...globalFallback];
    for (const key of preferred) {
      const matched = this.pickAllowedVisualValue(key, availableAnimations);
      if (matched) return matched;
    }
    return availableAnimations[order % availableAnimations.length] ?? "fade-up";
  }

  private defaultFxForLayout(layoutId: string, order: number, availableFx: string[], primaryTheme: string) {
    const conservativeTheme = /(corporate|academic|minimal|swiss|whiteprint|news)/i.test(primaryTheme);
    const subtlePool = ["orbit-ring", "sparkle-trail"];
    const vividPool = ["galaxy-swirl", "particle-burst", "counter-explosion", "constellation"];
    const byLayout: Record<string, string[]> = {
      cover: conservativeTheme ? subtlePool : [...vividPool, ...subtlePool],
      "section-divider": conservativeTheme ? subtlePool : [...vividPool, ...subtlePool],
      "stat-highlight": conservativeTheme ? ["orbit-ring"] : ["counter-explosion", "data-stream", "particle-burst"],
      timeline: conservativeTheme ? ["orbit-ring", "data-stream"] : ["constellation", "orbit-ring"],
      thanks: conservativeTheme ? ["sparkle-trail"] : ["firework", "sparkle-trail"]
    };
    const preferred = [...(byLayout[layoutId] ?? (conservativeTheme ? subtlePool : vividPool)), ...availableFx];
    for (const key of preferred) {
      const matched = this.pickAllowedVisualValue(key, availableFx);
      if (matched) return matched;
    }
    return availableFx[order % availableFx.length] ?? "";
  }

  private ensureAnimationDiversity(
    slideVisuals: Array<{ index: number; composition: string; animation?: string; fx?: string }>,
    slides: AgentPlan["slides"],
    availableAnimations: string[]
  ) {
    if (slideVisuals.length <= 1 || availableAnimations.length <= 1) return;
    const distinct = new Set(slideVisuals.map((item) => item.animation).filter(Boolean));
    const targetKinds = slideVisuals.length >= 10 ? 4 : slideVisuals.length >= 6 ? 3 : 2;
    if (distinct.size >= targetKinds) return;

    for (let i = 0; i < slideVisuals.length; i += 1) {
      const slide = slides[i];
      const visual = slideVisuals[i];
      if (!slide || !visual) continue;
      visual.animation = this.defaultAnimationForLayout(slide.layoutId, i, availableAnimations);
      if (new Set(slideVisuals.map((item) => item.animation).filter(Boolean)).size >= targetKinds) {
        break;
      }
    }
  }

  private ensureFxCoverage(
    slideVisuals: Array<{ index: number; composition: string; animation?: string; fx?: string }>,
    slides: AgentPlan["slides"],
    availableFx: string[],
    primaryTheme: string
  ) {
    if (slideVisuals.length === 0 || availableFx.length === 0) return;
    const conservativeTheme = /(corporate|academic|minimal|swiss|whiteprint|news)/i.test(primaryTheme);
    const currentCount = slideVisuals.filter((item) => Boolean(item.fx)).length;
    const targetCount = conservativeTheme ? 1 : slideVisuals.length >= 10 ? 2 : 1;
    if (currentCount >= targetCount) return;

    const orderByPriority = slides
      .map((slide, order) => ({
        order,
        priority:
          slide.layoutId === "cover"
            ? 0
            : slide.layoutId === "section-divider"
              ? 1
              : slide.layoutId === "stat-highlight"
                ? 2
                : slide.layoutId === "timeline"
                  ? 3
                  : slide.layoutId === "thanks"
                    ? 4
                    : 10
      }))
      .sort((a, b) => a.priority - b.priority || a.order - b.order);

    let filled = currentCount;
    for (const item of orderByPriority) {
      if (filled >= targetCount) break;
      const visual = slideVisuals[item.order];
      const slide = slides[item.order];
      if (!visual || !slide || visual.fx) continue;
      const fx = this.defaultFxForLayout(slide.layoutId, item.order, availableFx, primaryTheme);
      if (!fx) continue;
      visual.fx = fx;
      filled += 1;
    }
  }

  private limitFxCoverage(
    slideVisuals: Array<{ index: number; composition: string; animation?: string; fx?: string }>,
    slides: AgentPlan["slides"],
    primaryTheme: string
  ) {
    if (slideVisuals.length === 0) return;
    const conservativeTheme = /(corporate|academic|minimal|swiss|whiteprint|news)/i.test(primaryTheme);
    const maxFxCount = conservativeTheme ? 1 : slideVisuals.length >= 10 ? 2 : 1;
    const allowedLayouts = new Set(["cover", "section-divider", "stat-highlight", "cta", "thanks"]);
    const priorityByLayout: Record<string, number> = {
      cover: 0,
      "section-divider": 1,
      "stat-highlight": 2,
      cta: 3,
      thanks: 4
    };

    const ranked = slideVisuals
      .map((visual, order) => ({ visual, slide: slides[order], order }))
      .filter((item) => Boolean(item.visual.fx));

    for (const item of ranked) {
      const layoutId = item.slide?.layoutId ?? "";
      if (!allowedLayouts.has(layoutId) || this.isBlockedFx(item.visual.fx ?? "")) {
        delete item.visual.fx;
      }
    }

    const remaining = ranked
      .filter((item) => Boolean(item.visual.fx))
      .sort((a, b) => {
        const pa = priorityByLayout[a.slide?.layoutId ?? ""] ?? 99;
        const pb = priorityByLayout[b.slide?.layoutId ?? ""] ?? 99;
        return pa - pb || a.order - b.order;
      });

    remaining.forEach((item, index) => {
      if (index >= maxFxCount) {
        delete item.visual.fx;
      }
    });
  }

  private normalizeLayoutId(input: string, type: string, index: number, total: number, allowed: string[]) {
    if (allowed.includes(input)) return input;
    const normalized = input.toLowerCase().replace(/_/g, "-");
    if (allowed.includes(normalized)) return normalized;
    const preferred = this.inferLayoutId(type, index, total);
    if (allowed.includes(preferred)) return preferred;
    return allowed[index === 0 ? 0 : Math.min(index, allowed.length - 1)] ?? "bullets";
  }

  private inferLayoutId(type: string, index: number, total: number) {
    const value = type.toLowerCase();
    if (index === 0 || value.includes("cover") || value.includes("封面")) return "cover";
    if (index === total - 1 || value.includes("thanks") || value.includes("closing") || value.includes("结尾")) return "thanks";
    if (value.includes("toc") || value.includes("目录")) return "toc";
    if (value.includes("timeline") || value.includes("history") || value.includes("历史") || value.includes("时间")) return "timeline";
    if (value.includes("kpi") || value.includes("stat") || value.includes("指标") || value.includes("数据")) return "kpi-grid";
    if (value.includes("compare") || value.includes("comparison") || value.includes("对比")) return "comparison";
    if (value.includes("process") || value.includes("step") || value.includes("流程") || value.includes("训练")) return "process-steps";
    if (value.includes("roadmap") || value.includes("future") || value.includes("未来") || value.includes("规划")) return "roadmap";
    if (value.includes("pros") || value.includes("利弊")) return "pros-cons";
    if (value.includes("quote") || value.includes("金句")) return "big-quote";
    if (value.includes("three") || value.includes("三")) return "three-column";
    if (value.includes("two") || value.includes("二")) return "two-column";
    return ["two-column", "three-column", "stat-highlight", "timeline", "comparison", "process-steps", "kpi-grid", "roadmap"][Math.max(0, index - 1) % 8] ?? "two-column";
  }

  private toSpecLayout(layoutId: string, index: number, total: number): PptDeckLayout {
    if (layoutId === "cover") return "cover-hero";
    if (layoutId === "toc") return "toc-grid";
    if (layoutId === "comparison" || layoutId === "pros-cons") return "comparison-board";
    if (layoutId === "kpi-grid" || layoutId === "stat-highlight") return "kpi-grid";
    if (layoutId === "timeline") return "timeline-ribbon";
    if (layoutId === "roadmap" || layoutId === "gantt") return "roadmap";
    if (layoutId === "flow-diagram" || layoutId === "process-steps" || layoutId === "arch-diagram" || layoutId === "mindmap") return "flow-diagram";
    if (layoutId === "cta" || layoutId === "thanks" || index === total - 1) return "closing-cta";
    return index === 0 ? "cover-hero" : "content-cards";
  }

  private fallbackResearch(userPrompt: string, requestRequirements?: DeckRequestRequirements): ResearchPack {
    const suggestedSlideCount = requestRequirements?.requestedSlideCount ?? 8;
    return {
      topicSummary: userPrompt.slice(0, 240),
      keyFacts: [
        "模型资料整理阶段未返回结果，本资料包由后端兜底生成。",
        "后续内容规划阶段需要根据用户原始需求自行补全事实、结构和叙事重点。",
        "涉及实时数据、市场份额、具体年份排名或最新趋势的内容，需要在 needVerification 中标记待核验。"
      ],
      narrativeAngles: ["发展脉络", "品牌定位", "核心竞争力", "用户价值", "未来趋势"],
      suggestedSections: ["开场定义", "发展历程", "品牌拆解", "关键数据/指标", "趋势判断", "总结行动"],
      needVerification: ["实时事实与最新数据未执行外部搜索，需要人工或后续联网核验。"],
      suggestedSlideCount,
      perSlideLengthTargets: this.buildPerSlideLengthTargets(suggestedSlideCount, requestRequirements)
    };
  }

  private extractDeckRequestRequirements(userPrompt: string): DeckRequestRequirements {
    const text = userPrompt ?? "";
    const slideMatch =
      text.match(/(?:^|[\s,，。；:：])(\d{1,2})\s*(?:页|页ppt|页PPT|张)(?:\s*(?:ppt|PPT|幻灯片|slides?))?/i) ??
      text.match(/(?:^|[\s,，。；:：])(\d{1,2})\s*(?:slides?|pages?)\b/i);
    const requestedSlideCount = slideMatch ? Math.min(30, Math.max(1, Number(slideMatch[1]))) : undefined;

    const zhLengthMatch = text.match(/(?:至少|不少于|不低于|约|大约|左右)?\s*(\d{2,5})\s*字(?:以上|以内|左右)?/i);
    const enLengthMatch = text.match(/(?:at least|around|about|minimum)?\s*(\d{2,5})\s*(words?|characters?|chars?)\b/i);

    let requestedNarrativeLength: number | undefined;
    let narrativeLengthUnit: DeckRequestRequirements["narrativeLengthUnit"];
    let narrativeLengthMode: DeckRequestRequirements["narrativeLengthMode"];

    if (zhLengthMatch) {
      requestedNarrativeLength = Math.min(40000, Math.max(1, Number(zhLengthMatch[1])));
      narrativeLengthUnit = "chars";
      const matched = zhLengthMatch[0] ?? "";
      narrativeLengthMode = /至少|不少于|不低于|以上/.test(matched) ? "minimum" : "target";
    } else if (enLengthMatch) {
      requestedNarrativeLength = Math.min(40000, Math.max(1, Number(enLengthMatch[1])));
      narrativeLengthUnit = /word/i.test(enLengthMatch[2] ?? "") ? "words" : "chars";
      const matched = enLengthMatch[0] ?? "";
      narrativeLengthMode = /at least|minimum/i.test(matched) ? "minimum" : "target";
    }

    return {
      ...(requestedSlideCount ? { requestedSlideCount } : {}),
      ...(requestedNarrativeLength ? { requestedNarrativeLength } : {}),
      ...(narrativeLengthUnit ? { narrativeLengthUnit } : {}),
      ...(narrativeLengthMode ? { narrativeLengthMode } : {})
    };
  }

  private buildPerSlideLengthTargets(slideCount: number, requestRequirements?: DeckRequestRequirements): ResearchPack["perSlideLengthTargets"] {
    const count = Math.min(30, Math.max(1, slideCount || 8));
    const totalLength = requestRequirements?.requestedNarrativeLength ?? count * (requestRequirements?.narrativeLengthUnit === "words" ? 90 : 120);
    const weights = Array.from({ length: count }, (_, index) => {
      if (count === 1) return 1;
      if (index === 0) return 0.45;
      if (index === count - 1) return 0.55;
      if (index === 1) return 0.7;
      if (index === count - 2) return 0.75;
      const ratio = index / Math.max(1, count - 1);
      return ratio > 0.25 && ratio < 0.75 ? 1.15 : 0.95;
    });
    const weightSum = weights.reduce((sum, value) => sum + value, 0) || 1;
    return weights.map((weight, index) => ({
      index: index + 1,
      targetLength: Math.max(20, Math.round((totalLength * weight) / weightSum)),
      purpose:
        index === 0
          ? "opening hook"
          : index === count - 1
            ? "closing takeaway"
            : index === 1
              ? "agenda or framing"
              : index === count - 2
                ? "summary or action bridge"
        : "core body content"
    }));
  }

  private requestedChineseCharTarget(requestRequirements?: DeckRequestRequirements) {
    if (!requestRequirements?.requestedNarrativeLength) return undefined;
    if (requestRequirements.narrativeLengthUnit === "words") return undefined;
    return requestRequirements.requestedNarrativeLength;
  }

  private countChineseChars(value: string) {
    return (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  }

  private visibleSectionChineseChars(section: string) {
    return this.countChineseChars(this.visibleSlideText(section));
  }

  private sumSectionsChineseChars(sections: string[]) {
    return sections.reduce((sum, section) => sum + this.visibleSectionChineseChars(section), 0);
  }

  private researchSchemaHint(requestRequirements?: DeckRequestRequirements) {
    const slideCount = requestRequirements?.requestedSlideCount ?? 8;
    return [
      "Return one JSON object only.",
      "Schema:",
      `{ "topicSummary": "string", "keyFacts": ["string"], "narrativeAngles": ["string"], "suggestedSections": ["string"], "needVerification": ["string"], "suggestedSlideCount": ${slideCount}, "perSlideLengthTargets": [{ "index": 1, "targetLength": 80, "purpose": "opening hook" }] }`
    ].join("\n");
  }

  private planSchemaHint(requestRequirements: DeckRequestRequirements | undefined, research?: ResearchPack) {
    const slideCount = requestRequirements?.requestedSlideCount ?? research?.suggestedSlideCount ?? 8;
    return [
      "Return one JSON object only.",
      "Schema:",
      `{ "title": "string", "subtitle": "string?", "slideCount": ${slideCount}, "audience": "string", "tone": "clinical|playful|editorial|cyber|enterprise|documentary|lifestyle|energetic|academic|friendly", "format": "live-talk|pdf-handout|xhs-image|web-share|keynote|internal-memo", "objective": "string", "slides": [{ "index": 1, "title": "string", "type": "string", "layoutId": "string", "goal": "string", "keyPoints": ["string"] }] }`
    ].join("\n");
  }

  private async readLayoutTemplates(skillRoot: string, layoutIds: string[]) {
    const unique = Array.from(new Set(layoutIds));
    const snippets = await Promise.all(unique.map(async (layoutId) => {
      const raw = await this.readSingleLayoutTemplate(skillRoot, layoutId);
      const compact = this.sanitizeLayoutTemplateForPrompt(layoutId, raw).replace(/\n{3,}/g, "\n\n").trim();
      return [
        `--- layoutId: ${layoutId} ---`,
        "Gold-standard slot skeleton: preserve this structure and class rhythm; replace bracketed tokens with this deck's planned content.",
        compact.slice(0, 6500)
      ].join("\n");
    }));
    return snippets.join("\n\n");
  }

  private async readSingleLayoutTemplate(skillRoot: string, layoutId: string) {
    const content = await readFile(join(skillRoot, "templates", "single-page", `${layoutId}.html`), "utf8").catch(() => "");
    return content.match(/<section\b[\s\S]*?<\/section>/i)?.[0] ?? content;
  }

  private sanitizeLayoutTemplateForPrompt(layoutId: string, template: string) {
    let next = template
      .replace(/\bis-active\b/g, "")
      .replace(/\s{2,}/g, " ");
    next = next.replace(/<section\b([^>]*)>/i, (match, attrs: string) => {
      let nextAttrs = attrs;
      if (!/\bdata-title=/.test(nextAttrs)) nextAttrs += ' data-title="{TITLE}"';
      else nextAttrs = nextAttrs.replace(/\bdata-title=(["'])[^"']*\1/i, 'data-title="{TITLE}"');
      if (!/\bdata-slide-index=/.test(nextAttrs)) nextAttrs += ' data-slide-index="{INDEX}"';
      if (!/\bdata-layoutid=/.test(nextAttrs)) nextAttrs += ` data-layoutid="${this.escapeAttr(layoutId)}"`;
      return `<section${nextAttrs}>`;
    });
    next = this.maskDonorLeafText(next);
    next = next.replace(/>([^<>{}\n][^<>]*?)</g, (match, text: string) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return match;
      if (/^\[[A-Z0-9_-]+\]$/.test(normalized)) return match;
      return `>${this.semanticDonorToken("", "", normalized)}<`;
    });
    return next;
  }

  /**
   * Pick the strongest full-deck template name to use as a visual-DNA donor
   * for the section author. Order:
   *   1. First entry in visual.referenceTemplates that exists in the skill
   *      catalog (this is the model's own choice from Stage 04).
   *   2. Manifest fullDecks whose deckClass matches visual.deckClass.
   *   3. Skill manifest fullDecks whose themesReferenced includes the chosen
   *      primary theme.
   *   4. The first entry in skill.referenceSources that the skill loaded
   *      eagerly (which already biases towards templateId / known good decks).
   */
  private pickReferenceFullDeckName(visual: VisualPlan, skill: SkillPack): string | undefined {
    const valid = new Set(skill.templateNames);
    const explicit = visual.referenceTemplates.find((name) => valid.has(name));
    if (explicit) return explicit;

    const fullDecks = skill.manifest?.fullDecks ?? [];
    const deckClass = visual.deckClass?.toLowerCase().trim();
    if (deckClass) {
      const byDeckClass = fullDecks.find((deck) => deck.deckClass?.toLowerCase().trim() === deckClass);
      if (byDeckClass && valid.has(byDeckClass.id)) return byDeckClass.id;
    }

    const primaryTheme = visual.primaryTheme?.toLowerCase().trim();
    if (primaryTheme) {
      const byTheme = fullDecks.find((deck) =>
        (deck.themesReferenced ?? []).some((theme) => theme.toLowerCase().trim() === primaryTheme)
      );
      if (byTheme && valid.has(byTheme.id)) return byTheme.id;
    }

    const eager = skill.referenceSources.find((item) => valid.has(item.name));
    return eager?.name;
  }

  /**
   * Read up to 5 representative <section> blocks from the chosen full-deck
   * template and a trimmed style.css excerpt so the section author can
   * inherit visual DNA (typography, decoration, accents) without copying
   * text content verbatim.
   */
  private async readReferenceFullDeck(skill: SkillPack, templateName: string): Promise<ReferenceFullDeckSnippet | undefined> {
    if (!templateName) return undefined;
    const skillRoot = skill.root;
    const indexPath = join(skillRoot, "templates", "full-decks", templateName, "index.html");
    const stylePath = join(skillRoot, "templates", "full-decks", templateName, "style.css");
    const [indexHtml, cssText] = await Promise.all([
      readFile(indexPath, "utf8").catch(() => ""),
      readFile(stylePath, "utf8").catch(() => "")
    ]);
    if (!indexHtml.trim()) return undefined;

    const allSections = indexHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    if (allSections.length === 0) return undefined;

    // Pick a representative spread: cover, an early body slide, a middle
    // body slide, a late body slide, and a closer if available.
    const picks: string[] = [];
    const total = allSections.length;
    const pickIndex = (relative: number) => Math.min(total - 1, Math.max(0, Math.round(relative * (total - 1))));
    const positions = total === 1
      ? [0]
      : total <= 4
        ? Array.from({ length: total }, (_, i) => i)
        : [0, pickIndex(0.25), pickIndex(0.55), pickIndex(0.8), total - 1];

    const seen = new Set<number>();
    for (const pos of positions) {
      if (seen.has(pos)) continue;
      seen.add(pos);
      const section = allSections[pos];
      if (!section) continue;
      picks.push(section.replace(/\s+\n/g, "\n").trim());
    }
    const donorContract = await this.resolveDonorTemplateContract(skill, templateName);
    const sanitizedPicks = picks
      .slice(0, 5)
      .map((section) => this.sanitizeDonorSectionForPrompt(section, donorContract));

    return {
      name: templateName,
      sections: sanitizedPicks,
      cssExcerpt: this.sanitizeDonorCssExcerptForPrompt(cssText, donorContract).slice(0, 4000),
      contract: this.inferReferenceComponentContract(picks.slice(0, 5), cssText),
      donorContract
    };
  }

  private async resolveDonorTemplateContract(skill: SkillPack, templateName: string): Promise<DonorTemplateContract | undefined> {
    const fromManifest = skill.manifest?.fullDecks?.find((deck) => deck.id === templateName)?.donorContract;
    if (fromManifest) return fromManifest;
    const raw = await readFile(join(skill.root, "templates", "full-decks", templateName, "donor-contract.json"), "utf8").catch(() => "");
    if (!raw.trim()) return undefined;
    try {
      return JSON.parse(raw) as DonorTemplateContract;
    } catch {
      return undefined;
    }
  }

  private sanitizeDonorSectionForPrompt(section: string, donorContract?: DonorTemplateContract) {
    return this.sanitizeDonorSection(section, { donorContract, maskText: true });
  }

  private maskDonorLeafText(markup: string) {
    return markup.replace(/<([a-z0-9:-]+)\b([^>]*)>([^<>]+)<\/\1>/gi, (match, tagName: string, attrs: string, text: string) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return match;
      const classes = attrs.match(/\bclass=(["'])([^"']+)\1/i)?.[2] ?? "";
      return `<${tagName}${attrs}>${this.semanticDonorToken(tagName.toLowerCase(), classes, normalized)}</${tagName}>`;
    });
  }

  private semanticDonorToken(tagName: string, classes: string, text: string) {
    const classText = classes.toLowerCase();
    if (/h1/.test(tagName) || /\b(?:h1|title|hero-title|cover-title)\b/.test(classText)) return "[H1]";
    if (/h2/.test(tagName) || /\b(?:h2|title-md|subtitle)\b/.test(classText)) return "[H2]";
    if (/h[3-6]/.test(tagName)) return "[H3]";
    if (tagName === "li") return "[BULLET]";
    if (/footer|page|snum|slide-number/.test(classText)) return "[FOOTER]";
    if (/kicker|eyebrow|tag|label|badge|pill/.test(classText)) return "[KICKER]";
    if (/num|metric|value|amount|counter/.test(classText) || /^\d+[%+.,\w-]*$/.test(text.trim())) return "[NUMBER]";
    if (/code|mono|terminal|cmd/.test(classText) || ["code", "pre"].includes(tagName)) return "[CODE]";
    if (/lede|sub|dim|desc|body|txt|copy/.test(classText) || tagName === "p") return "[BODY]";
    return "[TEXT]";
  }

  private sanitizeDonorCssExcerptForPrompt(cssText: string, donorContract?: DonorTemplateContract) {
    if (!donorContract) return cssText;
    const redacted = new Set([
      ...(donorContract.forbiddenClasses ?? []),
      ...(donorContract.coverOnlyClasses ?? []),
      ...(donorContract.decorativeOnlyClasses ?? []),
      ...(donorContract.cssRedactClasses ?? [])
    ].filter(Boolean));
    if (redacted.size === 0) return cssText;

    return this.findCssRules(cssText)
      .filter((rule) => !this.extractClassTokensFromSelector(rule.selector).some((token) => redacted.has(token)))
      .map((rule) => `${rule.selector.trim()}{${rule.body.trim()}}`)
      .join("\n");
  }

  private inferReferenceComponentContract(sections: string[], cssText: string): ReferenceComponentContract | undefined {
    const markup = sections.join("\n");
    const classTokens = Array.from(
      new Set([
        ...this.extractClassTokensFromMarkup(markup),
        ...this.extractClassTokensFromCss(cssText)
      ])
    );
    const donorPrefix = this.detectDonorClassPrefix(classTokens);
    const coverTitleClass = this.findContractHeadingClass(sections[0] ?? "", donorPrefix);
    const bodyTitleClass = this.findContractHeadingClass(sections.slice(1).join("\n") || markup, donorPrefix) ?? coverTitleClass;
    const kickerClass = this.findContractClassByHint(markup, classTokens, donorPrefix, ["kicker", "eyebrow"]);
    const footerClass = this.findContractClassByHint(markup, classTokens, donorPrefix, ["footer"]);
    const sectionLabelClass = this.findContractClassByHint(markup, classTokens, donorPrefix, ["section-label", "section_label", "label"]);
    const cardClass = this.findContractClassByHint(markup, classTokens, donorPrefix, ["card", "panel"]);

    const contract: ReferenceComponentContract = {
      donorPrefix,
      coverTitleClass,
      bodyTitleClass,
      kickerClass,
      footerClass,
      sectionLabelClass,
      cardClass,
      titleTreatment: bodyTitleClass ? `Keep ${bodyTitleClass} as the default body heading class and reserve accent spans for small inline emphasis only.` : undefined,
      cardTreatment: cardClass ? `Use ${cardClass} as the primary card shell so border width, radius, and fill stay visually continuous across middle slides.` : undefined,
      accentTreatment: kickerClass || sectionLabelClass
        ? `Concentrate accent color on ${kickerClass ?? sectionLabelClass}, section labels, big numbers, and selective highlighted cards rather than inventing new accent widgets.`
        : undefined
    };

    if (!contract.donorPrefix && !contract.coverTitleClass && !contract.bodyTitleClass && !contract.kickerClass && !contract.cardClass && !contract.footerClass && !contract.sectionLabelClass) {
      return undefined;
    }
    return contract;
  }

  private detectDonorClassPrefix(classTokens: string[]) {
    const genericPrefixes = new Set([
      "slide", "deck", "grid", "card", "panel", "hero", "visual", "content", "metric", "anim", "timeline", "process",
      "roadmap", "comparison", "quote", "callout", "stack", "cluster", "stat", "pill", "badge", "tag", "meta", "caption"
    ]);
    const counts = new Map<string, number>();
    for (const token of classTokens) {
      const match = token.match(/^([a-z]{2,4})-[a-z0-9-]+$/i);
      if (!match) continue;
      const prefix = match[1]?.toLowerCase();
      if (!prefix || genericPrefixes.has(prefix)) continue;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  private findContractHeadingClass(markup: string, donorPrefix?: string) {
    for (const match of markup.matchAll(/<(h1|h2)\b[^>]*class=["']([^"']+)["'][^>]*>/gi)) {
      const classes = (match[2] ?? "").split(/\s+/).filter(Boolean);
      const donorClass = classes.find((token) => donorPrefix && token.startsWith(`${donorPrefix}-`));
      if (donorClass) return donorClass;
      const fallback = classes.find((token) => /(title|h1|h2)/i.test(token));
      if (fallback) return fallback;
    }
    return undefined;
  }

  private findContractClassByHint(markup: string, classTokens: string[], donorPrefix: string | undefined, hints: string[]) {
    const hintMatchers = hints.map((hint) => new RegExp(hint.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i"));
    for (const match of markup.matchAll(/\bclass=["']([^"']+)["']/gi)) {
      const classes = (match[1] ?? "").split(/\s+/).filter(Boolean);
      const donorHit = classes.find((token) => donorPrefix && token.startsWith(`${donorPrefix}-`) && hintMatchers.some((re) => re.test(token)));
      if (donorHit) return donorHit;
    }
    return classTokens.find((token) => donorPrefix && token.startsWith(`${donorPrefix}-`) && hintMatchers.some((re) => re.test(token)))
      ?? classTokens.find((token) => hintMatchers.some((re) => re.test(token)));
  }

  private layoutContract() {
    return [
      "底层布局契约：",
      "- index.html 的每个 section 来自 html-ppt templates/single-page/<layoutId>.html。",
      "- .deck 与 .slide 由 assets/base.css + runtime.js 控制，不属于创意 CSS 的自由区。",
      "- .deck-header、.deck-footer、.slide-number 是 html-ppt runtime chrome slots，不要把它们当作封面主容器或大型内容容器。",
      "- CSS 可以增强 .card、.grid、.kicker、.eyebrow、.h1、.h2、.lede、timeline、kpi、comparison 等模板内部元素。",
      "- CSS 不应该把幻灯片改成纵向滚动网页，不应该让不同页使用互相冲突的根容器尺寸。",
      "- 每页视觉差异来自装饰、排布密度、强调层、图形关系和内容层级，不来自破坏 runtime 的结构重写。"
    ].join("\n");
  }

  private formatProgress(detail: string, orchestration: PptGenerationOrchestration, status: "running" | "completed" | "failed") {
    const step = orchestration.steps.at(-1);
    return [status === "failed" ? "HTML-PPT Agent 编排遇到问题" : "正在使用 html-ppt-skill 直写生成", "", step ? `当前步骤：${step.name}` : "", `进度说明：${detail}`, `模型调用：${orchestration.totalModelCalls} 次`, "当前编排会直接生成 index.html 与 style.css，然后由后端固定脚本复制 assets、内联主题并打包。"].filter(Boolean).join("\n");
  }

  private userContext(input: { projectName: string; context: { summaryText: string }; pendingUserMessage: PptMessageDto }) {
    return [`项目名：${input.projectName}`, input.context.summaryText ? `历史摘要：${input.context.summaryText}` : "历史摘要：无", `用户输入：${input.pendingUserMessage.content}`, input.pendingUserMessage.template ? `模板：${input.pendingUserMessage.template.label} ${input.pendingUserMessage.template.description}` : ""].filter(Boolean).join("\n");
  }

  private async readSnippet(path: string, limit: number) {
    const content = await readFile(path, "utf8").catch(() => "");
    return content.length > limit ? `${content.slice(0, limit)}\n/* truncated */` : content;
  }

  private async listDirs(path: string) {
    return (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  }

  private async listFiles(path: string, ext: string) {
    return (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((item) => item.isFile() && item.name.endsWith(ext)).map((item) => item.name).sort();
  }

  private parseJson(content: string) {
    for (const candidate of this.jsonCandidates(content)) {
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    return null;
  }

  private jsonCandidates(content: string) {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const source = (fenced ?? content).trim();
    const candidates: string[] = [];
    if (source) candidates.push(source);

    const balanced = this.extractBalancedJsonObject(source);
    if (balanced && !candidates.includes(balanced)) {
      candidates.push(balanced);
    }

    const repaired = this.repairTruncatedJsonObject(source);
    if (repaired && !candidates.includes(repaired)) {
      candidates.push(repaired);
    }

    return candidates;
  }

  private extractBalancedJsonObject(source: string) {
    const start = source.indexOf("{");
    if (start < 0) return null;

    let inString = false;
    let escape = false;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
    return null;
  }

  private repairTruncatedJsonObject(source: string) {
    const start = source.indexOf("{");
    if (start < 0) return null;
    const objectLike = source.slice(start);
    let inString = false;
    let escape = false;
    const stack: string[] = [];
    let lastSafeIndex = -1;

    for (let index = 0; index < objectLike.length; index += 1) {
      const char = objectLike[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") {
        stack.push("}");
        continue;
      }
      if (char === "[") {
        stack.push("]");
        continue;
      }
      if (char === "}" || char === "]") {
        if (stack.length > 0) stack.pop();
        lastSafeIndex = index + 1;
        continue;
      }
      if (char === ",") {
        lastSafeIndex = index;
      }
    }

    let trimmed = objectLike;
    if (inString || stack.length > 0) {
      trimmed = lastSafeIndex > 0 ? objectLike.slice(0, lastSafeIndex) : objectLike;
    }
    trimmed = trimmed.replace(/[,\s:]+$/g, "");
    if (!trimmed.startsWith("{")) return null;

    const closure = this.missingJsonClosures(trimmed);
    const repaired = `${trimmed}${closure}`;
    return repaired.includes("}") ? repaired : null;
  }

  private missingJsonClosures(source: string) {
    let inString = false;
    let escape = false;
    const stack: string[] = [];
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") stack.push("}");
      if (char === "[") stack.push("]");
      if ((char === "}" || char === "]") && stack.length > 0) stack.pop();
    }
    return `${inString ? "\"" : ""}${stack.reverse().join("")}`;
  }

  private summarizeOutput(input: string) {
    return input.replace(/\s+/g, " ").trim().slice(0, 220);
  }

  private extractContent(payload: ChatResponse) {
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map((item) => item.text ?? "").join("\n") : "";
  }

  private stripFence(content: string) {
    return content.match(/```(?:html|css|json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  }

  private providerError(payload: unknown) {
    if (payload && typeof payload === "object") {
      const c = payload as { error?: { message?: string }; message?: string };
      return c.error?.message ?? c.message ?? "模型服务返回错误。";
    }
    return "模型服务返回错误。";
  }

  private str(input: unknown, fallback: string) { return typeof input === "string" && input.trim() ? input.trim() : fallback; }
  private opt(input: unknown) { return typeof input === "string" && input.trim() ? input.trim() : undefined; }
  private strings(input: unknown) { return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []; }
  private num(input: unknown, fallback: number) { const value = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN; return Number.isFinite(value) ? value : fallback; }
}
