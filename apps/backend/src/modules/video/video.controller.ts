import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Public } from "../../common/auth/public.decorator";
import { formatBytes, getMaxVideoChunkBytes, getMaxVideoUploadBytes } from "./video.config";
import { VideoRateLimitGuard } from "./video-rate-limit.guard";
import { getVideoUploadDirectory, sanitizeUploadFileName, VideoService } from "./video.service";
import type {
  UploadedVideoFile,
  VideoTranscodeRequest,
  VideoUploadChunkRequest,
  VideoUploadSessionRequest
} from "./video.types";

const {
  diskStorage,
  memoryStorage
}: {
  diskStorage: (options: Record<string, unknown>) => unknown;
  memoryStorage: () => unknown;
} = require("multer");

function createVideoUploadInterceptor() {
  return FileInterceptor("file", {
    storage: diskStorage({
      destination: (_request: unknown, _file: unknown, callback: (error: Error | null, destination: string) => void) => {
        callback(null, getVideoUploadDirectory());
      },
      filename: (
        _request: unknown,
        file: { originalname: string },
        callback: (error: Error | null, filename: string) => void
      ) => {
        callback(null, `${randomUUID()}-${sanitizeUploadFileName(file.originalname)}`);
      }
    }),
    limits: {
      fileSize: getMaxVideoUploadBytes()
    }
  });
}

@Controller("video")
@UseGuards(VideoRateLimitGuard)
export class VideoController {
  constructor(@Inject(VideoService) private readonly videoService: VideoService) {}

  @Post("uploads/init")
  @Public()
  @HttpCode(200)
  async initUpload(@Body() body?: VideoUploadSessionRequest) {
    return this.videoService.createUploadSession(body ?? {});
  }

  @Post("uploads/:id/chunk")
  @Public()
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("chunk", {
      storage: memoryStorage(),
      limits: {
        fileSize: 8 * 1024 * 1024
      }
    })
  )
  async uploadChunk(@Param("id") id: string, @UploadedFile() file?: UploadedVideoFile, @Body() body?: VideoUploadChunkRequest) {
    if (!file?.buffer) {
      throw new BadRequestException("未收到上传分块。");
    }

    if (file.buffer.length > getMaxVideoChunkBytes()) {
      throw new PayloadTooLargeException(`单个上传分块不能超过 ${formatBytes(getMaxVideoChunkBytes())}。`);
    }

    try {
      return await this.videoService.appendUploadChunk(id, body?.index, body?.totalChunks, file.buffer);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "上传分块失败。");
    }
  }

  @Post("uploads/:id/inspect")
  @Public()
  @HttpCode(200)
  async inspectUpload(@Param("id") id: string) {
    try {
      return {
        metadata: await this.videoService.inspectUploadSession(id)
      };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "视频信息解析失败。");
    }
  }

  @Post("uploads/:id/transcode")
  @Public()
  @HttpCode(200)
  async transcodeUpload(@Param("id") id: string, @Body() body?: VideoTranscodeRequest) {
    try {
      return await this.videoService.transcodeUploadSession(id, body ?? {});
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "视频转码失败。");
    }
  }

  @Post("inspect")
  @Public()
  @UseInterceptors(createVideoUploadInterceptor())
  async inspect(@UploadedFile() file?: UploadedVideoFile) {
    if (!file) {
      throw new BadRequestException("未收到可解析的视频文件。");
    }

    if (file.size > getMaxVideoUploadBytes()) {
      throw new PayloadTooLargeException(`上传视频不能超过 ${formatBytes(getMaxVideoUploadBytes())}。`);
    }

    try {
      return {
        metadata: await this.videoService.inspectUploadedFile(file)
      };
    } finally {
      await this.videoService.cleanupUploadedFile(file);
    }
  }

  @Post("transcode")
  @Public()
  @UseInterceptors(createVideoUploadInterceptor())
  async transcode(@UploadedFile() file?: UploadedVideoFile, @Body() body?: VideoTranscodeRequest) {
    if (!file) {
      throw new BadRequestException("未收到待转码的视频文件。");
    }

    if (file.size > getMaxVideoUploadBytes()) {
      throw new PayloadTooLargeException(`上传视频不能超过 ${formatBytes(getMaxVideoUploadBytes())}。`);
    }

    try {
      return await this.videoService.transcodeUploadedFile(file, body ?? {});
    } finally {
      await this.videoService.cleanupUploadedFile(file);
    }
  }

  @Get("output/:id")
  @Public()
  getOutput(@Param("id") id: string, @Query("download") download: string | undefined, @Res({ passthrough: true }) response: any) {
    const { manifest, stream } = this.videoService.getOutputStream(id);
    const shouldDownload = download === "1";

    response.setHeader("Content-Type", manifest.mimeType);
    response.setHeader("Content-Disposition", `${shouldDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(manifest.fileName)}"`);

    return new StreamableFile(stream);
  }
}
