import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deckIrSchema, type DeckIR, type SlideSlotFillIR } from "../ir";
import { DeckRendererService } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import { runRenderVerificationStage } from "../stages";

type LegacySlide = {
  index: number;
  title: string;
  body: string[];
};

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const inputDir = resolve(getArg("--input") || process.env.HTML_PPT_LEGACY_DECK_DIR || await findLatestLegacyDeck(workspaceRoot));
  const outputRoot = resolve(getArg("--output-root") || process.env.HTML_PPT_V2_MIGRATION_OUTPUT_ROOT || join(workspaceRoot, ".local-runtime", "html-ppt-v2", "legacy-migrations"));
  const deckId = safeDeckId(getArg("--deck-id") || basename(inputDir) || randomUUID());
  const outputDir = resolve(outputRoot, deckId);
  await mkdir(outputDir, { recursive: true });

  const [registry, legacyHtml, legacyManifest] = await Promise.all([
    hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt")),
    readFile(join(inputDir, "index.html"), "utf8"),
    readJson(join(inputDir, "manifest.json")).catch(() => ({}))
  ]);
  const slides = extractLegacySlides(legacyHtml);
  if (!slides.length) {
    throw new Error(`No <section class="slide"> blocks found in legacy deck: ${inputDir}`);
  }

  const deck = buildDeckIrFromLegacy({
    slides,
    title: stringValue(legacyManifest.title, slides[0]?.title || "Migrated HTML-PPT Deck"),
    registryHash: registry.hash
  });
  const renderer = new DeckRendererService();
  await renderer.renderToDirectory(deck, {
    outputDir,
    registryHash: registry.hash
  });
  const verification = await runRenderVerificationStage({
    outputDir,
    deck,
    registryHash: registry.hash
  });
  const report = {
    source: inputDir,
    outputDir,
    deckId,
    slideCount: deck.intent.derivedSlideCount,
    verification: {
      status: verification.status,
      hardIssueCount: verification.summary.hardIssueCount,
      warningCount: verification.summary.warningCount,
      screenshotCount: verification.summary.screenshotCount
    }
  };
  await writeFile(join(outputDir, "legacy-migration-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
}

function buildDeckIrFromLegacy(input: { slides: LegacySlide[]; title: string; registryHash: string }): DeckIR {
  const count = Math.max(1, Math.min(50, input.slides.length));
  const slides = input.slides.slice(0, count);
  const now = new Date().toISOString();
  const citationKey = "legacy-import";
  const narrativeSlides = slides.map((slide, offset) => {
    const role = offset === 0 ? "cover" : offset === 1 && count > 3 ? "toc" : offset === count - 1 ? "cta" : "analysis";
    const body = slide.body.length ? slide.body : [slide.title];
    return {
      index: offset + 1,
      role,
      beat: compactText(body[0] || slide.title, 120),
      contentBrief: {
        headline: compactText(slide.title || `Slide ${offset + 1}`, 120),
        subhead: body[0] ? compactText(body[0], 180) : undefined,
        supportingPoints: body.slice(0, 6).map((item) => compactText(item, 260)),
        evidenceRefs: [citationKey],
        keyMetrics: []
      },
      densityBudget: body.join("").length > 260 ? "dense" : "balanced",
      estimatedNarrativeChars: Math.max(120, body.join("").replace(/\s+/g, "").length)
    } as const;
  });
  const layoutPlan = narrativeSlides.map((slide) => ({
    slideIndex: slide.index,
    layoutId: slide.role === "cover" ? "cover" : slide.role === "toc" ? "toc" : slide.role === "cta" ? "cta" : "two-column",
    capacityCheck: { passed: true, details: "Legacy migration selected a conservative deterministic layout." },
    variancePosition: slide.index - 1
  }));
  const slots = narrativeSlides.map((slide): SlideSlotFillIR => {
    const points = slide.contentBrief.supportingPoints;
    if (slide.role === "cover") {
      return {
        slideIndex: slide.index,
        kind: "cover",
        title: slide.contentBrief.headline,
        kicker: "Legacy Migration",
        subtitle: slide.contentBrief.subhead ?? points[0] ?? input.title,
        meta: [`${count} slides`, "v2 deterministic renderer"],
        citationKeys: [citationKey]
      };
    }
    if (slide.role === "toc") {
      const items = narrativeSlides.slice(2, Math.min(count, 8)).map((item) => ({
        label: compactText(item.contentBrief.headline, 56),
        description: compactText(item.contentBrief.supportingPoints[0] ?? item.beat, 96)
      }));
      return {
        slideIndex: slide.index,
        kind: "toc",
        title: slide.contentBrief.headline,
        kicker: "Agenda",
        items: items.length ? items : [{ label: "Overview", description: "Migrated from the legacy deck structure." }],
        citationKeys: [citationKey]
      };
    }
    if (slide.role === "cta") {
      return {
        slideIndex: slide.index,
        kind: "cta",
        title: slide.contentBrief.headline,
        kicker: "Closing",
        headline: slide.contentBrief.headline,
        action: compactText(points[0] ?? "Review the migrated deck and refine content where needed.", 140),
        supportingText: compactText(points.slice(1).join(" ") || "This deck was reconstructed from a legacy HTML output into typed V2 IR.", 200),
        citationKeys: [citationKey]
      };
    }
    return {
      slideIndex: slide.index,
      kind: "two-column",
      title: slide.contentBrief.headline,
      kicker: "Migrated",
      leftTitle: compactText(points[0] ?? slide.contentBrief.headline, 60),
      leftBody: compactText(points[1] ?? points[0] ?? slide.beat, 220),
      rightTitle: compactText(points[2] ?? "Key point", 60),
      rightBody: compactText(points.slice(3).join(" ") || points[1] || slide.beat, 220),
      bullets: points.slice(0, 4).map((item) => compactText(item, 70)),
      citationKeys: [citationKey]
    };
  });

  return deckIrSchema.parse({
    intent: {
      topic: input.title,
      language: containsCjk(input.title + slides.map((slide) => slide.body.join("")).join("")) ? "zh-CN" : "en",
      audience: "general-public",
      tone: "analytical",
      format: "briefing",
      hardConstraints: { slideCount: count, requiredSections: [] },
      preferences: { aestheticHints: ["legacy migration"], forbiddenThemes: [], domainTerminology: [], knowledgeCutoffWarning: false },
      derivedSlideCount: count,
      derivedNarrativeChars: Math.max(600, narrativeSlides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0))
    },
    evidence: {
      facts: [{
        claim: "This deck was migrated from an existing legacy HTML-PPT output.",
        confidence: "medium",
        sources: [{ url: "https://example.invalid/html-ppt-v2/legacy-migration", title: "Legacy HTML-PPT deck", type: "rag" }],
        citationKey
      }],
      dataPoints: [],
      candidateVisuals: [],
      terminology: [],
      narrativeAngles: [{ angle: "Preserve legacy content while moving to deterministic v2 rendering.", tradeoffs: "Visual fidelity is approximate because legacy free-form HTML is converted into typed layouts." }],
      knownGaps: ["Legacy-to-IR migration is structural and may need manual content polish."]
    },
    narrative: {
      arc: "thematic-clusters",
      slides: narrativeSlides,
      totalEstimatedChars: narrativeSlides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0),
      transitions: narrativeSlides.slice(1).map((slide, offset) => ({
        fromSlide: offset + 1,
        toSlide: slide.index,
        bridge: "Continue the migrated narrative in the original slide order."
      }))
    },
    design: buildMigrationDesign(),
    layoutPlan,
    slots,
    assets: {},
    choreography: narrativeSlides.map((slide) => ({
      slideIndex: slide.index,
      entrance: "fade-up",
      builds: slide.role === "analysis" ? [{ target: "card", anim: "stagger-list", delay: 80 }] : [],
      fx: slide.role === "cover" || slide.role === "cta" ? "soft-glow" : "none"
    })),
    meta: {
      irVersion: "v1",
      revisionRound: 0,
      qualityScores: { factual: 0.6, narrative: 0.7, visual: 0.72, density: 0.72, accessibility: 0.86, overall: 0.72 },
      generatedAt: now,
      checkpoints: [{
        stage: "stage-10:legacy-migration",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: `Migrated legacy deck into typed V2 IR. registryHash=${input.registryHash}`
      }]
    }
  });
}

function buildMigrationDesign(): DeckIR["design"] {
  return {
    themeId: "engineering-whiteprint",
    themeTokens: {
      palette: {
        bg: "#f8fafc",
        surface: "#ffffff",
        surface2: "#eaf2f8",
        accent: "#0f766e",
        accent2: "#2563eb",
        accent3: "#f59e0b",
        text1: "#0f172a",
        text2: "#475569",
        border: "#cbd5e1",
        good: "#16a34a",
        warn: "#d97706",
        bad: "#dc2626"
      },
      typography: { fontDisplay: "Sora", fontBody: "Manrope", fontMono: "IBM Plex Mono", scaleRatio: 1.18, baseSize: 18 },
      geometry: { radiusSm: 8, radiusMd: 18, radiusLg: 32, gapSm: 12, gapMd: 24, gapLg: 40 },
      elevation: {
        shadowSm: "0 4px 16px rgba(15, 23, 42, 0.08)",
        shadowMd: "0 14px 32px rgba(15, 23, 42, 0.12)",
        shadowLg: "0 24px 64px rgba(15, 23, 42, 0.16)"
      },
      motion: { easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", durationFast: 160, durationBase: 420, durationSlow: 900 }
    },
    donorTemplateId: "tech-sharing",
    donorContract: {
      id: "tech-sharing",
      decorativeClasses: ["ts-grid", "ts-glow"],
      coverOnlyClasses: ["ts-hero-orbit"],
      bodyAllowedClasses: ["ts-panel", "ts-kicker", "ts-card"],
      dnaSignature: {
        titleTreatment: "precise technical heading with restrained accent",
        cardTreatment: "white panel with thin engineering border",
        kickerTreatment: "small uppercase technical label",
        accentRule: "one teal accent per slide",
        density: "balanced"
      },
      forbiddenTextPatterns: ["Halo v2", "fin", "cta final"]
    },
    deckClass: "tpl-tech-sharing",
    contrastReport: { passed: true, minContrastRatio: 7.8, issues: [] },
    animationBudget: { allowedAnims: ["fade-up", "stagger-list", "none"], allowedFx: ["soft-glow", "none"], maxAccentSlides: 2, fxAllowedRoles: ["cover", "cta"] },
    accentPolicy: "static",
    audienceFitReport: { score: 0.86, reasons: ["Conservative migration theme preserves readability.", "Deterministic layout avoids legacy free-form CSS drift."] }
  };
}

function extractLegacySlides(html: string): LegacySlide[] {
  const sections = [...html.matchAll(/<section\b[^>]*class=["'][^"']*\bslide\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi)];
  return sections.map((match, offset) => {
    const section = match[0] || "";
    const title =
      textFromFirst(section, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
      textFromFirst(section, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i) ||
      attrValue(section, "data-title") ||
      `Slide ${offset + 1}`;
    const body = [...section.matchAll(/<(p|li|h3|h4|small)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((item) => cleanText(item[2] || ""))
      .filter((item) => item.length >= 4 && !/方向键|Ctrl\+S|edit mode|按\s*T/i.test(item))
      .slice(0, 10);
    return {
      index: offset + 1,
      title: compactText(cleanText(title), 120),
      body: body.length ? body : [compactText(cleanText(section), 220)]
    };
  });
}

function textFromFirst(html: string, pattern: RegExp) {
  const match = html.match(pattern);
  return match ? cleanText(match[1] || "") : "";
}

function attrValue(html: string, name: string) {
  const match = html.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
}

function cleanText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string, max: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() : text || "Migrated content";
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function containsCjk(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function findLatestLegacyDeck(workspaceRoot: string) {
  const root = resolve(workspaceRoot, ".local-runtime", "html-ppt-decks");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const dir = join(root, entry.name);
    const manifest = join(dir, "manifest.json");
    return existsSync(manifest) ? { dir, mtimeMs: (await stat(manifest)).mtimeMs } : null;
  }));
  const latest = dirs.filter(Boolean).sort((a, b) => b!.mtimeMs - a!.mtimeMs)[0];
  if (!latest) {
    throw new Error(`No legacy deck found under ${root}; pass --input <legacy-deck-dir>.`);
  }
  return latest.dir;
}

function getArg(name: string) {
  const args = process.argv.slice(2);
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === name) return args[index + 1] ?? "";
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

function safeDeckId(value: string) {
  return value.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || randomUUID();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
