/**
 * html-ppt-v3 :: manifest.parser.ts  (CLI tool)
 *
 * Semi-automatic manifest generator.
 * Usage (from backend root):
 *   npx tsx src/modules/ppt-chat/html-ppt-v3/manifest/manifest.parser.ts
 *   npx tsx src/modules/ppt-chat/html-ppt-v3/manifest/manifest.parser.ts 09-fashion-ar
 *
 * For each template (or the specified one), reads index.html, analyses the
 * DOM structure and emits a manifest.json DRAFT into the template folder.
 * The draft must be human-reviewed before committing.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import type { ChildNode, Document, Element, Text } from "domhandler";
import { PAGE_TYPES, type PageType, type SlideManifest, type SlotAnchor, type TemplateManifest } from "./manifest.types";

/* ─── Paths ─────────────────────────────────────────────────────── */

// __dirname = apps/backend/src/modules/ppt-chat/html-ppt-v3/manifest
const TEMPLATES_ROOT = resolve(
  __dirname,
  "../../../../../../../.agents/skills/html-ppt/templates/full-decks/gemini"
);

/* ─── Entry point ───────────────────────────────────────────────── */

async function main() {
  const targetId = process.argv[2]?.trim();
  const templateIds: string[] = targetId
    ? [targetId]
    : (await readdir(TEMPLATES_ROOT, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

  for (const templateId of templateIds) {
    const htmlPath = join(TEMPLATES_ROOT, templateId, "index.html");
    if (!existsSync(htmlPath)) {
      console.warn(`[SKIP] ${templateId}: index.html not found`);
      continue;
    }

    try {
      const html = await readFile(htmlPath, "utf8");
      const manifest = parseTemplateHtml(templateId, html);
      const outPath = join(TEMPLATES_ROOT, templateId, "manifest.json");
      await writeFile(outPath, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`[OK]   ${templateId} → manifest.json  (${manifest.slides.length} slides)`);
    } catch (err) {
      console.error(`[ERR]  ${templateId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/* ─── Parser ────────────────────────────────────────────────────── */

function parseTemplateHtml(templateId: string, html: string): TemplateManifest {
  const dom = parseDocument(html);

  // Extract deckClass from <body class="tpl-*">
  const body = selectOne("body", dom as unknown as ChildNode) as Element | null;
  const deckClass = (body?.attribs?.class ?? "")
    .split(/\s+/)
    .find((c) => c.startsWith("tpl-")) ?? "tpl-unknown";

  // Extract all slides
  const sections = selectAll("section.slide", dom as unknown as ChildNode) as Element[];
  const totalSlides = sections.length;

  const slides: SlideManifest[] = sections.map((section, index) => {
    const slideIndex = index + 1;
    const isFirst = slideIndex === 1;
    const isLast = slideIndex === totalSlides;
    return parseSection(section, slideIndex, isFirst, isLast, dom);
  });

  return {
    id: templateId,
    label: {
      "zh-CN": `模板 ${templateId}`,
      en: `Template ${templateId}`,
    },
    description: {
      "zh-CN": "（待填写）",
      en: "(to be filled)",
    },
    deckClass,
    totalSlides,
    slides,
  };
}

function parseSection(
  section: Element,
  slideIndex: number,
  isFirst: boolean,
  isLast: boolean,
  _dom: Document
): SlideManifest {
  const classes = (section.attribs?.class ?? "").split(/\s+/);

  /* ── PageType detection ── */
  const pageType = detectPageType(section, classes, isFirst, isLast);

  /* ── Slide title from data-title attribute ── */
  const slideTitle = section.attribs?.["data-title"] ?? `Slide ${slideIndex}`;

  /* ── Count topic cards ── */
  const { topicSlots, topicSlotMaxChars } = measureTopicSlots(section, pageType);

  /* ── Media detection ── */
  const imgWraps = selectAll(".img-wrap", section as unknown as ChildNode) as Element[];
  const hasImage = imgWraps.length > 0;
  const imageCount = imgWraps.length;

  const videoEls = selectAll("video", section as unknown as ChildNode) as Element[];
  const hasVideo = videoEls.length > 0;

  const canvasEls = selectAll("canvas[id]", section as unknown as ChildNode) as Element[];
  const hasChart = canvasEls.length > 0;
  const chartCanvasIds = canvasEls.map((el) => el.attribs?.id ?? "").filter(Boolean);

  /* ── Slot anchors ── */
  const anchors = extractAnchors(section, pageType);

  return {
    slideIndex,
    slideTitle,
    pageType,
    topicSlots,
    topicSlotMaxChars,
    hasImage,
    imageCount,
    hasVideo,
    hasChart,
    chartCanvasIds,
    anchors,
  };
}

/* ─── PageType detection ─────────────────────────────────────────── */

function detectPageType(section: Element, classes: string[], isFirst: boolean, isLast: boolean): PageType {
  const has = (cls: string) => classes.includes(cls);
  const hasChild = (sel: string) => (selectOne(sel, section as unknown as ChildNode) as Element | null) !== null;

  // Cover / Closing must be checked before generic grids
  if (has("title-slide") && isFirst) return "cover";
  if (has("title-slide") && isLast) return "closing";
  if (has("title-slide")) return "cover"; // mid-deck title slides treated as cover style

  if (hasChild("audio")) return "audio";
  if (hasChild("video")) return "video";
  if (hasChild("canvas")) return "chart";
  if (hasChild(".flow-step") || hasChild(".flow-container")) return "path-flow";
  if (hasChild(".data-table")) return "table";

  if (hasChild(".grid-layout-sidebar") || hasChild(".grid-sidebar")) return "sidebar";

  // Check for image+text combinations in grid-2
  const hasGrid2 = hasChild(".grid-2");
  const hasImgWrap = hasChild(".img-wrap");

  if (hasGrid2 && hasImgWrap) return "image-text";
  if (hasGrid2) return "grid-2";
  if (hasChild(".grid-3")) return "grid-3";
  if (hasChild(".grid-4")) return "grid-4";
  if (hasChild(".grid-5")) return "grid-5";

  // Full-bleed image (img-wrap with no grid)
  if (hasImgWrap && !hasChild(".content-area > *:not(.img-wrap)")) return "image-full";

  return "title-text";
}

/* ─── Topic slot measurement ─────────────────────────────────────── */

function measureTopicSlots(section: Element, pageType: PageType): { topicSlots: number; topicSlotMaxChars: number } {
  const cards = selectAll(".card", section as unknown as ChildNode) as Element[];
  const topicSlots = cards.length;

  if (!topicSlots) {
    return { topicSlots: 0, topicSlotMaxChars: 0 };
  }

  // Measure average body text length per card as char budget baseline
  let totalChars = 0;
  let counted = 0;
  for (const card of cards) {
    const pEl = selectOne("p", card as unknown as ChildNode) as Element | null;
    if (pEl) {
      const text = getTextContent(pEl);
      totalChars += text.length;
      counted++;
    }
  }

  // Use 1.2× observed average as max, clamped between 60-400 chars
  const avg = counted > 0 ? totalChars / counted : 120;
  const topicSlotMaxChars = Math.min(400, Math.max(60, Math.round(avg * 1.3)));

  return { topicSlots, topicSlotMaxChars };
}

/* ─── Slot anchor extraction ─────────────────────────────────────── */

function extractAnchors(section: Element, pageType: PageType): SlotAnchor[] {
  const anchors: SlotAnchor[] = [];

  // Title (h2.h2 or h1.h1)
  const titleEl = (selectOne("h2.h2", section as unknown as ChildNode) ??
                   selectOne("h1.h1", section as unknown as ChildNode)) as Element | null;
  if (titleEl) {
    const sel = buildSelector(titleEl, section);
    if (sel) {
      anchors.push({ slotId: "title", selector: sel, maxChars: 60, optional: false });
    }
  }

  // Kicker
  const kickerEl = (selectOne(".kicker", section as unknown as ChildNode) ??
                    selectOne("span.kicker", section as unknown as ChildNode)) as Element | null;
  if (kickerEl) {
    const sel = buildSelector(kickerEl, section);
    if (sel) {
      anchors.push({ slotId: "kicker", selector: sel, maxChars: 40, optional: true });
    }
  }

  // Footer
  const footerEl = selectOne(".footer span:first-child", section as unknown as ChildNode) as Element | null;
  if (footerEl) {
    const sel = buildSelector(footerEl, section);
    if (sel) {
      anchors.push({ slotId: "footer", selector: sel, maxChars: 80, optional: true });
    }
  }

  // Cards
  const cards = selectAll(".card", section as unknown as ChildNode) as Element[];
  cards.forEach((card, idx) => {
    const cardNum = idx + 1;

    const h3 = selectOne("h3", card as unknown as ChildNode) as Element | null;
    if (h3) {
      const sel = buildSelector(h3, section);
      if (sel) {
        const text = getTextContent(h3);
        anchors.push({
          slotId:   `card-${cardNum}-heading`,
          selector: sel,
          maxChars: Math.min(60, Math.max(20, Math.round(text.length * 1.2))),
          optional: false,
        });
      }
    }

    const p = selectOne("p", card as unknown as ChildNode) as Element | null;
    if (p) {
      const sel = buildSelector(p, section);
      if (sel) {
        const text = getTextContent(p);
        anchors.push({
          slotId:   `card-${cardNum}-body`,
          selector: sel,
          maxChars: Math.min(400, Math.max(60, Math.round(text.length * 1.3))),
          optional: false,
        });
      }
    }
  });

  // Flow steps (path-flow slides)
  if (pageType === "path-flow") {
    const steps = selectAll(".flow-step", section as unknown as ChildNode) as Element[];
    steps.forEach((step, idx) => {
      const h3 = selectOne("h3", step as unknown as ChildNode) as Element | null;
      const p = selectOne("p", step as unknown as ChildNode) as Element | null;
      if (h3) {
        const sel = buildSelector(h3, section);
        if (sel) anchors.push({ slotId: `step-${idx + 1}-heading`, selector: sel, maxChars: 40, optional: false });
      }
      if (p) {
        const sel = buildSelector(p, section);
        if (sel) anchors.push({ slotId: `step-${idx + 1}-body`, selector: sel, maxChars: 120, optional: true });
      }
    });
  }

  // Cover / closing subtitle / meta
  if (pageType === "cover" || pageType === "closing") {
    const pEls = selectAll("p", section as unknown as ChildNode) as Element[];
    pEls.slice(0, 2).forEach((pEl, idx) => {
      const sel = buildSelector(pEl, section);
      if (sel) {
        const text = getTextContent(pEl);
        anchors.push({
          slotId:   idx === 0 ? "subtitle" : `meta-${idx}`,
          selector: sel,
          maxChars: Math.min(200, Math.max(30, Math.round(text.length * 1.3))),
          optional: true,
        });
      }
    });
  }

  // Table slides: extract <th> headers and <td> data cells
  if (pageType === "table") {
    // Intro paragraph above the table (optional summary text)
    const introP = selectOne(".content-area > p", section as unknown as ChildNode) as Element | null;
    if (introP) {
      const sel = buildSelector(introP, section);
      if (sel) {
        const text = getTextContent(introP);
        anchors.push({
          slotId:   "table-intro",
          selector: sel,
          maxChars: Math.min(300, Math.max(60, Math.round(text.length * 1.5))),
          optional: true,
        });
      }
    }

    // Table header cells (<th>)
    const thEls = selectAll("table.data-table thead th", section as unknown as ChildNode) as Element[];
    thEls.forEach((th, colIdx) => {
      const sel = buildSelector(th, section);
      if (sel) {
        const text = getTextContent(th);
        anchors.push({
          slotId:   `table-header-${colIdx + 1}`,
          selector: sel,
          maxChars: Math.min(80, Math.max(10, Math.round(text.length * 1.2))),
          optional: false,
        });
      }
    });

    // Table body rows + cells (<td>)
    const trEls = selectAll("table.data-table tbody tr", section as unknown as ChildNode) as Element[];
    trEls.forEach((tr, rowIdx) => {
      const tdEls = selectAll("td", tr as unknown as ChildNode) as Element[];
      tdEls.forEach((td, colIdx) => {
        const sel = buildSelector(td, section);
        if (sel) {
          const text = getTextContent(td);
          // Body cells (wider columns, typically 3rd col) get more chars
          const baseMax = colIdx === 0 ? 30 : colIdx === 1 ? 60 : 200;
          anchors.push({
            slotId:   `table-row-${rowIdx + 1}-col-${colIdx + 1}`,
            selector: sel,
            maxChars: Math.max(baseMax, Math.round(text.length * 2)),
            optional: false,
          });
        }
      });
    });
  }

  return anchors;
}

/* ─── CSS selector builder ───────────────────────────────────────── */

/**
 * Build a unique CSS selector from target el up to (but not including) root.
 * Uses tag + nth-child for each level.
 */
function buildSelector(target: Element, root: Element): string | null {
  const parts: string[] = [];
  let current: Element | null = target;

  while (current && current !== root) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parent as Element | null;
    if (!parent || parent === root || parent.tagName === undefined) {
      // Direct child of root; use class-based selector where possible
      const cls = primaryClass(current);
      parts.unshift(cls ? `${tag}.${cls}` : tag);
      break;
    }

    // Find nth-child index among same-tag siblings
    const siblings = (parent.children ?? []).filter(
      (c): c is Element => (c as Element).tagName !== undefined && (c as Element).tagName === current!.tagName
    );
    const pos = siblings.indexOf(current) + 1;
    const cls = primaryClass(current);
    const part = cls
      ? `${tag}.${cls}`
      : siblings.length > 1
        ? `${tag}:nth-child(${siblingIndex(current, parent)})`
        : tag;
    parts.unshift(part);
    current = parent;
  }

  return parts.length ? parts.join(" > ") : null;
}

function siblingIndex(el: Element, parent: Element): number {
  const children = (parent.children ?? []).filter((c): c is Element => (c as Element).tagName !== undefined);
  return children.indexOf(el) + 1;
}

function primaryClass(el: Element): string | null {
  const cls = el.attribs?.class ?? "";
  const classes = cls.split(/\s+/).filter(Boolean);
  // Prefer semantic classes over layout utilities
  const preferred = classes.find((c) => /^(h[1-6]|kicker|footer|pill|card-icon|data-label|data-readout)$/.test(c));
  return preferred ?? classes[0] ?? null;
}

/* ─── Text content helper ────────────────────────────────────────── */

function getTextContent(el: Element): string {
  let text = "";
  for (const child of (el.children ?? []) as ChildNode[]) {
    if ((child as unknown as { type: string }).type === "text") {
      text += ((child as unknown as Text).data ?? "");
    } else if ((child as unknown as Element).tagName !== undefined) {
      text += getTextContent(child as unknown as Element);
    }
  }
  return text.trim();
}

/* ─── Run ────────────────────────────────────────────────────────── */

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
