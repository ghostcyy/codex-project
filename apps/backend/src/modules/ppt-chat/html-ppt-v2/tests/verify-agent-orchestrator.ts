import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HtmlPptV2AgentService } from "../orchestration";
import { DeckRendererService } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const outputDir = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "agent-fixture");
  const runtimeRoot = resolve(workspaceRoot, ".local-runtime");
  if (!outputDir.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputDir: ${outputDir}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const agent = new HtmlPptV2AgentService();
  const result = await agent.generateDeckIr({
    userPrompt: "制作一个6页HTML PPT，主题为力量举的前世今生，1000字，适合学生，要求包含历史、规则、冠军。",
    registry
  });

  if (result.deck.intent.derivedSlideCount !== 6 || result.deck.narrative.slides.length !== 6) {
    throw new Error("V2 agent orchestrator must preserve exact slide count.");
  }
  if (result.deck.narrative.totalEstimatedChars < result.deck.intent.derivedNarrativeChars) {
    throw new Error("V2 agent orchestrator must preserve narrative length constraints.");
  }
  if (result.deck.slots.length !== result.deck.layoutPlan.length || result.deck.choreography.length !== result.deck.slots.length) {
    throw new Error("V2 agent orchestrator produced inconsistent DeckIR arrays.");
  }

  const renderer = new DeckRendererService();
  await renderer.renderToDirectory(result.deck, { outputDir, registryHash: registry.hash });
  for (const file of ["index.html", "preview.html", "standalone.html", "style.css", "manifest.json", "html-ppt-deck.zip", join("assets", "runtime-v2.js")]) {
    if (!existsSync(join(outputDir, file))) {
      throw new Error(`V2 agent rendered deck is missing ${file}`);
    }
  }

  console.log(`HTML-PPT v2 agent orchestrator verification passed. outputDir=${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
