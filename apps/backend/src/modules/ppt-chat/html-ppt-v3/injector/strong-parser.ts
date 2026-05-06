import { parseDocument } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";

const STRONG_MARKER = "|STRONG|";

export function parseStrongText(text: string): AnyNode[] {
  const markerIndex = text.indexOf(STRONG_MARKER);
  if (markerIndex < 0) return parseInlineHtml(escapeHtml(text));

  const strongText = text.slice(0, markerIndex);
  const restText = text.slice(markerIndex + STRONG_MARKER.length);
  const html = `${strongText ? `<strong>${escapeHtml(strongText)}</strong>` : ""}${escapeHtml(restText)}`;
  return parseInlineHtml(html);
}

function parseInlineHtml(html: string): AnyNode[] {
  return parseDocument(html, { decodeEntities: false }).children as AnyNode[];
}

export function attachChildren(parent: Element, children: AnyNode[]) {
  parent.children = children;
  for (const child of children) {
    child.parent = parent;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
