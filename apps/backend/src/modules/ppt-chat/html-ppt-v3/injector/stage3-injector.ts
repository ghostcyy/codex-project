import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { selectAll } from "css-select";
import type { AnyNode, Element as DomElement } from "domhandler";
import { Element } from "domhandler";
import type { ContentIR, GeneratedImageMap, PlanIR, SpeakerNotesIR, TemplateManifestV2 } from "../shared";
import { injectCharts } from "./chart-injector";
import { stitchDeck, renderSlides } from "./deck-stitcher";
import { resolveImages } from "./image-resolver";
import { applyPostStitchClean } from "./post-stitch-cleaner";
import { fillSlots } from "./slot-filler";
import { attachChildren, parseStrongText } from "./strong-parser";

export type Stage3InjectorInput = {
  manifest: TemplateManifestV2;
  plan: PlanIR;
  content: ContentIR;
  templateDir: string;
  workdir: string;
  jobId: string;
  generatedImages?: GeneratedImageMap;
  speakerNotes?: SpeakerNotesIR;
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
    templateDir: input.templateDir
  });
  const contentByIndex = new Map(input.content.slides.map((slide) => [slide.slideIndex, slide]));
  const planByIndex = new Map(input.plan.slides.map((slide) => [slide.slideIndex, slide]));
  const speakerNotesByIndex = new Map((input.speakerNotes?.slides ?? []).map((slide) => [slide.slideIndex, slide]));
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
    injectSpeakerNotes(slide.section, speakerNotesByIndex.get(slide.slideIndex));
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

function injectSpeakerNotes(section: DomElement, speakerNotes?: SpeakerNotesIR["slides"][number]) {
  removeExistingSpeakerNotes(section);
  if (!speakerNotes?.notes.length) return;

  const aside = new Element("aside", {
    class: "notes",
    "data-html-ppt-v3-speaker-notes": "true"
  }, []);
  const paragraphs = speakerNotes.notes
    .map((note) => note.trim())
    .filter(Boolean)
    .map((note) => {
      const paragraph = new Element("p", {}, []);
      attachChildren(paragraph, parseStrongText(note));
      return paragraph;
    });
  attachChildren(aside, paragraphs);
  aside.parent = section;
  section.children.push(aside);
}

function removeExistingSpeakerNotes(section: DomElement) {
  const existingNotes = selectAll(".notes, aside.notes, .speaker-notes", section as unknown as AnyNode) as DomElement[];
  for (const note of existingNotes) {
    const parent = note.parent as DomElement | null;
    if (!parent?.children) continue;
    parent.children = parent.children.filter((child) => child !== note);
    note.parent = null;
  }
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
  copyRuntimeTemplateFiles(templateDir, workdir);
  ensureEditModeAsset(workdir);
}

const TEMPLATE_ENGINEERING_ENTRIES = new Set([
  "fragments",
  "index.html",
  "manifest.json",
  "manifest-v2.json",
  "shell.html"
]);

function copyRuntimeTemplateFiles(templateDir: string, workdir: string) {
  for (const entry of readdirSync(templateDir)) {
    if (TEMPLATE_ENGINEERING_ENTRIES.has(entry)) continue;
    const source = join(templateDir, entry);
    const target = join(workdir, entry);
    const stat = statSync(source);
    if (stat.isDirectory()) {
      cpSync(source, target, { recursive: true });
    } else if (stat.isFile()) {
      cpSync(source, target);
    }
  }
}

function ensureEditModeAsset(workdir: string) {
  const target = join(workdir, "assets", "edit-mode.js");
  if (existsSync(target)) return;

  const fallbackCandidates = [
    join(process.cwd(), ".agents", "skills", "html-ppt", "assets", "edit-mode.js"),
    join(process.cwd(), "..", "..", ".agents", "skills", "html-ppt", "assets", "edit-mode.js")
  ];
  const fallback = fallbackCandidates.find((candidate) => existsSync(candidate));
  if (!fallback) return;

  mkdirSync(dirname(target), { recursive: true });
  cpSync(fallback, target);
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
