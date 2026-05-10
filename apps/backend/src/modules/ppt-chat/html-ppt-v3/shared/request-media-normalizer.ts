import {
  fragmentHasMediaKind,
  isImagePageType,
  type TemplateManifestV2
} from "./manifest-v2.types";
import type { GenerateRequest } from "./job.types";

export type TemplateMediaNormalizationResult = {
  request: GenerateRequest;
  warnings: string[];
};

export const TEMPLATE_HAS_NO_IMAGE_PAGE_WARNING = "当前模板没有图片页，已关闭图片页选项并继续生成。";

export function normalizeRequestForTemplateMedia(
  request: GenerateRequest,
  manifest: TemplateManifestV2
): TemplateMediaNormalizationResult {
  const warnings: string[] = [];
  let nextRequest = request;

  if (request.includeImages && !templateHasImageSlots(manifest)) {
    nextRequest = { ...nextRequest, includeImages: false };
    warnings.push(TEMPLATE_HAS_NO_IMAGE_PAGE_WARNING);
  }

  return { request: nextRequest, warnings };
}

export function templateHasImageSlots(manifest: TemplateManifestV2): boolean {
  return Object.values(manifest.pool).some((fragment) => {
    const isImageFragment = isImagePageType(fragment.pageType) || fragmentHasMediaKind(fragment, "image");
    return isImageFragment && (fragment.imageSlotSelectors?.length ?? 0) > 0;
  });
}
