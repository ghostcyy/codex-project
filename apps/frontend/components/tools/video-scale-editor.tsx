"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GeometryState } from "../../lib/video-geometry";
import type { VideoMetadata } from "../../lib/video-metadata";

const FIXED_CANVAS_WIDTH = 1280;
const FIXED_CANVAS_HEIGHT = 720;
const PREVIEW_PADDING = 24;

function parsePositiveInt(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function makeEvenFloor(value: number, minimum = 2) {
  const floored = Math.floor(value);
  const even = floored % 2 === 0 ? floored : floored - 1;
  return Math.max(minimum, even);
}

function deriveScaledResolution(geometryState: GeometryState, sourceWidth: number, sourceHeight: number) {
  const safeSourceWidth = sourceWidth > 0 ? sourceWidth : 1280;
  const safeSourceHeight = sourceHeight > 0 ? sourceHeight : 720;
  const aspectRatio = safeSourceWidth / safeSourceHeight;
  const targetWidth = parsePositiveInt(geometryState.scaleWidth, 1280);
  const targetHeight = parsePositiveInt(geometryState.scaleHeight, 720);

  if (geometryState.scalePreset === "按宽度等比缩放") {
    return {
      width: makeEvenFloor(targetWidth),
      height: makeEvenFloor(targetWidth / aspectRatio)
    };
  }

  if (geometryState.scalePreset === "按高度等比缩放") {
    return {
      width: makeEvenFloor(targetHeight * aspectRatio),
      height: makeEvenFloor(targetHeight)
    };
  }

  if (geometryState.scalePreset === "固定宽高输出") {
    return {
      width: makeEvenFloor(targetWidth),
      height: makeEvenFloor(targetHeight)
    };
  }

  const scale = Math.min(targetWidth / safeSourceWidth, targetHeight / safeSourceHeight);
  return {
    width: makeEvenFloor(safeSourceWidth * scale),
    height: makeEvenFloor(safeSourceHeight * scale)
  };
}

function getPreviewFrame(targetWidth: number, targetHeight: number) {
  const maxWidth = FIXED_CANVAS_WIDTH - PREVIEW_PADDING * 2;
  const maxHeight = FIXED_CANVAS_HEIGHT - PREVIEW_PADDING * 2;
  const scale = Math.min(maxWidth / targetWidth, maxHeight / targetHeight);

  return {
    width: targetWidth * scale,
    height: targetHeight * scale
  };
}

function getPreviewSummary(geometryState: GeometryState) {
  if (geometryState.scalePreset === "按宽度等比缩放") {
    return "按目标宽度等比重算高度";
  }

  if (geometryState.scalePreset === "按高度等比缩放") {
    return "按目标高度等比重算宽度";
  }

  if (geometryState.scalePreset === "固定宽高输出") {
    return "直接输出固定分辨率";
  }

  return "自定义尺寸下保持宽高比，并自动收口到偶数分辨率";
}

export function VideoScaleEditor({
  geometryState,
  onGeometryStateChange,
  sourcePreviewUrl,
  videoMetadata
}: {
  geometryState: GeometryState;
  onGeometryStateChange: (next: GeometryState) => void;
  sourcePreviewUrl: string | null;
  videoMetadata: VideoMetadata | null;
}) {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const sourceWidth = videoMetadata?.video?.resolution.width ?? 0;
  const sourceHeight = videoMetadata?.video?.resolution.height ?? 0;
  const scaledResolution = useMemo(
    () => deriveScaledResolution(geometryState, sourceWidth, sourceHeight),
    [geometryState, sourceHeight, sourceWidth]
  );
  const widthIsAuto = geometryState.scalePreset === "按高度等比缩放";
  const heightIsAuto = geometryState.scalePreset === "按宽度等比缩放";
  const previewFrame = useMemo(
    () => getPreviewFrame(scaledResolution.width, scaledResolution.height),
    [scaledResolution.height, scaledResolution.width]
  );
  const hasPreviewVideo = Boolean(sourcePreviewUrl && sourceWidth > 0 && sourceHeight > 0);

  useEffect(() => {
    const videoElement = previewVideoRef.current;
    if (!videoElement || !sourcePreviewUrl) {
      return undefined;
    }

    const seekToPreviewFrame = () => {
      const seekTarget = Math.min(Math.max(videoElement.duration || 0, 0), 0.05);
      try {
        videoElement.currentTime = seekTarget;
      } catch {
        videoElement.pause();
      }
    };

    const handleSeeked = () => {
      videoElement.pause();
    };

    videoElement.addEventListener("loadedmetadata", seekToPreviewFrame);
    videoElement.addEventListener("seeked", handleSeeked);

    if (videoElement.readyState >= 1) {
      seekToPreviewFrame();
    }

    return () => {
      videoElement.removeEventListener("loadedmetadata", seekToPreviewFrame);
      videoElement.removeEventListener("seeked", handleSeeked);
    };
  }, [sourcePreviewUrl]);

  return (
    <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">缩放预设</span>
          <select
            value={geometryState.scalePreset}
            onChange={(event) => onGeometryStateChange({ ...geometryState, scalePreset: event.target.value })}
            className="select-input"
          >
            {["按宽度等比缩放", "按高度等比缩放", "固定宽高输出", "自定义尺寸"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">目标宽度</span>
            <input
              type="text"
              value={widthIsAuto ? `${scaledResolution.width}（自动）` : geometryState.scaleWidth}
              onChange={(event) => onGeometryStateChange({ ...geometryState, scaleWidth: event.target.value })}
              placeholder="例如 1280"
              readOnly={widthIsAuto}
              className={widthIsAuto ? "text-input cursor-not-allowed bg-[var(--accent-softer)] text-[var(--muted)]" : "text-input"}
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">目标高度</span>
            <input
              type="text"
              value={heightIsAuto ? `${scaledResolution.height}（自动）` : geometryState.scaleHeight}
              onChange={(event) => onGeometryStateChange({ ...geometryState, scaleHeight: event.target.value })}
              placeholder="例如 720"
              readOnly={heightIsAuto}
              className={heightIsAuto ? "text-input cursor-not-allowed bg-[var(--accent-softer)] text-[var(--muted)]" : "text-input"}
            />
          </label>
        </div>

        <div className="rounded-[18px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3 text-sm leading-7 text-[var(--muted)]">
          当前预估输出为 {scaledResolution.width} × {scaledResolution.height}。{getPreviewSummary(geometryState)}。
        </div>
      </div>

      <div className="rounded-[22px] border border-[var(--line)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--ink)]">缩放画布</p>
        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">外层预览区域固定，内部按当前缩放策略展示预估输出分辨率。</p>

        <div className="mt-4">
          <div
            className="relative mx-auto w-full max-w-[1280px] overflow-hidden rounded-[20px] border border-[var(--line)] bg-white/32"
            style={{ aspectRatio: `${FIXED_CANVAS_WIDTH} / ${FIXED_CANVAS_HEIGHT}` }}
          >
            <div className="absolute inset-0 bg-white/24" />

            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div
                className="relative overflow-hidden rounded-[18px] border border-[var(--line)] bg-slate-950 shadow-[0_22px_64px_rgba(15,23,42,0.16)]"
                style={{
                  width: `${(previewFrame.width / FIXED_CANVAS_WIDTH) * 100}%`,
                  height: `${(previewFrame.height / FIXED_CANVAS_HEIGHT) * 100}%`
                }}
              >
                {hasPreviewVideo ? (
                  <video
                    ref={previewVideoRef}
                    key={`${sourcePreviewUrl}-${geometryState.scalePreset}-${geometryState.scaleWidth}-${geometryState.scaleHeight}`}
                    src={sourcePreviewUrl ?? undefined}
                    muted
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full"
                    style={{
                      objectFit: geometryState.scalePreset === "固定宽高输出" ? "fill" : "cover"
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-white/76">
                    上传视频后，这里会显示第一帧缩放预览。
                  </div>
                )}

                <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/56 px-3 py-1 text-xs font-semibold text-white">
                  {scaledResolution.width} × {scaledResolution.height}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
