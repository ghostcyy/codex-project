import { resolve } from "node:path";
import {
  runChoreographyStage,
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runLayoutPlanStage,
  runNarrativeStage,
  runSlotFillStage
} from "../stages";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";

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
  const result = await runChoreographyStage({ narrative, design, slots });

  if (result.source !== "deterministic" || result.choreography.length !== slots.length) {
    throw new Error("Choreography stage must produce one deterministic entry per slot.");
  }

  const allowedAnims = new Set(design.animationBudget.allowedAnims);
  const allowedFx = new Set(design.animationBudget.allowedFx);
  let fxCount = 0;
  for (const item of result.choreography) {
    if (item.entrance && !allowedAnims.has(item.entrance)) {
      throw new Error(`Choreography entrance exceeds animation budget: ${item.entrance}`);
    }
    for (const build of item.builds) {
      if (!allowedAnims.has(build.anim)) {
        throw new Error(`Choreography build exceeds animation budget: ${build.anim}`);
      }
    }
    if (item.fx && item.fx !== "none") {
      fxCount += 1;
      if (!allowedFx.has(item.fx)) {
        throw new Error(`Choreography FX exceeds animation budget: ${item.fx}`);
      }
    }
  }

  if (slots.some((slot) => slot.kind === "chart") && !result.choreography.some((item) => item.builds.some((build) => build.target === "chart-figure"))) {
    throw new Error("Choreography stage should assign a build animation to chart figures when chart slides are present.");
  }

  if (fxCount > design.animationBudget.maxAccentSlides) {
    throw new Error("Choreography stage exceeded maxAccentSlides.");
  }

  console.log("HTML-PPT v2 choreography stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
