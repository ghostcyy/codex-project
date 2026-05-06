import type { DonorCatalogItem } from "../registry";

const ALLOWED_DONOR_CSS_PROPERTIES = new Set([
  "align-content",
  "align-items",
  "align-self",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "border-radius",
  "border-bottom",
  "border-left",
  "border-right",
  "border-top",
  "box-shadow",
  "color",
  "column-gap",
  "display",
  "filter",
  "flex",
  "flex-direction",
  "flex-wrap",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "justify-content",
  "justify-items",
  "justify-self",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-height",
  "min-width",
  "outline",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "row-gap",
  "text-decoration",
  "text-shadow",
  "text-transform"
]);

const UNSAFE_VALUE_PATTERN =
  /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|-moz-binding|behavior\s*:|@import\b|<\s*\/?\s*script\b/i;
const UNSAFE_FUNCTION_PATTERN = /\b(?:image-set|cross-fade|element|paint|env)\s*\(/i;
const SAFE_TOKEN_VALUE_PATTERN = /^[a-zA-Z0-9_#.,%+\-*/\s()[\]'":]+$/;
const SAFE_FONT_VALUE_PATTERN = /^[a-zA-Z0-9_\-'",\s]+$/;
const SAFE_CUSTOM_PROPERTY_PATTERN = /^--[a-z0-9-]+$/;

const ENUM_VALUES: Record<string, Set<string>> = {
  "align-content": new Set(["start", "end", "center", "stretch", "space-between", "space-around", "space-evenly", "flex-start", "flex-end", "normal"]),
  "align-items": new Set(["start", "end", "center", "stretch", "baseline", "flex-start", "flex-end", "normal"]),
  "align-self": new Set(["auto", "start", "end", "center", "stretch", "baseline", "flex-start", "flex-end", "normal"]),
  "display": new Set(["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none", "contents"]),
  "flex-direction": new Set(["row", "row-reverse", "column", "column-reverse"]),
  "flex-wrap": new Set(["nowrap", "wrap", "wrap-reverse"]),
  "font-style": new Set(["normal", "italic", "oblique"]),
  "justify-content": new Set(["start", "end", "center", "stretch", "space-between", "space-around", "space-evenly", "flex-start", "flex-end", "normal"]),
  "justify-items": new Set(["start", "end", "center", "stretch", "baseline", "normal"]),
  "justify-self": new Set(["auto", "start", "end", "center", "stretch", "baseline", "normal"]),
  "text-decoration": new Set(["none", "underline", "overline", "line-through"]),
  "text-transform": new Set(["none", "uppercase", "lowercase", "capitalize"])
};

const COLOR_PROPERTIES = new Set([
  "background-color",
  "border-color",
  "color"
]);

const BACKGROUND_PROPERTIES = new Set([
  "background",
  "background-image"
]);

const SHADOW_PROPERTIES = new Set([
  "box-shadow",
  "text-shadow"
]);

const SPACING_OR_SIZE_PROPERTIES = new Set([
  "border",
  "border-radius",
  "border-bottom",
  "border-left",
  "border-right",
  "border-top",
  "column-gap",
  "flex",
  "font-size",
  "font-weight",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-height",
  "min-width",
  "outline",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "row-gap"
]);

export function sanitizeAndScopeDonorCss(donor: DonorCatalogItem, scopeSelector: string): string {
  const blockedClasses = new Set([
    ...donor.contract.cssRedactClasses,
    ...donor.contract.forbiddenClasses
  ]);
  const forbiddenText = [...donor.contract.forbiddenTextPatterns, ...donor.contract.forbiddenTextExamples]
    .map((value) => value.trim())
    .filter(Boolean);
  const css = stripUnsupportedAtRules(donor.css);
  const rules: string[] = [];

  for (const match of css.matchAll(/([^{}]+){([^{}]*)}/g)) {
    const selectorText = match[1]?.trim();
    const body = match[2]?.trim();
    if (!selectorText || !body || selectorText.startsWith("@")) {
      continue;
    }
    if (forbiddenText.some((text) => body.includes(text))) {
      continue;
    }

    const selectors = selectorText
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => selector && !selectorContainsBlockedClass(selector, blockedClasses))
      .map((selector) => scopeDonorSelector(selector, scopeSelector, donor.deckClass))
      .filter(Boolean);
    if (!selectors.length) {
      continue;
    }

    const declarations = body
      .split(";")
      .map((declaration) => sanitizeDeclaration(declaration))
      .filter((declaration): declaration is string => Boolean(declaration));
    if (!declarations.length) {
      continue;
    }

    rules.push(`${selectors.join(", ")} { ${declarations.join("; ")}; }`);
  }

  return rules.length ? `/* Sanitized real donor CSS from ${donor.id}. */\n${rules.join("\n")}` : "";
}

function stripUnsupportedAtRules(input: string): string {
  let css = input
    .replace(/@import\b[^;]+;/gi, "")
    .replace(/@font-face\s*{[\s\S]*?}/gi, "")
    .replace(/@keyframes\s+[^{]+{[\s\S]*?}\s*}/gi, "")
    .replace(/@media\s+[^{]+{[\s\S]*?}\s*}/gi, "");

  let previous = "";
  while (previous !== css) {
    previous = css;
    css = css.replace(/@(?!charset\b)[a-z-]+\b[^{};]*(?:{[^{}]*}|;)/gi, "");
  }
  return css;
}

function sanitizeDeclaration(declaration: string): string | null {
  const separator = declaration.indexOf(":");
  if (separator <= 0) return null;

  const property = declaration.slice(0, separator).trim().toLowerCase();
  const value = declaration.slice(separator + 1).trim();
  if (!property || !value || property === "behavior") return null;
  if (property.startsWith("--")) {
    return isSafeCustomProperty(property, value) ? `${property}: ${value}` : null;
  }
  if (!ALLOWED_DONOR_CSS_PROPERTIES.has(property)) return null;
  if (!isSafeCssValue(property, value)) return null;
  return `${property}: ${value}`;
}

function isSafeCustomProperty(property: string, value: string): boolean {
  if (!SAFE_CUSTOM_PROPERTY_PATTERN.test(property)) return false;
  if (value.length > 240 || hasUnsafeValue(value)) return false;
  if (!SAFE_TOKEN_VALUE_PATTERN.test(value)) return false;
  return isSafeGradientOrTokenValue(value) || isSafeShadowValue(value);
}

function isSafeCssValue(property: string, value: string): boolean {
  if (value.length > 500 || hasUnsafeValue(value)) return false;
  if (!SAFE_TOKEN_VALUE_PATTERN.test(value)) return false;

  const enumValues = ENUM_VALUES[property];
  if (enumValues) {
    return enumValues.has(value.toLowerCase());
  }
  if (COLOR_PROPERTIES.has(property)) {
    return isSafeColorValue(value);
  }
  if (BACKGROUND_PROPERTIES.has(property)) {
    return isSafeGradientOrTokenValue(value);
  }
  if (SHADOW_PROPERTIES.has(property)) {
    return isSafeShadowValue(value);
  }
  if (property === "filter") {
    return isSafeFilterValue(value);
  }
  if (property === "font-family") {
    return value.length <= 180 && SAFE_FONT_VALUE_PATTERN.test(value);
  }
  if (SPACING_OR_SIZE_PROPERTIES.has(property)) {
    return isSafeSizingValue(value);
  }
  return false;
}

function hasUnsafeValue(value: string): boolean {
  return UNSAFE_VALUE_PATTERN.test(value) || UNSAFE_FUNCTION_PATTERN.test(value);
}

function isSafeColorValue(value: string): boolean {
  const text = value.trim();
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([^;{}]+\)|var\(--[a-z0-9-]+\)|transparent|currentColor|black|white)$/i.test(text);
}

function isSafeGradientOrTokenValue(value: string): boolean {
  const text = value.trim();
  if (/^(?:none|transparent|currentColor|black|white)$/i.test(text)) return true;
  if (isSafeColorValue(text)) return true;
  if (/^var\(--[a-z0-9-]+\)$/i.test(text)) return true;
  if (/^(?:linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient)\([^;{}]+\)$/i.test(text)) {
    return !hasUnsafeValue(text);
  }
  return false;
}

function isSafeShadowValue(value: string): boolean {
  const text = value.trim();
  if (/^(?:none|var\(--[a-z0-9-]+\))$/i.test(text)) return true;
  return /^(?:inset\s+)?[-0-9.a-zA-Z%()\s,#]+$/.test(text) && !hasUnsafeValue(text);
}

function isSafeFilterValue(value: string): boolean {
  const text = value.trim();
  if (/^(?:none|var\(--[a-z0-9-]+\))$/i.test(text)) return true;
  const parts = text.match(/[a-z-]+\([^)]*\)/gi) ?? [];
  if (!parts.length || parts.join(" ") !== text) return false;
  return parts.every((part) => /^(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia|drop-shadow)\([-0-9.a-zA-Z%()\s,#]+\)$/i.test(part));
}

function isSafeSizingValue(value: string): boolean {
  const text = value.trim();
  return /^(?:auto|none|0|[-0-9.a-zA-Z%(),\s*/+]+|var\(--[a-z0-9-]+\))$/i.test(text);
}

function selectorContainsBlockedClass(selector: string, blockedClasses: Set<string>): boolean {
  for (const className of blockedClasses) {
    if (new RegExp(`\\.${escapeRegExp(className)}(?![a-zA-Z0-9_-])`).test(selector)) {
      return true;
    }
  }
  return false;
}

function scopeDonorSelector(selector: string, scopeSelector: string, donorDeckClass?: string): string {
  const normalized = selector.trim();
  if (!normalized || normalized.includes(":host")) {
    return "";
  }
  if (normalized === ":root" || normalized === "html" || normalized === "body") {
    return scopeSelector;
  }
  if (donorDeckClass) {
    const donorRootPattern = new RegExp(`^\\.${escapeRegExp(donorDeckClass)}(?=$|[\\s.#:[>+~])`);
    if (donorRootPattern.test(normalized)) {
      return normalized.replace(donorRootPattern, scopeSelector);
    }
  }
  if (normalized.startsWith("body")) {
    return normalized.replace(/^body(?:\.[a-zA-Z0-9_-]+)*/, scopeSelector);
  }
  if (normalized.startsWith("html ")) {
    return `${scopeSelector} ${normalized.slice(5).trim()}`;
  }
  return `${scopeSelector} ${normalized}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
