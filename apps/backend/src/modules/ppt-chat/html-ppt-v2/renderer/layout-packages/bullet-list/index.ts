import type { SlideSlotFillIR } from "../../../ir";
import { renderBulletList } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "bullet-list" }>;

export const bulletListLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "bullet-list",
  roleFit: ["analysis", "context", "evidence"],
  renderer: renderBulletList,
  sampleFill: {
    slideIndex: 1,
    kind: "bullet-list",
    title: "Structured Bullets",
    kicker: "Checklist",
    lede: "Compact list cards group related ideas without inventing free-form HTML.",
    groups: [
      { title: "Principle", items: ["Use typed fields", "Keep bullets concise"], accent: "primary", citationKeys: [] },
      { title: "Practice", items: ["Group by decision", "Prefer scannable labels"], accent: "secondary", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-bullet-list",
    "content-shell",
    "bullet-list-shell",
    "kicker",
    "h2",
    "lede",
    "bullet-group-grid",
    "bullet-group",
    "bullet-group-title",
    "bullet-items",
    "bullet-item",
    "inline-citation-row",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
