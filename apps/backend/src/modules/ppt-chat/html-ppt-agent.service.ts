import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { HtmlPptRendererService } from "../html-ppt-renderer/html-ppt-renderer.service";
import type { HtmlPptRenderResult } from "../html-ppt-renderer/html-ppt-renderer.types";
import { LlmConfigService } from "../llm-config/llm-config.service";
import type { PptDeckLayout, PptDeckSpec, PptGenerationOrchestration, PptGenerationStep, PptMessageDto } from "./ppt-chat.types";
import { indexSkillAssets } from "./skill-asset-indexer";
import type { SkillAssetManifest } from "./skill-asset-indexer";

type ActiveModelConfig = Awaited<ReturnType<LlmConfigService["getActiveConfig"]>>;
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatResponse = { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
type AgentPlan = {
  title: string;
  subtitle?: string;
  slideCount: number;
  audience: string;
  objective: string;
  slides: Array<{ index: number; title: string; type: string; layoutId: string; goal: string; keyPoints: string[] }>;
};
type VisualPlan = {
  primaryTheme: string;
  backupThemes: string[];
  referenceTemplates: string[];
  deckClass: string;
  visualLanguage: string;
  slideVisuals: Array<{ index: number; composition: string; animation?: string; fx?: string }>;
};
type SkillPack = {
  root: string;
  rules: string;
  layouts: string;
  fullDecks: string;
  templateNames: string[];
  layoutNames: string[];
  themeNames: string[];
  referenceSources: Array<{ name: string; index: string; css: string }>;
  manifest: SkillAssetManifest;
};

@Injectable()
export class HtmlPptAgentService {
  private readonly logger = new Logger(HtmlPptAgentService.name);

  constructor(
    @Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService,
    @Inject(HtmlPptRendererService) private readonly rendererService: HtmlPptRendererService
  ) {}

  async generateDeck(
    input: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    },
    onProgress?: (progress: { content: string; orchestration: PptGenerationOrchestration; generationStatus: "running" | "completed" | "failed" }) => Promise<void>
  ): Promise<{ deckSpec: PptDeckSpec; deckRender: HtmlPptRenderResult; orchestration: PptGenerationOrchestration }> {
    const activeConfig = await this.llmConfigService.getActiveConfig();
    const startedAt = new Date().toISOString();
    const steps: PptGenerationStep[] = [];
    let running: PptGenerationStep | null = null;
    let modelCalls = 0;

    const makeOrchestration = (): PptGenerationOrchestration => ({
      version: "html-ppt-agent-v1",
      model: activeConfig.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalModelCalls: modelCalls,
      steps: running ? [...steps, running] : steps
    });
    const publish = async (detail: string, status: "running" | "completed" | "failed") => {
      if (!onProgress) return;
      const orchestration = makeOrchestration();
      await onProgress({
        content: this.formatProgress(detail, orchestration, status),
        orchestration,
        generationStatus: status
      });
    };
    const runStep = async <T>(name: string, action: () => Promise<{ value: T; detail: string }>) => {
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
        steps.push({ ...failedStep, status: "failed", endedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : "步骤失败。" });
        running = null;
        await publish(error instanceof Error ? error.message : "步骤失败。", "failed");
        throw error;
      }
    };
    const countCall = () => { modelCalls += 1; };

    await publish("已启动 html-ppt-skill 直写编排，旧 DeckSpec renderer 不再作为主路径。", "running");

    const skill = await runStep("01 读取 skill 与模板目录", async () => {
      const value = await this.readSkillPack(input.templateId);
      return { value, detail: `读取完成：${value.manifest.layouts.length} 个布局、${value.manifest.fullDecks.length} 个模板、${value.manifest.themes.length} 个主题、${value.manifest.animations.length} 个动效、${value.manifest.fxEffects.length} 个 FX（manifest hash ${value.manifest.hash}）。` };
    });
    const research = await runStep("02 主题资料整理", async () => {
      try {
        const value = await this.modelJson(activeConfig, "你是 PPT 内容研究员。输出严格 JSON。", [
          "基于用户请求整理资料包；第一阶段暂不接入外部搜索 API，涉及实时事实请放入 needVerification。",
          this.userContext(input),
          "输出 JSON: {topicSummary,keyFacts,narrativeAngles,suggestedSections,needVerification}"
        ].join("\n\n"), countCall);
        return { value, detail: "资料包已整理。第一阶段使用模型通用知识，不执行真实外部搜索。" };
      } catch (error) {
        const value = this.fallbackResearch(input.pendingUserMessage.content);
        const reason = error instanceof Error ? error.message : "模型资料整理失败。";
        return { value, detail: `资料整理模型调用失败，已使用本地 fallback 资料包继续编排。原因：${reason}` };
      }
    });
    const plan = await runStep("03 内容规划", async () => {
      const value = this.normalizePlan(await this.modelJson(activeConfig, "你是 HTML-PPT 内容总编。只输出严格 JSON。", [
        this.userContext(input),
        `Skill rules:\n${skill.rules}`,
        `Layouts catalog:\n${skill.layouts}`,
        `Allowed layoutId values:\n${skill.layoutNames.join(", ")}`,
        `Research:\n${JSON.stringify(research)}`,
        [
          "规划原则：",
          "1. 每页必须选择一个 layoutId，layoutId 只能来自 Allowed layoutId values。",
          "2. layoutId 负责稳定页面骨架，keyPoints 负责放开内容创作；不要让所有页面都用同一种 layoutId。",
          "3. 典型顺序：cover/toc 开场；timeline、kpi-grid、comparison、process-steps、three-column、roadmap 等承载主体；cta/thanks 收尾。",
          "4. 每页 keyPoints 要给足可落地内容，不要只写抽象短词。",
          "输出 JSON: {title,subtitle,slideCount,audience,objective,slides:[{index,title,type,layoutId,goal,keyPoints}]}"
        ].join("\n")
      ].join("\n\n"), countCall), input.pendingUserMessage.content, skill);
      return { value, detail: `内容规划完成：${value.slideCount} 页，已绑定布局：${value.slides.map((slide) => `${slide.index}.${slide.layoutId}`).join(" / ")}。` };
    });
    const visual = await runStep("04 视觉方案", async () => {
      const value = this.normalizeVisual(await this.modelJson(activeConfig, "你是 HTML-PPT 视觉总监。只输出严格 JSON。", [
        `Plan:\n${JSON.stringify(plan)}`,
        `Themes:\n${skill.themeNames.join(", ")}`,
        `Templates:\n${skill.templateNames.join(", ")}`,
        `Reference snippets:\n${this.referenceText(skill)}`,
        "输出 JSON: {primaryTheme,backupThemes,referenceTemplates,deckClass,visualLanguage,slideVisuals:[{index,composition,animation,fx}]}"
      ].join("\n\n"), countCall), skill, input);
      return { value, detail: `视觉方案完成：${value.primaryTheme} / ${value.visualLanguage}` };
    });
    const indexHtml = await runStep("05 生成 index.html", async () => {
      const value = await this.generateIndexHtml(activeConfig, input, plan, visual, research, skill, countCall);
      if (!/<!doctype html/i.test(value) || !/<section\s+class=["']slide\b/i.test(value)) throw new ServiceUnavailableException("index.html 缺少 DOCTYPE 或 slide。");
      return { value, detail: `index.html 生成完成：${value.length} 字符。` };
    });
    const styleCss = await runStep("06 生成 style.css", async () => {
      return this.generateStyleCss(activeConfig, plan, visual, indexHtml, skill, countCall);
    });
    const deckRender = await runStep("07 复制 assets 与便携化打包", async () => {
      const deckRender = await this.rendererService.publishStaticDeck({
        title: plan.title,
        indexHtml,
        styleCss,
        skillRoot: skill.root,
        manifest: { generator: "html-ppt-agent-v1", plan, visual }
      });
      return { value: deckRender, detail: `导出完成：预览 ${deckRender.previewUrl}，下载 ${deckRender.downloadUrl}。` };
    });
    const qa = await runStep("08 本地 HTML 质检", async () => {
      const value = await this.qaPublishedDeck(deckRender.outputDir, plan.slides.length || plan.slideCount);
      if (value.issues.length > 0) {
        throw new ServiceUnavailableException(`本地 HTML 质检未通过：${value.issues.join("；")}`);
      }

      return {
        value,
        detail: `质检通过：${value.slides} 页，index/preview/standalone 均仅 1 个初始 active，中文 ${value.chineseChars} 字，主题内联 ${value.inlineThemes ? "完成" : "未检测到"}。`
      };
    });

    const deckSpec = this.summarySpec(plan, visual, qa.slides, qa.chineseChars);
    await publish("HTML-PPT Agent 编排完成。", "completed");
    return { deckSpec, deckRender, orchestration: makeOrchestration() };
  }

  private async readSkillPack(templateId: string): Promise<SkillPack> {
    const root = this.resolveSkillRoot();
    const fullDeckRoot = join(root, "templates", "full-decks");
    const singlePageRoot = join(root, "templates", "single-page");
    const templateNames = await this.listDirs(fullDeckRoot);
    const layoutNames = (await this.listFiles(singlePageRoot, ".html")).map((name) => basename(name, ".html"));
    const themeNames = (await this.listFiles(join(root, "assets", "themes"), ".css")).map((name) => basename(name, ".css"));
    const referenceNames = Array.from(new Set([templateId, "tech-sharing", "knowledge-arch-blueprint", "pitch-deck"])).filter((name) => templateNames.includes(name)).slice(0, 3);
    const [referenceSources, rules, layouts, fullDecks, manifest] = await Promise.all([
      Promise.all(referenceNames.map(async (name) => ({
        name,
        index: await this.readSnippet(join(fullDeckRoot, name, "index.html"), 8000),
        css: await this.readSnippet(join(fullDeckRoot, name, "style.css"), 8000)
      }))),
      this.readSnippet(join(root, "SKILL.md"), 12000),
      this.readSnippet(join(root, "references", "layouts.md"), 8000),
      this.readSnippet(join(root, "references", "full-decks.md"), 8000),
      indexSkillAssets(root)
    ]);
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

  private async modelJson(activeConfig: ActiveModelConfig, system: string, user: string, onCall: () => void) {
    const raw = await this.modelText(activeConfig, system, user, onCall);
    const parsed = this.parseJson(raw);
    if (parsed) return parsed;

    this.logger.warn(`HTML-PPT Agent JSON parse failed, requesting repair. snippet=${this.summarizeOutput(raw)}`);
    const repaired = await this.modelText(
      activeConfig,
      system,
      [
        user,
        "",
        "你上一条输出不是有效 JSON。",
        "请把上一条输出改写为严格 JSON object。",
        "禁止 markdown，禁止解释文字，禁止 ```json 代码块。",
        "必须只输出一个 JSON object，且字段名使用双引号。",
        "",
        `上一条输出：\n${raw || "（空输出）"}`
      ].join("\n"),
      onCall
    );
    const repairedParsed = this.parseJson(repaired);
    if (repairedParsed) return repairedParsed;

    throw new ServiceUnavailableException(`模型未返回有效 JSON。输出片段：${this.summarizeOutput(repaired || raw)}`);
  }

  private async modelText(activeConfig: ActiveModelConfig, system: string, user: string, onCall: () => void) {
    onCall();
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
    research: unknown,
    skill: SkillPack,
    onCall: () => void
  ) {
    const slides = plan.slides.length ? plan.slides : [{ index: 1, title: plan.title, type: "cover", layoutId: "cover", goal: plan.objective, keyPoints: [] }];
    const batchSize = 4;
    const sectionBatches: string[] = [];

    for (let start = 0; start < slides.length; start += batchSize) {
      const batch = slides.slice(start, start + batchSize);
      const batchIndexes = new Set(batch.map((slide) => slide.index));
      const batchVisuals = visual.slideVisuals.filter((item) => batchIndexes.has(item.index));
      const layoutTemplates = await this.readLayoutTemplates(skill.root, batch.map((slide) => slide.layoutId));
      const prompt = this.sectionBatchPrompt(input, plan, visual, research, skill, batch, batchVisuals, layoutTemplates, start);
      const raw = await this.modelText(activeConfig, this.sectionBatchSystemPrompt(), prompt, onCall);
      let sections = this.sanitizeSectionBatchMarkup(this.extractSlideSections(raw));
      let qa = this.validateSectionBatch(sections, batch);

      if (qa.issues.length > 0) {
        const repairRaw = await this.modelText(
          activeConfig,
          this.sectionBatchSystemPrompt(),
          [
            prompt,
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
        let repaired = this.sanitizeSectionBatchMarkup(this.extractSlideSections(repairRaw));
        let repairedQa = this.validateSectionBatch(repaired, batch);

        if (repairedQa.issues.length > 0) {
          const repairedSections = this.extractSectionList(repaired);
          const issuesBySlide = this.groupIssuesBySlide(repairedQa.issues, batch);

          for (const issueGroup of issuesBySlide) {
            const slide = batch.find((item) => item.index === issueGroup.slideIndex);
            if (!slide) continue;

            const layoutTemplate = await this.readLayoutTemplates(skill.root, [slide.layoutId]);
            const singlePrompt = this.sectionBatchPrompt(
              input,
              plan,
              visual,
              research,
              skill,
              [slide],
              batchVisuals.filter((item) => item.index === slide.index),
              layoutTemplate,
              slide.index - 1
            );
            const previousSection = repairedSections[issueGroup.batchOffset] ?? "";
            const singleRaw = await this.modelText(
              activeConfig,
              this.sectionBatchSystemPrompt(),
              [
                singlePrompt,
                "",
                "只重写这一页，不要输出其它页。",
                "必须严格复用该 layout template 的骨架，不要自造新的指标占位结构。",
                "如果某个 metric-label / metric-sm / caption / meta 节点没有内容，就直接删除该节点。",
                "当前 QA 问题：",
                ...issueGroup.issues.map((issue, index) => `${index + 1}. ${issue}`),
                "",
                `上一版 section:\n${previousSection}`
              ].join("\n"),
              onCall
            );
            const singleSections = this.extractSectionList(this.sanitizeSectionBatchMarkup(this.extractSlideSections(singleRaw)));
            if (singleSections.length !== 1) continue;
            const singleQa = this.validateSectionBatch(singleSections[0], [slide]);
            if (singleQa.issues.length === 0) {
              repairedSections[issueGroup.batchOffset] = singleSections[0];
            }
          }

          repaired = repairedSections.join("\n\n");
          repairedQa = this.validateSectionBatch(repaired, batch);
        }

        if (repairedQa.issues.length > 0) {
          throw new ServiceUnavailableException(`index.html 分批生成 QA 未通过：${repairedQa.issues.join("；")}`);
        }
        sections = repaired;
        qa = repairedQa;
      }

      sectionBatches.push(sections);
    }

    return this.composeIndexHtml(plan, visual, sectionBatches.join("\n\n"));
  }

  private sectionBatchSystemPrompt() {
    return "你是资深 HTML-PPT 作者。只输出多个 <section class=\"slide\"> 片段，不要 markdown，不要完整 HTML，不要 head/body。必须基于给定 single-page layout 模板骨架改写内容。不要生成逐字稿、讲稿或 notes。";
  }

  private sectionBatchPrompt(
    input: {
      projectName: string;
      context: { summaryText: string; recentMessages: PptMessageDto[] };
      pendingUserMessage: PptMessageDto;
      templateId: string;
      theme: string;
    },
    plan: AgentPlan,
    visual: VisualPlan,
    research: unknown,
    skill: SkillPack,
    batch: AgentPlan["slides"],
    batchVisuals: VisualPlan["slideVisuals"],
    layoutTemplates: string,
    start: number
  ) {
    return [
      this.userContext(input),
      `Deck title: ${plan.title}`,
      `Deck subtitle: ${plan.subtitle ?? ""}`,
      `Visual language: ${visual.visualLanguage}`,
      `Deck class: ${visual.deckClass}`,
      `Primary theme: ${visual.primaryTheme}`,
      `Research:\n${JSON.stringify(research).slice(0, 6000)}`,
      `Slides in this batch:\n${JSON.stringify(batch)}`,
      `Visuals in this batch:\n${JSON.stringify(batchVisuals)}`,
      `Layout templates in this batch:\n${layoutTemplates}`,
      `Relevant skill rules:\n${skill.rules.slice(0, 7000)}`,
      "User override: 本项目暂时不需要演讲者逐字稿。不要输出 <div class=\"notes\">、<aside class=\"notes\"> 或任何 speaker script。",
      [
        "输出要求：",
        `1. 只输出第 ${batch[0]?.index ?? start + 1} 到第 ${batch.at(-1)?.index ?? start + batch.length} 页的 <section> 片段。`,
        "2. 每页必须按该 slide 的 layoutId 选用对应模板；保留模板的主要 class 命名和结构层级，只替换/扩写文本、卡片、指标、时间线、流程节点等内容。",
        "3. 可以添加少量语义 class、data-anim、data-fx、data-title，但不要自造完全不同的外层 wrapper。",
        "4. 每页可见正文要信息密集但必须能单屏展示；不要写逐字稿/讲稿，长句压缩成短标题、指标、卡片和对比关系。",
        "5. 视觉创意通过内容密度、图形文本、徽章、指标、对比关系体现；底层布局必须稳定。",
        "6. 不要使用远程图片，不要输出 ```，不要输出 <!DOCTYPE html>、<html>、<head>、<body>。",
        "7. 禁止生成 notes、speaker notes、逐字稿、讲稿、备注抽屉内容。",
        "8. 禁止生成空白卡片、空白面板、只有装饰但没有信息的内容块。",
        "9. 禁止大量 inline style；每页 style 属性不超过 8 个，主要视觉交给 style.css。",
        "10. cta/thanks/summary 结尾页必须克制：最多 4 个指标卡 + 3 条总结 + 1 个 CTA，不要写成长报告页。",
        "11. chart-* 布局可以保留模板中的 canvas 和 Chart.js 初始化脚本；非 chart 布局不要使用 canvas。",
        "12. data-fx 只能放在 section 或整页装饰容器上，禁止放在 .metric-large、.metric-number、.metric-sm、普通文本或卡片内的小元素上。不要给指标数字使用 counter-explosion。",
        "13. 禁止留下空的叶子占位节点，例如空的 .metric-label、.metric-sm、.caption、.meta；如果没有内容，直接删除该节点。"
      ].join("\n")
    ].join("\n\n");
  }

  private extractSlideSections(content: string) {
    const cleaned = this.stripFence(content.replace(/<think>[\s\S]*?<\/think>/gi, "")).trim();
    const sections = cleaned.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
    return sections.join("\n\n").trim();
  }

  private extractSectionList(content: string) {
    return content.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
  }

  private sanitizeSectionBatchMarkup(sectionsHtml: string) {
    return this.extractSectionList(sectionsHtml)
      .map((section) => this.stripEmptyLeafPlaceholderNodes(section))
      .join("\n\n")
      .trim();
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

  private validateSectionBatch(sectionsHtml: string, batch: AgentPlan["slides"]) {
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

  private async qaPublishedDeck(outputDir: string, expectedSlides: number) {
    const files = await Promise.all(["index.html", "preview.html", "standalone.html"].map(async (name) => {
      const html = await readFile(join(outputDir, name), "utf8");
      return { name, html, stats: this.htmlDeckStats(html) };
    }));
    const indexStats = files.find((file) => file.name === "index.html")?.stats ?? this.htmlDeckStats("");
    const issues: string[] = [];

    // Check style.css for slide position overrides that break navigation.
    const styleCss = await readFile(join(outputDir, "style.css"), "utf8").catch(() => "");
    if (this.detectSlidePositionOverride(styleCss)) {
      issues.push("style.css 包含 .slide { position: relative/static/fixed }，会覆盖 runtime position:absolute 导致幻灯片导航失效");
    }

    for (const file of files) {
      if (file.stats.slides !== expectedSlides) {
        issues.push(`${file.name} 页数 ${file.stats.slides}，预期 ${expectedSlides}`);
      }
      if (file.stats.activeSlides !== 1) {
        issues.push(`${file.name} 初始 active 页数 ${file.stats.activeSlides}，必须为 1`);
      }
      if (file.stats.notes > 0) {
        issues.push(`${file.name} 仍包含 notes ${file.stats.notes} 个`);
      }
      if (file.stats.unsafeMetricFx > 0) {
        issues.push(`${file.name} 指标数字仍包含危险 data-fx ${file.stats.unsafeMetricFx} 个`);
      }
      if (file.stats.unresolvedMetricCounts > 0) {
        issues.push(`${file.name} 存在 ${file.stats.unresolvedMetricCounts} 个 data-count 指标仍显示为 0，占位数字未被归一化`);
      }
      if (!file.stats.runtimeProgressBeforeDeck || !file.stats.firstProgressIsRuntime) {
        issues.push(`${file.name} 运行时 progress-bar 缺失或被业务 progress-bar 抢占，runtime.js 会崩溃`);
      }
      if (file.stats.slides !== indexStats.slides) {
        issues.push(`${file.name} 页数与 index.html 不一致`);
      }
    }

    return {
      slides: indexStats.slides,
      activeSlides: indexStats.activeSlides,
      chineseChars: indexStats.chineseChars,
      inlineThemes: indexStats.inlineThemes,
      issues
    };
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
    onCall: () => void
  ) {
    const system = "你是资深 CSS 视觉设计师。只输出 CSS，不要 markdown。必须使用 html-ppt 主题变量 var(--bg)、var(--surface)、var(--text-1)、var(--text-2)、var(--accent)、var(--border)。";
    const prompt = [
      `Deck class: ${visual.deckClass}`,
      `Plan summary:\n${this.planSummaryForCss(plan)}`,
      `Visual:\n${JSON.stringify(visual).slice(0, 7000)}`,
      `Layout contract:\n${this.layoutContract()}`,
      `Index summary:\n${this.indexSummaryForCss(indexHtml)}`,
      `Reference CSS, compact:\n${skill.referenceSources.map((item) => `--- ${item.name} ---\n${item.css.slice(0, 2200)}`).join("\n\n")}`,
      [
        "要求：",
        "1. CSS 只做统一视觉皮肤、背景光效、装饰图形、卡片质感、指标/时间线/流程图的局部增强。",
        "2. 不要重新发明每页底层结构；尊重 index.html 中来自 single-page layout 的 class 命名。",
        "3. 所有主要内容必须适配 16:9 单屏展示，避免纵向长页面；使用 clamp、grid-template、max-height 控制密度。",
        "4. 禁止覆盖 .deck 和 .slide 的 position、inset、opacity、pointer-events、transform 核心运行时规则。",
        "5. 禁止把 .deck-header、.deck-footer、.slide-number 当成封面/卡片/全屏容器使用；这些是 html-ppt runtime chrome slots，不能设置 min-height、height、large padding、full-screen background、transform。",
        "6. 禁止把 .slide、.slide-inner、.slide-content 改成普通文档流长页面；每页必须保持 100vw × 100vh 的幻灯片体验。",
        "7. comparison/table 页面必须用紧凑表格或卡片矩阵，控制 cell padding、font-size、line-height，避免 5 列表格横向/纵向溢出。",
        "8. three-column/bullets 页面每列最多 4 个短块；用短标题、短句、指标和徽章，不要让卡片写成长段报告。",
        "9. 不要使用外部图片；可以使用 CSS 渐变、伪元素、clip-path、box-shadow、SVG 背景感。",
        "10. 使用 body.<deckClass> 作为主要作用域，减少污染基础 runtime。",
        "11. 结尾页、总结页、CTA 页必须更像幻灯片而不是长文报告：控制标题、指标卡和总结卡尺寸，最多两层主内容。",
        "12. 不要依赖 inline style；如果 index.html 里有少量模板 inline style，CSS 可以覆盖为更紧凑的统一尺寸。",
        "13. 输出控制在 8KB-18KB，避免冗余逐页长 CSS。",
        "14. 【严禁】绝对不能给 .slide 或 body.{deckClass} .slide 设置 position:relative / position:static / position:fixed；.slide 必须保持 position:absolute（由 runtime guard 强制），否则幻灯片导航完全失效。",
        "15. 业务进度条/进度环组件必须使用专属 class（如 .progress-item .bar、.progress-list .bar），绝对不能复用 .progress-bar——该 class 是 runtime 全局进度条专用，被 runtime.js 通过 document.querySelector('.progress-bar') 直接查找。"
      ].join("\n")
    ].join("\n\n");

    try {
      const value = await this.modelText(activeConfig, system, prompt, onCall);
      if (!value.includes("{") || !value.includes("}")) throw new ServiceUnavailableException("style.css 内容不完整。");
      // Strip position:relative/static/fixed on .slide selectors before appending the guard.
      const sanitized = this.stripSlidePositionOverride(value);
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

  private planSummaryForCss(plan: AgentPlan) {
    return [
      `title=${plan.title}`,
      plan.subtitle ? `subtitle=${plan.subtitle}` : "",
      `slideCount=${plan.slideCount}`,
      `audience=${plan.audience}`,
      `objective=${plan.objective}`,
      "slides:",
      ...plan.slides.map((slide) => `${slide.index}. ${slide.layoutId} | ${slide.title} | ${slide.goal}`)
    ].filter(Boolean).join("\n");
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
      `body.${deckClass} .notes { display: none; }`,
      "@media (max-width: 1100px) {",
      `  body.${deckClass} .grid.g3, body.${deckClass} .grid.g4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }`,
      "}"
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
      const content = await readFile(join(skillRoot, "templates", "single-page", `${layoutId}.html`), "utf8").catch(() => "");
      const section = content.match(/<section\b[\s\S]*?<\/section>/i)?.[0] ?? content;
      const compact = section.replace(/\n{3,}/g, "\n\n").trim();
      return `--- layoutId: ${layoutId} ---\n${compact.slice(0, 6500)}`;
    }));
    return snippets.join("\n\n");
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

  private referenceText(skill: SkillPack) {
    return skill.referenceSources.map((item) => `--- ${item.name}/index.html ---\n${item.index}\n--- ${item.name}/style.css ---\n${item.css}`).join("\n\n");
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
