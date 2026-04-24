"use client";

import { useState } from "react";
import { normalizeClientVideoAssetUrl } from "../../lib/client-video-api";
import { DEFAULT_GEOMETRY_STATE, type GeometryState } from "../../lib/video-geometry";
import { type VideoMetadata } from "../../lib/video-metadata";
import { DEFAULT_TRANSCODE_OPTIONS, type TranscodeOptions, type TranscodeResult } from "../../lib/video-transcode";
import { transcodeUploadedSession } from "../../lib/video-upload-session";
import { VideoModuleSelector } from "./video-module-selector";
import { VideoProcessingWorkbench } from "./video-processing-workbench";

type ImplementedModuleId = "transcode" | "geometry";

export function VideoProcessingStudio() {
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [uploadSessionId, setUploadSessionId] = useState<string | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [videoMetadata, setVideoMetadata] = useState<VideoMetadata | null>(null);
  const [transcodeOptions, setTranscodeOptions] = useState<TranscodeOptions>(DEFAULT_TRANSCODE_OPTIONS);
  const [geometryState, setGeometryState] = useState<GeometryState>(DEFAULT_GEOMETRY_STATE);
  const [activeModuleId, setActiveModuleId] = useState("transcode");
  const [executionMode, setExecutionMode] = useState<ImplementedModuleId>("transcode");
  const [result, setResult] = useState<TranscodeResult | null>(null);
  const [resultMetadata, setResultMetadata] = useState<VideoMetadata | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function handleModuleChange(nextModuleId: string) {
    setActiveModuleId(nextModuleId);
    if (nextModuleId === "transcode" || nextModuleId === "geometry") {
      setExecutionMode(nextModuleId);
    }
  }

  async function handleStartTranscode() {
    if (!sourceFile || !uploadSessionId || isProcessing) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);
    setResult(null);
    setResultMetadata(null);

    const effectiveTranscodeOptions =
      executionMode === "transcode" ? transcodeOptions : DEFAULT_TRANSCODE_OPTIONS;
    const effectiveGeometryState =
      executionMode === "geometry" ? geometryState : DEFAULT_GEOMETRY_STATE;

    const payload = await transcodeUploadedSession(uploadSessionId, {
      outputContainer: effectiveTranscodeOptions.outputContainer,
      videoCodec: effectiveTranscodeOptions.videoCodec,
      audioCodecStrategy: effectiveTranscodeOptions.audioCodecStrategy,
      packagingMode: effectiveTranscodeOptions.packagingMode,
      geometryConfig: JSON.stringify(effectiveGeometryState)
    }).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : "转码失败。");
      setIsProcessing(false);
      return null;
    });

    if (!payload?.result) {
      return;
    }

    setResult({
      ...payload.result,
      outputUrl: normalizeClientVideoAssetUrl(payload.result.outputUrl),
      downloadUrl: normalizeClientVideoAssetUrl(payload.result.downloadUrl)
    });
    setResultMetadata(payload.metadata ?? null);
    setIsProcessing(false);
  }

  return (
    <>
      <VideoProcessingWorkbench
        onMetadataChange={(metadata) => {
          setVideoMetadata(metadata);
        }}
        onUploadSessionChange={setUploadSessionId}
        onSourcePreviewUrlChange={setSourcePreviewUrl}
        onSourceFileChange={(file) => {
          setSourceFile(file);
          setUploadSessionId(null);
          setResult(null);
          setResultMetadata(null);
          setErrorMessage(null);
        }}
      />

      <VideoModuleSelector
        activeModuleId={activeModuleId}
        executionMode={executionMode}
        onActiveModuleChange={handleModuleChange}
        sourceFile={sourceFile}
        sourcePreviewUrl={sourcePreviewUrl}
        videoMetadata={videoMetadata}
        options={transcodeOptions}
        onOptionsChange={setTranscodeOptions}
        geometryState={geometryState}
        onGeometryStateChange={setGeometryState}
      />

      <section className="surface-card mt-8 min-h-[760px] rounded-[32px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">视频处理区</p>
            <h2 className="mt-4 text-2xl font-semibold text-[var(--ink)]">视频处理区</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--muted)]">
              点击“开始转码”后，只会执行当前激活的功能模式。
              {executionMode === "transcode"
                ? " 当前为“转码与封装”模式，画面几何处理参数不会生效。"
                : " 当前为“画面几何处理”模式，转码与封装参数不会生效。"}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                void handleStartTranscode();
              }}
              disabled={!sourceFile || !uploadSessionId || isProcessing}
              className="primary-button px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isProcessing ? "转码中..." : "开始转码"}
            </button>

            <a
              href={result?.downloadUrl ?? "#"}
              aria-disabled={!result}
              className="ghost-button px-5 py-3 text-sm aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              视频导出
            </a>
          </div>
        </div>

        {errorMessage ? (
          <div className="mt-6 rounded-[22px] border border-[var(--line)] bg-[var(--danger-soft)] px-5 py-4 text-sm leading-7 text-[var(--ink)]">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-6 overflow-hidden rounded-[28px] border border-[var(--line)] bg-slate-950">
          {result ? (
            <video key={result.outputUrl} src={result.outputUrl} controls playsInline className="block aspect-video w-full bg-black" />
          ) : (
            <div className="flex aspect-video items-center justify-center px-6 text-center text-sm leading-7 text-white/72">
              {isProcessing
                ? "正在执行转码，完成后这里会加载处理后视频。"
                : "处理后视频会显示在这里，容器尺寸与上方视频工作区保持一致。"}
            </div>
          )}
        </div>

        {resultMetadata ? (
          <div className="mt-6 rounded-[24px] border border-[var(--line)] bg-white/65 px-5 py-5">
            <p className="text-sm font-semibold text-[var(--ink)]">处理结果概况</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-[18px] border border-[var(--line)] bg-white/78 px-4 py-3 text-sm text-[var(--muted)]">
                输出文件：{result?.fileName ?? "未知"}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-white/78 px-4 py-3 text-sm text-[var(--muted)]">
                输出容器：{resultMetadata.container.longName ?? resultMetadata.container.shortName ?? "未知"}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-white/78 px-4 py-3 text-sm text-[var(--muted)]">
                视频编码：{resultMetadata.video?.codecLongName ?? resultMetadata.video?.codec ?? "未知"}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-white/78 px-4 py-3 text-sm text-[var(--muted)]">
                音频编码：{resultMetadata.audio?.codecLongName ?? resultMetadata.audio?.codec ?? "未知"}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
