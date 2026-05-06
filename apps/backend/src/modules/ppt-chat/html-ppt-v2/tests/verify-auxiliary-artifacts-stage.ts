import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DeckRendererService, readZipEntryNames } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import { runAuxiliaryArtifactsStage, runRenderVerificationStage } from "../stages";
import { deckIrFixtures } from "./fixtures/deck-ir-fixtures";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const outputDir = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2", "auxiliary-artifacts-fixture");
  const runtimeRoot = resolve(workspaceRoot, ".local-runtime");
  if (!outputDir.startsWith(runtimeRoot)) {
    throw new Error(`Refusing to clean unexpected outputDir: ${outputDir}`);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const fixture = deckIrFixtures[0];
  if (!fixture) {
    throw new Error("Missing DeckIR fixture for auxiliary artifacts.");
  }
  const deck = JSON.parse(JSON.stringify(fixture)) as typeof fixture;
  deck.intent.language = "zh-CN";
  deck.intent.topic = "中国火锅文化";
  deck.narrative.slides[0]!.contentBrief.headline = "中国火锅文化";

  const renderer = new DeckRendererService();
  await renderer.renderToDirectory(deck, { outputDir, registryHash: registry.hash });
  await runRenderVerificationStage({ outputDir, deck, registryHash: registry.hash });

  const result = await runAuxiliaryArtifactsStage({ deck, outputDir });
  if (result.warnings.length) {
    throw new Error(`Auxiliary artifacts should not warn on a rendered fixture: ${result.warnings.join("; ")}`);
  }

  for (const artifactPath of Object.values(result.artifacts)) {
    if (!existsSync(join(outputDir, artifactPath))) {
      throw new Error(`Auxiliary artifact was not written: ${artifactPath}`);
    }
  }

  const notes = await readFile(join(outputDir, result.artifacts.speakerNotes), "utf8");
  if (!notes.includes("## Slide 1") || !notes.includes("citation keys")) {
    throw new Error("speaker-notes.md must include per-slide notes and citation guidance.");
  }

  if (!result.artifacts.agendaPdf.endsWith(".png")) {
    throw new Error("CJK agenda should be rendered as a PNG artifact instead of relying on non-embedded PDF CID fonts.");
  }
  const agendaPng = await readFile(join(outputDir, result.artifacts.agendaPdf));
  if (agendaPng.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("CJK agenda PNG must be a valid PNG file.");
  }

  const talkingPoints = JSON.parse(await readFile(join(outputDir, result.artifacts.talkingPoints), "utf8")) as {
    slides?: unknown[];
  };
  if (talkingPoints.slides?.length !== deck.intent.derivedSlideCount) {
    throw new Error("talking-points.json must contain exactly one entry per slide.");
  }

  const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8")) as {
    files?: { auxiliaryArtifacts?: Record<string, string> };
    auxiliaryArtifacts?: Record<string, string>;
  };
  if (!manifest.files?.auxiliaryArtifacts || !manifest.auxiliaryArtifacts) {
    throw new Error("manifest.json must include auxiliary artifact metadata.");
  }

  const zipEntries = new Set(readZipEntryNames(await readFile(join(outputDir, "html-ppt-deck.zip"))));
  for (const artifactPath of Object.values(result.artifacts)) {
    if (!zipEntries.has(artifactPath)) {
      throw new Error(`html-ppt-deck.zip must include auxiliary artifact: ${artifactPath}`);
    }
  }

  console.log(`HTML-PPT v2 auxiliary artifacts stage passed. outputDir=${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
