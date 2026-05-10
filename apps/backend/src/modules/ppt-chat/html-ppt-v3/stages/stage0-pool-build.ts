import {
  buildAvailablePool,
  generateRequestSchema,
  templateManifestV2Schema,
  type AvailablePool,
  type GenerateRequest,
  type TemplateManifestV2
} from "../shared";

export type Stage0PoolBuildInput = {
  request: GenerateRequest;
  manifest: TemplateManifestV2;
};

export type Stage0PoolBuildResult = {
  pool: AvailablePool;
};

export function runStage0PoolBuild(input: Stage0PoolBuildInput): Stage0PoolBuildResult {
  const request = generateRequestSchema.parse(input.request);
  const manifest = templateManifestV2Schema.parse(input.manifest);
  const pool = buildAvailablePool(manifest, request);
  if (request.pageCount > 2 && Object.keys(pool.middle).length === 0) {
    throw new Error("No available middle fragments after media filtering; enable at least one media option or choose another template.");
  }
  if (
    request.includeImages &&
    request.pageCount > 2 &&
    !Object.values(pool.middle).some((summary) => summary.isImage && summary.imageSlotCount > 0)
  ) {
    throw new Error("No available image fragments with image slots after media filtering; choose a template with image pages or adjust media options.");
  }
  return { pool };
}
