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

export type VideoOutputManifest = {
  id: string;
  fileName: string;
  absolutePath: string;
  mimeType: string;
  createdAt: string;
};

export type UploadedVideoFile = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
};

export type VideoTranscodeRequest = {
  outputContainer?: string;
  videoCodec?: string;
  audioCodecStrategy?: string;
  packagingMode?: string;
  geometryConfig?: string;
};

export type VideoUploadSessionRequest = {
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
};

export type VideoUploadChunkRequest = {
  index?: string | number;
  totalChunks?: string | number;
};

export type VideoUploadSessionManifest = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
  nextChunkIndex: number;
  totalChunks: number;
  completed: boolean;
};
