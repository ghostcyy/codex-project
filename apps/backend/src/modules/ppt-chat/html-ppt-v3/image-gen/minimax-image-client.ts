import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import type { V3ImageGenerationClient } from "../stages/stage2_5-image-generation";

export const MINIMAX_DEFAULT_IMAGE_MODEL = "image-01";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_IMAGE_MIME = "image/png";

export type MiniMaxImageClientOptions = {
  config: ActiveLlmConfig;
  imageModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class MiniMaxImageClient implements V3ImageGenerationClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MiniMaxImageClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateImage(args: {
    prompt: string;
    outputDir: string;
    fileBaseName: string;
    imageModel?: string;
  }): Promise<{ relativePath: string | null; warnings: string[]; absolutePath?: string }> {
    validateImageRequest(this.options.config, args.prompt);
    const apiKey = imageApiKeyFromConfig(this.options.config);
    const warnings: string[] = [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const imageBaseUrl = this.options.config.imageBaseUrl?.trim() || this.options.config.baseUrl;
      const response = await this.fetchImpl(normalizeMiniMaxImageEndpoint(imageBaseUrl, this.options.config.providerType), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: imageModelFromConfig(args.imageModel ?? this.options.imageModel ?? this.options.config.imageModel),
          prompt: args.prompt,
          aspect_ratio: "16:9",
          response_format: "base64",
          n: 1,
          prompt_optimizer: true,
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = safeJsonParse(text);
      if (!response.ok) {
        return {
          relativePath: null,
          warnings: [`MiniMax image generation failed (${response.status}): ${text.slice(0, 240)}`]
        };
      }

      const image = extractImagePayload(payload ?? text);
      if (!image) {
        return {
          relativePath: null,
          warnings: [formatMissingImageWarning(payload)]
        };
      }

      const bytes = image.kind === "url" ? await this.downloadImage(image.value) : Buffer.from(image.value, "base64");
      if (!bytes.length) {
        return {
          relativePath: null,
          warnings: ["MiniMax image response contained empty image data."]
        };
      }

      const extension = extensionFromMime(image.mime) ?? ".png";
      const fileName = `${safeFileBaseName(args.fileBaseName)}${extension}`;
      const outputDir = resolve(args.outputDir);
      mkdirSync(outputDir, { recursive: true });
      const outputPath = resolve(outputDir, fileName);
      const outputRelative = relative(outputDir, outputPath);
      if (outputRelative.startsWith("..") || outputRelative === "" || outputRelative.includes(":")) {
        return {
          relativePath: null,
          warnings: ["MiniMax image output path failed safety validation."]
        };
      }
      writeFileSync(outputPath, bytes);
      return {
        relativePath: buildGeneratedImageRelativePathFromFileName(basename(outputPath)),
        absolutePath: outputPath,
        warnings,
      };
    } catch (error) {
      return {
        relativePath: null,
        warnings: [`MiniMax image generation error: ${error instanceof Error ? error.message : String(error)}`]
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`image URL download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
}

export function normalizeMiniMaxImageEndpoint(baseUrl: string, providerType?: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("MiniMax image generation requires config.baseUrl.");
  if (/\/(?:image_generation|images\/generations)$/i.test(trimmed)) return trimmed;

  const host = (() => {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === "mimimax.cn" || host.endsWith(".mimimax.cn")) {
    if (/\/v1$/i.test(trimmed)) return `${trimmed}/images/generations`;
    return `${trimmed}/v1/images/generations`;
  }

  if (providerType === "openai-compatible") {
    if (/\/v1$/i.test(trimmed)) return `${trimmed}/images/generations`;
    return `${trimmed}/v1/images/generations`;
  }

  if (/\/v1$/i.test(trimmed)) return `${trimmed}/image_generation`;
  return `${trimmed}/v1/image_generation`;
}

function imageModelFromConfig(imageModel?: string) {
  return imageModel?.trim() || MINIMAX_DEFAULT_IMAGE_MODEL;
}

type ExtractedImage =
  | { kind: "base64"; value: string; mime: string }
  | { kind: "url"; value: string; mime: string };

export type MiniMaxImageCandidate =
  | { kind: "base64"; data: string; mimeType: string }
  | { kind: "url"; url: string; mimeType: string };

export async function generateMiniMaxImage(args: {
  config: ActiveLlmConfig;
  prompt: string;
  workdir: string;
  slideIndex: number;
  slotIndex: number;
  imageModel?: string;
  fetchImpl?: typeof fetch;
}) {
  validateImageRequest(args.config, args.prompt);
  return new MiniMaxImageClient({ config: args.config, imageModel: args.imageModel, fetchImpl: args.fetchImpl }).generateImage({
    prompt: args.prompt,
    outputDir: resolve(args.workdir, "img", "generated"),
    fileBaseName: buildGeneratedImageFileBaseName(args.slideIndex, args.slotIndex),
  });
}

export function buildGeneratedImageRelativePath(slideIndex: number, slotIndex: number) {
  return buildGeneratedImageRelativePathFromFileName(`${buildGeneratedImageFileBaseName(slideIndex, slotIndex)}.png`);
}

export function resolveGeneratedImagePath(workdir: string, relativePath: string) {
  if (!workdir.trim()) throw new Error("MiniMax image generation requires a workdir.");
  if (!relativePath.startsWith("img/generated/")) {
    throw new Error("Generated image relative path must start with img/generated/.");
  }
  if (relativePath.replace(/\\/g, "/").split("/").some((part) => !part || part === "..")) {
    throw new Error("Generated image path contains unsafe path segments.");
  }
  const root = resolve(workdir, "img", "generated");
  const outputPath = resolve(workdir, relativePath);
  const outputRelative = relative(root, outputPath);
  if (outputRelative.startsWith("..") || outputRelative.includes(":") || outputRelative === "") {
    throw new Error("Generated image path escapes workdir/img/generated.");
  }
  return outputPath;
}

export function extractMiniMaxImageCandidate(payload: unknown): MiniMaxImageCandidate | null {
  const image = extractImagePayload(payload);
  if (!image) return null;
  return image.kind === "url"
    ? { kind: "url", url: image.value, mimeType: image.mime }
    : { kind: "base64", data: image.value, mimeType: image.mime };
}

export function extractImagePayload(payload: unknown): ExtractedImage | null {
  const visited = new Set<unknown>();
  const found = findImageValue(payload, visited);
  if (!found) return null;
  if (/^data:image\//i.test(found)) {
    const match = found.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    return match ? { kind: "base64", mime: match[1] ?? DEFAULT_IMAGE_MIME, value: match[2] ?? "" } : null;
  }
  if (/^https?:\/\//i.test(found)) {
    return { kind: "url", mime: mimeFromExtension(extname(new URL(found).pathname)) ?? DEFAULT_IMAGE_MIME, value: found };
  }
  if (looksLikeBase64(found)) {
    return { kind: "base64", mime: DEFAULT_IMAGE_MIME, value: found };
  }
  return null;
}

function formatMissingImageWarning(payload: unknown) {
  const baseResp = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).base_resp
    : null;
  if (baseResp && typeof baseResp === "object") {
    const record = baseResp as Record<string, unknown>;
    const statusCode = typeof record.status_code === "number" || typeof record.status_code === "string"
      ? String(record.status_code)
      : "";
    const statusMsg = typeof record.status_msg === "string" ? record.status_msg.trim() : "";
    const detail = [statusCode, statusMsg].filter(Boolean).join(" ");
    if (detail) return `MiniMax image generation returned no image: ${detail}`;
  }
  return "MiniMax image response did not include image data.";
}

function findImageValue(value: unknown, visited: Set<unknown>): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    return /^data:image\//i.test(value) || /^https?:\/\/.+\.(?:png|jpe?g|webp)(?:\?|$)/i.test(value) || looksLikeBase64(value)
      ? value
      : null;
  }
  if (typeof value !== "object") return null;
  if (visited.has(value)) return null;
  visited.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ["base64", "b64_json", "image_base64", "image_data", "image", "data", "url", "image_url", "image_urls"]) {
    const direct = findImageValue(record[key], visited);
    if (direct) return direct;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findImageValue(item, visited);
      if (nested) return nested;
    }
    return null;
  }
  for (const nested of Object.values(record)) {
    const found = findImageValue(nested, visited);
    if (found) return found;
  }
  return null;
}

function safeFileBaseName(input: string) {
  const base = input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `image-${Date.now()}`;
}

function extensionFromMime(mime: string) {
  if (/jpeg|jpg/i.test(mime)) return ".jpg";
  if (/webp/i.test(mime)) return ".webp";
  if (/gif/i.test(mime)) return ".gif";
  if (/png/i.test(mime)) return ".png";
  return null;
}

function mimeFromExtension(extension: string) {
  if (/\.jpe?g/i.test(extension)) return "image/jpeg";
  if (/\.webp/i.test(extension)) return "image/webp";
  if (/\.png/i.test(extension)) return "image/png";
  return null;
}

function buildGeneratedImageFileBaseName(slideIndex: number, slotIndex: number) {
  if (!Number.isInteger(slideIndex) || slideIndex < 1) {
    throw new Error("MiniMax image generation requires slideIndex to be a positive integer.");
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0) {
    throw new Error("MiniMax image generation requires slotIndex to be a non-negative integer.");
  }
  return `slide-${String(slideIndex).padStart(2, "0")}-slot-${String(slotIndex + 1).padStart(2, "0")}`;
}

function buildGeneratedImageRelativePathFromFileName(fileName: string) {
  return `img/generated/${fileName}`;
}

function looksLikeBase64(value: string) {
  const compact = value.trim();
  return compact.length > 40 && /^[a-zA-Z0-9+/]+={0,2}$/.test(compact);
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateImageRequest(config: ActiveLlmConfig, prompt: string) {
  if (!(config.imageBaseUrl?.trim() || config.baseUrl?.trim())) throw new Error("MiniMax image generation requires config.imageBaseUrl or config.baseUrl.");
  if (!imageApiKeyFromConfig(config)) throw new Error("MiniMax image generation requires config.imageApiKey or config.apiKey.");
  if (!prompt.trim()) throw new Error("MiniMax image generation requires a non-empty prompt.");
}

function imageApiKeyFromConfig(config: ActiveLlmConfig) {
  return config.imageApiKey?.trim() || config.apiKey?.trim() || "";
}
