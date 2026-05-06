import type { SlideSlotFillIR } from "../../../ir";
import { renderToc } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "toc" }>;

export const tocLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "toc",
  roleFit: ["toc"],
  renderer: renderToc,
  sampleFill: {
    slideIndex: 1,
    kind: "toc",
    title: "Agenda",
    kicker: "Map",
    items: [
      { label: "Context", description: "What the deck explains" },
      { label: "Evidence", description: "What supports the claim" },
      { label: "Action", description: "What to do next" }
    ],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-toc", "toc-shell", "kicker", "h2", "toc-list", "toc-item", "toc-number", "toc-copy", "toc-label", "toc-description", "citation-row", "citation-key", "slide-footer"]
};
