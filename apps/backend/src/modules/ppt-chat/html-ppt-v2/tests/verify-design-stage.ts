import { resolve } from "node:path";
import {
  runDesignStage,
  runEvidenceStage,
  runIntentStage,
  runNarrativeStage,
  type JsonOnlyModelClient
} from "../stages";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const intent = (await runIntentStage({
    userPrompt: "制作一个12页HTML PPT，主题为AI云服务器的应用和未来，约1500字，面向企业管理层，风格科技商务。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const narrative = (await runNarrativeStage({ intent, evidence })).narrative;
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return {
          themeId: "made-up-purple-theme",
          donorTemplateId: "tech-sharing",
          accentPolicy: "static",
          animationBudget: {
            allowedAnims: ["fade-up", "none"],
            allowedFx: ["soft-glow", "none"],
            maxAccentSlides: 2,
            fxAllowedRoles: ["cover", "cta"]
          },
          audienceFitReasons: ["Invalid first attempt should trigger retry."]
        };
      }

      return JSON.stringify({
        themeId: "engineering-whiteprint",
        donorTemplateId: "tech-sharing",
        accentPolicy: "static",
        animationBudget: {
          allowedAnims: ["fade-up", "stagger-list", "none"],
          allowedFx: ["grid-lines", "soft-glow", "none"],
          maxAccentSlides: 3,
          fxAllowedRoles: ["cover", "transition-divider", "cta"]
        },
        audienceFitReasons: [
          "Engineering whiteprint fits technical executive infrastructure topics.",
          "Tech sharing donor keeps visual DNA precise and restrained."
        ],
        themeTokens: {
          bg: "#000000"
        }
      });
    }
  };

  const result = await runDesignStage({ intent, evidence, narrative, registry, model });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Design stage should retry once and accept corrected registry choices.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Design retry prompt must include validation feedback.");
  }

  const registryTheme = registry.themes.find((theme) => theme.id === result.design.themeId);
  const registryDonor = registry.donors.find((donor) => donor.id === result.design.donorTemplateId);
  if (!registryTheme || !registryDonor) {
    throw new Error("Design stage emitted theme or donor outside registry.");
  }

  if (result.design.themeTokens.palette.bg !== registryTheme.tokens.bg) {
    throw new Error("Design stage must lock themeTokens from registry, not model output.");
  }

  if (result.design.deckClass !== registryDonor.deckClass || result.design.donorContract.id !== registryDonor.id) {
    throw new Error("Design stage must lock deckClass and donorContract from registry.");
  }

  if (!result.design.contrastReport.passed || result.design.animationBudget.allowedAnims.length < 1) {
    throw new Error("Design stage must lock a passing contrast report and non-empty animation budget.");
  }

  const fallback = await runDesignStage({ intent, evidence, narrative, registry });
  if (
    fallback.source !== "fallback" ||
    !registry.themes.some((theme) => theme.id === fallback.design.themeId) ||
    !registry.donors.some((donor) => donor.id === fallback.design.donorTemplateId)
  ) {
    throw new Error("Design stage fallback must choose registry-backed theme and donor.");
  }

  console.log("HTML-PPT v2 design stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
