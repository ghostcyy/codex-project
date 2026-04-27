import type {
  AgentPlan,
  DeckRequestRequirements,
  HtmlPptAgentInput,
  ReferenceComponentContract,
  ReferenceFullDeckSnippet,
  ResearchPack,
  SkillAssetManifestLike,
  SkillPack,
  VisualPlan
} from "./html-ppt-agent.types";
import type { CssPatchInstruction } from "./qa/css-patch-repair";

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
  | "css"
  | "css-patch";

type PromptBuilderOptions = {
  userContextText: string;
  skill: SkillPack;
  assetManifest?: SkillAssetManifestLike;
};

type ResearchPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
  requestRequirements?: DeckRequestRequirements;
};

type ContentPlanPromptContext = PromptBuilderOptions & {
  input: HtmlPptAgentInput;
  research: ResearchPack;
  requestRequirements?: DeckRequestRequirements;
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
  referenceFullDeck?: ReferenceFullDeckSnippet;
  allowedClassCatalog?: string;
  priorFailures?: string[];
};

type CssPromptContext = PromptBuilderOptions & {
  plan: AgentPlan;
  visual: VisualPlan;
  indexHtmlSummary: string;
  existingClassCatalog: string;
  layoutContract: string;
  selectedThemePalette?: string;
  priorFailures?: string[];
};

type CssPatchPromptContext = PromptBuilderOptions & {
  plan: AgentPlan;
  visual: VisualPlan;
  selectedThemePalette?: string;
  instructions: CssPatchInstruction[];
  currentStyleCssLength: number;
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

function requestRequirementsText(request?: DeckRequestRequirements) {
  if (!request || (!request.requestedSlideCount && !request.requestedNarrativeLength)) {
    return "Hard user request constraints:\n- No explicit slide-count or total-length requirement detected in the user prompt.";
  }

  const lines = ["Hard user request constraints (treat these as explicit requirements):"];
  if (request.requestedSlideCount) {
    lines.push(`- Slide count: EXACTLY ${request.requestedSlideCount} slides/pages.`);
  }
  if (request.requestedNarrativeLength) {
    const mode = request.narrativeLengthMode === "minimum" ? "AT LEAST" : "AROUND";
    const unit = request.narrativeLengthUnit === "words" ? "words" : "Chinese characters";
    lines.push(`- Total narrative length: ${mode} ${request.requestedNarrativeLength} ${unit} across the whole deck. Treat this as a real planning budget, not a casual hint.`);
  }
  return lines.join("\n");
}

function narrativePlanningPressureText(request?: DeckRequestRequirements, suggestedSlideCount?: number) {
  if (!request?.requestedNarrativeLength) {
    return "Narrative density guidance:\n- No explicit total-length target exists, so choose a balanced mix of cover, TOC, dividers, and body pages.";
  }

  const slideCount = request.requestedSlideCount ?? suggestedSlideCount ?? 8;
  const totalLength = request.requestedNarrativeLength;
  const unit = request.narrativeLengthUnit === "words" ? "words" : "Chinese characters";
  const avgPerSlide = Math.max(1, Math.round(totalLength / Math.max(1, slideCount)));
  const mode = request.narrativeLengthMode === "minimum" ? "minimum" : "target";
  const highDensity = request.narrativeLengthUnit !== "words" && avgPerSlide >= 120;
  const veryHighDensity = request.narrativeLengthUnit !== "words" && avgPerSlide >= 160;
  const maxLightSlides = veryHighDensity ? 3 : highDensity ? 4 : 5;
  return [
    "Narrative density guidance:",
    `- Planning budget: ${totalLength} ${unit} across ${slideCount} slides (${avgPerSlide} ${unit} per slide on average, ${mode} mode).`,
    `- Keep lightweight pages limited. For this request, target no more than ${maxLightSlides} lightweight pages total across cover / toc / section-divider / cta / thanks / big-quote.`,
    "- When the requested total length is high, prefer more body slides and denser layouts over decorative dividers.",
    "- Use higher per-slide length targets on body pages to justify bullets / two-column / timeline / roadmap / comparison layouts with sentence-level copy.",
    "- If tradeoffs are necessary, sacrifice extra divider pages before sacrificing body-page substance."
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

/**
 * Audience + tone -> theme shortlist, lifted directly from the html-ppt skill
 * authoring guide (`references/authoring-guide.md` step 2). The visual-plan
 * stage uses this as a hard first-pass filter before ranking themes by topic
 * fit, which prevents the model from defaulting to one or two themes.
 */
const AUDIENCE_THEME_TABLE = [
  "Audience and tone -> theme shortlist (skill authoring guide step 2):",
  "- Engineers / dev tools / CLI / infra: catppuccin-mocha, tokyo-night, dracula, gruvbox-dark, terminal-green, blueprint",
  "- Designers / product / creative / launch reveal: editorial-serif, aurora, soft-pastel, glassmorphism, magazine-bold",
  "- Executives / enterprise / serious / strategy: minimal-white, arctic-cool, swiss-grid, corporate-clean, sharp-mono",
  "- Researchers / academic / documentary / systems: academic-paper, blueprint, engineering-whiteprint, magazine-bold, swiss-grid",
  "- Consumers / lifestyle / 小红书 / wellbeing: xiaohongshu-white, sunset-warm, soft-pastel, japanese-minimal, midcentury",
  "- Cyber / sci-fi / gaming / nightlife / energy: cyberpunk-neon, vaporwave, y2k-chrome, retro-tv, tokyo-night",
  "- Pitch / VC / bold / launch keynote: neo-brutalism, sharp-mono, bauhaus, pitch-deck-vc, memphis-pop",
  "- News / journalism / magazine / editorial: news-broadcast, magazine-bold, editorial-serif, swiss-grid",
  "- Bilingual or Chinese-first dense text: xiaohongshu-white, editorial-serif, soft-pastel, academic-paper"
].join("\n");

function buildAudienceToneLine(plan: AgentPlan) {
  const tone = plan.tone ? `tone=${plan.tone}` : "";
  const format = plan.format ? `format=${plan.format}` : "";
  return [`audience=${plan.audience}`, tone, format].filter(Boolean).join(" · ");
}

/**
 * Layout -> recommended accent animation, taken from the html-ppt skill
 * `references/animations.md` and `references/authoring-guide.md` step 6.
 * One accent per slide; everything else stays calm. The runtime will silently
 * drop an unknown name, so the visual-plan model only needs to pick one of
 * these for each layout that appears in the deck.
 */
const LAYOUT_ANIMATION_HINTS = [
  "Layout -> recommended accent animation (one per slide, skill authoring guide step 6):",
  "- cover: blur-in or rise-in or perspective-zoom",
  "- toc: stagger-list",
  "- section-divider: cube-rotate-3d or perspective-zoom or ripple-reveal",
  "- bullets / process-steps / todo-checklist / roadmap / image-grid: stagger-list",
  "- two-column / pros-cons / diff: fade-left + fade-right paired by column",
  "- three-column: stagger-list",
  "- big-quote: typewriter or rise-in",
  "- stat-highlight / kpi-grid: counter-up",
  "- chart-line / chart-radar / flow-diagram / arch-diagram / mindmap / gantt: path-draw",
  "- chart-bar / chart-pie / table: stagger-list or fade-up",
  "- code / terminal: typewriter (and optionally neon-glow on terminal)",
  "- timeline: path-draw or shimmer-sweep",
  "- comparison: card-flip-3d for the reveal slide, otherwise fade-left + fade-right",
  "- image-hero: kenburns or blur-in",
  "- cta: zoom-pop or shimmer-sweep",
  "- thanks: confetti-burst or spotlight"
].join("\n");

const LAYOUT_FX_HINTS = [
  "Layout -> recommended canvas FX (decorative; only for cover / section-divider / stat / closing slides):",
  "- cover or section-divider on cyber/sci-fi/gaming themes: knowledge-graph, galaxy-swirl, particle-burst, constellation, matrix-rain",
  "- cover or section-divider on minimal/corporate/academic themes: gradient-blob, orbit-ring, sparkle-trail, data-stream",
  "- stat-highlight: counter-explosion or data-stream",
  "- thanks: firework or sparkle-trail or confetti-cannon",
  "- timeline / arch-diagram: orbit-ring or constellation",
  "Place fx only on the section element or a major decorative container, never on a single number node."
].join("\n");

function referenceComponentContractText(contract?: ReferenceComponentContract) {
  if (!contract) return "";
  const lines = ["Locked donor component contract:"];
  if (contract.donorPrefix) lines.push(`- donor class family prefix: ${contract.donorPrefix}-*`);
  if (contract.coverTitleClass) lines.push(`- cover title treatment: use ${contract.coverTitleClass} on cover / thanks / hero titles`);
  if (contract.bodyTitleClass) lines.push(`- body title treatment: use ${contract.bodyTitleClass} on body-slide main headings`);
  if (contract.kickerClass) lines.push(`- kicker / eyebrow treatment: use ${contract.kickerClass} for top labels`);
  if (contract.sectionLabelClass) lines.push(`- section label treatment: use ${contract.sectionLabelClass} for divider lines / section labels`);
  if (contract.cardClass) lines.push(`- primary card shell: use ${contract.cardClass} on generic cards / panels so border, fill, and radius stay consistent`);
  if (contract.footerClass) lines.push(`- footer treatment: use ${contract.footerClass} for slide footer / page label rows`);
  if (contract.titleTreatment) lines.push(`- title rhythm: ${contract.titleTreatment}`);
  if (contract.cardTreatment) lines.push(`- card treatment: ${contract.cardTreatment}`);
  if (contract.accentTreatment) lines.push(`- accent treatment: ${contract.accentTreatment}`);
  return lines.join("\n");
}

function referenceFullDeckBlock(reference?: ReferenceFullDeckSnippet) {
  if (!reference || reference.sections.length === 0) return "";
  const sections = reference.sections
    .map((section, index) => `--- reference section ${index + 1} ---\n${section.slice(0, 4500)}`)
    .join("\n\n");
  const cssLine = reference.cssExcerpt
    ? `\n--- ${reference.name}/style.css excerpt ---\n${reference.cssExcerpt.slice(0, 2400)}`
    : "";
  return [
    `Reference full-deck template: ${reference.name}`,
    "Inherit this template's visual DNA:",
    "- typography rhythm (kicker / h1 / h2 / lede sizing relationships),",
    "- card decoration style (border, shadow, accent stripe, soft fills),",
    "- accent colour placement (where the primary accent appears: pill, underline, number, gradient text),",
    "- spacing density and grid choices,",
    "- decorative motifs that recur (corner badge, frame, ruler, watermark, scanlines, etc).",
    referenceComponentContractText(reference.contract),
    "Map the reference patterns onto each layout in this batch even when the layoutId differs from the reference section. Do not copy reference text.",
    sections + cssLine
  ].filter(Boolean).join("\n\n");
}

export function buildPrompt(stage: "research", ctx: ResearchPromptContext): PromptEnvelope;
export function buildPrompt(stage: "content-plan", ctx: ContentPlanPromptContext): PromptEnvelope;
export function buildPrompt(stage: "visual-plan", ctx: VisualPlanPromptContext): PromptEnvelope;
export function buildPrompt(stage: "section-batch", ctx: SectionBatchPromptContext): PromptEnvelope;
export function buildPrompt(stage: "css", ctx: CssPromptContext): PromptEnvelope;
export function buildPrompt(stage: "css-patch", ctx: CssPatchPromptContext): PromptEnvelope;
export function buildPrompt(stage: PromptStage, ctx: ResearchPromptContext | ContentPlanPromptContext | VisualPlanPromptContext | SectionBatchPromptContext | CssPromptContext | CssPatchPromptContext): PromptEnvelope {
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
          requestRequirementsText(researchCtx.requestRequirements),
          "Compile a compact topic research pack for an HTML PPT deck.",
          [
            "Research output rules:",
            "1. If a hard slide-count requirement exists, `suggestedSlideCount` MUST equal that exact number.",
            "2. `perSlideLengthTargets` MUST contain exactly `suggestedSlideCount` entries, indexed 1..N with no gaps.",
            "3. Distribute the narrative length realistically: opening / divider / closing pages should be lighter, core body pages should be denser.",
            "4. If a total-length target exists, `perSlideLengthTargets` MUST add up closely to that target and must allocate most of the length to core body pages.",
            "5. `perSlideLengthTargets` are planning guidance for Stage 03, not a literal writing quota."
          ].join("\n"),
          "No external search API is connected in this phase. If any fact may be time-sensitive or unverifiable, place it in needVerification.",
          `Return JSON only: { "topicSummary": "string", "keyFacts": ["string"], "narrativeAngles": ["string"], "suggestedSections": ["string"], "needVerification": ["string"], "suggestedSlideCount": ${researchCtx.requestRequirements?.requestedSlideCount ?? 8}, "perSlideLengthTargets": [{ "index": 1, "targetLength": 80, "purpose": "opening hook" }] }`
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
          requestRequirementsText(planCtx.requestRequirements),
          narrativePlanningPressureText(planCtx.requestRequirements, planCtx.research.suggestedSlideCount),
          `Research:\n${JSON.stringify(planCtx.research)}`,
          `Per-slide length guidance from research:\nslideCountHint=${planCtx.research.suggestedSlideCount}\n${JSON.stringify(planCtx.research.perSlideLengthTargets)}`,
          `Layout catalog:\n${layoutCatalogText(planCtx.skill, planCtx.assetManifest)}`,
          `Allowed layoutId values:\n${planCtx.skill.layoutNames.join(", ")}`,
          [
            "Planning rules:",
            "1. Every slide must select one layoutId from the allowed catalog.",
            "2. layoutId defines the stable page skeleton; keyPoints carry the content creativity.",
            "2a. If a hard slide-count requirement exists, `slideCount` and `slides.length` MUST equal that exact number.",
            "2b. If no hard slide-count requirement exists, prefer `research.suggestedSlideCount` as the planning baseline.",
            "3. Avoid repeating the same layout for the whole deck unless the topic truly requires it.",
            "4. Cover and TOC should open the deck; timelines, KPI grids, comparisons, process pages, multi-column pages, and roadmaps should carry the body; CTA or thanks should close it.",
            "5. keyPoints must be concrete and presentation-ready, not abstract placeholders.",
            "6. Always emit `audience`, `tone`, and `format` so downstream stages can choose the right theme and visual register.",
            "   - audience: one short phrase describing the primary audience (e.g. 'engineers building dev tools', 'enterprise execs reviewing strategy', '小红书 lifestyle reader').",
            "   - tone: one of clinical, playful, editorial, cyber, enterprise, documentary, lifestyle, energetic, academic, friendly. Pick the single best fit.",
            "   - format: one of live-talk, pdf-handout, xhs-image, web-share, keynote, internal-memo. Pick the single best fit.",
            "6a. Use `perSlideLengthTargets` as page-density guidance when choosing structure. Lower targets fit cover/divider/cta/thanks/stat pages; medium targets fit comparison/KPI pages; higher targets fit bullets/two-column/timeline pages.",
            "6b. The length target is a hard planning budget for this stage. There is no QA word-count gate later, so Stage 03 must allocate enough dense body pages now.",
            "6c. If the user requested a high total narrative length, reduce decorative section-divider usage and prefer content-bearing layouts for middle slides.",
            "Narrative rhythm:",
            "7. Decks with more than 6 body slides must include `section-divider` slides between content sections. Recommended pattern: cover → toc → section-divider → 2-4 body → section-divider → 2-4 body → (optional section-divider → 2-4 body) → cta → thanks.",
            "8. Each section-divider slide should carry a concise section number + label in `title` (e.g. '02 · Approach', '03 · 实践') and 1-3 bullet keyPoints summarising what the next section covers.",
            "9. Distribute body slides evenly between section-dividers so no section runs longer than 4 body slides without a break.",
            "10. When a hard total-length target exists, the plan should be plausible for that target even before Stage 05 writes the actual HTML. Do not rely on later expansion to rescue an under-dense plan."
          ].join("\n"),
          `Return JSON only: { "title": "string", "subtitle": "string?", "slideCount": ${planCtx.requestRequirements?.requestedSlideCount ?? planCtx.research.suggestedSlideCount ?? 8}, "audience": "string", "tone": "string", "format": "string", "objective": "string", "slides": [{ "index": 1, "title": "string", "type": "string", "layoutId": "string", "goal": "string", "keyPoints": ["string"] }] }`
        ].join("\n\n")
      };
      }
    case "visual-plan":
      {
      const visualCtx = ctx as VisualPlanPromptContext;
      const lockedTemplateId =
        visualCtx.skill.templateNames.includes(visualCtx.input.pendingUserMessage.template?.id ?? "")
          ? visualCtx.input.pendingUserMessage.template?.id ?? ""
          : "";
      const lockedDeckClass =
        lockedTemplateId
          ? visualCtx.assetManifest?.fullDecks?.find((deck) => deck.id === lockedTemplateId)?.deckClass ?? `tpl-${lockedTemplateId}`
          : "";
      return {
        system: "You are the visual director for an HTML PPT generator. Return one strict JSON object only.",
        user: [
          baseConstraints,
          `Plan:\n${JSON.stringify(visualCtx.plan)}`,
          `Audience signal: ${buildAudienceToneLine(visualCtx.plan)}`,
          AUDIENCE_THEME_TABLE,
          LAYOUT_ANIMATION_HINTS,
          LAYOUT_FX_HINTS,
          `Theme catalog:\n${themeCatalogText(visualCtx.skill, visualCtx.assetManifest)}`,
          `Full deck catalog:\n${fullDeckCatalogText(visualCtx.skill, visualCtx.assetManifest)}`,
          `Reference snippets:\n${compactReferenceText(visualCtx.skill)}`,
          lockedTemplateId
            ? `Locked full-deck template:\nThe user explicitly selected template "${lockedTemplateId}". You MUST keep referenceTemplates as ["${lockedTemplateId}"] and MUST use deckClass "${lockedDeckClass}". Do not switch to another full-deck template in this stage.`
            : "",
          [
            "Theme selection process (apply in order):",
            "1. Find the audience+tone row in the shortlist table above. The primaryTheme MUST come from that row unless no row fits, in which case explain in visualLanguage and pick the closest neighbour row.",
            "2. Within the shortlisted themes, rank by topic fit, palette fit, and tone consistency.",
            "3. backupThemes must be 2-3 alternatives from the SAME row, so the runtime T-cycle stays coherent.",
            "4. Do not default to tokyo-night, aurora, dracula, or cyberpunk-neon when audience/tone do not call for cyber, nightlife, sci-fi, or high-energy futuristic aesthetics.",
            "5. Avoid repeating the user's last theme habitually; treat each topic on its own merits.",
            "Reference template selection:",
            lockedTemplateId
              ? `6. Because the user explicitly selected "${lockedTemplateId}", referenceTemplates must contain exactly that one full-deck name and no others.`
              : "6. referenceTemplates must list 1-3 full-deck names from the catalog whose deckClass and themesReferenced overlap with the chosen primaryTheme.",
            lockedTemplateId
              ? `7. deckClass must be "${lockedDeckClass}". The section author downstream will use "${lockedTemplateId}" as the visual-DNA donor.`
              : "7. Place the strongest match first; the section author downstream uses the first item as the visual-DNA donor.",
            "Slide-level variety:",
            "8. Pick the animation for each slideVisual from the layout-animation hints above for that slide's layoutId. Use one accent animation per slide; everything else stays calm.",
            "9. For 10+ slides, ensure at least 4 distinct animation presets across the deck so the rhythm does not feel monotone.",
            "10. Assign fx only on cover, section-divider, stat-highlight, thanks, and the deck's hero slide (typically slide 1 or the first body slide). For 10+ slides, target 2-4 slides with fx in total. Use the layout-fx hints above to choose.",
            "11. Never put fx on metric numbers, tiny captions, or tables; fx belongs on the section or a major decorative container."
          ].join("\n"),
          'Return JSON only: { "primaryTheme": "string", "backupThemes": ["string"], "referenceTemplates": ["string"], "deckClass": "string", "visualLanguage": "string", "slideVisuals": [{ "index": 1, "composition": "string", "animation": "string?", "fx": "string?" }] }'
        ].join("\n\n")
      };
      }
    case "section-batch":
      {
      const sectionCtx = ctx as SectionBatchPromptContext;
      const referenceBlock = referenceFullDeckBlock(sectionCtx.referenceFullDeck);
      return {
        system: [
          "You are a senior HTML PPT author.",
          "Output only one or more <section class=\"slide\"> fragments.",
          "Do not output markdown, do not output full HTML, head, or body.",
          "Rewrite content on top of the provided single-page layout skeletons while inheriting the visual DNA of the reference full-deck template.",
          "Do not generate notes, speaker notes, scripts, or transcript blocks."
        ].join(" "),
        user: [
          baseConstraints,
          sectionCtx.userContextText,
          `Deck title: ${sectionCtx.plan.title}`,
          `Deck subtitle: ${sectionCtx.plan.subtitle ?? ""}`,
          `Audience signal: ${buildAudienceToneLine(sectionCtx.plan)}`,
          `Visual language: ${sectionCtx.visual.visualLanguage}`,
          `Deck class: ${sectionCtx.visual.deckClass}`,
          `Primary theme: ${sectionCtx.visual.primaryTheme}`,
          `Research:\n${JSON.stringify(sectionCtx.research).slice(0, 6000)}`,
          `Slides in this batch:\n${JSON.stringify(sectionCtx.batch)}`,
          `Visual instructions for this batch:\n${JSON.stringify(sectionCtx.batchVisuals)}`,
          referenceBlock,
          `Layout templates in this batch:\n${sectionCtx.layoutTemplates}`,
          sectionCtx.allowedClassCatalog ? `Allowed class tokens for this batch:\n${sectionCtx.allowedClassCatalog}` : "",
          sectionCtx.priorFailures?.length
            ? `Recent failed checks for this stage:\n${sectionCtx.priorFailures.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
            : "",
          [
            "Output rules:",
            "1. Output only the requested <section> fragments for this batch, in order.",
            "2. Each slide must reuse the matching layout template skeleton for its layoutId; do not invent new top-level structures.",
            "3. Preserve the main class names and structure hierarchy from the layout skeleton; only enrich the content and light semantic hooks.",
            "4. Inherit visual DNA from the reference full-deck template: typography rhythm, card decoration style, accent placement, kicker / eyebrow patterns, decorative motifs. The reference is for visual style, not for text content.",
            "5. You may add only a small number of semantic classes, and every class token must come from the allowed class catalog above. Do not invent `xp-*`, `hero-*`, `feature-*`, or any other new class family outside that catalog. data-anim, data-fx, data-title, and data-arc are still allowed.",
            "5a. Keep every page title as one visual unit. Do not wrap only part of a heading sentence in styled spans, gradient spans, focus pills, or other intra-heading emphasis fragments.",
            "5b. Keep the donor template class family consistent across the deck. If the reference template provides title / kicker / card classes such as `xw-title-md`, `xw-kicker`, `xw-card`, keep using that family on body slides instead of falling back to generic `.h2`, `.kicker`, or unrelated skeleton naming.",
            "5c. Treat the donor component contract as mandatory on middle slides: keep the same title treatment, the same card background / border shell, the same kicker / footer / section-label family, and the same accent placement logic unless the layout skeleton truly has no slot for that component.",
            "6. Keep each slide information-dense but still readable in a single 16:9 screen.",
            "7. Do not use remote images and do not output code fences.",
            "8. Do not output notes, speaker notes, transcript content, or hidden presenter copy.",
            "9. Do not leave blank cards, blank panels, empty metric labels, or empty metadata nodes.",
            "10. Keep inline style usage minimal; the main visual skin belongs in style.css.",
            "11. chart-* layouts may keep local canvas and Chart.js initialization; non-chart layouts must not use canvas.",
            "12. data-fx may only appear on the section or major decorative containers, never on metric numbers or tiny text nodes.",
            "13. If a slideVisual provides animation, map it to section-level or major container data-anim.",
            "14. If a slideVisual provides fx, apply it on the section element unless the layout has no decorative region."
          ].join("\n")
        ].filter(Boolean).join("\n\n")
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
          `Exact class catalog already present in index.html:\n${cssCtx.existingClassCatalog}`,
          cssCtx.priorFailures?.length
            ? `Recent failed checks for this stage:\n${cssCtx.priorFailures.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
            : "",
          `Reference CSS, compact:\n${cssCtx.skill.referenceSources.map((item) => `--- ${item.name} ---\n${item.css.slice(0, 2200)}`).join("\n\n")}`,
          [
            "CSS rules — be ambitious within the contract; the runtime guard sanitizes anything you get wrong:",
            "",
            "ALLOWED (encouraged) — use these to deliver template-distinctive visuals:",
            "- body.<deckClass> background layers: gradients, radial washes, fixed grid masks, scanlines, paper textures, blueprint motifs, drifting blur orbs (build these with `body.<deckClass>::before` / `::after`).",
            "- body.<deckClass> .h1 / .h2 / .h3 / .lede / .kicker / .eyebrow typography overrides: font size with clamp(), weight, letter-spacing, gradient text via `background-clip: text`, italic display fonts.",
            "- body.<deckClass> .card / .card-soft / .card-outline / .card-accent decoration: border (including hard 1-2px borders), corner radius, accent stripe, soft inner glow, hover-less shadows, left-border highlight, accent dot.",
            "- body.<deckClass> .kpi-grid .metric .number / .metric-label / .delta typography and accent placement.",
            "- body.<deckClass> .timeline / .process-steps / .roadmap / .gantt / .comparison / .pros-cons internal decoration: connector lines, numbered badges, accent fills on the active step.",
            "- body.<deckClass> .grid.g2 / .g3 / .g4 gap and inner padding tweaks (do not change column count).",
            "- Decorative SVG / pseudo-element overlays scoped under body.<deckClass> (corner badges, frames, watermarks).",
            "- @keyframes definitions consumed by your own decorative pseudo-elements (not by .slide itself).",
            "",
            "THEME OWNERSHIP:",
            "- `primaryTheme` is the single source of truth for deck-level tokens such as --bg, --surface, --surface-2, --border, --text-1, --text-2, --accent, --accent-2, --accent-3, --grad, --shadow, --radius, and --font-sans.",
            "- The template may shape composition, typography rhythm, card decoration, and helper-class styling, but it must consume the active theme tokens instead of redefining them.",
            "",
            "FORBIDDEN — these break the runtime contract; the sanitizer will strip them:",
            "- bare `.slide` rules, `.slide > *` top-level layout, `.deck` size or position rewrites.",
            "- `position` / `overflow` declarations on .slide, .deck, or .progress-bar.",
            "- `.progress-bar` rules of any kind (runtime owns this).",
            "- `@media`, `@supports`, `@container` queries.",
            "- raw hex colour palettes invented from scratch; always reference the selected theme palette tokens or var(--bg), var(--surface), var(--accent), var(--text-1), var(--text-2), var(--border).",
            "- defining or overriding deck-level theme tokens (`--bg`, `--surface`, `--text-1`, `--accent`, `--grad`, `--shadow`, `--radius`, `--font-sans`, etc.) in `body.<deckClass>`, `.tpl-*`, or component rules.",
            "- column-count rewrites or vertical scrolling layouts; every slide must fit a 16:9 single screen.",
            "- inventing new semantic selectors whose class tokens do not already exist in the index.html class catalog above.",
            "- reinterpreting donor template classes into a different semantic role, for example turning a text-gradient class into a background box class.",
            "- reinterpreting donor layout helper classes such as `xw-grid-2`, `xw-grid-3`, `xw-topbar`, `xp-topbar`, `xp-page`, `xp-grid-2`, `xp-grid-3`, or `xw-card`; if the donor defines a two-column helper, keep it two columns instead of adding divider rails or extra structural columns.",
            "",
            "STRUCTURE:",
            "- Scope every selector under `body.<deckClass>` so the rules do not leak into other decks.",
            "- Only target class names that already exist in index.html. You may combine them, nest them, or add pseudo-elements, but do not mint new class tokens in CSS.",
            "- Keep page titles and section titles visually coherent. Do not rely on partial word styling inside one heading sentence.",
            "- Let the chosen theme own the palette; template helpers should style components by consuming theme vars, not by acting like a second theme layer.",
            "- Inherit visual DNA from the reference template excerpts above: match its kicker style, card border weight, accent placement, typography scale, decorative motifs.",
            "- Treat the CSS as the deck's visual identity layer; aim for a deck that is recognisably 'this template' at a glance, not a generic look."
          ].join("\n")
        ].filter(Boolean).join("\n\n")
      };
      }
    case "css-patch":
      {
      const cssPatchCtx = ctx as CssPatchPromptContext;
      return {
        system: [
          "You are a senior CSS repair specialist.",
          "Output CSS only.",
          "Append-only patch rules only.",
          "Every selector must start with the exact prefix body." + cssPatchCtx.visual.deckClass + " .slide:nth-child(",
          "Use only existing theme tokens such as var(--bg), var(--surface), var(--text-1), var(--text-2), var(--accent), var(--border), or template-local --variables that already exist in the deck.",
          "Do not output prose, markdown, comments, @media, @supports, @container, .progress-bar, .deck, or bare .slide rules."
        ].join(" "),
        user: [
          baseConstraints,
          `Deck class: ${cssPatchCtx.visual.deckClass}`,
          `Primary theme: ${cssPatchCtx.visual.primaryTheme}`,
          cssPatchCtx.selectedThemePalette ? `Selected theme palette:\n${cssPatchCtx.selectedThemePalette}` : "",
          `Plan summary:\n${cssPatchCtx.plan.title}\nslideCount=${cssPatchCtx.plan.slideCount}\naudience=${cssPatchCtx.plan.audience}\nobjective=${cssPatchCtx.plan.objective}`,
          `Current style.css length: ${cssPatchCtx.currentStyleCssLength}`,
          `Outliers to align:\n${cssPatchCtx.instructions.map((item, index) => `${index + 1}. slide=${item.slideIndex}; role=${item.role}; property=${item.property}; current=${String(item.currentValue)}; canonical=${String(item.canonicalValue)}; selector=${item.selector}`).join("\n")}`,
          [
            "Patch rules:",
            "1. Output CSS only.",
            "2. Each outlier may receive at most one rule block.",
            "3. Scope every rule to body.<deckClass> .slide:nth-child(N) plus the provided inner selector path.",
            "4. Prefer aligning to the canonical value rather than inventing a new style.",
            "5. Use font-size, line-height, font-family, color, border, border-radius, padding, or background fixes only.",
            "6. Do not change slide positioning, deck sizing, or progress bar behavior."
          ].join("\n")
        ].filter(Boolean).join("\n\n")
      };
      }
  }
}
