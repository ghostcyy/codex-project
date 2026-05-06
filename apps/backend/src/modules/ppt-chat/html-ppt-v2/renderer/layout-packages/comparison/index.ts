import type { SlideSlotFillIR } from "../../../ir";
import { renderComparison } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "comparison" }>;

export const comparisonLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "comparison",
  roleFit: ["comparison", "analysis"],
  renderer: renderComparison,
  sampleFill: {
    slideIndex: 1,
    kind: "comparison",
    title: "Legacy path versus v2 path",
    kicker: "Comparison",
    left: { title: "Legacy", body: "Raw HTML and CSS could drift or break.", accent: "bad", citationKeys: [] },
    right: { title: "V2", body: "Typed JSON feeds deterministic templates.", accent: "good", citationKeys: [] },
    verdict: "The renderer becomes a compiler target rather than a model-authored artifact.",
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-comparison", "content-shell", "kicker", "h2", "comparison-grid", "comparison-panel", "comparison-left", "comparison-right", "comparison-title", "comparison-body", "callout", "inline-citation-row", "citation-row", "citation-key", "slide-footer"]
};
