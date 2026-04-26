import type { AgentPlan } from "../html-ppt-agent.types";
import type { GeometryFinding, SlideCascade, SlideCascadeNode } from "./qa-types";

const VIEWPORT_WIDTH = 1280;

export function estimateGeometryIssues(cascades: SlideCascade[], _plan: AgentPlan): GeometryFinding[] {
  const findings: GeometryFinding[] = [];

  for (const slide of cascades) {
    const h1Nodes = findNodes(slide, (node) => isHeadingLevelOne(node));
    const h2Nodes = findNodes(slide, (node) => isHeadingLevelTwo(node));
    const ledeNodes = findNodes(slide, (node) => isLedeNode(node));
    const metricNodes = findNodes(slide, (node) => isMetricNode(node));
    const metricLabels = findNodes(slide, (node) => node.classList.includes("metric-label"));
    const textNodes = findNodes(slide, (node) => node.text.length > 0 && isTextLike(node));

    const h1 = pickLargest(h1Nodes);
    const h2 = pickLargest(h2Nodes);
    const lede = pickLargest(ledeNodes);
    const metric = pickLargest(metricNodes);
    const metricLabel = pickLargest(metricLabels);

    if (h1 && h2 && h2.computed.fontSize >= h1.computed.fontSize) {
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "hierarchy-violation",
        severity: "warn",
        message: `.h2 字号 ${h2.computed.fontSize}px 不应大于或等于 .h1 ${h1.computed.fontSize}px`,
        fixHint: "css-patch",
        nodeSelector: h2.path
      });
    }
    if (h1 && lede && lede.computed.fontSize >= h1.computed.fontSize) {
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "hierarchy-violation",
        severity: "warn",
        message: `.lede 字号 ${lede.computed.fontSize}px 不应大于或等于 .h1 ${h1.computed.fontSize}px`,
        fixHint: "css-patch",
        nodeSelector: lede.path
      });
    }
    if (metric && metricLabel && metricLabel.computed.fontSize >= metric.computed.fontSize) {
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "hierarchy-violation",
        severity: "warn",
        message: `.metric-label 字号 ${metricLabel.computed.fontSize}px 不应大于或等于指标数字 ${metric.computed.fontSize}px`,
        fixHint: "css-patch",
        nodeSelector: metricLabel.path
      });
    }

    for (const node of [...h1Nodes, ...h2Nodes, ...ledeNodes, ...metricNodes]) {
      const overflow = estimateNodeOverflow(slide, node);
      if (!overflow) continue;
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "overflow-estimate",
        severity: overflow.ratio > 1.3 ? "block" : "warn",
        message: `${overflow.label} 估算行数 ${overflow.estimatedLines.toFixed(1)}，超过建议 ${overflow.allowedLines.toFixed(1)}，可能出现裁切或遮挡`,
        fixHint: overflow.ratio > 1.3 ? "section-rewrite" : "css-patch",
        nodeSelector: node.path
      });
    }

    const competingPrimaryCount = textNodes.filter((node) => (node.computed.fontWeight ?? 0) >= 800 && node.computed.fontSize >= 64).length;
    if (competingPrimaryCount >= 3) {
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "competing-primary",
        severity: "warn",
        message: `当前页有 ${competingPrimaryCount} 个字号 >= 64px 且字重 >= 800 的主标题级元素，视觉主次可能冲突`,
        fixHint: "css-patch"
      });
    }

    const distinctColors = Array.from(new Set(textNodes.map((node) => node.computed.color).filter(Boolean)));
    if (distinctColors.length > 5) {
      findings.push({
        slideIndex: slide.slideIndex,
        layoutId: slide.layoutId,
        kind: "accent-overuse",
        severity: "warn",
        message: `当前页检测到 ${distinctColors.length} 种文本颜色，超过建议上限 5，视觉会显得不统一`,
        fixHint: "css-patch"
      });
    }
  }

  return findings;
}

function findNodes(slide: SlideCascade, matcher: (node: SlideCascadeNode) => boolean) {
  return slide.nodes.filter(matcher);
}

function pickLargest(nodes: SlideCascadeNode[]) {
  return nodes.slice().sort((left, right) => right.computed.fontSize - left.computed.fontSize)[0];
}

function isTextLike(node: SlideCascadeNode) {
  return ["h1", "h2", "h3", "p", "li", "span", "strong", "small", "div"].includes(node.tagName);
}

function estimateNodeOverflow(slide: SlideCascade, node: SlideCascadeNode) {
  if (!node.text) return null;
  const label = inferNodeLabel(node);
  const widthFraction = inferWidthFraction(slide, node);
  const availableWidth = Math.max(180, widthFraction * VIEWPORT_WIDTH - node.computed.paddingLeft - node.computed.paddingRight - 48);
  const charUnits = estimateTextUnits(node.text);
  const charsPerLine = Math.max(3, availableWidth / Math.max(12, node.computed.fontSize) / averageCharWidth(node.text));
  const estimatedLines = charUnits / charsPerLine;
  const allowedLines = allowedLineCount(node);
  const ratio = estimatedLines / Math.max(1, allowedLines);
  if (ratio <= 1.05) return null;
  return { label, estimatedLines, allowedLines, ratio };
}

function allowedLineCount(node: SlideCascadeNode) {
  if (isMetricNode(node)) return 1.1;
  if (isHeadingLevelOne(node)) return node.computed.fontSize >= 60 ? 2 : 2.6;
  if (isHeadingLevelTwo(node) || node.classList.includes("h3")) return 2.8;
  if (isLedeNode(node)) return 4;
  return 3;
}

function inferNodeLabel(node: SlideCascadeNode) {
  if (isHeadingLevelOne(node)) return node.classList.includes("xw-title") ? ".xw-title" : ".h1";
  if (isHeadingLevelTwo(node)) return node.classList.includes("xw-title-md") ? ".xw-title-md" : ".h2";
  if (isLedeNode(node)) return node.classList.includes("xw-sub") ? ".xw-sub" : ".lede";
  if (isMetricNode(node)) return ".metric-large";
  return node.path;
}

function isHeadingLevelOne(node: SlideCascadeNode) {
  return node.tagName === "h1" || node.classList.includes("h1") || node.classList.includes("xw-title");
}

function isHeadingLevelTwo(node: SlideCascadeNode) {
  return node.tagName === "h2" || node.classList.includes("h2") || node.classList.includes("xw-title-md");
}

function isLedeNode(node: SlideCascadeNode) {
  return node.classList.includes("lede") || node.classList.includes("xw-sub");
}

function isMetricNode(node: SlideCascadeNode) {
  return node.classList.includes("metric-large")
    || node.classList.includes("metric-number")
    || (node.classList.includes("number") && node.path.includes(".metric"));
}

function estimateTextUnits(text: string) {
  return Array.from(text).reduce((sum, char) => {
    if (/\s/.test(char)) return sum + 0.25;
    if (/[\u3400-\u9fff]/.test(char)) return sum + 1;
    if (/[A-Z]/.test(char)) return sum + 0.72;
    if (/[a-z0-9]/.test(char)) return sum + 0.56;
    return sum + 0.5;
  }, 0);
}

function averageCharWidth(text: string) {
  const hasCjk = /[\u3400-\u9fff]/.test(text);
  return hasCjk ? 1 : 0.55;
}

function inferWidthFraction(slide: SlideCascade, node: SlideCascadeNode) {
  let fraction = 1;
  const nodeMap = new Map(slide.nodes.map((entry) => [entry.id, entry]));
  let current: SlideCascadeNode | undefined = node;
  while (current?.parentId) {
    const parent = nodeMap.get(current.parentId);
    if (!parent) break;
    const classes = new Set(parent.classList);
    if (classes.has("g4")) fraction *= 0.25;
    else if (classes.has("g3") || classes.has("three-column")) fraction *= 1 / 3;
    else if (classes.has("g2") || classes.has("two-column") || classes.has("kb-grid-2")) fraction *= 0.5;
    else if (Array.from(classes).some((value) => /(pipeline|steps|timeline|metrics-row|process|roadmap)/i.test(value)) && parent.childCount > 1) {
      fraction *= 1 / parent.childCount;
    }
    current = parent;
  }

  if (slide.layoutId.startsWith("three-column")) fraction = Math.min(fraction, 1 / 3);
  else if (slide.layoutId.startsWith("two-column")) fraction = Math.min(fraction, 0.5);
  return Math.max(0.2, Math.min(1, fraction));
}
