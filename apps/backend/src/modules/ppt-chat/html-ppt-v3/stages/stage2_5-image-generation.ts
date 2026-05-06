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
      requestedCount++;
      if (generatedCount >= maxImages) {
        skippedCount++;
        warnings.push(`Slide ${slide.slideIndex} image ${slotIndex + 1}: skipped because max generated images is ${maxImages}.`);
        continue;
      }
      if (!input.imageClient) {
        skippedCount++;
        warnings.push(`Slide ${slide.slideIndex} image ${slotIndex + 1}: MiniMax image client is unavailable; using local fallback.`);
        continue;
      }

      const prompt = buildImagePrompt({ request: input.request, manifest: input.manifest, slide, content, slotIndex });
      const fileBaseName = `slide-${String(slide.slideIndex).padStart(2, "0")}-slot-${String(slotIndex + 1).padStart(2, "0")}`;
      const outputDir = resolveGeneratedImageTempDir(input.workdir);

      try {
        const result = await input.imageClient.generateImage({ prompt, outputDir, fileBaseName });
        warnings.push(...result.warnings);
        if (!result.relativePath) {
          skippedCount++;
          warnings.push(`Slide ${slide.slideIndex} image ${slotIndex + 1}: MiniMax returned no image; using local fallback.`);
          continue;
        }
        generatedImages[generatedImageKey(slide.slideIndex, slotIndex)] = {
          slideIndex: slide.slideIndex,
          slotIndex,
          relativePath: result.relativePath,
          absolutePath: result.absolutePath ?? join(outputDir, basename(result.relativePath)),
          prompt,
          source: "minimax"
        } satisfies GeneratedImageAsset;
        generatedCount++;
      } catch (error) {
        skippedCount++;
        warnings.push(`Slide ${slide.slideIndex} image ${slotIndex + 1}: ${error instanceof Error ? error.message : String(error)}; using local fallback.`);
      }
    }
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
  const slotText = Object.values(args.content.slotFills)
    .filter(Boolean)
    .join("；")
    .slice(0, 500);
  const templateStyle = [
    args.manifest.label["zh-CN"] || args.manifest.label.en,
    args.manifest.description["zh-CN"] || args.manifest.description.en
  ].filter(Boolean).join("，");

  return [
    `为一页中文 HTML-PPT 生成配图。`,
    `整套 PPT 主题：${args.request.theme}`,
    `当前页标题：${args.slide.slideTitle}`,
    `当前页要点：${args.slide.topicPoints.join("；")}`,
    hint ? `图片提示：${hint}` : "",
    slotText ? `页面正文：${slotText}` : "",
    templateStyle ? `视觉风格参考：${templateStyle}` : "",
    `要求：横版演示文稿配图，专业、清晰、无水印、不要生成可读长文字，不要出现模板占位符。`
  ].filter(Boolean).join("\n");
}
