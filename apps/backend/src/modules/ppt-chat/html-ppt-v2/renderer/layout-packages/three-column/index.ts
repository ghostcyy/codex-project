import type { SlideSlotFillIR } from "../../../ir";
import { renderThreeColumn } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "three-column" }>;

export const threeColumnLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "three-column",
  roleFit: ["context", "analysis", "synthesis"],
  renderer: renderThreeColumn,
  sampleFill: {
    slideIndex: 1,
    kind: "three-column",
    title: "Three parallel ideas",
    kicker: "Three column",
    cards: [
      { title: "Schema", body: "Validation keeps the input bounded.", accent: "primary", citationKeys: [] },
      { title: "Template", body: "Known classes keep the output stable.", accent: "secondary", citationKeys: [] },
      { title: "Runtime", body: "Navigation remains deterministic.", accent: "neutral", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-three-column", "content-shell", "kicker", "h2", "card-grid", "card-grid-3", "card", "card-title", "card-body", "inline-citation-row", "citation-row", "citation-key", "slide-footer"]
};
