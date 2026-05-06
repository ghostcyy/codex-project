import type { DeckIR } from "../ir";
import { renderFontResourceTags } from "./font-resources";
import { escapeAttr, escapeHtml } from "./html";

export function renderDeckHtmlDocument(input: {
  deck: DeckIR;
  sectionsHtml: string;
  styleHref?: string;
  scriptSrc?: string;
  inlineCss?: string;
  inlineScript?: string;
}): string {
  const { deck } = input;
  const donorDna = deck.design.donorContract.dnaSignature;
  const title = deck.narrative.slides[0]?.contentBrief.headline ?? deck.intent.topic;
  const styleTag = input.inlineCss
    ? `<style>${input.inlineCss}</style>`
    : `<link rel="stylesheet" href="${escapeAttr(input.styleHref ?? "style.css")}">`;
  const fontTags = renderFontResourceTags(deck);
  const scriptTag = input.inlineScript
    ? `<script>${input.inlineScript}</script>`
    : `<script src="${escapeAttr(input.scriptSrc ?? "assets/runtime-v2.js")}" defer></script>`;

  return [
    "<!doctype html>",
    `<html lang="${escapeAttr(deck.intent.language)}" data-html-ppt-version="v2" data-theme="${escapeAttr(deck.design.themeId)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    fontTags,
    styleTag,
    "</head>",
    `<body class="${escapeAttr(deck.design.deckClass)}" data-donor="${escapeAttr(deck.design.donorTemplateId)}" data-dna-density="${escapeAttr(donorDna.density)}" data-dna-title-treatment="${escapeAttr(donorDna.titleTreatment)}" data-dna-card-treatment="${escapeAttr(donorDna.cardTreatment)}" data-dna-kicker-treatment="${escapeAttr(donorDna.kickerTreatment)}" data-dna-accent-rule="${escapeAttr(donorDna.accentRule)}">`,
    '<main class="deck-viewport">',
    `<div class="deck" data-slide-count="${deck.intent.derivedSlideCount}" aria-label="${escapeAttr(title)}">`,
    '<div class="deck-status" aria-live="polite"></div>',
    input.sectionsHtml,
    '<div class="deck-progress" aria-hidden="true"><span class="deck-progress-bar"></span></div>',
    "</div>",
    "</main>",
    scriptTag,
    "</body>",
    "</html>"
  ].join("\n");
}
