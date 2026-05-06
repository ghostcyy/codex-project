import type { SlideSlotFillIR } from "../../../ir";
import { renderSectionDivider } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "section-divider" }>;

export const sectionDividerLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "section-divider",
  roleFit: ["transition-divider", "context", "synthesis"],
  renderer: renderSectionDivider,
  sampleFill: {
    slideIndex: 1,
    kind: "section-divider",
    title: "New Section",
    kicker: "Part 02",
    marker: "02",
    progressText: "2 / 5",
    supportingText: "A low-density divider that resets rhythm before the next argument.",
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-section-divider",
    "section-divider-shell",
    "section-divider-rule",
    "section-divider-copy",
    "kicker",
    "section-marker",
    "h2",
    "section-title",
    "section-support",
    "section-progress",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
