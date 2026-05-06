import type { DonorId } from "../ir";
import type { TemplateAspectRatio, TemplateRendererProfile } from "../registry";

export type TemplateRenderProfileDensity = "airy" | "balanced" | "dense";

export type TemplateRenderProfileChrome =
  | "none"
  | "grid"
  | "hazard-stripes"
  | "stage-frame"
  | "editorial-wash"
  | "terminal-scanlines"
  | "blueprint-grid"
  | "social-card";

export type TemplateRenderProfilePrimitive =
  | "accent-kicker"
  | "alert-kicker"
  | "stage-kicker"
  | "soft-orb"
  | "hard-shadow-card"
  | "semantic-alert-bars"
  | "agenda-row"
  | "code-panel"
  | "metric-emphasis";

export type TemplateRenderProfileLayoutOverride =
  | "none"
  | "portrait-card"
  | "dense-warning-panels"
  | "presenter-stage-spacing"
  | "minimal-shadow"
  | "course-sidebar-hint";

type TemplateRenderProfileCssContext = {
  selector: string;
  sharedCardSelector: string;
};

export type TemplateRenderProfile = {
  id: DonorId;
  aspectRatio: TemplateAspectRatio;
  rendererProfile: TemplateRendererProfile;
  density: TemplateRenderProfileDensity;
  chrome: TemplateRenderProfileChrome[];
  decorativePrimitives: TemplateRenderProfilePrimitive[];
  layoutOverrides: TemplateRenderProfileLayoutOverride[];
  cssRules: (context: TemplateRenderProfileCssContext) => string[];
};

export function composeTemplateRenderProfileCss(selector: string, donor: DonorId): string {
  const sharedCardSelector = `${selector} .card, ${selector} .comparison-panel, ${selector} .metric-card, ${selector} .timeline-event, ${selector} .stat-card, ${selector} .bullet-group, ${selector} .process-step`;
  const profile = TEMPLATE_RENDER_PROFILES[donor];
  const rules = profile?.cssRules({ selector, sharedCardSelector }) ?? [
    `${sharedCardSelector} { border-color: color-mix(in srgb, var(--accent) 24%, var(--border)); }`
  ];
  return rules.join("\n");
}

export const TEMPLATE_RENDER_PROFILES: Readonly<Record<DonorId, TemplateRenderProfile>> = {
  "pitch-deck": {
    id: "pitch-deck",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["soft-orb", "metric-emphasis"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background: radial-gradient(circle at 78% 18%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 28%), var(--bg); }`,
      `${selector} .h1, ${selector} .h2 { max-width: 1060px; letter-spacing: -.06em; }`,
      `${sharedCardSelector} { border-color: color-mix(in srgb, var(--accent) 36%, var(--border)); box-shadow: 0 18px 48px color-mix(in srgb, var(--accent) 10%, transparent); }`,
      `${selector} .callout, ${selector} .cta-action { border-left-width: 8px; }`,
      `${selector} .kicker { letter-spacing: .20em; color: var(--accent); font-weight: 900; }`,
      `${selector} .section-divider-rule { background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent2) 80%, var(--accent))); box-shadow: 0 0 24px color-mix(in srgb, var(--accent) 26%, transparent); }`,
      `${selector} .metric-value { color: var(--accent); filter: drop-shadow(0 8px 22px color-mix(in srgb, var(--accent) 28%, transparent)); }`,
      `${selector} .stat-value { color: var(--accent); letter-spacing: -.10em; filter: drop-shadow(0 12px 32px color-mix(in srgb, var(--accent) 24%, transparent)); }`,
      `${selector} .cta-action { background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, var(--surface)), var(--surface)); border-radius: var(--radius-lg); }`,
      `${selector} .toc-item { border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); background: linear-gradient(135deg, color-mix(in srgb, var(--surface) 92%, var(--accent) 5%), var(--surface)); }`,
      `${selector} .process-step-number { background: var(--accent); color: var(--surface); box-shadow: 0 8px 20px color-mix(in srgb, var(--accent) 30%, transparent); }`,
      `${selector} .donor-pitch-deck-title { max-width: 10ch; } ${selector} .donor-pitch-deck-card, ${selector} .donor-pitch-deck-panel { border-top: 4px solid color-mix(in srgb, var(--accent) 60%, transparent); }`
    ]
  },
  "product-launch": {
    id: "product-launch",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["accent-kicker", "soft-orb"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .cover-mark { right: -90px; top: 70px; width: 520px; height: 320px; border-radius: 44px; transform: rotate(-8deg); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 28%, transparent), color-mix(in srgb, var(--accent2) 20%, transparent)); }`,
      `${selector} .kicker { display: inline-flex; width: fit-content; border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--border)); border-radius: 999px; padding: 9px 13px; background: color-mix(in srgb, var(--surface) 84%, var(--accent) 8%); }`,
      `${sharedCardSelector} { background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 90%, var(--accent) 8%), var(--surface)); }`,
      `${selector} .donor-product-launch-title { max-width: 9ch; text-transform: uppercase; letter-spacing: -.085em; }`,
      `${selector} .donor-product-launch-card, ${selector} .donor-product-launch-panel { border-top: 6px solid color-mix(in srgb, var(--accent) 72%, var(--accent2)); }`,
      `${selector} .donor-product-launch-cta-cta { background: var(--text1); color: var(--surface); border-color: var(--text1); }`
    ]
  },
  "tech-sharing": {
    id: "tech-sharing",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["grid"],
    decorativePrimitives: ["accent-kicker"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background-image: linear-gradient(color-mix(in srgb, var(--border) 36%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 36%, transparent) 1px, transparent 1px); background-size: 36px 36px; }`,
      `${selector} .kicker { border-left: 4px solid var(--accent); padding-left: 12px; }`,
      `${sharedCardSelector} { background: color-mix(in srgb, var(--surface) 86%, var(--accent) 6%); }`,
      `${selector} .donor-tech-sharing-title { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.035em; }`,
      `${selector} .donor-tech-sharing-card, ${selector} .donor-tech-sharing-panel { border-radius: 16px; border-width: 1.5px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent); }`,
      `${selector} .donor-tech-sharing-cover-shell::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: linear-gradient(90deg, var(--accent), transparent); }`
    ]
  },
  "testing-safety-alert": {
    id: "testing-safety-alert",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "dense",
    chrome: ["hazard-stripes"],
    decorativePrimitives: ["alert-kicker", "semantic-alert-bars", "code-panel"],
    layoutOverrides: ["dense-warning-panels"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} { --renderer-fallback-profile: 'testing-safety-alert'; }`,
      `${selector} .deck { background: linear-gradient(135deg, color-mix(in srgb, var(--bad) 10%, transparent), transparent 42%), var(--bg); }`,
      `${selector} .deck::before, ${selector} .deck::after { content: ''; position: absolute; left: 0; right: 0; height: 18px; z-index: 5; pointer-events: none; background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--warn) 84%, var(--bad) 16%) 0 18px, color-mix(in srgb, var(--text1) 88%, transparent) 18px 36px); }`,
      `${selector} .deck::before { top: 0; }`,
      `${selector} .deck::after { bottom: 0; }`,
      `${selector} .slide { padding-top: 66px; padding-bottom: 66px; }`,
      `${selector} .kicker { display: inline-flex; width: fit-content; align-items: center; gap: 10px; border: 1px solid color-mix(in srgb, var(--bad) 46%, var(--border)); border-radius: 0; padding: 9px 12px; background: color-mix(in srgb, var(--bad) 14%, var(--surface)); color: var(--bad); letter-spacing: .18em; }`,
      `${selector} .kicker::before { content: 'ALERT'; border-radius: 3px; padding: 4px 6px; background: var(--bad); color: var(--surface); font-size: 10px; letter-spacing: .12em; }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.035em; text-transform: uppercase; }`,
      `${selector} .callout, ${selector} .cta-action { border-left: 9px solid var(--bad); background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--bad) 10%, var(--surface)) 0 18px, color-mix(in srgb, var(--warn) 10%, var(--surface)) 18px 36px); }`,
      `${sharedCardSelector} { border-radius: 6px; border: 1.5px solid color-mix(in srgb, var(--bad) 36%, var(--border)); background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 88%, var(--warn) 7%), color-mix(in srgb, var(--surface) 92%, var(--bad) 5%)); box-shadow: 8px 8px 0 color-mix(in srgb, var(--text1) 12%, transparent); }`,
      `${selector} .card::before, ${selector} .comparison-panel::before, ${selector} .metric-card::before, ${selector} .timeline-event::before { content: ''; display: block; width: 44px; height: 5px; margin-bottom: 16px; background: var(--bad); box-shadow: 54px 0 0 var(--warn), 108px 0 0 var(--good); }`,
      `${selector} .card[data-accent='primary'], ${selector} .comparison-panel[data-accent='primary'] { border-color: var(--bad); }`,
      `${selector} .card[data-accent='secondary'], ${selector} .comparison-panel[data-accent='secondary'] { border-color: var(--warn); }`,
      `${selector} .timeline-dot { border-radius: 2px; background: var(--bad); box-shadow: 0 0 0 6px color-mix(in srgb, var(--bad) 16%, transparent); }`,
      `${selector} .metric-value { color: var(--bad); font-family: var(--font-mono), monospace; }`,
      `${selector} .chart-figure { border-radius: 8px; border-color: color-mix(in srgb, var(--bad) 42%, var(--border)); background-image: linear-gradient(color-mix(in srgb, var(--text1) 8%, transparent) 1px, transparent 1px); background-size: 100% 34px; }`
      ,
      `${selector} .quote-text { text-transform: uppercase; letter-spacing: -.035em; }`,
      `${selector} .section-divider-rule { background: repeating-linear-gradient(135deg, var(--warn) 0 18px, var(--text1) 18px 36px); }`,
      `${selector} .section-marker, ${selector} .stat-value { color: var(--bad); }`,
      `${selector} .process-step-number { border-radius: 4px; background: var(--bad); }`,
      `${selector} .bullet-item::before { border-radius: 2px; background: var(--bad); }`,
      `${selector} .image-hero-visual { border-radius: 8px; border-color: color-mix(in srgb, var(--bad) 44%, var(--border)); }`
    ]
  },
  "weekly-report": {
    id: "weekly-report",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["none"],
    decorativePrimitives: ["accent-kicker"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .slide::after { content: ''; position: absolute; left: 76px; right: 76px; top: 42px; height: 2px; background: color-mix(in srgb, var(--accent) 32%, var(--border)); }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.035em; }`,
      `${sharedCardSelector} { min-height: 180px; background: var(--surface); border-radius: 0; border-left-width: 3px; border-left-color: color-mix(in srgb, var(--accent) 46%, var(--border)); border-top: 0; border-right: 0; }`,
      `${selector} .donor-weekly-report-title { max-width: 12ch; }`,
      `${selector} .kicker { letter-spacing: .18em; color: var(--text2); border-bottom: 1px solid var(--border); padding-bottom: 9px; font-weight: 700; }`,
      `${selector} .metric-value { color: var(--text1); font-size: clamp(34px, 4.2vw, 62px); letter-spacing: -.04em; }`,
      `${selector} .metric-label { color: var(--text2); font-weight: 700; font-size: 16px; letter-spacing: .06em; text-transform: uppercase; }`,
      `${selector} .toc-item { border-radius: 0; border-left: 4px solid color-mix(in srgb, var(--accent) 50%, var(--border)); border-top: 0; border-right: 0; border-bottom: 1px solid var(--border); background: var(--surface); }`,
      `${selector} .timeline-event { border-radius: 0; border-top: 3px solid color-mix(in srgb, var(--accent) 40%, var(--border)); border-left: 0; border-right: 0; border-bottom: 1px solid var(--border); }`,
      `${selector} .section-marker { border-radius: 0; letter-spacing: .18em; }`,
      `${selector} .process-step-number { border-radius: 4px; background: color-mix(in srgb, var(--surface) 90%, var(--accent) 8%); color: var(--text1); border: 2px solid color-mix(in srgb, var(--accent) 40%, var(--border)); }`,
      `${selector} .slide-footer { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--text2); }`
    ]
  },
  "course-module": {
    id: "course-module",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["accent-kicker"],
    layoutOverrides: ["course-sidebar-hint"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 38%), var(--bg); }`,
      `${selector} .kicker { color: var(--text2); }`,
      `${selector} .kicker::before { content: 'LESSON'; margin-right: 10px; color: var(--accent); }`,
      `${sharedCardSelector} { border-radius: calc(var(--radius-md) + 8px); }`,
      `${selector} .donor-course-module-card { border-left: 6px solid color-mix(in srgb, var(--accent) 62%, transparent); }`,
      `${selector} .donor-course-module-title { max-width: 10ch; }`
    ]
  },
  "presenter-mode-reveal": {
    id: "presenter-mode-reveal",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "airy",
    chrome: ["stage-frame"],
    decorativePrimitives: ["stage-kicker", "agenda-row", "soft-orb"],
    layoutOverrides: ["presenter-stage-spacing"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} { --renderer-fallback-profile: 'presenter-mode-reveal'; }`,
      `${selector} .deck { background: radial-gradient(circle at 50% -12%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in srgb, var(--text1) 9%, var(--bg)), var(--bg)); }`,
      `${selector} .deck::before { content: ''; position: absolute; inset: 28px; border: 1px solid color-mix(in srgb, var(--text1) 14%, transparent); border-radius: 28px; pointer-events: none; z-index: 0; }`,
      `${selector} .slide { padding: 76px 92px; }`,
      `${selector} .cover-shell, ${selector} .cta-shell { justify-content: flex-end; padding-bottom: 54px; }`,
      `${selector} .cover-mark { right: 72px; top: 58px; width: 330px; height: 330px; border-radius: 999px; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 28%, transparent), transparent 66%); filter: blur(10px); }`,
      `${selector} .kicker { display: inline-flex; width: fit-content; align-items: center; gap: 10px; border-bottom: 2px solid color-mix(in srgb, var(--accent) 58%, transparent); padding-bottom: 8px; color: var(--accent); letter-spacing: .22em; }`,
      `${selector} .kicker::before { content: 'STAGE'; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 999px; padding: 5px 8px; background: color-mix(in srgb, var(--surface) 72%, var(--text1) 12%); color: var(--text1); font-size: 10px; letter-spacing: .14em; }`,
      `${selector} .h1 { max-width: 1040px; font-size: clamp(64px, 7.8vw, 118px); letter-spacing: -.075em; }`,
      `${selector} .h2 { max-width: 960px; letter-spacing: -.06em; }`,
      `${selector} .lede { max-width: 700px; font-size: 22px; }`,
      `${selector} .toc-list { gap: 18px; max-width: 1020px; }`,
      `${selector} .toc-item { grid-template-columns: 82px 1fr; border-radius: 999px 26px 26px 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--surface) 82%, var(--text1) 8%), var(--surface)); }`,
      `${selector} .toc-number { display: grid; width: 54px; height: 54px; place-items: center; border-radius: 999px; background: var(--text1); color: var(--surface); font-size: 18px; }`,
      `${sharedCardSelector} { border-radius: 28px; border-color: color-mix(in srgb, var(--text1) 18%, var(--border)); background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 82%, var(--text1) 9%), color-mix(in srgb, var(--surface) 92%, var(--accent) 5%)); box-shadow: 0 22px 60px color-mix(in srgb, var(--text1) 14%, transparent); }`,
      `${selector} .card-title, ${selector} .comparison-title, ${selector} .timeline-title { font-family: var(--font-display), var(--font-body), sans-serif; letter-spacing: -.035em; }`,
      `${selector} .metric-card { min-height: 220px; display: flex; flex-direction: column; justify-content: flex-end; }`,
      `${selector} .metric-value { color: var(--text1); text-shadow: 0 10px 34px color-mix(in srgb, var(--accent) 22%, transparent); }`,
      `${selector} .timeline-event { padding-top: 38px; }`,
      `${selector} .timeline-dot { width: 38px; height: 4px; border-radius: 99px; background: var(--accent); }`,
      `${selector} .cta-action { border-radius: 999px; border-left-width: 1px; padding: 22px 30px; background: var(--text1); color: var(--surface); }`,
      `${selector} .quote-text { max-width: 1040px; font-size: clamp(56px, 6vw, 96px); }`,
      `${selector} .section-divider-shell { grid-template-columns: 92px 1fr; }`,
      `${selector} .section-marker { background: var(--text1); color: var(--surface); }`,
      `${selector} .stat-value { color: var(--text1); text-shadow: 0 14px 42px color-mix(in srgb, var(--accent) 20%, transparent); }`,
      `${selector} .process-flow::before { top: 32px; }`,
      `${selector} .process-step-number { background: var(--text1); color: var(--surface); }`,
      `${selector} .image-hero-visual { border-radius: 34px; }`
    ]
  },
  "xhs-white-editorial": {
    id: "xhs-white-editorial",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "airy",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["soft-orb"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background: radial-gradient(circle at 20% 12%, color-mix(in srgb, var(--accent2) 12%, transparent), transparent 28%), var(--bg); }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.065em; font-style: italic; }`,
      `${sharedCardSelector} { border: 0; background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 88%, var(--accent2) 8%)); box-shadow: 0 20px 48px color-mix(in srgb, var(--accent2) 14%, transparent); }`,
      `${selector} .donor-xhs-white-editorial-title { font-style: italic; max-width: 9ch; }`,
      `${selector} .kicker { font-family: var(--font-body), sans-serif; letter-spacing: .28em; color: color-mix(in srgb, var(--text2) 80%, var(--accent)); font-style: normal; }`,
      `${selector} .lede { font-size: 26px; font-style: italic; color: color-mix(in srgb, var(--text2) 90%, var(--accent2)); }`,
      `${selector} .metric-value { color: color-mix(in srgb, var(--accent) 78%, var(--accent2)); letter-spacing: -.06em; }`,
      `${selector} .stat-value { color: color-mix(in srgb, var(--accent) 76%, var(--accent2) 24%); letter-spacing: -.10em; }`,
      `${selector} .quote-text { font-style: italic; letter-spacing: -.07em; }`,
      `${selector} .quote-attribution { letter-spacing: .24em; color: color-mix(in srgb, var(--accent) 72%, var(--accent2)); }`,
      `${selector} .section-divider-rule { background: linear-gradient(180deg, var(--accent2), color-mix(in srgb, var(--accent) 55%, var(--accent2))); opacity: .72; }`,
      `${selector} .cover-mark { filter: blur(3px); opacity: .38; width: 360px; height: 360px; background: radial-gradient(circle, color-mix(in srgb, var(--accent2) 30%, transparent), transparent 66%); }`
    ]
  },
  "xhs-post": {
    id: "xhs-post",
    aspectRatio: "3:4",
    rendererProfile: "social-portrait",
    density: "dense",
    chrome: ["social-card"],
    decorativePrimitives: ["hard-shadow-card", "soft-orb"],
    layoutOverrides: ["portrait-card"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck-viewport { background: #f0eae2; }`,
      `${selector} .deck { width: min(100vw, calc(100vh * 3 / 4)); aspect-ratio: 3 / 4; border: 0; border-radius: 28px; background: var(--bg); box-shadow: 0 18px 46px rgba(90, 40, 30, .12); }`,
      `${selector} .slide { padding: 70px 64px; border-radius: 28px; }`,
      `${selector} .cover-mark { right: -18%; top: 4%; width: 58%; height: 26%; border-radius: 999px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 26%, transparent), color-mix(in srgb, var(--accent-3, var(--accent3)) 24%, transparent)); filter: blur(4px); opacity: .7; }`,
      `${selector} .h1 { font-size: clamp(44px, 7.2vh, 72px); line-height: 1.1; letter-spacing: -.02em; }`,
      `${selector} .h2 { font-size: clamp(34px, 5.4vh, 54px); line-height: 1.15; letter-spacing: -.015em; }`,
      `${selector} .lede { font-size: clamp(18px, 2.4vh, 26px); line-height: 1.55; }`,
      `${selector} .kicker { color: var(--accent); letter-spacing: .2em; }`,
      `${selector} .two-column-grid, ${selector} .comparison-grid, ${selector} .card-grid, ${selector} .kpi-grid, ${selector} .timeline { grid-template-columns: 1fr; gap: 18px; margin-top: 28px; }`,
      `${sharedCardSelector} { border: 2.5px solid var(--text-1, var(--text1)); border-radius: 22px; background: #fff; box-shadow: 5px 5px 0 var(--text-1, var(--text1)); }`,
      `${selector} .slide-footer { right: 64px; bottom: 40px; }`,
      `${selector} .deck-progress { left: 24px; right: 24px; bottom: 18px; }`
    ]
  },
  "graphify-dark-graph": {
    id: "graphify-dark-graph",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["grid"],
    decorativePrimitives: ["metric-emphasis"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background-image: radial-gradient(circle at 18% 22%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 30%), linear-gradient(color-mix(in srgb, var(--border) 30%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 30%, transparent) 1px, transparent 1px); background-size: auto, 42px 42px, 42px 42px; }`,
      `${selector} .metric-value { font-family: var(--font-mono), monospace; color: var(--accent); filter: drop-shadow(0 10px 24px color-mix(in srgb, var(--accent) 22%, transparent)); }`,
      `${sharedCardSelector} { background: color-mix(in srgb, var(--surface) 80%, var(--accent) 8%); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }`,
      `${selector} .h1, ${selector} .h2 { font-family: var(--font-mono), monospace; letter-spacing: -.04em; text-transform: uppercase; }`,
      `${selector} .kicker { font-family: var(--font-mono), monospace; letter-spacing: .20em; color: var(--accent); }`,
      `${selector} .stat-value { color: var(--accent); letter-spacing: -.09em; filter: drop-shadow(0 14px 36px color-mix(in srgb, var(--accent) 28%, transparent)); }`,
      `${selector} .chart-figure { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); background: color-mix(in srgb, var(--surface) 84%, var(--accent) 8%); background-image: linear-gradient(color-mix(in srgb, var(--text1) 7%, transparent) 1px, transparent 1px); background-size: 100% 36px; }`,
      `${selector} .timeline-dot { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 18%, transparent), 0 0 16px color-mix(in srgb, var(--accent) 32%, transparent); }`,
      `${selector} .donor-graphify-dark-graph-title { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.025em; }`,
      `${selector} .process-step-number { background: color-mix(in srgb, var(--surface) 80%, var(--accent) 12%); color: var(--accent); border: 2px solid color-mix(in srgb, var(--accent) 44%, var(--border)); font-family: var(--font-mono), monospace; }`,
      `${selector} .section-marker { font-family: var(--font-mono), monospace; border-radius: 4px; letter-spacing: .16em; }`,
      `${selector} .quote-text { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.04em; }`
    ]
  },
  "knowledge-arch-blueprint": {
    id: "knowledge-arch-blueprint",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["blueprint-grid"],
    decorativePrimitives: ["accent-kicker"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background-image: linear-gradient(color-mix(in srgb, var(--accent) 10%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--accent) 10%, transparent) 1px, transparent 1px); background-size: 28px 28px; }`,
      `${selector} .h1, ${selector} .h2 { text-decoration: underline; text-decoration-thickness: 3px; text-underline-offset: 10px; text-decoration-color: color-mix(in srgb, var(--accent) 60%, transparent); }`,
      `${sharedCardSelector} { border-style: dashed; border-color: color-mix(in srgb, var(--accent) 36%, var(--border)); background: color-mix(in srgb, var(--surface) 94%, var(--accent) 3%); }`,
      `${selector} .donor-knowledge-arch-blueprint-card { border-style: dashed; border-width: 2px; }`,
      `${selector} .kicker { font-family: var(--font-mono), monospace; letter-spacing: .24em; color: var(--accent); font-weight: 700; }`,
      `${selector} .section-marker { border-radius: 0; font-family: var(--font-mono), monospace; letter-spacing: .20em; border-style: dashed; }`,
      `${selector} .metric-value { font-family: var(--font-mono), monospace; color: var(--accent); letter-spacing: -.04em; }`,
      `${selector} .stat-value { font-family: var(--font-mono), monospace; color: var(--accent); letter-spacing: -.08em; }`,
      `${selector} .timeline-dot { border-radius: 3px; background: var(--accent); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent); }`,
      `${selector} .process-step-number { border-radius: 6px; font-family: var(--font-mono), monospace; background: color-mix(in srgb, var(--accent) 10%, var(--surface)); color: var(--accent); border: 2px dashed color-mix(in srgb, var(--accent) 52%, var(--border)); }`,
      `${selector} .bullet-item::before { border-radius: 2px; background: var(--accent); width: 10px; height: 10px; }`,
      `${selector} .image-hero-visual { border-style: dashed; border-width: 2px; border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }`
    ]
  },
  "hermes-cyber-terminal": {
    id: "hermes-cyber-terminal",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "balanced",
    chrome: ["terminal-scanlines"],
    decorativePrimitives: ["code-panel"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .09; background: repeating-linear-gradient(0deg, var(--text1) 0 1px, transparent 1px 5px); z-index: 0; }`,
      `${selector} .kicker { font-family: var(--font-mono), monospace; letter-spacing: .20em; color: var(--accent); border-left: 3px solid var(--accent); padding-left: 10px; }`,
      `${sharedCardSelector} { background: color-mix(in srgb, var(--surface) 78%, var(--accent) 10%); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 4px; }`,
      `${selector} .h1, ${selector} .h2 { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.035em; }`,
      `${selector} .metric-value { font-family: var(--font-mono), monospace; color: var(--accent); text-shadow: 0 0 22px color-mix(in srgb, var(--accent) 44%, transparent); }`,
      `${selector} .stat-value { font-family: var(--font-mono), monospace; color: var(--accent); letter-spacing: -.08em; text-shadow: 0 0 38px color-mix(in srgb, var(--accent) 40%, transparent); }`,
      `${selector} .quote-text { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.03em; font-size: clamp(36px, 4.2vw, 66px); }`,
      `${selector} .timeline-dot { border-radius: 2px; background: var(--accent); box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 48%, transparent); }`,
      `${selector} .donor-hermes-cyber-terminal-title { font-family: var(--font-mono), monospace; text-transform: uppercase; letter-spacing: -.02em; }`,
      `${selector} .process-step-number { border-radius: 4px; font-family: var(--font-mono), monospace; background: color-mix(in srgb, var(--accent) 16%, var(--surface)); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 54%, var(--border)); }`,
      `${selector} .bullet-item::before { border-radius: 2px; background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 42%, transparent); }`,
      `${selector} .section-marker { border-radius: 2px; font-family: var(--font-mono), monospace; background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 48%, var(--border)); }`
    ]
  },
  "obsidian-claude-gradient": {
    id: "obsidian-claude-gradient",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "airy",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["soft-orb"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background: radial-gradient(circle at 18% 18%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 34%), radial-gradient(circle at 82% 72%, color-mix(in srgb, var(--accent2) 18%, transparent), transparent 34%), var(--bg); }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.07em; }`,
      `${sharedCardSelector} { backdrop-filter: blur(10px); background: color-mix(in srgb, var(--surface) 82%, var(--accent2) 7%); border-color: color-mix(in srgb, var(--accent) 20%, color-mix(in srgb, var(--accent2) 20%, var(--border))); box-shadow: 0 22px 52px color-mix(in srgb, var(--accent2) 14%, transparent); }`,
      `${selector} .kicker { color: color-mix(in srgb, var(--accent) 78%, var(--accent2)); letter-spacing: .22em; }`,
      `${selector} .h1 { max-width: 1040px; font-size: clamp(62px, 8vw, 116px); }`,
      `${selector} .lede { font-size: 25px; color: color-mix(in srgb, var(--text2) 90%, var(--accent) 10%); }`,
      `${selector} .metric-value { color: color-mix(in srgb, var(--accent) 78%, var(--accent2)); letter-spacing: -.08em; }`,
      `${selector} .stat-value { color: color-mix(in srgb, var(--accent) 76%, var(--accent2) 24%); letter-spacing: -.10em; }`,
      `${selector} .cover-mark { filter: blur(8px); opacity: .54; width: 500px; height: 500px; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 26%, transparent), color-mix(in srgb, var(--accent2) 18%, transparent) 60%, transparent 80%); }`,
      `${selector} .section-divider-rule { background: linear-gradient(180deg, var(--accent), var(--accent2)); box-shadow: 0 0 28px color-mix(in srgb, var(--accent) 20%, transparent); }`,
      `${selector} .timeline-dot { background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 40%, transparent); }`,
      `${selector} .donor-obsidian-claude-gradient-title { letter-spacing: -.08em; } ${selector} .donor-obsidian-claude-gradient-card, ${selector} .donor-obsidian-claude-gradient-panel { border-color: color-mix(in srgb, var(--accent) 22%, color-mix(in srgb, var(--accent2) 22%, var(--border))); }`
    ]
  },
  "xhs-pastel-card": {
    id: "xhs-pastel-card",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "airy",
    chrome: ["editorial-wash"],
    decorativePrimitives: ["soft-orb"],
    layoutOverrides: ["none"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 9%, transparent), color-mix(in srgb, var(--accent2) 8%, transparent)), var(--bg); }`,
      `${selector} .cover-mark { filter: blur(2px); opacity: .48; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 32%, transparent), color-mix(in srgb, var(--accent2) 26%, transparent) 60%, transparent 80%); }`,
      `${sharedCardSelector} { border: 0; border-radius: calc(var(--radius-md) + 12px); background: color-mix(in srgb, white 74%, color-mix(in srgb, var(--accent) 30%, var(--accent2))); box-shadow: 0 18px 42px color-mix(in srgb, var(--accent) 12%, transparent), 0 6px 14px color-mix(in srgb, var(--accent2) 8%, transparent); }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.048em; }`,
      `${selector} .kicker { color: color-mix(in srgb, var(--accent) 88%, var(--accent2)); letter-spacing: .18em; font-weight: 900; }`,
      `${selector} .metric-value { color: color-mix(in srgb, var(--accent) 82%, var(--accent2)); letter-spacing: -.06em; }`,
      `${selector} .stat-value { color: color-mix(in srgb, var(--accent) 80%, var(--accent2) 20%); letter-spacing: -.09em; }`,
      `${selector} .toc-item { border-radius: calc(var(--radius-md) + 10px); border: 0; background: color-mix(in srgb, white 78%, color-mix(in srgb, var(--accent) 20%, var(--accent2))); box-shadow: 0 14px 32px color-mix(in srgb, var(--accent) 12%, transparent); }`,
      `${selector} .timeline-dot { background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 36%, transparent); border-radius: 99px; }`,
      `${selector} .bullet-group { border-radius: calc(var(--radius-md) + 10px); border: 0; background: color-mix(in srgb, white 76%, color-mix(in srgb, var(--accent2) 24%, var(--accent))); box-shadow: 0 14px 32px color-mix(in srgb, var(--accent2) 10%, transparent); }`,
      `${selector} .process-step-number { border-radius: 999px; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent2) 60%, var(--accent))); color: white; box-shadow: 0 8px 20px color-mix(in srgb, var(--accent) 30%, transparent); }`,
      `${selector} .donor-xhs-pastel-card-title { letter-spacing: -.052em; } ${selector} .donor-xhs-pastel-card-card, ${selector} .donor-xhs-pastel-card-panel { border-radius: calc(var(--radius-md) + 14px); }`
    ]
  },
  "dir-key-nav-minimal": {
    id: "dir-key-nav-minimal",
    aspectRatio: "16:9",
    rendererProfile: "standard-wide",
    density: "airy",
    chrome: ["none"],
    decorativePrimitives: ["accent-kicker"],
    layoutOverrides: ["minimal-shadow"],
    cssRules: ({ selector, sharedCardSelector }) => [
      `${selector} .deck { box-shadow: none !important; background: var(--bg); }`,
      `${selector} .kicker { color: var(--text2); letter-spacing: 4px; font-weight: 700; font-size: 11px; }`,
      `${sharedCardSelector} { box-shadow: none; background: transparent; border-color: color-mix(in srgb, var(--text1) 14%, var(--border)); border-radius: 0; }`,
      `${selector} .h1, ${selector} .h2 { letter-spacing: -.03em; font-size: clamp(46px, 5.6vw, 86px); }`,
      `${selector} .lede { font-size: 20px; line-height: 1.5; color: var(--text2); max-width: 680px; }`,
      `${selector} .cover-mark { opacity: 0; pointer-events: none; }`,
      `${selector} .metric-value { color: var(--text1); font-size: clamp(46px, 5.8vw, 88px); letter-spacing: -.04em; }`,
      `${selector} .stat-value { color: var(--text1); letter-spacing: -.09em; font-size: clamp(78px, 12vw, 170px); }`,
      `${selector} .toc-number { color: var(--text2); font-size: 16px; font-weight: 700; }`,
      `${selector} .process-step-number { border-radius: 0; background: var(--surface); color: var(--text1); border: 1px solid color-mix(in srgb, var(--text1) 24%, var(--border)); font-size: 14px; }`,
      `${selector} .section-divider-rule { background: color-mix(in srgb, var(--text1) 22%, transparent); height: 58%; box-shadow: none; }`,
      `${selector} .donor-dir-key-nav-minimal-title { font-weight: 900; letter-spacing: -.032em; } ${selector} .donor-dir-key-nav-minimal-card, ${selector} .donor-dir-key-nav-minimal-panel { background: transparent; border-radius: 0; }`
    ]
  }
};
