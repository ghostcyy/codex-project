import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContentIR, GeneratedImageMap, PlanIR, TemplateManifestV2 } from "../shared";
import { injectCharts } from "./chart-injector";
import { stitchDeck, renderSlides } from "./deck-stitcher";
import { resolveImages } from "./image-resolver";
import { applyPostStitchClean } from "./post-stitch-cleaner";
import { fillSlots } from "./slot-filler";

export type Stage3InjectorInput = {
  manifest: TemplateManifestV2;
  plan: PlanIR;
  content: ContentIR;
  templateDir: string;
  workdir: string;
  jobId: string;
  generatedImages?: GeneratedImageMap;
};

export type Stage3InjectorResult = {
  workdir: string;
  indexHtmlPath: string;
  html: string;
  warnings: string[];
};

export function runStage3Injector(input: Stage3InjectorInput): Stage3InjectorResult {
  const warnings: string[] = [];
  prepareWorkdir(input.templateDir, input.workdir);
  copyGeneratedImages(input.generatedImages, input.workdir, warnings);

  const stitchedDeck = stitchDeck({
    manifest: input.manifest,
    plan: input.plan,
    templateDir: input.workdir
  });
  const contentByIndex = new Map(input.content.slides.map((slide) => [slide.slideIndex, slide]));
  const planByIndex = new Map(input.plan.slides.map((slide) => [slide.slideIndex, slide]));
  const chartScripts: string[] = [];

  for (const slide of stitchedDeck.slides) {
    const content = contentByIndex.get(slide.slideIndex);
    const plannedSlide = planByIndex.get(slide.slideIndex);
    if (!content || !plannedSlide) {
      warnings.push(`Slide ${slide.slideIndex}: missing plan or content.`);
      continue;
    }

    fillSlots({ section: slide.section, anchors: slide.fragment.anchors, content, plannedSlide, warnings });
    resolveImages({
      section: slide.section,
      fragment: slide.fragment,
      content,
      templateDir: input.workdir,
      warnings,
      generatedImages: input.generatedImages
    });
    const chartInits = injectCharts({ section: slide.section, fragment: slide.fragment, plannedSlide, content, warnings });
    chartScripts.push(...chartInits.map((chartInit) => chartInit.script));
  }

  applyPostStitchClean({ slides: stitchedDeck.slides, totalSlides: input.plan.slides.length, warnings });

  const html = buildIndexHtml(
    stitchedDeck.shellHtml,
    renderSlides(stitchedDeck.slides),
    chartScripts.join("\n"),
    input.plan.slides[0]?.slideTitle ?? input.manifest.label["zh-CN"]
  );
  const indexHtmlPath = join(input.workdir, "index.html");
  writeFileSync(indexHtmlPath, html, "utf8");

  return {
    workdir: input.workdir,
    indexHtmlPath,
    html,
    warnings
  };
}

function copyGeneratedImages(generatedImages: GeneratedImageMap | undefined, workdir: string, warnings: string[]) {
  if (!generatedImages) return;
  for (const asset of Object.values(generatedImages)) {
    if (!asset.absolutePath) continue;
    if (!existsSync(asset.absolutePath)) {
      warnings.push(`Slide ${asset.slideIndex}: generated image file is missing at ${asset.absolutePath}.`);
      continue;
    }
    const targetPath = join(workdir, asset.relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(asset.absolutePath, targetPath);
  }
}

function prepareWorkdir(templateDir: string, workdir: string) {
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  cpSync(templateDir, workdir, { recursive: true });
}

function buildIndexHtml(shellHtml: string, slidesHtml: string, chartInitsHtml: string, deckTitle: string) {
  if (!shellHtml.includes("<!-- SLIDES -->")) {
    throw new Error("Shell HTML must contain <!-- SLIDES -->.");
  }
  if (!shellHtml.includes("<!-- CHART_INITS -->")) {
    throw new Error("Shell HTML must contain <!-- CHART_INITS -->.");
  }
  return addOutputMarker(shellHtml
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(deckTitle)}</title>`)
    .replace("<!-- SLIDES -->", slidesHtml)
    .replace("<!-- CHART_INITS -->", chartInitsHtml));
}

function addOutputMarker(html: string) {
  if (/data-html-ppt-v3-output=/i.test(html)) return html;
  return html.replace(/<html\b([^>]*)>/i, `<html$1 data-html-ppt-v3-output="fragment-id">`);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
