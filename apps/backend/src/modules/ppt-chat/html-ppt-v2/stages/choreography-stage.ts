import {
  choreographyIrSchema,
  type AnimationId,
  type ChoreographyIR,
  type DesignSystemIR,
  type FxId,
  type NarrativeIR,
  type SlotFillIR
} from "../ir";

export type ChoreographyStageInput = {
  narrative: NarrativeIR;
  design: DesignSystemIR;
  slots: SlotFillIR;
};

export type ChoreographyStageResult = {
  choreography: ChoreographyIR;
  source: "deterministic" | "llm-assisted";
  warnings: string[];
};

export async function runChoreographyStage(input: ChoreographyStageInput): Promise<ChoreographyStageResult> {
  const warnings: string[] = [];
  const allowedAnims = new Set(input.design.animationBudget.allowedAnims);
  const allowedFx = new Set(input.design.animationBudget.allowedFx);
  const fxAllowedRoles = new Set(input.design.animationBudget.fxAllowedRoles);
  let fxUsed = 0;

  const choreography = input.slots.map((slot) => {
    const slide = input.narrative.slides.find((item) => item.index === slot.slideIndex);
    const role = slide?.role;
    const entrance = chooseEntrance(slot.kind, allowedAnims);
    const builds = buildAnimationsForSlot(slot, allowedAnims);
    const wantsFx = role ? fxAllowedRoles.has(role) : false;
    const fx = wantsFx && fxUsed < input.design.animationBudget.maxAccentSlides
      ? chooseFx(allowedFx)
      : "none";
    if (fx !== "none") {
      fxUsed += 1;
    }

    return {
      slideIndex: slot.slideIndex,
      entrance,
      builds,
      fx
    };
  });

  if (fxUsed < input.narrative.slides.filter((slide) => fxAllowedRoles.has(slide.role)).length && fxUsed >= input.design.animationBudget.maxAccentSlides) {
    warnings.push("FX assignment was capped by DesignSystemIR.animationBudget.maxAccentSlides.");
  }

  return {
    choreography: choreographyIrSchema.parse(choreography),
    source: "deterministic",
    warnings
  };
}

function chooseEntrance(kind: SlotFillIR[number]["kind"], allowedAnims: Set<AnimationId>): AnimationId | null {
  const preferred: AnimationId[] = kind === "cover" || kind === "cta"
    ? ["rise-in", "fade-up", "zoom-pop", "none"]
    : ["fade-up", "rise-in", "none"];
  return preferred.find((anim) => allowedAnims.has(anim)) ?? "none";
}

function chooseFx(allowedFx: Set<FxId>): FxId {
  for (const fx of ["soft-glow", "grid-lines", "spotlight", "particles-subtle"] as const) {
    if (allowedFx.has(fx)) return fx;
  }
  return "none";
}

function buildAnimationsForSlot(slot: SlotFillIR[number], allowedAnims: Set<AnimationId>) {
  const staggerAnim: AnimationId = allowedAnims.has("stagger-list") ? "stagger-list" : allowedAnims.has("fade-up") ? "fade-up" : "none";
  if (staggerAnim === "none") {
    return [];
  }

  switch (slot.kind) {
    case "toc":
      return [{ target: "toc-item", anim: staggerAnim, delay: 70 }];
    case "two-column":
    case "three-column":
      return [{ target: "card", anim: staggerAnim, delay: 90 }];
    case "kpi-grid":
      return [{ target: "metric-card", anim: staggerAnim, delay: 80 }];
    case "timeline":
      return [{ target: "timeline-event", anim: staggerAnim, delay: 90 }];
    case "comparison":
      return [{ target: "comparison-panel", anim: staggerAnim, delay: 90 }];
    case "chart":
      return [{ target: "chart-figure", anim: staggerAnim, delay: 80 }];
    default:
      return [];
  }
}
