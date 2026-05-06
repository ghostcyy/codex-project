import { selectAll } from "css-select";
import type { AnyNode, Element, Text } from "domhandler";
import type { StitchedSlide } from "./deck-stitcher";
import { attachChildren } from "./strong-parser";

const RESIDUE_TEXT_PATTERN = /\b[A-Z][A-Z0-9_]{4,}\s*\/\/\s*\d{4}\b|\b(?:EDIT_ME|TPL_PLACEHOLDER)\b|\{\{[^}]+\}\}/;

export function applyPostStitchClean(args: {
  slides: StitchedSlide[];
  totalSlides: number;
  warnings: string[];
}) {
  for (const [ordinal, slide] of args.slides.entries()) {
    const actualIndex = ordinal + 1;
    slide.section.attribs = {
      ...slide.section.attribs,
      "data-slide-index": String(actualIndex),
      "data-slide-total": String(args.totalSlides)
    };
    rewriteSlideNumbers(slide.section, actualIndex, args.totalSlides);
    replaceResidueText(slide.section, actualIndex, slide.fragment.pageType, slide.fragment.anchors
      .map((anchor) => anchor.sourceText?.trim())
      .filter((value): value is string => Boolean(value)), args.warnings);
  }
}

function rewriteSlideNumbers(section: Element, slideIndex: number, totalSlides: number) {
  const nodes = selectAll(".slide-number, [data-current], [data-total]", section as unknown as AnyNode) as Element[];
  for (const node of nodes) {
    const isVisibleSlideNumber = node.attribs.class?.split(/\s+/).includes("slide-number") ?? false;
    const currentText = textOf(node).trim();
    if (isVisibleSlideNumber) {
      node.attribs = {
        ...node.attribs,
        "data-current": String(slideIndex),
        "data-total": String(totalSlides)
      };
      attachChildren(node, []);
      continue;
    }

    node.attribs = {
      ...node.attribs,
      "data-current": String(slideIndex),
      "data-total": String(totalSlides)
    };
    if (/^\d{1,3}\s*\/\s*\d{1,3}$/.test(currentText)) {
      attachChildren(node, []);
    }
  }
}

function replaceResidueText(section: Element, slideIndex: number, pageType: string, sourceTexts: string[], warnings: string[]) {
  for (const textNode of collectTextNodes(section)) {
    const value = textNode.data.trim();
    if (!value) continue;
    const leakedSource = sourceTexts.find((sourceText) => sourceText.length >= 3 && value.includes(sourceText));
    if (!leakedSource && !RESIDUE_TEXT_PATTERN.test(value)) continue;
    const fallback = labelForPageType(pageType);
    textNode.data = textNode.data.replace(value, fallback);
    warnings.push(`Slide ${slideIndex}: template residue '${leakedSource ?? value}' replaced with '${fallback}'.`);
  }
}

function collectTextNodes(node: AnyNode): Text[] {
  if (node.type === "text") return [node as Text];
  if (!("children" in node) || !node.children) return [];
  return node.children.flatMap((child) => collectTextNodes(child as AnyNode));
}

function textOf(node: AnyNode): string {
  if (node.type === "text") return (node as Text).data;
  if (!("children" in node) || !node.children) return "";
  return node.children.map((child) => textOf(child as AnyNode)).join("");
}

function labelForPageType(pageType: string) {
  if (pageType === "chart") return "数据洞察";
  if (pageType.startsWith("image")) return "视觉线索";
  if (pageType === "video") return "视频素材";
  if (pageType === "audio") return "音频素材";
  if (pageType === "cover") return "主题开场";
  if (pageType === "closing") return "行动总结";
  return "主题线索";
}
