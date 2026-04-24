"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GeometryState } from "../../lib/video-geometry";
import type { VideoMetadata } from "../../lib/video-metadata";

const FIXED_CANVAS_WIDTH = 1280;
const FIXED_CANVAS_HEIGHT = 720;

const PAD_COLOR_PREVIEW: Record<string, string> = {
  black: "#0f172a",
  white: "#ffffff",
  blur: "rgba(255,255,255,0.68)",
  transparent: "rgba(255,255,255,0.18)"
};

function parseCanvasSize(padCanvas: string) {
  const [widthText, heightText] = padCanvas.split("×");
  const width = Number.parseInt(widthText ?? "", 10);
  const height = Number.parseInt(heightText ?? "", 10);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1280, height: 720 };
  }

  return { width, height };
}

function getCanvasPreviewFrame(canvasWidth: number, canvasHeight: number) {
  const scale = Math.min(FIXED_CANVAS_WIDTH / canvasWidth, FIXED_CANVAS_HEIGHT / canvasHeight);
  const width = canvasWidth * scale;
  const height = canvasHeight * scale;

  return {
    width,
    height
  };
}

function getVideoPosition(align: string) {
  if (align === "顶部居中") {
    return "center top";
  }

  if (align === "底部居中") {
    return "center bottom";
  }

  if (align === "左侧居中") {
    return "left center";
  }

  if (align === "右侧居中") {
    return "right center";
  }

  return "center center";
}

export function VideoPadEditor({
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
  const customCanvasWidth = Number.parseInt(geometryState.padCustomWidth, 10);
  const customCanvasHeight = Number.parseInt(geometryState.padCustomHeight, 10);
  const targetCanvas = useMemo(() => {
    if (geometryState.padCanvas === "自定义画布") {
      return {
        width: Number.isFinite(customCanvasWidth) && customCanvasWidth > 0 ? customCanvasWidth : 1280,
        height: Number.isFinite(customCanvasHeight) && customCanvasHeight > 0 ? customCanvasHeight : 720
      };
    }

    return parseCanvasSize(geometryState.padCanvas);
  }, [customCanvasHeight, customCanvasWidth, geometryState.padCanvas]);
  const previewFrame = useMemo(
    () => getCanvasPreviewFrame(targetCanvas.width, targetCanvas.height),
    [targetCanvas.height, targetCanvas.width]
  );

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

  const sourceWidth = videoMetadata?.video?.resolution.width ?? 0;
  const sourceHeight = videoMetadata?.video?.resolution.height ?? 0;
  const hasPreviewVideo = Boolean(sourcePreviewUrl && sourceWidth > 0 && sourceHeight > 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">目标画布</span>
          <select
            value={geometryState.padCanvas}
            onChange={(event) => onGeometryStateChange({ ...geometryState, padCanvas: event.target.value })}
            className="select-input"
          >
            {["1280×720", "1920×1080", "1080×1920", "自定义画布"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {geometryState.padCanvas === "自定义画布" ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--ink)]">自定义 X</span>
              <input
                type="text"
                value={geometryState.padCustomWidth}
                onChange={(event) => onGeometryStateChange({ ...geometryState, padCustomWidth: event.target.value })}
                placeholder="例如 1280"
                className="text-input"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-[var(--ink)]">自定义 Y</span>
              <input
                type="text"
                value={geometryState.padCustomHeight}
                onChange={(event) => onGeometryStateChange({ ...geometryState, padCustomHeight: event.target.value })}
                placeholder="例如 720"
                className="text-input"
              />
            </label>
          </div>
        ) : null}

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">补边颜色</span>
          <select
            value={geometryState.padColor}
            onChange={(event) => onGeometryStateChange({ ...geometryState, padColor: event.target.value })}
            className="select-input"
          >
            {["black", "white", "blur", "transparent"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">对齐方式</span>
          <select
            value={geometryState.padAlign}
            onChange={(event) => onGeometryStateChange({ ...geometryState, padAlign: event.target.value })}
            className="select-input"
          >
            {["居中", "顶部居中", "底部居中", "左侧居中", "右侧居中"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded-[18px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3 text-sm leading-7 text-[var(--muted)]">
          右侧会按目标画布比例和补边颜色生成输出画布，并把当前视频第一帧叠到最上层。
        </div>
      </div>

      <div className="rounded-[22px] border border-[var(--line)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--ink)]">补边画布</p>
        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">外层预览区域固定，内部输出画布会随目标尺寸比例变化。</p>

        <div className="mt-4">
          <div
            className="relative mx-auto w-full max-w-[1280px] overflow-hidden rounded-[20px] border border-[var(--line)] bg-white/32"
            style={{ aspectRatio: `${FIXED_CANVAS_WIDTH} / ${FIXED_CANVAS_HEIGHT}` }}
          >
            <div className="absolute inset-0 bg-white/24" />

            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div
                className="relative overflow-hidden rounded-[18px] border border-[var(--line)] shadow-[0_22px_64px_rgba(15,23,42,0.16)]"
                style={{
                  width: `${(previewFrame.width / FIXED_CANVAS_WIDTH) * 100}%`,
                  height: `${(previewFrame.height / FIXED_CANVAS_HEIGHT) * 100}%`,
                  background: PAD_COLOR_PREVIEW[geometryState.padColor] ?? PAD_COLOR_PREVIEW.black
                }}
              >
                {hasPreviewVideo ? (
                  <video
                    ref={previewVideoRef}
                    key={`${sourcePreviewUrl}-${geometryState.padCanvas}-${geometryState.padAlign}`}
                    src={sourcePreviewUrl ?? undefined}
                    muted
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full"
                    style={{
                      objectFit: "contain",
                      objectPosition: getVideoPosition(geometryState.padAlign)
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-[var(--muted)]">
                    上传视频后，这里会显示第一帧补边预览。
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
