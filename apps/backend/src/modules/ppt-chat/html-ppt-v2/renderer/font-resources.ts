import type { DeckIR } from "../ir";
import { escapeAttr } from "./html";

type FontCatalogEntry = {
  family: string;
  weights: string;
};

const FONT_CATALOG: Record<string, FontCatalogEntry> = {
  "Fraunces": { family: "Fraunces", weights: "600;700;800;900" },
  "Source Serif 4": { family: "Source Serif 4", weights: "400;600;700;800" },
  "Noto Serif SC": { family: "Noto Serif SC", weights: "400;600;700;900" },
  "Noto Sans SC": { family: "Noto Sans SC", weights: "400;500;700;900" },
  "Space Grotesk": { family: "Space Grotesk", weights: "400;500;700" },
  "Sora": { family: "Sora", weights: "400;600;700;800" },
  "Manrope": { family: "Manrope", weights: "400;500;700;800" },
  "IBM Plex Mono": { family: "IBM Plex Mono", weights: "400;600;700" }
};

export function renderFontResourceTags(deck: DeckIR): string {
  const families = collectCatalogFonts([
    deck.design.themeTokens.typography.fontDisplay,
    deck.design.themeTokens.typography.fontBody,
    deck.design.themeTokens.typography.fontMono
  ]);
  if (!families.length) return "";

  const url = buildGoogleFontsCssUrl(families);
  return [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" data-font-provider="google-fonts" href="${escapeAttr(url)}">`
  ].join("\n");
}

function collectCatalogFonts(fontStacks: string[]): FontCatalogEntry[] {
  const names = fontStacks.flatMap(parseFontStack);
  const entries = names.map((name) => FONT_CATALOG[name]).filter((entry): entry is FontCatalogEntry => Boolean(entry));
  return uniqueBy(entries, (entry) => entry.family);
}

function parseFontStack(stack: string): string[] {
  return stack
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function buildGoogleFontsCssUrl(entries: FontCatalogEntry[]): string {
  const families = entries
    .map((entry) => `family=${encodeURIComponent(entry.family).replace(/%20/g, "+")}:wght@${entry.weights}`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
