const ONE_MEGABYTE = 1024 * 1024;

const DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_CHUNK_BYTES = 8 * ONE_MEGABYTE;
const DEFAULT_VIDEO_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_VIDEO_RATE_LIMIT_REQUESTS = 30;
const DEFAULT_VIDEO_RATE_LIMIT_CHUNK_REQUESTS = 1200;
const DEFAULT_VIDEO_RATE_LIMIT_OUTPUT_REQUESTS = 120;

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMaxVideoUploadBytes() {
  return parsePositiveNumber(process.env.VIDEO_MAX_UPLOAD_BYTES, DEFAULT_MAX_VIDEO_UPLOAD_BYTES);
}

export function getMaxVideoChunkBytes() {
  return parsePositiveNumber(process.env.VIDEO_MAX_CHUNK_BYTES, DEFAULT_MAX_VIDEO_CHUNK_BYTES);
}

export function getVideoRateLimitWindowMs() {
  return parsePositiveNumber(process.env.VIDEO_RATE_LIMIT_WINDOW_MS, DEFAULT_VIDEO_RATE_LIMIT_WINDOW_MS);
}

export function getVideoRateLimitRequests() {
  return parsePositiveNumber(process.env.VIDEO_RATE_LIMIT_REQUESTS, DEFAULT_VIDEO_RATE_LIMIT_REQUESTS);
}

export function getVideoChunkRateLimitRequests() {
  return parsePositiveNumber(process.env.VIDEO_RATE_LIMIT_CHUNK_REQUESTS, DEFAULT_VIDEO_RATE_LIMIT_CHUNK_REQUESTS);
}

export function getVideoOutputRateLimitRequests() {
  return parsePositiveNumber(process.env.VIDEO_RATE_LIMIT_OUTPUT_REQUESTS, DEFAULT_VIDEO_RATE_LIMIT_OUTPUT_REQUESTS);
}

export function formatBytes(bytes: number) {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
