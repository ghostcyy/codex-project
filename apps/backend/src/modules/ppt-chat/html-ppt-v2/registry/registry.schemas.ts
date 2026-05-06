import { z } from "zod";
import {
  animationIdSchema,
  audienceSchema,
  densityBudgetSchema,
  donorIdSchema,
  formatSchema,
  fxIdSchema,
  layoutIdSchema,
  renderableLayoutIdSchema,
  slideRoleSchema,
  themeIdSchema,
  toneSchema
} from "../ir/enums";
import { wcagReportSchema } from "../ir/shared";

const strictIdSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/);
export const templateAspectRatioSchema = z.enum(["16:9", "3:4"]);
export const templateRendererProfileSchema = z.enum(["standard-wide", "social-portrait"]);

type DonorContractGuardInput = {
  forbiddenTextPatterns?: readonly string[];
  forbiddenTextExamples?: readonly string[];
  forbiddenClasses?: readonly string[];
  coverOnlyClasses?: readonly string[];
  decorativeOnlyClasses?: readonly string[];
  cssRedactClasses?: readonly string[];
  reviewedExemptions?: {
    textGuards?: string;
    classCssGuards?: string;
  };
};

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export type DonorContractGuardCounts = {
  forbiddenTextPatterns: number;
  forbiddenTextExamples: number;
  textGuards: number;
  forbiddenClasses: number;
  coverOnlyClasses: number;
  decorativeOnlyClasses: number;
  cssRedactClasses: number;
  classCssGuards: number;
  totalGuards: number;
  textGuardsExempted: boolean;
  classCssGuardsExempted: boolean;
};

export function countDonorContractGuards(contract: DonorContractGuardInput): DonorContractGuardCounts {
  const forbiddenTextPatterns = contract.forbiddenTextPatterns?.length ?? 0;
  const forbiddenTextExamples = contract.forbiddenTextExamples?.length ?? 0;
  const forbiddenClasses = contract.forbiddenClasses?.length ?? 0;
  const coverOnlyClasses = contract.coverOnlyClasses?.length ?? 0;
  const decorativeOnlyClasses = contract.decorativeOnlyClasses?.length ?? 0;
  const cssRedactClasses = contract.cssRedactClasses?.length ?? 0;
  const textGuards = forbiddenTextPatterns + forbiddenTextExamples;
  const classCssGuards = forbiddenClasses + coverOnlyClasses + decorativeOnlyClasses + cssRedactClasses;
  return {
    forbiddenTextPatterns,
    forbiddenTextExamples,
    textGuards,
    forbiddenClasses,
    coverOnlyClasses,
    decorativeOnlyClasses,
    cssRedactClasses,
    classCssGuards,
    totalGuards: textGuards + classCssGuards,
    textGuardsExempted: Boolean(contract.reviewedExemptions?.textGuards?.trim()),
    classCssGuardsExempted: Boolean(contract.reviewedExemptions?.classCssGuards?.trim())
  };
}

export const layoutSanitySchema = z.object({
  minCards: z.number().int().min(0).optional(),
  maxCards: z.number().int().min(0).optional(),
  minBullets: z.number().int().min(0).optional(),
  maxBullets: z.number().int().min(0).optional(),
  minMetrics: z.number().int().min(0).optional(),
  maxMetrics: z.number().int().min(0).optional(),
  wantsCardTitle: z.boolean().optional(),
  wantsCardBody: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  columns: z.number().int().min(1).max(6).optional(),
  requiresCanvas: z.boolean().optional(),
  notes: z.string().max(500).optional()
}).strict();

export const layoutAxisSchema = z.enum(["single", "horizontal", "vertical", "mixed"]);

export const layoutPrimitiveExpectationSchema = z.enum([
  "cover-hero",
  "agenda-list",
  "split-columns",
  "card-columns",
  "metric-grid",
  "timeline-rail",
  "comparison-panels",
  "grouped-bullets",
  "step-flow",
  "stat-callout",
  "section-break",
  "quote-block",
  "call-to-action",
  "chart-canvas",
  "visual-hero"
]);

export const layoutSlotTypeSchema = z.enum([
  "title",
  "kicker",
  "subtitle",
  "meta",
  "items",
  "body",
  "lede",
  "bullets",
  "cards",
  "metrics",
  "summary",
  "events",
  "comparison-sides",
  "verdict",
  "headline",
  "action",
  "chart",
  "quote",
  "attribution",
  "supporting-text",
  "marker",
  "progress-text",
  "value",
  "label",
  "explanation",
  "groups",
  "steps",
  "image",
  "chips",
  "footer",
  "citations"
]);

export const layoutSlotGroupContractSchema = z.object({
  id: strictIdSchema,
  type: layoutSlotTypeSchema,
  required: z.boolean(),
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional()
}).strict().superRefine((slotGroup, ctx) => {
  if (slotGroup.minItems !== undefined && slotGroup.maxItems !== undefined && slotGroup.minItems > slotGroup.maxItems) {
    ctx.addIssue({
      code: "custom",
      path: ["maxItems"],
      message: "slot group maxItems must be greater than or equal to minItems."
    });
  }
});

export const layoutDensityProfileSchema = z.object({
  preferred: densityBudgetSchema,
  supported: z.array(densityBudgetSchema).min(1).max(3),
  maxNarrativeChars: z.number().int().min(120).max(8000).optional()
}).strict().superRefine((density, ctx) => {
  if (!density.supported.includes(density.preferred)) {
    ctx.addIssue({
      code: "custom",
      path: ["preferred"],
      message: "density preferred value must be included in supported."
    });
  }
});

export const renderableLayoutContractSchema = z.object({
  id: renderableLayoutIdSchema,
  roleFit: z.array(slideRoleSchema).min(1),
  density: layoutDensityProfileSchema,
  axis: layoutAxisSchema,
  columns: z.number().int().min(1).max(6),
  capacity: layoutSanitySchema,
  requiredSlots: z.array(layoutSlotGroupContractSchema).min(1),
  optionalSlots: z.array(layoutSlotGroupContractSchema).default([]),
  primitives: z.array(layoutPrimitiveExpectationSchema).min(1).max(4),
  fallbackLayouts: z.array(renderableLayoutIdSchema).max(6),
  notes: z.string().trim().max(500).optional()
}).strict().superRefine((contract, ctx) => {
  if (new Set(contract.roleFit).size !== contract.roleFit.length) {
    ctx.addIssue({ code: "custom", path: ["roleFit"], message: "layout contract roleFit must not contain duplicate roles." });
  }
  if (new Set(contract.primitives).size !== contract.primitives.length) {
    ctx.addIssue({ code: "custom", path: ["primitives"], message: "layout contract primitives must not contain duplicates." });
  }
  if (contract.fallbackLayouts.includes(contract.id)) {
    ctx.addIssue({ code: "custom", path: ["fallbackLayouts"], message: "layout contract fallbackLayouts must not include the layout itself." });
  }
});

export const layoutCatalogItemSchema = z.object({
  id: layoutIdSchema,
  sourceId: strictIdSchema,
  file: z.string().min(1),
  roleFit: z.array(slideRoleSchema).min(1),
  capacity: layoutSanitySchema,
  contract: renderableLayoutContractSchema,
  slotKind: layoutIdSchema,
  htmlTemplate: z.string().min(1),
  tags: z.array(strictIdSchema).default([])
}).strict().superRefine((layout, ctx) => {
  if (layout.contract.id !== layout.id) {
    ctx.addIssue({
      code: "custom",
      path: ["contract", "id"],
      message: "layout contract id must match layout id."
    });
  }
  if (!sameStringSet(layout.roleFit, layout.contract.roleFit)) {
    ctx.addIssue({
      code: "custom",
      path: ["contract", "roleFit"],
      message: "layout contract roleFit must match layout roleFit."
    });
  }
  if (JSON.stringify(layout.capacity) !== JSON.stringify(layout.contract.capacity)) {
    ctx.addIssue({
      code: "custom",
      path: ["contract", "capacity"],
      message: "layout contract capacity must match normalized layout capacity."
    });
  }
});

export const themeCatalogItemSchema = z.object({
  id: themeIdSchema,
  sourceId: strictIdSchema,
  file: z.string().min(1),
  css: z.string().min(1),
  tokens: z.object({
    bg: z.string().min(1),
    surface: z.string().min(1),
    surface2: z.string().min(1),
    accent: z.string().min(1),
    accent2: z.string().min(1),
    accent3: z.string().min(1),
    text1: z.string().min(1),
    text2: z.string().min(1),
    border: z.string().min(1)
  }).strict(),
  wcag: wcagReportSchema,
  tags: z.array(strictIdSchema).default([])
}).strict();

export const donorContractSchema = z.object({
  forbiddenTextPatterns: z.array(z.string().min(1)).default([]),
  forbiddenTextExamples: z.array(z.string().min(1)).default([]),
  forbiddenClasses: z.array(strictIdSchema).default([]),
  coverOnlyClasses: z.array(strictIdSchema).default([]),
  decorativeOnlyClasses: z.array(strictIdSchema).default([]),
  cssRedactClasses: z.array(strictIdSchema).default([]),
  reviewedExemptions: z.object({
    textGuards: z.string().trim().min(12).max(300).optional(),
    classCssGuards: z.string().trim().min(12).max(300).optional()
  }).strict().default({})
}).strict().superRefine((contract, ctx) => {
  const counts = countDonorContractGuards(contract);

  if (counts.totalGuards === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Donor contract must define at least one forbidden text, forbidden class, cover-only class, decorative-only class, or CSS redaction guard."
    });
  }
  if (counts.textGuards === 0 && !counts.textGuardsExempted) {
    ctx.addIssue({
      code: "custom",
      path: ["forbiddenTextPatterns"],
      message: "Donor contract must define at least one text guard or reviewedExemptions.textGuards."
    });
  }
  if (counts.classCssGuards === 0 && !counts.classCssGuardsExempted) {
    ctx.addIssue({
      code: "custom",
      path: ["cssRedactClasses"],
      message: "Donor contract must define at least one class/CSS guard or reviewedExemptions.classCssGuards."
    });
  }
});

export const donorCatalogItemSchema = z.object({
  id: donorIdSchema,
  sourceId: strictIdSchema,
  dir: z.string().min(1),
  deckClass: z.string().regex(/^tpl-[a-z0-9-]+$/),
  contract: donorContractSchema,
  css: z.string().min(1),
  tags: z.array(strictIdSchema).default([])
}).strict();

export const templatePackageSchema = z.object({
  id: donorIdSchema,
  label: z.object({
    "zh-CN": z.string().trim().min(1).max(80),
    en: z.string().trim().min(1).max(80)
  }).strict(),
  description: z.object({
    "zh-CN": z.string().trim().min(1).max(260),
    en: z.string().trim().min(1).max(260)
  }).strict(),
  donorTemplateId: donorIdSchema,
  deckClass: z.string().regex(/^tpl-[a-z0-9-]+$/),
  aspectRatio: templateAspectRatioSchema,
  rendererProfile: templateRendererProfileSchema,
  themeId: themeIdSchema,
  themeAlternates: z.array(themeIdSchema).max(4).default([]),
  layoutPolicy: z.object({
    cover: renderableLayoutIdSchema,
    toc: renderableLayoutIdSchema,
    body: z.array(renderableLayoutIdSchema).min(2).max(8),
    closing: renderableLayoutIdSchema
  }).strict(),
  audienceFit: z.array(audienceSchema).min(1).max(5),
  formatFit: z.array(formatSchema).min(1).max(4),
  toneFit: z.array(toneSchema).min(1).max(4),
  defaultDensity: densityBudgetSchema,
  defaultSlideCount: z.number().int().min(5).max(20),
  defaultAnimationBudget: z.object({
    allowedAnims: z.array(animationIdSchema).min(1).max(8),
    allowedFx: z.array(fxIdSchema).max(4),
    maxAccentSlides: z.number().int().min(0).max(8)
  }).strict(),
  embeddingPrompt: z.string().trim().min(1).max(500),
  promptSignals: z.array(z.string().trim().min(1).max(80)).max(20),
  forbidPromptSignals: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  thumbnailFile: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_.-]+$/)
}).strict().superRefine((template, ctx) => {
  if (template.id !== template.donorTemplateId) {
    ctx.addIssue({
      code: "custom",
      path: ["donorTemplateId"],
      message: "template id must match donorTemplateId."
    });
  }
  if (template.rendererProfile === "social-portrait" && template.aspectRatio !== "3:4") {
    ctx.addIssue({
      code: "custom",
      path: ["aspectRatio"],
      message: "social-portrait renderer profile requires aspectRatio 3:4."
    });
  }
  if (template.rendererProfile === "standard-wide" && template.aspectRatio !== "16:9") {
    ctx.addIssue({
      code: "custom",
      path: ["aspectRatio"],
      message: "standard-wide renderer profile requires aspectRatio 16:9."
    });
  }
});

export const animationCatalogItemSchema = z.object({
  id: animationIdSchema,
  cssClass: z.string().min(1),
  kind: z.enum(["enter", "loop"]),
  perfClass: z.enum(["cheap", "medium", "heavy"])
}).strict();

export const fxCatalogItemSchema = z.object({
  id: fxIdSchema,
  file: z.string().min(1),
  perfClass: z.enum(["medium", "heavy"])
}).strict();

export const skillRegistrySchema = z.object({
  version: z.literal("html-ppt-v2-registry-v1"),
  skillRoot: z.string().min(1),
  hash: z.string().min(12),
  generatedAt: z.string().datetime({ offset: true }),
  layouts: z.array(layoutCatalogItemSchema).min(1),
  themes: z.array(themeCatalogItemSchema).min(1),
  donors: z.array(donorCatalogItemSchema).min(1),
  templatePackages: z.array(templatePackageSchema).min(1),
  animations: z.array(animationCatalogItemSchema),
  fx: z.array(fxCatalogItemSchema)
}).strict().superRefine((registry, ctx) => {
  for (const [name, items] of [
    ["layouts", registry.layouts],
    ["themes", registry.themes],
    ["donors", registry.donors],
    ["templatePackages", registry.templatePackages],
    ["animations", registry.animations],
    ["fx", registry.fx]
  ] as const) {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: [name], message: `${name} contains duplicate ids.` });
    }
  }

  for (const theme of registry.themes) {
    if (!theme.wcag.passed) {
      ctx.addIssue({ code: "custom", path: ["themes", theme.id], message: `Theme '${theme.id}' failed WCAG registry gate.` });
    }
  }

  const layoutById = new Map(registry.layouts.map((layout) => [layout.id, layout]));
  for (const layout of registry.layouts) {
    if (layout.contract.id !== layout.id) {
      ctx.addIssue({
        code: "custom",
        path: ["layouts", layout.id, "contract", "id"],
        message: `Layout '${layout.id}' contract id must match layout id.`
      });
    }
    if (!sameStringSet(layout.roleFit, layout.contract.roleFit)) {
      ctx.addIssue({
        code: "custom",
        path: ["layouts", layout.id, "contract", "roleFit"],
        message: `Layout '${layout.id}' contract roleFit must match layout roleFit.`
      });
    }
    if (JSON.stringify(layout.capacity) !== JSON.stringify(layout.contract.capacity)) {
      ctx.addIssue({
        code: "custom",
        path: ["layouts", layout.id, "contract", "capacity"],
        message: `Layout '${layout.id}' contract capacity must match layout capacity.`
      });
    }
    for (const fallbackLayout of layout.contract.fallbackLayouts) {
      if (!layoutById.has(fallbackLayout)) {
        ctx.addIssue({
          code: "custom",
          path: ["layouts", layout.id, "contract", "fallbackLayouts"],
          message: `Layout '${layout.id}' fallback '${fallbackLayout}' is not present in the hydrated registry.`
        });
      }
    }
  }

  for (const donor of registry.donors) {
    const guardCounts = countDonorContractGuards(donor.contract);
    if (guardCounts.totalGuards === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["donors", donor.id, "contract"],
        message: `Donor '${donor.id}' must define at least one contract guard.`
      });
    }
    if (guardCounts.textGuards === 0 && !guardCounts.textGuardsExempted) {
      ctx.addIssue({
        code: "custom",
        path: ["donors", donor.id, "contract", "forbiddenTextPatterns"],
        message: `Donor '${donor.id}' must define at least one text guard or reviewedExemptions.textGuards.`
      });
    }
    if (guardCounts.classCssGuards === 0 && !guardCounts.classCssGuardsExempted) {
      ctx.addIssue({
        code: "custom",
        path: ["donors", donor.id, "contract", "cssRedactClasses"],
        message: `Donor '${donor.id}' must define at least one class/CSS guard or reviewedExemptions.classCssGuards.`
      });
    }
  }

  const donorById = new Map(registry.donors.map((donor) => [donor.id, donor]));
  for (const template of registry.templatePackages) {
    const donor = donorById.get(template.donorTemplateId);
    if (!donor) {
      ctx.addIssue({
        code: "custom",
        path: ["templatePackages", template.id],
        message: `Template package '${template.id}' references missing donor '${template.donorTemplateId}'.`
      });
      continue;
    }
    if (template.deckClass !== donor.deckClass) {
      ctx.addIssue({
        code: "custom",
        path: ["templatePackages", template.id, "deckClass"],
        message: `Template package '${template.id}' deckClass '${template.deckClass}' does not match donor deckClass '${donor.deckClass}'.`
      });
    }
  }
});

export type LayoutSanity = z.infer<typeof layoutSanitySchema>;
export type LayoutAxis = z.infer<typeof layoutAxisSchema>;
export type LayoutPrimitiveExpectation = z.infer<typeof layoutPrimitiveExpectationSchema>;
export type LayoutSlotType = z.infer<typeof layoutSlotTypeSchema>;
export type LayoutSlotGroupContract = z.infer<typeof layoutSlotGroupContractSchema>;
export type LayoutDensityProfile = z.infer<typeof layoutDensityProfileSchema>;
export type RenderableLayoutContract = z.infer<typeof renderableLayoutContractSchema>;
export type LayoutCatalogItem = z.infer<typeof layoutCatalogItemSchema>;
export type ThemeCatalogItem = z.infer<typeof themeCatalogItemSchema>;
export type DonorContract = z.infer<typeof donorContractSchema>;
export type DonorCatalogItem = z.infer<typeof donorCatalogItemSchema>;
export type TemplatePackage = z.infer<typeof templatePackageSchema>;
export type TemplateAspectRatio = z.infer<typeof templateAspectRatioSchema>;
export type TemplateRendererProfile = z.infer<typeof templateRendererProfileSchema>;
export type AnimationCatalogItem = z.infer<typeof animationCatalogItemSchema>;
export type FxCatalogItem = z.infer<typeof fxCatalogItemSchema>;
export type SkillRegistry = z.infer<typeof skillRegistrySchema>;
