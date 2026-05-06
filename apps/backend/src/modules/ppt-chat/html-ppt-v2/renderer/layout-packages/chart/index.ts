import type { SlideSlotFillIR } from "../../../ir";
import { renderChart } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "chart" }>;

export const chartLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "chart",
  roleFit: ["data-highlight", "evidence", "analysis"],
  renderer: renderChart,
  sampleFill: {
    slideIndex: 1,
    kind: "chart",
    title: "Evidence chart",
    kicker: "Chart",
    chartType: "bar",
    dataAssetKey: "evidence-chart",
    insight: "Chart slides consume AssetIR chart data and render a deterministic SVG.",
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-chart",
    "content-shell",
    "chart-shell",
    "kicker",
    "chart-layout",
    "chart-copy",
    "h2",
    "lede",
    "chart-figure",
    "chart-svg",
    "chart-axis",
    "chart-bar",
    "chart-line",
    "chart-area",
    "chart-dot",
    "chart-value",
    "chart-label",
    "chart-slice",
    "chart-slice-1",
    "chart-slice-2",
    "chart-slice-3",
    "chart-slice-4",
    "chart-slice-5",
    "chart-slice-6",
    "chart-hole",
    "chart-radar",
    "chart-caption",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
