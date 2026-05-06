import type { SlideSlotFillIR } from "../../../ir";
import { renderTwoColumn } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "two-column" }>;

export const twoColumnLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "two-column",
  roleFit: ["context", "analysis", "synthesis"],
  renderer: renderTwoColumn,
  sampleFill: {
    slideIndex: 1,
    kind: "two-column",
    title: "Premise and implication",
    kicker: "Two column",
    leftTitle: "Premise",
    leftBody: "Typed slot data gives the renderer a bounded input contract.",
    rightTitle: "Implication",
    rightBody: "The renderer controls tags, classes, and layout behavior.",
    bullets: ["Typed JSON", "Known classes", "Stable shell"],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-two-column", "content-shell", "kicker", "h2", "two-column-grid", "card", "column-card", "card-title", "card-body", "pill-row", "pill", "citation-row", "citation-key", "slide-footer"]
};
