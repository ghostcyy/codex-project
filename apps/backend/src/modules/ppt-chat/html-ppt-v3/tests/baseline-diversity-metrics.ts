/**
 * Baseline diversity metrics for html-ppt-v3 Stage 1 planner.
 *
 * Three measurement layers:
 *   1) Pool inventory     — theoretical max diversity each template can offer (no LLM).
 *   2) Round-robin floor  — what the deterministic Stage 1 fallback produces (no LLM).
 *   3) Live LLM observed  — what the real model picks (gated by HTML_PPT_V3_LIVE_LLM=1).
 *
 * Output:
 *   - stdout: human-readable per-template + aggregate report
 *   - docs/14-BASELINE_DIVERSITY_REPORT.md: machine-snapshotted "before" numbers,
 *     to be re-run after Wave 5/6 to compute deltas.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplicationContext } from "@nestjs/common";
import type { z } from "zod";
import { listAvailableTemplateV2Ids, loadManifestV2 } from "../manifest/manifest-v2.loader";
import { runStage0PoolBuild } from "../stages/stage0-pool-build";
import { runStage1Planner } from "../stages/stage1-planner";
import {
  type AvailablePool,
  type GenerateRequest,
  type PlanIR,
  type TemplateManifestV2
} from "../shared";
import type { HtmlPptV3LLMClient } from "../orchestration/html-ppt-v3-llm-client";

const LIVE_FLAG = "HTML_PPT_V3_LIVE_LLM";
const LIVE_RUNS_PER_TEMPLATE = parseInt(process.env.BASELINE_LIVE_RUNS_PER_TEMPLATE ?? "3", 10);

const SAMPLE_THEMES = [
  "AI Agent 在中小企业的落地路线：场景、成本、风险与90天实施计划",
  "面向 2027 的可持续供应链：碳成本、合规与本地化重构",
  "教育行业 AI 助教年度复盘：留存、付费转化与下一代体验",
  "金融科技反欺诈：实时图模型、特征工程与监管预期",
  "医疗影像 AI 临床落地：审批、定价、医生工作流改造"
];

const REQUEST_CONFIGS: Array<Pick<GenerateRequest, "pageCount" | "wordBudget" | "includeImages" | "includeVideo" | "includeChart" | "includeAudio" | "includeSpeakerNotes">> = [
  { pageCount: 8,  wordBudget: 1800, includeImages: false, includeVideo: false, includeChart: false, includeAudio: false, includeSpeakerNotes: false },
  { pageCount: 12, wordBudget: 2800, includeImages: false, includeVideo: false, includeChart: true,  includeAudio: false, includeSpeakerNotes: false },
  { pageCount: 12, wordBudget: 2800, includeImages: true,  includeVideo: false, includeChart: true,  includeAudio: false, includeSpeakerNotes: false }
];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

type DeckMetrics = {
  templateId: string;
  config: string;
  source: "round-robin-fallback" | "live-model";
  pageCount: number;
  middleSlideCount: number;
  distinctFragments: number;
  layoutFamilyEntropy: number;          // bits; H = -Σ p log2 p
  layoutFamilyEntropyNormalized: number; // 0..1, divided by log2(uniqueFamiliesAvailable)
  componentSignatureMaxStreak: number;  // longest run of same signature
  hasThreeStreak: boolean;              // any signature ≥ 3 consecutive
  fragmentGini: number;                 // 0=perfect uniform, 1=concentrated
  topFragmentShare: number;             // share of most-used middle fragmentId
};

type PoolInventory = {
  templateId: string;
  middleFragmentCount: number;
  uniqueLayoutFamilies: number;
  layoutFamilyDistribution: Record<string, number>;
  imageFragmentCount: number;
  chartFragmentCount: number;
  videoFragmentCount: number;
  audioFragmentCount: number;
  theoreticalMaxLayoutEntropy: number;  // log2(uniqueLayoutFamilies)
};

async function main() {
  const liveMode = process.env[LIVE_FLAG] === "1";
  const templateIds = await listAvailableTemplateV2Ids();
  console.log(`[baseline] discovered ${templateIds.length} templates; liveMode=${liveMode}`);

  let llm: HtmlPptV3LLMClient | null = null;
  let appCtx: INestApplicationContext | null = null;

  if (liveMode) {
    const { NestFactory } = await import("@nestjs/core");
    const { AppModule } = await import("../../../../app.module.js");
    const { LlmConfigService } = await import("../../../llm-config/llm-config.service.js");
    const { HtmlPptV3LlmClient } = await import("../orchestration/html-ppt-v3-llm-client.js");
    appCtx = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const cfg = await appCtx!.get(LlmConfigService).getActiveConfig();
    llm = new HtmlPptV3LlmClient(cfg);
  }

  const inventories: PoolInventory[] = [];
  const deckRuns: DeckMetrics[] = [];

  for (const templateId of templateIds) {
    let manifest: TemplateManifestV2;
    try {
      manifest = await loadManifestV2(templateId);
    } catch (err) {
      console.warn(`[baseline] skip ${templateId}: ${(err as Error).message}`);
      continue;
    }

    inventories.push(buildPoolInventory(templateId, manifest));

    for (const config of REQUEST_CONFIGS) {
      const request: GenerateRequest = { theme: SAMPLE_THEMES[0]!, templateId, ...config };
      let pool: AvailablePool;
      try {
        pool = runStage0PoolBuild({ request, manifest }).pool;
      } catch {
        continue; // some configs unsupported by some templates (e.g., includeImages on a template without image fragments)
      }

      // Layer 2: round-robin fallback baseline
      try {
        const fallbackResult = await runStage1Planner({ request, pool, llm: throwingLlm() });
        deckRuns.push(measureDeck(templateId, configLabel(config), "round-robin-fallback", fallbackResult.plan, manifest));
      } catch (err) {
        console.warn(`[baseline] fallback failed for ${templateId}/${configLabel(config)}: ${(err as Error).message}`);
      }

      // Layer 3: live LLM observed (only first config to limit cost)
      if (llm && config === REQUEST_CONFIGS[0]) {
        for (let i = 0; i < LIVE_RUNS_PER_TEMPLATE; i++) {
          const themeRequest = { ...request, theme: SAMPLE_THEMES[i % SAMPLE_THEMES.length]! };
          try {
            const liveResult = await runStage1Planner({ request: themeRequest, pool, llm });
            deckRuns.push(measureDeck(templateId, configLabel(config), "live-model", liveResult.plan, manifest));
          } catch (err) {
            console.warn(`[baseline] live LLM failed for ${templateId}: ${(err as Error).message}`);
          }
        }
      }
    }

    process.stdout.write(".");
  }
  process.stdout.write("\n");

  if (appCtx) {
    await appCtx.close();
  }

  printReport(inventories, deckRuns, liveMode);
  writeReport(inventories, deckRuns, liveMode);
}

function buildPoolInventory(templateId: string, manifest: TemplateManifestV2): PoolInventory {
  const middleFragments = Object.values(manifest.pool);
  const familyDist: Record<string, number> = {};
  let imageCount = 0, chartCount = 0, videoCount = 0, audioCount = 0;

  for (const fragment of middleFragments) {
    const family = fragment.pagePortrait?.layoutFamily ?? "unknown";
    familyDist[family] = (familyDist[family] ?? 0) + 1;
    if (fragment.mediaKinds?.includes("image") || fragment.imageSlotSelectors?.length) imageCount++;
    if (fragment.mediaKinds?.includes("chart") || fragment.chartSlots?.length) chartCount++;
    if (fragment.mediaKinds?.includes("video") || fragment.videoSlotSelector) videoCount++;
    if (fragment.mediaKinds?.includes("audio")) audioCount++;
  }

  const uniqueFamilies = Object.keys(familyDist).length;
  return {
    templateId,
    middleFragmentCount: middleFragments.length,
    uniqueLayoutFamilies: uniqueFamilies,
    layoutFamilyDistribution: familyDist,
    imageFragmentCount: imageCount,
    chartFragmentCount: chartCount,
    videoFragmentCount: videoCount,
    audioFragmentCount: audioCount,
    theoreticalMaxLayoutEntropy: uniqueFamilies > 1 ? Math.log2(uniqueFamilies) : 0
  };
}

function measureDeck(
  templateId: string,
  config: string,
  source: DeckMetrics["source"],
  plan: PlanIR,
  manifest: TemplateManifestV2
): DeckMetrics {
  const middleSlides = plan.slides.slice(1, -1);
  const families: string[] = [];
  const signatures: string[] = [];
  const fragmentIds: string[] = [];

  for (const slide of middleSlides) {
    if (!slide.fragmentId) continue;
    const fragment = manifest.pool[slide.fragmentId];
    if (!fragment) continue;
    families.push(fragment.pagePortrait?.layoutFamily ?? "unknown");
    signatures.push(fragment.pagePortrait?.componentSignature ?? slide.fragmentId);
    fragmentIds.push(slide.fragmentId);
  }

  const familyCounts = countBy(families);
  const uniqueFamiliesInDeck = Object.keys(familyCounts).length;
  const familyEntropy = entropyBits(familyCounts);
  const familyEntropyMax = uniqueFamiliesInDeck > 1 ? Math.log2(uniqueFamiliesInDeck) : 1;
  const familyEntropyNormalized = uniqueFamiliesInDeck > 1 ? familyEntropy / familyEntropyMax : 0;

  const maxStreak = longestStreak(signatures);
  const fragmentCounts = countBy(fragmentIds);
  const fragmentGini = giniIndex(Object.values(fragmentCounts));
  const sortedFragShares = Object.values(fragmentCounts).sort((a, b) => b - a);
  const topShare = fragmentIds.length ? (sortedFragShares[0] ?? 0) / fragmentIds.length : 0;

  return {
    templateId,
    config,
    source,
    pageCount: plan.slides.length,
    middleSlideCount: middleSlides.length,
    distinctFragments: new Set(fragmentIds).size,
    layoutFamilyEntropy: familyEntropy,
    layoutFamilyEntropyNormalized: familyEntropyNormalized,
    componentSignatureMaxStreak: maxStreak,
    hasThreeStreak: maxStreak >= 3,
    fragmentGini,
    topFragmentShare: topShare
  };
}

function throwingLlm(): HtmlPptV3LLMClient {
  return {
    async callStructured<T extends z.ZodTypeAny>(_args: { schema: T }): Promise<z.infer<T>> {
      throw new Error("baseline: forced fallback");
    }
  };
}

/* ─── math helpers ─────────────────────────────────── */

function countBy<T extends string>(items: T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const item of items) out[item] = ((out[item] ?? 0) as number) + 1;
  return out;
}

function entropyBits(counts: Record<string, number>): number {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const n of Object.values(counts)) {
    if (n <= 0) continue;
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function longestStreak(items: string[]): number {
  let best = 0, cur = 0, prev: string | null = null;
  for (const x of items) {
    if (x === prev) cur++;
    else cur = 1;
    if (cur > best) best = cur;
    prev = x;
  }
  return best;
}

function giniIndex(counts: number[]): number {
  if (!counts.length) return 0;
  const sorted = [...counts].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  if (sum <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * (sorted[i] ?? 0);
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

function configLabel(c: typeof REQUEST_CONFIGS[number]): string {
  const flags: string[] = [];
  if (c.includeImages) flags.push("img");
  if (c.includeVideo) flags.push("vid");
  if (c.includeChart) flags.push("chart");
  if (c.includeAudio) flags.push("audio");
  return `p${c.pageCount}w${c.wordBudget}${flags.length ? "_" + flags.join("+") : ""}`;
}

/* ─── reporting ────────────────────────────────────── */

function printReport(inventories: PoolInventory[], decks: DeckMetrics[], liveMode: boolean) {
  console.log("\n=== Pool Inventory ===");
  console.log(`templates=${inventories.length} fragmentsTotal=${inventories.reduce((s, i) => s + i.middleFragmentCount, 0)}`);

  const fragCountStats = stats(inventories.map((i) => i.middleFragmentCount));
  const familyStats = stats(inventories.map((i) => i.uniqueLayoutFamilies));
  console.log(`middleFragmentsPerTemplate: min=${fragCountStats.min} max=${fragCountStats.max} mean=${fragCountStats.mean.toFixed(1)}`);
  console.log(`uniqueLayoutFamiliesPerTemplate: min=${familyStats.min} max=${familyStats.max} mean=${familyStats.mean.toFixed(1)}`);
  console.log(`templates with image fragments: ${inventories.filter((i) => i.imageFragmentCount > 0).length}/${inventories.length}`);
  console.log(`templates with chart fragments: ${inventories.filter((i) => i.chartFragmentCount > 0).length}/${inventories.length}`);

  printDeckGroup(decks.filter((d) => d.source === "round-robin-fallback"), "Round-Robin Fallback (lower-bound: deterministic ceiling)");
  if (liveMode) {
    printDeckGroup(decks.filter((d) => d.source === "live-model"), "Live LLM Observed (real model behaviour)");
  } else {
    console.log(`\nLive LLM measurements skipped. Set ${LIVE_FLAG}=1 + BASELINE_LIVE_RUNS_PER_TEMPLATE=N (default 3) to enable.`);
  }
}

function printDeckGroup(decks: DeckMetrics[], heading: string) {
  console.log(`\n=== ${heading} ===`);
  console.log(`runs=${decks.length}`);
  if (!decks.length) return;
  const entropyN = stats(decks.map((d) => d.layoutFamilyEntropyNormalized));
  const streak = stats(decks.map((d) => d.componentSignatureMaxStreak));
  const gini = stats(decks.map((d) => d.fragmentGini));
  const distinctRatio = stats(decks.map((d) => d.distinctFragments / Math.max(1, d.middleSlideCount)));
  const threeStreakRate = decks.filter((d) => d.hasThreeStreak).length / decks.length;

  console.log(`layoutFamilyEntropyNormalized:  min=${entropyN.min.toFixed(2)} max=${entropyN.max.toFixed(2)} mean=${entropyN.mean.toFixed(2)}`);
  console.log(`componentSignatureMaxStreak:    min=${streak.min} max=${streak.max} mean=${streak.mean.toFixed(2)}`);
  console.log(`hasThreeStreak rate:            ${(threeStreakRate * 100).toFixed(1)}%`);
  console.log(`fragmentGini:                   min=${gini.min.toFixed(2)} max=${gini.max.toFixed(2)} mean=${gini.mean.toFixed(2)}`);
  console.log(`distinctFragments/middleSlides: min=${distinctRatio.min.toFixed(2)} max=${distinctRatio.max.toFixed(2)} mean=${distinctRatio.mean.toFixed(2)}`);
}

function stats(xs: number[]) {
  if (!xs.length) return { min: 0, max: 0, mean: 0 };
  return {
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean: xs.reduce((s, v) => s + v, 0) / xs.length
  };
}

function writeReport(inventories: PoolInventory[], decks: DeckMetrics[], liveMode: boolean) {
  const docPath = join(__dirname, "..", "docs", "14-BASELINE_DIVERSITY_REPORT.md");
  const fallbackDecks = decks.filter((d) => d.source === "round-robin-fallback");
  const liveDecks = decks.filter((d) => d.source === "live-model");

  const lines: string[] = [];
  lines.push(`# html-ppt-v3 Baseline Diversity Report`);
  lines.push("");
  lines.push(`> 自动生成。再生成请运行 \`npm run html-ppt-v3:baseline-diversity --workspace @codex/backend\`。`);
  lines.push(`> Wave 5/6 完成后再跑一次同口径，对比 entropy / streak / gini 数字。`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Live mode: ${liveMode ? "ON" : "OFF (round-robin only)"}`);
  lines.push(`Templates measured: ${inventories.length}`);
  lines.push(`Fallback runs: ${fallbackDecks.length}, Live runs: ${liveDecks.length}`);
  lines.push("");

  lines.push("## Pool inventory");
  lines.push("");
  lines.push("| templateId | middleFragments | uniqueFamilies | image | chart | video | audio |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const inv of inventories) {
    lines.push(`| ${inv.templateId} | ${inv.middleFragmentCount} | ${inv.uniqueLayoutFamilies} | ${inv.imageFragmentCount} | ${inv.chartFragmentCount} | ${inv.videoFragmentCount} | ${inv.audioFragmentCount} |`);
  }
  lines.push("");

  if (fallbackDecks.length) {
    lines.push("## Round-Robin Fallback Baseline (deterministic ceiling)");
    lines.push("");
    lines.push(metricsTable(fallbackDecks));
    lines.push("");
  }

  if (liveMode && liveDecks.length) {
    lines.push("## Live LLM Observed Baseline");
    lines.push("");
    lines.push(metricsTable(liveDecks));
    lines.push("");
  } else {
    lines.push("## Live LLM Observed Baseline");
    lines.push("");
    lines.push("> Not run. Set `HTML_PPT_V3_LIVE_LLM=1` and re-run to populate.");
    lines.push("");
  }

  lines.push("## Per-deck detail (first 50 rows per source)");
  lines.push("");
  lines.push("| source | templateId | config | middleSlides | distinctFrags | familyEntN | maxStreak | gini | topShare |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  const sample = [...fallbackDecks.slice(0, 50), ...liveDecks.slice(0, 50)];
  for (const d of sample) {
    lines.push(`| ${d.source} | ${d.templateId} | ${d.config} | ${d.middleSlideCount} | ${d.distinctFragments} | ${d.layoutFamilyEntropyNormalized.toFixed(2)} | ${d.componentSignatureMaxStreak} | ${d.fragmentGini.toFixed(2)} | ${d.topFragmentShare.toFixed(2)} |`);
  }
  lines.push("");

  lines.push("## How to read");
  lines.push("");
  lines.push("- **layoutFamilyEntropyNormalized**: 0 = single family throughout; 1 = perfectly uniform across all families used. Higher = more diverse.");
  lines.push("- **componentSignatureMaxStreak**: longest run of slides sharing identical componentSignature. ≤ 2 is healthy; ≥ 3 is the user-reported \"连击\" pain.");
  lines.push("- **hasThreeStreak rate**: percent of decks with at least one 3+ streak. Wave 6 target: ≤ 5%.");
  lines.push("- **fragmentGini**: 0 = each fragment used equally; 1 = one fragment dominates. Lower = better.");
  lines.push("- **distinctFragments / middleSlides**: fraction of unique fragments out of available slots. 1.0 = no repeats.");
  lines.push("- **topFragmentShare**: fraction of middle slides that picked the single most-used fragment.");
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- Round-robin fallback is the deterministic Stage 1 fallback; it is the **upper bound** of what selection diversity could be. The real LLM tends to be worse, not better.");
  lines.push("- Live runs use only first request config (page=8, no media) to control cost.");
  lines.push("- Some templates have very small middle pool (< 6); their entropy ceiling is naturally low.");

  writeFileSync(docPath, lines.join("\n"), "utf-8");
  console.log(`\n[baseline] report written to ${docPath}`);
}

function metricsTable(decks: DeckMetrics[]): string {
  const entropyN = stats(decks.map((d) => d.layoutFamilyEntropyNormalized));
  const streak = stats(decks.map((d) => d.componentSignatureMaxStreak));
  const gini = stats(decks.map((d) => d.fragmentGini));
  const distinctRatio = stats(decks.map((d) => d.distinctFragments / Math.max(1, d.middleSlideCount)));
  const threeStreakRate = decks.filter((d) => d.hasThreeStreak).length / decks.length;
  const lines: string[] = [];
  lines.push("| metric | min | max | mean |");
  lines.push("|---|---|---|---|");
  lines.push(`| layoutFamilyEntropyNormalized | ${entropyN.min.toFixed(2)} | ${entropyN.max.toFixed(2)} | ${entropyN.mean.toFixed(2)} |`);
  lines.push(`| componentSignatureMaxStreak | ${streak.min} | ${streak.max} | ${streak.mean.toFixed(2)} |`);
  lines.push(`| fragmentGini | ${gini.min.toFixed(2)} | ${gini.max.toFixed(2)} | ${gini.mean.toFixed(2)} |`);
  lines.push(`| distinctFragments / middleSlides | ${distinctRatio.min.toFixed(2)} | ${distinctRatio.max.toFixed(2)} | ${distinctRatio.mean.toFixed(2)} |`);
  lines.push(`| hasThreeStreak rate | ${(threeStreakRate * 100).toFixed(1)}% | | |`);
  return lines.join("\n");
}
