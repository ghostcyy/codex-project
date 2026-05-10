import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
    const targetRelativePath = stableGeneratedImagePath(args.content.slideIndex, index);
    materializeImageSlotFallback({
      workdir: args.templateDir,
      sourceFileName: fileName,
      targetRelativePath,
      slideIndex: args.content.slideIndex,
      slotIndex: index,
      warnings: args.warnings,
    });
    matches[0]!.attribs = { ...matches[0]!.attribs, src: targetRelativePath };
  }
}

function stableGeneratedImagePath(slideIndex: number, slotIndex: number) {
  const slidePart = String(slideIndex).padStart(2, "0");
  const slotPart = String(slotIndex + 1).padStart(2, "0");
  return `img/generated/slide-${slidePart}-slot-${slotPart}.png`;
}

function materializeImageSlotFallback(args: {
  workdir: string;
  sourceFileName: string;
  targetRelativePath: string;
  slideIndex: number;
  slotIndex: number;
  warnings: string[];
}) {
  const sourceRelativePath = `img/${args.sourceFileName}`;
  const sourcePath = join(args.workdir, sourceRelativePath);
  const targetPath = join(args.workdir, args.targetRelativePath);
  if (!existsSync(sourcePath)) {
    args.warnings.push(
      `Slide ${args.slideIndex} image ${args.slotIndex + 1}: fallback source ${sourceRelativePath} is missing; expected ${args.targetRelativePath}.`
    );
    return;
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath);
  args.warnings.push(
    `Slide ${args.slideIndex} image ${args.slotIndex + 1}: fallback copied from ${sourceRelativePath} to ${args.targetRelativePath}.`
  );
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
