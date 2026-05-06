import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Injectable } from "@nestjs/common";
import { deckIrSchema, type DeckIR, type SlideSlotFillIR } from "../ir";
import { DeckRendererService } from "../renderer";
import type { SkillRegistry, TemplatePackage } from "../registry";
import {
  runAuxiliaryArtifactsStage,
  runRenderVerificationStage,
  runSlotFillStage,
  type AuxiliaryArtifactsStageResult,
  type RenderVerificationIssue,
  type RenderVerificationReport
} from "../stages";
import {
  HtmlPptV2AgentService,
  type HtmlPptV2AgentInput,
  type HtmlPptV2AgentResult,
  type HtmlPptV2ProgressEvent
} from "./html-ppt-v2-agent.service";

export type HtmlPptV2PublishInput = Omit<HtmlPptV2AgentInput, "registry"> & {
  registry: SkillRegistry;
  outputRoot: string;
  deckId?: string;
  projectSlug?: string;
  allowVerificationFailure?: boolean;
};

export type HtmlPptV2PublishTrace = HtmlPptV2AgentResult["trace"] & {
  renderSource: "deterministic";
  verificationSource: "static" | "playwright";
  auxiliarySource: "deterministic";
  renderRemediation: RenderRemediationTrace;
  outputDir: string;
  files: {
    indexHtml: string;
    previewHtml: string;
    standaloneHtml: string;
    styleCss: string;
    manifest: string;
    zip: string;
    verificationReport: string;
    speakerNotes: string;
    agendaPdf: string;
    talkingPoints: string;
    qaPrep: string;
    accessibilityReport: string;
  };
};

export type RenderRemediationTrace = {
  attempted: boolean;
  accepted: boolean;
  slideIndexes: number[];
  before: { hardIssueCount: number; warningCount: number };
  after?: { hardIssueCount: number; warningCount: number };
  reason: string;
  modelCalls?: number;
};

export type HtmlPptV2PublishResult = {
  deckId: string;
  deck: DeckIR;
  outputDir: string;
  verification: RenderVerificationReport;
  auxiliary: AuxiliaryArtifactsStageResult;
  trace: HtmlPptV2PublishTrace;
};

@Injectable()
export class HtmlPptV2PublishService {
  constructor(
    private readonly agent = new HtmlPptV2AgentService(),
    private readonly renderer = new DeckRendererService()
  ) {}

  async generateAndPublish(input: HtmlPptV2PublishInput): Promise<HtmlPptV2PublishResult> {
    const outputRoot = resolve(input.outputRoot);
    const deckId = input.deckId && /^[a-zA-Z0-9_-]{8,120}$/.test(input.deckId) ? input.deckId : randomUUID();
    const outputDir = resolve(outputRoot, deckId);
    ensureChildPath(outputRoot, outputDir);
    await mkdir(outputDir, { recursive: true });

    let modelCalls = 0;
    const report = async (
      stageId: string,
      stageName: string,
      status: HtmlPptV2ProgressEvent["status"],
      detail: string,
      startedAt: string,
      endedAt?: string,
      options: Pick<HtmlPptV2ProgressEvent, "stageModelCalls" | "retryCount" | "failureReason"> = {}
    ) => {
      await input.onProgress?.({
        stageId,
        stageName,
        status,
        detail,
        startedAt,
        endedAt,
        modelCalls,
        ...options
      });
    };
    const runPublishStage = async <T>(
      stageId: string,
      stageName: string,
      action: () => Promise<T>,
      summarize: (result: T) => string
    ): Promise<T> => {
      const startedAt = new Date().toISOString();
      const stageModelCallsStart = modelCalls;
      await report(stageId, stageName, "running", `${stageName} running.`, startedAt, undefined, {
        stageModelCalls: 0,
        retryCount: 0
      });
      try {
        const result = await action();
        const stageModelCalls = Math.max(0, modelCalls - stageModelCallsStart);
        await report(stageId, stageName, "completed", summarize(result), startedAt, new Date().toISOString(), {
          stageModelCalls,
          retryCount: Math.max(0, stageModelCalls - 1)
        });
        return result;
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : `${stageName} failed.`;
        const stageModelCalls = Math.max(0, modelCalls - stageModelCallsStart);
        await report(
          stageId,
          stageName,
          "failed",
          failureReason,
          startedAt,
          new Date().toISOString(),
          {
            stageModelCalls,
            retryCount: Math.max(0, stageModelCalls - 1),
            failureReason
          }
        );
        throw error;
      }
    };

    const agentResult = await this.agent.generateDeckIr({
      ...input,
      onProgress: async (event) => {
        modelCalls = event.modelCalls;
        await input.onProgress?.(event);
      }
    });
    modelCalls = agentResult.trace.modelCalls;
    let deck = agentResult.deck;
    const selectedTemplate = resolveSelectedTemplatePackage(input.registry, agentResult.trace.templateSelection.chosenTemplateId);
    await runPublishStage("10-render", "10 Render", () => this.renderer.renderToDirectory(deck, {
      outputDir,
      registryHash: input.registry.hash,
      registry: input.registry
    }), () => `Render completed: ${outputDir}.`);
    const verifyStartedAt = new Date().toISOString();
    let verification = await runPublishStage("11-verify", "11 Verify", () => runRenderVerificationStage({
      outputDir,
      deck,
      registryHash: input.registry.hash,
      selectedTemplate
    }), (result) => `Verify completed: status=${result.status}; hard=${result.summary.hardIssueCount}; warnings=${result.summary.warningCount}.`);
    const renderRemediation = await this.runRenderRemediation({
      deck,
      verification,
      outputDir,
      registryHash: input.registry.hash,
      registry: input.registry,
      selectedTemplate,
      model: input.model
    });
    modelCalls += renderRemediation.trace.modelCalls ?? 0;
    deck = renderRemediation.deck;
    verification = renderRemediation.verification;
    if (renderRemediation.trace.attempted) {
      const remediationCalls = renderRemediation.trace.modelCalls ?? 0;
      await report(
        "11-verify",
        "11 Verify",
        "completed",
        `Verify completed: status=${verification.status}; hard=${verification.summary.hardIssueCount}; warnings=${verification.summary.warningCount}; remediation=${renderRemediation.trace.accepted ? "accepted" : "rejected"}; reason=${renderRemediation.trace.reason}.`,
        verifyStartedAt,
        new Date().toISOString(),
        {
          stageModelCalls: remediationCalls,
          retryCount: Math.max(0, remediationCalls - 1)
        }
      );
    }

    if (verification.status === "failed" && !input.allowVerificationFailure) {
      throw new Error(`HTML-PPT v2 render verification failed: ${verification.hardIssues.map((issue) => issue.message).join("; ")}`);
    }
    const auxiliary = await runPublishStage("12-artifacts", "12 Artifacts", () => runAuxiliaryArtifactsStage({
      deck,
      outputDir
    }), (result) => `Artifacts completed: ${Object.keys(result.artifacts).length} files.`);
    const publishStartedAt = new Date().toISOString();
    await report("13-publish", "13 Publish", "completed", `Publish completed: deckId=${deckId}.`, publishStartedAt, publishStartedAt, {
      stageModelCalls: 0,
      retryCount: 0
    });

    return {
      deckId,
      deck,
      outputDir,
      verification,
      auxiliary,
      trace: {
        ...agentResult.trace,
        modelCalls: agentResult.trace.modelCalls + (renderRemediation.trace.modelCalls ?? 0),
        renderSource: "deterministic",
        verificationSource: verification.mode,
        auxiliarySource: auxiliary.source,
        renderRemediation: renderRemediation.trace,
        outputDir,
        files: buildPublishedFiles(outputDir, auxiliary)
      }
    };
  }

  private async runRenderRemediation(input: {
    deck: DeckIR;
    verification: RenderVerificationReport;
    outputDir: string;
    registryHash: string;
    registry: SkillRegistry;
    selectedTemplate?: TemplatePackage;
    model?: HtmlPptV2PublishInput["model"];
  }): Promise<{ deck: DeckIR; verification: RenderVerificationReport; trace: RenderRemediationTrace }> {
    const slideIndexes = getRemediableSlideIndexes(input.verification);
    const before = issueCounts(input.verification);
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

    if (input.model) {
      const modelCandidate = await this.runModelSlotRemediation(input, input.model, slideIndexes, before);
      if (modelCandidate) {
        return modelCandidate;
      }
    }

    const candidateDeck = compactDeckForRenderVerification(input.deck, slideIndexes);
    await this.renderer.renderToDirectory(candidateDeck, {
      outputDir: input.outputDir,
      registryHash: input.registryHash,
      registry: input.registry
    });
    const candidateVerification = await runRenderVerificationStage({
      outputDir: input.outputDir,
      deck: candidateDeck,
      registryHash: input.registryHash,
      selectedTemplate: input.selectedTemplate
    });
    const after = issueCounts(candidateVerification);
    if (isVerificationImproved(before, after)) {
      return {
        deck: candidateDeck,
        verification: candidateVerification,
        trace: {
          attempted: true,
          accepted: true,
          slideIndexes,
          before,
          after,
          reason: "stage-11-feedback-compacted-stage-6-slots",
          modelCalls: 0
        }
      };
    }

    await this.renderer.renderToDirectory(input.deck, {
      outputDir: input.outputDir,
      registryHash: input.registryHash,
      registry: input.registry
    });
    const restoredVerification = await runRenderVerificationStage({
      outputDir: input.outputDir,
      deck: input.deck,
      registryHash: input.registryHash,
      selectedTemplate: input.selectedTemplate
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
        reason: "stage-11-feedback-did-not-improve-verification",
        modelCalls: 0
      }
    };
  }

  private async runModelSlotRemediation(
    input: {
      deck: DeckIR;
      outputDir: string;
      registryHash: string;
      registry: SkillRegistry;
      selectedTemplate?: TemplatePackage;
    },
    model: NonNullable<HtmlPptV2PublishInput["model"]>,
    slideIndexes: number[],
    before: { hardIssueCount: number; warningCount: number }
  ): Promise<{ deck: DeckIR; verification: RenderVerificationReport; trace: RenderRemediationTrace } | undefined> {
    try {
      const slotResult = await runSlotFillStage({
        intent: input.deck.intent,
        evidence: input.deck.evidence,
        narrative: input.deck.narrative,
        design: input.deck.design,
        layoutPlan: input.deck.layoutPlan,
        model,
        verificationFeedback: buildSlotRemediationFeedback(slideIndexes),
        targetSlideIndexes: slideIndexes
      });
      const candidateDeck = replaceRemediatedSlots(input.deck, slotResult.slots, slideIndexes, "Regenerated Stage 6 slots from Stage 11 render verification feedback.");
      await this.renderer.renderToDirectory(candidateDeck, {
        outputDir: input.outputDir,
        registryHash: input.registryHash,
        registry: input.registry
      });
      const candidateVerification = await runRenderVerificationStage({
        outputDir: input.outputDir,
        deck: candidateDeck,
        registryHash: input.registryHash,
        selectedTemplate: input.selectedTemplate
      });
      const after = issueCounts(candidateVerification);
      if (isVerificationImproved(before, after)) {
        return {
          deck: candidateDeck,
          verification: candidateVerification,
          trace: {
            attempted: true,
            accepted: true,
            slideIndexes,
            before,
            after,
            reason: "stage-11-feedback-reran-stage-6-slots",
            modelCalls: slotResult.attempts
          }
        };
      }
      await this.renderer.renderToDirectory(input.deck, {
        outputDir: input.outputDir,
        registryHash: input.registryHash,
        registry: input.registry
      });
      return {
        deck: input.deck,
        verification: await runRenderVerificationStage({
          outputDir: input.outputDir,
          deck: input.deck,
          registryHash: input.registryHash,
          selectedTemplate: input.selectedTemplate
        }),
        trace: {
          attempted: true,
          accepted: false,
          slideIndexes,
          before,
          after,
          reason: "stage-11-feedback-stage-6-rerun-did-not-improve-verification",
          modelCalls: slotResult.attempts
        }
      };
    } catch {
      return undefined;
    }
  }
}

function buildSlotRemediationFeedback(slideIndexes: number[]): string[] {
  return [
    `Stage 11 render verification detected overflow on slide(s): ${slideIndexes.join(", ")}.`,
    "For those slideIndex values, refill the same layout kind with shorter text, fewer long labels, and compact card/body copy.",
    "Preserve slideIndex, kind, citationKeys, and the existing layout plan exactly."
  ];
}

function replaceRemediatedSlots(deck: DeckIR, candidateSlots: SlideSlotFillIR[], slideIndexes: number[], summary: string): DeckIR {
  const targetSlides = new Set(slideIndexes);
  const candidateBySlide = new Map(candidateSlots.filter((slot) => targetSlides.has(slot.slideIndex)).map((slot) => [slot.slideIndex, slot]));
  const now = new Date().toISOString();
  return deckIrSchema.parse({
    ...cloneDeck(deck),
    slots: deck.slots.map((slot) => candidateBySlide.get(slot.slideIndex) ?? slot),
    meta: {
      ...deck.meta,
      checkpoints: [
        ...deck.meta.checkpoints.filter((checkpoint) => checkpoint.stage !== "stage-11:render-remediation"),
        {
          stage: "stage-11:render-remediation" as const,
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
          summary
        }
      ]
    }
  });
}

export function compactDeckForRenderVerification(deck: DeckIR, slideIndexes: number[]): DeckIR {
  const targetSlides = new Set(slideIndexes);
  const now = new Date().toISOString();
  const compacted = {
    ...cloneDeck(deck),
    slots: deck.slots.map((slot) => targetSlides.has(slot.slideIndex) ? compactSlotForRenderVerification(slot) : slot),
    meta: {
      ...deck.meta,
      checkpoints: [
        ...deck.meta.checkpoints.filter((checkpoint) => checkpoint.stage !== "stage-11:render-remediation"),
        {
          stage: "stage-11:render-remediation" as const,
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
          summary: `Compacted Stage 6 slot content for slides ${slideIndexes.join(", ")} after render verification feedback.`
        }
      ]
    }
  };
  return deckIrSchema.parse(compacted);
}

function getRemediableSlideIndexes(report: RenderVerificationReport): number[] {
  const fixableCodes = new Set([
    "browser-element-overflow",
    "browser-slide-viewport-mismatch"
  ]);
  const issues: RenderVerificationIssue[] = [...report.hardIssues, ...report.warnings];
  return [...new Set(
    issues
      .filter((issue) => typeof issue.slideIndex === "number" && issue.signal === "browser" && fixableCodes.has(issue.code))
      .map((issue) => issue.slideIndex!)
      .filter((slideIndex) => Number.isInteger(slideIndex) && slideIndex > 0)
  )].sort((a, b) => a - b);
}

function issueCounts(report: RenderVerificationReport) {
  return {
    hardIssueCount: report.summary.hardIssueCount,
    warningCount: report.summary.warningCount
  };
}

function isVerificationImproved(
  before: { hardIssueCount: number; warningCount: number },
  after: { hardIssueCount: number; warningCount: number }
) {
  const beforeScore = before.hardIssueCount * 100 + before.warningCount;
  const afterScore = after.hardIssueCount * 100 + after.warningCount;
  return afterScore < beforeScore;
}

function cloneDeck(deck: DeckIR): DeckIR {
  return JSON.parse(JSON.stringify(deck)) as DeckIR;
}

function resolveSelectedTemplatePackage(registry: SkillRegistry, templateId: string): TemplatePackage | undefined {
  return registry.templatePackages.find((template) => template.id === templateId);
}

function compactSlotForRenderVerification(slot: SlideSlotFillIR): SlideSlotFillIR {
  const base = {
    ...slot,
    title: compactText(slot.title, 68),
    ...(slot.kicker ? { kicker: compactText(slot.kicker, 48) } : {}),
    ...(slot.footer ? { footer: compactText(slot.footer, 80) } : {})
  };

  switch (slot.kind) {
    case "cover":
      return {
        ...base,
        kind: "cover",
        subtitle: slot.subtitle ? compactText(slot.subtitle, 150) : undefined,
        meta: slot.meta.slice(0, 3).map((item) => compactText(item, 28))
      };
    case "toc":
      return {
        ...base,
        kind: "toc",
        items: slot.items.slice(0, Math.max(3, Math.min(6, slot.items.length))).map((item) => ({
          label: compactText(item.label, 48),
          ...(item.description ? { description: compactText(item.description, 90) } : {})
        }))
      };
    case "two-column":
      return {
        ...base,
        kind: "two-column",
        leftTitle: compactText(slot.leftTitle, 44),
        leftBody: compactText(slot.leftBody, 210),
        rightTitle: compactText(slot.rightTitle, 44),
        rightBody: compactText(slot.rightBody, 210),
        bullets: slot.bullets.slice(0, 4).map((item) => compactText(item, 58))
      };
    case "three-column":
      return {
        ...base,
        kind: "three-column",
        cards: slot.cards.map((card) => compactCard(card, 42, 135))
      };
    case "kpi-grid":
      return {
        ...base,
        kind: "kpi-grid",
        summary: slot.summary ? compactText(slot.summary, 150) : undefined,
        metrics: slot.metrics.slice(0, Math.max(3, Math.min(4, slot.metrics.length))).map((metric) => ({
          ...metric,
          label: compactText(metric.label, 40),
          value: compactText(metric.value, 22),
          note: metric.note ? compactText(metric.note, 90) : undefined
        }))
      };
    case "timeline":
      return {
        ...base,
        kind: "timeline",
        events: slot.events.slice(0, Math.max(4, Math.min(5, slot.events.length))).map((event) => ({
          ...event,
          label: compactText(event.label, 36),
          date: event.date ? compactText(event.date, 28) : undefined,
          description: compactText(event.description, 110)
        }))
      };
    case "comparison":
      return {
        ...base,
        kind: "comparison",
        left: compactCard(slot.left, 42, 150),
        right: compactCard(slot.right, 42, 150),
        verdict: slot.verdict ? compactText(slot.verdict, 130) : undefined
      };
    case "cta":
      return {
        ...base,
        kind: "cta",
        headline: compactText(slot.headline, 70),
        action: compactText(slot.action, 110),
        supportingText: slot.supportingText ? compactText(slot.supportingText, 130) : undefined
      };
    default:
      return base as SlideSlotFillIR;
  }
}

function compactCard<T extends { title: string; body: string; citationKeys: string[]; accent?: "primary" | "secondary" | "neutral" | "good" | "warn" | "bad" }>(
  card: T,
  titleLimit: number,
  bodyLimit: number
): T {
  return {
    ...card,
    title: compactText(card.title, titleLimit),
    body: compactText(card.body, bodyLimit)
  };
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function buildPublishedFiles(outputDir: string, auxiliary: AuxiliaryArtifactsStageResult): HtmlPptV2PublishTrace["files"] {
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

function sanitizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "deck";
}

function ensureChildPath(parent: string, child: string) {
  const root = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  if (child !== parent && !child.startsWith(root)) {
    throw new Error(`Refusing to publish outside outputRoot: ${child}`);
  }
}
