import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { TEMPLATES_ROOT, type TemplateManifestV2 } from "../shared";
import { parseManifestV2Json, validateManifestV2Files } from "./manifest-v2.validator";

type ManifestCacheEntry = {
  manifest: TemplateManifestV2;
  mtimeMs: number;
  size: number;
};

const cache = new Map<string, ManifestCacheEntry>();

export async function loadManifestV2(templateId: string): Promise<TemplateManifestV2> {
  const templateDir = resolveTemplateDir(templateId);
  const manifestPath = join(templateDir, "manifest-v2.json");
  const manifestStat = await stat(manifestPath).catch(() => null);
  if (!manifestStat) {
    throw new Error(`manifest-v2.json not found for template '${templateId}': ${manifestPath}`);
  }

  const cached = cache.get(templateId);
  if (cached && cached.mtimeMs === manifestStat.mtimeMs && cached.size === manifestStat.size) {
    return cached.manifest;
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`manifest-v2.json not found for template '${templateId}': ${manifestPath}`);
  }

  const parsed = await parseManifestV2Json(raw);
  if (!parsed.ok) {
    throw new Error(`manifest-v2 schema validation failed for template '${templateId}': ${parsed.reasons.join("; ")}`);
  }
  if (parsed.manifest.id !== templateId) {
    throw new Error(`manifest-v2 id mismatch for template '${templateId}': got '${parsed.manifest.id}'`);
  }

  const files = await validateManifestV2Files(parsed.manifest, templateDir);
  if (!files.ok) {
    throw new Error(`manifest-v2 file validation failed for template '${templateId}': ${files.reasons.join("; ")}`);
  }

  cache.set(templateId, {
    manifest: parsed.manifest,
    mtimeMs: manifestStat.mtimeMs,
    size: manifestStat.size
  });
  return parsed.manifest;
}

export async function listAvailableTemplateV2Ids(): Promise<string[]> {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(TEMPLATES_ROOT, entry.name, "manifest-v2.json"), "utf8");
      ids.push(entry.name);
    } catch {
      // Template has not been converted yet.
    }
  }
  return ids.sort();
}

export function resolveTemplateDir(templateId: string): string {
  return join(TEMPLATES_ROOT, templateId);
}

export function resolveTemplateV2ManifestPath(templateId: string): string {
  return join(resolveTemplateDir(templateId), "manifest-v2.json");
}

export function clearManifestV2Cache() {
  cache.clear();
}
