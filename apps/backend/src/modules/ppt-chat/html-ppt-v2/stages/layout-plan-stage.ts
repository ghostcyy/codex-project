import { z } from "zod";
import { buildLayoutPlanPrompt } from "../prompts";
import {
  RENDERABLE_LAYOUT_IDS,
  layoutPlanIrSchema,
  type DesignSystemIR,
  type IntentIR,
  type LayoutPlanIR,
  type LayoutPlanItemIR,
  type NarrativeIR,
  type NarrativeSlideIR,
  type RenderableLayoutId,
  type SlideRoleId
} from "../ir";
import type { SkillRegistry, TemplatePackage } from "../registry";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";

const layoutChoiceItemSchema = z.object({
  slideIndex: z.number().int().min(1).max(50),
  layoutId: z.string().trim().min(1),
  capacityCheck: z.object({
    passed: z.boolean().default(true),
    details: z.string().max(500).default("")
  }).default({ passed: true, details: "" }),
  variancePosition: z.number().int().min(0).max(50).default(0)
});

const layoutChoiceSchema = z.array(layoutChoiceItemSchema).min(1).max(50);

export type LayoutPlanStageInput = {
  intent: IntentIR;
  narrative: NarrativeIR;
  design: DesignSystemIR;
  registry: SkillRegistry;
  pinnedTemplate?: TemplatePackage;
  model?: JsonOnlyModelClient;
};

export type LayoutPlanStageResult = {
  layoutPlan: LayoutPlanIR;
  source: "model" | "fallback" | "pinned";
  attempts: number;
  validationErrors: string[];
};

export async function runLayoutPlanStage(input: LayoutPlanStageInput): Promise<LayoutPlanStageResult> {
  const validationErrors: string[] = [];
  const renderableLayoutIds = getRenderableLayoutIds(input.registry);

  if (input.pinnedTemplate) {
    const layoutPlan = layoutPlanIrSchema.parse(buildPinnedTemplateLayoutPlan(input, input.pinnedTemplate));
    return {
      layoutPlan,
      source: "pinned",
      attempts: 0,
      validationErrors
    };
  }

  if (input.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildLayoutPlanPrompt({
        intent: input.intent,
        narrative: input.narrative,
        design: input.design,
        registry: input.registry,
        renderableLayoutIds,
        validationError: validationErrors.at(-1)
      });
      const raw = await input.model.completeJson({
        stage: "05-layout-plan",
        system: prompt.system,
        user: prompt.user,
        temperature: 0
      });
      const parsedChoice = layoutChoiceSchema.safeParse(parseJsonLike(raw, { shape: "array" }));
      if (!parsedChoice.success) {
        validationErrors.push(formatZodError(parsedChoice.error));
        continue;
      }

      const choiceIssues = validateRawLayoutChoices(parsedChoice.data, input.narrative, renderableLayoutIds);
      if (choiceIssues.length) {
        validationErrors.push(choiceIssues.join("; "));
        continue;
      }

      const candidate = normalizeLayoutPlanCandidate(parsedChoice.data, input, renderableLayoutIds);
      const parsedPlan = layoutPlanIrSchema.safeParse(candidate);
      if (parsedPlan.success) {
        const stageIssues = validateLayoutPlanAgainstNarrative(parsedPlan.data, input.narrative);
        if (!stageIssues.length) {
          return {
            layoutPlan: parsedPlan.data,
            source: "model",
            attempts: attempt,
            validationErrors
          };
        }
        validationErrors.push(stageIssues.join("; "));
        continue;
      }

      validationErrors.push(formatZodError(parsedPlan.error));
    }
  }

  const fallback = layoutPlanIrSchema.parse(buildFallbackLayoutPlan(input, renderableLayoutIds));
  return {
    layoutPlan: fallback,
    source: "fallback",
    attempts: input.model ? 2 : 0,
    validationErrors
  };
}

function validateRawLayoutChoices(
  choices: z.infer<typeof layoutChoiceSchema>,
  narrative: NarrativeIR,
  renderableLayoutIds: RenderableLayoutId[]
): string[] {
  const issues: string[] = [];
  if (choices.length !== narrative.slides.length) {
    issues.push(`layout choice length must equal narrative slide count (${narrative.slides.length}), got ${choices.length}`);
  }

  const narrativeIndexes = new Set(narrative.slides.map((slide) => slide.index));
  const seen = new Set<number>();
  for (const choice of choices) {
    if (!narrativeIndexes.has(choice.slideIndex)) {
      issues.push(`layout choice references unknown slideIndex ${choice.slideIndex}`);
    }
    if (seen.has(choice.slideIndex)) {
      issues.push(`layout choice duplicates slideIndex ${choice.slideIndex}`);
    }
    seen.add(choice.slideIndex);
    if (!isRenderableLayoutId(choice.layoutId, renderableLayoutIds)) {
      issues.push(`layoutId '${choice.layoutId}' is not in the current v2 renderable layout contract`);
    }
  }

  return issues;
}

export function validateLayoutPlanAgainstNarrative(layoutPlan: LayoutPlanIR, narrative: NarrativeIR): string[] {
  const issues: string[] = [];
  if (layoutPlan.length !== narrative.slides.length) {
    issues.push(`layoutPlan length must equal narrative slide count (${narrative.slides.length}), got ${layoutPlan.length}`);
  }

  const narrativeIndexes = new Set(narrative.slides.map((slide) => slide.index));
  for (const item of layoutPlan) {
    if (!narrativeIndexes.has(item.slideIndex)) {
      issues.push(`layoutPlan references unknown slideIndex ${item.slideIndex}`);
    }
  }
  return issues;
}

function normalizeLayoutPlanCandidate(
  choices: z.infer<typeof layoutChoiceSchema>,
  input: LayoutPlanStageInput,
  renderableLayoutIds: RenderableLayoutId[]
): LayoutPlanIR {
  const bySlide = new Map(choices.map((choice) => [choice.slideIndex, choice]));
  return input.narrative.slides.map((slide, offset) => {
    const choice = bySlide.get(slide.index);
    const requestedLayout = isRenderableLayoutId(choice?.layoutId, renderableLayoutIds) ? choice.layoutId : undefined;
    const requestedCapacity = requestedLayout ? computeCapacityCheck(slide, requestedLayout, input.registry) : null;
    const layoutId = requestedLayout && isLayoutRoleCompatible(requestedLayout, slide.role, input.registry) && requestedCapacity?.passed
      ? requestedLayout
      : chooseFallbackLayoutForSlide(slide, input.registry, renderableLayoutIds);
    return buildLayoutPlanItem(slide, layoutId, input.registry, offset, { relaxCapacity: true });
  });
}

function buildFallbackLayoutPlan(input: LayoutPlanStageInput, renderableLayoutIds: RenderableLayoutId[]): LayoutPlanIR {
  return input.narrative.slides.map((slide, offset) => {
    const layoutId = chooseFallbackLayoutForSlide(slide, input.registry, renderableLayoutIds);
    return buildLayoutPlanItem(slide, layoutId, input.registry, offset, { relaxCapacity: true });
  });
}

function buildPinnedTemplateLayoutPlan(input: LayoutPlanStageInput, template: TemplatePackage): LayoutPlanIR {
  let bodyOrdinal = 0;
  return input.narrative.slides.map((slide, offset) => {
    const layoutId = pickPinnedLayoutForSlide(slide.role, template, bodyOrdinal);
    if (!["cover", "toc", "cta", "thanks"].includes(slide.role)) {
      bodyOrdinal += 1;
    }
    return buildLayoutPlanItem(slide, layoutId, input.registry, offset, { relaxCapacity: true });
  });
}

function pickPinnedLayoutForSlide(role: SlideRoleId, template: TemplatePackage, bodyOrdinal: number): RenderableLayoutId {
  if (role === "cover" || role === "hook") return template.layoutPolicy.cover;
  if (role === "toc") return template.layoutPolicy.toc;
  if (role === "cta" || role === "thanks") return template.layoutPolicy.closing;
  const bodyLayouts: RenderableLayoutId[] = template.layoutPolicy.body.length ? template.layoutPolicy.body : ["two-column"];
  return bodyLayouts[bodyOrdinal % bodyLayouts.length]!;
}

function buildLayoutPlanItem(
  slide: NarrativeSlideIR,
  layoutId: RenderableLayoutId,
  registry: SkillRegistry,
  variancePosition: number,
  options?: { relaxCapacity?: boolean }
): LayoutPlanItemIR {
  const rawCapacity = computeCapacityCheck(slide, layoutId, registry);
  const capacity = rawCapacity.passed || !options?.relaxCapacity
    ? rawCapacity
    : {
        passed: true,
        details: `Relaxed deterministic fallback: ${rawCapacity.details}. SlotFill and renderer will normalize content to fit.`
      };
  return {
    slideIndex: slide.index,
    layoutId,
    capacityCheck: capacity,
    variancePosition
  };
}

function computeCapacityCheck(slide: NarrativeSlideIR, layoutId: RenderableLayoutId, registry: SkillRegistry): LayoutPlanItemIR["capacityCheck"] {
  const layout = registry.layouts.find((item) => item.id === layoutId);
  const contract = layout?.contract;
  const issues: string[] = [];
  if (!layout) {
    issues.push(`layout '${layoutId}' is not present in registry`);
  }

  if (layout && !isLayoutRoleCompatible(layoutId, slide.role, registry)) {
    issues.push(`layout '${layoutId}' roleFit does not include slide role '${slide.role}'`);
  }

  const pointCount = slide.contentBrief.supportingPoints.length;
  const metricCount = slide.contentBrief.keyMetrics?.length ?? 0;
  const capacity = contract?.capacity ?? layout?.capacity;
  if (capacity?.maxBullets !== undefined && pointCount > capacity.maxBullets) {
    issues.push(`supporting point count ${pointCount} exceeds maxBullets ${capacity.maxBullets}`);
  }
  if (capacity?.maxMetrics !== undefined && metricCount > capacity.maxMetrics) {
    issues.push(`metric count ${metricCount} exceeds maxMetrics ${capacity.maxMetrics}`);
  }

  const density = contract?.density;
  if (density?.maxNarrativeChars !== undefined && slide.estimatedNarrativeChars > density.maxNarrativeChars) {
    issues.push(`layout '${layoutId}' density '${density.preferred}' cannot carry ${slide.estimatedNarrativeChars} estimated chars above max ${density.maxNarrativeChars}`);
  }

  return {
    passed: issues.length === 0,
    details: issues.length
      ? issues.join("; ")
      : `Layout '${layoutId}' fits role '${slide.role}', ${pointCount} supporting points, ${metricCount} key metrics.`
  };
}

function chooseFallbackLayoutForSlide(slide: NarrativeSlideIR, registry: SkillRegistry, renderableLayoutIds: RenderableLayoutId[]): RenderableLayoutId {
  const preferred = preferredLayoutsForRole(slide.role, slide);
  for (const layoutId of preferred) {
    if (renderableLayoutIds.includes(layoutId) && isLayoutRoleCompatible(layoutId, slide.role, registry)) {
      const capacity = computeCapacityCheck(slide, layoutId, registry);
      if (capacity.passed) return layoutId;
    }
  }

  const contractFallbacks = getContractFallbackLayouts(preferred, registry);
  for (const layoutId of contractFallbacks) {
    if (renderableLayoutIds.includes(layoutId) && isLayoutRoleCompatible(layoutId, slide.role, registry)) {
      const capacity = computeCapacityCheck(slide, layoutId, registry);
      if (capacity.passed) return layoutId;
    }
  }

  for (const layoutId of renderableLayoutIds) {
    if (isLayoutRoleCompatible(layoutId, slide.role, registry)) {
      const capacity = computeCapacityCheck(slide, layoutId, registry);
      if (capacity.passed) return layoutId;
    }
  }

  return "two-column";
}

function getContractFallbackLayouts(layoutIds: RenderableLayoutId[], registry: SkillRegistry): RenderableLayoutId[] {
  const fallbacks: RenderableLayoutId[] = [];
  const seen = new Set<RenderableLayoutId>();
  for (const layoutId of layoutIds) {
    const layout = registry.layouts.find((item) => item.id === layoutId);
    for (const fallbackLayout of layout?.contract.fallbackLayouts ?? []) {
      if (!seen.has(fallbackLayout)) {
        seen.add(fallbackLayout);
        fallbacks.push(fallbackLayout);
      }
    }
  }
  return fallbacks;
}

function preferredLayoutsForRole(role: SlideRoleId, slide: NarrativeSlideIR): RenderableLayoutId[] {
  const pointCount = slide.contentBrief.supportingPoints.length;
  const metricCount = slide.contentBrief.keyMetrics?.length ?? 0;
  const hasFewMetrics = metricCount > 0 && metricCount <= 2;
  const hasManyLowComplexityBullets = pointCount >= 5 && metricCount === 0;
  const hasProcessFlow = hasProcessFlowCue(slide);
  const hasVisualHero = hasVisualHeroCue(slide);

  if (role === "cover") return ["cover"];
  if (role === "toc") return ["toc"];
  if (role === "cta" || role === "thanks") return ["cta"];
  if (role === "transition-divider") return ["section-divider", "quote", "two-column"];
  if (role === "hook" && hasVisualHero) return ["image-hero", "quote", "cover", "two-column", "three-column"];
  if (role === "hook") return ["quote", "image-hero", "cover", "two-column", "three-column"];
  if (role === "comparison") return ["comparison", "two-column"];
  if (role === "process") return ["process", "timeline", "three-column", "two-column"];
  if (role === "case-study" && hasProcessFlow) return ["process", "timeline", "quote", "three-column", "two-column"];
  if (role === "case-study" && hasVisualHero) return ["image-hero", "quote", "timeline", "three-column", "two-column"];
  if (role === "case-study" && slide.densityBudget === "sparse") return ["quote", "timeline", "three-column", "two-column"];
  if (role === "case-study") return ["timeline", "quote", "three-column", "two-column"];
  if (role === "data-highlight" && hasFewMetrics) return ["stat-highlight", "chart", "kpi-grid", "three-column", "two-column"];
  if (role === "data-highlight") return ["chart", "kpi-grid", "stat-highlight", "three-column", "two-column"];
  if (role === "evidence" && hasFewMetrics) return ["stat-highlight", "chart", "kpi-grid", "three-column", "two-column"];
  if (role === "evidence" && metricCount) return ["chart", "kpi-grid", "stat-highlight", "three-column", "two-column"];
  if (metricCount) return ["chart", "kpi-grid", "three-column", "two-column"];
  if ((role === "context" || role === "evidence" || role === "analysis") && hasManyLowComplexityBullets) {
    return ["bullet-list", "three-column", "two-column", "comparison"];
  }
  if (role === "evidence" || role === "analysis" || slide.densityBudget === "dense") return ["three-column", "two-column", "comparison"];
  if (role === "context" && hasVisualHero) return ["image-hero", "quote", "two-column", "three-column"];
  if (role === "context" && slide.densityBudget === "sparse") return ["quote", "two-column", "three-column"];
  if (role === "context") return ["two-column", "quote", "three-column"];
  if (role === "synthesis") return ["quote", "comparison", "two-column", "three-column"];
  return ["two-column", "three-column"];
}

function hasProcessFlowCue(slide: NarrativeSlideIR): boolean {
  const text = searchableSlideText(slide);
  return /\b(step|steps|phase|phases|stage|stages|sequence|flow|workflow|process|path|roadmap|rollout|journey|timeline|playbook)\b/i.test(text)
    || /步骤|流程|阶段|路径|落地|路线图|推进|实施/.test(text);
}

function hasVisualHeroCue(slide: NarrativeSlideIR): boolean {
  const text = searchableSlideText(slide);
  return /\b(image|visual|hero|photo|picture|illustration|scene|screenshot|mockup|diagram|map|showcase|generated image|visualize|visualise)\b/i.test(text)
    || /图片|视觉|主视觉|插图|场景|截图|示意图|生成图|形象化/.test(text);
}

function searchableSlideText(slide: NarrativeSlideIR): string {
  return [
    slide.beat,
    slide.contentBrief.headline,
    slide.contentBrief.subhead ?? "",
    ...slide.contentBrief.supportingPoints
  ].join(" ");
}

function isLayoutRoleCompatible(layoutId: RenderableLayoutId, role: SlideRoleId, registry: SkillRegistry): boolean {
  const layout = registry.layouts.find((item) => item.id === layoutId);
  if (!layout) return false;
  if (layout.contract.roleFit.includes(role)) return true;

  const aliases: Partial<Record<SlideRoleId, RenderableLayoutId[]>> = {
    hook: ["cover", "image-hero", "quote", "two-column"],
    evidence: ["bullet-list", "stat-highlight", "chart", "kpi-grid", "three-column", "two-column"],
    analysis: ["bullet-list", "two-column", "three-column", "comparison"],
    context: ["image-hero", "quote", "bullet-list", "two-column", "three-column"],
    synthesis: ["quote", "two-column", "three-column", "comparison"],
    "case-study": ["process", "timeline", "image-hero", "quote", "three-column", "two-column"],
    process: ["process", "timeline", "three-column"],
    "data-highlight": ["stat-highlight", "chart", "kpi-grid", "three-column"],
    "transition-divider": ["section-divider", "quote"],
    comparison: ["comparison", "two-column"],
    thanks: ["cta"]
  };

  return aliases[role]?.includes(layoutId) ?? false;
}

function getRenderableLayoutIds(registry: SkillRegistry): RenderableLayoutId[] {
  const registryLayoutIds = new Set(registry.layouts.map((layout) => layout.contract.id));
  return RENDERABLE_LAYOUT_IDS.filter((layoutId) => registryLayoutIds.has(layoutId));
}

function isRenderableLayoutId(value: unknown, renderableLayoutIds: RenderableLayoutId[]): value is RenderableLayoutId {
  return typeof value === "string" && renderableLayoutIds.includes(value as RenderableLayoutId);
}
