import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { IMAGE_PAGE_TYPES, TEMPLATES_ROOT, type PageFragment, type TemplateManifestV2 } from "../shared";

type AuditRow = {
  templateId: string;
  imageSlots: number;
  imageCount: number;
  placeholder: boolean;
  required: number;
  status: "ok" | "fail";
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"]);
const PLACEHOLDER_IMAGE = "_placeholder.jpg";

async function main() {
  const rows = await auditGeminiImages();
  printRows(rows);

  if (rows.some((row) => row.status === "fail")) {
    process.exitCode = 1;
  }
}

export async function auditGeminiImages(): Promise<AuditRow[]> {
  const templateIds = await listTemplateIdsWithManifest();
  const rows: AuditRow[] = [];

  for (const templateId of templateIds) {
    const templateDir = join(TEMPLATES_ROOT, templateId);
    const manifest = JSON.parse(await readFile(join(templateDir, "manifest-v2.json"), "utf8")) as TemplateManifestV2;
    const imageSlots = countImageSlots(manifest);
    const imageCount = await countImageFiles(join(templateDir, "img"));
    const placeholder = existsSync(join(templateDir, "img", PLACEHOLDER_IMAGE));
    const required = imageSlots > 0 ? Math.max(3 * imageSlots, 3) : 0;
    const status = imageSlots === 0 || (placeholder && imageCount >= required) ? "ok" : "fail";

    rows.push({ templateId, imageSlots, imageCount, placeholder, required, status });
  }

  return rows;
}

async function listTemplateIdsWithManifest() {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  const ids: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(TEMPLATES_ROOT, entry.name, "manifest-v2.json"))) {
      ids.push(entry.name);
    }
  }

  return ids.sort();
}

function countImageSlots(manifest: TemplateManifestV2) {
  return listFragments(manifest)
    .filter((fragment) => IMAGE_PAGE_TYPES.includes(fragment.pageType))
    .reduce((sum, fragment) => sum + (fragment.imageSlotSelectors?.length ?? 0), 0);
}

function listFragments(manifest: TemplateManifestV2): PageFragment[] {
  return [manifest.fixed.cover, manifest.fixed.closing, ...Object.values(manifest.pool).filter(Boolean)] as PageFragment[];
}

async function countImageFiles(imgDir: string) {
  if (!existsSync(imgDir)) return 0;

  const entries = await readdir(imgDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    const file = join(imgDir, entry.name);
    const info = await stat(file);
    if (info.size > 0) count += 1;
  }

  return count;
}

function printRows(rows: AuditRow[]) {
  const headers = ["templateId", "imageSlots", "imageCount", "placeholder", "required", "status"];
  const values = rows.map((row) => [
    row.templateId,
    String(row.imageSlots),
    String(row.imageCount),
    row.placeholder ? "yes" : "no",
    String(row.required),
    row.status
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((value) => value[index]!.length))
  );

  console.log(formatRow(headers, widths));
  console.log(formatRow(widths.map((width) => "-".repeat(width)), widths));
  for (const value of values) {
    console.log(formatRow(value, widths));
  }
}

function formatRow(values: string[], widths: number[]) {
  return values.map((value, index) => value.padEnd(widths[index]!)).join(" | ");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
