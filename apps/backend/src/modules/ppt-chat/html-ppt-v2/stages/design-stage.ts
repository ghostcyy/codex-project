import { z } from "zod";
import { buildDesignPrompt } from "../prompts";
import {
  ANIMATION_IDS,
  FX_IDS,
  SLIDE_ROLE_IDS,
  designSystemIrSchema,
  type AnimationId,
  type DesignSystemIR,
  type DonorContractIR,
  type EvidencePack,
  type FxId,
  type IntentIR,
  type NarrativeIR,
  type SlideRoleId,
  type ThemeTokens
} from "../ir";
import type { DonorCatalogItem, SkillRegistry, TemplatePackage, ThemeCatalogItem } from "../registry";
import type { JsonOnlyModelClient } from "./json-model-client";
import { formatZodError, parseJsonLike } from "./json-utils";
import { rankTemplateCandidates } from "./template-select-stage";

const designChoiceSchema = z.object({
  themeId: z.string().trim().min(1),
  donorTemplateId: z.string().trim().min(1),
  accentPolicy: z.enum(["rotate", "static", "gradient-build"]).default("static"),
  animationBudget: z.object({
    allowedAnims: z.array(z.enum(ANIMATION_IDS)).min(1).max(12).default(["fade-up", "none"]),
    allowedFx: z.array(z.enum(FX_IDS)).max(12).default(["none"]),
    maxAccentSlides: z.number().int().min(0).max(20).default(2),
    fxAllowedRoles: z.array(z.enum(SLIDE_ROLE_IDS)).max(8).default(["cover", "cta"])
  }).strict().default({
    allowedAnims: ["fade-up", "none"],
    allowedFx: ["none"],
    maxAccentSlides: 2,
    fxAllowedRoles: ["cover", "cta"]
  }),
  audienceFitReasons: z.array(z.string().trim().min(1).max(220)).min(1).max(10)
});

type DesignChoice = z.infer<typeof designChoiceSchema>;

export type DesignStageInput = {
  intent: IntentIR;
  evidence: EvidencePack;
  narrative: NarrativeIR;
  registry: SkillRegistry;
  pinnedTemplate?: TemplatePackage;
  model?: JsonOnlyModelClient;
};

export type DesignStageResult = {
  design: DesignSystemIR;
  source: "model" | "fallback" | "pinned";
  attempts: number;
  validationErrors: string[];
};

export async function runDesignStage(input: DesignStageInput): Promise<DesignStageResult> {
  const validationErrors: string[] = [];

  if (input.pinnedTemplate) {
    const choice = buildPinnedDesignChoice(input.pinnedTemplate);
    return {
      design: lockDesignSystem(choice, input),
      source: "pinned",
      attempts: 0,
      validationErrors
    };
  }

  if (input.model) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildDesignPrompt({
        intent: input.intent,
        evidence: input.evidence,
        narrative: input.narrative,
        registry: input.registry,
        validationError: validationErrors.at(-1)
      });
      const raw = await input.model.completeJson({
        stage: "04-design",
        system: prompt.system,
        user: prompt.user,
        temperature: 0
      });
      const parsedChoice = designChoiceSchema.safeParse(parseJsonLike(raw));
      if (!parsedChoice.success) {
        validationErrors.push(formatZodError(parsedChoice.error));
        continue;
      }

      const choiceIssues = validateChoiceAgainstRegistry(parsedChoice.data, input.registry);
      if (choiceIssues.length) {
        validationErrors.push(choiceIssues.join("; "));
        continue;
      }

      const design = lockDesignSystem(parsedChoice.data, input);
      return {
        design,
        source: "model",
        attempts: attempt,
        validationErrors
      };
    }
  }

  const fallbackChoice = buildFallbackDesignChoice(input.intent, input.registry);
  return {
    design: lockDesignSystem(fallbackChoice, input),
    source: "fallback",
    attempts: input.model ? 2 : 0,
    validationErrors
  };
}

function buildPinnedDesignChoice(template: TemplatePackage): DesignChoice {
  return {
    themeId: template.themeId,
    donorTemplateId: template.donorTemplateId,
    accentPolicy: "static",
    animationBudget: {
      allowedAnims: template.defaultAnimationBudget.allowedAnims,
      allowedFx: template.defaultAnimationBudget.allowedFx.length ? template.defaultAnimationBudget.allowedFx : ["none"],
      maxAccentSlides: template.defaultAnimationBudget.maxAccentSlides,
      fxAllowedRoles: ["cover", "transition-divider", "cta"]
    },
    audienceFitReasons: [
      `Pinned template '${template.id}' selected by user or template selector.`,
      `Template package locks donor='${template.donorTemplateId}' and theme='${template.themeId}'.`
    ]
  };
}

export function lockDesignSystem(choice: DesignChoice, input: Omit<DesignStageInput, "model">): DesignSystemIR {
  const theme = requireRegistryTheme(choice.themeId, input.registry);
  const donor = requireRegistryDonor(choice.donorTemplateId, input.registry);
  const roleSet = new Set(input.narrative.slides.map((slide) => slide.role));
  const allowedFx = normalizeAllowedFx(choice.animationBudget.allowedFx, roleSet);
  const candidate: DesignSystemIR = {
    themeId: theme.id,
    themeTokens: themeTokensFromCatalog(theme),
    donorTemplateId: donor.id,
    donorContract: donorContractFromCatalog(donor),
    deckClass: donor.deckClass,
    contrastReport: theme.wcag,
    animationBudget: {
      allowedAnims: normalizeAllowedAnims(choice.animationBudget.allowedAnims),
      allowedFx,
      maxAccentSlides: Math.min(choice.animationBudget.maxAccentSlides, Math.max(1, Math.ceil(input.intent.derivedSlideCount / 4))),
      fxAllowedRoles: choice.animationBudget.fxAllowedRoles.filter((role) => roleSet.has(role)).slice(0, 8)
    },
    accentPolicy: choice.accentPolicy,
    audienceFitReport: {
      score: scoreAudienceFit(input.intent, theme, donor),
      reasons: choice.audienceFitReasons.slice(0, 10)
    }
  };

  return designSystemIrSchema.parse(candidate);
}

function requireRegistryTheme(themeId: string, registry: SkillRegistry): ThemeCatalogItem {
  const theme = registry.themes.find((item) => item.id === themeId);
  if (!theme) {
    throw new Error(`Design stage cannot lock unknown themeId '${themeId}'.`);
  }
  return theme;
}

function requireRegistryDonor(donorTemplateId: string, registry: SkillRegistry): DonorCatalogItem {
  const donor = registry.donors.find((item) => item.id === donorTemplateId);
  if (!donor) {
    throw new Error(`Design stage cannot lock unknown donorTemplateId '${donorTemplateId}'.`);
  }
  return donor;
}

function validateChoiceAgainstRegistry(choice: DesignChoice, registry: SkillRegistry): string[] {
  const issues: string[] = [];
  if (!registry.themes.some((theme) => theme.id === choice.themeId)) {
    issues.push(`Unknown themeId '${choice.themeId}'. Use a registry theme ID.`);
  }
  if (!registry.donors.some((donor) => donor.id === choice.donorTemplateId)) {
    issues.push(`Unknown donorTemplateId '${choice.donorTemplateId}'. Use a registry donor ID.`);
  }
  return issues;
}

function buildFallbackDesignChoice(intent: IntentIR, registry: SkillRegistry): DesignChoice {
  const { template, reason } = chooseFallbackTemplatePackage(intent, registry);
  return {
    themeId: template.themeId,
    donorTemplateId: template.donorTemplateId,
    accentPolicy: "static",
    animationBudget: {
      allowedAnims: template.defaultAnimationBudget.allowedAnims,
      allowedFx: template.defaultAnimationBudget.allowedFx.length ? template.defaultAnimationBudget.allowedFx : ["none"],
      maxAccentSlides: template.defaultAnimationBudget.maxAccentSlides,
      fxAllowedRoles: ["cover", "transition-divider", "cta"]
    },
    audienceFitReasons: [
      `Residual design fallback selected Auto top-1 template '${template.id}'.`,
      reason
    ]
  };
}

function chooseFallbackTemplatePackage(intent: IntentIR, registry: SkillRegistry): { template: TemplatePackage; reason: string } {
  const ranked = rankTemplateCandidates({ intent, registry });
  const top = ranked[0];
  const template = registry.templatePackages.find((item) => item.id === top?.id) ?? registry.templatePackages[0];
  if (!template) {
    throw new Error("Design stage fallback requires at least one template package.");
  }
  return {
    template,
    reason: top?.reason ?? `Fallback to first registry template '${template.id}'.`
  };
}

function themeTokensFromCatalog(theme: ThemeCatalogItem): ThemeTokens {
  return {
    palette: {
      bg: theme.tokens.bg,
      surface: theme.tokens.surface,
      surface2: theme.tokens.surface2,
      accent: theme.tokens.accent,
      accent2: theme.tokens.accent2,
      accent3: theme.tokens.accent3,
      text1: theme.tokens.text1,
      text2: theme.tokens.text2,
      border: theme.tokens.border,
      good: "#16a34a",
      warn: "#d97706",
      bad: "#dc2626"
    },
    typography: {
      fontDisplay: inferDisplayFont(theme.id),
      fontBody: inferBodyFont(theme.id),
      fontMono: "IBM Plex Mono",
      scaleRatio: theme.tags.includes("editorial") ? 1.24 : 1.18,
      baseSize: theme.tags.includes("story") ? 19 : 18
    },
    geometry: {
      radiusSm: theme.tags.includes("technical") ? 8 : 12,
      radiusMd: theme.tags.includes("technical") ? 18 : 24,
      radiusLg: theme.tags.includes("technical") ? 32 : 40,
      gapSm: 12,
      gapMd: 24,
      gapLg: 40
    },
    elevation: {
      shadowSm: "0 4px 16px rgba(15, 23, 42, 0.08)",
      shadowMd: "0 14px 32px rgba(15, 23, 42, 0.12)",
      shadowLg: "0 24px 64px rgba(15, 23, 42, 0.16)"
    },
    motion: {
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      durationFast: 160,
      durationBase: 420,
      durationSlow: 900
    }
  };
}

function donorContractFromCatalog(donor: DonorCatalogItem): DonorContractIR {
  return {
    id: donor.id,
    decorativeClasses: unique([...donor.contract.decorativeOnlyClasses, ...donor.contract.cssRedactClasses]),
    coverOnlyClasses: unique(donor.contract.coverOnlyClasses),
    bodyAllowedClasses: unique(donor.contract.forbiddenClasses.length ? [] : donor.tags.map((tag) => `${tag}-body`)),
    dnaSignature: inferDnaSignature(donor),
    forbiddenTextPatterns: unique([...donor.contract.forbiddenTextPatterns, ...donor.contract.forbiddenTextExamples])
  };
}

function inferDnaSignature(donor: DonorCatalogItem): DonorContractIR["dnaSignature"] {
  if (donor.tags.includes("technical")) {
    return {
      titleTreatment: "precise technical heading with restrained accent",
      cardTreatment: "structured panels with thin borders and clear metadata",
      kickerTreatment: "small uppercase technical label",
      accentRule: "one controlled accent family per slide",
      density: "balanced"
    };
  }
  if (donor.tags.includes("social") || donor.tags.includes("editorial")) {
    return {
      titleTreatment: "editorial headline with warm emphasis",
      cardTreatment: "soft editorial cards with generous whitespace",
      kickerTreatment: "compact magazine-style eyebrow",
      accentRule: "warm accent used for hierarchy, not decoration spam",
      density: "airy"
    };
  }
  if (donor.tags.includes("business")) {
    return {
      titleTreatment: "business headline with strong claim-first wording",
      cardTreatment: "premium cards with measurable emphasis",
      kickerTreatment: "concise section label",
      accentRule: "accent supports metrics and decisions",
      density: "balanced"
    };
  }
  return {
    titleTreatment: "clean headline with stable visual hierarchy",
    cardTreatment: "consistent neutral cards",
    kickerTreatment: "simple section label",
    accentRule: "static accent throughout the deck",
    density: "balanced"
  };
}

function inferDisplayFont(themeId: string): string {
  if (themeId.includes("editorial") || themeId.includes("magazine")) return "Fraunces";
  if (themeId.includes("japanese")) return "Noto Serif SC";
  if (themeId.includes("terminal") || themeId.includes("graphify")) return "Space Grotesk";
  return "Sora";
}

function inferBodyFont(themeId: string): string {
  if (themeId.includes("editorial") || themeId.includes("magazine")) return "Source Serif 4";
  if (themeId.includes("japanese")) return "Noto Sans SC";
  return "Manrope";
}

function normalizeAllowedAnims(values: AnimationId[]): AnimationId[] {
  const allowed = values.filter((value) => (ANIMATION_IDS as readonly string[]).includes(value));
  return unique([...allowed, "none"]).slice(0, 12) as AnimationId[];
}

function normalizeAllowedFx(values: FxId[], roleSet: Set<SlideRoleId>): FxId[] {
  const fx = values.filter((value) => (FX_IDS as readonly string[]).includes(value));
  const shouldDisableFx = !["cover", "transition-divider", "cta"].some((role) => roleSet.has(role as SlideRoleId));
  return unique([...(shouldDisableFx ? [] : fx), "none"]).slice(0, 12) as FxId[];
}

function scoreAudienceFit(intent: IntentIR, theme: ThemeCatalogItem, donor: DonorCatalogItem): number {
  let score = 0.62;
  const joinedTags = new Set([...theme.tags, ...donor.tags]);
  if ((intent.audience === "engineers" || intent.audience === "researchers") && joinedTags.has("technical")) score += 0.18;
  if ((intent.audience === "investors" || intent.audience === "executives") && joinedTags.has("business")) score += 0.16;
  if ((intent.audience === "consumers" || intent.audience === "sales") && (joinedTags.has("consumer") || joinedTags.has("social"))) score += 0.16;
  if ((intent.format === "lecture" || intent.format === "tutorial") && (joinedTags.has("clean") || joinedTags.has("technical"))) score += 0.12;
  if (theme.wcag.minContrastRatio >= 7) score += 0.08;
  return Number(Math.min(1, score).toFixed(2));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
