import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { getGeneratedImage, type GeneratedImageMap, type PageFragment, type SlideContent } from "../shared";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
const PLACEHOLDER_IMAGE = "_placeholder.jpg";

export function resolveImages(args: {
  section: Element;
  fragment: PageFragment;
  content: SlideContent;
  templateDir: string;
  warnings: string[];
  generatedImages?: GeneratedImageMap;
}) {
  const selectors = args.fragment.imageSlotSelectors ?? [];
  if (selectors.length === 0) return;

  const imageFiles = listImageFiles(join(args.templateDir, "img"));
  for (const [index, selector] of selectors.entries()) {
    const matches = selectAll(selector, args.section as unknown as AnyNode) as Element[];
    if (matches.length !== 1) {
      args.warnings.push(
        `Slide ${args.content.slideIndex}: image selector '${selector}' matched ${matches.length} elements.`
      );
      continue;
    }
    const generated = getGeneratedImage(args.generatedImages, args.content.slideIndex, index);
    if (generated) {
      matches[0]!.attribs = { ...matches[0]!.attribs, src: generated.relativePath };
      if (generated.warning) args.warnings.push(generated.warning);
      continue;
    }
    const hint = args.content.imageHints?.[index] ?? "";
    const fileName = matchImageFile(hint, imageFiles);
    matches[0]!.attribs = { ...matches[0]!.attribs, src: `img/${fileName}` };
  }
}

function listImageFiles(imgDir: string) {
  if (!existsSync(imgDir)) return [PLACEHOLDER_IMAGE];
  const files = readdirSync(imgDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const dotIndex = name.lastIndexOf(".");
      return dotIndex >= 0 && IMAGE_EXTENSIONS.has(name.slice(dotIndex).toLowerCase());
    });
  return files.length ? files : [PLACEHOLDER_IMAGE];
}

function matchImageFile(hint: string, files: string[]) {
  const tokens = hint.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = files.map((fileName) => {
    const lowerFileName = fileName.toLowerCase();
    return {
      fileName,
      score: tokens.reduce((sum, token) => sum + (lowerFileName.includes(token) ? 1 : 0), 0)
    };
  });
  scored.sort((left, right) => right.score - left.score || left.fileName.localeCompare(right.fileName));
  return scored[0]?.score ? scored[0].fileName : PLACEHOLDER_IMAGE;
}
