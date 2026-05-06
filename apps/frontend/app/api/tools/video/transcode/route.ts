import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  buildMetadata,
  getFfmpegBinaryPath,
  getFfprobeBinaryPath,
  getManifestPath,
  getProjectRoot,
  getPythonBinaryPath,
  getVideoOutputDirectory,
  runFfprobe,
  statFileInfo,
  type VideoOutputManifest
} from "../../../../../lib/video-server";
import { DEFAULT_GEOMETRY_STATE, type GeometryState } from "../../../../../lib/video-geometry";
import { getCurrentUser } from "../../../../../lib/server-auth";
import type { OutputContainer } from "../../../../../lib/video-transcode";

export const runtime = "nodejs";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm"
};

const EXTENSIONS: Record<OutputContainer, string> = {
  MP4: ".mp4",
  MOV: ".mov",
  MKV: ".mkv",
  WebM: ".webm"
};

function sanitizeFileName(value: string) {
  return value.replace(/[^\w.-]+/g, "_");
}

function normalizeAudioCodecStrategy(value: string) {
  if (value === "copy" || value === "AAC" || value === "Opus" || value === "mute") {
    return value;
  }

  if (value === "静音导出") {
    return "mute";
  }

  return "copy";
}

function normalizePackagingMode(value: string) {
  if (value === "faststart") {
    return "faststart";
  }

  return "standard";
}

function normalizeGeometryConfig(geometryConfig: GeometryState): GeometryState {
  const padCanvasMap: Record<string, string> = {
    "1280×720": "1280x720",
    "1920×1080": "1920x1080",
    "1080×1920": "1080x1920",
    "自定义画布": "custom"
  };

  const scalePresetMap: Record<string, string> = {
    "按宽度等比缩放": "fit_width",
    "按高度等比缩放": "fit_height",
    "固定宽高输出": "fixed",
    "自定义尺寸": "custom"
  };

  const scaleFitModeMap: Record<string, string> = {
    "保持宽高比": "keep_aspect",
    "强制拉伸": "stretch",
    "按宽适配": "fit_width",
    "按高适配": "fit_height"
  };

  const padAlignMap: Record<string, string> = {
    "居中": "center",
    "顶部居中": "top",
    "底部居中": "bottom",
    "左侧居中": "left",
    "右侧居中": "right"
  };

  const rotateModeMap: Record<string, string> = {
    "水平翻转": "hflip",
    "垂直翻转": "vflip",
    "顺时针 90°": "cw_90",
    "逆时针 90°": "ccw_90",
    "180°": "flip_180",
    "自定义角度": "custom"
  };

  const rotateBackgroundMap: Record<string, string> = {
    black: "black",
    white: "white",
    transparent: "transparent",
    "保持原样": "keep"
  };

  return {
    ...geometryConfig,
    scalePreset: scalePresetMap[geometryConfig.scalePreset] ?? geometryConfig.scalePreset,
    scaleFitMode: scaleFitModeMap[geometryConfig.scaleFitMode] ?? geometryConfig.scaleFitMode,
    padCanvas: padCanvasMap[geometryConfig.padCanvas] ?? geometryConfig.padCanvas,
    padAlign: padAlignMap[geometryConfig.padAlign] ?? geometryConfig.padAlign,
    rotateMode: rotateModeMap[geometryConfig.rotateMode] ?? geometryConfig.rotateMode,
    rotateBackground: rotateBackgroundMap[geometryConfig.rotateBackground] ?? geometryConfig.rotateBackground
  };
}

function parseGeometryConfig(value: FormDataEntryValue | null): GeometryState {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_GEOMETRY_STATE;
  }

  try {
    const parsed = JSON.parse(value) as Partial<GeometryState>;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_GEOMETRY_STATE;
    }

    return {
      ...DEFAULT_GEOMETRY_STATE,
      ...parsed
    };
  } catch {
    return DEFAULT_GEOMETRY_STATE;
  }
}

function runPythonTranscode(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      getPythonBinaryPath(),
      args,
      {
        windowsHide: true,
        cwd: getProjectRoot(),
        maxBuffer: 8 * 1024 * 1024
      },
      (error: ExecFileException | null, _stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        resolve();
      }
    );
  });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  const uploadedFile = formData?.get("file");
  const outputContainer = (formData?.get("outputContainer") as OutputContainer | null) ?? "MP4";
  const videoCodec = (formData?.get("videoCodec") as string | null) ?? "libx264";
  const audioCodecStrategy = normalizeAudioCodecStrategy((formData?.get("audioCodecStrategy") as string | null) ?? "AAC");
  const packagingMode = normalizePackagingMode((formData?.get("packagingMode") as string | null) ?? "standard");
  const geometryConfig = normalizeGeometryConfig(parseGeometryConfig(formData?.get("geometryConfig") ?? null));

  if (!(uploadedFile instanceof File)) {
    return NextResponse.json({ message: "未收到待转码的视频文件。" }, { status: 400 });
  }

  const tempDirectory = await fs.mkdtemp(path.join(tmpdir(), "codex-transcode-"));
  const sourceName = sanitizeFileName(uploadedFile.name);
  const tempInputPath = path.join(tempDirectory, `${randomUUID()}-${sourceName}`);

  const outputId = randomUUID();
  const outputExtension = EXTENSIONS[outputContainer] ?? ".mp4";
  const outputFileName = `${path.parse(sourceName).name || "transcoded-video"}-transcoded${outputExtension}`;
  const outputAbsolutePath = path.join(getVideoOutputDirectory(), `${outputId}${outputExtension}`);

  try {
    await fs.writeFile(tempInputPath, Buffer.from(await uploadedFile.arrayBuffer()));

    const scriptPath = path.join(getProjectRoot(), "scripts", "transcode_video.py");
    await runPythonTranscode([
      scriptPath,
      "--input",
      tempInputPath,
      "--output",
      outputAbsolutePath,
      "--ffmpeg-bin",
      getFfmpegBinaryPath(),
      "--ffprobe-bin",
      getFfprobeBinaryPath(),
      "--output-container",
      outputContainer,
      "--video-codec",
      videoCodec,
      "--audio-codec-strategy",
      audioCodecStrategy,
      "--packaging-mode",
      packagingMode,
      "--geometry-config",
      JSON.stringify(geometryConfig)
    ]);

    const probePayload = await runFfprobe(outputAbsolutePath);
    const metadata = buildMetadata(
      probePayload,
      statFileInfo(outputAbsolutePath, outputFileName, MIME_TYPES[outputExtension] ?? "application/octet-stream")
    );

    const manifest: VideoOutputManifest = {
      id: outputId,
      fileName: outputFileName,
      absolutePath: outputAbsolutePath,
      mimeType: MIME_TYPES[outputExtension] ?? "application/octet-stream",
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(getManifestPath(outputId), JSON.stringify(manifest, null, 2), "utf-8");

    return NextResponse.json({
      result: {
        id: outputId,
        fileName: outputFileName,
        outputUrl: `/api/tools/video/output/${outputId}`,
        downloadUrl: `/api/tools/video/output/${outputId}?download=1`
      },
      metadata
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频转码失败。";
    return NextResponse.json({ message }, { status: 500 });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
