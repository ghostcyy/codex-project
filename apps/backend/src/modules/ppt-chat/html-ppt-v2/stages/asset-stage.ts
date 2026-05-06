import {
  assetIrSchema,
  type AssetIR,
  type DesignSystemIR,
  type EvidencePack,
  type SlotFillIR
} from "../ir";

export type AssetStageInput = {
  slots: SlotFillIR;
  design: DesignSystemIR;
  evidence: EvidencePack;
};

export type AssetStageResult = {
  assets: AssetIR;
  source: "deterministic" | "llm-assisted";
  warnings: string[];
};

export async function runAssetStage(input: AssetStageInput): Promise<AssetStageResult> {
  const assets: AssetIR = {};
  const warnings: string[] = [];

  for (const slot of input.slots) {
    if (slot.kind === "chart") {
      assets[slot.dataAssetKey] = {
        kind: "chart",
        chartType: slot.chartType,
        chartConfig: buildChartConfig(slot.title, slot.chartType, input),
        sourceCitationKeys: slot.citationKeys.slice(0, 12)
      };
      continue;
    }
  }

  return {
    assets: assetIrSchema.parse(assets),
    source: "deterministic",
    warnings
  };
}

function buildChartConfig(title: string, chartType: "bar" | "line" | "area" | "pie" | "doughnut" | "radar", input: AssetStageInput) {
  const dataPoints = input.evidence.dataPoints.slice(0, 6);
  const labels = dataPoints.length ? dataPoints.map((point) => point.metric) : ["Signal 1", "Signal 2", "Signal 3"];
  const values = dataPoints.length ? dataPoints.map((point, index) => numericChartValue(point.value, index + 1)) : [1, 2, 3];
  const palette = input.design.themeTokens.palette;

  return {
    title,
    labels,
    series: [
      {
        label: title,
        data: values,
        color: chartType === "pie" || chartType === "doughnut" ? palette.accent2 : palette.accent
      }
    ],
    unit: dataPoints.find((point) => typeof point.value === "string" && /[%$¥元亿万]/.test(point.value)) ? "mixed" : undefined,
    summary: `Deterministic ${chartType} chart generated from ${labels.length} evidence data point${labels.length === 1 ? "" : "s"}.`
  };
}

function numericChartValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}
