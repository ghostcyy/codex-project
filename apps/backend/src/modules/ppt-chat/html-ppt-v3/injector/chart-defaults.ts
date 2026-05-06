import type { ChartType } from "../shared";

export type ChartDefaults = {
  responsive: boolean;
  maintainAspectRatio: boolean;
  indexAxis?: "x" | "y";
  plugins?: {
    legend?: {
      position?: "top" | "bottom" | "left" | "right";
    };
  };
};

export const CHART_DEFAULTS: Record<ChartType, ChartDefaults> = {
  line: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "bottom" } }
  },
  bar: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "top" } }
  },
  pie: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "right" } }
  },
  gantt: {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "bottom" } }
  }
};
