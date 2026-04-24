import { buildClientVideoApiUrl } from "./client-video-api";
import type { VideoMetadata } from "./video-metadata";
import type { TranscodeResult } from "./video-transcode";

type UploadInitPayload = {
  uploadId: string;
  chunkSizeBytes: number;
};

export async function uploadVideoInChunks(file: File, onProgress?: (progress: number) => void) {
  const initResponse = await fetch(buildClientVideoApiUrl("/video/uploads/init"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      fileSizeBytes: file.size
    })
  });

  const initPayload = (await initResponse.json().catch(() => null)) as UploadInitPayload | null;
  if (!initResponse.ok || !initPayload?.uploadId || !initPayload.chunkSizeBytes) {
    throw new Error("无法初始化大文件上传。");
  }

  const { uploadId, chunkSizeBytes } = initPayload;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSizeBytes));

  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = file.slice(index * chunkSizeBytes, Math.min(file.size, (index + 1) * chunkSizeBytes));
    const formData = new FormData();
    formData.set("chunk", chunk, `${file.name}.part${index}`);
    formData.set("index", String(index));
    formData.set("totalChunks", String(totalChunks));

    const response = await fetch(buildClientVideoApiUrl(`/video/uploads/${uploadId}/chunk`), {
      method: "POST",
      body: formData
    });
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) {
      throw new Error(payload?.message ?? "上传分块失败。");
    }

    onProgress?.((index + 1) / totalChunks);
  }

  return uploadId;
}

export async function inspectUploadedSession(uploadId: string) {
  const response = await fetch(buildClientVideoApiUrl(`/video/uploads/${uploadId}/inspect`), {
    method: "POST"
  });
  const payload = (await response.json().catch(() => null)) as { metadata?: VideoMetadata; message?: string } | null;
  if (!response.ok || !payload?.metadata) {
    throw new Error(payload?.message ?? "视频信息解析失败。");
  }

  return payload.metadata;
}

export async function transcodeUploadedSession(
  uploadId: string,
  body: Record<string, string>
) {
  const response = await fetch(buildClientVideoApiUrl(`/video/uploads/${uploadId}/transcode`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => null)) as
    | { result?: TranscodeResult; metadata?: VideoMetadata; message?: string }
    | null;

  if (!response.ok || !payload?.result) {
    throw new Error(payload?.message ?? "转码失败。");
  }

  return payload;
}
