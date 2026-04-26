import type { SkillAssetManifest } from "./skill-asset-indexer";
import type { HtmlPptRenderResult } from "../html-ppt-renderer/html-ppt-renderer.types";
import type { PptGenerationOrchestration, PptMessageDto } from "./ppt-chat.types";

export type AgentPlan = {
  title: string;
  subtitle?: string;
  slideCount: number;
  audience: string;
  tone?: string;
  format?: string;
  objective: string;
  slides: Array<{
    index: number;
    title: string;
    type: string;
    layoutId: string;
    goal: string;
    keyPoints: string[];
  }>;
};

export type ReferenceFullDeckSnippet = {
  name: string;
  /**
   * Up to 5 representative <section> blocks pulled from the chosen full-deck
   * template's index.html. The model uses these as visual-DNA donors when
   * authoring the deck's actual sections.
   */
  sections: string[];
  /**
   * Trimmed excerpt of the template's style.css so the section author can see
   * the template's class hooks, typography rhythm, and decoration cues.
   */
  cssExcerpt: string;
};

export type VisualPlan = {
  primaryTheme: string;
  backupThemes: string[];
  referenceTemplates: string[];
  deckClass: string;
  visualLanguage: string;
  slideVisuals: Array<{
    index: number;
    composition: string;
    animation?: string;
    fx?: string;
  }>;
};

export type SkillPack = {
  root: string;
  rules: string;
  layouts: string;
  fullDecks: string;
  templateNames: string[];
  layoutNames: string[];
  themeNames: string[];
  referenceSources: Array<{ name: string; index: string; css: string }>;
  manifest?: SkillAssetManifest;
};

export type ResearchPack = {
  topicSummary: string;
  keyFacts: string[];
  narrativeAngles: string[];
  suggestedSections: string[];
  needVerification: string[];
  suggestedSlideCount: number;
  perSlideLengthTargets: Array<{
    index: number;
    targetLength: number;
    purpose: string;
  }>;
};

export type DeckRequestRequirements = {
  requestedSlideCount?: number;
  requestedNarrativeLength?: number;
  narrativeLengthUnit?: "chars" | "words";
  narrativeLengthMode?: "minimum" | "target";
};

export type SkillAssetManifestLike = {
  themes?: Array<{
    id: string;
    mood?: string;
    tags?: string[];
    palette?: Partial<Record<"bg" | "surface" | "accent" | "text1" | "text2" | "border", string>>;
  }>;
  layouts?: Array<{
    id: string;
    role?: string;
    tags?: string[];
    densityBudget?: Record<string, number>;
    canvasRequired?: boolean;
  }>;
  fullDecks?: Array<{
    id: string;
    deckClass?: string;
    tags?: string[];
    themesReferenced?: string[];
    animationsUsed?: string[];
  }>;
};

export type HtmlPptAgentInput = {
  userId?: number;
  projectId?: string;
  assistantMessageId?: string;
  projectName: string;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  pendingUserMessage: PptMessageDto;
  templateId: string;
  theme: string;
};

export type HtmlPptAgentStage =
  | "01-read-skill"
  | "02-research"
  | "03-content-plan"
  | "04-visual-plan"
  | "05-generate-index"
  | "06-generate-style"
  | "07-publish"
  | "08-qa"
  | "completed";

export type HtmlPptAgentFailureRecord = {
  stage: HtmlPptAgentStage;
  stepName: string;
  reason: string;
  issues: string[];
  occurredAt: string;
};

export type HtmlPptAgentIndexResult = {
  html: string;
  batchCount: number;
  concurrency: number;
  repairCalls: number;
  localRepairCount: number;
  narrativeTargetChineseChars?: number;
  narrativeActualChineseChars?: number;
  narrativeExpandedChars?: number;
  narrativeExpandedSlides?: number[];
  stats: Array<{
    batchIndex: number;
    slideIndexes: number[];
    layoutIds: string[];
    densityBudget: number;
    modelRepairCalls: number;
    localRepairCount: number;
  }>;
};

export type HtmlPptAgentFailedSlideIssue = {
  slideIndex: number;
  batchOffset: number;
  issues: string[];
};

export type HtmlPptAgentBatchSnapshot = {
  batchIndex: number;
  slideIndexes: number[];
  layoutIds: string[];
  densityBudget: number;
  sections: string;
  qaIssues?: string[];
  slideIssues?: HtmlPptAgentFailedSlideIssue[];
};

export type HtmlPptAgentFailedIndexState = {
  batchSnapshots: HtmlPptAgentBatchSnapshot[];
  failedBatches?: HtmlPptAgentBatchSnapshot[];
  // Backward-compatible legacy field; new code writes failedBatches.
  failedBatch?: HtmlPptAgentBatchSnapshot;
};

export type HtmlPptAgentCheckpoint = {
  version: "html-ppt-agent-checkpoint-v1";
  sourceUserMessageId: string;
  projectName: string;
  templateId: string;
  theme: string;
  nextStage: HtmlPptAgentStage;
  pendingUserMessage: PptMessageDto;
  context: { summaryText: string; recentMessages: PptMessageDto[] };
  research?: ResearchPack;
  plan?: AgentPlan;
  visual?: VisualPlan;
  indexResult?: HtmlPptAgentIndexResult;
  failedIndexState?: HtmlPptAgentFailedIndexState;
  styleCss?: string;
  deckRender?: HtmlPptRenderResult;
  failureHistory?: HtmlPptAgentFailureRecord[];
  updatedAt: string;
};

export type HtmlPptAgentProgress = {
  content: string;
  orchestration: PptGenerationOrchestration;
  generationStatus: "running" | "completed" | "failed";
  checkpoint?: HtmlPptAgentCheckpoint;
};
