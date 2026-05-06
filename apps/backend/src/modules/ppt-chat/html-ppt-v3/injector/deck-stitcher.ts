import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { render } from "dom-serializer";
import type { AnyNode, Element } from "domhandler";
import type { PageFragment, PlanIR, TemplateManifestV2 } from "../shared";
import { HtmlPptV3StaleTemplateError } from "../shared";
import { getNavRuntimeScript } from "./nav-runtime";

export type StitchedSlide = {
  slideIndex: number;
  fragment: PageFragment;
  section: Element;
};

export type StitchedDeck = {
  shellHtml: string;
  slides: StitchedSlide[];
};

export function stitchDeck(args: {
  manifest: TemplateManifestV2;
  plan: PlanIR;
  templateDir: string;
}): StitchedDeck {
  const shellHtml = ensureDeckEffects(
    readFileSync(join(args.templateDir, args.manifest.shellHtmlFile), "utf8"),
    args.manifest,
    args.templateDir
  );
  const slides = args.plan.slides.map((plannedSlide) => {
    const fragment = getFragmentForPlannedSlide(args.manifest, plannedSlide);
    const fragmentPath = join(args.templateDir, fragment.htmlFile);
    if (!existsSync(fragmentPath)) {
      throw new HtmlPptV3StaleTemplateError(`Missing fragment '${fragment.htmlFile}' for fragmentId '${fragment.fragmentId ?? plannedSlide.fragmentId ?? plannedSlide.pageType}'.`);
    }
    const fragmentHtml = readFileSync(fragmentPath, "utf8");
    const fragmentDom = parseDocument(fragmentHtml, { decodeEntities: false });
    const sections = selectAll("section.slide", fragmentDom as unknown as AnyNode) as Element[];
    if (sections.length !== 1) {
      throw new Error(`Fragment '${fragment.htmlFile}' must contain exactly one section.slide; found ${sections.length}.`);
    }
    const section = sections[0]!;
    section.attribs = {
      ...section.attribs,
      "data-page-type": plannedSlide.pageType,
      ...(plannedSlide.fragmentId ? { "data-fragment-id": plannedSlide.fragmentId } : {}),
      "data-slide-index": String(plannedSlide.slideIndex)
    };
    return { slideIndex: plannedSlide.slideIndex, fragment, section };
  });

  return { shellHtml: injectNavRuntime(shellHtml), slides };
}

export function renderSlides(slides: StitchedSlide[]) {
  return slides.map((slide) => render(slide.section as unknown as AnyNode, { decodeEntities: false })).join("\n");
}

function getFragmentForPlannedSlide(manifest: TemplateManifestV2, plannedSlide: PlanIR["slides"][number]): PageFragment {
  if (plannedSlide.pageType === "cover") return manifest.fixed.cover;
  if (plannedSlide.pageType === "closing") return manifest.fixed.closing;
  if (!plannedSlide.fragmentId) throw new Error(`Middle planned slide ${plannedSlide.slideIndex} must include fragmentId.`);
  const key = plannedSlide.fragmentId;
  const fragment = manifest.pool[key];
  if (!fragment) throw new Error(`No manifest fragment found for fragmentId '${key}'.`);
  return fragment;
}

function injectNavRuntime(shellHtml: string): string {
  if (shellHtml.includes("data-html-ppt-v3-nav-runtime")) return shellHtml;
  const runtimeScript = getNavRuntimeScript();
  if (shellHtml.includes("<!-- CHART_INITS -->")) {
    return shellHtml.replace("<!-- CHART_INITS -->", `<!-- CHART_INITS -->\n${runtimeScript}`);
  }
  return shellHtml.replace("</body>", `${runtimeScript}\n</body>`);
}

function ensureDeckEffects(shellHtml: string, manifest: TemplateManifestV2, templateDir: string) {
  const deckEffects = manifest.deckEffects;
  if (!deckEffects) return shellHtml;

  let next = shellHtml;
  const missingElementIds = deckEffects.elementIds.filter((elementId) =>
    !next.includes(`id="${elementId}"`) && !next.includes(`id='${elementId}'`)
  );

  if (missingElementIds.length) {
    if (!deckEffects.htmlFile) {
      throw new HtmlPptV3StaleTemplateError(`Template deckEffects HTML is missing for element(s): ${missingElementIds.join(", ")}.`);
    }
    const effectPath = join(templateDir, deckEffects.htmlFile);
    if (!existsSync(effectPath)) {
      throw new HtmlPptV3StaleTemplateError(`Missing deckEffects htmlFile '${deckEffects.htmlFile}'.`);
    }
    const effectHtml = readFileSync(effectPath, "utf8").trim();
    for (const elementId of missingElementIds) {
      if (!effectHtml.includes(`id="${elementId}"`) && !effectHtml.includes(`id='${elementId}'`)) {
        throw new HtmlPptV3StaleTemplateError(`deckEffects htmlFile '${deckEffects.htmlFile}' does not contain '${elementId}'.`);
      }
    }
    next = next.includes("<!-- SLIDES -->")
      ? next.replace("<!-- SLIDES -->", `${effectHtml}\n    <!-- SLIDES -->`)
      : next.replace(/<main\b([^>]*)>/i, `<main$1>\n    ${effectHtml}`);
  }

  if (deckEffects.jsFile && !next.includes(deckEffects.jsFile)) {
    const jsPath = join(templateDir, deckEffects.jsFile);
    if (!existsSync(jsPath)) {
      throw new HtmlPptV3StaleTemplateError(`Missing deckEffects jsFile '${deckEffects.jsFile}'.`);
    }
    const scriptTag = `<script src="${deckEffects.jsFile}" data-html-ppt-v3-deck-effects></script>`;
    next = next.includes("</body>")
      ? next.replace("</body>", `${scriptTag}\n</body>`)
      : `${next}\n${scriptTag}`;
  }

  return next;
}
