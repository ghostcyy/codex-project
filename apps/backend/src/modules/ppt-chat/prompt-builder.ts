import type {
  AgentPlan,
  HtmlPptAgentInput,
  ResearchPack,
  SkillAssetManifestLike,
  SkillPack,
  VisualPlan
} from "./html-ppt-agent.types";

type PromptEnvelope = {
  system: string;
  user: string;
};

const PALETTE_KEYS_FOR_PROMPT = ["bg", "surface", "accent", "text1", "text2", "border"] as const;

type PromptStage =
  | "research"
  | "content-plan"
  | "visual-plan"
  | "section-batch"
  | "css";

type PromptBuilderOptions = {
  userContextText: string;
  skill: SkillPack;
  assetManifest?: SkillAssetManifestLike;
};

type ResearchPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
};

type ContentPlanPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
  research: ResearchPack;
};

type VisualPlanPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
  plan: AgentPlan;
};

type SectionBatchPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
  plan: AgentPlan;
  visual: VisualPlan;
  research: ResearchPack;
  batch: AgentPlan["slides"];
  batchVisuals: VisualPlan["slideVisuals"];
  layoutTemplates: string;
  priorFailures?: string[];
};

type CssPromptContext = PromptBuilderOptions & {
  plan: AgentPlan;
  visual: VisualPlan;
  indexHtmlSummary: string;
  layoutContract: string;
  selectedThemePalette?: string;
  priorFailures?: string[];
};

function buildBaseConstraints(skill: SkillPack) {
  return [
    "Base constraints derived from html-ppt skill and runtime contract:",
    "- Follow the html-ppt skill rules and preserve the runtime-controlled slide system.",
    "- The deck is always a 16:9 single-screen slide deck, not a scrolling document.",
    "- Do not output notes, speaker notes, scripts, or transcript blocks.",
    "- Do not use remote images or remote assets unless explicitly required by the runtime.",
    "- Prefer the local template, theme, animation, and effect catalog over invented structures.",
    "- When generating CSS, use html-ppt theme variables instead of hard-coded random colors.",
    "",
    "Skill excerpt:",
    skill.rules.slice(0, 6000)
  ].join("\n");
}

function layoutCatalogText(skill: SkillPack, assetManifest?: SkillAssetManifestLike) {
  if (assetManifest?.layouts?.length) {
    return assetManifest.layouts.map((layout) => {
      const density = layout.densityBudget
        ? Object.entries(layout.densityBudget).map(([key, value]) => `${key}=${value}`).join(", ")
        : "densityBudget=unknown";
      return [
        `- ${layout.id}`,
        `role=${layout.role ?? "unknown"}`,
        density,
        `canvasRequired=${layout.canvasRequired ? "yes" : "no"}`,
        `tags=${(layout.tags ?? []).join("|") || "none"}`
      ].join("; ");
    }).join("\n");
  }

  return skill.layoutNames.map((name) => `- ${name}`).join("\n");
}

function themeCatalogText(skill: SkillPack, assetManifest?: SkillAssetManifestLike) {
  if (assetManifest?.themes?.length) {
    return assetManifest.themes.map((theme) => {
      const palette = theme.palette
        ? PALETTE_KEYS_FOR_PROMPT
          .map((key) => {
            const value = theme.palette?.[key];
            return value ? `${key}=${value}` : "";
          })
          .filter(Boolean)
          .join(", ")
        : "palette=unknown";
      return [
        `- ${theme.id}`,
        `mood=${theme.mood ?? "unknown"}`,
        palette || "palette=unknown",
        `tags=${(theme.tags ?? []).join("|") || "none"}`
      ].join("; ");
    }).join("\n");
  }

  return skill.themeNames.map((name) => `- ${name}`).join("\n");
}

function fullDeckCatalogText(skill: SkillPack, assetManifest?: SkillAssetManifestLike) {
  if (assetManifest?.fullDecks?.length) {
    return assetManifest.fullDecks.map((deck) => [
      `- ${deck.id}`,
      `deckClass=${deck.deckClass ?? "unknown"}`,
      `themesReferenced=${(deck.themesReferenced ?? []).join("|") || "none"}`,
      `animationsUsed=${(deck.animationsUsed ?? []).join("|") || "none"}`,
      `tags=${(deck.tags ?? []).join("|") || "none"}`
    ].join("; ")).join("\n");
  }

  return skill.templateNames.map((name) => `- ${name}`).join("\n");
}

function compactReferenceText(skill: SkillPack) {
  return skill.referenceSources
    .map((item) => `--- ${item.name}/index.html ---\n${item.index}\n--- ${item.name}/style.css ---\n${item.css}`)
    .join("\n\n");
}

export function buildPrompt(stage: "research", ctx: ResearchPromptContext): PromptEnvelope;
export function buildPrompt(stage: "content-plan", ctx: ContentPlanPromptContext): PromptEnvelope;
export function buildPrompt(stage: "visual-plan", ctx: VisualPlanPromptContext): PromptEnvelope;
export function buildPrompt(stage: "section-batch", ctx: SectionBatchPromptContext): PromptEnvelope;
export function buildPrompt(stage: "css", ctx: CssPromptContext): PromptEnvelope;
export function buildPrompt(stage: PromptStage, ctx: ResearchPromptContext | ContentPlanPromptContext | VisualPlanPromptContext | SectionBatchPromptContext | CssPromptContext): PromptEnvelope {
  const baseConstraints = buildBaseConstraints(ctx.skill);

  switch (stage) {
    case "research":
      {
      const researchCtx = ctx as ResearchPromptContext;
      return {
        system: "You are a PPT content researcher. Return one strict JSON object only.",
        user: [
          baseConstraints,
          researchCtx.userContextText,
          "Compile a compact topic research pack for an HTML PPT deck.",
          "No external search API is connected in this phase. If any fact may be time-sensitive or unverifiable, place it in needVerification.",
          'Return JSON only: { "topicSummary": "string", "keyFacts": ["string"], "narrativeAngles": ["string"], "suggestedSections": ["string"], "needVerification": ["string"] }'
        ].join("\n\n")
      };
      }
    case "content-plan":
      {
      const planCtx = ctx as ContentPlanPromptContext;
      return {
        system: "You are the chief content editor for an HTML PPT generator. Return one strict JSON object only.",
        user: [
          baseConstraints,
          planCtx.userContextText,
          `Research:\n${JSON.stringify(planCtx.research)}`,
          `Layout catalog:\n${layoutCatalogText(planCtx.skill, planCtx.assetManifest)}`,
          `Allowed layoutId values:\n${planCtx.skill.layoutNames.join(", ")}`,
          [
            "Planning rules:",
            "1. Every slide must select one layoutId from the allowed catalog.",
            "2. layoutId defines the stable page skeleton; keyPoints carry the content creativity.",
            "3. Avoid repeating the same layout for the whole deck unless the topic truly requires it.",
            "4. Cover and TOC should open the deck; timelines, KPI grids, comparisons, process pages, multi-column pages, and roadmaps should carry the body; CTA or thanks should close it.",
            "5. keyPoints must be concrete and presentation-ready, not abstract placeholders."
          ].join("\n"),
          'Return JSON only: { "title": "string", "subtitle": "string?", "slideCount": 8, "audience": "string", "objective": "string", "slides": [{ "index": 1, "title": "string", "type": "string", "layoutId": "string", "goal": "string", "keyPoints": ["string"] }] }'
        ].join("\n\n")
      };
      }
    case "visual-plan":
      {
      const visualCtx = ctx as VisualPlanPromptContext;
      return {
        system: "You are the visual director for an HTML PPT generator. Return one strict JSON object only.",
        user: [
          baseConstraints,
          `Plan:\n${JSON.stringify(visualCtx.plan)}`,
          `Theme catalog:\n${themeCatalogText(visualCtx.skill, visualCtx.assetManifest)}`,
          `Full deck catalog:\n${fullDeckCatalogText(visualCtx.skill, visualCtx.assetManifest)}`,
          `Reference snippets:\n${compactReferenceText(visualCtx.skill)}`,
          [
            "Theme selection rules:",
            "1. Pick the primaryTheme by topic fit, palette fit, and deck tone, not by habit.",
            "2. Do not repeatedly default to tokyo-night, aurora, or cyberpunk-neon for every technical topic.",
            "3. If the topic is serious, documentary, enterprise, research, or systems-oriented, strongly consider blueprint, engineering-whiteprint, swiss-grid, corporate-clean, academic-paper, or magazine-bold when they fit.",
            "4. Only choose dark neon / purple-heavy themes when the topic explicitly benefits from cyber, nightlife, gaming, sci-fi, or high-energy futuristic aesthetics."
          ].join("\n"),
          'Return JSON only: { "primaryTheme": "string", "backupThemes": ["string"], "referenceTemplates": ["string"], "deckClass": "string", "visualLanguage": "string", "slideVisuals": [{ "index": 1, "composition": "string", "animation": "string?", "fx": "string?" }] }'
        ].join("\n\n")
      };
      }
    case "section-batch":
      {
      const sectionCtx = ctx as SectionBatchPromptContext;
      return {
        system: [
          "You are a senior HTML PPT author.",
          "Output only one or more <section class=\"slide\"> fragments.",
          "Do not output markdown, do not output full HTML, head, or body.",
          "Rewrite content on top of the provided single-page layout skeletons.",
          "Do not generate notes, speaker notes, scripts, or transcript blocks."
        ].join(" "),
        user: [
          baseConstraints,
          sectionCtx.userContextText,
          `Deck title: ${sectionCtx.plan.title}`,
          `Deck subtitle: ${sectionCtx.plan.subtitle ?? ""}`,
          `Visual language: ${sectionCtx.visual.visualLanguage}`,
          `Deck class: ${sectionCtx.visual.deckClass}`,
          `Primary theme: ${sectionCtx.visual.primaryTheme}`,
          `Research:\n${JSON.stringify(sectionCtx.research).slice(0, 6000)}`,
          `Slides in this batch:\n${JSON.stringify(sectionCtx.batch)}`,
          `Visual instructions for this batch:\n${JSON.stringify(sectionCtx.batchVisuals)}`,
          `Layout templates in this batch:\n${sectionCtx.layoutTemplates}`,
          sectionCtx.priorFailures?.length
            ? `Recent failed checks for this stage:\n${sectionCtx.priorFailures.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
            : "",
          [
            "Output rules:",
            "1. Output only the requested <section> fragments for this batch, in order.",
            "2. Each slide must reuse the matching layout template skeleton for its layoutId.",
            "3. Preserve the main class names and structure hierarchy from the template; only enrich the content and light semantic hooks.",
            "4. You may add limited semantic classes, data-anim, data-fx, and data-title attributes.",
            "5. Keep each slide information-dense but still readable in a single 16:9 screen.",
            "6. Do not use remote images and do not output code fences.",
            "7. Do not output notes, speaker notes, transcript content, or hidden presenter copy.",
            "8. Do not leave blank cards, blank panels, empty metric labels, or empty metadata nodes.",
            "9. Keep inline style usage minimal; the main visual skin belongs in style.css.",
            "10. chart-* layouts may keep local canvas and Chart.js initialization; non-chart layouts must not use canvas.",
            "11. data-fx may only appear on the section or major decorative containers, never on metric numbers or tiny text nodes."
          ].join("\n")
        ].join("\n\n")
      };
      }
    case "css":
      {
      const cssCtx = ctx as CssPromptContext;
      return {
        system: [
          "You are a senior CSS visual designer.",
          "Output CSS only.",
          "Use html-ppt theme variables such as var(--bg), var(--surface), var(--text-1), var(--text-2), var(--accent), and var(--border)."
        ].join(" "),
        user: [
          baseConstraints,
          `Deck class: ${cssCtx.visual.deckClass}`,
          `Plan summary:\n${cssCtx.plan.title}\nslideCount=${cssCtx.plan.slideCount}\naudience=${cssCtx.plan.audience}\nobjective=${cssCtx.plan.objective}`,
          `Visual:\n${JSON.stringify(cssCtx.visual).slice(0, 7000)}`,
          `Layout contract:\n${cssCtx.layoutContract}`,
          cssCtx.selectedThemePalette ? `Selected theme palette:\n${cssCtx.selectedThemePalette}` : "",
          `Index summary:\n${cssCtx.indexHtmlSummary}`,
          cssCtx.priorFailures?.length
            ? `Recent failed checks for this stage:\n${cssCtx.priorFailures.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
            : "",
          `Reference CSS, compact:\n${cssCtx.skill.referenceSources.map((item) => `--- ${item.name} ---\n${item.css.slice(0, 2200)}`).join("\n\n")}`,
          [
            "CSS rules:",
            "1. Your CSS scope is narrow: only body/deck backgrounds, card/panel decoration, and typography emphasis.",
            "2. Do not invent runtime layout rules. Do not redesign the slide container, root flow, or top-level page structure.",
            "3. Allowed targets include descendants like .slide .card, .slide .grid, .kicker, .h1, .h2, .kpi-grid .metric, .deck::before, and theme decoration layers.",
            "4. Forbidden targets include bare .slide, .slide > * top-level layout, .progress-bar, @media, @supports, and any rule that sets position or overflow on .slide itself.",
            "5. Use only the selected theme palette and html-ppt variables for color decisions; do not invent random hex palettes.",
            "6. All major content must fit a 16:9 single-screen slide viewport.",
            "7. Scope your main selectors under body.<deckClass> to avoid polluting the runtime base styles."
          ].join("\n")
        ].filter(Boolean).join("\n\n")
      };
      }
  }
}
