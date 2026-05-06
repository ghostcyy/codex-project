import type { DeckAsset, DeterministicChartConfig, SlideSlotFillIR } from "../../ir";
import {
  classes,
  escapeAttr,
  escapeHtml,
  optionalBlock,
  renderCitationKeys,
  renderFooter,
  renderInlineCitationKeys,
  renderKicker
} from "../html";
import { donorVocabularyClasses } from "./donor-vocabulary";
import { renderSection } from "./section";
import type { LayoutRenderContext, LayoutRenderer, RenderedSlideSection } from "./types";

type Fill<K extends SlideSlotFillIR["kind"]> = Extract<SlideSlotFillIR, { kind: K }>;

export const CORE_LAYOUT_RENDERER_IDS = [
  "cover",
  "toc",
  "two-column",
  "three-column",
  "kpi-grid",
  "timeline",
  "comparison",
  "bullet-list",
  "process",
  "stat-highlight",
  "section-divider",
  "quote",
  "chart",
  "image-hero",
  "cta"
] as const;

function donorClass(context: LayoutRenderContext | undefined, layoutId: SlideSlotFillIR["kind"], scope: Parameters<typeof donorVocabularyClasses>[2], ...base: Array<string | undefined | false>): string {
  return classes(...base, ...donorVocabularyClasses(context, layoutId, scope));
}

function renderCard(
  card: { title: string; body: string; accent?: string; citationKeys?: string[] },
  index: number,
  context: LayoutRenderContext | undefined,
  layoutId: Extract<SlideSlotFillIR["kind"], "three-column" | "stat-highlight">
): string {
  const accent = card.accent ? ` data-accent="${escapeAttr(card.accent)}"` : "";
  return [
    `<article class="${donorClass(context, layoutId, "card", "card")}" data-card-index="${index + 1}"${accent}>`,
    `<h3 class="${donorClass(context, layoutId, "title", "card-title")}">${escapeHtml(card.title)}</h3>`,
    `<p class="card-body">${escapeHtml(card.body)}</p>`,
    renderInlineCitationKeys(card.citationKeys),
    "</article>"
  ].join("");
}

export const renderCover: LayoutRenderer<Fill<"cover">> = (fill, context) => {
  const meta = fill.meta.length
    ? `<div class="meta-row">${fill.meta.map((item) => `<span class="meta-pill">${escapeHtml(item)}</span>`).join("")}</div>`
    : "";
  const body = [
    `<div class="${donorClass(context, "cover", "shell", "cover-shell")}">`,
    '<div class="cover-mark" aria-hidden="true"></div>',
    `<div class="${donorClass(context, "cover", "copy", "cover-copy")}">`,
    renderKicker(fill.kicker, donorClass(context, "cover", "kicker")),
    `<h1 class="${donorClass(context, "cover", "title", "h1")}">${escapeHtml(fill.title)}</h1>`,
    optionalBlock(fill.subtitle, (safe) => `<p class="lede">${safe}</p>`),
    meta,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    "</div>",
    renderFooter(fill.footer, donorClass(context, "cover", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "cover", title: fill.title, role: "cover", body, context });
};

export const renderToc: LayoutRenderer<Fill<"toc">> = (fill, context) => {
  const items = fill.items.map((item, index) => [
    `<li class="${donorClass(context, "toc", "card", "toc-item")}" data-toc-index="${index + 1}">`,
    `<span class="toc-number">${String(index + 1).padStart(2, "0")}</span>`,
    `<div class="${donorClass(context, "toc", "copy", "toc-copy")}">`,
    `<span class="toc-label">${escapeHtml(item.label)}</span>`,
    optionalBlock(item.description, (safe) => `<span class="toc-description">${safe}</span>`),
    "</div>",
    "</li>"
  ].join("")).join("");

  const body = [
    `<div class="${donorClass(context, "toc", "shell", "toc-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "toc", "kicker")),
    `<h2 class="${donorClass(context, "toc", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    `<ol class="toc-list">${items}</ol>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "toc", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "toc", title: fill.title, role: "toc", body, context });
};

export const renderTwoColumn: LayoutRenderer<Fill<"two-column">> = (fill, context) => {
  const bullets = fill.bullets.length
    ? `<div class="pill-row">${fill.bullets.map((bullet) => `<span class="pill">${escapeHtml(bullet)}</span>`).join("")}</div>`
    : "";
  const body = [
    `<div class="${donorClass(context, "two-column", "shell", "content-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "two-column", "kicker")),
    `<h2 class="${donorClass(context, "two-column", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    '<div class="two-column-grid">',
    `<article class="${donorClass(context, "two-column", "card", "card", "column-card")}">`,
    `<h3 class="${donorClass(context, "two-column", "title", "card-title")}">${escapeHtml(fill.leftTitle)}</h3>`,
    `<p class="card-body">${escapeHtml(fill.leftBody)}</p>`,
    "</article>",
    `<article class="${donorClass(context, "two-column", "card", "card", "column-card")}">`,
    `<h3 class="${donorClass(context, "two-column", "title", "card-title")}">${escapeHtml(fill.rightTitle)}</h3>`,
    `<p class="card-body">${escapeHtml(fill.rightBody)}</p>`,
    "</article>",
    "</div>",
    bullets,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "two-column", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "two-column", title: fill.title, role: "analysis", body, context });
};

export const renderThreeColumn: LayoutRenderer<Fill<"three-column">> = (fill, context) => {
  const body = [
    `<div class="${donorClass(context, "three-column", "shell", "content-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "three-column", "kicker")),
    `<h2 class="${donorClass(context, "three-column", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    `<div class="card-grid card-grid-3">${fill.cards.map((card, index) => renderCard(card, index, context, "three-column")).join("")}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "three-column", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "three-column", title: fill.title, role: "analysis", body, context });
};

export const renderKpiGrid: LayoutRenderer<Fill<"kpi-grid">> = (fill, context) => {
  const metrics = fill.metrics.map((metric, index) => [
    `<article class="${donorClass(context, "kpi-grid", "metric", "metric-card")}" data-metric-index="${index + 1}">`,
    `<div class="metric-value">${escapeHtml(metric.value)}</div>`,
    `<div class="metric-label">${escapeHtml(metric.label)}</div>`,
    optionalBlock(metric.note, (safe) => `<p class="metric-note">${safe}</p>`),
    renderInlineCitationKeys(metric.citationKeys),
    "</article>"
  ].join("")).join("");

  const body = [
    `<div class="${donorClass(context, "kpi-grid", "shell", "content-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "kpi-grid", "kicker")),
    `<h2 class="${donorClass(context, "kpi-grid", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    optionalBlock(fill.summary, (safe) => `<p class="lede">${safe}</p>`),
    `<div class="kpi-grid">${metrics}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "kpi-grid", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "kpi-grid", title: fill.title, role: "data-highlight", body, context });
};

export const renderTimeline: LayoutRenderer<Fill<"timeline">> = (fill, context) => {
  const events = fill.events.map((event, index) => {
    const accent = event.accent ? ` data-accent="${escapeAttr(event.accent)}"` : "";
    return [
      `<article class="${donorClass(context, "timeline", "card", "timeline-event")}" data-event-index="${index + 1}"${accent}>`,
      `<span class="timeline-dot" aria-hidden="true"></span>`,
      optionalBlock(event.date, (safe) => `<span class="timeline-date">${safe}</span>`),
      `<h3 class="${donorClass(context, "timeline", "title", "timeline-title")}">${escapeHtml(event.label)}</h3>`,
      `<p class="timeline-body">${escapeHtml(event.description)}</p>`,
      renderInlineCitationKeys(event.citationKeys),
      "</article>"
    ].join("");
  }).join("");

  const body = [
    `<div class="${donorClass(context, "timeline", "shell", "content-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "timeline", "kicker")),
    `<h2 class="${donorClass(context, "timeline", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    `<div class="timeline">${events}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "timeline", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "timeline", title: fill.title, role: "process", body, context });
};

export const renderComparison: LayoutRenderer<Fill<"comparison">> = (fill, context) => {
  const panel = (side: "left" | "right", card: Fill<"comparison">["left"]) => [
    `<article class="${donorClass(context, "comparison", "panel", "comparison-panel", `comparison-${side}`)}" data-accent="${escapeAttr(card.accent ?? (side === "left" ? "neutral" : "primary"))}">`,
    `<h3 class="${donorClass(context, "comparison", "title", "comparison-title")}">${escapeHtml(card.title)}</h3>`,
    `<p class="comparison-body">${escapeHtml(card.body)}</p>`,
    renderInlineCitationKeys(card.citationKeys),
    "</article>"
  ].join("");

  const body = [
    `<div class="${donorClass(context, "comparison", "shell", "content-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "comparison", "kicker")),
    `<h2 class="${donorClass(context, "comparison", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    '<div class="comparison-grid">',
    panel("left", fill.left),
    panel("right", fill.right),
    "</div>",
    optionalBlock(fill.verdict, (safe) => `<p class="callout">${safe}</p>`),
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "comparison", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "comparison", title: fill.title, role: "comparison", body, context });
};

export const renderChart: LayoutRenderer<Fill<"chart">> = (fill, context) => {
  const asset = context?.assets?.[fill.dataAssetKey];
  const chartConfig = asset?.kind === "chart"
    ? asset.chartConfig
    : fallbackChartConfig(fill.title);
  const chartSvg = renderChartSvg(chartConfig, asset?.kind === "chart" ? asset : undefined, fill.chartType);
  const body = [
    `<div class="${donorClass(context, "chart", "shell", "content-shell", "chart-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "chart", "kicker")),
    `<div class="chart-layout">`,
    `<div class="${donorClass(context, "chart", "copy", "chart-copy")}">`,
    `<h2 class="${donorClass(context, "chart", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    `<p class="lede">${escapeHtml(fill.insight)}</p>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    `<figure class="${donorClass(context, "chart", "visual", "chart-figure")}" data-chart-type="${escapeAttr(fill.chartType)}" data-asset-key="${escapeAttr(fill.dataAssetKey)}">`,
    chartSvg,
    `<figcaption class="chart-caption">${escapeHtml(chartConfig.summary ?? `Chart asset ${fill.dataAssetKey}`)}</figcaption>`,
    "</figure>",
    "</div>",
    "</div>",
    renderFooter(fill.footer, donorClass(context, "chart", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "chart", title: fill.title, role: "data-highlight", body, context });
};

export const renderBulletList: LayoutRenderer<Fill<"bullet-list">> = (fill, context) => {
  const groups = fill.groups.map((group, index) => [
    `<article class="${donorClass(context, "bullet-list", "card", "bullet-group")}" data-group-index="${index + 1}"${group.accent ? ` data-accent="${escapeAttr(group.accent)}"` : ""}>`,
    `<h3 class="${donorClass(context, "bullet-list", "title", "bullet-group-title")}">${escapeHtml(group.title)}</h3>`,
    '<ul class="bullet-items">',
    ...group.items.map((item) => `<li class="bullet-item">${escapeHtml(item)}</li>`),
    "</ul>",
    renderInlineCitationKeys(group.citationKeys),
    "</article>"
  ].join("")).join("");
  const body = [
    `<div class="${donorClass(context, "bullet-list", "shell", "content-shell", "bullet-list-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "bullet-list", "kicker")),
    `<h2 class="${donorClass(context, "bullet-list", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    optionalBlock(fill.lede, (safe) => `<p class="lede">${safe}</p>`),
    `<div class="bullet-group-grid">${groups}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "bullet-list", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "bullet-list", title: fill.title, role: "analysis", body, context });
};

export const renderProcess: LayoutRenderer<Fill<"process">> = (fill, context) => {
  const steps = fill.steps.map((step, index) => [
    `<article class="${donorClass(context, "process", "card", "process-step")}" data-step-index="${index + 1}"${step.accent ? ` data-accent="${escapeAttr(step.accent)}"` : ""}>`,
    `<span class="process-step-number">${escapeHtml(step.label || String(index + 1).padStart(2, "0"))}</span>`,
    '<div class="process-step-copy">',
    `<h3 class="${donorClass(context, "process", "title", "process-step-title")}">${escapeHtml(step.title)}</h3>`,
    `<p class="process-step-body">${escapeHtml(step.description)}</p>`,
    renderInlineCitationKeys(step.citationKeys),
    "</div>",
    "</article>"
  ].join("")).join("");
  const body = [
    `<div class="${donorClass(context, "process", "shell", "content-shell", "process-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "process", "kicker")),
    `<h2 class="${donorClass(context, "process", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    optionalBlock(fill.lede, (safe) => `<p class="lede">${safe}</p>`),
    `<div class="process-flow">${steps}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "process", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "process", title: fill.title, role: "process", body, context });
};

export const renderImageHero: LayoutRenderer<Fill<"image-hero">> = (fill, context) => {
  const asset = fill.imageAssetKey ? context?.assets?.[fill.imageAssetKey] : undefined;
  const visual = (asset?.kind === "photo" || asset?.kind === "illustration") && asset.src
    ? `<img class="image-hero-img" src="${escapeAttr(asset.src)}" alt="${escapeAttr(fill.imageAlt ?? asset.alt ?? fill.title)}">`
    : [
        '<div class="image-hero-placeholder" role="img" aria-label="Deterministic visual placeholder">',
        '<span class="image-hero-orb image-hero-orb-primary" aria-hidden="true"></span>',
        '<span class="image-hero-orb image-hero-orb-secondary" aria-hidden="true"></span>',
        `<span class="image-hero-label">${escapeHtml(fill.visualLabel ?? "VISUAL")}</span>`,
        "</div>"
      ].join("");
  const chips = fill.chips.length
    ? `<div class="image-hero-chip-row">${fill.chips.map((chip) => `<span class="image-hero-chip">${escapeHtml(chip)}</span>`).join("")}</div>`
    : "";
  const body = [
    `<div class="${donorClass(context, "image-hero", "shell", "image-hero-shell")}">`,
    `<figure class="${donorClass(context, "image-hero", "visual", "image-hero-visual")}">${visual}</figure>`,
    `<div class="${donorClass(context, "image-hero", "copy", "image-hero-copy")}">`,
    renderKicker(fill.kicker, donorClass(context, "image-hero", "kicker")),
    `<h2 class="${donorClass(context, "image-hero", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    optionalBlock(fill.lede, (safe) => `<p class="lede">${safe}</p>`),
    `<p class="image-hero-body">${escapeHtml(fill.body)}</p>`,
    chips,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    "</div>",
    renderFooter(fill.footer, donorClass(context, "image-hero", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "image-hero", title: fill.title, role: "case-study", body, context });
};

export const renderQuote: LayoutRenderer<Fill<"quote">> = (fill, context) => {
  const body = [
    `<div class="${donorClass(context, "quote", "shell", "quote-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "quote", "kicker")),
    '<figure class="quote-figure">',
    '<div class="quote-mark" aria-hidden="true">“</div>',
    `<blockquote class="${donorClass(context, "quote", "title", "quote-text")}">${escapeHtml(fill.quote)}</blockquote>`,
    optionalBlock(fill.attribution, (safe) => `<figcaption class="quote-attribution">${safe}</figcaption>`),
    "</figure>",
    optionalBlock(fill.supportingText, (safe) => `<p class="quote-support">${safe}</p>`),
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "quote", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "quote", title: fill.title, role: "synthesis", body, context });
};

export const renderSectionDivider: LayoutRenderer<Fill<"section-divider">> = (fill, context) => {
  const body = [
    `<div class="${donorClass(context, "section-divider", "shell", "section-divider-shell")}">`,
    '<div class="section-divider-rule" aria-hidden="true"></div>',
    `<div class="${donorClass(context, "section-divider", "copy", "section-divider-copy")}">`,
    renderKicker(fill.kicker, donorClass(context, "section-divider", "kicker")),
    `<div class="section-marker">${escapeHtml(fill.marker)}</div>`,
    `<h2 class="${donorClass(context, "section-divider", "title", "h2", "section-title")}">${escapeHtml(fill.title)}</h2>`,
    optionalBlock(fill.supportingText, (safe) => `<p class="section-support">${safe}</p>`),
    optionalBlock(fill.progressText, (safe) => `<span class="section-progress">${safe}</span>`),
    renderCitationKeys(fill.citationKeys),
    "</div>",
    "</div>",
    renderFooter(fill.footer, donorClass(context, "section-divider", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "section-divider", title: fill.title, role: "transition-divider", body, context });
};

export const renderStatHighlight: LayoutRenderer<Fill<"stat-highlight">> = (fill, context) => {
  const cards = fill.cards.length
    ? `<div class="stat-card-grid">${fill.cards.map((card, index) => [
        `<article class="${donorClass(context, "stat-highlight", "card", "stat-card")}" data-card-index="${index + 1}"${card.accent ? ` data-accent="${escapeAttr(card.accent)}"` : ""}>`,
        `<h3 class="${donorClass(context, "stat-highlight", "title", "stat-card-title")}">${escapeHtml(card.title)}</h3>`,
        `<p class="stat-card-body">${escapeHtml(card.body)}</p>`,
        renderInlineCitationKeys(card.citationKeys),
        "</article>"
      ].join("")).join("")}</div>`
    : "";
  const body = [
    `<div class="${donorClass(context, "stat-highlight", "shell", "stat-highlight-shell")}">`,
    `<div class="${donorClass(context, "stat-highlight", "copy", "stat-copy")}">`,
    renderKicker(fill.kicker, donorClass(context, "stat-highlight", "kicker")),
    `<h2 class="${donorClass(context, "stat-highlight", "title", "h2")}">${escapeHtml(fill.title)}</h2>`,
    `<div class="stat-value">${escapeHtml(fill.value)}</div>`,
    `<div class="stat-label">${escapeHtml(fill.label)}</div>`,
    `<p class="stat-explanation">${escapeHtml(fill.explanation)}</p>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    cards,
    "</div>",
    renderFooter(fill.footer, donorClass(context, "stat-highlight", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "stat-highlight", title: fill.title, role: "data-highlight", body, context });
};

export const renderCta: LayoutRenderer<Fill<"cta">> = (fill, context) => {
  const body = [
    `<div class="${donorClass(context, "cta", "shell", "cta-shell")}">`,
    renderKicker(fill.kicker, donorClass(context, "cta", "kicker")),
    `<h2 class="${donorClass(context, "cta", "title", "h2")}">${escapeHtml(fill.headline)}</h2>`,
    optionalBlock(fill.supportingText, (safe) => `<p class="lede">${safe}</p>`),
    `<div class="${donorClass(context, "cta", "cta", "cta-action")}">${escapeHtml(fill.action)}</div>`,
    renderCitationKeys(fill.citationKeys),
    "</div>",
    renderFooter(fill.footer, donorClass(context, "cta", "footer"))
  ].join("");

  return renderSection({ slideIndex: fill.slideIndex, layoutId: "cta", title: fill.title, role: "cta", body, context });
};

export const coreLayoutRenderers = {
  cover: renderCover,
  toc: renderToc,
  "two-column": renderTwoColumn,
  "three-column": renderThreeColumn,
  "kpi-grid": renderKpiGrid,
  timeline: renderTimeline,
  comparison: renderComparison,
  "bullet-list": renderBulletList,
  process: renderProcess,
  "stat-highlight": renderStatHighlight,
  "section-divider": renderSectionDivider,
  quote: renderQuote,
  chart: renderChart,
  "image-hero": renderImageHero,
  cta: renderCta
};

export function renderCoreLayout(fill: SlideSlotFillIR, context?: LayoutRenderContext): RenderedSlideSection {
  switch (fill.kind) {
    case "cover":
      return renderCover(fill, context);
    case "toc":
      return renderToc(fill, context);
    case "two-column":
      return renderTwoColumn(fill, context);
    case "three-column":
      return renderThreeColumn(fill, context);
    case "kpi-grid":
      return renderKpiGrid(fill, context);
    case "timeline":
      return renderTimeline(fill, context);
    case "comparison":
      return renderComparison(fill, context);
    case "bullet-list":
      return renderBulletList(fill, context);
    case "process":
      return renderProcess(fill, context);
    case "stat-highlight":
      return renderStatHighlight(fill, context);
    case "section-divider":
      return renderSectionDivider(fill, context);
    case "quote":
      return renderQuote(fill, context);
    case "chart":
      return renderChart(fill, context);
    case "image-hero":
      return renderImageHero(fill, context);
    case "cta":
      return renderCta(fill, context);
    default:
      throw new Error("No deterministic core layout renderer registered for unsupported slot fill.");
  }
}

function fallbackChartConfig(title: string): DeterministicChartConfig {
  return {
    title,
    labels: ["Signal 1", "Signal 2", "Signal 3"],
    series: [{ label: title, data: [1, 2, 3], color: "var(--accent)" }],
    summary: "Fallback deterministic chart rendered without external data."
  };
}

function renderChartSvg(config: DeterministicChartConfig, asset: Extract<DeckAsset, { kind: "chart" }> | undefined, chartType: Fill<"chart">["chartType"]): string {
  const labels = config.labels.slice(0, 8);
  const values = config.series[0]?.data.slice(0, labels.length) ?? [];
  if (chartType === "pie" || chartType === "doughnut" || chartType === "radar") {
    return renderRadialChartSvg(labels, values, chartType, asset?.chartType ?? chartType);
  }
  return renderCartesianChartSvg(labels, values, chartType, config.series[0]?.color);
}

function renderCartesianChartSvg(labels: string[], values: number[], chartType: Fill<"chart">["chartType"], color: string | undefined): string {
  const width = 640;
  const height = 360;
  const padding = { left: 54, right: 28, top: 34, bottom: 72 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...values.map((value) => Math.abs(value)));
  const colorValue = sanitizeSvgPaint(color);
  const points = values.map((value, index) => {
    const x = padding.left + (labels.length <= 1 ? chartWidth / 2 : (chartWidth / (labels.length - 1)) * index);
    const y = padding.top + chartHeight - (Math.max(0, value) / max) * chartHeight;
    return { x, y, value };
  });
  const bars = points.map((point, index) => {
    const slot = chartWidth / Math.max(1, labels.length);
    const barWidth = Math.max(22, Math.min(58, slot * 0.58));
    const barHeight = padding.top + chartHeight - point.y;
    const x = padding.left + slot * index + (slot - barWidth) / 2;
    return [
      `<rect class="chart-bar" x="${x.toFixed(1)}" y="${point.y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="10"></rect>`,
      `<text class="chart-value" x="${(x + barWidth / 2).toFixed(1)}" y="${Math.max(18, point.y - 10).toFixed(1)}" text-anchor="middle">${escapeHtml(formatChartValue(point.value))}</text>`,
      `<text class="chart-label" x="${(x + barWidth / 2).toFixed(1)}" y="${height - 34}" text-anchor="middle">${escapeHtml(shortChartLabel(labels[index] ?? ""))}</text>`
    ].join("");
  }).join("");
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const dots = points.map((point, index) => [
    `<circle class="chart-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6"></circle>`,
    `<text class="chart-value" x="${point.x.toFixed(1)}" y="${Math.max(18, point.y - 12).toFixed(1)}" text-anchor="middle">${escapeHtml(formatChartValue(point.value))}</text>`,
    `<text class="chart-label" x="${point.x.toFixed(1)}" y="${height - 34}" text-anchor="middle">${escapeHtml(shortChartLabel(labels[index] ?? ""))}</text>`
  ].join("")).join("");
  const areaPath = linePath ? `${linePath} L ${points.at(-1)?.x.toFixed(1) ?? padding.left} ${padding.top + chartHeight} L ${points[0]?.x.toFixed(1) ?? padding.left} ${padding.top + chartHeight} Z` : "";

  return [
    `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Deterministic ${escapeAttr(chartType)} chart" data-chart-color="${escapeAttr(colorValue)}">`,
    `<line class="chart-axis" x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}"></line>`,
    chartType === "bar"
      ? bars
      : [
          chartType === "area" && areaPath ? `<path class="chart-area" d="${areaPath}"></path>` : "",
          linePath ? `<path class="chart-line" d="${linePath}"></path>` : "",
          dots
        ].join(""),
    "</svg>"
  ].join("");
}

function renderRadialChartSvg(labels: string[], values: number[], chartType: Fill<"chart">["chartType"], assetType: Fill<"chart">["chartType"]): string {
  const width = 640;
  const height = 360;
  const cx = 320;
  const cy = 172;
  const radius = 112;
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  let angle = -90;
  const slices = values.map((value, index) => {
    const portion = Math.max(0, value) / total;
    const sweep = portion * 360;
    const path = describeArc(cx, cy, radius, angle, angle + sweep);
    const labelAngle = angle + sweep / 2;
    const label = polarPoint(cx, cy, radius + 48, labelAngle);
    angle += sweep;
    return [
      `<path class="chart-slice chart-slice-${(index % 6) + 1}" d="${path}"></path>`,
      `<text class="chart-label" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="middle">${escapeHtml(shortChartLabel(labels[index] ?? ""))}</text>`
    ].join("");
  }).join("");
  const radar = values.map((value, index) => {
    const point = polarPoint(cx, cy, radius * (Math.max(0, value) / Math.max(1, ...values)), -90 + (360 / Math.max(1, values.length)) * index);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" ");

  return [
    `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Deterministic ${escapeAttr(assetType)} chart">`,
    chartType === "radar"
      ? `<polygon class="chart-radar" points="${radar}"></polygon>${labels.map((label, index) => {
          const point = polarPoint(cx, cy, radius + 42, -90 + (360 / Math.max(1, labels.length)) * index);
          return `<text class="chart-label" x="${point.x.toFixed(1)}" y="${point.y.toFixed(1)}" text-anchor="middle">${escapeHtml(shortChartLabel(label))}</text>`;
        }).join("")}`
      : `${slices}${chartType === "doughnut" ? `<circle class="chart-hole" cx="${cx}" cy="${cy}" r="58"></circle>` : ""}`,
    "</svg>"
  ].join("");
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polarPoint(cx, cy, radius, endAngle);
  const end = polarPoint(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${cx} ${cy} L ${start.x.toFixed(1)} ${start.y.toFixed(1)} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x.toFixed(1)} ${end.y.toFixed(1)} Z`;
}

function polarPoint(cx: number, cy: number, radius: number, angleDegrees: number) {
  const angle = (angleDegrees - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle)
  };
}

function sanitizeSvgPaint(value: string | undefined): string {
  const text = value?.trim() || "var(--accent)";
  return /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%/\s-]+\)|hsla?\([0-9.,%/\s-]+\)|oklch\([0-9.,%/\s-]+\)|var\(--[a-z0-9-]+\)|[a-z]+)$/i.test(text)
    ? text
    : "var(--accent)";
}

function shortChartLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 14 ? `${trimmed.slice(0, 13)}…` : trimmed;
}

function formatChartValue(value: number): string {
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
