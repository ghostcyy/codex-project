"use client";

import { useEffect, useRef } from "react";
import type { GeometryState } from "../../lib/video-geometry";

const FIXED_CANVAS_WIDTH = 1280;
const FIXED_CANVAS_HEIGHT = 720;

const ROTATE_OPTIONS = [
  { mode: "水平翻转", label: "水平" },
  { mode: "垂直翻转", label: "垂直" },
  { mode: "顺时针 90°", label: "↻ 90°" },
  { mode: "自定义角度", label: "自定义" }
] as const;

function getSignedRotation(geometryState: GeometryState) {
  if (geometryState.rotateMode === "顺时针 90°") {
    const angle = Number.parseFloat(geometryState.rotateCustomAngle);
    return Number.isFinite(angle) ? Math.abs(angle) : 90;
  }

  if (geometryState.rotateMode === "逆时针 90°") {
    const angle = Number.parseFloat(geometryState.rotateCustomAngle);
    return Number.isFinite(angle) ? -Math.abs(angle) : -90;
  }

  if (geometryState.rotateMode === "自定义角度") {
    const angle = Number.parseFloat(geometryState.rotateCustomAngle);
    if (!Number.isFinite(angle)) {
      return geometryState.rotateDirection === "ccw" ? -15 : 15;
    }

    return geometryState.rotateDirection === "ccw" ? -Math.abs(angle) : Math.abs(angle);
  }

  return 0;
}

function getPreviewTransform(geometryState: GeometryState) {
  if (geometryState.rotateMode === "none") {
    return "";
  }

  if (geometryState.rotateMode === "水平翻转") {
    return "scaleX(-1)";
  }

  if (geometryState.rotateMode === "垂直翻转") {
    return "scaleY(-1)";
  }

  if (geometryState.rotateMode === "顺时针 90°") {
    return `rotate(${getSignedRotation(geometryState)}deg)`;
  }

  return `rotate(${getSignedRotation(geometryState)}deg)`;
}

function getRotateSummary(geometryState: GeometryState) {
  if (geometryState.rotateMode === "none") {
    return "当前未应用旋转或翻转";
  }

  if (geometryState.rotateMode === "水平翻转") {
    return "左右镜像翻转";
  }

  if (geometryState.rotateMode === "垂直翻转") {
    return "上下镜像翻转";
  }

  if (geometryState.rotateMode === "顺时针 90°") {
    return `顺时针累计旋转 ${Math.abs(getSignedRotation(geometryState)) || 90} 度`;
  }

  if (geometryState.rotateMode === "逆时针 90°") {
    return "逆时针旋转 90 度";
  }

  if (geometryState.rotateMode === "180°") {
    return "整体翻转 180 度";
  }

  const angle = Math.abs(getSignedRotation(geometryState));
  const direction = geometryState.rotateDirection === "ccw" ? "逆时针" : "顺时针";
  return `按 ${direction} ${angle || 15} 度做自定义旋转`;
}

export function VideoRotateEditor({
  geometryState,
  onGeometryStateChange,
  sourcePreviewUrl
}: {
  geometryState: GeometryState;
  onGeometryStateChange: (next: GeometryState) => void;
  sourcePreviewUrl: string | null;
}) {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const handleToggleFlip = (mode: "水平翻转" | "垂直翻转") => {
    if (geometryState.rotateMode === mode) {
      onGeometryStateChange({
        ...geometryState,
        operation: "rotate",
        rotateMode: "none"
      });
      return;
    }

    onGeometryStateChange({
      ...geometryState,
      operation: "rotate",
      rotateMode: mode
    });
  };

  const handleRotateStep = () => {
    const currentQuarterTurns =
      geometryState.rotateMode === "顺时针 90°"
        ? Math.max(1, Math.round(Math.abs(getSignedRotation(geometryState)) / 90))
        : 0;
    const nextQuarterTurns = (currentQuarterTurns + 1) % 4;

    if (nextQuarterTurns === 0) {
      onGeometryStateChange({
        ...geometryState,
        operation: "rotate",
        rotateMode: "none",
        rotateDirection: "cw",
        rotateCustomAngle: "90"
      });
      return;
    }

    onGeometryStateChange({
      ...geometryState,
      operation: "rotate",
      rotateMode: "顺时针 90°",
      rotateDirection: "cw",
      rotateCustomAngle: `${nextQuarterTurns * 90}`
    });
  };

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
    <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-3 text-sm font-medium text-[var(--ink)]">功能类型</legend>
          <div className="grid grid-cols-2 gap-2">
            {ROTATE_OPTIONS.map((option, index) => {
              const signedRotation = getSignedRotation(geometryState);
              const isActive =
                option.mode === "水平翻转"
                  ? geometryState.rotateMode === "水平翻转"
                  : option.mode === "垂直翻转"
                    ? geometryState.rotateMode === "垂直翻转"
                    : option.mode === "顺时针 90°"
                      ? geometryState.rotateMode === "顺时针 90°"
                      : geometryState.rotateMode === "自定义角度";
              const shouldSpanTwoColumns = index === ROTATE_OPTIONS.length - 1;
              return (
                <button
                  key={option.mode}
                  type="button"
                  onClick={() => {
                    if (option.mode === "水平翻转" || option.mode === "垂直翻转") {
                      handleToggleFlip(option.mode);
                      return;
                    }

                    if (option.mode === "顺时针 90°") {
                      handleRotateStep();
                      return;
                    }

                    onGeometryStateChange({
                      ...geometryState,
                      operation: "rotate",
                      rotateMode: geometryState.rotateMode === "自定义角度" ? "none" : "自定义角度",
                      rotateDirection: geometryState.rotateDirection || "cw"
                    });
                  }}
                  className={
                    isActive
                      ? `rounded-[16px] border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-3 text-left text-sm font-medium text-[var(--ink)] ${shouldSpanTwoColumns ? "col-span-2" : ""}`
                      : `rounded-[16px] border border-[var(--line)] bg-white/78 px-3 py-3 text-left text-sm text-[var(--ink)] ${shouldSpanTwoColumns ? "col-span-2" : ""}`
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {geometryState.rotateMode === "自定义角度" ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">自定义角度</span>
            <input
              type="text"
              value={geometryState.rotateCustomAngle}
              onChange={(event) =>
                onGeometryStateChange({
                  ...geometryState,
                  rotateMode: "自定义角度",
                  rotateCustomAngle: event.target.value
                })
              }
              placeholder="例如 15"
              className="text-input"
            />
          </label>
        ) : null}

        {geometryState.rotateMode === "自定义角度" ? (
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">空白区域填充</span>
            <select
              value={geometryState.rotateBackground}
              onChange={(event) => onGeometryStateChange({ ...geometryState, rotateBackground: event.target.value })}
              className="select-input"
            >
              {["black", "white", "transparent", "保持原样"].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="rounded-[18px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3 text-sm leading-7 text-[var(--muted)]">
          当前效果：{getRotateSummary(geometryState)}。右侧用第一帧做即时演示。
        </div>
      </div>

      <div className="rounded-[22px] border border-[var(--line)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--ink)]">旋转演示</p>
        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">右侧直接显示当前功能类型对第一帧的预估效果。</p>

        <div className="mt-4">
          <div
            className="relative mx-auto w-full max-w-[1280px] overflow-hidden rounded-[20px] border border-[var(--line)] bg-white/32"
            style={{ aspectRatio: `${FIXED_CANVAS_WIDTH} / ${FIXED_CANVAS_HEIGHT}` }}
          >
            <div className="absolute inset-0 bg-white/24" />

            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="relative h-full w-full overflow-hidden rounded-[18px] border border-[var(--line)] bg-slate-950 shadow-[0_22px_64px_rgba(15,23,42,0.16)]">
                {sourcePreviewUrl ? (
                  <video
                    ref={previewVideoRef}
                    key={`${sourcePreviewUrl}-${geometryState.rotateMode}-${geometryState.rotateCustomAngle}`}
                    src={sourcePreviewUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="absolute left-1/2 top-1/2 object-contain"
                    style={{
                      width: "100%",
                      height: "100%",
                      transform: `translate(-50%, -50%)${getPreviewTransform(geometryState) ? ` ${getPreviewTransform(geometryState)}` : ""}`,
                      transformOrigin: "center center"
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-white/76">
                    上传视频后，这里会显示第一帧旋转演示。
                  </div>
                )}

                <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/56 px-3 py-1 text-xs font-semibold text-white">
                  {getRotateSummary(geometryState)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
