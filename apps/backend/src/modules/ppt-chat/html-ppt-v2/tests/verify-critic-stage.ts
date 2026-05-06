import { resolve } from "node:path";
import { HtmlPptV2AgentService } from "../orchestration";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import { CriticBlockedError, critiqueDeck, runCriticStage } from "../stages";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const agent = new HtmlPptV2AgentService();
  const agentResult = await agent.generateDeckIr({
    userPrompt: "制作一个6页HTML PPT，主题为力量举的前世今生，1000字，适合学生，要求包含历史、规则、冠军。",
    registry
  });

  if (agentResult.deck.meta.revisionRound < 1) {
    throw new Error("V2 agent should run Stage 9 critic loop and write revisionRound.");
  }
  if (!agentResult.deck.meta.checkpoints.some((checkpoint) => checkpoint.stage === "stage-9:critic")) {
    throw new Error("Stage 9 critic checkpoint missing from DeckIR meta.");
  }

  const broken = structuredClone(agentResult.deck);
  const firstSlot = broken.slots[0]!;
  firstSlot.citationKeys = [];
  for (const item of broken.choreography) {
    if (item.slideIndex <= 4) item.fx = "soft-glow";
  }

  const before = critiqueDeck(broken);
  if (!before.issues.some((issue) => issue.critic === "factual" && issue.slideIndex === firstSlot.slideIndex)) {
    throw new Error("Critic should detect missing slot citation keys.");
  }
  if (!before.issues.some((issue) => issue.critic === "visual" && issue.issue.startsWith("FX assigned"))) {
    throw new Error("Critic should detect animation budget overflow.");
  }
  broken.narrative.slides[1]!.contentBrief.headline = broken.narrative.slides[0]!.contentBrief.headline;
  const duplicateTitleReport = critiqueDeck(broken);
  if (!duplicateTitleReport.issues.some((issue) => issue.critic === "narrative" && issue.severity === "block" && issue.issue.includes("share the same headline"))) {
    throw new Error("Critic should block adjacent duplicate slide headlines.");
  }
  broken.narrative.slides[1]!.contentBrief.headline = agentResult.deck.narrative.slides[1]!.contentBrief.headline;

  const result = await runCriticStage({ deck: broken });
  const after = critiqueDeck(result.deck);
  if (after.issues.some((issue) => issue.critic === "visual" && issue.issue.startsWith("FX assigned"))) {
    throw new Error("Critic deterministic fixes should drop excess FX assignments.");
  }
  if (!result.reports.length || result.deck.meta.qualityScores.overall <= 0) {
    throw new Error("Critic stage should produce reports and quality scores.");
  }

  const blockBroken = structuredClone(agentResult.deck);
  blockBroken.slots[0]!.citationKeys = ["missing-citation-key"];
  let blocked = false;
  try {
    await runCriticStage({ deck: blockBroken });
  } catch (error) {
    if (!(error instanceof CriticBlockedError)) {
      throw error;
    }
    blocked = true;
    if (!error.issues.some((issue) => issue.severity === "block" && issue.critic === "factual")) {
      throw new Error("CriticBlockedError should include the factual block issue.");
    }
    if (!error.finalReport.issues.some((issue) => issue.severity === "block")) {
      throw new Error("CriticBlockedError should carry the final critic report.");
    }
  }
  if (!blocked) {
    throw new Error("Critic stage must block publication when unresolved block issues remain.");
  }

  console.log("HTML-PPT v2 critic stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
