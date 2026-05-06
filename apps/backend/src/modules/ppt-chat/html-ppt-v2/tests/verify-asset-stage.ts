import { resolve } from "node:path";
import {
  runAssetStage,
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  runSlotFillStage
} from "../stages";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import type { SlotFillIR } from "../ir";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const intent = (await runIntentStage({
    userPrompt: "制作一个8页HTML PPT，主题为企业AI知识库建设方法，约1200字，面向企业管理层。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const narrative = (await runNarrativeStage({ intent, evidence })).narrative;
  const design = (await runDesignStage({ intent, evidence, narrative, registry })).design;
  const layoutPlan = (await runLayoutPlanStage({ intent, narrative, design, registry })).layoutPlan;
  const slots = (await runSlotFillStage({ intent, evidence, narrative, design, layoutPlan })).slots;

  const deterministicResult = await runAssetStage({ slots, design, evidence });
  if (deterministicResult.source !== "deterministic") {
    throw new Error("Asset stage must remain deterministic.");
  }
  const unexpectedGeneratedAssets = Object.values(deterministicResult.assets).filter((asset) => asset.kind !== "chart");
  if (unexpectedGeneratedAssets.length) {
    throw new Error("Automatically generated deterministic assets should currently be limited to chart assets.");
  }

  const assetSlots: SlotFillIR = [
    ...slots,
    {
      slideIndex: 40,
      kind: "chart",
      title: "Evidence chart",
      chartType: "bar",
      dataAssetKey: "evidence-chart",
      insight: "Use sourced data points as chart inputs.",
      citationKeys: evidence.dataPoints.slice(0, 2).map((point) => point.citationKey)
    }
  ];

  const result = await runAssetStage({ slots: assetSlots, design, evidence });
  if (result.assets["evidence-chart"]?.kind !== "chart") {
    throw new Error("Asset stage must generate chart assets for chart slots.");
  }
  if (
    result.assets["evidence-chart"]?.kind === "chart" &&
    (!result.assets["evidence-chart"].chartConfig.labels.length || !result.assets["evidence-chart"].chartConfig.series.length)
  ) {
    throw new Error("Chart assets must include deterministic labels and series.");
  }

  console.log("HTML-PPT v2 asset stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
