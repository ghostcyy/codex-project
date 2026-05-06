import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import type { PlannedSlide, SlideContent, SlotAnchor } from "../shared";
import { attachChildren, parseStrongText } from "./strong-parser";

export function fillSlots(args: {
  section: Element;
  anchors: SlotAnchor[];
  content: SlideContent;
  plannedSlide?: PlannedSlide;
  warnings: string[];
}) {
  for (const anchor of args.anchors) {
    const rawValue = args.content.slotFills[anchor.slotId];
    const matches = selectAll(anchor.selector, args.section as unknown as AnyNode) as Element[];
    if (matches.length !== 1) {
      args.warnings.push(
        `Slide ${args.content.slideIndex}: selector '${anchor.selector}' for slot '${anchor.slotId}' matched ${matches.length} elements.`
      );
      continue;
    }

    if (rawValue === undefined || rawValue.trim() === "") {
      if (!anchor.optional) {
        args.warnings.push(`Slide ${args.content.slideIndex}: required slot '${anchor.slotId}' has no content.`);
      }
      const fallback = shouldUseFallback(anchor)
        ? buildSlotFallback(anchor, args.content, args.plannedSlide)
        : "";
      attachChildren(matches[0]!, fallback ? parseStrongText(enforceMaxChars(fallback, anchor, args.content.slideIndex, args.warnings)) : []);
      continue;
    }

    const normalizedValue = shouldUseFallback(anchor)
      ? normalizeDecorativeSlotValue(rawValue, anchor, args.content, args.plannedSlide)
      : rawValue;
    const value = enforceMaxChars(normalizedValue, anchor, args.content.slideIndex, args.warnings);
    attachChildren(matches[0]!, parseStrongText(value));
  }
}

function enforceMaxChars(value: string, anchor: SlotAnchor, slideIndex: number, warnings: string[]) {
  if (value.length <= anchor.maxChars) return value;
  warnings.push(`Slide ${slideIndex}: slot '${anchor.slotId}' exceeded maxChars ${anchor.maxChars}; truncated.`);
  return value.slice(0, anchor.maxChars);
}

function shouldUseFallback(anchor: SlotAnchor) {
  if (!anchor.optional) return true;
  return /(?:decorative|footer|meta|badge|label|section|eyebrow|kicker)/i.test(anchor.slotId);
}

function buildSlotFallback(anchor: SlotAnchor, content: SlideContent, plannedSlide?: PlannedSlide) {
  const title = plannedSlide?.slideTitle || `第${content.slideIndex}页`;
  const pageType = plannedSlide?.pageType || content.pageType;
  switch (anchor.kind) {
    case "title":
    case "subtitle":
      return title;
    case "kicker":
      return shortSlideLabel(plannedSlide, title, pageType, 14);
    case "cardHeading":
      return "关键策略";
    case "cardBody":
      return `${title} 围绕目标、路径和执行条件形成清晰判断。`;
    case "listItem":
      return `${title} 的关键行动项`;
    case "statNumber":
      return "3.6x";
    case "statLabel":
      return `${title} 指标`;
    case "tableCell":
      return `${title} 相关维度`;
    case "quote":
      return `${title} 的核心价值在于把复杂问题转化为可执行路径。`;
    case "caption":
      return `${title} 的视觉说明`;
    case "footer":
      return shortSlideLabel(plannedSlide, title, pageType, 18);
    case "badge":
      return `${cleanDecorativeLabel(title).slice(0, 8) || labelForPageType(pageType)}`;
    case "cta":
      return "开始行动";
    case "codeLine":
      return `status: ${labelForPageType(pageType)} ready`;
    case "mediaLabel":
      return `${labelForPageType(pageType)} 素材`;
  }
  if (/title/i.test(anchor.slotId)) return title;
  if (/(?:heading|kicker|eyebrow)/i.test(anchor.slotId)) return title;
  if (/(?:decorative|footer|meta|badge|label|section)/i.test(anchor.slotId)) {
    return `${shortSlideLabel(plannedSlide, title, pageType, 12)} · 要点`;
  }
  if (/caption/i.test(anchor.slotId)) return `${title} 的视觉说明`;
  return `${title} 的核心信息以简洁方式呈现，突出可执行判断。`;
}

function normalizeDecorativeSlotValue(value: string, anchor: SlotAnchor, content: SlideContent, plannedSlide?: PlannedSlide) {
  if (!/(?:decorative|footer|meta|badge|label|section)/i.test(anchor.slotId)) return value;
  const cleaned = cleanDecorativeLabel(value);
  if (cleaned) return cleaned;
  return buildSlotFallback(anchor, content, plannedSlide);
}

function cleanDecorativeLabel(value: string) {
  return value
    .replace(/\s*\/\/\s*\d{4}\b/g, "")
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .replace(/\s*\/\s*\d{1,3}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function shortSlideLabel(plannedSlide: PlannedSlide | undefined, title: string, pageType: string, limit: number) {
  const candidates = [
    plannedSlide?.topicPoints?.[0],
    title,
    labelForPageType(pageType)
  ];
  for (const candidate of candidates) {
    const cleaned = cleanDecorativeLabel(candidate ?? "");
    if (cleaned) return cleaned.slice(0, limit);
  }
  return "主题要点";
}

function labelForPageType(pageType: string) {
  if (pageType === "chart") return "数据洞察";
  if (pageType.startsWith("image")) return "视觉线索";
  if (pageType === "video") return "视频素材";
  if (pageType === "audio") return "音频素材";
  if (pageType === "cover") return "主题开场";
  if (pageType === "closing") return "行动总结";
  return "主题要点";
}
