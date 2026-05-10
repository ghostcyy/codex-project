import { basename, dirname, join } from "node:path";
import {
  fragmentHasMediaKind,
  generatedImageKey,
  isImagePageType,
  type ContentIR,
  type GenerateRequest,
  type GeneratedImageAsset,
  type GeneratedImageMap,
  type PageFragment,
  type PlanIR,
  type PlannedSlide,
  type SlideContent,
  type TemplateManifestV2
} from "../shared";

export type V3ImageGenerationClient = {
  generateImage(args: {
    prompt: string;
    outputDir: string;
    fileBaseName: string;
  }): Promise<{ relativePath: string | null; warnings: string[]; absolutePath?: string }>;
};

export type Stage25ImageGenerationInput = {
  request: GenerateRequest;
  plan: PlanIR;
  content: ContentIR;
  manifest: TemplateManifestV2;
  workdir: string;
  imageClient?: V3ImageGenerationClient;
  maxImages?: number;
};

export type Stage25ImageGenerationResult = {
  generatedImages: GeneratedImageMap;
  warnings: string[];
  requestedCount: number;
  generatedCount: number;
  skippedCount: number;
};

const DEFAULT_MAX_IMAGES = 6;
const IMAGE_PROMPT_MAX_CHARS = 1400;

export async function runStage25ImageGeneration(
  input: Stage25ImageGenerationInput
): Promise<Stage25ImageGenerationResult> {
  const generatedImages: GeneratedImageMap = {};
  const warnings: string[] = [];
  const maxImages = Math.max(0, input.maxImages ?? DEFAULT_MAX_IMAGES);
  const contentByIndex = new Map(input.content.slides.map((slide) => [slide.slideIndex, slide]));
  let requestedCount = 0;
  let generatedCount = 0;
  let skippedCount = 0;

  if (!input.request.includeImages) {
    return { generatedImages, warnings, requestedCount, generatedCount, skippedCount };
  }

  const tasks: Array<{
    slide: PlannedSlide;
    content: SlideContent;
    slotIndex: number;
  }> = [];

  for (const slide of input.plan.slides) {
    const fragment = getFragment(input.manifest, slide);
    if (!fragment || !isImageFragment(fragment)) continue;
    const slotCount = fragment.imageSlotSelectors?.length ?? 0;
    if (slotCount <= 0) continue;

    const content = contentByIndex.get(slide.slideIndex);
    if (!content) {
      warnings.push(`Slide ${slide.slideIndex}: image generation skipped because content is missing.`);
      skippedCount += slotCount;
      continue;
    }

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex++) {
      tasks.push({ slide, content, slotIndex });
    }
  }

  requestedCount = tasks.length;
  if (!input.imageClient) {
    skippedCount += tasks.length;
    for (const task of tasks) {
      warnings.push(`Slide ${task.slide.slideIndex} image ${task.slotIndex + 1}: MiniMax image client is unavailable; using local fallback.`);
    }
    return { generatedImages, warnings, requestedCount, generatedCount, skippedCount };
  }

  const runnableTasks = tasks.slice(0, maxImages);
  const cappedTasks = tasks.slice(maxImages);
  skippedCount += cappedTasks.length;
  for (const task of cappedTasks) {
    warnings.push(`Slide ${task.slide.slideIndex} image ${task.slotIndex + 1}: skipped because max generated images is ${maxImages}.`);
  }

  const outputDir = resolveGeneratedImageTempDir(input.workdir);
  const results = await Promise.all(runnableTasks.map(async (task) => {
    const prompt = buildImagePrompt({
      request: input.request,
      manifest: input.manifest,
      slide: task.slide,
      content: task.content,
      slotIndex: task.slotIndex
    });
    const fileBaseName = `slide-${String(task.slide.slideIndex).padStart(2, "0")}-slot-${String(task.slotIndex + 1).padStart(2, "0")}`;
    try {
      const result = await input.imageClient!.generateImage({ prompt, outputDir, fileBaseName });
      return { task, prompt, result };
    } catch (error) {
      return { task, prompt, error };
    }
  }));

  for (const item of results) {
    if ("error" in item) {
      skippedCount++;
      warnings.push(`Slide ${item.task.slide.slideIndex} image ${item.task.slotIndex + 1}: ${item.error instanceof Error ? item.error.message : String(item.error)}; using local fallback.`);
      continue;
    }
    warnings.push(...item.result.warnings);
    if (!item.result.relativePath) {
      skippedCount++;
      warnings.push(`Slide ${item.task.slide.slideIndex} image ${item.task.slotIndex + 1}: MiniMax returned no image; using local fallback.`);
      continue;
    }
    generatedImages[generatedImageKey(item.task.slide.slideIndex, item.task.slotIndex)] = {
      slideIndex: item.task.slide.slideIndex,
      slotIndex: item.task.slotIndex,
      relativePath: item.result.relativePath,
      absolutePath: item.result.absolutePath ?? join(outputDir, basename(item.result.relativePath)),
      prompt: item.prompt,
      source: "minimax"
    } satisfies GeneratedImageAsset;
    generatedCount++;
  }

  return { generatedImages, warnings, requestedCount, generatedCount, skippedCount };
}

function resolveGeneratedImageTempDir(workdir: string) {
  const outputRoot = dirname(dirname(workdir));
  return join(outputRoot, "image-assets", basename(workdir));
}

function isImageFragment(fragment: PageFragment) {
  return isImagePageType(fragment.pageType) || fragmentHasMediaKind(fragment, "image") || (fragment.imageSlotSelectors?.length ?? 0) > 0;
}

function getFragment(manifest: TemplateManifestV2, slide: PlannedSlide) {
  if (slide.pageType === "cover") return manifest.fixed.cover;
  if (slide.pageType === "closing") return manifest.fixed.closing;
  return slide.fragmentId ? manifest.pool[slide.fragmentId] : undefined;
}

function buildImagePrompt(args: {
  request: GenerateRequest;
  manifest: TemplateManifestV2;
  slide: PlannedSlide;
  content: SlideContent;
  slotIndex: number;
}) {
  const hint = args.content.imageHints?.[args.slotIndex] ?? "";
  const slideText = uniqueVisibleText(Object.values(args.content.slotFills));
  const templateStyle = [
    args.manifest.label["zh-CN"] || args.manifest.label.en,
    args.manifest.description["zh-CN"] || args.manifest.description.en
  ].filter(Boolean).join("，");

  const requiredParts = [
    `为一页中文 HTML-PPT 生成配图。`,
    `整套 PPT 主题：${args.request.theme}`,
    `当前页标题：${args.slide.slideTitle}`,
    `当前页要点：${args.slide.topicPoints.join("；")}`,
    hint ? `图片提示：${hint}` : "",
    templateStyle ? `视觉风格参考：${templateStyle}` : "",
    `要求：横版演示文稿配图，专业、清晰、无水印、不要生成可读长文字，不要出现模板占位符。`
  ].filter(Boolean);
  return clipImagePrompt(requiredParts, slideText);
}

function uniqueVisibleText(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.join("；");
}

function clipImagePrompt(requiredParts: string[], slideText: string) {
  const textPrefix = "当前页文字：";
  const suffix = requiredParts.join("\n");
  if (!slideText) return clipToChars(suffix, IMAGE_PROMPT_MAX_CHARS);

  const partsWithoutText = requiredParts.join("\n");
  const remaining = IMAGE_PROMPT_MAX_CHARS - countChars(partsWithoutText) - countChars(textPrefix) - 2;
  const clippedSlideText = remaining > 0 ? clipToChars(slideText, remaining) : "";
  const parts = clippedSlideText
    ? [...requiredParts.slice(0, -1), `${textPrefix}${clippedSlideText}`, requiredParts[requiredParts.length - 1]]
    : requiredParts;
  return clipToChars(parts.filter(Boolean).join("\n"), IMAGE_PROMPT_MAX_CHARS);
}

function clipToChars(value: string, maxChars: number) {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function countChars(value: string) {
  return [...value].length;
}
