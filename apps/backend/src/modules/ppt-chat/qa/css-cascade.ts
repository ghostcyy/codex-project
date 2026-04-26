import { parseDocument } from "htmlparser2";
import postcss, { type Declaration, type Rule } from "postcss";
import { selectAll } from "css-select";
import { parse as parseSelectorAst } from "css-what";
import type { ComputedStyle, SlideCascade, SlideCascadeNode, SlideTier } from "./qa-types";

type HtmlNode = {
  type?: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
  parent?: HtmlNode | null;
};

type CascadeOptions = {
  baseCss?: string;
  slideLayouts?: Array<{ slideIndex: number; layoutId: string }>;
  viewportWidth?: number;
  viewportHeight?: number;
};

type CssDeclaration = {
  prop: string;
  value: string;
  important: boolean;
};

type CssRuleEntry = {
  selector: string;
  specificity: [number, number, number];
  order: number;
  declarations: CssDeclaration[];
};

type AppliedValue = {
  value: string;
  important: boolean;
  inline: boolean;
  specificity: [number, number, number];
  order: number;
};

type ElementState = {
  props: Map<string, AppliedValue>;
  vars: Map<string, AppliedValue>;
};

const INHERITED_PROPERTIES = new Set(["font-size", "font-weight", "font-family", "line-height", "color"]);

const TRACKED_PROPERTIES = new Set([
  "font",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "color",
  "background",
  "background-color",
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left"
]);

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;

export function buildSlideCascade(indexHtml: string, styleCss: string, options: CascadeOptions = {}): SlideCascade[] {
  const baseCss = options.baseCss ?? "";
  const viewportWidth = options.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const viewportHeight = options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;
  const sections = indexHtml.match(/<section\b[\s\S]*?<\/section>/gi) ?? [];
  const htmlAttrs = extractTagAttributes(indexHtml, "html");
  const bodyAttrs = extractTagAttributes(indexHtml, "body");
  const inlineCss = extractInlineStyleBlocks(indexHtml).join("\n\n");
  const cssSource = [baseCss, inlineCss, styleCss].filter(Boolean).join("\n\n");
  const rules = parseCssRules(cssSource);
  const slideLayouts = options.slideLayouts ?? [];

  return sections.map((sectionHtml, sectionIndex) => {
    const slideIndex = slideLayouts[sectionIndex]?.slideIndex ?? sectionIndex + 1;
    const layoutId = slideLayouts[sectionIndex]?.layoutId ?? "unknown";
    const wrapper = `<!DOCTYPE html><html${htmlAttrs}><body${bodyAttrs}><div class="deck">${sectionHtml}</div></body></html>`;
    const document = parseDocument(wrapper) as HtmlNode;
    const htmlNode = firstElement(selectAll("html", document as never)[0] as HtmlNode | undefined);
    const slideNode = firstElement(selectAll("section.slide", document as never)[0] as HtmlNode | undefined);
    if (!htmlNode || !slideNode) {
      return { slideIndex, layoutId, tier: classifySlideTier(layoutId), nodes: [] };
    }

    const states = new Map<HtmlNode, ElementState>();
    applyCssRules(document, rules, states);
    applyInlineStyles(htmlNode, states);

    const nodes: SlideCascadeNode[] = [];
    const visit = (node: HtmlNode, parentStyle?: ComputedStyle, inSlide = false) => {
      if (!isElement(node)) return;
      const computed = computeStyle(node, states.get(node), parentStyle, viewportWidth, viewportHeight);
      const insideSlide = inSlide || node === slideNode;
      if (insideSlide) {
        const parentChildren = elementChildren(node.parent ?? { children: [] });
        nodes.push({
          id: buildNodeId(nodes.length + 1),
          tagName: node.name ?? "div",
          classList: classList(node),
          attributes: { ...(node.attribs ?? {}) },
          text: visibleNodeText(node),
          path: buildNodePath(node, slideNode),
          parentId: undefined,
          childIndex: siblingIndex(node),
          childCount: Math.max(1, parentChildren.length),
          computed
        });
      }
      for (const child of elementChildren(node)) {
        visit(child, computed, insideSlide);
      }
    };

    visit(htmlNode, undefined, false);
    const enrichedNodes = attachParentIds(nodes);
    return {
      slideIndex,
      layoutId,
      tier: classifySlideTier(layoutId),
      nodes: enrichedNodes
    };
  });
}

export function classifySlideTier(layoutId: string): SlideTier {
  const normalized = layoutId.toLowerCase();
  if (/(cover|image-hero|hero)/.test(normalized)) return "hero";
  if (/(section-divider|divider|interstitial)/.test(normalized)) return "divider";
  if (/(cta|thanks|closing|closer)/.test(normalized)) return "closer";
  if (/(stat|kpi|chart|comparison|timeline|roadmap|process|table|diagram|flow)/.test(normalized)) return "data";
  return "body";
}

function attachParentIds(nodes: SlideCascadeNode[]) {
  const idByPath = new Map(nodes.map((node) => [node.path, node.id]));
  return nodes.map((node) => ({
    ...node,
    parentId: parentPath(node.path) ? idByPath.get(parentPath(node.path) as string) : undefined
  }));
}

function parentPath(path: string) {
  const parts = path.split(" > ");
  if (parts.length <= 1) return undefined;
  return parts.slice(0, -1).join(" > ");
}

function buildNodeId(index: number) {
  return `node-${index}`;
}

function extractInlineStyleBlocks(html: string) {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)).map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

function extractTagAttributes(html: string, tag: "html" | "body") {
  const match = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(html);
  return match?.[1] ? ` ${match[1].trim()}` : "";
}

function parseCssRules(cssSource: string): CssRuleEntry[] {
  if (!cssSource.trim()) return [];
  const root = postcss.parse(cssSource);
  const rules: CssRuleEntry[] = [];
  let order = 0;

  root.walkRules((rule) => {
    if (isWithinKeyframes(rule)) return;
    const declarations = collectTrackedDeclarations(rule);
    if (declarations.length === 0) return;
    for (const selector of rule.selectors ?? []) {
      const normalizedSelector = selector.trim();
      if (!normalizedSelector || /::(?:before|after)/i.test(normalizedSelector)) continue;
      rules.push({
        selector: normalizedSelector,
        specificity: computeSpecificity(normalizedSelector),
        order: order += 1,
        declarations
      });
    }
  });

  return rules;
}

function isWithinKeyframes(rule: Rule) {
  let current: { type?: string; name?: string; parent?: unknown } | undefined = rule.parent as unknown as {
    type?: string;
    name?: string;
    parent?: unknown;
  };
  while (current) {
    if (current.type === "atrule" && /keyframes$/i.test(current.name ?? "")) return true;
    current = current.parent as typeof current;
  }
  return false;
}

function collectTrackedDeclarations(rule: Rule) {
  const declarations: CssDeclaration[] = [];
  for (const node of rule.nodes ?? []) {
    if (node.type !== "decl") continue;
    const decl = node as Declaration;
    const prop = decl.prop.trim().toLowerCase();
    if (!prop.startsWith("--") && !TRACKED_PROPERTIES.has(prop)) continue;
    declarations.push({ prop, value: decl.value.trim(), important: Boolean(decl.important) });
  }
  return declarations;
}

function computeSpecificity(selector: string): [number, number, number] {
  try {
    const groups = parseSelectorAst(selector);
    return groups.reduce<[number, number, number]>((best, group) => {
      const next = specificityForGroup(group);
      return compareSpecificity(next, best) > 0 ? next : best;
    }, [0, 0, 0]);
  } catch {
    return [0, 0, 0];
  }
}

function specificityForGroup(group: ReturnType<typeof parseSelectorAst>[number]): [number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const token of group) {
    switch (token.type) {
      case "attribute":
        if (token.name === "id" && token.action === "equals") a += 1;
        else b += 1;
        break;
      case "pseudo":
        if (token.name === "where") break;
        if (Array.isArray(token.data)) {
          const nested = token.data.reduce<[number, number, number]>((best, nestedGroup) => {
            const next = specificityForGroup(nestedGroup);
            return compareSpecificity(next, best) > 0 ? next : best;
          }, [0, 0, 0]);
          a += nested[0];
          b += nested[1];
          c += nested[2];
          break;
        }
        if (token.name.startsWith("::")) c += 1;
        else b += 1;
        break;
      case "pseudo-element":
        c += 1;
        break;
      case "tag":
        if (token.name !== "*") c += 1;
        break;
      default:
        break;
    }
  }
  return [a, b, c];
}

function compareSpecificity(left: [number, number, number], right: [number, number, number]) {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}

function applyCssRules(document: HtmlNode, rules: CssRuleEntry[], states: Map<HtmlNode, ElementState>) {
  for (const rule of rules) {
    let matches: HtmlNode[] = [];
    try {
      matches = selectAll(rule.selector, document as never) as unknown as HtmlNode[];
    } catch {
      continue;
    }
    for (const match of matches) {
      if (!isElement(match)) continue;
      const state = getOrCreateState(states, match);
      for (const declaration of rule.declarations) {
        const target = declaration.prop.startsWith("--") ? state.vars : state.props;
        const candidate: AppliedValue = {
          value: declaration.value,
          important: declaration.important,
          inline: false,
          specificity: rule.specificity,
          order: rule.order
        };
        const previous = target.get(declaration.prop);
        if (!previous || winsCascade(candidate, previous)) {
          target.set(declaration.prop, candidate);
        }
      }
    }
  }
}

function applyInlineStyles(root: HtmlNode, states: Map<HtmlNode, ElementState>) {
  const queue: HtmlNode[] = [root];
  let order = 100_000;
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || !isElement(node)) continue;
    const inlineStyle = node.attribs?.style;
    if (inlineStyle) {
      const state = getOrCreateState(states, node);
      for (const declaration of parseInlineStyle(inlineStyle)) {
        const target = declaration.prop.startsWith("--") ? state.vars : state.props;
        target.set(declaration.prop, {
          value: declaration.value,
          important: declaration.important,
          inline: true,
          specificity: [1, 0, 0],
          order: order += 1
        });
      }
    }
    for (const child of elementChildren(node)) queue.push(child);
  }
}

function parseInlineStyle(style: string) {
  return style
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const index = chunk.indexOf(":");
      const prop = chunk.slice(0, index).trim().toLowerCase();
      const rawValue = chunk.slice(index + 1).trim();
      const important = /\!important$/i.test(rawValue);
      const value = rawValue.replace(/\!important$/i, "").trim();
      return { prop, value, important };
    })
    .filter((item) => item.prop && item.value);
}

function winsCascade(next: AppliedValue, current: AppliedValue) {
  if (next.important !== current.important) return next.important;
  if (next.inline !== current.inline) return next.inline;
  const specificityDelta = compareSpecificity(next.specificity, current.specificity);
  if (specificityDelta !== 0) return specificityDelta > 0;
  return next.order >= current.order;
}

function computeStyle(
  node: HtmlNode,
  state: ElementState | undefined,
  parentStyle: ComputedStyle | undefined,
  viewportWidth: number,
  viewportHeight: number
): ComputedStyle {
  const inheritedVars = parentStyle?.customProperties ?? {};
  const customProperties = { ...inheritedVars };
  for (const [name, applied] of state?.vars ?? []) {
    customProperties[name] = resolveCssVariables(applied.value, customProperties);
  }

  const rawProps = Object.fromEntries(Array.from(state?.props ?? []).map(([key, applied]) => [key, resolveCssVariables(applied.value, customProperties)]));
  const fontSizeRaw = rawProps["font-size"] ?? (INHERITED_PROPERTIES.has("font-size") ? String(parentStyle?.fontSize ?? "16px") : "16px");
  const fontSize = resolveLengthPx(fontSizeRaw, parentStyle?.fontSize ?? 16, viewportWidth, viewportHeight) ?? parentStyle?.fontSize ?? 16;
  const lineHeightRaw = rawProps["line-height"] ?? String(parentStyle?.lineHeight ?? fontSize * 1.2);
  const lineHeight = resolveLineHeightPx(lineHeightRaw, fontSize, viewportWidth, viewportHeight);
  const padding = resolveBoxShorthand(rawProps["padding"], fontSize, viewportWidth, viewportHeight);
  const margin = resolveBoxShorthand(rawProps["margin"], fontSize, viewportWidth, viewportHeight);
  const background = rawProps["background"] ?? rawProps["background-color"];
  const borderShorthand = rawProps["border"] ?? "";
  const borderWidth = resolveBorderWidth(rawProps["border-width"] ?? borderShorthand, fontSize, viewportWidth, viewportHeight);
  const borderRadius = resolveLengthPx(rawProps["border-radius"] ?? "0", fontSize, viewportWidth, viewportHeight) ?? 0;
  const fontWeight = resolveFontWeight(rawProps["font-weight"] ?? parentStyle?.raw["font-weight"]);
  const color = normalizeColor(rawProps["color"] ?? parentStyle?.color);
  const borderColor = normalizeColor(rawProps["border-color"] ?? extractBorderColor(borderShorthand));

  return {
    fontSize,
    fontWeight,
    fontFamily: (rawProps["font-family"] ?? parentStyle?.fontFamily ?? "").trim() || undefined,
    color,
    lineHeight,
    border: canonicalBorder(borderWidth, rawProps["border-style"] ?? extractBorderStyle(borderShorthand), borderColor),
    borderWidth,
    borderStyle: (rawProps["border-style"] ?? extractBorderStyle(borderShorthand)).trim() || undefined,
    borderColor,
    borderRadius,
    background,
    backgroundColor: normalizeColor(rawProps["background-color"] ?? undefined),
    paddingTop: padding[0],
    paddingRight: padding[1],
    paddingBottom: padding[2],
    paddingLeft: padding[3],
    marginTop: margin[0],
    marginRight: margin[1],
    marginBottom: margin[2],
    marginLeft: margin[3],
    customProperties,
    raw: rawProps
  };
}

function resolveCssVariables(value: string | undefined, vars: Record<string, string>, seen = new Set<string>()): string {
  if (!value) return "";
  return value.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_match, name: string, fallback?: string) => {
    if (seen.has(name)) return fallback?.trim() ?? "";
    const resolved = vars[name];
    if (!resolved) return fallback?.trim() ?? "";
    seen.add(name);
    return resolveCssVariables(resolved, vars, seen);
  });
}

function resolveLineHeightPx(value: string, fontSize: number, viewportWidth: number, viewportHeight: number) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "normal") return Number((fontSize * 1.2).toFixed(2));
  if (/^[\d.]+$/.test(normalized)) return Number((Number(normalized) * fontSize).toFixed(2));
  return resolveLengthPx(normalized, fontSize, viewportWidth, viewportHeight) ?? Number((fontSize * 1.2).toFixed(2));
}

function resolveBoxShorthand(value: string | undefined, fontSize: number, viewportWidth: number, viewportHeight: number): [number, number, number, number] {
  if (!value) return [0, 0, 0, 0];
  const parts = splitCssList(value.replace(/\//g, " "));
  const resolved = parts.map((part) => resolveLengthPx(part, fontSize, viewportWidth, viewportHeight) ?? 0);
  if (resolved.length === 1) return [resolved[0] ?? 0, resolved[0] ?? 0, resolved[0] ?? 0, resolved[0] ?? 0];
  if (resolved.length === 2) return [resolved[0] ?? 0, resolved[1] ?? 0, resolved[0] ?? 0, resolved[1] ?? 0];
  if (resolved.length === 3) return [resolved[0] ?? 0, resolved[1] ?? 0, resolved[2] ?? 0, resolved[1] ?? 0];
  return [resolved[0] ?? 0, resolved[1] ?? 0, resolved[2] ?? 0, resolved[3] ?? 0];
}

function resolveLengthPx(value: string | undefined, baseFontSize: number, viewportWidth: number, viewportHeight: number): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  if (normalized.startsWith("clamp(") && normalized.endsWith(")")) {
    const parts = splitCssArgs(normalized.slice(6, -1));
    if (parts.length !== 3) return undefined;
    const min = resolveLengthPx(parts[0], baseFontSize, viewportWidth, viewportHeight);
    const preferred = resolveLengthPx(parts[1], baseFontSize, viewportWidth, viewportHeight);
    const max = resolveLengthPx(parts[2], baseFontSize, viewportWidth, viewportHeight);
    if (min === undefined || preferred === undefined || max === undefined) return undefined;
    return Number(Math.min(Math.max(preferred, min), max).toFixed(2));
  }
  if (normalized.startsWith("calc(") && normalized.endsWith(")")) {
    const inner = normalized.slice(5, -1).trim();
    const additive = inner.split(/\s+\+\s+/);
    if (additive.length > 1) {
      const total = additive.reduce((sum, part) => sum + (resolveLengthPx(part, baseFontSize, viewportWidth, viewportHeight) ?? 0), 0);
      return Number(total.toFixed(2));
    }
  }
  if (/^-?[\d.]+px$/.test(normalized)) return Number.parseFloat(normalized);
  if (/^-?[\d.]+rem$/.test(normalized)) return Number((Number.parseFloat(normalized) * 16).toFixed(2));
  if (/^-?[\d.]+em$/.test(normalized)) return Number((Number.parseFloat(normalized) * baseFontSize).toFixed(2));
  if (/^-?[\d.]+vw$/.test(normalized)) return Number((Number.parseFloat(normalized) * viewportWidth / 100).toFixed(2));
  if (/^-?[\d.]+vh$/.test(normalized)) return Number((Number.parseFloat(normalized) * viewportHeight / 100).toFixed(2));
  if (/^-?[\d.]+%$/.test(normalized)) return Number((Number.parseFloat(normalized) * baseFontSize / 100).toFixed(2));
  if (/^-?[\d.]+pt$/.test(normalized)) return Number((Number.parseFloat(normalized) * 1.3333).toFixed(2));
  if (/^-?[\d.]+$/.test(normalized)) return Number.parseFloat(normalized);
  switch (normalized) {
    case "thin":
      return 1;
    case "medium":
      return 3;
    case "thick":
      return 5;
    default:
      return undefined;
  }
}

function resolveBorderWidth(value: string | undefined, fontSize: number, viewportWidth: number, viewportHeight: number) {
  if (!value) return undefined;
  const direct = resolveLengthPx(value, fontSize, viewportWidth, viewportHeight);
  if (direct !== undefined) return direct;
  const tokens = splitCssList(value);
  for (const token of tokens) {
    const resolved = resolveLengthPx(token, fontSize, viewportWidth, viewportHeight);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveFontWeight(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^[\d.]+$/.test(normalized)) return Number.parseInt(normalized, 10);
  switch (normalized) {
    case "normal":
      return 400;
    case "bold":
      return 700;
    case "bolder":
      return 800;
    case "lighter":
      return 300;
    default:
      return undefined;
  }
}

function extractBorderStyle(value: string | undefined) {
  if (!value) return "";
  const tokens = splitCssList(value);
  return tokens.find((token) => /^(none|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(token)) ?? "";
}

function extractBorderColor(value: string | undefined) {
  if (!value) return undefined;
  const tokens = splitCssList(value);
  return tokens.find((token) => !resolveLengthPx(token, 16, DEFAULT_VIEWPORT_WIDTH, DEFAULT_VIEWPORT_HEIGHT) && !/^(none|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(token));
}

function canonicalBorder(width: number | undefined, style: string | undefined, color: string | undefined) {
  const parts = [width !== undefined ? `${Number(width.toFixed(2))}px` : "", style?.trim() ?? "", color?.trim() ?? ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function normalizeColor(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.trim();
  const rgb = parseRgb(normalized);
  if (!rgb) return normalized.replace(/\s+/g, " ");
  if (rgb.a < 1) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Number(rgb.a.toFixed(3))})`;
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

function parseRgb(value: string) {
  const hex = value.match(/^#([\da-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1] ?? "";
    if (raw.length === 3) {
      return {
        r: Number.parseInt(raw.charAt(0) + raw.charAt(0), 16),
        g: Number.parseInt(raw.charAt(1) + raw.charAt(1), 16),
        b: Number.parseInt(raw.charAt(2) + raw.charAt(2), 16),
        a: 1
      };
    }
    if (raw.length === 6 || raw.length === 8) {
      return {
        r: Number.parseInt(raw.slice(0, 2), 16),
        g: Number.parseInt(raw.slice(2, 4), 16),
        b: Number.parseInt(raw.slice(4, 6), 16),
        a: raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1
      };
    }
  }

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = (rgb[1] ?? "").split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      return {
        r: clampChannel(parts[0] ?? "0"),
        g: clampChannel(parts[1] ?? "0"),
        b: clampChannel(parts[2] ?? "0"),
        a: parts[3] ? Number(parts[3]) : 1
      };
    }
  }

  return undefined;
}

function clampChannel(value: string) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(255, Math.round(numeric)));
}

function splitCssArgs(value: string) {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function splitCssList(value: string) {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current.trim()) {
        result.push(current.trim());
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function buildNodePath(node: HtmlNode, slideRoot: HtmlNode) {
  const segments: string[] = [];
  let current: HtmlNode | undefined | null = node;
  while (current && current !== slideRoot.parent) {
    if (isElement(current)) {
      segments.unshift(pathSegment(current));
    }
    if (current === slideRoot) break;
    current = current.parent;
  }
  return segments.join(" > ");
}

function pathSegment(node: HtmlNode) {
  const tag = node.name ?? "div";
  const classes = classList(node).slice(0, 3);
  const index = siblingIndex(node);
  const classSuffix = classes.length > 0 ? `.${classes.join(".")}` : "";
  return `${tag}${classSuffix}:nth-child(${index})`;
}

function siblingIndex(node: HtmlNode) {
  const parent = node.parent;
  if (!parent?.children) return 1;
  const siblings = parent.children.filter(isElement);
  const index = siblings.findIndex((child) => child === node);
  return index >= 0 ? index + 1 : 1;
}

function visibleNodeText(node: HtmlNode): string {
  if (!node.children || node.children.length === 0) return "";
  return node.children
    .map((child) => {
      if (child.type === "text") return child.data ?? "";
      if (!isElement(child)) return "";
      return visibleNodeText(child);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function classList(node: HtmlNode) {
  return (node.attribs?.class ?? "").split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function elementChildren(node: HtmlNode) {
  return (node.children ?? []).filter(isElement);
}

function isElement(node: HtmlNode | undefined | null): node is HtmlNode {
  return Boolean(node && node.type === "tag");
}

function firstElement(node: HtmlNode | undefined) {
  return isElement(node) ? node : undefined;
}

function getOrCreateState(states: Map<HtmlNode, ElementState>, node: HtmlNode) {
  const existing = states.get(node);
  if (existing) return existing;
  const created: ElementState = { props: new Map(), vars: new Map() };
  states.set(node, created);
  return created;
}
