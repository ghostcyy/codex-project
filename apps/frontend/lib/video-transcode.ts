export type OutputContainer = "MP4" | "MOV" | "MKV" | "WebM";

export type TranscodeOptions = {
  outputContainer: OutputContainer;
  videoCodec: string;
  audioCodecStrategy: string;
  packagingMode: string;
};

export type TranscodeResult = {
  id: string;
  fileName: string;
  outputUrl: string;
  downloadUrl: string;
};

export const DEFAULT_TRANSCODE_OPTIONS: TranscodeOptions = {
  outputContainer: "MP4",
  videoCodec: "copy",
  audioCodecStrategy: "copy",
  packagingMode: "标准封装"
};

const OUTPUT_EXTENSIONS: Record<OutputContainer, string> = {
  MP4: ".mp4",
  MOV: ".mov",
  MKV: ".mkv",
  WebM: ".webm"
};

const VIDEO_CODEC_MAP: Record<string, string> = {
  libx264: "libx264",
  libx265: "libx265",
  copy: "copy",
  "libvpx-vp9": "libvpx-vp9",
  vp9: "libvpx-vp9",
  "libaom-av1": "libaom-av1",
  av1: "libaom-av1",
  mpeg4: "mpeg4",
  libxvid: "libxvid",
  libvpx: "libvpx"
};

const AUDIO_CODEC_MAP: Record<string, string> = {
  AAC: "aac",
  copy: "copy",
  Opus: "libopus",
  mute: "mute"
};

function quoteArgument(value: string) {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildTranscodeCommandPreview(options: TranscodeOptions, geometryPreview = "") {
  const outputExtension = OUTPUT_EXTENSIONS[options.outputContainer] ?? ".mp4";
  const outputFileName = `output-transcoded${outputExtension}`;
  const args: string[] = ["ffmpeg", "-i", quoteArgument("input-video.mp4")];
  const geometryActive = geometryPreview.length > 0;

  if (geometryPreview) {
    args.push(geometryPreview);
  }

  if (options.packagingMode === "仅换容器") {
    args.push("-c:v", "copy", "-c:a", "copy", quoteArgument(outputFileName));
    return args.join(" ");
  }

  const resolvedVideoCodec =
    geometryActive && options.videoCodec === "copy"
      ? "libx264"
      : (VIDEO_CODEC_MAP[options.videoCodec] ?? options.videoCodec);
  args.push("-c:v", resolvedVideoCodec);

  if (options.audioCodecStrategy === "静音导出" || options.audioCodecStrategy === "mute") {
    args.push("-an");
  } else {
    const resolvedAudioCodec = AUDIO_CODEC_MAP[options.audioCodecStrategy] ?? "aac";
    args.push("-c:a", resolvedAudioCodec);
  }

  if (resolvedVideoCodec !== "copy" && (options.outputContainer === "MP4" || options.outputContainer === "MOV")) {
    args.push("-pix_fmt", "yuv420p");
  }

  if (options.packagingMode === "faststart" && (options.outputContainer === "MP4" || options.outputContainer === "MOV")) {
    args.push("-movflags", "faststart");
  }

  if (options.packagingMode === "高压缩优先" && resolvedVideoCodec !== "copy") {
    if (resolvedVideoCodec === "libx264") {
      args.push("-crf", "28", "-preset", "slow");
    } else if (resolvedVideoCodec === "libx265") {
      args.push("-crf", "30", "-preset", "slow");
    } else if (resolvedVideoCodec === "libvpx-vp9" || resolvedVideoCodec === "libaom-av1") {
      args.push("-crf", "32", "-b:v", "0");
    }
  }

  args.push(quoteArgument(outputFileName));
  return args.join(" ");
}
