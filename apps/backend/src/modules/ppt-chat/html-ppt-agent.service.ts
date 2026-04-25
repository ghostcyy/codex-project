import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { ZodType } from "zod";
import { HtmlPptRendererService } from "../html-ppt-renderer/html-ppt-renderer.service";
import type { HtmlPptRenderResult } from "../html-ppt-renderer/html-ppt-renderer.types";
import { LlmConfigService } from "../llm-config/llm-config.service";
import { LlmLoggingService } from "../llm-logging/llm-logging.service";
import { planSchema, researchSchema, structuredOutputSchemaHints, visualSchema } from "./html-ppt-agent.schemas";
import type {
  AgentPlan,
  HtmlPptAgentCheckpoint,
  HtmlPptAgentBatchSnapshot,
  HtmlPptAgentFailedIndexState,
  HtmlPptAgentFailedSlideIssue,
  HtmlPptAgentFailureRecord,
  HtmlPptAgentIndexResult,
  HtmlPptAgentInput,
  HtmlPptAgentProgress,
  HtmlPptAgentStage,
  ResearchPack,
  SkillPack,
  VisualPlan
} from "./html-ppt-agent.types";
import type { PptDeckLayout, PptDeckSpec, PptGenerationOrchestration, PptGenerationStep, PptMessageDto } from "./ppt-chat.types";
import { buildPrompt } from "./prompt-builder";
import { indexSkillAssets } from "./skill-asset-indexer";
import type { SkillAssetManifest } from "./skill-asset-indexer";

type ActiveModelConfig = Awaited<ReturnType<LlmConfigService["getActiveConfig"]>>;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatResponse = { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
type QaSignalStatus = "passed" | "healed" | "failed";
type QaSignalReport = { status: QaSignalStatus; issues: string[]; details?: Record<string, unknown> };
type QaSlideFitIssue = { slideIndex: number; planOffset: number; layoutId: string; issues: string[] };
type QaReport = {
  generatedAt: string;
  repairedSlides: number[];
  truncatedSlides: number[];
  warnings: string[];
  signals: {
    structure: QaSignalReport;
    assets: QaSignalReport;
    runtime: QaSignalReport;
    fit: QaSignalReport;
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

  constructor(
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(HtmlPptRendererService) private readonly rendererService: HtmlPptRendererService,
    @Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService
  ) {}

  async generateDeck(
    input: HtmlPptAgentInput & { userId?: number },
    onProgress?: (progress: HtmlPptAgentProgress) => Promise<void>,
    resume?: {
      checkpoint?: HtmlPptAgentCheckpoint;
      orchestration?: PptGenerationOrchestration;
    }
  ): Promise<{ deckSpec: PptDeckSpec; deckRender: HtmlPptRenderResult; orchestration: PptGenerationOrchestration }> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
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

    const makeOrchestration = (): PptGenerationOrchestration => ({
      version: "html-ppt-agent-v1",
      model: activeConfig.model,
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
      const runningDetail = `正在执行，等待 MiniMax 返回结果；单次模型请求上限 ${Math.round(this.modelRequestTimeoutMs() / 1000)} 秒。`;
      running = { id: `step-${steps.length + 1}`, name, status: "running", startedAt: started, endedAt: started, detail: runningDetail };
      await publish(`${name} 进行中。${runningDetail}`, "running");
      let heartbeatBusy = false;
      const publishHeartbeat = async () => {
        if (!running || heartbeatBusy) return;
        heartbeatBusy = true;
        try {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - new Date(started).getTime()) / 1000));
          const heartbeatDetail = `${runningDetail} 已等待 ${elapsedSeconds} 秒，仍在等待 MiniMax 返回；后台任务未停止。`;
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
        steps.push({ ...completedStep, status: "completed", endedAt: new Date().toISOString(), detail: result.detail });
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
        steps.push({ ...failedStep, status: "failed", endedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : "步骤失败。" });
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
          const prompt = buildPrompt("research", { input: agentInput, userContextText, skill: skillPack });
          const value = await this.modelStructured(activeConfig, researchSchema, structuredOutputSchemaHints.research, prompt.system, prompt.user, countCall);
          return { value, detail: "资料包已整理。第一阶段使用模型通用知识，不执行真实外部搜索。" };
        } catch (error) {
          const value = this.fallbackResearch(agentInput.pendingUserMessage.content);
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
        const prompt = buildPrompt("content-plan", { input: agentInput, userContextText, skill: skillPack, research, assetManifest: skillPack.manifest });
        const planned = await this.modelStructured(activeConfig, planSchema, structuredOutputSchemaHints.plan, prompt.system, prompt.user, countCall);
        const value = this.normalizePlan(planned, agentInput.pendingUserMessage.content, skillPack);
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
        const prompt = buildPrompt("visual-plan", { input: agentInput, userContextText, skill: skillPack, plan, assetManifest: skillPack.manifest });
        const visuals = await this.modelStructured(activeConfig, visualSchema, structuredOutputSchemaHints.visual, prompt.system, prompt.user, countCall);
        const value = this.normalizeVisual(visuals, skillPack, agentInput);
        return { value, detail: `视觉方案完成：${value.primaryTheme} / ${value.visualLanguage}` };
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
          activeConfig,
          agentInput,
          plan,
          visual,
          research,
          skillPack,
          countCall,
          stageFailureHints("05-generate-index"),
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
          detail: `index.html 生成完成：${value.html.length} 字符；${value.batchCount} 个批次，并发 ${value.concurrency}，模型修复 ${value.repairCalls} 次，本地修复 ${value.localRepairCount} 次。`
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
        return this.generateStyleCss(activeConfig, plan, visual, indexResult.html, skillPack, countCall, stageFailureHints("06-generate-style"));
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
          activeConfig,
          agentInput,
          research,
          onCall: countCall
        });
        if (value.issues.length > 0) {
          throw new ServiceUnavailableException(`本地 HTML 质检未通过：${value.issues.join("；")}`);
        }

        return {
          value,
          detail: `质检通过：${value.slides} 页，index/preview/standalone 均仅 1 个初始 active，中文 ${value.chineseChars} 字，主题内联 ${value.inlineThemes ? "完成" : "未检测到"}；结构自愈 ${value.qaReport.signals.structure.status === "healed" ? "已执行" : "未触发"}，横版适配 ${value.qaReport.signals.fit.status === "healed" ? "已修复" : "通过"}。`
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
          signals: {
            structure: { status: "passed", issues: [] },
            assets: { status: "passed", issues: [] },
            runtime: { status: "passed", issues: [] },
            fit: { status: "passed", issues: [] },
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
    if (stage === "05-generate-index") return "05-generate-index";
    if (!state.indexResult) return "05-generate-index";
    if (stage === "06-generate-style") return "06-generate-style";
    if (!state.styleCss) return "06-generate-style";
    if (stage === "07-publish") return "07-publish";
    if (!state.deckRender) return "07-publish";
    if (!existsSync(state.deckRender.outputDir)) return "07-publish";
    return stage === "completed" ? "completed" : "08-qa";
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
    onCall: () => void
  ) {
    const raw = await this.modelText(activeConfig, system, user, onCall);
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
      onCall
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

  private async modelText(activeConfig: ActiveModelConfig, system: string, user: string, onCall: (usage?: any) => void) {
    const controller = new AbortController();
    const timeoutMs = this.modelRequestTimeoutMs();
    const transportTimeoutMs = this.modelTransportTimeoutMs(timeoutMs);
    const dispatcher = this.createModelDispatcher(transportTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const id = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    this.logger.log(`HTML-PPT Agent model ${id} started: chars=${system.length + user.length}, modelTimeoutMs=${timeoutMs}, transportTimeoutMs=${transportTimeoutMs}`);
    try {
      const response = await undiciFetch(`${activeConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${activeConfig.apiKey}` },
        body: JSON.stringify({ model: activeConfig.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] satisfies ChatMessage[] }),
        signal: controller.signal,
        dispatcher
      });
      const payload = await response.json().catch(() => null) as ChatResponse | { error?: { message?: string }; message?: string } | null;
      if (!response.ok) throw new ServiceUnavailableException(this.providerError(payload));
      const content = payload && "choices" in payload ? this.extractContent(payload) : "";
      const cleaned = this.stripFence(content.replace(/<think>[\s\S]*?<\/think>/gi, "")).trim();
      
      const usage = payload && "usage" in payload ? (payload as any).usage : undefined;
      onCall(usage);
      
      this.logger.log(`HTML-PPT Agent model ${id} completed: elapsedMs=${Date.now() - startedAt}, outputChars=${cleaned.length}`);
      return cleaned;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.warn(`HTML-PPT Agent model ${id} timeout: elapsedMs=${Date.now() - startedAt}, timeoutMs=${timeoutMs}`);
        throw new ServiceUnavailableException(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒未返回。`);
      }
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
    failedIndexState?: HtmlPptAgentFailedIndexState,
    onFailureState?: (state: HtmlPptAgentFailedIndexState | undefined) => void
  ) {
    const slides = plan.slides.length ? plan.slides : [{ index: 1, title: plan.title, type: "cover", layoutId: "cover", goal: plan.objective, keyPoints: [] }];
    const batches = this.buildSectionBatches(slides, skill);
    const snapshotMap = new Map((failedIndexState?.batchSnapshots ?? []).map((item) => [item.batchIndex, item]));
    const failedBatchSnapshot = failedIndexState?.failedBatch;
    const concurrency = failedBatchSnapshot ? 1 : Math.min(this.sectionBatchConcurrency(), Math.max(1, batches.length));
    let reservedRepairCalls = 0;
    const maxRepairCalls = Math.max(2, slides.length * 2);
    const reserveRepairCall = (label: string, issues: string[]) => {
      if (reservedRepairCalls >= maxRepairCalls) {
        throw new ServiceUnavailableException(`index.html ${label}超过最大修复次数 ${maxRepairCalls}，终止继续修复。当前问题：${issues.join("；")}`);
      }
      reservedRepairCalls += 1;
    };
    const completedSnapshots: HtmlPptAgentBatchSnapshot[] = [];
    const processBatch = async (batch: AgentPlan["slides"], batchIndex: number) => {
      const cachedSnapshot = snapshotMap.get(batchIndex);
      if (
        cachedSnapshot &&
        !failedBatchSnapshot &&
        this.isCompatibleBatchSnapshot(cachedSnapshot, batch)
      ) {
        completedSnapshots.push(cachedSnapshot);
        return {
          ...cachedSnapshot,
          modelRepairCalls: 0,
          localRepairCount: 0
        };
      }

      try {
        const result = await this.processSectionBatch({
          batch,
          batchIndex,
          activeConfig,
          input,
          plan,
          visual,
          research,
          skill,
          onCall,
          reserveRepairCall,
          priorFailures,
          resumeSnapshot:
            failedBatchSnapshot && failedBatchSnapshot.batchIndex === batchIndex && this.isCompatibleBatchSnapshot(failedBatchSnapshot, batch)
              ? failedBatchSnapshot
              : undefined
        });
        completedSnapshots.push(this.toBatchSnapshot(result));
        return result;
      } catch (error) {
        if (error instanceof HtmlPptAgentBatchError) {
          onFailureState?.({
            batchSnapshots: completedSnapshots.sort((a, b) => a.batchIndex - b.batchIndex),
            failedBatch: error.snapshot
          });
        }
        throw error;
      }
    };

    const batchResults = await this.mapWithConcurrency(
      batches.map((batch, batchIndex) => ({ batch, batchIndex })),
      concurrency,
      async ({ batch, batchIndex }) => processBatch(batch, batchIndex)
    );
    const ordered = batchResults.sort((a, b) => a.batchIndex - b.batchIndex);
    onFailureState?.(undefined);

    return {
      html: this.composeIndexHtml(plan, visual, ordered.map((item) => item.sections).join("\n\n")),
      batchCount: batches.length,
      concurrency,
      repairCalls: ordered.reduce((sum, item) => sum + item.modelRepairCalls, 0),
      localRepairCount: ordered.reduce((sum, item) => sum + item.localRepairCount, 0),
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

  private extractSectionList(content: string) {
    return content.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
  }

  private sanitizeSectionBatchMarkup(sectionsHtml: string, batch: AgentPlan["slides"]) {
    let localRepairCount = 0;
    const sections = this.extractSectionList(sectionsHtml)
      .map((section, index) => {
        const repaired = this.locallyRepairSectionMarkup(section, batch[index]);
        if (repaired !== section.trim()) localRepairCount += 1;
        return repaired;
      })
      .join("\n\n")
      .trim();

    return { html: sections, localRepairCount };
  }

  private locallyRepairSectionMarkup(section: string, slide?: AgentPlan["slides"][number]) {
    let next = section;
    next = this.stripNotesBlocks(next);
    next = this.stripUnsafeMetricFx(next);
    next = this.stripEmptyLeafPlaceholderNodes(next);
    next = this.ensureSectionDataTitle(next, slide?.title);
    return next.trim();
  }

  private ensureSectionDataTitle(section: string, title?: string) {
    if (/\bdata-title=/.test(section)) return section;
    return section.replace(/<section\b/i, (match) => `${match} data-title="${this.escapeAttr(title?.trim() || "Slide")}"`);
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
    visual: VisualPlan;
    research: ResearchPack;
    skill: SkillPack;
    onCall: () => void;
    reserveRepairCall: (label: string, issues: string[]) => void;
    priorFailures?: string[];
    resumeSnapshot?: HtmlPptAgentBatchSnapshot;
  }) {
    const { batch, batchIndex, activeConfig, input: agentInput, plan, visual, research, skill, onCall, reserveRepairCall, priorFailures = [], resumeSnapshot } = input;
    const batchIndexes = new Set(batch.map((slide) => slide.index));
    const batchVisuals = visual.slideVisuals.filter((item) => batchIndexes.has(item.index));
    const layoutTemplates = await this.readLayoutTemplates(skill.root, batch.map((slide) => slide.layoutId));
    const prompt = buildPrompt("section-batch", {
      input: agentInput,
      userContextText: this.userContext(agentInput),
      skill,
      plan,
      visual,
      research,
      batch,
      batchVisuals,
      layoutTemplates,
      priorFailures
    });

    let sections = "";
    let localRepairCount = 0;
    let qa: { issues: string[] };
    let modelRepairCalls = 0;
    if (resumeSnapshot && this.isCompatibleBatchSnapshot(resumeSnapshot, batch) && resumeSnapshot.sections.trim()) {
      sections = resumeSnapshot.sections;
      qa = { issues: resumeSnapshot.qaIssues ?? this.validateSectionBatch(sections, batch, skill).issues };
    } else {
      const raw = await this.modelText(activeConfig, prompt.system, prompt.user, onCall);
      const initialSanitized = this.sanitizeSectionBatchMarkup(this.extractSlideSections(raw), batch);
      sections = initialSanitized.html;
      localRepairCount = initialSanitized.localRepairCount;
      qa = this.validateSectionBatch(sections, batch, skill);
    }

    if (qa.issues.length > 0) {
      reserveRepairCall("分批生成", qa.issues);
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
        onCall
      );
      const repairedSanitized = this.sanitizeSectionBatchMarkup(this.extractSlideSections(repairRaw), batch);
      let repaired = repairedSanitized.html;
      localRepairCount += repairedSanitized.localRepairCount;
      let repairedQa = this.validateSectionBatch(repaired, batch, skill);
      let issuesBySlide = this.groupIssuesBySlide(repairedQa.issues, batch);

      if (repairedQa.issues.length > 0) {
        const repairedSections = this.extractSectionList(repaired);
        issuesBySlide = this.groupIssuesBySlide(repairedQa.issues, batch);

        for (const issueGroup of issuesBySlide) {
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
            slide,
            slideVisual: batchVisuals.find((item) => item.index === slide.index),
            previousSection: repairedSections[issueGroup.batchOffset] ?? "",
            issues: issueGroup.issues,
            onCall,
            reserveRepairCall,
            priorFailures
          });
          const sanitizedSingle = this.sanitizeSectionBatchMarkup(this.extractSlideSections(singleRaw), [slide]);
          localRepairCount += sanitizedSingle.localRepairCount;
          const singleSections = this.extractSectionList(sanitizedSingle.html);
          if (singleSections.length !== 1) continue;
          const singleQa = this.validateSectionBatch(singleSections[0], [slide], skill);
          if (singleQa.issues.length === 0) {
            repairedSections[issueGroup.batchOffset] = singleSections[0];
          }
        }

        repaired = repairedSections.join("\n\n");
        repairedQa = this.validateSectionBatch(repaired, batch, skill);
      }

      if (repairedQa.issues.length > 0) {
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
    slide: AgentPlan["slides"][number];
    slideVisual?: VisualPlan["slideVisuals"][number];
    previousSection: string;
    issues: string[];
    onCall: () => void;
    reserveRepairCall: (label: string, issues: string[]) => void;
    priorFailures?: string[];
  }) {
    const { activeConfig, agentInput, plan, visual, research, skill, slide, slideVisual, previousSection, issues, onCall, reserveRepairCall, priorFailures = [] } = input;
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
      onCall
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

  private validateSectionBatch(sectionsHtml: string, batch: AgentPlan["slides"], skill?: SkillPack) {
    const sections = sectionsHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    const issues: string[] = [];

    if (sections.length !== batch.length) {
      issues.push(`本批应返回 ${batch.length} 页，实际返回 ${sections.length} 页`);
    }

    sections.forEach((section, index) => {
      const slide = batch[index];
      const label = slide ? `第 ${slide.index} 页(${slide.layoutId})` : `第 ${index + 1} 个 section`;
      const visibleText = this.visibleSlideText(section);
      const styleCount = (section.match(/\sstyle=/gi) ?? []).length;
      const sectionChars = section.length;
      const isClosing = slide ? ["cta", "thanks"].includes(slide.layoutId) : false;
      const maxVisibleChars = isClosing ? 620 : 820;
      const maxSectionChars = isClosing ? 7200 : 9500;

      if (!/\bdata-title=/.test(section)) issues.push(`${label} 缺少 data-title`);
      if (/<(?:div|aside)\b[^>]*class=["'][^"']*\bnotes\b/i.test(section)) issues.push(`${label} 含 notes/逐字稿，请删除 notes 并只保留观众可见内容`);
      if (visibleText.length > maxVisibleChars) issues.push(`${label} 可见文字 ${visibleText.length} 字，超过 ${maxVisibleChars}，请压缩为短标题、指标、卡片和对比关系`);
      if (sectionChars > maxSectionChars) issues.push(`${label} HTML ${sectionChars} 字符，超过 ${maxSectionChars}，页面结构过重，容易纵向溢出`);
      if (styleCount > 8) issues.push(`${label} inline style 数量 ${styleCount}，超过 8，说明偏离模板骨架`);
      if (/<[^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*\sdata-fx=/i.test(section)) issues.push(`${label} 指标数字不应使用 data-fx，会产生数字层遮挡`);
      if (/<script\b/gi.test(section) && !/<canvas\b/i.test(section)) issues.push(`${label} 含 script 但不是 chart canvas 场景，请移除脚本`);
      if (/<canvas\b/i.test(section) && slide && !slide.layoutId.startsWith("chart-")) issues.push(`${label} 非 chart layout 不应使用 canvas`);

      const emptyBlocks = this.findEmptyContentBlocks(section);
      if (emptyBlocks.length > 0) {
        issues.push(`${label} 存在空白内容块：${emptyBlocks.slice(0, 3).join(", ")}`);
      }

      if (slide && skill) {
        issues.push(...this.estimateLandscapeFitIssues(section, slide, skill).map((issue) => `${label} ${issue}`));
      }
    });

    return { issues };
  }

  private visibleSlideText(section: string) {
    return this.stripNotesBlocks(section)
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
    const cleanSections = this.normalizeInitialActiveSlide(this.stripUnsafeMetricFx(this.stripNotesBlocks(sections)));
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
    let files = await Promise.all(htmlFileNames.map(async (name) => ({
      name,
      html: await readFile(join(outputDir, name), "utf8").catch(() => ""),
    })));
    let styleCss = await readFile(join(outputDir, "style.css"), "utf8").catch(() => "");
    let structureHealed = false;
    let fitHealed = false;
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

    let evaluation = await this.evaluatePublishedDeckQa({
      outputDir,
      expectedSlides,
      plan,
      visual,
      skill,
      files,
      styleCss,
      structureHealed,
      fitHealed,
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
          files,
          styleCss,
          structureHealed,
          fitHealed,
          repairedSlides,
          truncatedSlides
        });
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
          files,
          styleCss,
          structureHealed,
          fitHealed,
          repairedSlides,
          truncatedSlides
        });
      }
    }

    await this.writeQaReportToManifest(outputDir, evaluation.qaReport);
    return evaluation;
  }

  private healPublishedHtml(html: string) {
    return this.ensureRuntimeProgressBar(
      this.normalizeMetricCountPlaceholders(
        this.normalizeInitialActiveSlide(this.stripUnsafeMetricFx(this.stripNotesBlocks(html)))
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
    files: Array<{ name: "index.html" | "preview.html" | "standalone.html"; html: string }>;
    styleCss: string;
    structureHealed: boolean;
    fitHealed: boolean;
    repairedSlides: number[];
    truncatedSlides: number[];
  }) {
    const { outputDir, expectedSlides, plan, visual, skill, files, styleCss, structureHealed, fitHealed, repairedSlides, truncatedSlides } = input;
    const filesWithStats = files.map((file) => ({ ...file, stats: this.htmlDeckStats(file.html) }));
    const indexFile = filesWithStats.find((file) => file.name === "index.html");
    const indexStats = indexFile?.stats ?? this.htmlDeckStats("");
    const structureIssues: string[] = [];
    const blockingAssetIssues: string[] = [];
    const advisoryAssetIssues: string[] = [];
    const runtimeIssues: string[] = [];
    const fitIssues: string[] = [];
    const fitSlideIssues: QaSlideFitIssue[] = [];
    const themeContrastIssues: string[] = [];
    const blockingPortabilityIssues: string[] = [];
    const advisoryPortabilityIssues: string[] = [];

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
    plan.slides.forEach((slide, index) => {
      const section = sections[index];
      if (!section) return;
      const issues = this.estimateLandscapeFitIssues(section, slide, skill);
      if (issues.length === 0) return;
      fitSlideIssues.push({ slideIndex: slide.index, planOffset: index, layoutId: slide.layoutId, issues });
      fitIssues.push(...issues.map((issue) => `第 ${slide.index} 页(${slide.layoutId}) ${issue}`));
    });

    themeContrastIssues.push(...this.collectThemeContrastIssues(visual, skill));
    const portability = await this.collectPortabilityIssues(outputDir, filesWithStats);
    blockingPortabilityIssues.push(...portability.blocking);
    advisoryPortabilityIssues.push(...portability.advisory);

    const blockingIssues = [...structureIssues, ...blockingAssetIssues, ...runtimeIssues, ...blockingPortabilityIssues];
    const warnings = [...advisoryAssetIssues, ...fitIssues, ...themeContrastIssues, ...advisoryPortabilityIssues];

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
        themeContrast: this.makeQaSignal(themeContrastIssues, false, { primaryTheme: visual.primaryTheme }),
        portability: this.makeQaSignal([...blockingPortabilityIssues, ...advisoryPortabilityIssues], false)
      },
      issues: blockingIssues
    };

    return {
      slides: indexStats.slides,
      activeSlides: indexStats.activeSlides,
      chineseChars: indexStats.chineseChars,
      inlineThemes: indexStats.inlineThemes,
      issues: blockingIssues,
      qaReport
    };
  }

  private makeQaSignal(issues: string[], healed: boolean, details?: Record<string, unknown>): QaSignalReport {
    return {
      status: issues.length > 0 ? "failed" : healed ? "healed" : "passed",
      issues,
      ...(details ? { details } : {})
    };
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

  private estimateLandscapeFitIssues(section: string, slide: AgentPlan["slides"][number], skill: SkillPack) {
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
      densityBudget: layout.densityBudget
    });
    const textBudget = budgetProfile.textBudget;
    const titleBudget = budgetProfile.titleBudget;
    const itemBudget = budgetProfile.itemBudget;
    const cardBudget = budgetProfile.cardBudget;

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

    const pressureScore =
      visibleTextLength / Math.max(1, textBudget) +
      liCount / Math.max(1, itemBudget) +
      cardCount / Math.max(1, cardBudget) +
      titleText.length / Math.max(1, titleBudget);
    if (pressureScore > 3.2) {
      issues.push(`密度压力分 ${pressureScore.toFixed(2)}，估算在 16:9 横版下会发生拥挤或遮挡`);
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
  }) {
    const { slide, titleText, visibleTextLength, densityBudget } = input;
    const topicCount = Math.max(1, slide.keyPoints.length);
    const avgPointLength =
      slide.keyPoints.length > 0
        ? Math.round(slide.keyPoints.reduce((sum, item) => sum + item.trim().length, 0) / slide.keyPoints.length)
        : 0;
    const compactTopicSet = topicCount <= 3 && avgPointLength <= 18;
    const compactTitle = titleText.length > 0 && titleText.length <= Math.max(10, densityBudget.maxTitleChars * 0.72);
    const compactText = visibleTextLength <= Math.round(densityBudget.maxBodyCharsTotal * 0.78);
    const longTitlePenalty = titleText.length > densityBudget.maxTitleChars ? 1 : 0;
    const denseTopicPenalty = topicCount >= Math.max(5, densityBudget.maxItems) ? 1 : 0;
    const longPointPenalty = avgPointLength >= 30 ? 1 : 0;

    let cardBudget = Math.max(1, densityBudget.maxCardCount || 1);
    if (compactTopicSet && compactTitle && compactText) {
      cardBudget += 1;
    }
    if (slide.layoutId === "two-column" && topicCount >= 4 && avgPointLength >= 22) {
      cardBudget = Math.min(cardBudget, 2);
    }
    cardBudget = Math.max(1, cardBudget - longTitlePenalty - denseTopicPenalty);

    const titleBudget = Math.max(10, densityBudget.maxTitleChars - denseTopicPenalty * 2);
    const itemBudget = Math.max(1, densityBudget.maxItems + (compactTopicSet ? 1 : 0) - longPointPenalty);
    const textBudget = Math.max(
      140,
      densityBudget.maxBodyCharsTotal + (compactTopicSet ? 60 : 0) - longTitlePenalty * 40 - denseTopicPenalty * 50 - longPointPenalty * 30
    );

    return { cardBudget, titleBudget, itemBudget, textBudget };
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
    let files = currentFiles;
    const indexFile = files.find((file) => file.name === "index.html");
    if (!indexFile) return { applied: false, files, repairedSlides: [] as number[] };

    const sections = this.extractSectionList(indexFile.html);
    const repairedSlides: number[] = [];
    for (const slideIssue of slideIssues.slice(0, 2)) {
      const slide = plan.slides.find((item) => item.index === slideIssue.slideIndex);
      if (!slide) continue;
      const previousSection = sections[slide.index - 1] ?? "";
      const singleRaw = await this.repairSingleSlideFromSkeleton({
        activeConfig,
        agentInput,
        plan,
        visual,
        research,
        skill,
        slide,
        slideVisual: visual.slideVisuals.find((item) => item.index === slide.index),
        previousSection,
        issues: slideIssue.issues,
        onCall,
        reserveRepairCall: () => undefined
      });
      const sanitizedSingle = this.sanitizeSectionBatchMarkup(this.extractSlideSections(singleRaw), [slide]);
      const singleSections = this.extractSectionList(sanitizedSingle.html);
      if (singleSections.length !== 1) continue;
        const candidate = singleSections[0];
        const candidateQa = this.validateSectionBatch(candidate, [slide], skill);
        if (candidateQa.issues.length > 0) continue;
        if (this.estimateLandscapeFitIssues(candidate, slide, skill).length > 0) continue;
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
      const truncated = this.truncateSectionToDensityBudget(currentSection, slide, skill);
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

  private truncateSectionToDensityBudget(section: string, slide: AgentPlan["slides"][number], skill: SkillPack) {
    const layout = (skill.manifest?.layouts ?? []).find((item) => item.id === slide.layoutId);
    if (!layout?.densityBudget) return section;

    let next = section;
    next = this.limitSectionListItems(next, layout.densityBudget.maxItems);
    next = this.trimHeadingText(next, layout.densityBudget.maxTitleChars);
    next = this.trimLeafTextBudget(next, layout.densityBudget.maxBodyCharsTotal);
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

  private collectThemeContrastIssues(visual: VisualPlan, skill: SkillPack) {
    const issues: string[] = [];
    const theme = (skill.manifest?.themes ?? []).find((item) => item.id === visual.primaryTheme);
    if (!theme) return issues;
    const ratio = this.contrastRatio(theme.palette.text1, theme.palette.bg);
    if (ratio === null) {
      issues.push(`主题 ${visual.primaryTheme} 的 --text-1 或 --bg 无法解析，无法验证 WCAG 对比度`);
      return issues;
    }
    if (ratio < 4.5) {
      issues.push(`主题 ${visual.primaryTheme} 的 --text-1 与 --bg 对比度仅 ${ratio.toFixed(2)}，低于 WCAG AA 4.5`);
    }
    return issues;
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

  private sanitizeGeneratedCss(css: string) {
    const withoutUnsupportedAtRules = this.stripUnsupportedCssAtRules(css);
    return withoutUnsupportedAtRules.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector: string, body: string) => {
      if (this.selectorListTargetsProgressBar(selector)) return "";
      if (this.selectorListTargetsSlideDirectChild(selector)) return "";
      if (this.selectorListTargetsUnapprovedSlideSelf(selector)) return "";

      let sanitizedBody = body;
      if (this.selectorListTargetsSlideSelf(selector)) {
        sanitizedBody = this.stripDisallowedSlideDeclarations(sanitizedBody);
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
    return css.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector: string, body: string) => {
      if (!this.selectorListTargetsSlideSelf(selector)) return match;
      const sanitized = body.replace(/\bposition\s*:\s*(relative|static|fixed)\s*(!important)?\s*;?/gi, "/* position: $1 removed by runtime guard */");
      return `${selector}{${sanitized}}`;
    });
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
    return body
      .replace(/\bposition\s*:\s*[^;]+;?/gi, "/* position removed by CSS sanitizer */")
      .replace(/\boverflow(?:-x|-y)?\s*:\s*[^;]+;?/gi, "/* overflow removed by CSS sanitizer */");
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
    priorFailures: string[] = []
  ) {
    const selectedThemePalette = await this.readThemePalettePrompt(skill, visual.primaryTheme);
    const prompt = buildPrompt("css", {
      userContextText: "",
      skill,
      plan,
      visual,
      indexHtmlSummary: this.indexSummaryForCss(indexHtml),
      layoutContract: this.layoutContract(),
      selectedThemePalette,
      priorFailures
    });

    try {
      const value = await this.modelText(activeConfig, prompt.system, prompt.user, onCall);
      if (!value.includes("{") || !value.includes("}")) throw new ServiceUnavailableException("style.css 内容不完整。");
      const sanitized = this.sanitizeGeneratedCss(value);
      const guarded = this.appendRuntimeCssGuard(sanitized);
      return { value: guarded, detail: `style.css 生成完成：${guarded.length} 字符。` };
    } catch (error) {
      const guarded = this.appendRuntimeCssGuard(this.fallbackStyleCss(visual));
      return {
        value: guarded,
        detail: `style.css 模型调用失败，已使用本地稳定样式继续打包。原因：${this.describeError(error)}`
      };
    }
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

  private escapeHtml(input: string) {
    return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapeAttr(input: string) {
    return this.escapeHtml(input).replace(/"/g, "&quot;");
  }

  private appendRuntimeCssGuard(css: string) {
    return [
      css.trim(),
      "",
      "/* Runtime guard: keep html-ppt slide navigation functional.",
      "   !important on position/opacity/pointer-events prevents model-generated",
      "   'body.{deckClass} .slide { position: relative }' (specificity 0,2,1) from",
      "   overriding '.deck > .slide { position: absolute }' (specificity 0,2,0). */",
      ".deck > .slide {",
      "  position: absolute !important;",
      "  inset: 0;",
      "  width: 100vw;",
      "  height: 100vh;",
      "  opacity: 0;",
      "  pointer-events: none !important;",
      "  transform: translateX(30px);",
      "}",
      ".deck > .slide.is-active {",
      "  opacity: 1 !important;",
      "  pointer-events: auto !important;",
      "  transform: translateX(0);",
      "  z-index: 2;",
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
      ".deck > .slide :where(.cta-tagline.gradient-text, .cta-lede.gradient-text) {",
      "  background: none !important;",
      "  -webkit-background-clip: border-box !important;",
      "  background-clip: border-box !important;",
      "  -webkit-text-fill-color: currentColor !important;",
      "  color: var(--text-1) !important;",
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

  private normalizePlan(input: unknown, fallbackTitle: string, skill: SkillPack): AgentPlan {
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
    return { title: this.str(c.title, fallbackTitle).slice(0, 80), subtitle: this.opt(c.subtitle), slideCount: this.num(c.slideCount, slides.length || 8), audience: this.str(c.audience, "普通观众"), objective: this.str(c.objective, "生成 HTML-PPT"), slides: slides.length ? slides : [{ index: 1, title: this.str(c.title, fallbackTitle), type: "cover", layoutId: "cover", goal: "封面", keyPoints: [] }] };
  }

  private normalizeVisual(input: unknown, skill: SkillPack, fallback: { templateId: string; theme: string }): VisualPlan {
    const c = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const primaryTheme = skill.themeNames.includes(this.str(c.primaryTheme, "")) ? this.str(c.primaryTheme, "") : (skill.themeNames.includes(fallback.theme) ? fallback.theme : skill.themeNames[0] ?? "gruvbox-dark");
    return {
      primaryTheme,
      backupThemes: this.strings(c.backupThemes).filter((item) => skill.themeNames.includes(item) && item !== primaryTheme).slice(0, 8),
      referenceTemplates: this.strings(c.referenceTemplates).filter((item) => skill.templateNames.includes(item)).slice(0, 4),
      deckClass: this.str(c.deckClass, "tpl-html-ppt-agent").replace(/[^a-z0-9_-]/gi, "-"),
      visualLanguage: this.str(c.visualLanguage, "高质量 HTML-PPT 视觉系统"),
      slideVisuals: (Array.isArray(c.slideVisuals) ? c.slideVisuals : []).map((item, index) => {
        const s = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { index: this.num(s.index, index + 1), composition: this.str(s.composition, "强标题与卡片组合"), animation: this.opt(s.animation), fx: this.opt(s.fx) };
      })
    };
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

  private fallbackResearch(userPrompt: string) {
    return {
      topicSummary: userPrompt.slice(0, 240),
      keyFacts: [
        "模型资料整理阶段未返回结果，本资料包由后端兜底生成。",
        "后续内容规划阶段需要根据用户原始需求自行补全事实、结构和叙事重点。",
        "涉及实时数据、市场份额、具体年份排名或最新趋势的内容，需要在 needVerification 中标记待核验。"
      ],
      narrativeAngles: ["发展脉络", "品牌定位", "核心竞争力", "用户价值", "未来趋势"],
      suggestedSections: ["开场定义", "发展历程", "品牌拆解", "关键数据/指标", "趋势判断", "总结行动"],
      needVerification: ["实时事实与最新数据未执行外部搜索，需要人工或后续联网核验。"]
    };
  }

  private async readLayoutTemplates(skillRoot: string, layoutIds: string[]) {
    const unique = Array.from(new Set(layoutIds));
    const snippets = await Promise.all(unique.map(async (layoutId) => {
      const compact = (await this.readSingleLayoutTemplate(skillRoot, layoutId)).replace(/\n{3,}/g, "\n\n").trim();
      return `--- layoutId: ${layoutId} ---\n${compact.slice(0, 6500)}`;
    }));
    return snippets.join("\n\n");
  }

  private async readSingleLayoutTemplate(skillRoot: string, layoutId: string) {
    const content = await readFile(join(skillRoot, "templates", "single-page", `${layoutId}.html`), "utf8").catch(() => "");
    return content.match(/<section\b[\s\S]*?<\/section>/i)?.[0] ?? content;
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
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const source = fenced ?? content;
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    const text = start >= 0 && end > start ? source.slice(start, end + 1) : source;
    try { return JSON.parse(text); } catch { return null; }
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
