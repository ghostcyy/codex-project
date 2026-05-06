import {
  buildAvailablePool as buildSharedAvailablePool,
  generateRequestSchema,
  type AvailablePool,
  type GenerateRequest,
  type TemplateManifestV2
} from "../shared";
import { loadManifestV2 } from "./manifest-v2.loader";

export type PoolBuildOptions = Pick<GenerateRequest, "includeImages" | "includeVideo" | "includeChart" | "includeAudio">;

export function buildAvailablePoolFromManifest(
  manifest: TemplateManifestV2,
  options: PoolBuildOptions
): AvailablePool {
  const req = generateRequestSchema.parse({
    theme: "pool-build",
    pageCount: 5,
    wordBudget: 500,
    templateId: manifest.id,
    includeImages: options.includeImages,
    includeVideo: options.includeVideo,
    includeChart: options.includeChart,
    includeAudio: options.includeAudio
  });
  return buildSharedAvailablePool(manifest, req);
}

export async function buildTemplatePool(templateId: string, options: PoolBuildOptions): Promise<AvailablePool> {
  const manifest = await loadManifestV2(templateId);
  return buildAvailablePoolFromManifest(manifest, options);
}
