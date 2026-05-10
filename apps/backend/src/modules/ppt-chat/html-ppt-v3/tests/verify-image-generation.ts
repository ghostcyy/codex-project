import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ActiveLlmConfig } from "../../../llm-config/llm-config.types";
import {
  buildGeneratedImageRelativePath,
  extractMiniMaxImageCandidate,
  generateMiniMaxImage,
  MINIMAX_DEFAULT_IMAGE_MODEL,
  normalizeMiniMaxImageEndpoint,
  resolveGeneratedImagePath
} from "../image-gen";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

const config: ActiveLlmConfig = {
  id: "cfg-minimax",
  name: "MiniMax",
  providerType: "minimax",
  baseUrl: "https://api.minimax.io/v1",
  apiKey: "test-key",
  model: "MiniMax-M2.7",
  stageModelOverrides: {},
  enabled: true
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  verifyEndpointNormalization();
  verifyImageExtraction();
  verifyPathSafety();
  await verifyBase64Generation();
  await verifyImageApiKeyOverride();
  await verifyImageBaseUrlOverride();
  await verifyImageModelFromConfig();
  await verifyUrlGenerationDownload();
  await verifyMissingImageReturnsWarnings();
  await verifyBaseRespMissingImageWarning();

  console.log("HTML-PPT v3 image generation verification passed.");
}

function verifyEndpointNormalization() {
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://api.minimax.io/v1"),
    "https://api.minimax.io/v1/image_generation",
    "baseUrl ending in /v1 should append /image_generation"
  );
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://api.minimax.io/v1/"),
    "https://api.minimax.io/v1/image_generation",
    "baseUrl ending in /v1/ should normalize trailing slash"
  );
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://api.minimax.io"),
    "https://api.minimax.io/v1/image_generation",
    "baseUrl without /v1 should append /v1/image_generation"
  );
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://mimimax.cn/v1"),
    "https://mimimax.cn/v1/images/generations",
    "mimimax.cn relay should use the OpenAI-compatible image generation endpoint"
  );
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://mimimax.cn"),
    "https://mimimax.cn/v1/images/generations",
    "mimimax.cn relay without /v1 should append /v1/images/generations"
  );
  assertEqual(
    normalizeMiniMaxImageEndpoint("https://v2.aicodee.com/v1", "openai-compatible"),
    "https://v2.aicodee.com/v1/images/generations",
    "OpenAI-compatible relays should use the /images/generations endpoint"
  );
}

function verifyImageExtraction() {
  const base64Candidate = extractMiniMaxImageCandidate({
    data: { image_base64: [PNG_BASE64] }
  });
  assert(base64Candidate?.kind === "base64", "should extract official data.image_base64 responses");
  assertEqual(base64Candidate.data, PNG_BASE64, "should preserve extracted base64 payload");

  const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
  const dataUrlCandidate = extractMiniMaxImageCandidate({
    data: [{ b64_json: dataUrl }]
  });
  assert(dataUrlCandidate?.kind === "base64", "should extract data URL image payloads");
  assertEqual(dataUrlCandidate.mimeType, "image/png", "should keep data URL mime type");
  assertEqual(dataUrlCandidate.data, PNG_BASE64, "should strip the data URL prefix");

  const urlCandidate = extractMiniMaxImageCandidate({
    data: { image_urls: ["https://cdn.example.test/generated.png"] }
  });
  assert(urlCandidate?.kind === "url", "should extract official data.image_urls responses");
  assertEqual(urlCandidate.url, "https://cdn.example.test/generated.png", "should preserve image URL");
}

function verifyPathSafety() {
  const workdir = makeWorkdir("paths");
  const relativePath = buildGeneratedImageRelativePath(5, 0);
  assertEqual(relativePath, "img/generated/slide-05-slot-01.png", "should use stable generated image relative path");

  const safePath = resolveGeneratedImagePath(workdir, relativePath);
  assert(
    safePath.startsWith(resolve(workdir, "img", "generated")),
    "safe generated path should stay inside workdir/img/generated"
  );

  assertThrows(
    () => resolveGeneratedImagePath(workdir, "img/generated/../escape.png"),
    "path traversal should be rejected"
  );
}

async function verifyBase64Generation() {
  const workdir = makeWorkdir("base64");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: stringifyFetchInput(input), init });
    return jsonResponse({ data: { image_base64: [PNG_BASE64] } });
  };

  const result = await generateMiniMaxImage({
    config,
    prompt: "wide cinematic city skyline",
    workdir,
    slideIndex: 5,
    slotIndex: 0,
    fetchImpl
  });

  assertEqual(result.relativePath, "img/generated/slide-05-slot-01.png", "should return saved relative path");
  assertEqual(result.warnings.length, 0, "successful base64 generation should not warn");
  assertEqual(calls[0]?.url, "https://api.minimax.io/v1/image_generation", "should call normalized endpoint");

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assertEqual(headers.Authorization, "Bearer test-key", "should use text config API key as bearer token");
  assertEqual(headers["Content-Type"], "application/json", "should send JSON");

  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assertEqual(body.model, MINIMAX_DEFAULT_IMAGE_MODEL, "should default to MiniMax image model");
  assertEqual(body.prompt, "wide cinematic city skyline", "should send the image prompt");
  assertEqual(body.aspect_ratio, "16:9", "should default to deck-friendly 16:9 image output");
  assertEqual(body.response_format, "base64", "should request base64 so assets can be persisted locally");
  assertEqual(body.n, 1, "should request one image per slot");
  assertEqual(body.prompt_optimizer, true, "should enable MiniMax prompt optimization by default");

  const saved = readFileSync(join(workdir, "img", "generated", "slide-05-slot-01.png"));
  assert(saved.equals(PNG_BYTES), "should save decoded image bytes");
}

async function verifyImageApiKeyOverride() {
  const workdir = makeWorkdir("image-key");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: stringifyFetchInput(input), init });
    return jsonResponse({ data: { image_base64: [PNG_BASE64] } });
  };

  await generateMiniMaxImage({
    config: { ...config, imageApiKey: "image-key" },
    prompt: "use the dedicated image key",
    workdir,
    slideIndex: 3,
    slotIndex: 0,
    fetchImpl
  });

  const headers = calls[0]?.init?.headers as Record<string, string>;
  assertEqual(headers.Authorization, "Bearer image-key", "should prefer dedicated image API key when configured");
}

async function verifyImageBaseUrlOverride() {
  const workdir = makeWorkdir("image-base-url");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: stringifyFetchInput(input), init });
    return jsonResponse({ data: { image_base64: [PNG_BASE64] } });
  };

  await generateMiniMaxImage({
    config: { ...config, providerType: "openai-compatible", baseUrl: "https://text.example.test/v1", imageBaseUrl: "https://mimimax.cn/v1" },
    prompt: "use the dedicated image base URL",
    workdir,
    slideIndex: 4,
    slotIndex: 0,
    fetchImpl
  });

  assertEqual(calls[0]?.url, "https://mimimax.cn/v1/images/generations", "should prefer dedicated image base URL when configured");
}

async function verifyImageModelFromConfig() {
  const workdir = makeWorkdir("image-model");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: stringifyFetchInput(input), init });
    return jsonResponse({ data: { image_base64: [PNG_BASE64] } });
  };

  await generateMiniMaxImage({
    config: { ...config, imageModel: "default-image-model" },
    prompt: "use dedicated default image model",
    workdir,
    slideIndex: 4,
    slotIndex: 1,
    fetchImpl
  });

  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assertEqual(body.model, "default-image-model", "should use image model from active image config when no explicit override is passed");
}

async function verifyUrlGenerationDownload() {
  const workdir = makeWorkdir("url");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = stringifyFetchInput(input);
    calls.push({ url, init });
    if (url === "https://cdn.example.test/generated.png") {
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/png" }
      });
    }
    return jsonResponse({ data: { image_urls: ["https://cdn.example.test/generated.png"] } });
  };

  const result = await generateMiniMaxImage({
    config: { ...config, baseUrl: "https://api.minimax.io" },
    prompt: "download this generated image",
    workdir,
    slideIndex: 2,
    slotIndex: 1,
    imageModel: "custom-image-model",
    fetchImpl
  });

  assertEqual(result.relativePath, "img/generated/slide-02-slot-02.png", "should save downloaded URL image locally");
  assertEqual(calls[0]?.url, "https://api.minimax.io/v1/image_generation", "should append /v1 when needed");
  assertEqual(calls[1]?.url, "https://cdn.example.test/generated.png", "should download returned image URLs");

  const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assertEqual(body.model, "custom-image-model", "should allow a caller-provided image model override");
}

async function verifyMissingImageReturnsWarnings() {
  const workdir = makeWorkdir("missing");
  const fetchImpl: typeof fetch = async () => jsonResponse({ data: {}, base_resp: { status_code: 0, status_msg: "success" } });

  const result = await generateMiniMaxImage({
    config,
    prompt: "no image in response",
    workdir,
    slideIndex: 1,
    slotIndex: 0,
    fetchImpl
  });

  assertEqual(result.relativePath, null, "missing image data should not claim a saved path");
  assert(
    result.warnings.some((warning) => warning.includes("did not include image data") || warning.includes("returned no image")),
    "missing image data should return a warning instead of throwing"
  );

  const generatedDir = join(workdir, "img", "generated");
  assert(
    !existsSync(generatedDir) || readdirSync(generatedDir).length === 0,
    "missing image data should not write placeholder files"
  );
}

async function verifyBaseRespMissingImageWarning() {
  const workdir = makeWorkdir("base-resp-warning");
  const fetchImpl: typeof fetch = async () => jsonResponse({
    data: null,
    base_resp: {
      status_code: 2013,
      status_msg: "invalid params, prompt length must be less than 1500"
    }
  });

  const result = await generateMiniMaxImage({
    config,
    prompt: "prompt that is too long",
    workdir,
    slideIndex: 1,
    slotIndex: 0,
    fetchImpl
  });

  assertEqual(result.relativePath, null, "base_resp no-image response should not claim a saved path");
  assert(
    result.warnings.some((warning) => warning.includes("2013") && warning.includes("prompt length must be less than 1500")),
    "base_resp no-image warning should expose MiniMax status_code and status_msg"
  );
}

function makeWorkdir(name: string) {
  const workdir = join(tmpdir(), `html-ppt-v3-image-generation-${name}`);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  return workdir;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stringifyFetchInput(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`);
  }
}

function assertThrows(fn: () => unknown, message: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}
