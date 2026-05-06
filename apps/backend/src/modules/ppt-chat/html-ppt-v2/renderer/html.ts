export function escapeHtml(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value: string | number | undefined | null): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

export function classes(...values: Array<string | undefined | false | null>): string {
  return values.filter(Boolean).join(" ");
}

export function optionalBlock(value: string | undefined, render: (safeValue: string) => string): string {
  const trimmed = value?.trim();
  return trimmed ? render(escapeHtml(trimmed)) : "";
}

export function renderKicker(value: string | undefined, extraClassName?: string): string {
  return optionalBlock(value, (safe) => `<p class="${classes("kicker", extraClassName)}">${safe}</p>`);
}

export function renderFooter(value: string | undefined, extraClassName?: string): string {
  return optionalBlock(value, (safe) => `<p class="${classes("slide-footer", extraClassName)}">${safe}</p>`);
}

function renderCitationMetadata(className: string, citationKeys: string[] | undefined): string {
  if (!citationKeys?.length) return "";
  const serializedKeys = escapeAttr(citationKeys.join("|"));
  // citationKeys are internal evidence handles. Keep them in DOM metadata for tooling,
  // but never render them as user-visible slide text.
  return `<div class="${className}" data-citation-keys="${serializedKeys}" aria-hidden="true" hidden></div>`;
}

export function renderCitationKeys(citationKeys: string[] | undefined): string {
  return renderCitationMetadata("citation-row", citationKeys);
}

export function renderInlineCitationKeys(citationKeys: string[] | undefined): string {
  return renderCitationMetadata("inline-citation-row", citationKeys);
}
