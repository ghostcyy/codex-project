import type { SlideSlotFillIR } from "../../../ir";
import { renderKpiGrid } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "kpi-grid" }>;

export const kpiGridLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "kpi-grid",
  roleFit: ["data-highlight", "evidence"],
  renderer: renderKpiGrid,
  sampleFill: {
    slideIndex: 1,
    kind: "kpi-grid",
    title: "Renderer health signals",
    kicker: "KPI grid",
    summary: "Metrics provide quick feedback on the render contract.",
    metrics: [
      { label: "Layouts", value: "8", note: "Core deterministic set", citationKeys: [] },
      { label: "Model HTML", value: "0", note: "Forbidden in v2", citationKeys: [] },
      { label: "Output files", value: "6", note: "Minimum deck bundle", citationKeys: [] }
    ],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-kpi-grid", "content-shell", "kicker", "h2", "lede", "kpi-grid", "metric-card", "metric-value", "metric-label", "metric-note", "inline-citation-row", "citation-row", "citation-key", "slide-footer"]
};
