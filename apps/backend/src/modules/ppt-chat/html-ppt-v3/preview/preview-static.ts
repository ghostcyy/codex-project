import { access, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { HtmlPptV3StaleTemplateError } from "../shared";

export type ResolvedPreviewFile = {
  absolutePath: string;
  contentType: string;
};

export type ResolvePreviewOptions = {
  requireOutputMarker?: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

export async function resolvePreviewFile(previewRoot: string, requestPath: string, options: ResolvePreviewOptions = {}): Promise<ResolvedPreviewFile> {
  await assertCurrentPreviewManifest(previewRoot, options);

  const decodedPath = decodeURIComponent(requestPath || "index.html").replace(/\\/g, "/");
  const parts = decodedPath.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Preview path is invalid.");
  }

  const root = resolve(previewRoot);
  const absolutePath = resolve(root, ...parts);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error("Preview path escapes the job output directory.");
  }

  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error("Preview path is not a file.");
  }
  await access(absolutePath);

  return {
    absolutePath,
    contentType: CONTENT_TYPES[extname(absolutePath).toLowerCase()] ?? "application/octet-stream"
  };
}

async function assertCurrentPreviewManifest(previewRoot: string, options: ResolvePreviewOptions): Promise<void> {
  const root = resolve(previewRoot);
  const manifestPath = join(root, "manifest-v2.json");
  let raw = "";
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    // Final preview/zip output intentionally excludes template engineering files
    // such as manifest-v2.json and fragments/. In that case the current output
    // marker in index.html is the source of truth for freshness.
    if (options.requireOutputMarker !== false) {
      await assertCurrentPreviewIndex(root);
    }
    return;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new HtmlPptV3StaleTemplateError("manifest-v2.json is not valid JSON.");
  }

  if (!isRecord(manifest) || manifest["schemaVersion"] !== 2) {
    throw new HtmlPptV3StaleTemplateError("manifest-v2.json is missing schemaVersion=2.");
  }

  const pool = manifest["pool"];
  if (!isRecord(pool)) {
    throw new HtmlPptV3StaleTemplateError("manifest-v2.json is missing pool.");
  }

  for (const [key, value] of Object.entries(pool)) {
    if (!isRecord(value)) {
      throw new HtmlPptV3StaleTemplateError(`pool.${key} is invalid.`);
    }
    const fragmentId = typeof value["fragmentId"] === "string" ? value["fragmentId"] : "";
    if (fragmentId !== key) {
      throw new HtmlPptV3StaleTemplateError(`pool.${key}.fragmentId does not match its manifest key.`);
    }
    await assertFragmentFileExists(root, key, typeof value["htmlFile"] === "string" ? value["htmlFile"] : "");
  }

  const fixed = manifest["fixed"];
  if (isRecord(fixed)) {
    for (const fixedKey of ["cover", "closing"]) {
      const value = fixed[fixedKey];
      if (isRecord(value)) {
        await assertFragmentFileExists(root, fixedKey, typeof value["htmlFile"] === "string" ? value["htmlFile"] : "");
      }
    }
  }

  if (options.requireOutputMarker !== false) {
    await assertCurrentPreviewIndex(root);
  }
}

async function assertCurrentPreviewIndex(root: string): Promise<void> {
  const indexPath = join(root, "index.html");
  let html = "";
  try {
    html = await readFile(indexPath, "utf8");
  } catch {
    throw new HtmlPptV3StaleTemplateError("index.html is missing from the preview workdir.");
  }

  if (!/data-html-ppt-v3-output=["']fragment-id["']/i.test(html)) {
    throw new HtmlPptV3StaleTemplateError("index.html is missing the current fragment-id output marker.");
  }

  const legacyFragmentRef = html.match(/fragments\/(?:grid|title-text|sidebar|chart|image|audio|video|cta|thanks|toc)[^"')\s]*\.html/i);
  if (legacyFragmentRef) {
    throw new HtmlPptV3StaleTemplateError(`index.html still references legacy fragment '${legacyFragmentRef[0]}'.`);
  }

  const slideTags = html.match(/<section\b[^>]*\bslide\b[^>]*>/gi) ?? [];
  if (!slideTags.length) {
    throw new HtmlPptV3StaleTemplateError("index.html does not contain slide sections.");
  }
  for (const tag of slideTags) {
    if (/\bdata-page-type=["'](?:cover|closing)["']/i.test(tag)) continue;
    if (!/\bdata-fragment-id=["']slide-\d{2,3}["']/i.test(tag)) {
      throw new HtmlPptV3StaleTemplateError("index.html contains a middle slide without a slide-XX fragmentId.");
    }
  }
}

async function assertFragmentFileExists(root: string, label: string, htmlFile: string): Promise<void> {
  if (!htmlFile) {
    throw new HtmlPptV3StaleTemplateError(`fragment '${label}' is missing htmlFile.`);
  }
  if (htmlFile.includes("\\") || htmlFile.startsWith("/") || htmlFile.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new HtmlPptV3StaleTemplateError(`fragment '${label}' has invalid htmlFile '${htmlFile}'.`);
  }
  const absolutePath = resolve(root, ...htmlFile.split("/"));
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new HtmlPptV3StaleTemplateError(`fragment '${label}' htmlFile escapes preview root.`);
  }
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new HtmlPptV3StaleTemplateError(`fragment '${label}' htmlFile is not a file.`);
    }
  } catch (error) {
    if (error instanceof HtmlPptV3StaleTemplateError) throw error;
    throw new HtmlPptV3StaleTemplateError(`fragment '${label}' file '${htmlFile}' is missing.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
