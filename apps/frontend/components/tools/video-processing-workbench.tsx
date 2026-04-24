"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import {
  formatBitRate,
  formatChannels,
  formatDuration,
  formatFileSize,
  formatFrameRate,
  formatResolution,
  formatSampleRate,
  type VideoMetadata
} from "../../lib/video-metadata";
import { inspectUploadedSession, uploadVideoInChunks } from "../../lib/video-upload-session";

type VideoState = {
  file: File;
  objectUrl: string;
};

type InspectState =
  | { status: "idle" }
  | { status: "uploading"; progress: number }
  | { status: "loading" }
  | { status: "success"; metadata: VideoMetadata }
  | { status: "error"; message: string };

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 border-b border-[var(--line)] py-2 last:border-b-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</span>
      <span className="text-sm leading-6 text-[var(--ink)]">{value}</span>
    </div>
  );
}

export function VideoProcessingWorkbench({
  onMetadataChange,
  onSourceFileChange,
  onSourcePreviewUrlChange,
  onUploadSessionChange
}: {
  onMetadataChange?: (metadata: VideoMetadata | null) => void;
  onSourceFileChange?: (file: File | null) => void;
  onSourcePreviewUrlChange?: (previewUrl: string | null) => void;
  onUploadSessionChange?: (uploadId: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoState, setVideoState] = useState<VideoState | null>(null);
  const [inspectState, setInspectState] = useState<InspectState>({ status: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (videoState) {
        URL.revokeObjectURL(videoState.objectUrl);
      }
    };
  }, [videoState]);

  useEffect(() => {
    onSourcePreviewUrlChange?.(videoState?.objectUrl ?? null);
  }, [onSourcePreviewUrlChange, videoState]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      return;
    }

    if (videoState) {
      URL.revokeObjectURL(videoState.objectUrl);
    }

    const objectUrl = URL.createObjectURL(selectedFile);
    setVideoState({
      file: selectedFile,
      objectUrl
    });
    setCopyState("idle");
    onMetadataChange?.(null);
    onSourceFileChange?.(selectedFile);
    onUploadSessionChange?.(null);

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setInspectState({ status: "uploading", progress: 0 });

    void uploadVideoInChunks(selectedFile, (progress) => {
      if (requestIdRef.current !== requestId) {
        return;
      }

      startTransition(() => {
        setInspectState({ status: "uploading", progress });
      });
    })
      .then(async (uploadId) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        onUploadSessionChange?.(uploadId);
        startTransition(() => {
          setInspectState({ status: "loading" });
        });

        const metadata = await inspectUploadedSession(uploadId);
        if (requestIdRef.current !== requestId) {
          return;
        }

        startTransition(() => {
          setInspectState({ status: "success", metadata });
        });
        onMetadataChange?.(metadata);
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        startTransition(() => {
          setInspectState({
            status: "error",
            message: error instanceof Error ? error.message : "视频信息解析失败。"
          });
        });
        onUploadSessionChange?.(null);
        onMetadataChange?.(null);
      });
  }

  async function handleCopyProbeJson() {
    if (inspectState.status !== "success") {
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(inspectState.metadata.rawProbe, null, 2));
      setCopyState("done");
      window.setTimeout(() => {
        setCopyState("idle");
      }, 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => {
        setCopyState("idle");
      }, 1800);
    }
  }

  return (
    <section className="surface-card mt-8 min-h-[760px] rounded-[32px] px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">视频工作区</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {videoState ? "视频已加载，可以直接在当前页面预览和导出。" : "上传本地视频后即可开始预览。"}
          </p>
        </div>

        <label className="primary-button cursor-pointer px-5 py-3 text-sm">
          <input type="file" accept="video/*" className="sr-only" onChange={handleFileChange} />
          上传视频
        </label>
      </div>

      <div className="mt-6 space-y-6">
        <div className="overflow-hidden rounded-[28px] border border-[var(--line)] bg-slate-950">
          {videoState ? (
            <video
              ref={videoRef}
              key={videoState.objectUrl}
              src={videoState.objectUrl}
              controls
              playsInline
              className="block aspect-video w-full bg-black"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center px-6 text-center text-sm leading-7 text-white/72">
              上传一个视频后，这里会直接显示播放器。你可以使用原生控件进行播放、暂停、拖动进度条、音量调节和全屏预览。
            </div>
          )}
        </div>

        <div className="flex flex-col rounded-[24px] border border-[var(--line)] bg-white/60 px-5 py-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">视频信息</p>
            {inspectState.status === "uploading" ? (
              <span className="data-pill">{`上传中 ${Math.round(inspectState.progress * 100)}%`}</span>
            ) : inspectState.status === "loading" ? (
              <span className="data-pill">解析中</span>
            ) : null}
          </div>

          {videoState ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col">
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3">
                <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--ink)]">{videoState.file.name}</p>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {formatFileSize(videoState.file.size)} · {videoState.file.type || "未知格式"}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      void handleCopyProbeJson();
                    }}
                    disabled={inspectState.status !== "success"}
                    className="ghost-button min-w-[132px] px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {copyState === "done" ? "已复制 JSON" : copyState === "error" ? "复制失败" : "复制探测JSON"}
                  </button>

                  <a
                    href={videoState.objectUrl}
                    download={videoState.file.name}
                    className="primary-button px-4 py-2 text-sm"
                  >
                    导出原视频
                  </a>
                </div>
              </div>

              {inspectState.status === "success" ? (
                <div className="mt-4 min-h-0 flex-1 pr-1">
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-[20px] border border-[var(--line)] bg-white/70 px-4 py-3">
                      <p className="mb-2 text-sm font-semibold text-[var(--ink)]">基础信息</p>
                      <MetadataRow label="容器" value={inspectState.metadata.container.longName ?? inspectState.metadata.container.shortName ?? "未知"} />
                      <MetadataRow label="文件大小" value={formatFileSize(inspectState.metadata.fileSizeBytes)} />
                      <MetadataRow label="总码率" value={formatBitRate(inspectState.metadata.bitRate)} />
                      <MetadataRow label="时长" value={formatDuration(inspectState.metadata.durationSeconds)} />
                      <MetadataRow label="流数量" value={`${inspectState.metadata.streamCount}`} />
                    </div>

                    <div className="rounded-[20px] border border-[var(--line)] bg-white/70 px-4 py-3">
                      <p className="mb-2 text-sm font-semibold text-[var(--ink)]">音频流</p>
                      <MetadataRow
                        label="音频编码"
                        value={inspectState.metadata.audio?.codecLongName ?? inspectState.metadata.audio?.codec ?? "未知"}
                      />
                      <MetadataRow
                        label="采样率"
                        value={formatSampleRate(inspectState.metadata.audio?.sampleRate ?? null)}
                      />
                      <MetadataRow
                        label="声道"
                        value={formatChannels(
                          inspectState.metadata.audio?.channels ?? null,
                          inspectState.metadata.audio?.channelLayout ?? null
                        )}
                      />
                      <MetadataRow label="音频码率" value={formatBitRate(inspectState.metadata.audio?.bitRate ?? null)} />
                    </div>

                    <div className="rounded-[20px] border border-[var(--line)] bg-white/70 px-4 py-3 lg:col-span-2">
                      <p className="mb-2 text-sm font-semibold text-[var(--ink)]">视频流</p>
                      <div className="grid gap-0 lg:grid-cols-2 lg:gap-x-5">
                        <div>
                          <MetadataRow
                            label="视频编码"
                            value={inspectState.metadata.video?.codecLongName ?? inspectState.metadata.video?.codec ?? "未知"}
                          />
                          <MetadataRow
                            label="分辨率"
                            value={formatResolution(
                              inspectState.metadata.video?.resolution.width ?? null,
                              inspectState.metadata.video?.resolution.height ?? null
                            )}
                          />
                          <MetadataRow label="平均帧率" value={formatFrameRate(inspectState.metadata.video?.frameRate ?? null)} />
                          <MetadataRow
                            label="名义帧率"
                            value={formatFrameRate(inspectState.metadata.video?.nominalFrameRate ?? null)}
                          />
                          <MetadataRow label="像素格式" value={inspectState.metadata.video?.pixelFormat ?? "未知"} />
                          <MetadataRow label="显示比例" value={inspectState.metadata.video?.aspectRatio ?? "未知"} />
                          <MetadataRow label="采样比例" value={inspectState.metadata.video?.sampleAspectRatio ?? "未知"} />
                        </div>
                        <div>
                          <MetadataRow label="扫描方式" value={inspectState.metadata.video?.fieldOrder ?? "未知"} />
                          <MetadataRow label="色彩范围" value={inspectState.metadata.video?.colorRange ?? "未知"} />
                          <MetadataRow label="色彩空间" value={inspectState.metadata.video?.colorSpace ?? "未知"} />
                          <MetadataRow label="传输特性" value={inspectState.metadata.video?.colorTransfer ?? "未知"} />
                          <MetadataRow label="色度原色" value={inspectState.metadata.video?.colorPrimaries ?? "未知"} />
                          <MetadataRow label="原始位深" value={inspectState.metadata.video?.rawBitDepth ?? "未知"} />
                          <MetadataRow label="视频码率" value={formatBitRate(inspectState.metadata.video?.bitRate ?? null)} />
                          <MetadataRow label="帧数量" value={`${inspectState.metadata.video?.frameCount ?? "未知"}`} />
                        </div>
                      </div>
                    </div>
                  </div>

                </div>
              ) : inspectState.status === "uploading" ? (
                <div className="mt-4 flex min-h-[220px] flex-1 items-center justify-center rounded-[20px] border border-dashed border-[var(--line)] bg-white/50 px-5 text-center">
                  <p className="text-sm leading-7 text-[var(--muted)]">
                    {`正在分块上传视频，当前进度 ${Math.round(inspectState.progress * 100)}%。上传完成后会自动读取视频信息。`}
                  </p>
                </div>
              ) : inspectState.status === "loading" ? (
                <div className="mt-4 flex min-h-[220px] flex-1 items-center justify-center rounded-[20px] border border-dashed border-[var(--line)] bg-white/50 px-5 text-center">
                  <p className="text-sm leading-7 text-[var(--muted)]">正在读取视频信息，包括容器、编码、帧率、色彩和音频流。</p>
                </div>
              ) : inspectState.status === "error" ? (
                <div className="mt-4 flex min-h-[220px] flex-1 items-center rounded-[20px] border border-[var(--line)] bg-[var(--danger-soft)] px-5">
                  <p className="text-sm leading-7 text-[var(--ink)]">{inspectState.message}</p>
                </div>
              ) : (
                <div className="mt-4 flex min-h-[220px] flex-1 items-center rounded-[20px] border border-dashed border-[var(--line)] bg-white/50 px-5">
                  <p className="text-sm leading-7 text-[var(--muted)]">上传视频后，这里会显示完整的视频与音频流属性。</p>
                </div>
              )}

            </div>
          ) : (
            <div className="mt-4 flex min-h-[220px] flex-1 items-center">
              <p className="text-sm leading-7 text-[var(--muted)]">当前还没有选择视频文件。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
