import type { SlideSlotFillIR } from "../../../ir";
import { renderImageHero } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "image-hero" }>;

export const imageHeroLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "image-hero",
  roleFit: ["case-study", "hook", "showcase"],
  renderer: renderImageHero,
  sampleFill: {
    slideIndex: 1,
    kind: "image-hero",
    title: "Image Hero",
    kicker: "Visual",
    lede: "A deterministic visual area can use a safe asset or fallback placeholder.",
    visualLabel: "HERO",
    body: "The text side remains typed while the visual side stays controlled.",
    chips: ["asset-safe", "typed", "deterministic"],
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-image-hero",
    "image-hero-shell",
    "image-hero-visual",
    "image-hero-img",
    "image-hero-placeholder",
    "image-hero-orb",
    "image-hero-orb-primary",
    "image-hero-orb-secondary",
    "image-hero-label",
    "image-hero-copy",
    "kicker",
    "h2",
    "lede",
    "image-hero-body",
    "image-hero-chip-row",
    "image-hero-chip",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
