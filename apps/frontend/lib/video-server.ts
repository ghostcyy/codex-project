import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ProbePayload, ProbeStream, VideoMetadata } from "./video-metadata";

type FileInfo = {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
};

export type VideoOutputManifest = {
  id: string;
  fileName: string;
  absolutePath: string;
  mimeType: string;
  createdAt: string;
};

function parseNumber(value: string | number | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRational(value: string | undefined) {
  if (!value || value === "0/0") {
    return null;
  }

  const parts = value.split("/");
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function pickStream(streams: ProbeStream[] | undefined, codecType: string) {
  return streams?.find((stream) => stream.codec_type === codecType) ?? null;
}

function getBinaryOverride(name: string) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getProjectRoot() {
  const currentWorkingDirectory = /* turbopackIgnore: true */ process.cwd();
  const candidateRoots = [
    currentWorkingDirectory,
    path.resolve(currentWorkingDirectory, ".."),
    path.resolve(currentWorkingDirectory, "..", "..")
  ];

  return (
    candidateRoots.find((candidate) => {
      return existsSync(path.join(candidate, "apps", "frontend")) && existsSync(path.join(candidate, "package.json"));
    }) ?? currentWorkingDirectory
  );
}

export function getRuntimeDirectory() {
  const runtimeDirectory = path.join(getProjectRoot(), ".local-runtime");
  mkdirSync(runtimeDirectory, { recursive: true });
  return runtimeDirectory;
}

export function getVideoOutputDirectory() {
  const outputDirectory = path.join(getRuntimeDirectory(), "video-outputs");
  mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

export function getManifestPath(id: string) {
  return path.join(getVideoOutputDirectory(), `${id}.json`);
}

export function readManifest(id: string) {
  const manifestPath = getManifestPath(id);
  if (!existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(readFileSync(manifestPath, "utf-8")) as VideoOutputManifest;
}

export function getPythonBinaryPath() {
  const override = getBinaryOverride("PYTHON_BIN");
  if (override) {
    return override;
  }

  const runtimeDirectory = getRuntimeDirectory();
  if (process.platform === "win32") {
    const windowsVenv = path.join(runtimeDirectory, "video-tools-venv", "Scripts", "python.exe");
    return existsSync(windowsVenv) ? windowsVenv : "python";
  }

  const posixVenv = path.join(runtimeDirectory, "video-tools-venv", "bin", "python");
  return existsSync(posixVenv) ? posixVenv : "python3";
}

export function getFfmpegBinaryPath() {
  const override = getBinaryOverride("FFMPEG_BIN");
  if (override) {
    return override;
  }

  const bundledBinary = path.join(getProjectRoot(), "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (existsSync(bundledBinary)) {
    return bundledBinary;
  }

  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function getFfprobeBinaryPath() {
  const override = getBinaryOverride("FFPROBE_BIN");
  if (override) {
    return override;
  }

  const bundledBinary = path.join(
    getProjectRoot(),
    "node_modules",
    "ffprobe-static",
    "bin",
    process.platform,
    process.arch,
    process.platform === "win32" ? "ffprobe.exe" : "ffprobe"
  );
  if (existsSync(bundledBinary)) {
    return bundledBinary;
  }

  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

export async function runFfprobe(filePath: string) {
  return new Promise<ProbePayload>((resolve, reject) => {
    execFile(
      getFfprobeBinaryPath(),
      ["-v", "error", "-show_streams", "-show_format", "-print_format", "json", filePath],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout) as ProbePayload);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

export function buildMetadata(payload: ProbePayload, fileInfo: FileInfo): VideoMetadata {
  const format = payload.format;
  const videoStream = pickStream(payload.streams, "video");
  const audioStream = pickStream(payload.streams, "audio");

  return {
    fileName: fileInfo.fileName,
    mimeType: fileInfo.mimeType,
    fileSizeBytes: fileInfo.fileSizeBytes,
    streamCount: format?.nb_streams ?? payload.streams?.length ?? 0,
    container: {
      shortName: format?.format_name ?? null,
      longName: format?.format_long_name ?? null
    },
    durationSeconds: parseNumber(format?.duration),
    bitRate: parseNumber(format?.bit_rate),
    startTimeSeconds: parseNumber(format?.start_time),
    video: videoStream
      ? {
          codec: videoStream.codec_name ?? null,
          codecLongName: videoStream.codec_long_name ?? null,
          profile: videoStream.profile ?? null,
          resolution: {
            width: videoStream.width ?? null,
            height: videoStream.height ?? null,
            codedWidth: videoStream.coded_width ?? null,
            codedHeight: videoStream.coded_height ?? null
          },
          frameRate: parseRational(videoStream.avg_frame_rate),
          nominalFrameRate: parseRational(videoStream.r_frame_rate),
          pixelFormat: videoStream.pix_fmt ?? null,
          fieldOrder: videoStream.field_order ?? null,
          aspectRatio: videoStream.display_aspect_ratio ?? null,
          sampleAspectRatio: videoStream.sample_aspect_ratio ?? null,
          colorRange: videoStream.color_range ?? null,
          colorSpace: videoStream.color_space ?? null,
          colorTransfer: videoStream.color_transfer ?? null,
          colorPrimaries: videoStream.color_primaries ?? null,
          rawBitDepth: videoStream.bits_per_raw_sample ?? null,
          bitRate: parseNumber(videoStream.bit_rate),
          frameCount: parseNumber(videoStream.nb_frames),
          level: videoStream.level ?? null
        }
      : null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? null,
          codecLongName: audioStream.codec_long_name ?? null,
          sampleRate: parseNumber(audioStream.sample_rate),
          channels: audioStream.channels ?? null,
          channelLayout: audioStream.channel_layout ?? null,
          bitRate: parseNumber(audioStream.bit_rate)
        }
      : null,
    rawProbe: payload
  };
}

export function statFileInfo(filePath: string, fileName: string, mimeType: string) {
  const stats = statSync(filePath);
  return {
    fileName,
    mimeType,
    fileSizeBytes: stats.size
  };
}
