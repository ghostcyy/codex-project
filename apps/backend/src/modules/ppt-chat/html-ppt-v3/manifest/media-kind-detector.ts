import { MEDIA_KINDS, type MediaKind } from "../shared";

const REMOTE_URL_PATTERN = /https?:\/\/[^"')\s]+/gi;
const CSS_IMAGE_URL_PATTERN = /url\(["']?((?:https?:\/\/|img\/)[^"')\s]+)["']?\)/gi;
const LOCAL_IMAGE_URL_PATTERN = /\bimg\/[^"')\s]+\.(?:png|jpe?g|webp|gif|svg)(?:[?#][^"')\s]*)?/gi;
const IMAGE_CLASS_PATTERN = /class=["'][^"']*(?:img-wrap|image-slot|photo)[^"']*["']/i;
const CHART_PATTERN = /<canvas\b|data-chart-slot|class=["'][^"']*(?:chart-card|chart-container|chart-wrapper|chart-legend|pie-chart|bar-chart|line-chart|xbar-chart|s-chart|donut-chart|area-chart|gantt-chart)[^"']*["']/i;
const AUDIO_PATTERN = /<audio\b|class=["'][^"']*(?:audio-frame|audio-player|voice-wave)[^"']*["']|\.mp3\b|\.wav\b/i;
const VIDEO_PATTERN = /<video\b|data-video-slot|\.mp4\b|\.webm\b|\.mov\b|class=["'][^"']*(?:video-frame|video-player|video-card|play-btn|play-button)[^"']*["']|▶|RESPONSE_VOD|LIVE_EXERCISE|FEED:\s*LIVE/i;

export function detectMediaKinds(html: string): MediaKind[] {
  const detected: MediaKind[] = [];
  if (detectsImageMedia(html)) detected.push("image");
  if (detectsChartMedia(html)) detected.push("chart");
  if (AUDIO_PATTERN.test(html)) detected.push("audio");
  if (VIDEO_PATTERN.test(html)) detected.push("video");
  return MEDIA_KINDS.filter((kind) => detected.includes(kind));
}

export function detectsImageMedia(value: string) {
  return /<img\b/i.test(value)
    || /data-image-slot/i.test(value)
    || IMAGE_CLASS_PATTERN.test(value)
    || CSS_IMAGE_URL_PATTERN.test(resetLastIndex(value, CSS_IMAGE_URL_PATTERN))
    || LOCAL_IMAGE_URL_PATTERN.test(resetLastIndex(value, LOCAL_IMAGE_URL_PATTERN))
    || findRemoteImageUrls(value).length > 0;
}

export function detectsChartMedia(value: string) {
  return CHART_PATTERN.test(value) || detectsSvgChartMedia(value);
}

export function findRemoteImageUrls(value: string): string[] {
  return [...new Set(
    [...value.matchAll(REMOTE_URL_PATTERN)]
      .map((match) => match[0])
      .filter(isRemoteImageUrl)
  )];
}

export function hasRemoteImageUrls(value: string) {
  return findRemoteImageUrls(value).length > 0;
}

function isRemoteImageUrl(url: string) {
  return /\/\/(?:images\.unsplash\.com|source\.unsplash\.com)\//i.test(url)
    || /\.(?:png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(url);
}

function detectsSvgChartMedia(value: string) {
  if (!/<svg\b/i.test(value)) return false;
  const hasChartContext = /\b(?:chart|trend|distribution|metrics?|forecast|revenue|growth|multiplier|q[1-4]\s*20\d{2})\b/i.test(value);
  const hasChartPrimitives = /<(?:path|polyline|rect|circle)\b/i.test(value) && /<text\b/i.test(value);
  return hasChartContext || hasChartPrimitives;
}

function resetLastIndex(value: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return value;
}
