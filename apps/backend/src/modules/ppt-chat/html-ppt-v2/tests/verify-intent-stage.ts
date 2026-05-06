import { runIntentStage, type JsonOnlyModelClient } from "../stages";

async function main() {
  const prompt = "制作一个12页的HTML PPT，主题为AI云服务器的应用和未来，约1500字，面向企业管理层，风格科技商务。";
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return { topic: "bad partial json" };
      }

      return JSON.stringify({
        topic: "AI云服务器的应用和未来",
        language: "zh-CN",
        audience: "executives",
        tone: "analytical",
        format: "analysis",
        hardConstraints: {
          slideCount: 10,
          narrativeChars: 1000,
          requiredSections: []
        },
        preferences: {
          aestheticHints: ["科技", "商务"],
          forbiddenThemes: [],
          domainTerminology: ["AI云服务器"],
          knowledgeCutoffWarning: true
        },
        derivedSlideCount: 10,
        derivedNarrativeChars: 1000
      });
    }
  };

  const result = await runIntentStage({ userPrompt: prompt, model });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Intent stage should retry once and accept the corrected model JSON.");
  }

  if (result.intent.derivedSlideCount !== 12 || result.intent.hardConstraints.slideCount !== 12) {
    throw new Error("Deterministic slide-count hints must override model drift.");
  }

  if (result.intent.derivedNarrativeChars < 1500 || result.intent.hardConstraints.narrativeChars !== 1500) {
    throw new Error("Deterministic narrative-char hints must override model drift.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Retry prompt must include the prior validation error.");
  }

  const fallback = await runIntentStage({ userPrompt: "做一个6页PPT，介绍力量举的前世今生，1000字，适合学生。" });
  if (fallback.source !== "fallback" || fallback.intent.derivedSlideCount !== 6 || fallback.intent.audience !== "students") {
    throw new Error("Intent stage deterministic fallback failed.");
  }

  const japanese = await runIntentStage({ userPrompt: "日本の半導体産業について8ページのPPTを作成してください。" });
  if (japanese.intent.language !== "ja") {
    throw new Error("Intent stage should detect Japanese kana as ja.");
  }

  const korean = await runIntentStage({ userPrompt: "한국 전기차 시장을 소개하는 7페이지 PPT를 만들어 주세요." });
  if (korean.intent.language !== "ko") {
    throw new Error("Intent stage should detect Hangul as ko.");
  }

  console.log("HTML-PPT v2 intent stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
