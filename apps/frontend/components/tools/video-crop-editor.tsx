"use client";

import { useEffect, useRef, useState } from "react";
import type { GeometryState } from "../../lib/video-geometry";
import type { VideoMetadata } from "../../lib/video-metadata";

type DragHandle = "move" | "nw" | "ne" | "sw" | "se";

type DragState = {
  handle: DragHandle;
  startPointerX: number;
  startPointerY: number;
  startRect: CropRect;
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MediaFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MIN_DISPLAY_RECT = 24;
const FIXED_CANVAS_WIDTH = 1280;
const FIXED_CANVAS_HEIGHT = 720;

function parseNumber(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeEven(value: number, minimum = 2) {
  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded - 1;
  return Math.max(minimum, even);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeCropRect(geometryState: GeometryState, sourceWidth: number, sourceHeight: number): CropRect {
  const width = clamp(makeEven(parseNumber(geometryState.cropWidth, Math.min(sourceWidth, 640))), 2, sourceWidth);
  const height = clamp(makeEven(parseNumber(geometryState.cropHeight, Math.min(sourceHeight, 360))), 2, sourceHeight);
  const x = clamp(makeEven(parseNumber(geometryState.cropX, 0), 0), 0, Math.max(sourceWidth - width, 0));
  const y = clamp(makeEven(parseNumber(geometryState.cropY, 0), 0), 0, Math.max(sourceHeight - height, 0));

  return {
    x,
    y,
    width,
    height
  };
}

function getMediaFrame(boardWidth: number, boardHeight: number, sourceWidth: number, sourceHeight: number): MediaFrame {
  if (boardWidth <= 0 || boardHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.min(boardWidth / sourceWidth, boardHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (boardWidth - width) / 2,
    y: (boardHeight - height) / 2,
    width,
    height
  };
}

function toDisplayRect(rect: CropRect, mediaFrame: MediaFrame, sourceWidth: number, sourceHeight: number) {
  return {
    x: mediaFrame.x + (rect.x / sourceWidth) * mediaFrame.width,
    y: mediaFrame.y + (rect.y / sourceHeight) * mediaFrame.height,
    width: (rect.width / sourceWidth) * mediaFrame.width,
    height: (rect.height / sourceHeight) * mediaFrame.height
  };
}

function toSourceRect(displayRect: CropRect, mediaFrame: MediaFrame, sourceWidth: number, sourceHeight: number): CropRect {
  const width = clamp(makeEven((displayRect.width / mediaFrame.width) * sourceWidth), 2, sourceWidth);
  const height = clamp(makeEven((displayRect.height / mediaFrame.height) * sourceHeight), 2, sourceHeight);
  const x = clamp(makeEven(((displayRect.x - mediaFrame.x) / mediaFrame.width) * sourceWidth, 0), 0, Math.max(sourceWidth - width, 0));
  const y = clamp(makeEven(((displayRect.y - mediaFrame.y) / mediaFrame.height) * sourceHeight, 0), 0, Math.max(sourceHeight - height, 0));

  return {
    x,
    y,
    width,
    height
  };
}

export function VideoCropEditor({
  sourceFile,
  sourcePreviewUrl,
  videoMetadata,
  geometryState,
  onGeometryStateChange
}: {
  sourceFile: File | null;
  sourcePreviewUrl: string | null;
  videoMetadata: VideoMetadata | null;
  geometryState: GeometryState;
  onGeometryStateChange: (next: GeometryState) => void;
}) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const backgroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  const [dragState, setDragState] = useState<DragState | null>(null);

  const sourceWidth = videoMetadata?.video?.resolution.width ?? 0;
  const sourceHeight = videoMetadata?.video?.resolution.height ?? 0;
  const cropRect = sourceWidth > 0 && sourceHeight > 0 ? normalizeCropRect(geometryState, sourceWidth, sourceHeight) : null;
  const logicalMediaFrame = getMediaFrame(FIXED_CANVAS_WIDTH, FIXED_CANVAS_HEIGHT, sourceWidth, sourceHeight);
  const mediaFrame = getMediaFrame(boardSize.width, boardSize.height, sourceWidth, sourceHeight);
  const logicalDisplayRect =
    cropRect && logicalMediaFrame.width > 0 && logicalMediaFrame.height > 0
      ? toDisplayRect(cropRect, logicalMediaFrame, sourceWidth, sourceHeight)
      : null;
  const displayRect =
    cropRect && mediaFrame.width > 0 && mediaFrame.height > 0
      ? toDisplayRect(cropRect, mediaFrame, sourceWidth, sourceHeight)
      : null;

  useEffect(() => {
    if (!boardRef.current) {
      return undefined;
    }

    const element = boardRef.current;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setBoardSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const videoElement = backgroundVideoRef.current;
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

  useEffect(() => {
    if (!dragState || !displayRect || mediaFrame.width <= 0 || mediaFrame.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaX = event.clientX - dragState.startPointerX;
      const deltaY = event.clientY - dragState.startPointerY;

      let nextRect = {
        ...dragState.startRect
      };

      if (dragState.handle === "move") {
        nextRect.x = clamp(
          dragState.startRect.x + deltaX,
          mediaFrame.x,
          Math.max(mediaFrame.x + mediaFrame.width - dragState.startRect.width, mediaFrame.x)
        );
        nextRect.y = clamp(
          dragState.startRect.y + deltaY,
          mediaFrame.y,
          Math.max(mediaFrame.y + mediaFrame.height - dragState.startRect.height, mediaFrame.y)
        );
      }

      if (dragState.handle === "nw") {
        const right = dragState.startRect.x + dragState.startRect.width;
        const bottom = dragState.startRect.y + dragState.startRect.height;
        nextRect.x = clamp(dragState.startRect.x + deltaX, mediaFrame.x, right - MIN_DISPLAY_RECT);
        nextRect.y = clamp(dragState.startRect.y + deltaY, mediaFrame.y, bottom - MIN_DISPLAY_RECT);
        nextRect.width = right - nextRect.x;
        nextRect.height = bottom - nextRect.y;
      }

      if (dragState.handle === "ne") {
        const bottom = dragState.startRect.y + dragState.startRect.height;
        const nextRight = clamp(
          dragState.startRect.x + dragState.startRect.width + deltaX,
          dragState.startRect.x + MIN_DISPLAY_RECT,
          mediaFrame.x + mediaFrame.width
        );
        nextRect.y = clamp(dragState.startRect.y + deltaY, mediaFrame.y, bottom - MIN_DISPLAY_RECT);
        nextRect.width = nextRight - dragState.startRect.x;
        nextRect.height = bottom - nextRect.y;
      }

      if (dragState.handle === "sw") {
        const right = dragState.startRect.x + dragState.startRect.width;
        const nextBottom = clamp(
          dragState.startRect.y + dragState.startRect.height + deltaY,
          dragState.startRect.y + MIN_DISPLAY_RECT,
          mediaFrame.y + mediaFrame.height
        );
        nextRect.x = clamp(dragState.startRect.x + deltaX, mediaFrame.x, right - MIN_DISPLAY_RECT);
        nextRect.width = right - nextRect.x;
        nextRect.height = nextBottom - dragState.startRect.y;
      }

      if (dragState.handle === "se") {
        const nextRight = clamp(
          dragState.startRect.x + dragState.startRect.width + deltaX,
          dragState.startRect.x + MIN_DISPLAY_RECT,
          mediaFrame.x + mediaFrame.width
        );
        const nextBottom = clamp(
          dragState.startRect.y + dragState.startRect.height + deltaY,
          dragState.startRect.y + MIN_DISPLAY_RECT,
          mediaFrame.y + mediaFrame.height
        );
        nextRect.width = nextRight - dragState.startRect.x;
        nextRect.height = nextBottom - dragState.startRect.y;
      }

      const nextSourceRect = toSourceRect(nextRect, mediaFrame, sourceWidth, sourceHeight);
      onGeometryStateChange({
        ...geometryState,
        cropX: `${nextSourceRect.x}`,
        cropY: `${nextSourceRect.y}`,
        cropWidth: `${nextSourceRect.width}`,
        cropHeight: `${nextSourceRect.height}`
      });
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [displayRect, dragState, geometryState, mediaFrame, onGeometryStateChange, sourceHeight, sourceWidth]);

  const canRenderBoard = Boolean(sourceFile && sourcePreviewUrl && sourceWidth > 0 && sourceHeight > 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[248px_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">起点 X</span>
            <input
              type="text"
              value={geometryState.cropX}
              onChange={(event) => onGeometryStateChange({ ...geometryState, cropX: event.target.value })}
              placeholder="例如 160"
              className="text-input"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">起点 Y</span>
            <input
              type="text"
              value={geometryState.cropY}
              onChange={(event) => onGeometryStateChange({ ...geometryState, cropY: event.target.value })}
              placeholder="例如 90"
              className="text-input"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">裁剪宽度</span>
            <input
              type="text"
              value={geometryState.cropWidth}
              onChange={(event) => onGeometryStateChange({ ...geometryState, cropWidth: event.target.value })}
              placeholder="例如 960"
              className="text-input"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink)]">裁剪高度</span>
            <input
              type="text"
              value={geometryState.cropHeight}
              onChange={(event) => onGeometryStateChange({ ...geometryState, cropHeight: event.target.value })}
              placeholder="例如 540"
              className="text-input"
            />
          </label>
        </div>

        <div className="rounded-[18px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3 text-sm leading-7 text-[var(--muted)]">
          在右侧封面图上拖动矩形框即可调整裁剪区域。拖动四个角可以缩放选区，四个参数会实时同步。
        </div>
      </div>

      <div className="rounded-[22px] border border-[var(--line)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--ink)]">可视化裁剪画板</p>
        <p className="mt-2 text-sm leading-7 text-[var(--muted)]">
          以视频封面图作为基底，矩形框位置就是最终裁剪区域。选区不会超出画面范围。
        </p>

        <div className="mt-4">
          {canRenderBoard ? (
            <div
              ref={boardRef}
              className="relative mx-auto w-full max-w-[1280px] overflow-hidden rounded-[20px] border border-[var(--line)] bg-slate-950"
              style={{ aspectRatio: `${FIXED_CANVAS_WIDTH} / ${FIXED_CANVAS_HEIGHT}` }}
            >
              <video
                ref={backgroundVideoRef}
                key={sourcePreviewUrl}
                src={sourcePreviewUrl ?? undefined}
                muted
                playsInline
                preload="metadata"
                className="absolute inset-0 h-full w-full object-contain"
              />
              <div className="absolute inset-0 bg-black/15" />

              {logicalDisplayRect ? (
                <div
                  role="presentation"
                  onPointerDown={(event) => {
                    if (!displayRect) {
                      return;
                    }

                    event.preventDefault();
                    setDragState({
                      handle: "move",
                      startPointerX: event.clientX,
                      startPointerY: event.clientY,
                      startRect: displayRect
                    });
                  }}
                  className="absolute z-10 cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(15,23,42,0.42)]"
                  style={{
                    left: `${(logicalDisplayRect.x / FIXED_CANVAS_WIDTH) * 100}%`,
                    top: `${(logicalDisplayRect.y / FIXED_CANVAS_HEIGHT) * 100}%`,
                    width: `${(logicalDisplayRect.width / FIXED_CANVAS_WIDTH) * 100}%`,
                    height: `${(logicalDisplayRect.height / FIXED_CANVAS_HEIGHT) * 100}%`
                  }}
                >
                  <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[11px] font-semibold text-white">
                    {geometryState.cropWidth} × {geometryState.cropHeight}
                  </div>

                  {([
                    { key: "nw", className: "-left-2.5 -top-2.5 cursor-nwse-resize" },
                    { key: "ne", className: "-right-2.5 -top-2.5 cursor-nesw-resize" },
                    { key: "sw", className: "-bottom-2.5 -left-2.5 cursor-nesw-resize" },
                    { key: "se", className: "-bottom-2.5 -right-2.5 cursor-nwse-resize" }
                  ] as const).map((handle) => (
                    <button
                      key={handle.key}
                      type="button"
                      aria-label={`调整${handle.key}裁剪角`}
                      onPointerDown={(event) => {
                        if (!displayRect) {
                          return;
                        }

                        event.preventDefault();
                        event.stopPropagation();
                        setDragState({
                          handle: handle.key,
                          startPointerX: event.clientX,
                          startPointerY: event.clientY,
                          startRect: displayRect
                        });
                      }}
                      className={`absolute h-5 w-5 rounded-full border-2 border-slate-950 bg-white ${handle.className}`}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-[280px] items-center justify-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--accent-softer)] px-5 text-center text-sm leading-7 text-[var(--muted)]">
              {sourceFile
                ? "正在定位视频第一帧并加载裁剪画板。"
                : "先上传视频后，这里才会显示可视化裁剪画板。"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
