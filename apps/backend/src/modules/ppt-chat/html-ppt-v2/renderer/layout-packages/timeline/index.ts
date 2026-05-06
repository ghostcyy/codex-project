import type { SlideSlotFillIR } from "../../../ir";
import { renderTimeline } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "timeline" }>;

export const timelineLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "timeline",
  roleFit: ["process", "case-study"],
  renderer: renderTimeline,
  sampleFill: {
    slideIndex: 1,
    kind: "timeline",
    title: "Render sequence",
    kicker: "Timeline",
    events: [
      { label: "Validate", description: "Parse DeckIR before rendering.", accent: "neutral", citationKeys: [] },
      { label: "Render", description: "Create deterministic slide sections.", accent: "primary", citationKeys: [] },
      { label: "Compose", description: "Build shell, CSS, runtime, and manifest.", accent: "secondary", citationKeys: [] },
      { label: "Verify", description: "Check output files and invariants.", accent: "primary", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-timeline", "content-shell", "kicker", "h2", "timeline", "timeline-event", "timeline-dot", "timeline-date", "timeline-title", "timeline-body", "inline-citation-row", "citation-row", "citation-key", "slide-footer"]
};
