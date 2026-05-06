import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deckIrSchema, type DeckIR, type NarrativeSlideIR, type SlideSlotFillIR } from "../ir";
import { DeckRendererService } from "../renderer";
import { hydrateHtmlPptV2SkillRegistry, type SkillRegistry, type TemplatePackage } from "../registry";
import { runAuxiliaryArtifactsStage, runRenderVerificationStage, type RenderVerificationReport } from "../stages";

type BackfillRecord = {
  userId: string;
  deckId: string;
  outputDir: string;
  action: "rerendered" | "skipped" | "failed";
  reason?: string;
  beforeLeakedInternalTokens?: boolean;
  verification?: {
    status: "clean" | "warning" | "failed";
    hardIssueCount: number;
    warningCount: number;
  };
  artifactsWritten?: boolean;
};

type BackfillReport = {
  schemaVersion: "html-ppt-v2-backfill-report-v1";
  generatedAt: string;
  publishedRoot: string;
  registryHash: string;
  dryRun: boolean;
  filters: {
    userId?: string;
    deckId?: string;
    limit?: number;
  };
  summary: {
    scanned: number;
    rerendered: number;
    skipped: number;
    failed: number;
  };
  records: BackfillRecord[];
};

type MutableManifest = {
  deckIr?: unknown;
  donorTemplateId?: string;
  deckClass?: string;
  themeId?: string;
};

const INTERNAL_LEAK_HARD_CODES = new Set([
  "internal-citation-key-visible",
  "fallback-planning-phrase-visible",
  "fallback-terminology-phrase-visible",
  "fallback-layout-placeholder-visible"
]);

const INTERNAL_TOKEN_PATTERN = /\b(?:section-\d+|required-section-\d+|topic-brief|audience-brief|request-scope|requested-slides|requested-length)\b/giu;
const INTERNAL_SENTENCE_PATTERNS = [
  /needs a clear opening context/iu,
  /should be optimized for/iu,
  /requested output is locked to/iu,
  /scope should stay concise enough to fit/iu,
  /fallback evidence is generated from intentir/iu,
  /local fallback evidence generated from intentir/iu,
  /is treated as a key term to preserve accurately/iu,
  /is a core term that should stay precise and audience-appropriate/iu,
  /reserved section generated to keep the deterministic toc layout valid/iu
] as const;

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const skillRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt");
  const publishedRoot = resolve(
    getArg("--root")
    || process.env.HTML_PPT_V2_PUBLISHED_ROOT
    || join(workspaceRoot, ".local-runtime", "html-ppt-v2", "published")
  );
  const dryRun = hasFlag("--dry-run");
  const userIdFilter = getArg("--user") || process.env.HTML_PPT_V2_BACKFILL_USER_ID || "";
  const deckIdFilter = getArg("--deck") || process.env.HTML_PPT_V2_BACKFILL_DECK_ID || "";
  const limit = parsePositiveInt(getArg("--limit") || process.env.HTML_PPT_V2_BACKFILL_LIMIT || "");

  const registry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  const renderer = new DeckRendererService();
  const deckDirs = await collectPublishedDeckDirs(publishedRoot, {
    userId: userIdFilter,
    deckId: deckIdFilter,
    limit
  });
  const records: BackfillRecord[] = [];

  for (const deckDir of deckDirs) {
    records.push(await backfillPublishedDeck({
      deckDir,
      registry,
      renderer,
      dryRun
    }));
  }

  const report: BackfillReport = {
    schemaVersion: "html-ppt-v2-backfill-report-v1",
    generatedAt: new Date().toISOString(),
    publishedRoot,
    registryHash: registry.hash,
    dryRun,
    filters: {
      ...(userIdFilter ? { userId: userIdFilter } : {}),
      ...(deckIdFilter ? { deckId: deckIdFilter } : {}),
      ...(limit ? { limit } : {})
    },
    summary: {
      scanned: records.length,
      rerendered: records.filter((record) => record.action === "rerendered").length,
      skipped: records.filter((record) => record.action === "skipped").length,
      failed: records.filter((record) => record.action === "failed").length
    },
    records
  };

  const reportDir = resolve(workspaceRoot, ".local-runtime", "html-ppt-v2");
  await mkdir(reportDir, { recursive: true });
  const reportFile = join(reportDir, `backfill-report-${timestampSlug(new Date())}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportFile, ...report.summary }, null, 2));
}

async function backfillPublishedDeck(input: {
  deckDir: { userId: string; deckId: string; outputDir: string };
  registry: SkillRegistry;
  renderer: DeckRendererService;
  dryRun: boolean;
}): Promise<BackfillRecord> {
  const { deckDir, registry, renderer, dryRun } = input;
  const manifestPath = join(deckDir.outputDir, "manifest.json");
  const indexPath = join(deckDir.outputDir, "index.html");

  try {
    const manifest = await readJson<MutableManifest>(manifestPath);
    const parsedDeck = deckIrSchema.safeParse(manifest.deckIr);
    if (!parsedDeck.success) {
      return {
        ...deckDir,
        action: "skipped",
        reason: "manifest.json does not contain a valid deckIr snapshot."
      };
    }

    const deck = parsedDeck.data;
    const selectedTemplate = resolveSelectedTemplatePackageFromDeck(registry, deck, manifest);
    const beforeIndexHtml = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "";
    const beforeLeakedInternalTokens = hasVisibleInternalTokenLeak(beforeIndexHtml);

    if (dryRun) {
      return {
        ...deckDir,
        action: "skipped",
        reason: "dry-run",
        beforeLeakedInternalTokens
      };
    }

    let activeDeck = deck;
    let verification = await rerenderAndVerify({
      deck: activeDeck,
      outputDir: deckDir.outputDir,
      renderer,
      registry,
      selectedTemplate
    });

    if (verification.status === "failed" && shouldRetrySanitizedBackfill(verification)) {
      const sanitizedDeck = sanitizeDeckForBackfill(activeDeck);
      verification = await rerenderAndVerify({
        deck: sanitizedDeck,
        outputDir: deckDir.outputDir,
        renderer,
        registry,
        selectedTemplate
      });
      activeDeck = sanitizedDeck;
    }

    if (verification.status !== "failed") {
      await runAuxiliaryArtifactsStage({
        deck: activeDeck,
        outputDir: deckDir.outputDir
      });
    }

    return {
      ...deckDir,
      action: verification.status === "failed" ? "failed" : "rerendered",
      ...(verification.status === "failed"
        ? { reason: verification.hardIssues.map((issue) => issue.message).join("; ") || "render verification failed after backfill." }
        : {}),
      beforeLeakedInternalTokens,
      verification: {
        status: verification.status,
        hardIssueCount: verification.summary.hardIssueCount,
        warningCount: verification.summary.warningCount
      },
      artifactsWritten: verification.status !== "failed"
    };
  } catch (error) {
    return {
      ...deckDir,
      action: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function collectPublishedDeckDirs(
  publishedRoot: string,
  filters: { userId?: string; deckId?: string; limit?: number }
): Promise<Array<{ userId: string; deckId: string; outputDir: string }>> {
  const userDirs = await readdir(publishedRoot, { withFileTypes: true }).catch(() => []);
  const records: Array<{ userId: string; deckId: string; outputDir: string; mtimeMs: number }> = [];

  for (const userDir of userDirs) {
    if (!userDir.isDirectory()) continue;
    if (filters.userId && userDir.name !== filters.userId) continue;
    const userRoot = join(publishedRoot, userDir.name);
    const deckDirs = await readdir(userRoot, { withFileTypes: true }).catch(() => []);
    for (const deckDir of deckDirs) {
      if (!deckDir.isDirectory()) continue;
      if (filters.deckId && deckDir.name !== filters.deckId) continue;
      const outputDir = join(userRoot, deckDir.name);
      const manifestPath = join(outputDir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const manifestStat = await stat(manifestPath).catch(() => undefined);
      records.push({
        userId: userDir.name,
        deckId: deckDir.name,
        outputDir,
        mtimeMs: manifestStat?.mtimeMs ?? 0
      });
    }
  }

  records.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = filters.limit ? records.slice(0, filters.limit) : records;
  return limited.map(({ userId, deckId, outputDir }) => ({ userId, deckId, outputDir }));
}

function resolveSelectedTemplatePackageFromDeck(
  registry: SkillRegistry,
  deck: DeckIR,
  manifest?: MutableManifest
): TemplatePackage | undefined {
  const donorTemplateId = manifest?.donorTemplateId ?? deck.design.donorTemplateId;
  const deckClass = manifest?.deckClass ?? deck.design.deckClass;
  const themeId = manifest?.themeId ?? deck.design.themeId;
  return registry.templatePackages.find((template) =>
    template.donorTemplateId === donorTemplateId
    && template.deckClass === deckClass
    && (template.themeId === themeId || template.themeAlternates.some((alternateThemeId) => alternateThemeId === themeId))
  );
}

async function rerenderAndVerify(input: {
  deck: DeckIR;
  outputDir: string;
  renderer: DeckRendererService;
  registry: SkillRegistry;
  selectedTemplate?: TemplatePackage;
}): Promise<RenderVerificationReport> {
  await input.renderer.renderToDirectory(input.deck, {
    outputDir: input.outputDir,
    registryHash: input.registry.hash,
    registry: input.registry
  });
  return runRenderVerificationStage({
    outputDir: input.outputDir,
    deck: input.deck,
    registryHash: input.registry.hash,
    selectedTemplate: input.selectedTemplate
  });
}

function shouldRetrySanitizedBackfill(verification: RenderVerificationReport): boolean {
  return verification.hardIssues.some((issue) => INTERNAL_LEAK_HARD_CODES.has(issue.code));
}

function sanitizeDeckForBackfill(deck: DeckIR): DeckIR {
  const clone = JSON.parse(JSON.stringify(deck)) as DeckIR;
  clone.narrative.slides = clone.narrative.slides.map((slide) => sanitizeNarrativeSlide(slide));
  clone.narrative.totalEstimatedChars = clone.narrative.slides.reduce((sum, slide) => sum + slide.estimatedNarrativeChars, 0);
  clone.intent.derivedNarrativeChars = Math.max(
    clone.intent.hardConstraints.narrativeChars ?? 100,
    deck.intent.derivedNarrativeChars,
    clone.narrative.totalEstimatedChars
  );
  clone.narrative.transitions = clone.narrative.transitions.map((transition) => ({
    ...transition,
    bridge: sanitizeTextOrFallback(transition.bridge, "Continue to the next point.")
  }));

  const slideLookup = new Map(clone.narrative.slides.map((slide) => [
    slide.index,
    {
      headline: slide.contentBrief.headline,
      beat: slide.beat,
      points: slide.contentBrief.supportingPoints
    }
  ]));
  clone.slots = clone.slots.map((slot) => sanitizeSlotFill(slot, slideLookup.get(slot.slideIndex)));

  return deckIrSchema.parse(clone);
}

function sanitizeNarrativeSlide(slide: NarrativeSlideIR): NarrativeSlideIR {
  const headline = sanitizeTextOrFallback(slide.contentBrief.headline, `Slide ${slide.index}`);
  const beat = sanitizeTextOrFallback(slide.beat, headline);
  const subhead = sanitizeOptionalText(slide.contentBrief.subhead);
  const supportingPoints = slide.contentBrief.supportingPoints
    .map((point) => sanitizeOptionalText(point))
    .filter((point): point is string => Boolean(point));
  const safeSupportingPoints = supportingPoints.length ? supportingPoints : [beat];
  const keyMetrics = (slide.contentBrief.keyMetrics ?? [])
    .map((metric) => sanitizeOptionalText(metric))
    .filter((metric): metric is string => Boolean(metric));
  return {
    ...slide,
    beat,
    contentBrief: {
      ...slide.contentBrief,
      headline,
      ...(subhead ? { subhead } : {}),
      supportingPoints: safeSupportingPoints,
      ...(keyMetrics.length ? { keyMetrics } : {})
    },
    estimatedNarrativeChars: Math.max(
      slide.estimatedNarrativeChars,
      estimateNarrativeChars([headline, beat, subhead, ...safeSupportingPoints, ...keyMetrics])
    )
  };
}

function sanitizeSlotFill(
  slot: SlideSlotFillIR,
  slideSummary?: { headline: string; beat: string; points: string[] }
): SlideSlotFillIR {
  const fallbackHeadline = slideSummary?.headline || slot.title || "Key point";
  const fallbackBody = slideSummary?.points[0] || slideSummary?.beat || fallbackHeadline;
  const base = {
    ...slot,
    title: sanitizeTextOrFallback(slot.title, fallbackHeadline),
    kicker: sanitizeOptionalText(slot.kicker),
    footer: sanitizeOptionalText(slot.footer)
  };

  switch (slot.kind) {
    case "cover":
      return {
        ...base,
        kind: "cover",
        subtitle: sanitizeOptionalText(slot.subtitle) ?? fallbackBody,
        meta: ensureNonEmptyArray(slot.meta.map((item) => sanitizeOptionalText(item)).filter((item): item is string => Boolean(item)), ["HTML-PPT v2"])
      };
    case "toc":
      return {
        ...base,
        kind: "toc",
        items: slot.items.map((item, index) => ({
          label: sanitizeTextOrFallback(item.label, `Topic ${index + 1}`),
          ...(sanitizeOptionalText(item.description) ? { description: sanitizeOptionalText(item.description) } : {})
        }))
      };
    case "two-column":
      return {
        ...base,
        kind: "two-column",
        leftTitle: sanitizeTextOrFallback(slot.leftTitle, base.title),
        leftBody: sanitizeTextOrFallback(slot.leftBody, fallbackBody),
        rightTitle: sanitizeTextOrFallback(slot.rightTitle, `${base.title} detail`),
        rightBody: sanitizeTextOrFallback(slot.rightBody, slideSummary?.points[1] || fallbackBody),
        bullets: ensureNonEmptyArray(slot.bullets.map((item) => sanitizeOptionalText(item)).filter((item): item is string => Boolean(item)), [fallbackBody]).slice(0, 8)
      };
    case "three-column":
      return {
        ...base,
        kind: "three-column",
        cards: slot.cards.map((card, index) => ({
          ...card,
          title: sanitizeTextOrFallback(card.title, `${base.title} ${index + 1}`),
          body: sanitizeTextOrFallback(card.body, fallbackBody)
        }))
      };
    case "kpi-grid":
      return {
        ...base,
        kind: "kpi-grid",
        metrics: slot.metrics.map((metric, index) => ({
          ...metric,
          label: sanitizeTextOrFallback(metric.label, `Metric ${index + 1}`),
          value: sanitizeTextOrFallback(metric.value, "TBD"),
          ...(sanitizeOptionalText(metric.note) ? { note: sanitizeOptionalText(metric.note) } : {})
        })),
        ...(sanitizeOptionalText(slot.summary) ? { summary: sanitizeOptionalText(slot.summary) } : {})
      };
    case "timeline":
      return {
        ...base,
        kind: "timeline",
        events: slot.events.map((event, index) => ({
          ...event,
          label: sanitizeTextOrFallback(event.label, `Milestone ${index + 1}`),
          ...(sanitizeOptionalText(event.date) ? { date: sanitizeOptionalText(event.date) } : {}),
          description: sanitizeTextOrFallback(event.description, fallbackBody)
        }))
      };
    case "comparison":
      return {
        ...base,
        kind: "comparison",
        left: {
          ...slot.left,
          title: sanitizeTextOrFallback(slot.left.title, `${base.title} A`),
          body: sanitizeTextOrFallback(slot.left.body, fallbackBody)
        },
        right: {
          ...slot.right,
          title: sanitizeTextOrFallback(slot.right.title, `${base.title} B`),
          body: sanitizeTextOrFallback(slot.right.body, fallbackBody)
        },
        ...(sanitizeOptionalText(slot.verdict) ? { verdict: sanitizeOptionalText(slot.verdict) } : {})
      };
    case "bullet-list":
      return {
        ...base,
        kind: "bullet-list",
        ...(sanitizeOptionalText(slot.lede) ? { lede: sanitizeOptionalText(slot.lede) } : {}),
        groups: slot.groups.map((group, index) => ({
          ...group,
          title: sanitizeTextOrFallback(group.title, `${base.title} ${index + 1}`),
          items: ensureMinArraySize(
            group.items.map((item) => sanitizeOptionalText(item)).filter((item): item is string => Boolean(item)),
            2,
            [fallbackBody, slideSummary?.points[1] || "Additional detail"]
          ).slice(0, 5)
        }))
      };
    case "process":
      return {
        ...base,
        kind: "process",
        ...(sanitizeOptionalText(slot.lede) ? { lede: sanitizeOptionalText(slot.lede) } : {}),
        steps: slot.steps.map((step, index) => ({
          ...step,
          label: sanitizeTextOrFallback(step.label, `Step ${index + 1}`),
          title: sanitizeTextOrFallback(step.title, `${base.title} ${index + 1}`),
          description: sanitizeTextOrFallback(step.description, fallbackBody)
        }))
      };
    case "cta":
      return {
        ...base,
        kind: "cta",
        headline: sanitizeTextOrFallback(slot.headline, base.title),
        action: sanitizeTextOrFallback(slot.action, "Continue the next action."),
        ...(sanitizeOptionalText(slot.supportingText) ? { supportingText: sanitizeOptionalText(slot.supportingText) } : {})
      };
    case "chart":
      return {
        ...base,
        kind: "chart",
        chartType: slot.chartType,
        dataAssetKey: slot.dataAssetKey,
        insight: sanitizeTextOrFallback(slot.insight, fallbackBody)
      };
    case "image-hero":
      return {
        ...base,
        kind: "image-hero",
        ...(sanitizeOptionalText(slot.lede) ? { lede: sanitizeOptionalText(slot.lede) } : {}),
        ...(sanitizeOptionalText(slot.imageAssetKey) ? { imageAssetKey: sanitizeOptionalText(slot.imageAssetKey) } : {}),
        ...(sanitizeOptionalText(slot.imageAlt) ? { imageAlt: sanitizeOptionalText(slot.imageAlt) } : {}),
        ...(sanitizeOptionalText(slot.visualLabel) ? { visualLabel: sanitizeOptionalText(slot.visualLabel) } : {}),
        body: sanitizeTextOrFallback(slot.body, fallbackBody),
        chips: slot.chips.map((chip) => sanitizeTextOrFallback(chip, "Key point")).slice(0, 5)
      };
    case "quote":
      return {
        ...base,
        kind: "quote",
        quote: sanitizeTextOrFallback(slot.quote, fallbackBody),
        ...(sanitizeOptionalText(slot.attribution) ? { attribution: sanitizeOptionalText(slot.attribution) } : {}),
        ...(sanitizeOptionalText(slot.supportingText) ? { supportingText: sanitizeOptionalText(slot.supportingText) } : {})
      };
    case "section-divider":
      return {
        ...base,
        kind: "section-divider",
        marker: sanitizeSectionMarker(slot.marker, slot.slideIndex),
        ...(sanitizeOptionalText(slot.progressText) ? { progressText: sanitizeOptionalText(slot.progressText) } : {}),
        ...(sanitizeOptionalText(slot.supportingText) ? { supportingText: sanitizeOptionalText(slot.supportingText) } : {})
      };
    case "stat-highlight":
      return {
        ...base,
        kind: "stat-highlight",
        value: sanitizeTextOrFallback(slot.value, "TBD"),
        label: sanitizeTextOrFallback(slot.label, base.title),
        explanation: sanitizeTextOrFallback(slot.explanation, fallbackBody),
        cards: slot.cards.map((card, index) => ({
          ...card,
          title: sanitizeTextOrFallback(card.title, `${base.title} ${index + 1}`),
          body: sanitizeTextOrFallback(card.body, fallbackBody)
        }))
      };
    default:
      return base;
  }
}

function sanitizeSectionMarker(value: string, slideIndex: number): string {
  const sanitized = sanitizeOptionalText(value);
  if (!sanitized || /^section[-\s]*\d+$/iu.test(sanitized)) {
    return String(slideIndex).padStart(2, "0");
  }
  return sanitized;
}

function sanitizeOptionalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = sanitizeBackfillText(value);
  return trimmed || undefined;
}

function sanitizeTextOrFallback(value: string | undefined, fallback: string): string {
  const sanitized = sanitizeOptionalText(value);
  const safeFallback = sanitizeBackfillText(fallback).trim();
  return sanitized || safeFallback || "Key point";
}

function sanitizeBackfillText(value: string): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const parts = normalized
    .split(/(?<=[.!?。；;])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = (parts.length ? parts : [normalized]).filter((part) => !INTERNAL_SENTENCE_PATTERNS.some((pattern) => pattern.test(part)));
  const joined = kept.join(" ");
  return joined
    .replace(INTERNAL_TOKEN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureNonEmptyArray(values: string[], fallback: string[]): string[] {
  return values.length ? values : fallback;
}

function ensureMinArraySize(values: string[], minimum: number, fallback: string[]): string[] {
  const result = values.slice();
  for (const item of fallback) {
    if (result.length >= minimum) {
      break;
    }
    if (item) {
      result.push(item);
    }
  }
  return result.length >= minimum ? result : fallback.slice(0, minimum);
}

function estimateNarrativeChars(parts: Array<string | undefined>): number {
  const visibleChars = parts
    .filter((part): part is string => Boolean(part))
    .join("")
    .replace(/\s+/g, "")
    .length;
  return Math.max(120, Math.min(8000, visibleChars));
}

function hasVisibleInternalTokenLeak(indexHtml: string): boolean {
  if (!indexHtml) return false;
  const visibleText = indexHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\b(?:section-\d+|required-section-\d+|topic-brief|audience-brief|request-scope|requested-slides|requested-length)\b/iu.test(visibleText);
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
