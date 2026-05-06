import type { RenderableLayoutId } from "../../ir";
import type { LayoutRenderContext } from "./types";

export type DonorVocabularyScope =
  | "section"
  | "shell"
  | "copy"
  | "title"
  | "kicker"
  | "footer"
  | "card"
  | "panel"
  | "metric"
  | "quote"
  | "visual"
  | "cta";

type DonorDnaFamilies = {
  title: "technical" | "editorial" | "business" | "clean";
  card: "technical" | "editorial" | "business" | "clean";
  kicker: "technical" | "editorial" | "business" | "clean";
  accent: "controlled" | "warm" | "metrics" | "static";
};

export function donorVocabularyClasses(
  context: LayoutRenderContext | undefined,
  layoutId: RenderableLayoutId,
  scope: DonorVocabularyScope
): string[] {
  const donor = slugToken(context?.donorTemplateId, "generic");
  const density = slugToken(context?.donorDna?.density, "balanced");
  const families = resolveDonorDnaFamilies(context);
  const classes = [
    `donor-${scope}`,
    `donor-${layoutId}-${scope}`,
    `donor-${donor}-${scope}`,
    `donor-${donor}-${layoutId}-${scope}`,
    `donor-density-${density}`
  ];

  if (scope === "title") {
    classes.push(`dna-title-family-${families.title}`, `dna-accent-family-${families.accent}`);
  }
  if (scope === "card" || scope === "panel" || scope === "metric" || scope === "visual") {
    classes.push(`dna-card-family-${families.card}`, `dna-accent-family-${families.accent}`);
  }
  if (scope === "kicker") {
    classes.push(`dna-kicker-family-${families.kicker}`, `dna-accent-family-${families.accent}`);
  }
  if (scope === "section" || scope === "shell" || scope === "cta" || scope === "quote") {
    classes.push(`dna-density-family-${density}`);
  }

  return [...new Set(classes)];
}

export function donorVocabularyPrefix(context: LayoutRenderContext | undefined): string {
  return `donor-${slugToken(context?.donorTemplateId, "generic")}`;
}

export function resolveDonorDnaFamilies(context: LayoutRenderContext | undefined): DonorDnaFamilies {
  const titleTreatment = String(context?.donorDna?.titleTreatment ?? "").toLowerCase();
  const cardTreatment = String(context?.donorDna?.cardTreatment ?? "").toLowerCase();
  const kickerTreatment = String(context?.donorDna?.kickerTreatment ?? "").toLowerCase();
  const accentRule = String(context?.donorDna?.accentRule ?? "").toLowerCase();

  return {
    title: inferToneFamily(titleTreatment),
    card: inferToneFamily(cardTreatment),
    kicker: inferToneFamily(kickerTreatment),
    accent: inferAccentFamily(accentRule)
  };
}

function inferToneFamily(value: string): DonorDnaFamilies["title"] {
  if (value.includes("technical")) return "technical";
  if (value.includes("editorial") || value.includes("magazine") || value.includes("warm")) return "editorial";
  if (value.includes("business") || value.includes("premium") || value.includes("claim")) return "business";
  return "clean";
}

function inferAccentFamily(value: string): DonorDnaFamilies["accent"] {
  if (value.includes("warm")) return "warm";
  if (value.includes("metric") || value.includes("decision")) return "metrics";
  if (value.includes("controlled")) return "controlled";
  return "static";
}

function slugToken(value: string | undefined, fallback: string): string {
  const source = String(value ?? "").trim().toLowerCase();
  const slug = source.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || fallback;
}
