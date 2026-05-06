import type { SlideSlotFillIR } from "../../../ir";
import { renderProcess } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "process" }>;

export const processLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "process",
  roleFit: ["process", "tutorial", "analysis"],
  renderer: renderProcess,
  sampleFill: {
    slideIndex: 1,
    kind: "process",
    title: "Deterministic Process",
    kicker: "Flow",
    lede: "A controlled step-by-step flow with numbered stages and connectors.",
    steps: [
      { label: "01", title: "Frame", description: "Define the operating problem.", accent: "neutral", citationKeys: [] },
      { label: "02", title: "Build", description: "Create the deterministic artifact.", accent: "primary", citationKeys: [] },
      { label: "03", title: "Verify", description: "Check output against closed contracts.", accent: "secondary", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-process",
    "content-shell",
    "process-shell",
    "kicker",
    "h2",
    "lede",
    "process-flow",
    "process-step",
    "process-step-number",
    "process-step-copy",
    "process-step-title",
    "process-step-body",
    "inline-citation-row",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
