import { parseDocument } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";

const STRONG_MARKER = "|STRONG|";

export function parseStrongText(text: string): AnyNode[] {
  if (!text.includes(STRONG_MARKER)) return parseInlineHtml(escapeHtml(text));

  const parts = text.split(STRONG_MARKER);
  const html = parts
    .map((part, index) => {
      if (!part) return "";
      return index < parts.length - 1
        ? `<strong>${escapeHtml(part)}</strong>`
        : escapeHtml(part);
    })
    .join("");
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
