import { deckIrSchema, type DeckIR } from "../ir";
import type { SkillRegistry, TemplatePackage } from "../registry";
import {
  runAssetStage,
  runChoreographyStage,
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  runCriticStage,
  runSlotFillStage,
  runTemplateSelectionStage,
  type JsonOnlyModelClient,
  type ResearchClient,
  type TemplateSelectionCandidate,
  type TemplateSelectionResult
} from "../stages";

export type HtmlPptV2AgentInput = {
  userPrompt: string;
  conversationContext?: string[];
  userPreferences?: Record<string, unknown>;
  registry: SkillRegistry;
  pinnedTemplate?: TemplatePackage;
  model?: JsonOnlyModelClient;
  researchClient?: ResearchClient;
  onProgress?: HtmlPptV2ProgressReporter;
};

export type HtmlPptV2ProgressStatus = "running" | "completed" | "failed";

export type HtmlPptV2ProgressEvent = {
  stageId: string;
  stageName: string;
  status: HtmlPptV2ProgressStatus;
  detail: string;
  startedAt: string;
  endedAt?: string;
  modelCalls: number;
  stageModelCalls?: number;
  retryCount?: number;
  failureReason?: string;
};

export type HtmlPptV2ProgressReporter = (event: HtmlPptV2ProgressEvent) => void | Promise<void>;

export type HtmlPptV2AgentResult = {
  deck: DeckIR;
  trace: {
    intentSource: "model" | "fallback";
    evidenceSource: "model" | "fallback";
    templateSelectionSource: "pinned" | "auto-deterministic" | "auto-llm";
    templateSelection: {
      chosenTemplateId: string;
      shortlist: string[];
      shortlistScores?: TemplateSelectionTraceCandidate[];
      rationale: string;
      confidence: "high" | "medium" | "low";
    };
    narrativeSource: "model" | "fallback";
    designSource: "model" | "fallback" | "pinned";
    layoutPlanSource: "model" | "fallback" | "pinned";
    slotFillSource: "model" | "fallback";
    assetSource: "deterministic" | "llm-assisted";
    choreographySource: "deterministic" | "llm-assisted";
    criticSource: "deterministic" | "llm-critic-loop";
    criticRounds: number;
    stageAttempts: Record<string, number>;
    modelCalls: number;
    warnings: string[];
  };
};

export type TemplateSelectionTraceCandidate = {
  id: string;
  deterministicScore: number;
  breakdown: {
    audienceFit: number;
    formatFit: number;
    toneFit: number;
    promptSignals: number;
    forbidPromptSignals: number;
    defaultSlideCount: number;
  };
};

export class HtmlPptV2AgentService {
  async generateDeckIr(input: HtmlPptV2AgentInput): Promise<HtmlPptV2AgentResult> {
    const stageAttempts: Record<string, number> = {
      intent: 0,
      templateSelection: 0,
      evidence: 0,
      narrative: 0,
      design: 0,
      layoutPlan: 0,
      slotFill: 0,
      critic: 0
    };
    let modelCalls = 0;
    const runStage = async <T>(
      stageId: string,
      stageName: string,
      attemptKey: keyof typeof stageAttempts | undefined,
      action: () => Promise<T>,
      summarize: (result: T) => string
    ): Promise<T> => {
      const startedAt = new Date().toISOString();
      const stageModelCallsStart = modelCalls;
      await input.onProgress?.({
        stageId,
        stageName,
        status: "running",
        detail: `${stageName} running.`,
        startedAt,
        modelCalls,
        stageModelCalls: 0,
        retryCount: 0
      });
      try {
        const result = await action();
        const attempts = (result as { attempts?: unknown }).attempts;
        if (attemptKey && typeof attempts === "number") {
          stageAttempts[attemptKey] = attempts;
          modelCalls += attempts;
        }
        const stageModelCalls = Math.max(0, modelCalls - stageModelCallsStart);
        await input.onProgress?.({
          stageId,
          stageName,
          status: "completed",
          detail: summarize(result),
          startedAt,
          endedAt: new Date().toISOString(),
          modelCalls,
          stageModelCalls,
          retryCount: Math.max(0, stageModelCalls - 1)
        });
        return result;
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : `${stageName} failed.`;
        const stageModelCalls = Math.max(0, modelCalls - stageModelCallsStart);
        await input.onProgress?.({
          stageId,
          stageName,
          status: "failed",
          detail: failureReason,
          startedAt,
          endedAt: new Date().toISOString(),
          modelCalls,
          stageModelCalls,
          retryCount: Math.max(0, stageModelCalls - 1),
          failureReason
        });
        throw error;
      }
    };

    const intentResult = await runStage(
      "01-intent",
      "01 Intent",
      "intent",
      () => runIntentStage({
        userPrompt: input.userPrompt,
        conversationContext: input.conversationContext,
        userPreferences: input.userPreferences,
        model: input.model
      }),
      (result) => `Intent source=${result.source}; topic=${result.intent.topic}; slides=${result.intent.derivedSlideCount}.`
    );
    const templateSelectionResult = await runStage(
      "01b-template-select",
      "01b Template Select",
      "templateSelection",
      () => runTemplateSelectionStage({
        intent: intentResult.intent,
        registry: input.registry,
        rawPrompt: input.userPrompt,
        pinnedTemplate: input.pinnedTemplate,
        model: input.model
      }),
      (result) => summarizeTemplateSelectionProgress(result)
    );
    const selectedTemplate = templateSelectionResult.selectedTemplate;
    const evidenceResult = await runStage(
      "02-evidence",
      "02 Evidence",
      "evidence",
      () => runEvidenceStage({
        intent: intentResult.intent,
        model: input.model,
        researchClient: input.researchClient
      }),
      (result) => `Evidence source=${result.source}; facts=${result.evidence.facts.length}; dataPoints=${result.evidence.dataPoints.length}.`
    );
    const narrativeResult = await runStage(
      "03-narrative",
      "03 Narrative",
      "narrative",
      () => runNarrativeStage({
        intent: intentResult.intent,
        evidence: evidenceResult.evidence,
        model: input.model
      }),
      (result) => `Narrative source=${result.source}; slides=${result.narrative.slides.length}; chars=${result.narrative.totalEstimatedChars}.`
    );
    const designResult = await runStage(
      "04-design",
      "04 Design",
      "design",
      () => runDesignStage({
        intent: intentResult.intent,
        evidence: evidenceResult.evidence,
        narrative: narrativeResult.narrative,
        registry: input.registry,
        pinnedTemplate: selectedTemplate,
        model: input.model
      }),
      (result) => `Design source=${result.source}; theme=${result.design.themeId}; donor=${result.design.donorTemplateId}.`
    );
    const layoutPlanResult = await runStage(
      "05-layout",
      "05 Layout",
      "layoutPlan",
      () => runLayoutPlanStage({
        intent: intentResult.intent,
        narrative: narrativeResult.narrative,
        design: designResult.design,
        registry: input.registry,
        pinnedTemplate: selectedTemplate,
        model: input.model
      }),
      (result) => `Layout source=${result.source}; layouts=${result.layoutPlan.map((item) => item.layoutId).join(", ")}.`
    );
    const slotFillResult = await runStage(
      "06-slots",
      "06 Slots",
      "slotFill",
      () => runSlotFillStage({
        intent: intentResult.intent,
        evidence: evidenceResult.evidence,
        narrative: narrativeResult.narrative,
        design: designResult.design,
        layoutPlan: layoutPlanResult.layoutPlan,
        model: input.model
      }),
      (result) => `Slots source=${result.source}; slots=${result.slots.length}.`
    );
    const assetResult = await runStage(
      "07-assets",
      "07 Assets",
      undefined,
      () => runAssetStage({
        slots: slotFillResult.slots,
        design: designResult.design,
        evidence: evidenceResult.evidence
      }),
      (result) => `Assets source=${result.source}; assets=${Object.keys(result.assets).length}.`
    );
    const choreographyResult = await runStage(
      "08-choreography",
      "08 Choreography",
      undefined,
      () => runChoreographyStage({
        narrative: narrativeResult.narrative,
        design: designResult.design,
        slots: slotFillResult.slots
      }),
      (result) => `Choreography source=${result.source}; entries=${result.choreography.length}.`
    );
    const deckBeforeCritic = deckIrSchema.parse({
      intent: intentResult.intent,
      evidence: evidenceResult.evidence,
      narrative: narrativeResult.narrative,
      design: designResult.design,
      layoutPlan: layoutPlanResult.layoutPlan,
      slots: slotFillResult.slots,
      assets: assetResult.assets,
      choreography: choreographyResult.choreography,
      meta: {
        irVersion: "v1",
        revisionRound: 0,
        // The critic stage owns final scoring; keep pre-critic scores neutral.
        qualityScores: {
          factual: 0,
          narrative: 0,
          visual: 0,
          density: 0,
          accessibility: 0,
          overall: 0
        },
        generatedAt: new Date().toISOString(),
        checkpoints: [
          checkpoint("stage-1:intent", `Intent source: ${intentResult.source}`),
          checkpoint("stage-2:template-select", `Template source: ${templateSelectionResult.source}; selected=${selectedTemplate.id}`),
          checkpoint("stage-3:evidence", `Evidence source: ${evidenceResult.source}; facts=${evidenceResult.evidence.facts.length}`),
          checkpoint("stage-4:narrative", `Narrative source: ${narrativeResult.source}; slides=${narrativeResult.narrative.slides.length}`),
          checkpoint("stage-5:design", `Design source: ${designResult.source}; theme=${designResult.design.themeId}`),
          checkpoint("stage-6:layout", `Layout source: ${layoutPlanResult.source}; layouts=${layoutPlanResult.layoutPlan.length}`),
          checkpoint("stage-7:slots", `Slot source: ${slotFillResult.source}; slots=${slotFillResult.slots.length}`),
          checkpoint("stage-8:assets", `Asset source: ${assetResult.source}; assets=${Object.keys(assetResult.assets).length}`),
          checkpoint("stage-9:choreography", `Choreography source: ${choreographyResult.source}; entries=${choreographyResult.choreography.length}`)
        ]
      }
    });
    const criticResult = await runStage(
      "09-critic",
      "09 Critic",
      "critic",
      () => runCriticStage({ deck: deckBeforeCritic, model: input.model }),
      (result) => `Critic source=${result.source}; rounds=${result.reports.length}; score=${result.deck.meta.qualityScores.overall}.`
    );

    return {
      deck: criticResult.deck,
      trace: {
        intentSource: intentResult.source,
        templateSelectionSource: templateSelectionResult.source,
        templateSelection: traceTemplateSelection(templateSelectionResult),
        evidenceSource: evidenceResult.source,
        narrativeSource: narrativeResult.source,
        designSource: designResult.source,
        layoutPlanSource: layoutPlanResult.source,
        slotFillSource: slotFillResult.source,
        assetSource: assetResult.source,
        choreographySource: choreographyResult.source,
        criticSource: criticResult.source,
        criticRounds: criticResult.reports.length,
        stageAttempts,
        modelCalls,
        warnings: [
          ...evidenceResult.researchErrors,
          ...assetResult.warnings,
          ...choreographyResult.warnings,
          ...criticResult.warnings
        ]
      }
    };
  }
}

function checkpoint(stage: `stage-${number}:${string}`, summary: string) {
  const now = new Date().toISOString();
  return {
    stage,
    status: "completed" as const,
    startedAt: now,
    completedAt: now,
    summary
  };
}

export function traceTemplateSelection(result: TemplateSelectionResult) {
  return {
    chosenTemplateId: result.selectedTemplate.id,
    shortlist: result.shortlist.map((candidate) => candidate.id),
    shortlistScores: result.shortlist.map(traceTemplateSelectionCandidate),
    rationale: result.rationale,
    confidence: result.confidence
  };
}

export function summarizeTemplateSelectionProgress(result: TemplateSelectionResult): string {
  return [
    `Template source=${result.source}`,
    `selected=${result.selectedTemplate.id}`,
    `shortlist=${result.shortlist.map((item) => item.id).join(", ")}`,
    `scores=${result.shortlist.map(formatTemplateSelectionTraceCandidate).join(" | ")}`
  ].join("; ") + ".";
}

function traceTemplateSelectionCandidate(candidate: TemplateSelectionCandidate): TemplateSelectionTraceCandidate {
  return {
    id: candidate.id,
    deterministicScore: candidate.deterministicScore,
    breakdown: {
      audienceFit: candidate.breakdown?.audience ?? 0,
      formatFit: candidate.breakdown?.format ?? 0,
      toneFit: candidate.breakdown?.tone ?? 0,
      promptSignals: candidate.breakdown?.promptSignals ?? 0,
      forbidPromptSignals: candidate.breakdown?.forbidPromptSignals ?? 0,
      defaultSlideCount: candidate.breakdown?.slideCount ?? 0
    }
  };
}

function formatTemplateSelectionTraceCandidate(candidate: TemplateSelectionCandidate): string {
  const trace = traceTemplateSelectionCandidate(candidate);
  const breakdown = trace.breakdown;
  return `${trace.id}:${trace.deterministicScore}{audienceFit=${formatTraceScore(breakdown.audienceFit)},formatFit=${formatTraceScore(breakdown.formatFit)},toneFit=${formatTraceScore(breakdown.toneFit)},promptSignals=${formatTraceScore(breakdown.promptSignals)},forbidPromptSignals=${formatTraceScore(breakdown.forbidPromptSignals)},defaultSlideCount=${formatTraceScore(breakdown.defaultSlideCount)}}`;
}

function formatTraceScore(value: number): string {
  return Number(value.toFixed(2)).toString();
}
