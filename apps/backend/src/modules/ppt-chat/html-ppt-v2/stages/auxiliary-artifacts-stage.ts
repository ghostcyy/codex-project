import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DeckIR, NarrativeSlideIR, SlideSlotFillIR } from "../ir";
import { createZipBuffer } from "../renderer";

export type AuxiliaryArtifactsManifest = {
  speakerNotes: string;
  agendaPdf: string;
  talkingPoints: string;
  qaPrep: string;
  accessibilityReport: string;
};

export type AuxiliaryArtifactsStageResult = {
  source: "deterministic";
  artifacts: AuxiliaryArtifactsManifest;
  warnings: string[];
};

export type RunAuxiliaryArtifactsStageInput = {
  deck: DeckIR;
  outputDir: string;
  writeArtifacts?: boolean;
};

type MutableManifest = {
  files?: {
    indexHtml?: string;
    previewHtml?: string;
    standaloneHtml?: string;
    styleCss?: string;
    zip?: string;
    assets?: string[];
    verificationReport?: string;
    auxiliaryArtifacts?: AuxiliaryArtifactsManifest;
  };
  auxiliaryArtifacts?: AuxiliaryArtifactsManifest;
  [key: string]: unknown;
};

const AUX_ARTIFACTS: AuxiliaryArtifactsManifest = {
  speakerNotes: "speaker-notes.md",
  agendaPdf: "agenda.pdf",
  talkingPoints: "talking-points.json",
  qaPrep: "qa-prep.md",
  accessibilityReport: "accessibility-report.md"
};

export async function runAuxiliaryArtifactsStage(input: RunAuxiliaryArtifactsStageInput): Promise<AuxiliaryArtifactsStageResult> {
  const outputDir = resolve(input.outputDir);
  const speakerNotes = renderSpeakerNotes(input.deck);
  const agendaText = renderAgendaText(input.deck);
  const talkingPoints = `${JSON.stringify(buildTalkingPoints(input.deck), null, 2)}\n`;
  const qaPrep = renderQaPrep(input.deck);
  const accessibilityReport = renderAccessibilityReport(input.deck);
  const warnings: string[] = [];
  const agendaArtifact = await createAgendaArtifact(agendaText, input.deck.intent.language);
  warnings.push(...agendaArtifact.warnings);
  const artifacts: AuxiliaryArtifactsManifest = {
    ...AUX_ARTIFACTS,
    agendaPdf: agendaArtifact.fileName
  };

  if (input.writeArtifacts ?? true) {
    await writeFile(join(outputDir, artifacts.speakerNotes), speakerNotes, "utf8");
    await writeFile(join(outputDir, artifacts.agendaPdf), agendaArtifact.data);
    await writeFile(join(outputDir, artifacts.talkingPoints), talkingPoints, "utf8");
    await writeFile(join(outputDir, artifacts.qaPrep), qaPrep, "utf8");
    await writeFile(join(outputDir, artifacts.accessibilityReport), accessibilityReport, "utf8");
    await updateManifestAndZip({ outputDir, artifacts, warnings });
  }

  return {
    source: "deterministic",
    artifacts,
    warnings
  };
}

function renderSpeakerNotes(deck: DeckIR): string {
  const lines = [
    "# Speaker Notes",
    "",
    `Deck: ${deck.intent.topic}`,
    `Audience: ${deck.intent.audience}`,
    ""
  ];

  for (const slide of deck.narrative.slides) {
    const slot = findSlot(deck, slide.index);
    const transition = deck.narrative.transitions.find((item) => item.fromSlide === slide.index);
    const citations = uniqueStrings([...slide.contentBrief.evidenceRefs, ...(slot?.citationKeys ?? [])]);
    lines.push(`## Slide ${slide.index}: ${slide.contentBrief.headline}`);
    lines.push("");
    lines.push(`1. Open by framing this slide as "${slide.beat}", then restate the headline in conversational language.`);
    lines.push(`2. Explain the main point with ${summarizeSlot(slot)} so the audience sees the concrete takeaway before details.`);
    lines.push(`3. Use the supporting evidence: ${slide.contentBrief.supportingPoints.slice(0, 3).join(" ")}.`);
    lines.push(`4. If challenged, point to citation keys ${citations.length ? citations.join(", ") : "not provided in this draft"} and avoid overstating unsupported claims.`);
    lines.push(`5. Close the slide with ${transition?.bridge ?? "a short transition that connects this point to the next slide."}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function renderAgendaText(deck: DeckIR): string {
  const lines = [
    "HTML-PPT v2 Agenda",
    `Topic: ${deck.intent.topic}`,
    `Slides: ${deck.intent.derivedSlideCount}`,
    ""
  ];
  let cursorSeconds = 0;
  for (const slide of deck.narrative.slides) {
    const durationSeconds = estimateSlideSeconds(slide);
    lines.push(`${formatTime(cursorSeconds)} - ${formatTime(cursorSeconds + durationSeconds)} | Slide ${slide.index}: ${slide.contentBrief.headline}`);
    cursorSeconds += durationSeconds;
  }
  lines.push("");
  lines.push(`Estimated total: ${formatTime(cursorSeconds)}`);
  return lines.join("\n");
}

function buildTalkingPoints(deck: DeckIR) {
  return {
    schemaVersion: "html-ppt-v2-talking-points-v1",
    topic: deck.intent.topic,
    audience: deck.intent.audience,
    totalSlides: deck.intent.derivedSlideCount,
    slides: deck.narrative.slides.map((slide) => {
      const slot = findSlot(deck, slide.index);
      return {
        slideIndex: slide.index,
        role: slide.role,
        layoutId: slot?.kind,
        headline: slide.contentBrief.headline,
        beat: slide.beat,
        talkingPoints: slide.contentBrief.supportingPoints.slice(0, 5),
        keyMetrics: slide.contentBrief.keyMetrics ?? [],
        citationKeys: uniqueStrings([...slide.contentBrief.evidenceRefs, ...(slot?.citationKeys ?? [])]),
        estimatedSeconds: estimateSlideSeconds(slide)
      };
    })
  };
}

function renderQaPrep(deck: DeckIR): string {
  const gaps = deck.evidence.knownGaps.length ? deck.evidence.knownGaps : ["No major evidence gaps were recorded in EvidencePack."];
  const lines = [
    "# QA Prep",
    "",
    "## Likely Questions",
    ""
  ];

  for (const slide of deck.narrative.slides.slice(0, 8)) {
    lines.push(`### Slide ${slide.index}: ${slide.contentBrief.headline}`);
    lines.push(`- Question: What is the strongest evidence behind this point?`);
    lines.push(`- Suggested answer: Anchor the answer in ${slide.contentBrief.evidenceRefs.join(", ") || "the cited source list"} and keep the claim scoped to this slide.`);
    lines.push(`- Follow-up: How does this connect to the overall thesis?`);
    lines.push(`- Suggested answer: Connect it back to "${deck.intent.topic}" and the narrative beat "${slide.beat}".`);
    lines.push("");
  }

  lines.push("## Evidence Caveats");
  for (const gap of gaps) {
    lines.push(`- ${gap}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderAccessibilityReport(deck: DeckIR): string {
  const chartSlots = deck.slots.filter((slot) => slot.kind === "chart");
  const contrast = deck.design.contrastReport;
  const lines = [
    "# Accessibility Report",
    "",
    `- Language: ${deck.intent.language}`,
    `- Theme: ${deck.design.themeId}`,
    `- Contrast: ${contrast.passed ? "passed" : "needs review"} (minimum ${contrast.minContrastRatio.toFixed(2)}:1)`,
    `- Chart slides: ${chartSlots.length}`,
    "",
    "## Alt Text Coverage",
    ""
  ];

  if (!chartSlots.length) {
    lines.push("- No chart assets are required by the current deterministic core layout set.");
  }
  for (const slot of chartSlots) {
    const asset = deck.assets[slot.dataAssetKey];
    lines.push(`- Slide ${slot.slideIndex}: ${readAssetAlt(asset) ? "has chart summary alt text" : "missing chart alt text"} (${slot.dataAssetKey})`);
  }

  lines.push("");
  lines.push("## Notes");
  lines.push("- Stage 12 deterministic report checks declared IR accessibility data. Pixel-level contrast and font-load verification belongs to Stage 11 Playwright verification when enabled.");
  return `${lines.join("\n")}\n`;
}

function readAssetAlt(asset: DeckIR["assets"][string] | undefined): string {
  if (!asset) {
    return "";
  }
  if (asset.kind === "photo" || asset.kind === "illustration") {
    return asset.alt;
  }
  if (asset.kind === "chart") {
    return asset.sourceCitationKeys.length ? `Chart backed by ${asset.sourceCitationKeys.join(", ")}` : "";
  }
  return "";
}

function findSlot(deck: DeckIR, slideIndex: number): SlideSlotFillIR | undefined {
  return deck.slots.find((slot) => slot.slideIndex === slideIndex);
}

function summarizeSlot(slot: SlideSlotFillIR | undefined): string {
  if (!slot) {
    return "the planned slide content";
  }
  switch (slot.kind) {
    case "cover":
      return slot.subtitle ? `the subtitle "${slot.subtitle}"` : "the deck's opening premise";
    case "toc":
      return `${slot.items.length} agenda items`;
    case "two-column":
      return `the contrast between "${slot.leftTitle}" and "${slot.rightTitle}"`;
    case "three-column":
      return `${slot.cards.length} supporting cards`;
    case "kpi-grid":
      return `${slot.metrics.length} headline metrics`;
    case "timeline":
      return `${slot.events.length} timeline events`;
    case "comparison":
      return `the comparison between "${slot.left.title}" and "${slot.right.title}"`;
    case "cta":
      return `the action "${slot.action}"`;
    case "chart":
      return `the ${slot.chartType} chart insight`;
  }
  return "the planned layout content";
}

function estimateSlideSeconds(slide: NarrativeSlideIR): number {
  return Math.max(35, Math.min(150, Math.round((slide.estimatedNarrativeChars / 360) * 60)));
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function createAgendaArtifact(text: string, language: DeckIR["intent"]["language"]): Promise<{ fileName: string; data: Buffer | string; warnings: string[] }> {
  if (!requiresRasterAgenda(text, language)) {
    return {
      fileName: "agenda.pdf",
      data: createLatinAgendaPdf(text),
      warnings: []
    };
  }

  const png = await renderAgendaPng(text);
  if (png) {
    return {
      fileName: "agenda.png",
      data: png,
      warnings: []
    };
  }

  return {
    fileName: "agenda.txt",
    data: `${text}\n`,
    warnings: ["CJK agenda was emitted as UTF-8 text because Playwright was unavailable; PDF CID fonts are intentionally not used without embedded glyphs."]
  };
}

function requiresRasterAgenda(text: string, language: DeckIR["intent"]["language"]): boolean {
  return containsCjk(text) || ["zh-CN", "ja", "ko"].includes(language);
}

async function renderAgendaPng(text: string): Promise<Buffer | undefined> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    return undefined;
  }

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 });
    await page.setContent(renderAgendaHtml(text), { waitUntil: "load" });
    return Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
  } catch {
    return undefined;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function loadPlaywright(): Promise<typeof import("playwright") | undefined> {
  try {
    return await import("playwright");
  } catch {
    return undefined;
  }
}

function renderAgendaHtml(text: string): string {
  const lines = text.split("\n").slice(0, 42);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: #f7f2e8;
    color: #17231f;
    font-family: "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Arial Unicode MS", sans-serif;
  }
  .page {
    width: 1200px;
    min-height: 1600px;
    padding: 96px;
    background:
      radial-gradient(circle at 12% 10%, rgba(8, 116, 107, 0.15), transparent 28%),
      radial-gradient(circle at 86% 0%, rgba(210, 128, 47, 0.16), transparent 30%),
      #f7f2e8;
  }
  h1 {
    margin: 0 0 34px;
    font-size: 48px;
    line-height: 1.1;
    letter-spacing: -0.04em;
  }
  .line {
    display: block;
    margin: 0 0 15px;
    border-bottom: 1px solid rgba(23, 35, 31, 0.1);
    padding: 0 0 13px;
    font-size: 24px;
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .line:first-of-type {
    display: none;
  }
</style>
</head>
<body>
  <main class="page">
    <h1>${escapeHtml(lines[0] ?? "HTML-PPT v2 Agenda")}</h1>
    ${lines.map((line) => `<span class="line">${escapeHtml(line || " ")}</span>`).join("\n")}
  </main>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createLatinAgendaPdf(text: string): Buffer {
  const lines = text.split("\n").slice(0, 34);
  const textOps = lines.map((line, index) => {
    const fontSize = index === 0 ? 18 : 10;
    const y = 760 - index * 20;
    return `BT /F1 ${fontSize} Tf 54 ${y} Td (${escapePdfLiteral(line)}) Tj ET`;
  }).join("\n");
  const fontObjects = ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    fontObjects[0]!,
    `<< /Length ${Buffer.byteLength(textOps, "utf8")} >>\nstream\n${textOps}\nendstream`,
  ];
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let length = Buffer.byteLength(chunks[0] ?? "", "utf8");
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = `${index + 1} 0 obj\n${object}\nendobj\n`;
    chunks.push(chunk);
    length += Buffer.byteLength(chunk, "utf8");
  }
  const xrefOffset = length;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF"
  ].join("\n");
  chunks.push(xref);
  return Buffer.from(chunks.join(""), "utf8");
}

function containsCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
}

function escapePdfLiteral(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

async function updateManifestAndZip(input: { outputDir: string; artifacts: AuxiliaryArtifactsManifest; warnings: string[] }) {
  const manifestPath = join(input.outputDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    input.warnings.push("manifest.json not found; auxiliary artifact metadata was not attached.");
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
  const updatedManifest: MutableManifest = {
    ...manifest,
    files: {
      ...(manifest.files ?? {}),
      auxiliaryArtifacts: input.artifacts
    },
    auxiliaryArtifacts: input.artifacts
  };
  const manifestJson = `${JSON.stringify(updatedManifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestJson, "utf8");

  const zipPath = join(input.outputDir, "html-ppt-deck.zip");
  if (!existsSync(zipPath)) {
    input.warnings.push("html-ppt-deck.zip not found; auxiliary artifacts were not packed.");
    return;
  }

  const entries = await readPackEntries(input.outputDir, updatedManifest, input.artifacts, manifestJson);
  await writeFile(zipPath, createZipBuffer(entries));
}

async function readPackEntries(outputDir: string, manifest: MutableManifest, artifacts: AuxiliaryArtifactsManifest, manifestJson: string) {
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: "manifest.json", data: manifestJson }
  ];
  for (const file of ["index.html", "preview.html", "standalone.html", "style.css", manifest.files?.verificationReport].filter(isString)) {
    const target = safeResolveOutputPath(outputDir, file);
    if (target && existsSync(target)) {
      entries.push({ name: file.replace(/\\/g, "/"), data: await readFile(target) });
    }
  }
  for (const assetPath of manifest.files?.assets ?? []) {
    const target = safeResolveOutputPath(outputDir, assetPath);
    if (target && existsSync(target)) {
      entries.push({ name: assetPath.replace(/\\/g, "/"), data: await readFile(target) });
    }
  }
  for (const file of Object.values(artifacts)) {
    const target = safeResolveOutputPath(outputDir, file);
    if (target && existsSync(target)) {
      entries.push({ name: file, data: await readFile(target) });
    }
  }
  return entries;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeResolveOutputPath(outputDir: string, ref: string): string | undefined {
  const target = resolve(outputDir, ref.replace(/\\/g, "/").replace(/^\/+/, ""));
  const root = outputDir.endsWith(sep) ? outputDir : `${outputDir}${sep}`;
  if (target !== outputDir && !target.startsWith(root)) {
    return undefined;
  }
  return target;
}
