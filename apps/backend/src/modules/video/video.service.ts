import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, PayloadTooLargeException } from "@nestjs/common";
import type {
  ProbePayload,
  ProbeStream,
  UploadedVideoFile,
  VideoMetadata,
  VideoOutputManifest,
  VideoUploadSessionManifest,
  VideoUploadSessionRequest,
  VideoTranscodeRequest
} from "./video.types";
import { formatBytes, getMaxVideoUploadBytes } from "./video.config";

type FileInfo = {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
};

type GeometryState = Record<string, unknown>;
const DEFAULT_UPLOAD_CHUNK_SIZE_BYTES = 256 * 1024;
const DEFAULT_UPLOAD_RETENTION_HOURS = 24;
const DEFAULT_OUTPUT_RETENTION_HOURS = 24 * 7;
const DEFAULT_CLEANUP_INTERVAL_MINUTES = 60;

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm"
};

const EXTENSIONS: Record<string, string> = {
  MP4: ".mp4",
  MOV: ".mov",
  MKV: ".mkv",
  WebM: ".webm"
};

const DEFAULT_GEOMETRY_STATE: GeometryState = {
  operation: "none",
  scalePreset: "按宽度等比缩放",
  scaleWidth: "1280",
  scaleHeight: "720",
  scaleFitMode: "保持宽高比",
  padCanvas: "1280×720",
  padCustomWidth: "1280",
  padCustomHeight: "720",
  padColor: "black",
  padAlign: "居中",
  cropX: "100",
  cropY: "60",
  cropWidth: "640",
  cropHeight: "360",
  rotateMode: "none",
  rotateDirection: "cw",
  rotateBackground: "black",
  rotateCustomAngle: "90"
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

export function sanitizeUploadFileName(value: string) {
  return value.replace(/[^\w.-]+/g, "_");
}

export function getProjectRoot() {
  const currentWorkingDirectory = process.cwd();
  const candidateRoots = [
    currentWorkingDirectory,
    path.resolve(currentWorkingDirectory, ".."),
    path.resolve(currentWorkingDirectory, "..", "..")
  ];

  return (
    candidateRoots.find((candidate) => {
      return existsSync(path.join(candidate, "apps", "backend")) && existsSync(path.join(candidate, "package.json"));
    }) ?? currentWorkingDirectory
  );
}

export function getRuntimeDirectory() {
  const runtimeDirectory = path.join(getProjectRoot(), ".local-runtime");
  mkdirSync(runtimeDirectory, { recursive: true });
  return runtimeDirectory;
}

export function getVideoUploadDirectory() {
  const uploadDirectory = path.join(getRuntimeDirectory(), "video-upload-cache");
  mkdirSync(uploadDirectory, { recursive: true });
  return uploadDirectory;
}

export function getVideoOutputDirectory() {
  const outputDirectory = path.join(getRuntimeDirectory(), "video-outputs");
  mkdirSync(outputDirectory, { recursive: true });
  return outputDirectory;
}

export function getVideoSessionDirectory() {
  const sessionDirectory = path.join(getRuntimeDirectory(), "video-upload-sessions");
  mkdirSync(sessionDirectory, { recursive: true });
  return sessionDirectory;
}

function getManifestPath(id: string) {
  return path.join(getVideoOutputDirectory(), `${id}.json`);
}

function readManifest(id: string) {
  const manifestPath = getManifestPath(id);
  if (!existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(readFileSync(manifestPath, "utf-8")) as VideoOutputManifest;
}

function getSessionManifestPath(id: string) {
  return path.join(getVideoSessionDirectory(), `${id}.json`);
}

function readUploadSession(id: string) {
  const manifestPath = getSessionManifestPath(id);
  if (!existsSync(manifestPath)) {
    return null;
  }

  return JSON.parse(readFileSync(manifestPath, "utf-8")) as VideoUploadSessionManifest;
}

function getFfmpegBinaryPath() {
  const override = getBinaryOverride("FFMPEG_BIN");
  if (override) {
    return override;
  }

  const bundledBinary = path.join(
    getProjectRoot(),
    "node_modules",
    "ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );
  if (existsSync(bundledBinary)) {
    return bundledBinary;
  }

  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function getFfprobeBinaryPath() {
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

function getPythonBinaryPath() {
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

function statFileInfo(filePath: string, fileName: string, mimeType: string) {
  const stats = statSync(filePath);
  return {
    fileName,
    mimeType,
    fileSizeBytes: stats.size
  };
}

function buildMetadata(payload: ProbePayload, fileInfo: FileInfo): VideoMetadata {
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

function parseGeometryConfig(value?: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ...DEFAULT_GEOMETRY_STATE };
  }

  try {
    const parsed = JSON.parse(value) as GeometryState;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_GEOMETRY_STATE };
    }

    return {
      ...DEFAULT_GEOMETRY_STATE,
      ...parsed
    };
  } catch {
    return { ...DEFAULT_GEOMETRY_STATE };
  }
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
    scalePreset: scalePresetMap[String(geometryConfig.scalePreset)] ?? geometryConfig.scalePreset,
    scaleFitMode: scaleFitModeMap[String(geometryConfig.scaleFitMode)] ?? geometryConfig.scaleFitMode,
    padCanvas: padCanvasMap[String(geometryConfig.padCanvas)] ?? geometryConfig.padCanvas,
    padAlign: padAlignMap[String(geometryConfig.padAlign)] ?? geometryConfig.padAlign,
    rotateMode: rotateModeMap[String(geometryConfig.rotateMode)] ?? geometryConfig.rotateMode,
    rotateBackground: rotateBackgroundMap[String(geometryConfig.rotateBackground)] ?? geometryConfig.rotateBackground
  };
}

function runFfprobe(filePath: string) {
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

async function writeUploadSession(session: VideoUploadSessionManifest) {
  await fs.writeFile(getSessionManifestPath(session.id), JSON.stringify(session, null, 2), "utf-8");
}

function parsePositiveNumber(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Injectable()
export class VideoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoService.name);
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupPromise: Promise<void> | null = null;

  onModuleInit() {
    void this.runCleanupCycle();

    const cleanupIntervalMilliseconds =
      parsePositiveNumber(process.env.VIDEO_CLEANUP_INTERVAL_MINUTES, DEFAULT_CLEANUP_INTERVAL_MINUTES) * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      void this.runCleanupCycle();
    }, cleanupIntervalMilliseconds);
    this.cleanupTimer.unref?.();
  }

  async onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await this.cleanupPromise?.catch(() => undefined);
  }

  async createUploadSession(request: VideoUploadSessionRequest) {
    const fileName = sanitizeUploadFileName(request.fileName?.trim() || "uploaded-video.mp4");
    const declaredFileSize = Number.isFinite(request.fileSizeBytes) ? Number(request.fileSizeBytes) : 0;
    const maxUploadBytes = getMaxVideoUploadBytes();

    if (declaredFileSize > maxUploadBytes) {
      throw new PayloadTooLargeException(`上传视频不能超过 ${formatBytes(maxUploadBytes)}。`);
    }

    const sessionId = randomUUID();
    const absolutePath = path.join(getVideoSessionDirectory(), `${sessionId}-${fileName}`);
    const now = new Date().toISOString();

    await fs.writeFile(absolutePath, Buffer.alloc(0));

    const manifest: VideoUploadSessionManifest = {
      id: sessionId,
      fileName,
      mimeType: request.mimeType?.trim() || "application/octet-stream",
      fileSizeBytes: declaredFileSize,
      absolutePath,
      createdAt: now,
      updatedAt: now,
      nextChunkIndex: 0,
      totalChunks: 0,
      completed: false
    };
    await writeUploadSession(manifest);

    return {
      uploadId: sessionId,
      chunkSizeBytes: DEFAULT_UPLOAD_CHUNK_SIZE_BYTES
    };
  }

  async appendUploadChunk(uploadId: string, indexValue: string | number | undefined, totalChunksValue: string | number | undefined, chunk: Buffer) {
    const manifest = readUploadSession(uploadId);
    if (!manifest || !existsSync(manifest.absolutePath)) {
      throw new NotFoundException("上传会话不存在。");
    }

    const index = parseNumber(indexValue) ?? -1;
    const totalChunks = parseNumber(totalChunksValue) ?? -1;
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(totalChunks) || totalChunks <= 0) {
      throw new Error("分块参数不合法。");
    }

    if (manifest.totalChunks > 0 && manifest.totalChunks !== totalChunks) {
      throw new Error("分块总数与当前上传会话不一致。");
    }

    if (index > manifest.nextChunkIndex) {
      throw new Error("分块上传顺序不正确。");
    }

    if (index === manifest.nextChunkIndex) {
      await fs.appendFile(manifest.absolutePath, chunk);
      manifest.nextChunkIndex += 1;
      manifest.totalChunks = totalChunks;
      manifest.completed = manifest.nextChunkIndex >= totalChunks;
      manifest.updatedAt = new Date().toISOString();
      await writeUploadSession(manifest);
    }

    return {
      uploadId,
      nextChunkIndex: manifest.nextChunkIndex,
      totalChunks: manifest.totalChunks,
      completed: manifest.completed
    };
  }

  getUploadSession(uploadId: string) {
    const manifest = readUploadSession(uploadId);
    if (!manifest || !existsSync(manifest.absolutePath)) {
      throw new NotFoundException("上传会话不存在。");
    }

    return manifest;
  }

  async inspectUploadSession(uploadId: string) {
    const manifest = this.getUploadSession(uploadId);
    if (!manifest.completed) {
      throw new Error("视频仍在上传中，请稍后再试。");
    }

    const probePayload = await runFfprobe(manifest.absolutePath);
    return buildMetadata(probePayload, statFileInfo(manifest.absolutePath, manifest.fileName, manifest.mimeType));
  }

  async transcodeUploadSession(uploadId: string, request: VideoTranscodeRequest) {
    const manifest = this.getUploadSession(uploadId);
    if (!manifest.completed) {
      throw new Error("视频仍在上传中，请稍后再试。");
    }

    return this.transcodeFromPath(manifest.absolutePath, manifest.fileName, request);
  }

  async inspectUploadedFile(uploadedFile: UploadedVideoFile) {
    const probePayload = await runFfprobe(uploadedFile.path);
    return buildMetadata(probePayload, {
      fileName: uploadedFile.originalname,
      mimeType: uploadedFile.mimetype || "未知格式",
      fileSizeBytes: uploadedFile.size
    });
  }

  async transcodeUploadedFile(uploadedFile: UploadedVideoFile, request: VideoTranscodeRequest) {
    return this.transcodeFromPath(uploadedFile.path, uploadedFile.originalname, request);
  }

  private async transcodeFromPath(inputPath: string, originalName: string, request: VideoTranscodeRequest) {
    const outputContainer = request.outputContainer ?? "MP4";
    const sourceName = sanitizeUploadFileName(originalName);
    const outputId = randomUUID();
    const outputExtension = EXTENSIONS[outputContainer] ?? ".mp4";
    const outputFileName = `${path.parse(sourceName).name || "transcoded-video"}-transcoded${outputExtension}`;
    const outputAbsolutePath = path.join(getVideoOutputDirectory(), `${outputId}${outputExtension}`);
    const geometryConfig = normalizeGeometryConfig(parseGeometryConfig(request.geometryConfig));
    const scriptPath = path.join(getProjectRoot(), "scripts", "transcode_video.py");

    await runPythonTranscode([
      scriptPath,
      "--input",
      inputPath,
      "--output",
      outputAbsolutePath,
      "--ffmpeg-bin",
      getFfmpegBinaryPath(),
      "--ffprobe-bin",
      getFfprobeBinaryPath(),
      "--output-container",
      outputContainer,
      "--video-codec",
      request.videoCodec ?? "libx264",
      "--audio-codec-strategy",
      normalizeAudioCodecStrategy(request.audioCodecStrategy ?? "AAC"),
      "--packaging-mode",
      normalizePackagingMode(request.packagingMode ?? "standard"),
      "--geometry-config",
      JSON.stringify(geometryConfig)
    ]);

    const metadata = buildMetadata(
      await runFfprobe(outputAbsolutePath),
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

    return {
      result: {
        id: outputId,
        fileName: outputFileName,
        outputUrl: `/api/video/output/${outputId}`,
        downloadUrl: `/api/video/output/${outputId}?download=1`
      },
      metadata
    };
  }

  getOutputManifest(id: string) {
    const manifest = readManifest(id);
    if (!manifest) {
      throw new NotFoundException("输出视频不存在。");
    }

    return manifest;
  }

  getOutputStream(id: string) {
    const manifest = this.getOutputManifest(id);
    if (!existsSync(manifest.absolutePath)) {
      throw new NotFoundException("输出视频文件无法读取。");
    }

    return {
      manifest,
      stream: createReadStream(manifest.absolutePath)
    };
  }

  async cleanupUploadedFile(uploadedFile: UploadedVideoFile | null | undefined) {
    if (!uploadedFile?.path) {
      return;
    }

    await fs.rm(uploadedFile.path, { force: true }).catch(() => undefined);
  }

  private async runCleanupCycle() {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = this.cleanupArtifacts().finally(() => {
      this.cleanupPromise = null;
    });

    return this.cleanupPromise;
  }

  private async cleanupArtifacts() {
    const uploadRetentionMilliseconds =
      parsePositiveNumber(process.env.VIDEO_UPLOAD_RETENTION_HOURS, DEFAULT_UPLOAD_RETENTION_HOURS) * 60 * 60 * 1000;
    const outputRetentionMilliseconds =
      parsePositiveNumber(process.env.VIDEO_OUTPUT_RETENTION_HOURS, DEFAULT_OUTPUT_RETENTION_HOURS) * 60 * 60 * 1000;

    const deletedUploads = await this.cleanupUploadSessions(uploadRetentionMilliseconds);
    const deletedOutputs = await this.cleanupOutputArtifacts(outputRetentionMilliseconds);

    if (deletedUploads > 0 || deletedOutputs > 0) {
      this.logger.log(`Cleaned video artifacts: uploads=${deletedUploads}, outputs=${deletedOutputs}`);
    }
  }

  private async cleanupUploadSessions(retentionMilliseconds: number) {
    const directory = getVideoSessionDirectory();
    const now = Date.now();
    let deletedCount = 0;
    const referencedFiles = new Set<string>();

    for (const entry of await fs.readdir(directory)) {
      const absoluteEntryPath = path.join(directory, entry);
      if (!entry.endsWith(".json")) {
        continue;
      }

      try {
        const manifest = JSON.parse(await fs.readFile(absoluteEntryPath, "utf-8")) as VideoUploadSessionManifest;
        referencedFiles.add(manifest.absolutePath);
        const referenceTime = Date.parse(manifest.updatedAt || manifest.createdAt || "");
        const expired = !Number.isFinite(referenceTime) || now - referenceTime >= retentionMilliseconds;
        if (!expired) {
          continue;
        }

        await fs.rm(manifest.absolutePath, { force: true }).catch(() => undefined);
        await fs.rm(absoluteEntryPath, { force: true }).catch(() => undefined);
        deletedCount += 1;
      } catch {
        const stats = await fs.stat(absoluteEntryPath).catch(() => null);
        if (!stats || now - stats.mtimeMs < retentionMilliseconds) {
          continue;
        }

        await fs.rm(absoluteEntryPath, { force: true }).catch(() => undefined);
        deletedCount += 1;
      }
    }

    for (const entry of await fs.readdir(directory)) {
      const absoluteEntryPath = path.join(directory, entry);
      if (entry.endsWith(".json") || referencedFiles.has(absoluteEntryPath)) {
        continue;
      }

      const stats = await fs.stat(absoluteEntryPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < retentionMilliseconds) {
        continue;
      }

      await fs.rm(absoluteEntryPath, { force: true, recursive: true }).catch(() => undefined);
      deletedCount += 1;
    }

    return deletedCount;
  }

  private async cleanupOutputArtifacts(retentionMilliseconds: number) {
    const directory = getVideoOutputDirectory();
    const now = Date.now();
    let deletedCount = 0;
    const referencedFiles = new Set<string>();

    for (const entry of await fs.readdir(directory)) {
      const absoluteEntryPath = path.join(directory, entry);
      if (!entry.endsWith(".json")) {
        continue;
      }

      try {
        const manifest = JSON.parse(await fs.readFile(absoluteEntryPath, "utf-8")) as VideoOutputManifest;
        referencedFiles.add(manifest.absolutePath);
        const referenceTime = Date.parse(manifest.createdAt || "");
        const expired = !Number.isFinite(referenceTime) || now - referenceTime >= retentionMilliseconds;
        if (!expired) {
          continue;
        }

        await fs.rm(manifest.absolutePath, { force: true }).catch(() => undefined);
        await fs.rm(absoluteEntryPath, { force: true }).catch(() => undefined);
        deletedCount += 1;
      } catch {
        const stats = await fs.stat(absoluteEntryPath).catch(() => null);
        if (!stats || now - stats.mtimeMs < retentionMilliseconds) {
          continue;
        }

        await fs.rm(absoluteEntryPath, { force: true }).catch(() => undefined);
        deletedCount += 1;
      }
    }

    for (const entry of await fs.readdir(directory)) {
      const absoluteEntryPath = path.join(directory, entry);
      if (entry.endsWith(".json") || referencedFiles.has(absoluteEntryPath)) {
        continue;
      }

      const stats = await fs.stat(absoluteEntryPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < retentionMilliseconds) {
        continue;
      }

      await fs.rm(absoluteEntryPath, { force: true, recursive: true }).catch(() => undefined);
      deletedCount += 1;
    }

    return deletedCount;
  }
}
