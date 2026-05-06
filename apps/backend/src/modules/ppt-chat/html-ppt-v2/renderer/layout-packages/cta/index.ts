import type { SlideSlotFillIR } from "../../../ir";
import { renderCta } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "cta" }>;

export const ctaLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "cta",
  roleFit: ["cta", "thanks"],
  renderer: renderCta,
  sampleFill: {
    slideIndex: 1,
    kind: "cta",
    title: "Keep the renderer deterministic",
    kicker: "Next step",
    headline: "Keep the renderer deterministic",
    action: "Only add model stages that produce typed JSON.",
    supportingText: "Every later stage must preserve the same render contract.",
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-cta", "cta-shell", "kicker", "h2", "lede", "cta-action", "citation-row", "citation-key", "slide-footer"]
};
