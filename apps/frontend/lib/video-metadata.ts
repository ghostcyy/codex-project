export type ProbeStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  pix_fmt?: string;
  level?: number;
  field_order?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: string;
  bit_rate?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  tags?: Record<string, string>;
};

export type ProbeFormat = {
  filename?: string;
  nb_streams?: number;
  nb_programs?: number;
  format_name?: string;
  format_long_name?: string;
  start_time?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  probe_score?: number;
  tags?: Record<string, string>;
};

export type ProbePayload = {
  streams?: ProbeStream[];
  format?: ProbeFormat;
};

export type VideoMetadata = {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  streamCount: number;
  container: {
    shortName: string | null;
    longName: string | null;
  };
  durationSeconds: number | null;
  bitRate: number | null;
  startTimeSeconds: number | null;
  video: {
    codec: string | null;
    codecLongName: string | null;
    profile: string | null;
    resolution: {
      width: number | null;
      height: number | null;
      codedWidth: number | null;
      codedHeight: number | null;
    };
    frameRate: number | null;
    nominalFrameRate: number | null;
    pixelFormat: string | null;
    fieldOrder: string | null;
    aspectRatio: string | null;
    sampleAspectRatio: string | null;
    colorRange: string | null;
    colorSpace: string | null;
    colorTransfer: string | null;
    colorPrimaries: string | null;
    rawBitDepth: string | null;
    bitRate: number | null;
    frameCount: number | null;
    level: number | null;
  } | null;
  audio: {
    codec: string | null;
    codecLongName: string | null;
    sampleRate: number | null;
    channels: number | null;
    channelLayout: string | null;
    bitRate: number | null;
  } | null;
  rawProbe: ProbePayload;
};

export function formatFileSize(size: number | null) {
  if (size == null || Number.isNaN(size)) {
    return "未知";
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number | null) {
  if (seconds == null || Number.isNaN(seconds)) {
    return "未知";
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

export function formatBitRate(bitRate: number | null) {
  if (bitRate == null || Number.isNaN(bitRate)) {
    return "未知";
  }

  if (bitRate >= 1_000_000) {
    return `${(bitRate / 1_000_000).toFixed(2)} Mbps`;
  }

  if (bitRate >= 1_000) {
    return `${(bitRate / 1_000).toFixed(0)} kbps`;
  }

  return `${bitRate} bps`;
}

export function formatFrameRate(frameRate: number | null) {
  if (frameRate == null || Number.isNaN(frameRate)) {
    return "未知";
  }

  return `${frameRate.toFixed(frameRate % 1 === 0 ? 0 : 2)} fps`;
}

export function formatResolution(width: number | null, height: number | null) {
  if (width == null || height == null) {
    return "未知";
  }

  return `${width} × ${height}`;
}

export function formatSampleRate(sampleRate: number | null) {
  if (sampleRate == null || Number.isNaN(sampleRate)) {
    return "未知";
  }

  return `${sampleRate.toLocaleString()} Hz`;
}

export function formatChannels(channels: number | null, layout: string | null) {
  if (channels == null) {
    return "未知";
  }

  return layout ? `${channels} 声道 (${layout})` : `${channels} 声道`;
}
