/**
 * html-ppt-v3 :: manifest.loader.ts
 *
 * Loads and validates a TemplateManifest from the template folder's
 * manifest.json at runtime. Results are cached in-process.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { templateManifestSchema, type TemplateManifest } from "./manifest.types";

// Resolved at runtime: walk up from __dirname to find the monorepo root
// __dirname = apps/backend/src/modules/ppt-chat/html-ppt-v3/manifest
const TEMPLATES_ROOT = resolve(
  __dirname,
  "../../../../../../../.agents/skills/html-ppt/templates/full-decks/gemini"
);

const cache = new Map<string, TemplateManifest>();

/**
 * Load a single template's manifest.json.
 * Throws if the file is missing or fails Zod validation.
 */
export async function loadManifest(templateId: string): Promise<TemplateManifest> {
  if (cache.has(templateId)) return cache.get(templateId)!;

  const filePath = join(TEMPLATES_ROOT, templateId, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`Manifest not found for template '${templateId}': ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Manifest JSON parse error for template '${templateId}': ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = templateManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Manifest validation failed for template '${templateId}': ${issues}`);
  }

  cache.set(templateId, result.data);
  return result.data;
}

/**
 * List all template IDs that have a manifest.json available.
 */
export async function listAvailableTemplateIds(): Promise<string[]> {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(TEMPLATES_ROOT, entry.name, "manifest.json");
    try {
      await readFile(manifestPath, "utf8");
      ids.push(entry.name);
    } catch {
      // no manifest yet — skip
    }
  }
  return ids.sort();
}

/**
 * Return absolute path to a template's index.html.
 */
export function resolveTemplateHtmlPath(templateId: string): string {
  return join(TEMPLATES_ROOT, templateId, "index.html");
}

/**
 * Return absolute path to a template directory.
 */
export function resolveTemplateDir(templateId: string): string {
  return join(TEMPLATES_ROOT, templateId);
}
