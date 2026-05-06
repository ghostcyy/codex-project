import {
  cssColorTokenSchema,
  cssEasingTokenSchema,
  cssFontFamilyTokenSchema,
  cssShadowTokenSchema,
  type DeckIR,
  type DonorId
} from "../ir";
import type { SkillRegistry } from "../registry";
import { resolveDonorDnaFamilies } from "./layout-renderers";
import { sanitizeAndScopeDonorCss } from "./donor-css-sanitizer";
import { composeTemplateRenderProfileCss } from "./template-render-profiles";

function cssVarName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function cssStringLiteral(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function composeDeckStyleCss(deck: DeckIR, registry?: SkillRegistry): string {
  const { palette, typography, geometry, elevation, motion } = sanitizeThemeTokens(deck);
  const tokenCss = [
    ...Object.entries(palette).map(([key, value]) => `  --${cssVarName(key)}: ${value};`),
    `  --font-display: ${typography.fontDisplay};`,
    `  --font-body: ${typography.fontBody};`,
    `  --font-mono: ${typography.fontMono};`,
    `  --scale-ratio: ${typography.scaleRatio};`,
    `  --base-size: ${typography.baseSize}px;`,
    `  --radius-sm: ${geometry.radiusSm}px;`,
    `  --radius-md: ${geometry.radiusMd}px;`,
    `  --radius-lg: ${geometry.radiusLg}px;`,
    `  --gap-sm: ${geometry.gapSm}px;`,
    `  --gap-md: ${geometry.gapMd}px;`,
    `  --gap-lg: ${geometry.gapLg}px;`,
    `  --shadow-sm: ${elevation.shadowSm};`,
    `  --shadow-md: ${elevation.shadowMd};`,
    `  --shadow-lg: ${elevation.shadowLg};`,
    `  --ease: ${motion.easing};`,
    `  --duration-fast: ${motion.durationFast}ms;`,
    `  --duration-base: ${motion.durationBase}ms;`,
    `  --duration-slow: ${motion.durationSlow}ms;`
  ].join("\n");

  return [
    "/* HTML-PPT v2 deterministic stylesheet. No model-authored CSS. */",
    ":root {",
    tokenCss,
    "}",
    "",
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text1); }",
    `body.${deck.design.deckClass} { font-family: var(--font-body), sans-serif; overflow: hidden; }`,
    ".deck-viewport { width: 100vw; height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 15% 15%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 34%), var(--bg); }",
    ".deck { position: relative; width: min(100vw, calc(100vh * 16 / 9)); aspect-ratio: 16 / 9; overflow: hidden; background: var(--bg); border: 1px solid var(--border); box-shadow: var(--shadow-lg); }",
    ".slide { position: absolute; inset: 0; width: 100%; height: 100%; padding: 64px 76px; opacity: 0; pointer-events: none; transform: translateY(10px); transition: opacity var(--duration-base) var(--ease), transform var(--duration-base) var(--ease); overflow: hidden; }",
    ".slide.is-active { opacity: 1; pointer-events: auto; transform: translateY(0); }",
    ".slide.anim-fade-up { transform: translateY(18px); }",
    ".slide.anim-rise-in { transform: translateY(30px) scale(.985); }",
    ".slide.anim-zoom-pop { transform: scale(.965); }",
    ".slide.anim-scale-in { transform: scale(.975); }",
    ".slide.anim-stagger-list { transform: translateY(14px); }",
    ".slide.is-active.anim-fade-up, .slide.is-active.anim-rise-in, .slide.is-active.anim-zoom-pop, .slide.is-active.anim-scale-in, .slide.is-active.anim-stagger-list { transform: translateY(0) scale(1); }",
    ".slide[data-build-targets~='card'] .card, .slide[data-build-targets~='toc-item'] .toc-item, .slide[data-build-targets~='metric-card'] .metric-card, .slide[data-build-targets~='timeline-event'] .timeline-event, .slide[data-build-targets~='comparison-panel'] .comparison-panel, .slide[data-build-targets~='chart-figure'] .chart-figure { opacity: 0; transform: translateY(14px); transition: opacity var(--duration-base) var(--ease), transform var(--duration-base) var(--ease); }",
    ".slide.is-active[data-build-targets~='card'] .card, .slide.is-active[data-build-targets~='toc-item'] .toc-item, .slide.is-active[data-build-targets~='metric-card'] .metric-card, .slide.is-active[data-build-targets~='timeline-event'] .timeline-event, .slide.is-active[data-build-targets~='comparison-panel'] .comparison-panel, .slide.is-active[data-build-targets~='chart-figure'] .chart-figure { opacity: 1; transform: translateY(0); }",
    ".slide.is-active[data-build-targets~='card'] .card:nth-of-type(2), .slide.is-active[data-build-targets~='toc-item'] .toc-item:nth-child(2), .slide.is-active[data-build-targets~='metric-card'] .metric-card:nth-child(2), .slide.is-active[data-build-targets~='timeline-event'] .timeline-event:nth-child(2), .slide.is-active[data-build-targets~='comparison-panel'] .comparison-panel:nth-child(2) { transition-delay: 80ms; }",
    ".slide.is-active[data-build-targets~='card'] .card:nth-of-type(3), .slide.is-active[data-build-targets~='toc-item'] .toc-item:nth-child(3), .slide.is-active[data-build-targets~='metric-card'] .metric-card:nth-child(3), .slide.is-active[data-build-targets~='timeline-event'] .timeline-event:nth-child(3) { transition-delay: 160ms; }",
    ".slide.is-active[data-build-targets~='toc-item'] .toc-item:nth-child(4), .slide.is-active[data-build-targets~='timeline-event'] .timeline-event:nth-child(4) { transition-delay: 240ms; }",
    ".slide.is-active[data-fx='soft-glow']::before { content: ''; position: absolute; inset: -20%; z-index: 0; pointer-events: none; background: radial-gradient(circle at 18% 20%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 32%), radial-gradient(circle at 84% 72%, color-mix(in srgb, var(--accent2) 16%, transparent), transparent 34%); filter: blur(2px); }",
    ".slide.is-active[data-fx='grid-lines']::before { content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: .16; background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px); background-size: 46px 46px; }",
    ".slide.is-active[data-fx='spotlight']::before { content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none; background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 42%); }",
    ".slide.is-active[data-fx='particles-subtle']::before { content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: .22; background-image: radial-gradient(circle, var(--accent) 1.4px, transparent 1.6px); background-size: 34px 34px; }",
    ".content-shell, .cover-shell, .toc-shell, .cta-shell { position: relative; z-index: 1; height: 100%; display: flex; flex-direction: column; }",
    ".cover-shell, .cta-shell { justify-content: center; }",
    ".cover-copy { max-width: 820px; }",
    ".cover-mark { position: absolute; right: -60px; top: -60px; width: 440px; height: 440px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 16%, transparent); filter: blur(4px); }",
    ".kicker { margin: 0 0 16px; color: var(--accent); font: 800 13px/1 var(--font-mono), monospace; letter-spacing: .14em; text-transform: uppercase; }",
    ".h1, .h2 { margin: 0; font-family: var(--font-display), var(--font-body), sans-serif; line-height: .95; letter-spacing: -.04em; color: var(--text1); }",
    ".h1 { max-width: 900px; font-size: clamp(58px, 7.4vw, 108px); }",
    ".h2 { max-width: 980px; font-size: clamp(40px, 4.6vw, 72px); }",
    ".lede { max-width: 780px; margin: 22px 0 0; color: var(--text2); font-size: 24px; line-height: 1.35; }",
    ".meta-row, .pill-row, .citation-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }",
    ".inline-citation-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; opacity: .72; }",
    ".meta-pill, .pill, .citation-key { border: 1px solid var(--border); border-radius: 999px; padding: 8px 12px; background: var(--surface); color: var(--text2); font-size: 13px; }",
    ".inline-citation-row .citation-key { padding: 5px 8px; font-size: 11px; background: color-mix(in srgb, var(--surface) 80%, var(--accent) 5%); }",
    ".citation-row { position: absolute; left: 0; bottom: 0; margin: 0; opacity: .72; }",
    ".slide-footer { position: absolute; right: 76px; bottom: 44px; margin: 0; color: var(--text2); font-size: 13px; }",
    ".toc-list { list-style: none; display: grid; gap: 14px; margin: 36px 0 0; padding: 0; max-width: 900px; }",
    ".toc-item { display: grid; grid-template-columns: 72px 1fr; gap: 18px; align-items: center; padding: 20px 22px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }",
    ".toc-number { color: var(--accent); font: 900 24px/1 var(--font-mono), monospace; }",
    ".toc-copy { display: flex; flex-direction: column; gap: 6px; }",
    ".toc-label { color: var(--text1); font-size: 24px; font-weight: 800; }",
    ".toc-description { color: var(--text2); font-size: 16px; }",
    ".two-column-grid, .comparison-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap-md); margin-top: 34px; }",
    ".card-grid { display: grid; gap: var(--gap-md); margin-top: 34px; }",
    ".card-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
    ".card, .comparison-panel, .metric-card, .timeline-event { border: 1px solid var(--border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface) 90%, var(--accent) 4%); box-shadow: var(--shadow-sm); }",
    ".card, .comparison-panel { padding: 26px; min-height: 210px; }",
    ".card-title, .comparison-title, .timeline-title { margin: 0 0 12px; color: var(--text1); font-size: 24px; line-height: 1.12; }",
    ".card-body, .comparison-body, .timeline-body { margin: 0; color: var(--text2); font-size: 17px; line-height: 1.5; }",
    ".kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap-md); margin-top: 34px; }",
    ".metric-card { padding: 28px; min-height: 190px; }",
    ".metric-value { color: var(--accent); font: 900 clamp(42px, 5.2vw, 76px)/.9 var(--font-display), sans-serif; letter-spacing: -.05em; }",
    ".metric-label { margin-top: 14px; color: var(--text1); font-size: 20px; font-weight: 800; }",
    ".metric-note { margin: 10px 0 0; color: var(--text2); line-height: 1.4; }",
    ".timeline { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-top: 34px; }",
    ".timeline-event { position: relative; padding: 24px; min-height: 250px; }",
    ".timeline-dot { display: block; width: 14px; height: 14px; border-radius: 99px; background: var(--accent); margin-bottom: 18px; }",
    ".timeline-date { display: inline-block; margin-bottom: 10px; color: var(--accent); font: 800 12px/1 var(--font-mono), monospace; letter-spacing: .1em; text-transform: uppercase; }",
    ".comparison-panel[data-accent='primary'], .card[data-accent='primary'] { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }",
    ".comparison-panel[data-accent='secondary'], .card[data-accent='secondary'] { border-color: color-mix(in srgb, var(--accent2) 55%, var(--border)); }",
    ".chart-layout { display: grid; grid-template-columns: minmax(0, .86fr) minmax(420px, 1.14fr); gap: var(--gap-lg); align-items: stretch; height: 100%; }",
    ".chart-copy { min-width: 0; display: flex; flex-direction: column; justify-content: center; }",
    ".chart-figure { margin: 0; min-height: 420px; align-self: center; border: 1px solid var(--border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--surface) 88%, var(--accent) 5%); box-shadow: var(--shadow-md); padding: 24px; display: flex; flex-direction: column; justify-content: center; }",
    ".chart-svg { width: 100%; height: auto; overflow: visible; }",
    ".chart-axis { stroke: color-mix(in srgb, var(--text2) 30%, transparent); stroke-width: 2; }",
    ".chart-bar { fill: var(--accent); opacity: .88; }",
    ".chart-line { fill: none; stroke: var(--accent); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }",
    ".chart-area { fill: color-mix(in srgb, var(--accent) 18%, transparent); }",
    ".chart-dot { fill: var(--surface); stroke: var(--accent); stroke-width: 4; }",
    ".chart-value { fill: var(--text1); font: 800 14px/1 var(--font-mono), monospace; }",
    ".chart-label { fill: var(--text2); font: 700 12px/1.1 var(--font-body), sans-serif; }",
    ".chart-slice { stroke: var(--surface); stroke-width: 3; }",
    ".chart-slice-1 { fill: var(--accent); } .chart-slice-2 { fill: var(--accent2); } .chart-slice-3 { fill: var(--accent3); } .chart-slice-4 { fill: var(--surface2); } .chart-slice-5 { fill: var(--text2); } .chart-slice-6 { fill: var(--border); }",
    ".chart-hole { fill: var(--surface); }",
    ".chart-radar { fill: color-mix(in srgb, var(--accent) 22%, transparent); stroke: var(--accent); stroke-width: 4; }",
    ".chart-caption { margin-top: 12px; color: var(--text2); font-size: 13px; line-height: 1.35; }",
    ".quote-shell { position: relative; z-index: 1; height: 100%; display: grid; align-content: center; gap: 24px; }",
    ".quote-figure { position: relative; margin: 0; max-width: 980px; }",
    ".quote-mark { position: absolute; left: -34px; top: -72px; color: color-mix(in srgb, var(--accent) 34%, transparent); font: 900 180px/.8 var(--font-display), serif; pointer-events: none; }",
    ".quote-text { margin: 0; color: var(--text1); font: 800 clamp(44px, 5.2vw, 82px)/1.02 var(--font-display), serif; letter-spacing: -.055em; }",
    ".quote-attribution { margin-top: 22px; color: var(--accent); font: 800 15px/1 var(--font-mono), monospace; letter-spacing: .12em; text-transform: uppercase; }",
    ".quote-support { max-width: 760px; margin: 0; color: var(--text2); font-size: 21px; line-height: 1.45; }",
    ".section-divider-shell { position: relative; z-index: 1; height: 100%; display: grid; grid-template-columns: 120px 1fr; gap: 44px; align-items: center; }",
    ".section-divider-rule { width: 100%; height: 72%; border-radius: 999px; background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent2) 70%, var(--accent))); box-shadow: var(--shadow-md); }",
    ".section-divider-copy { display: flex; flex-direction: column; gap: 18px; min-width: 0; }",
    ".section-marker { width: fit-content; border: 1px solid color-mix(in srgb, var(--accent) 44%, var(--border)); border-radius: 999px; padding: 9px 14px; color: var(--accent); background: color-mix(in srgb, var(--surface) 82%, var(--accent) 8%); font: 900 15px/1 var(--font-mono), monospace; letter-spacing: .14em; text-transform: uppercase; }",
    ".section-title { max-width: 1060px; font-size: clamp(56px, 7vw, 112px); }",
    ".section-support { max-width: 720px; margin: 0; color: var(--text2); font-size: 22px; line-height: 1.45; }",
    ".section-progress { width: fit-content; color: var(--text2); font: 800 13px/1 var(--font-mono), monospace; letter-spacing: .14em; text-transform: uppercase; }",
    ".stat-highlight-shell { position: relative; z-index: 1; height: 100%; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: var(--gap-lg); align-items: end; }",
    ".stat-copy { min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; }",
    ".stat-value { margin-top: 22px; color: var(--accent); font: 950 clamp(92px, 15vw, 210px)/.82 var(--font-display), sans-serif; letter-spacing: -.09em; }",
    ".stat-label { margin-top: 8px; color: var(--text1); font-size: clamp(26px, 3vw, 46px); font-weight: 900; letter-spacing: -.045em; }",
    ".stat-explanation { max-width: 760px; margin: 18px 0 0; color: var(--text2); font-size: 21px; line-height: 1.45; }",
    ".stat-card-grid { display: grid; gap: 16px; align-self: end; }",
    ".stat-card { border: 1px solid var(--border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface) 88%, var(--accent) 5%); box-shadow: var(--shadow-sm); padding: 22px; }",
    ".stat-card-title { margin: 0 0 9px; color: var(--text1); font-size: 21px; line-height: 1.14; }",
    ".stat-card-body { margin: 0; color: var(--text2); font-size: 15px; line-height: 1.45; }",
    ".bullet-list-shell { justify-content: center; }",
    ".bullet-group-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap-md); margin-top: 30px; }",
    ".bullet-group { border: 1px solid var(--border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface) 90%, var(--accent) 4%); box-shadow: var(--shadow-sm); padding: 22px 24px; }",
    ".bullet-group-title { margin: 0 0 14px; color: var(--text1); font-size: 22px; line-height: 1.15; }",
    ".bullet-items { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }",
    ".bullet-item { position: relative; padding-left: 20px; color: var(--text2); font-size: 16px; line-height: 1.42; }",
    ".bullet-item::before { content: ''; position: absolute; left: 0; top: .62em; width: 8px; height: 8px; border-radius: 99px; background: var(--accent); }",
    ".process-shell { justify-content: center; }",
    ".process-flow { position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-top: 34px; }",
    ".process-flow::before { content: ''; position: absolute; left: 6%; right: 6%; top: 34px; height: 2px; background: color-mix(in srgb, var(--accent) 36%, var(--border)); }",
    ".process-step { position: relative; z-index: 1; display: grid; gap: 18px; border: 1px solid var(--border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface) 90%, var(--accent) 4%); box-shadow: var(--shadow-sm); padding: 22px; min-height: 230px; }",
    ".process-step-number { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 999px; background: var(--text1); color: var(--surface); font: 900 16px/1 var(--font-mono), monospace; }",
    ".process-step-copy { display: grid; gap: 9px; align-content: start; }",
    ".process-step-title { margin: 0; color: var(--text1); font-size: 22px; line-height: 1.14; }",
    ".process-step-body { margin: 0; color: var(--text2); font-size: 15px; line-height: 1.45; }",
    ".image-hero-shell { position: relative; z-index: 1; height: 100%; display: grid; grid-template-columns: minmax(420px, 1.05fr) minmax(0, .95fr); gap: var(--gap-lg); align-items: center; }",
    ".image-hero-visual { position: relative; min-height: 520px; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: color-mix(in srgb, var(--surface) 82%, var(--accent) 8%); box-shadow: var(--shadow-md); }",
    ".image-hero-img { width: 100%; height: 100%; min-height: 520px; object-fit: cover; }",
    ".image-hero-placeholder { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--accent) 32%, transparent), transparent 34%), radial-gradient(circle at 80% 75%, color-mix(in srgb, var(--accent2) 24%, transparent), transparent 36%), linear-gradient(135deg, color-mix(in srgb, var(--surface) 78%, var(--accent) 8%), var(--surface)); }",
    ".image-hero-orb { position: absolute; border-radius: 999px; filter: blur(10px); opacity: .7; }",
    ".image-hero-orb-primary { width: 220px; height: 220px; left: 9%; top: 12%; background: color-mix(in srgb, var(--accent) 30%, transparent); }",
    ".image-hero-orb-secondary { width: 260px; height: 260px; right: 8%; bottom: 8%; background: color-mix(in srgb, var(--accent2) 24%, transparent); }",
    ".image-hero-label { position: relative; z-index: 1; color: var(--text1); font: 950 clamp(42px, 5vw, 80px)/.92 var(--font-display), sans-serif; letter-spacing: -.06em; text-transform: uppercase; }",
    ".image-hero-copy { min-width: 0; display: flex; flex-direction: column; justify-content: center; }",
    ".image-hero-body { max-width: 680px; margin: 20px 0 0; color: var(--text2); font-size: 19px; line-height: 1.48; }",
    ".image-hero-chip-row { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 22px; }",
    ".image-hero-chip { border: 1px solid var(--border); border-radius: 999px; padding: 7px 11px; background: var(--surface); color: var(--text2); font-size: 12px; font-weight: 800; }",
    ".callout, .cta-action { margin-top: 28px; border-left: 5px solid var(--accent); padding: 18px 22px; background: var(--surface2); color: var(--text1); font-size: 22px; font-weight: 800; }",
    ".cta-action { display: inline-flex; max-width: 820px; border-radius: var(--radius-md); border: 1px solid var(--border); border-left-width: 5px; }",
    ".deck-progress { position: absolute; left: 24px; right: 24px; bottom: 20px; height: 4px; background: color-mix(in srgb, var(--border) 60%, transparent); border-radius: 99px; overflow: hidden; z-index: 10; }",
    ".deck-progress-bar { display: block; width: var(--progress, 25%); height: 100%; background: var(--accent); transition: width var(--duration-fast) var(--ease); }",
    ".deck-status { position: absolute; right: 28px; top: 24px; z-index: 10; color: var(--text2); font: 700 12px/1 var(--font-mono), monospace; }",
    composeDonorCss(deck, registry),
    "@media (max-width: 900px) { .slide { padding: 42px 38px; } .two-column-grid, .comparison-grid, .card-grid-3, .kpi-grid, .timeline { grid-template-columns: 1fr; } }",
    ""
  ].join("\n");
}

type SanitizedThemeTokens = DeckIR["design"]["themeTokens"];

function sanitizeThemeTokens(deck: DeckIR): SanitizedThemeTokens {
  const source = deck.design.themeTokens;
  return {
    palette: Object.fromEntries(
      Object.entries(source.palette).map(([key, value]) => [key, safeCssValue(`palette.${key}`, value, "color")])
    ) as SanitizedThemeTokens["palette"],
    typography: {
      fontDisplay: safeCssValue("typography.fontDisplay", source.typography.fontDisplay, "font"),
      fontBody: safeCssValue("typography.fontBody", source.typography.fontBody, "font"),
      fontMono: safeCssValue("typography.fontMono", source.typography.fontMono, "font"),
      scaleRatio: safeNumber("typography.scaleRatio", source.typography.scaleRatio, 1, 2),
      baseSize: safeNumber("typography.baseSize", source.typography.baseSize, 10, 32)
    },
    geometry: {
      radiusSm: safeNumber("geometry.radiusSm", source.geometry.radiusSm, 0, 80),
      radiusMd: safeNumber("geometry.radiusMd", source.geometry.radiusMd, 0, 120),
      radiusLg: safeNumber("geometry.radiusLg", source.geometry.radiusLg, 0, 180),
      gapSm: safeNumber("geometry.gapSm", source.geometry.gapSm, 0, 80),
      gapMd: safeNumber("geometry.gapMd", source.geometry.gapMd, 0, 120),
      gapLg: safeNumber("geometry.gapLg", source.geometry.gapLg, 0, 180)
    },
    elevation: {
      shadowSm: safeCssValue("elevation.shadowSm", source.elevation.shadowSm, "shadow"),
      shadowMd: safeCssValue("elevation.shadowMd", source.elevation.shadowMd, "shadow"),
      shadowLg: safeCssValue("elevation.shadowLg", source.elevation.shadowLg, "shadow")
    },
    motion: {
      easing: safeCssValue("motion.easing", source.motion.easing, "easing"),
      durationFast: safeNumber("motion.durationFast", source.motion.durationFast, 0, 5000),
      durationBase: safeNumber("motion.durationBase", source.motion.durationBase, 0, 5000),
      durationSlow: safeNumber("motion.durationSlow", source.motion.durationSlow, 0, 10000)
    }
  };
}

function safeCssValue(label: string, value: string | undefined, kind: "color" | "font" | "shadow" | "easing"): string {
  const text = String(value ?? "").trim();
  const schema = {
    color: cssColorTokenSchema,
    font: cssFontFamilyTokenSchema,
    shadow: cssShadowTokenSchema,
    easing: cssEasingTokenSchema
  }[kind];
  const parsed = schema.safeParse(text);
  if (!parsed.success) {
    throw new Error(`Unsafe CSS token rejected: ${label}`);
  }
  return parsed.data;
}

function safeNumber(label: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Unsafe numeric CSS token rejected: ${label}`);
  }
  return value;
}

function composeDonorCss(deck: DeckIR, registry?: SkillRegistry): string {
  const selector = `body.${deck.design.deckClass}[data-donor='${deck.design.donorTemplateId}']`;
  const donor = deck.design.donorTemplateId as DonorId;
  const registryDonor = registry?.donors.find((item) => item.id === donor);
  const scopedRegistryCss = registryDonor ? sanitizeAndScopeDonorCss(registryDonor, selector) : "";
  const dna = deck.design.donorContract.dnaSignature;
  const density = dna.density === "dense" ? "dense" : dna.density === "airy" ? "airy" : "balanced";
  const densityCss = density === "airy"
    ? `${selector} .slide { padding: 72px 88px; } ${selector} .card, ${selector} .comparison-panel, ${selector} .metric-card, ${selector} .timeline-event { padding: 30px; }`
    : density === "dense"
      ? `${selector} .slide { padding: 54px 64px; } ${selector} .card, ${selector} .comparison-panel, ${selector} .metric-card, ${selector} .timeline-event { padding: 22px; }`
      : "";
  const dnaFamilies = resolveDonorDnaFamilies({
    donorTemplateId: donor,
    donorDna: dna
  });
  const dnaCss = [
    `${selector} .dna-title-family-technical { text-transform: uppercase; letter-spacing: -.03em; }`,
    `${selector} .dna-title-family-editorial { letter-spacing: -.075em; max-width: 11ch; text-wrap: balance; }`,
    `${selector} .dna-title-family-business { letter-spacing: -.055em; max-width: 12ch; text-wrap: balance; }`,
    `${selector} .dna-title-family-clean { letter-spacing: -.04em; }`,
    `${selector} .dna-card-family-technical { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); background: color-mix(in srgb, var(--surface) 90%, var(--accent) 4%); }`,
    `${selector} .dna-card-family-editorial { border: 0; background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 98%, white), color-mix(in srgb, var(--surface) 90%, var(--accent2) 8%)); box-shadow: 0 20px 44px color-mix(in srgb, var(--accent2) 12%, transparent); }`,
    `${selector} .dna-card-family-business { border-width: 2px; border-color: color-mix(in srgb, var(--accent) 52%, var(--border)); box-shadow: 0 18px 36px color-mix(in srgb, var(--accent) 14%, transparent); }`,
    `${selector} .dna-card-family-clean { box-shadow: var(--shadow-sm); }`,
    `${selector} .dna-kicker-family-technical { font-size: 12px; letter-spacing: .18em; }`,
    `${selector} .dna-kicker-family-editorial { font-family: var(--font-body), sans-serif; letter-spacing: .22em; }`,
    `${selector} .dna-kicker-family-business { font-size: 12px; letter-spacing: .16em; font-weight: 900; }`,
    `${selector} .dna-kicker-family-clean { letter-spacing: .14em; }`,
    `${selector} .dna-accent-family-controlled .stat-value, ${selector} .dna-accent-family-controlled.metric-card .metric-value { color: var(--accent); }`,
    `${selector} .dna-accent-family-warm .stat-value, ${selector} .dna-accent-family-warm.metric-card .metric-value { color: color-mix(in srgb, var(--accent) 72%, var(--accent2)); }`,
    `${selector} .dna-accent-family-metrics { border-left-color: color-mix(in srgb, var(--accent) 80%, var(--accent2)); }`,
    `${selector} .dna-density-family-airy { gap: calc(var(--gap-md) + 6px); }`,
    `${selector} .dna-density-family-dense { gap: calc(var(--gap-sm) + 2px); }`,
    `${selector} .donor-${donor}-section { isolation: isolate; }`,
    `${selector} .donor-${donor}-shell { position: relative; }`,
    `${selector} .donor-${donor}-title { color: var(--text1); }`
  ].join("\n");

  const donorProfileCss = composeTemplateRenderProfileCss(selector, donor);

  return [
    "/* Donor-scoped visual DNA. Registry donor CSS is sanitized and scoped before deterministic renderer fallbacks. */",
    `${selector} { --donor-dna: ${cssStringLiteral(donor)}; --donor-density: ${cssStringLiteral(dna.density)}; --donor-title-treatment: ${cssStringLiteral(dna.titleTreatment)}; --donor-card-treatment: ${cssStringLiteral(dna.cardTreatment)}; --donor-kicker-treatment: ${cssStringLiteral(dna.kickerTreatment)}; --donor-accent-rule: ${cssStringLiteral(dna.accentRule)}; }`,
    `/* donor-dna-id: ${donor} */`,
    `/* donor-dna-density: ${dna.density} */`,
    `/* donor-dna-title-treatment: ${dna.titleTreatment} */`,
    `/* donor-dna-card-treatment: ${dna.cardTreatment} */`,
    `/* donor-dna-kicker-treatment: ${dna.kickerTreatment} */`,
    `/* donor-dna-accent-rule: ${dna.accentRule} */`,
    `/* donor-dna-title-family: ${dnaFamilies.title} */`,
    `/* donor-dna-card-family: ${dnaFamilies.card} */`,
    `/* donor-dna-kicker-family: ${dnaFamilies.kicker} */`,
    `/* donor-dna-accent-family: ${dnaFamilies.accent} */`,
    scopedRegistryCss,
    densityCss,
    dnaCss,
    donorProfileCss
  ].filter(Boolean).join("\n");
}
