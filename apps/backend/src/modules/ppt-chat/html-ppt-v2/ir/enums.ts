import { z } from "zod";

export const LANGUAGE_IDS = ["zh-CN", "en", "ja", "ko", "fr", "de", "es"] as const;
export const AUDIENCE_IDS = [
  "investors",
  "engineers",
  "executives",
  "students",
  "researchers",
  "general-public",
  "designers",
  "policy-makers",
  "sales",
  "consumers"
] as const;
export const TONE_IDS = [
  "authoritative",
  "friendly",
  "rigorous",
  "inspirational",
  "analytical",
  "narrative",
  "tutorial"
] as const;
export const FORMAT_IDS = ["pitch", "lecture", "report", "tutorial", "briefing", "showcase", "analysis"] as const;
export const NARRATIVE_ARC_IDS = [
  "problem-solution",
  "chronological",
  "deductive",
  "comparative",
  "thematic-clusters",
  "inverted-pyramid",
  "hero-journey",
  "pyramid-principle"
] as const;
export const SLIDE_ROLE_IDS = [
  "cover",
  "toc",
  "hook",
  "context",
  "evidence",
  "analysis",
  "comparison",
  "process",
  "case-study",
  "data-highlight",
  "transition-divider",
  "synthesis",
  "cta",
  "thanks"
] as const;
export const DENSITY_BUDGET_IDS = ["sparse", "balanced", "dense"] as const;
export const THEME_IDS = [
  "sunset-warm",
  "engineering-whiteprint",
  "editorial-serif",
  "magazine-bold",
  "japanese-minimal",
  "graphify-dark",
  "knowledge-blueprint",
  "obsidian-gradient",
  "terminal-cyber",
  "xhs-pastel",
  "minimal-nav",
  "safety-alert"
] as const;
export const DONOR_IDS = [
  "pitch-deck",
  "product-launch",
  "tech-sharing",
  "weekly-report",
  "course-module",
  "xhs-post",
  "presenter-mode-reveal",
  "xhs-white-editorial",
  "graphify-dark-graph",
  "knowledge-arch-blueprint",
  "hermes-cyber-terminal",
  "obsidian-claude-gradient",
  "xhs-pastel-card",
  "dir-key-nav-minimal",
  "testing-safety-alert"
] as const;
export const LAYOUT_IDS = [
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
  "cta",
  "chart",
  "image-hero"
] as const;
export const RENDERABLE_LAYOUT_IDS = [
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
export const ANIMATION_IDS = ["fade-up", "rise-in", "zoom-pop", "stagger-list", "scale-in", "none"] as const;
export const FX_IDS = ["soft-glow", "grid-lines", "particles-subtle", "spotlight", "none"] as const;
export const ANIMATABLE_SURFACE_IDS = ["toc-item", "card", "metric-card", "timeline-event", "comparison-panel", "chart-figure"] as const;
export const CHART_TYPE_IDS = ["bar", "line", "area", "pie", "doughnut", "radar"] as const;
export const QUALITY_SCORE_KEYS = ["factual", "narrative", "visual", "density", "accessibility", "overall"] as const;

export const languageSchema = z.enum(LANGUAGE_IDS);
export const audienceSchema = z.enum(AUDIENCE_IDS);
export const toneSchema = z.enum(TONE_IDS);
export const formatSchema = z.enum(FORMAT_IDS);
export const narrativeArcSchema = z.enum(NARRATIVE_ARC_IDS);
export const slideRoleSchema = z.enum(SLIDE_ROLE_IDS);
export const densityBudgetSchema = z.enum(DENSITY_BUDGET_IDS);
export const themeIdSchema = z.enum(THEME_IDS);
export const donorIdSchema = z.enum(DONOR_IDS);
export const layoutIdSchema = z.enum(LAYOUT_IDS);
export const renderableLayoutIdSchema = z.enum(RENDERABLE_LAYOUT_IDS);
export const animationIdSchema = z.enum(ANIMATION_IDS);
export const fxIdSchema = z.enum(FX_IDS);
export const animatableSurfaceIdSchema = z.enum(ANIMATABLE_SURFACE_IDS);
export const chartTypeSchema = z.enum(CHART_TYPE_IDS);

export type LanguageId = z.infer<typeof languageSchema>;
export type AudienceId = z.infer<typeof audienceSchema>;
export type ToneId = z.infer<typeof toneSchema>;
export type FormatId = z.infer<typeof formatSchema>;
export type NarrativeArcId = z.infer<typeof narrativeArcSchema>;
export type SlideRoleId = z.infer<typeof slideRoleSchema>;
export type DensityBudgetId = z.infer<typeof densityBudgetSchema>;
export type ThemeId = z.infer<typeof themeIdSchema>;
export type DonorId = z.infer<typeof donorIdSchema>;
export type LayoutId = z.infer<typeof layoutIdSchema>;
export type RenderableLayoutId = z.infer<typeof renderableLayoutIdSchema>;
export type AnimationId = z.infer<typeof animationIdSchema>;
export type FxId = z.infer<typeof fxIdSchema>;
export type AnimatableSurfaceId = z.infer<typeof animatableSurfaceIdSchema>;
export type ChartTypeId = z.infer<typeof chartTypeSchema>;
