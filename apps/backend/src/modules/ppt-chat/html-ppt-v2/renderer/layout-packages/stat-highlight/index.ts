import type { SlideSlotFillIR } from "../../../ir";
import { renderStatHighlight } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "stat-highlight" }>;

export const statHighlightLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "stat-highlight",
  roleFit: ["data-highlight", "evidence", "analysis"],
  renderer: renderStatHighlight,
  sampleFill: {
    slideIndex: 1,
    kind: "stat-highlight",
    title: "Key Number",
    kicker: "Metric",
    value: "3.2x",
    label: "signal lift",
    explanation: "The oversized metric anchors the slide while support cards explain why it matters.",
    cards: [
      { title: "Baseline", body: "Define what the number is measured against.", accent: "neutral", citationKeys: [] },
      { title: "Decision", body: "Tie the metric to a concrete audience choice.", accent: "primary", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-stat-highlight",
    "stat-highlight-shell",
    "stat-copy",
    "kicker",
    "h2",
    "stat-value",
    "stat-label",
    "stat-explanation",
    "stat-card-grid",
    "stat-card",
    "stat-card-title",
    "stat-card-body",
    "inline-citation-row",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
