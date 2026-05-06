import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import {
  isImagePageType,
  isVideoPageType,
  type ChartSlot,
  type LayoutFamily,
  type PageComponent,
  type PageDensity,
  type PagePortrait,
  type PageType
} from "../shared";

export function buildPagePortrait(args: {
  html: string;
  pageType: PageType;
  chartSlots: ChartSlot[];
  cssText: string;
}): PagePortrait {
  const dom = parseDocument(args.html, { decodeEntities: false });
  const root = dom as unknown as AnyNode;
  const components: PageComponent[] = [];

  components.push(...collectGridComponents(root, args.cssText));
  components.push(...collectLayoutClassComponents(root, args.cssText));
  components.push(...args.chartSlots.map((slot, index): PageComponent => ({
    id: slot.componentId || `chart-${index + 1}`,
    kind: "chart",
    subtype: `${slot.kind}-chart`,
    selector: slot.selector,
    chartSlotId: slot.slotId
  })));
  components.push(...collectSimpleComponents(root));

  const componentCounts = countComponents(components);
  const layoutFamily = inferLayoutFamily(args.pageType, componentCounts);
  const density = inferDensity(components.length);
  const componentSignature = buildComponentSignature(components);
  const tags = buildTags(args.pageType, layoutFamily, components, componentCounts);

  return {
    summary: buildSummary(layoutFamily, componentSignature, tags),
    layoutFamily,
    componentSignature,
    density,
    components,
    componentCounts,
    tags,
    useCases: buildUseCases(layoutFamily, components)
  };
}

function collectGridComponents(root: AnyNode, cssText: string): PageComponent[] {
  return (selectAll("[class*='grid-']", root) as Element[])
    .filter((element) => /\bgrid-\d+\b/.test(element.attribs?.class ?? ""))
    .map((element, index) => {
      const className = (element.attribs?.class ?? "").split(/\s+/).find((name) => /^grid-\d+$/.test(name)) ?? "grid";
      const items = countElementChildren(element);
      const cols = inferGridColumns(element, className, cssText, items);
      const rows = cols > 0 ? Math.max(1, Math.ceil(Math.max(items, 1) / cols)) : undefined;
      return {
        id: `grid-${index + 1}`,
        kind: "grid",
        subtype: rows && cols ? `grid-${rows}x${cols}` : className,
        selector: `.${className}`,
        layout: {
          rows,
          cols: cols || undefined,
          items,
          orientation: rows && cols && rows > 1 && cols > 1 ? "matrix" : cols > 1 ? "row" : "column"
        }
      } satisfies PageComponent;
    });
}

function collectLayoutClassComponents(root: AnyNode, cssText: string): PageComponent[] {
  const components: PageComponent[] = [];
  for (const element of selectAll("[class*='layout-']", root) as Element[]) {
    const className = (element.attribs?.class ?? "").split(/\s+/).find((name) => /^layout-/.test(name));
    if (!className) continue;
    const items = countElementChildren(element);
    const cols = inferGridColumns(element, className, cssText, items);
    const rows = cols > 0 ? Math.max(1, Math.ceil(Math.max(items, 1) / cols)) : undefined;
    components.push({
        id: className,
        kind: "grid",
        subtype: className,
        selector: `.${className}`,
        layout: {
          rows,
          cols: cols || undefined,
          items,
          orientation: rows && cols && rows > 1 && cols > 1 ? "matrix" : cols > 1 ? "row" : "column"
        }
      });
  }
  return components;
}

function collectSimpleComponents(root: AnyNode): PageComponent[] {
  const components: PageComponent[] = [];
  pushCounted(components, "card", selectAll(".card", root).length, "card");
  pushCounted(components, "stat", selectAll(".stat-box, .stat-card, .metric-card", root).length, "stat");
  pushCounted(components, "table", selectAll("table", root).length, "table");
  pushCounted(components, "timeline", selectAll(".timeline, .roadmap", root).length, "timeline");
  pushCounted(components, "image", selectAll("img, [data-image-slot]", root).length, "image");
  pushCounted(components, "video", selectAll("video, [data-video-slot]", root).length, "video");
  pushCounted(components, "list", selectAll("ul, ol", root).length, "list");
  pushCounted(components, "quote", selectAll("blockquote, .quote", root).length, "quote");
  return components;
}

function pushCounted(components: PageComponent[], kind: PageComponent["kind"], count: number, subtype: string) {
  for (let index = 0; index < count; index++) {
    components.push({ id: `${kind}-${index + 1}`, kind, subtype });
  }
}

function inferGridColumns(element: Element, className: string, cssText: string, items: number) {
  const inline = parseGridTemplateColumns(element.attribs?.style ?? "");
  if (inline) return inline;
  const fromCss = parseGridTemplateColumns(findCssRule(cssText, className));
  if (fromCss) return fromCss;
  const fromClass = Number(className.match(/^grid-(\d+)$/)?.[1] ?? 0);
  if (fromClass) return Math.min(fromClass, Math.max(items, 1));
  return Math.max(items, 1);
}

function parseGridTemplateColumns(value: string) {
  const template = value.match(/grid-template-columns\s*:\s*([^;]+)/i)?.[1] ?? value;
  const repeat = template.match(/repeat\(\s*(\d+)\s*,/i);
  if (repeat) return Number(repeat[1]);
  const frCount = (template.match(/\b[\d.]*fr\b/g) ?? []).length;
  if (frCount) return frCount;
  return 0;
}

function findCssRule(cssText: string, className: string) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\.${escaped}\\s*\\{([^}]+)\\}`, "i");
  return cssText.match(pattern)?.[1] ?? "";
}

function countElementChildren(element: Element) {
  return (element.children ?? []).filter((child) => (child as Element).tagName).length;
}

function countComponents(components: PageComponent[]) {
  const counts: Record<string, number> = {};
  for (const component of components) {
    counts[component.kind] = (counts[component.kind] ?? 0) + 1;
    if (component.subtype) counts[component.subtype] = (counts[component.subtype] ?? 0) + 1;
    if (component.kind === "chart" && component.subtype) {
      const chartKind = component.subtype.replace(/-chart$/, "");
      counts[`chart:${chartKind}`] = (counts[`chart:${chartKind}`] ?? 0) + 1;
    }
  }
  return counts;
}

function inferLayoutFamily(pageType: PageType, counts: Record<string, number>): LayoutFamily {
  if (pageType === "cover" || pageType === "closing") return pageType;
  const hasChart = Boolean(counts.chart);
  const hasGrid = Boolean(counts.grid);
  if (hasChart && hasGrid) return "mixed";
  if (hasChart) return "chart";
  if (counts.table) return "table";
  if (counts.image || counts.video || isImagePageType(pageType) || isVideoPageType(pageType)) return "media";
  if (counts.timeline || pageType === "path-flow") return "timeline";
  if (hasGrid || pageType.startsWith("grid-")) return "grid";
  return "text";
}

function inferDensity(componentCount: number): PageDensity {
  if (componentCount <= 3) return "low";
  if (componentCount <= 8) return "medium";
  return "high";
}

function buildComponentSignature(components: PageComponent[]) {
  const parts = new Map<string, number>();
  for (const component of components) {
    const key = component.kind === "grid" && component.layout?.rows && component.layout.cols
      ? `grid:${component.layout.rows}x${component.layout.cols}`
      : component.kind === "chart"
        ? `chart:${component.subtype?.replace(/-chart$/, "") ?? "unknown"}`
        : component.kind;
    parts.set(key, (parts.get(key) ?? 0) + 1);
  }
  return [...parts.entries()].map(([key, count]) => `${key} x${count}`).join(" + ") || "text x1";
}

function buildTags(pageType: PageType, layoutFamily: LayoutFamily, components: PageComponent[], counts: Record<string, number>) {
  const tags = new Set<string>([`pageType:${pageType}`, `layout:${layoutFamily}`]);
  if (counts.grid && counts.chart) tags.add("mixed:grid+chart");
  for (const component of components) {
    if (component.kind === "grid" && component.layout?.rows && component.layout.cols) {
      tags.add(`grid:${component.layout.rows}x${component.layout.cols}`);
    }
    if (component.kind === "chart") tags.add(`chart:${component.subtype?.replace(/-chart$/, "") ?? "unknown"}`);
  }
  return [...tags];
}

function buildUseCases(layoutFamily: LayoutFamily, components: PageComponent[]) {
  const useCases = new Set<string>();
  if (layoutFamily === "grid") useCases.add("结构对比");
  if (layoutFamily === "chart" || components.some((component) => component.kind === "chart")) useCases.add("数据分析");
  if (components.some((component) => component.kind === "chart" && component.subtype === "line-chart")) useCases.add("趋势分析");
  if (components.some((component) => component.kind === "chart" && component.subtype === "bar-chart")) useCases.add("指标对比");
  if (components.some((component) => component.kind === "chart" && component.subtype === "pie-chart")) useCases.add("占比分布");
  if (layoutFamily === "media") useCases.add("视觉展示");
  if (layoutFamily === "timeline") useCases.add("路线规划");
  if (!useCases.size) useCases.add("正文说明");
  return [...useCases];
}

function buildSummary(layoutFamily: LayoutFamily, componentSignature: string, tags: string[]) {
  return `${layoutFamily} page with ${componentSignature}${tags.length ? `; ${tags.slice(0, 4).join(", ")}` : ""}`;
}
