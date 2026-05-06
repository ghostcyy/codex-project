import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import type { AnyNode, Element, Text } from "domhandler";
import { runStage3Injector } from "../injector/stage3-injector";
import { loadManifestV2, resolveTemplateDir } from "../manifest/manifest-v2.loader";
import type { ContentIR, PageFragment, PlanIR, PlannedSlide, SlotAnchor, TemplateManifestV2 } from "../shared";

const RESIDUE_PATTERN = /\b(?:ECO_HARMONY|MATERIAL_DATA|LIGHT_ORCHESTRATION|SYSTEM_SYNC_COMPLETE|SMART-CITY-DAO|PGP_SIGNED)\b|GITHUB\.COM\/[A-Z0-9_-]+|0x[0-9A-Fa-f.]+\s*\/\/\s*[A-Z_]+|[A-Z][A-Z0-9_]{4,}\s*\/\/\s*\d{4}|\{\{[^}]+\}\}|EDIT_ME/;

async function main() {
  await verifyTemplateNoResidue("01-tech-web3", [
    /SYSTEM_SYNC_COMPLETE/i,
    /GITHUB\.COM\/SMART-CITY-DAO/i,
    /0x1234\.\.\.ABCD\s*\/\/\s*PGP_SIGNED/i
  ]);
  await verifyTemplateNoResidue("19-interior-design", [
    /INTERIOR_ARCH/i,
    /AMBIENT_WHITE_NOISE/i
  ]);
  await verifyTemplateNoResidue("11-corporate-consulting", [
    /Strategic Analysis Report/i,
    /Board of Directors/i,
    /Global Market Entry Strategy/i,
    /APAC Growth/i,
    /Q1 · Foundation/i
  ]);
  await verifyTemplateNoResidue("13-academic-lecture", [
    /Dr\. Jane Smith/i,
    /Lecture Outline/i,
    /Computational Linguistics/i
  ]);

  console.log("HTML-PPT v3 no-residue verification passed.");
}

async function verifyTemplateNoResidue(templateId: string, forbiddenPatterns: RegExp[]) {
  const manifest = await loadManifestV2(templateId);
  const templateDir = resolveTemplateDir(manifest.id);
  const workdir = join(tmpdir(), `html-ppt-v3-no-residue-${templateId}`);
  rmSync(workdir, { recursive: true, force: true });

  const middleSlides = pickMiddleFragments(manifest);
  const plan: PlanIR = {
    templateId: manifest.id,
    totalChars: 1200,
    pageCount: middleSlides.length + 2,
    slides: [
      { slideIndex: 1, pageType: "cover", slideTitle: "AI家居空间", topicPoints: ["开场"], charBudget: 180 },
      ...middleSlides.map((fragment, index): PlannedSlide => ({
        slideIndex: index + 2,
        fragmentId: fragment.fragmentId,
        pageType: fragment.pageType,
        slideTitle: `空间策略 ${index + 1}`,
        topicPoints: ["体验升级", "材料优化", "效率提升"].slice(0, getFragment(manifest, fragment).topicSlots),
        chartType: fragment.pageType === "chart" ? "line" : undefined,
        charBudget: 240
      })),
      { slideIndex: middleSlides.length + 2, pageType: "closing", slideTitle: "空间进化", topicPoints: ["收束"], charBudget: 180 }
    ]
  };
  const content = buildContent(plan, manifest);
  const result = runStage3Injector({ manifest, plan, content, templateDir, workdir, jobId: "no-residue" });

  if (!existsSync(result.indexHtmlPath)) throw new Error("No-residue verification should produce index.html.");
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.test(result.html)) {
      throw new Error(`${templateId}: generated HTML still contains forbidden template text matching ${forbidden}.`);
    }
  }
  if (RESIDUE_PATTERN.test(result.html)) {
    const match = result.html.match(RESIDUE_PATTERN)?.[0] ?? "unknown";
    throw new Error(`${templateId}: generated HTML still contains template residue '${match}'.`);
  }

  const dom = parseDocument(result.html, { decodeEntities: false });
  const slides = selectAll("section.slide", dom as unknown as AnyNode) as Element[];
  if (slides.length !== plan.pageCount) throw new Error(`Expected ${plan.pageCount} slides, got ${slides.length}.`);

  for (const [index, section] of slides.entries()) {
    const expectedCurrent = String(index + 1);
    const expectedTotal = String(slides.length);
    if (section.attribs["data-slide-index"] !== expectedCurrent || section.attribs["data-slide-total"] !== expectedTotal) {
      throw new Error(`Slide ${index + 1} has stale section page number attributes.`);
    }
    for (const node of selectAll(".slide-number, [data-current], [data-total]", section as unknown as AnyNode) as Element[]) {
      const isSlideNumber = (node.attribs.class ?? "").split(/\s+/).includes("slide-number");
      if (isSlideNumber) {
        if (node.attribs["data-current"] !== expectedCurrent || node.attribs["data-total"] !== expectedTotal) {
          throw new Error(`Slide ${index + 1} slide-number should keep actual data-current/data-total attributes.`);
        }
        if (textOf(node).trim()) {
          throw new Error(`Slide ${index + 1} slide-number should not duplicate CSS attr() output as visible text.`);
        }
      } else if (node.attribs["data-current"] !== expectedCurrent || node.attribs["data-total"] !== expectedTotal) {
        throw new Error(`Slide ${index + 1} has stale page number attributes.`);
      }
    }
  }

  const emptyDecorative = selectAll(".meta-badge, .tag, .label, .kicker", dom as unknown as AnyNode)
    .filter((node) => !textOf(node as Element).trim());
  if (emptyDecorative.length) {
    throw new Error(`${templateId}: generated HTML contains ${emptyDecorative.length} empty decorative text element(s).`);
  }
}

function pickMiddleFragments(manifest: TemplateManifestV2) {
  const fragments = Object.values(manifest.pool as Record<string, PageFragment>);
  const preferred = ["grid-3", "chart", "grid-4"]
    .flatMap((pageType) => fragments.filter((fragment) => fragment.pageType === pageType).slice(0, 1));
  const fallback = fragments.slice(0, 3);
  return (preferred.length ? preferred : fallback).map((fragment) => ({
    fragmentId: fragment.fragmentId,
    pageType: fragment.pageType
  }));
}

function buildContent(plan: PlanIR, manifest: TemplateManifestV2): ContentIR {
  return {
    templateId: plan.templateId,
    slides: plan.slides.map((slide) => {
      const fragment = getFragment(manifest, slide);
      const slotFills: Record<string, string> = {};
      for (const anchor of fragment.anchors) {
        if (shouldOmitToExerciseFallback(anchor)) continue;
        slotFills[anchor.slotId] = slotText(anchor.slotId, slide.slideTitle, anchor.maxChars);
      }
      const chartDataBySlot = fragment.chartSlots.length
        ? Object.fromEntries(fragment.chartSlots.map((slot) => [slot.slotId, {
            type: slot.defaultRenderType,
            labels: ["现状", "优化", "成果"],
            datasets: [{ label: slide.slideTitle, data: [36, 68, 91] }]
          }]))
        : undefined;
      return {
        slideIndex: slide.slideIndex,
        fragmentId: slide.fragmentId,
        pageType: slide.pageType,
        slotFills,
        chartDataBySlot,
        chartData: slide.pageType === "chart" && !chartDataBySlot
          ? {
              type: slide.chartType ?? "line",
              labels: ["现状", "优化", "成果"],
              datasets: [{ label: slide.slideTitle, data: [36, 68, 91] }]
            }
          : undefined
      };
    })
  };
}

function getFragment(manifest: TemplateManifestV2, slide: Pick<PlannedSlide, "pageType" | "fragmentId">): PageFragment {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  const fragmentId = slide.fragmentId;
  if (!fragmentId) throw new Error(`Middle slide with pageType '${slide.pageType}' must include fragmentId.`);
  const fragment = manifest.pool[fragmentId];
  if (!fragment) throw new Error(`Missing fragment for fragmentId '${fragmentId}'.`);
  return fragment;
}

function shouldOmitToExerciseFallback(anchor: SlotAnchor) {
  return /(?:decorative|footer|meta|badge|label|section)/i.test(anchor.slotId);
}

function slotText(slotId: string, title: string, maxChars: number) {
  const value = slotId === "title"
    ? title
    : /heading/i.test(slotId)
      ? "关键策略"
      : `${title} 通过材料、动线和智能系统形成可执行的空间升级路径。`;
  return value.slice(0, maxChars);
}

function textOf(node: AnyNode): string {
  if (node.type === "text") return (node as Text).data;
  if (!("children" in node) || !node.children) return "";
  return node.children.map((child) => textOf(child as AnyNode)).join("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
