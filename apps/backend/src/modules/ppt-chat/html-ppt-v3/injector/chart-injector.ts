import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import type { ChartDataIR, ChartSlot, PageFragment, PlannedSlide, SlideContent } from "../shared";
import { CHART_DEFAULTS } from "./chart-defaults";

export type ChartInit = {
  canvasId: string;
  script: string;
};

export function injectCharts(args: {
  section: Element;
  fragment: PageFragment;
  plannedSlide: PlannedSlide;
  content: SlideContent;
  warnings: string[];
}): ChartInit[] {
  const slots = chartSlotsForFragment(args.fragment);
  if (!slots.length) return [];

  const results: ChartInit[] = [];
  for (const slot of slots) {
    const matches = selectAll(slot.selector, args.section as unknown as AnyNode) as Element[];
    if (matches.length !== 1) {
      args.warnings.push(`Slide ${args.content.slideIndex}: chart canvas selector '${slot.selector}' matched ${matches.length} elements.`);
      continue;
    }
    const chartData = args.content.chartDataBySlot?.[slot.slotId] ?? (slot.slotId === "primary" ? args.content.chartData : undefined);
    if (!chartData) {
      args.warnings.push(`Slide ${args.content.slideIndex}: chart slot '${slot.slotId}' has no chartData.`);
      continue;
    }

    const canvasId = `chart-slide-${args.plannedSlide.slideIndex}-${sanitizeIdPart(slot.slotId)}`;
    matches[0]!.attribs = { ...matches[0]!.attribs, id: canvasId };
    results.push({
      canvasId,
      script: buildChartInitScript(canvasId, normalizeChartData(chartData, args.plannedSlide, slot))
    });
  }

  return results;
}

function chartSlotsForFragment(fragment: PageFragment): ChartSlot[] {
  if (fragment.chartSlots?.length) return fragment.chartSlots;
  if (fragment.pageType !== "chart" && !fragment.mediaKinds.includes("chart")) return [];
  return [{
    slotId: "primary",
    selector: fragment.chartCanvasSelector ?? "canvas[data-chart-slot='primary']",
    kind: "unknown",
    defaultRenderType: "line",
    componentId: "chart-1"
  }];
}

function normalizeChartData(chartData: ChartDataIR, plannedSlide: PlannedSlide, slot: ChartSlot) {
  const chartType = chartData.type ?? plannedSlide.chartType ?? slot.defaultRenderType;
  return {
    type: chartType === "gantt" ? "bar" : chartType,
    data: {
      labels: chartData.labels,
      datasets: chartData.datasets
    },
    options: CHART_DEFAULTS[chartType]
  };
}

function sanitizeIdPart(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "primary";
}

function buildChartInitScript(canvasId: string, config: unknown) {
  const configJson = JSON.stringify(config);
  return [
    "<script>",
    "document.addEventListener('DOMContentLoaded', () => {",
    `  const canvas = document.getElementById(${JSON.stringify(canvasId)});`,
    "  if (!canvas || typeof Chart === 'undefined') return;",
    `  new Chart(canvas, ${configJson});`,
    "});",
    "</script>"
  ].join("\n");
}
